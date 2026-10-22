/* The second factor, tested on its own.
 *
 * The theme is that a second factor is only worth having if it cannot be walked past. So the tests here are
 * weighted towards the ways it goes wrong: replaying a seen code, spending a backup code twice, guessing past
 * the lockout, and turning the whole thing off without the phone.
 *
 * Every test works in its own temporary directory, because this file writes a real file and the real file
 * holds a real secret. */
import assert from 'node:assert/strict';
import { test, after, beforeEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentCode } from '../totp.js';
import {
  beginEnrolment, confirmEnrolment, disable, verifySecondFactor, regenerateBackupCodes,
  isEnabled, isBroken, clearAttempts, twoFactorInternals
} from '../two-factor.js';

const { MAX_ATTEMPTS, SHOP_MAX_ATTEMPTS } = twoFactorInternals;

// Every directory this file makes is collected here and removed once at the end, rather than each test
// registering its own cleanup. A shop's data directory holds a real secret, so leaving one behind in /tmp
// is the one kind of untidiness in this repository that would actually matter.
const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

// The rate limiter is module-level on purpose — it belongs to the process, not to a request — which means it
// survives between tests in this file. Several tests deliberately exhaust an address's budget, so without
// this every later test would begin already locked out. The shared-state hazard is real enough that it is
// reset rather than worked around with a fresh address per test.
beforeEach(() => clearAttempts());

/** A throwaway data directory. */
function shop() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-2fa-'));
  made.push(dir);
  return dir;
}

/**
 * A request from a given address, since the limiter is per-address.
 *
 * The address is on the socket, not in a header, because that is where the server reads it. The old helper
 * set `x-forwarded-for`, which is what made the spoofing test below impossible to write in the first place.
 */
function from(ip) {
  return { headers: {}, socket: { remoteAddress: ip } };
}

/** A request claiming to be somebody else entirely, in the one header a client is free to invent. */
function spoofing(ip) {
  return { headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: '10.0.0.1' } };
}

/**
 * Enrols a phone and returns a `code()` giving the code that phone is showing.
 *
 * The clock is fixed to a whole step boundary plus a fixed offset, because enrolment spends the code it
 * confirms with (see the note in `confirmEnrolment`) and every later test needs a code that is still live.
 * Without a pinned clock, a test that enrols and then immediately unlocks works for about half of each
 * thirty-second window and fails for the other half — which is the worst kind of test failure, because it
 * passes on the machine it was written on.
 */
const AT = 1_700_000_000_000 + 12_000; // a whole step, twelve seconds in

/** Enrols a phone and returns its current code, which is what a shopkeeper's screen would be showing. */
function enrolled(dir, ip = '10.0.0.5') {
  const { secret } = beginEnrolment(dir, { account: 'owner', issuer: 'M3 POS' });
  const done = confirmEnrolment(dir, currentCode(secret, AT), { atMs: AT });
  assert.equal(done.ok, true, 'enrolment should succeed');
  return { secret, req: from(ip), code: () => nextCode(secret), at: AT };
}

/** The live code for a phone set up by `enrolled`, in the window after the confirming one was spent. */
function nextCode(secret) {
  return currentCode(secret, AT + 30_000);
}

/* ---------- the ordinary path ---------- */

test('a shop with no second factor on has none, and says so', () => {
  const dir = shop();
  assert.equal(isEnabled(dir), false, 'a brand new shop is not protected twice, it is unprotected once');
});

test('starting enrolment hands over a secret and a scannable link but does not switch anything on', () => {
  // The whole reason confirmation is a separate step: a secret that was never proven would be a second
  // factor the owner believes is working and discovers is not, at 9pm, on a locked till.
  const dir = shop();
  const begun = beginEnrolment(dir, { account: 'owner', issuer: 'M3 POS' });
  assert.match(begun.url, /^otpauth:\/\/totp\//);
  assert.ok(begun.secret.length >= 32);
  assert.equal(isEnabled(dir), false, 'not on yet');
});

test('the shop name is what the owner sees in their phone, so it is the issuer', () => {
  const dir = shop();
  const begun = beginEnrolment(dir, { account: 'owner', issuer: "M3 & Sons" });
  assert.equal(new URL(begun.url).searchParams.get('issuer'), 'M3 & Sons');
});

test('confirming with the code from the phone switches the second factor on', () => {
  const dir = shop();
  const e = enrolled(dir);
  assert.equal(isEnabled(dir), true);
  assert.equal(verifySecondFactor(dir, e.req, e.code(), { atMs: AT }).ok, true);
});

test('confirming with a wrong code switches nothing on', () => {
  const dir = shop();
  const { secret } = beginEnrolment(dir, { account: 'owner', issuer: 'M3 POS' });
  const result = confirmEnrolment(dir, '000000');
  assert.equal(result.ok, false);
  assert.equal(isEnabled(dir), false);
  // The secret is still pending, so the owner can simply try again rather than starting over.
  assert.equal(confirmEnrolment(dir, currentCode(secret)).ok, true);
});

test('confirming with a code that is not six digits says so plainly', () => {
  // "That code is not right" after typing five digits reads as a locked-out phone. This reads as a typo.
  const dir = shop();
  beginEnrolment(dir, { account: 'owner', issuer: 'M3 POS' });
  assert.match(confirmEnrolment(dir, '123').error, /six digits/i);
});

test('confirming when nothing is pending asks for a restart rather than crashing', () => {
  const dir = shop();
  assert.equal(confirmEnrolment(dir, '123456').ok, false);
});

/* ---------- checking a code at the till ---------- */

test('a live code opens the till', () => {
  const dir = shop();
  const e = enrolled(dir);
  assert.equal(verifySecondFactor(dir, e.req, e.code(), { atMs: AT }).ok, true);
});

test('a wrong code does not open the till and does not say which of the two factors failed', () => {
  const dir = shop();
  const e = enrolled(dir);
  const res = verifySecondFactor(dir, e.req, '000000', { atMs: AT });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'That code is not right');
});

test('a code that worked once is refused the next time', () => {
  // Read over a shoulder at a real till, a six-digit code stays live for half a minute. Without this, an
  // observer gets two unlocks out of one sighting.
  const dir = shop();
  const e = enrolled(dir);
  const code = e.code();
  assert.equal(verifySecondFactor(dir, e.req, code, { atMs: AT }).ok, true);

  const replay = verifySecondFactor(dir, e.req, code, { atMs: AT });
  assert.equal(replay.ok, false);
  assert.match(replay.error, /already used/i);
});

test('a code replayed from a different address is still refused', () => {
  // The replay record is per-shop, not per-phone, so walking to another device does not reset it.
  const dir = shop();
  const e = enrolled(dir);
  const code = e.code();
  assert.equal(verifySecondFactor(dir, e.req, code, { atMs: AT }).ok, true);
  assert.equal(verifySecondFactor(dir, from('10.0.0.9'), code, { atMs: AT }).ok, false);
});

test('the code that confirmed enrolment is not immediately a working unlock code', () => {
  // The owner's phone is showing that code at the end of setup, on screen, in the shop.
  const dir = shop();
  const e = enrolled(dir);
  const confirming = currentCode(e.secret, AT);
  const res = verifySecondFactor(dir, e.req, confirming, { atMs: AT });
  // Only refused if the window has not rolled over; once the phone has moved on, this is a new code and is
  // legitimately valid, so the assertion is deliberately narrow.
  if (Math.floor(Date.now() / 30000) === Math.floor(Date.now() / 30000)) {
    assert.equal(res.ok, false);
  }
});

test('a code that is not six digits is refused without being charged for', () => {
  // Somebody who has not read the screen is not an attacker, and charging them would lock a shopkeeper out
  // of their own till for typing five digits five times.
  const dir = shop();
  const e = enrolled(dir);
  for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
    const res = verifySecondFactor(dir, e.req, '12', { atMs: AT });
    assert.equal(res.ok, false);
    assert.match(res.error, /six digits/i);
  }
  // Still usable afterwards, which is the point of not charging.
  assert.equal(verifySecondFactor(dir, e.req, e.code(), { atMs: AT }).ok, true);
});

test('a phone whose clock has drifted is told so, because that is not an attack', () => {
  // Refusing a correct code because the phone is fifteen seconds fast looks exactly like somebody guessing,
  // and the shopkeeper has no way to tell the two apart. Saying "check your clock" turns a locked till back
  // into a working one in ten seconds.
  const dir = shop();
  const e = enrolled(dir);
  const drifted = currentCode(e.secret, AT + 30_000);
  const res = verifySecondFactor(dir, e.req, drifted, { atMs: AT });
  assert.equal(res.ok, true, 'a code one window ahead is still accepted');
});

test('a wrong code is not blamed on the clock', () => {
  // The opposite failure: if every wrong code suggested a clock problem, a real attack would be explaining
  // itself away as a settings mistake.
  const dir = shop();
  const e = enrolled(dir);
  const res = verifySecondFactor(dir, e.req, '000000', { atMs: AT });
  assert.equal(res.clockDrift, undefined);
});

/* ---------- the limiter ---------- */

test('the fifth wrong code locks the till out of this address', () => {
  const dir = shop();
  const e = enrolled(dir);
  for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
    const res = verifySecondFactor(dir, e.req, '000000', { atMs: AT });
    assert.equal(res.ok, false, `attempt ${i + 1} should just be refused`);
  }
  const locked = verifySecondFactor(dir, e.req, '000000', { atMs: AT });
  assert.match(locked.error, /too many wrong codes/i);
});

test('a locked-out address is refused even with the correct code', () => {
  // The important one. If a lockout only blocked wrong guesses, an attacker who triggered it and then had a
  // correct code could still get in, and the lockout would be a suggestion.
  const dir = shop();
  const e = enrolled(dir);
  for (let i = 0; i < MAX_ATTEMPTS; i++) verifySecondFactor(dir, e.req, '000000', { atMs: AT });
  const right = verifySecondFactor(dir, e.req, e.code(), { atMs: AT });
  assert.equal(right.ok, false);
  assert.match(right.error, /too many wrong codes/i);
});

test('the lockout is per address, so one guest guessing does not lock out the till', () => {
  // The till and a phone are different addresses. Locking the whole shop because somebody on the Wi-Fi
  // guessed five codes would be a denial of service handed out for free. The shop-wide ceiling below is
  // set far higher precisely so this case stays a lockout for the guest and nothing for anybody else.
  const dir = shop();
  const till = enrolled(dir, '10.0.0.5');
  for (let i = 0; i < MAX_ATTEMPTS; i++) verifySecondFactor(dir, from('10.0.0.99'), '000000', { atMs: AT });
  assert.equal(verifySecondFactor(dir, till.req, till.code(), { atMs: AT }).ok, true);
});

test('changing the address in a header does not get anybody a fresh set of guesses', () => {
  // The bug this replaces: the limiter counted whatever `X-Forwarded-For` said, and that header is set by
  // whoever sends the request. A guesser presenting a different value on every try was never counted twice,
  // so a six-digit code was being taken apart at whatever rate the shop's Wi-Fi allowed.
  const dir = shop();
  // The phone is on 10.0.0.1, and every guessing request claims a different address in the header while
  // arriving from that same socket.
  const e = enrolled(dir, '10.0.0.1');
  for (let i = 0; i < MAX_ATTEMPTS; i++) verifySecondFactor(dir, spoofing(`10.1.1.${i}`), '000000', { atMs: AT });
  const after = verifySecondFactor(dir, e.req, e.code(), { atMs: AT });
  assert.equal(after.ok, false, 'five wrong guesses still lock the address that sent them');
  assert.match(after.error, /too many wrong codes/i);
});

test('the shop-wide ceiling stops a spray from four machines, which per-address limits cannot', () => {
  // Four guests, four addresses, five guesses each: every one of them is under their own per-address limit,
  // and twenty tries against a six-digit code is a real start on a list of a million. This is the case the
  // per-address limit alone was blind to.
  const dir = shop();
  const till = enrolled(dir, '10.0.0.5');
  for (let i = 0; i < SHOP_MAX_ATTEMPTS; i++) {
    verifySecondFactor(dir, from(`10.0.0.${60 + i}`), '000000', { atMs: AT });
  }
  // The twentieth attempt is the one that trips it, and the message for *that* one has already been decided
  // before the counter moved, so the lockout is visible on the twenty-first.
  const next = verifySecondFactor(dir, from('10.0.0.90'), '000000', { atMs: AT });
  assert.match(next.error, /too many wrong codes/i, 'the whole shop is now closed for guessing');
  // Including the till itself: that is the cost of the ceiling, and it is paid for five minutes rather than
  // being paid for by an unbounded guessing run.
  assert.match(verifySecondFactor(dir, till.req, till.code(), { atMs: AT }).error, /too many wrong codes/i);
});

test('the unknown backup code branch is charged, since hashing it is real work', () => {
  // A well-shaped backup code that is not one of ours was answered without being counted, so it was a free
  // oracle: ten scrypt comparisons per request, no lockout, and a reply that separates "not ours" from
  // "already used" and so confirms a guess. Charging it makes five attempts a lockout like anything else.
  const dir = shop();
  const e = enrolled(dir);
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const res = verifySecondFactor(dir, e.req, '1111-2222-3333', { atMs: AT });
    assert.equal(res.ok, false);
  }
  assert.match(verifySecondFactor(dir, e.req, e.code(), { atMs: AT }).error, /too many wrong codes/i);
});

test('a right code clears the wrong count rather than leaving it on the counter', () => {
  // Otherwise four wrong guesses spread over a day would lock the fifth, correct one out — teaching an owner
  // that the till breaks after a few slips.
  const dir = shop();
  const e = enrolled(dir);
  for (let i = 0; i < 4; i++) verifySecondFactor(dir, e.req, '000000', { atMs: AT });
  assert.equal(verifySecondFactor(dir, e.req, e.code(), { atMs: AT }).ok, true);
  assert.equal(verifySecondFactor(dir, e.req, '000000', { atMs: AT }).error, 'That code is not right');
});

test('a spent backup code does not count against the limiter, because it is not a guess', () => {
  const dir = shop();
  const e = enrolled(dir);
  const { backupCodes } = { backupCodes: confirmFromBackup(dir) };
  const used = verifySecondFactor(dir, e.req, backupCodes[0], { atMs: AT });
  assert.equal(used.ok, true);
  assert.equal(used.usedBackup, true);
  assert.equal(verifySecondFactor(dir, e.req, '000000', { atMs: AT }).error, 'That code is not right');
});

/* ---------- backup codes ---------- */

/** Runs enrolment again on a dir that has none, and returns the codes. */
function confirmFromBackup(dir) {
  const { secret } = beginEnrolment(dir, { account: 'owner', issuer: 'M3 POS' });
  return confirmEnrolment(dir, currentCode(secret, AT), { atMs: AT }).backupCodes;
}

test('ten backup codes are handed over at enrolment, grouped to be readable off paper', () => {
  const dir = shop();
  const codes = confirmFromBackup(dir);
  assert.equal(codes.length, 10);
  for (const c of codes) {
    // Digits, not hex: this code has to be typeable on the numeric keypad next to the till, by somebody
    // reading it off a card because their phone is lost. Letters would be unreadable there.
    assert.match(c, /^\d{4}-\d{4}-\d{4}$/, `"${c}" should be four-four-four digits`);
  }
  assert.equal(new Set(codes).size, 10, 'all different');
});

test('a backup code opens the till when the phone is gone, and reports that it did', () => {
  // The UI has to say which was used, so the owner knows to tick one off the card.
  const dir = shop();
  const codes = confirmFromBackup(dir);
  const res = verifySecondFactor(dir, from('10.0.0.5'), codes[3], { atMs: AT });
  assert.equal(res.ok, true);
  assert.equal(res.usedBackup, true);
  assert.equal(res.remaining, 9);
});

test('a backup code works exactly once', () => {
  // A code that stayed valid would be a permanent way past the phone, which is the opposite of the point.
  const dir = shop();
  const codes = confirmFromBackup(dir);
  const req = from('10.0.0.5');
  assert.equal(verifySecondFactor(dir, req, codes[0], { atMs: AT }).ok, true);
  // Named as spent rather than as a plain wrong code, so the owner knows to tick it off the card. They
  // would work that out eventually by trying the next one, but "not right" after a code they can see is
  // exactly the message that makes somebody assume the whole set is broken.
  const second = verifySecondFactor(dir, req, codes[0], { atMs: AT });
  assert.equal(second.ok, false);
  assert.match(second.error, /already been used/i);
  assert.equal(second.spent, true);
});

test('the other backup codes still work after one is spent', () => {
  const dir = shop();
  const codes = confirmFromBackup(dir);
  const req = from('10.0.0.5');
  verifySecondFactor(dir, req, codes[0], { atMs: AT });
  assert.equal(verifySecondFactor(dir, req, codes[1], { atMs: AT }).ok, true);
  assert.equal(verifySecondFactor(dir, req, codes[2], { atMs: AT }).ok, true);
});

test('a backup code is accepted in any case, with or without the dashes', () => {
  // Read aloud down a phone to somebody who lost theirs. Case and punctuation have to be forgiving or a
  // perfectly good code gets burned on formatting.
  const dir = shop();
  const codes = confirmFromBackup(dir);
  const req = from('10.0.0.5');
  assert.equal(verifySecondFactor(dir, req, codes[0].toLowerCase(), { atMs: AT }).ok, true);
  assert.equal(verifySecondFactor(dir, req, codes[1].replace(/-/g, '')).ok, true);
});

test('the stored file never contains a backup code in the clear', () => {
  // If somebody walks off with the till's disk, every code in this file must already be useless to them.
  const dir = shop();
  const codes = confirmFromBackup(dir);
  const raw = fs.readFileSync(path.join(dir, 'auth-2fa.json'), 'utf8');
  for (const c of codes) {
    assert.equal(raw.includes(c), false, `${c} must not be readable in the file`);
    assert.equal(raw.includes(c.replace(/-/g, '')), false, 'nor without its dashes');
  }
  assert.ok(raw.includes('backupHashes'), 'hashes are there');
  assert.ok(!raw.includes('"hash":null') && !raw.includes('"salt":null'), 'and they are real');
});

test('a new set of backup codes replaces the old one, so a lost card is genuinely dead', () => {
  // "We lost the card" has to mean the codes on it no longer work, or there is no way to deal with it.
  const dir = shop();
  const codes = confirmFromBackup(dir);
  const req = from('10.0.0.5');
  const fresh = regenerateBackupCodes(dir, currentCode(readSecret(dir), AT + 30_000), { atMs: AT + 30_000 });
  assert.equal(fresh.ok, true);
  assert.equal(verifySecondFactor(dir, req, codes[0], { atMs: AT }).ok, false, 'an old code is dead');
  assert.equal(verifySecondFactor(dir, req, fresh.backupCodes[0], { atMs: AT }).ok, true, 'a new one works');
});

test('backup codes cannot be regenerated without the phone', () => {
  // Otherwise anyone at the till can mint themselves unlimited codes and the phone stops mattering.
  const dir = shop();
  confirmFromBackup(dir);
  assert.equal(regenerateBackupCodes(dir, '000000').ok, false);
});

function readSecret(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'auth-2fa.json'), 'utf8')).secret;
}

/* ---------- turning it off ---------- */

test('the second factor can be turned off with the phone', () => {
  const dir = shop();
  const e = enrolled(dir);
  const res = disable(dir, e.code(), { atMs: AT });
  assert.equal(res.ok, true);
  assert.equal(isEnabled(dir), false);
});

test('it cannot be turned off by somebody who has not got the phone', () => {
  // The whole reason a code is needed to disable it: a phone borrowed for a minute should not be able to
  // quietly remove the thing standing between the till and the money.
  const dir = shop();
  enrolled(dir);
  assert.equal(disable(dir, '000000').ok, false);
  assert.equal(isEnabled(dir), true, 'and it is still on');
});

test('turning it off removes the secret from the disk, not just the flag', () => {
  // A flag with the secret still sitting next to it would be a second factor that is off but recoverable by
  // anybody who edits a file, which is the same as no lock on a shop's own machine.
  const dir = shop();
  const e = enrolled(dir);
  disable(dir, e.code(), { atMs: AT });
  assert.equal(fs.existsSync(path.join(dir, 'auth-2fa.json')), false);
});

test('turning off something that was never on is refused rather than crashing', () => {
  const dir = shop();
  assert.equal(disable(dir, '123456').ok, false);
});

test('a shop whose 2FA file is damaged is refused, not quietly downgraded to the PIN alone', () => {
  // This one is the reverse of the test it replaces, and the change was deliberate. Treating an unreadable
  // file as "not enrolled" meant a truncated write, a bad disk or a stray edit turned a shop with a second
  // factor into a shop with a four-digit PIN and no warning at all — the protection was gone and the screen
  // said it was never there. Failing closed is uncomfortable, so the server says exactly what to do about it.
  const dir = shop();
  enrolled(dir);
  fs.writeFileSync(path.join(dir, 'auth-2fa.json'), '{ this is not json');
  assert.equal(isBroken(dir), true, 'the damage is reported rather than hidden');
  assert.throws(() => verifySecondFactor(dir, from('10.0.0.5'), '123456', { atMs: AT }), /could not be read/i);
  // isEnabled must not be read as "off" either, because that is what the login route uses to decide
  // whether to ask for a code at all.
  assert.throws(() => isEnabled(dir));
});

test('a file that is missing is not damaged: a shop that never enrolled still opens on the PIN alone', () => {
  // The distinction the damage test depends on. Absent is a normal, secure state; present-and-unreadable
  // is not, and they must not collapse into one answer.
  const dir = shop();
  assert.equal(isBroken(dir), false);
  assert.equal(isEnabled(dir), false);
  assert.deepEqual(verifySecondFactor(dir, from('10.0.0.5'), '123456', { atMs: AT }),
    { ok: false, error: 'Second factor is not set up' });
});

test('a shop with no 2FA file never reaches the limiter, so the PIN carries on working alone', () => {
  // A shopkeeper who has not set up a second factor must not be able to lock themselves out of a feature they
  // never turned on. Ten wrong codes here all have to come back as the same plain "not set up" answer, and
  // none of them may be charged, or the next real setup would begin already locked out.
  const dir = shop();
  // A fresh address, because the limiter is module-level and shared by the whole file.
  const req = from('10.0.0.77');
  for (let i = 0; i < MAX_ATTEMPTS + 5; i++) {
    const res = verifySecondFactor(dir, req, '000000', { atMs: AT });
    assert.equal(res.ok, false);
    assert.match(res.error, /not set up/i, `attempt ${i + 1} must not be a lockout`);
  }
});

/* ---------- what is stored, and who can read it ---------- */

test('the secret file sits outside config.json and is not world-readable', () => {
  // Two separate promises. Outside config.json because the shop's config is readable and backed up on the
  // LAN; 0600 because the directory holding it may be looser than the file.
  const dir = shop();
  enrolled(dir);
  const file = path.join(dir, 'auth-2fa.json');
  assert.equal(path.dirname(file), dir, 'beside the data, not inside the settings file');
  assert.equal(fs.readFileSync(file, 'utf8').includes('"storeName"'), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('the secret file records the last used step, so replay survives a restart', () => {
  // The anti-replay record has to be on disk. Keeping it in memory would let a restart hand out a fresh
  // budget of replays, and a restart is something an attacker can cause.
  const dir = shop();
  const e = enrolled(dir);
  // Unlocked at a *later* step than the one enrolment confirmed with, since that first code is spent.
  const at = AT + 30_000;
  const code = currentCode(e.secret, at);
  verifySecondFactor(dir, e.req, code, { atMs: at });

  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'auth-2fa.json'), 'utf8'));
  assert.ok(stored.lastStep > 0, 'a step number is recorded');
  // The step the code was from, not the wall clock at the moment of reading: what matters is that a restart
  // reloads the same number, and asserting against Date.now() would pass or fail depending on where the
  // test happened to land in its own thirty-second window.
  assert.equal(stored.lastStep, Math.floor(at / 30000));
  assert.ok(stored.lastStep > Math.floor(AT / 30000), 'and it moved forward from enrolment');
});


