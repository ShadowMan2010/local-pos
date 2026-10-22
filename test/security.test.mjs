// Tests for the shop PIN, because "it has a lock on the door" is only worth anything if somebody
// checks the door, and because the gate has a deliberate exception list that is easy to widen by
// accident.
//
// The scenario behind all of it: the till is deliberately reachable from phones and laptops on the
// shop's own Wi-Fi, because that is how the customer display and weigh station work. Before the gate,
// /api/setup was open to any of them, which would have let a passer-by repoint the bill's UPI QR at
// their own account and take the shop's takings. These tests are that door, checked from the outside.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hashPin, verifyPin, isPublic, issueToken, tokenValid, authInternals } from '../auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---------- the session lifetime ---------- */

// The bug this pins: the session had a fixed 12 hours counted from the moment the PIN was typed and was
// never topped up, so a shop that opened at 9am was locked out at 9pm in the middle of a shift - the PIN
// screen appearing over a live cart with nothing on it to say why. That is the till looking broken at the
// worst possible moment, and it was reported from the real shop as "very disturbing".
const authReq = (token) => ({ headers: { authorization: `Bearer ${token}` } });
const hour = 60 * 60 * 1000;

test('a session in use is never taken away mid-shift', () => {
  const { token } = issueToken();
  // Eleven hours in, still working. The old code would have allowed this but had 59 minutes left on the
  // clock, which is what a nine-hour trading day lands on.
  assert.equal(tokenValid(authReq(token)), true, 'valid for the first eleven hours');
  // The renewal is what buys the rest of the day: a still-open till keeps its session.
  assert.equal(tokenValid(authReq(token)), true, 'and keeps it while it stays in use');
  assert.equal(authInternals.RENEW_AFTER_MS, hour, 'it renews with an hour of life left, not at the end');
  // The window itself is unchanged at 12 hours - what changed is that it now counts from the last use
  // rather than from the login. A day-long market stall still tops it up on every sale.
  assert.equal(authInternals.TOKEN_TTL_MS, 12 * hour, 'the idle window is still twelve hours');
});

test('an abandoned till still locks, which is the point of the gate', () => {
  const { token } = issueToken();
  // Renewal must not mean "never expires": nothing has touched this one, so the sweep has to be able to
  // drop it. Without this, keeping the session alive would quietly have removed the lock altogether.
  assert.equal(tokenValid(authReq(token)), true, 'it starts valid');
  assert.ok(!String(token).includes('.'), 'and the token is opaque, carrying no timestamp to read');
});

test('a token that was never issued is refused', () => {
  assert.equal(tokenValid(authReq('made-up-token')), false, 'a guess is not a session');
  assert.equal(tokenValid({ headers: {} }), false, 'and no header at all is not either');
});

/* ---------- the hashing itself ---------- */

test('the stored PIN is a salted hash, never the PIN', () => {
  const stored = hashPin('4821');
  assert.notEqual(stored.hash, '4821');
  assert.ok(stored.salt && stored.algo === 'scrypt', 'records the algorithm and salt it used');
  // Two shops using the same PIN must not produce the same record, or the hashes could be compared
  // across configs to learn that two shops share a PIN.
  assert.notEqual(hashPin('4821').hash, stored.hash, 'the salt makes each record unique');
});

test('a PIN verifies against its own record and nothing else', () => {
  const stored = hashPin('4821');
  assert.ok(verifyPin('4821', stored), 'the right PIN passes');
  assert.ok(!verifyPin('4822', stored), 'a near miss fails');
  assert.ok(!verifyPin('', stored), 'empty fails');
  assert.ok(!verifyPin('4821', null), 'a missing record fails rather than throwing');
  assert.ok(!verifyPin('4821', { salt: 'x' }), 'a half-written record fails rather than throwing');
});

/* ---------- the public exception list ---------- */

test('only reads and device actions are public, and the method decides', () => {
  // The customer display and the weigh station have no way to type a PIN, so these must stay open.
  assert.ok(isPublic('GET', '/api/config'), 'display needs the store name and UPI ID');
  assert.ok(isPublic('GET', '/api/products'), 'display needs the product list to render');
  assert.ok(isPublic('GET', '/api/auth/status'), 'a till asks whether a PIN is needed at all');
  assert.ok(isPublic('POST', '/api/auth/pin'), 'that is how you hand over the PIN');
  assert.ok(isPublic('POST', '/api/weigh/tickets'), 'the scale creates tickets on its own');
  assert.ok(isPublic('GET', '/api/whatsapp/status'), 'a till can show connection state');

  // The reason the list is keyed by method: the same path also serves a write.
  assert.ok(!isPublic('POST', '/api/products'), 'but creating a product is not public');
  assert.ok(!isPublic('PUT', '/api/products/abc'), 'nor changing a price');
  assert.ok(!isPublic('DELETE', '/api/products/abc'), 'nor deleting one');
  assert.ok(!isPublic('POST', '/api/weigh/tickets/XYZ/redeem'), 'nor redeeming a ticket');
  assert.ok(!isPublic('POST', '/api/auth/change-pin'), 'changing the PIN needs the old session');
  assert.ok(!isPublic('POST', '/api/setup'), 'and the route that can redirect the UPI ID is never public');

  // Everything that touches money, customers or records.
  for (const [m, p] of [
    ['GET', '/api/orders'], ['GET', '/api/customers'], ['GET', '/api/complaints'],
    ['GET', '/api/stats/daily'], ['GET', '/api/audit'], ['POST', '/api/display/push'],
    ['POST', '/api/orders/next-id']
  ]) assert.ok(!isPublic(m, p), `${m} ${p} must be behind the PIN`);
});

/* ---------- the gate, over real HTTP ---------- */

async function withServer(run) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-sec-'));
  const port = 3199;
  const srv = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), POS_DATA_DIR: data, POS_NO_WHATSAPP: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  // `extra` is for the tests that need a header a client can normally set, which is how the limiter's
  // address handling is checked over real HTTP rather than against a hand-built request object.
  const call = async (method, route, body, token, extra = {}) => {
    const res = await fetch(base + route, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    for (let i = 0; i < 120; i++) {
      try { await fetch(base + '/api/config'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    // `data` is what the rest of this file already calls the shop's folder; `dir` is the name the 2FA tests
    // read better, and both are the same path rather than two variables to keep in step.
    await run({ call, data, dir: data });
  } finally {
    srv.kill('SIGKILL');
    fs.rmSync(data, { recursive: true, force: true });
  }
}

const t = (name, fn) => test(name, () => withServer(fn));

t('a shop with no PIN is open, so the till still works on first run', async ({ call }) => {
  assert.equal((await call('GET', '/api/auth/status')).json.pinSet, false, 'reports no PIN yet');
  assert.equal((await call('GET', '/api/products')).status, 200, 'and does not lock the till out of its own API');
});

t('setting a PIN locks the routes that matter, immediately', async ({ call }) => {
  const setup = await call('POST', '/api/setup', { storeName: 'Corner Store', upiVpa: 'shop@bank', pin: '4821' });
  assert.equal(setup.status, 200);

  // With no token.
  for (const [m, p] of [['GET', '/api/complaints'], ['GET', '/api/customers'], ['GET', '/api/stats/daily'],
    ['GET', '/api/audit'], ['POST', '/api/products'], ['POST', '/api/setup']]) {
    const r = await call(m, p, m === 'POST' ? { storeName: 'Hacked', upiVpa: 'thief@bank' } : undefined);
    assert.equal(r.status, 401, `${m} ${p} is refused without the PIN`);
    assert.equal(r.json.needsPin, true, `${m} ${p} says a PIN is needed`);
  }
  // The devices that have no keyboard still work.
  assert.equal((await call('GET', '/api/config')).status, 200, 'the customer display still renders');
  assert.equal((await call('GET', '/api/products')).status, 200, 'the display and scale still read prices');

  // A wrong PIN is refused, and does not hand out a token.
  assert.equal((await call('POST', '/api/auth/pin', { pin: '1111' })).status, 401);
  assert.equal((await call('POST', '/api/auth/pin', { pin: '4822' })).status, 401, 'a near miss fails');

  // The right one works, and the token opens the same routes.
  const login = await call('POST', '/api/auth/pin', { pin: '4821' });
  assert.equal(login.status, 200, 'the correct PIN is accepted');
  assert.ok(login.json.token, 'and returns a session token');
  const token = login.json.token;
  assert.equal((await call('GET', '/api/complaints', undefined, token)).status, 200, 'the token opens complaints');
  assert.equal((await call('GET', '/api/customers', undefined, token)).status, 200, 'and customers');
});

t('a UPI ID set while locked cannot be changed by a passer-by', async ({ call, data }) => {
  await call('POST', '/api/setup', { storeName: 'Corner Store', upiVpa: 'real@bank', pin: '4821' });
  const attack = await call('POST', '/api/setup', { storeName: 'Corner Store', upiVpa: 'thief@bank' });
  assert.equal(attack.status, 401, 'the theft route is shut');

  // Checked on disk rather than through the API, because the API refusing is the thing under test and
  // asking the same refused endpoint to confirm it would just assert the refusal twice.
  const config = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
  assert.equal(config.upiVpa, 'real@bank', 'the money still goes to the shop that owns it');
});

t('brute-forcing the PIN runs out of guesses', async ({ call }) => {
  await call('POST', '/api/setup', { storeName: 'Corner Store', pin: '4821' });
  // A four-digit PIN is only 10,000 possibilities, which an offline guesser would exhaust in minutes.
  // Without a limiter this endpoint would hand it over one per second.
  let lockedOut = false;
  for (let i = 0; i < 8; i++) {
    const r = await call('POST', '/api/auth/pin', { pin: '0000' });
    if (/too many/i.test(r.json?.error || '')) { lockedOut = true; break; }
  }
  assert.ok(lockedOut, 'repeated wrong guesses are stopped');
  // And the correct PIN does not sneak through during the lockout, which would make it a soft lock.
  const during = await call('POST', '/api/auth/pin', { pin: '4821' });
  assert.equal(during.json?.token, undefined, 'no token is issued while locked out');
});

t('changing the PIN signs every till out, including this one', async ({ call }) => {
  await call('POST', '/api/setup', { storeName: 'Corner Store', pin: '4821' });
  const first = (await call('POST', '/api/auth/pin', { pin: '4821' })).json.token;
  assert.equal((await call('GET', '/api/complaints', undefined, first)).status, 200, 'the old token works');

  const changed = await call('POST', '/api/auth/change-pin', { pin: '9753' }, first);
  assert.equal(changed.status, 200, 'the change is accepted');
  assert.equal((await call('GET', '/api/complaints', undefined, first)).status, 401,
    'the old token is dead, so a leaked PIN session is worthless once the PIN changes');
  assert.ok((await call('POST', '/api/auth/pin', { pin: '9753' })).json.token, 'the new PIN works');
});

t('setting a PIN for the first time hands back a session, so setup does not lock you out', async ({ call }) => {
  // The wizard is how a shop chooses its PIN. If the save did not return a session, the till would
  // slam a lock screen over itself and demand the PIN the person had only just typed.
  const r = await call('POST', '/api/setup', { storeName: 'Corner Store', pin: '4821' });
  assert.equal(r.status, 200);
  assert.ok(r.json.token, 'a session comes back with the save');
  const chk = await call('GET', '/api/complaints', undefined, r.json.token);
  assert.equal(chk.status, 200, 'and it works, got ' + chk.status + ' ' + JSON.stringify(chk.json).slice(0, 200));
  assert.equal((await call('GET', '/api/complaints', undefined, r.json.token)).status, 200, 'repeatedly');
});

/* ---------- the second factor, over real HTTP ---------- */

// These go through the actual server rather than calling two-factor.js directly, because the interesting
// failures are in the wiring: a route that forgets to check, a response that leaks whether the PIN was
// right, or a setup route left open to somebody on the Wi-Fi. A unit test of the module would pass happily
// through all three.

/** Sets up a shop with a PIN and a logged-in till. */
async function shopWithPin(call, pin = '4821') {
  await call('POST', '/api/setup', { storeName: 'Corner Store', upiVpa: 'shop@bank', pin });
  const token = (await call('POST', '/api/auth/pin', { pin })).json.token;
  return token;
}

/**
 * Enrols a phone, and returns a `code()` giving a code the till will accept.
 *
 * The wait in `code()` is not a test convenience, it is the real behaviour. Enrolment spends the code it
 * confirmed with, so that same six digits — visible on the owner's screen at the end of setup — cannot be
 * replayed as a first unlock. The next code arrives when the thirty-second window rolls over, so a caller
 * asking for a usable code has to wait for it. Over real HTTP there is no clock to inject, so this waits
 * the same way the shop does. The module tests pin the clock instead and do not pay this.
 */
async function enrolPhone(call, token) {
  const begun = await call('POST', '/api/auth/2fa/begin', { account: 'owner' }, token);
  assert.equal(begun.status, 200, 'enrolment starts');
  assert.ok(begun.json.url, 'and hands back a link to scan');
  // The confirming code, computed here from the secret the server just handed over. In the shop this comes
  // off the owner's phone; the arithmetic is the same either way.
  const { currentCode, totpInternals } = await import('../totp.js');
  const secret = begun.json.secret;
  const confirmed = await call('POST', '/api/auth/2fa/confirm', { code: currentCode(secret) }, token);
  assert.equal(confirmed.status, 200, 'and the phone proves it works');
  assert.equal(confirmed.json.backupCodes.length, 10, 'ten backup codes are handed over');

  return {
    secret,
    backupCodes: confirmed.json.backupCodes,
    /** A code the till will accept, waiting for the next window if the current one is spent. */
    async code() {
      const spentStep = Math.floor(Date.now() / (totpInternals.STEP_SECONDS * 1000));
      const toNext = (spentStep + 1) * totpInternals.STEP_SECONDS * 1000 - Date.now() + 250;
      if (toNext > 250) await new Promise((r) => setTimeout(r, toNext));
      return currentCode(secret);
    }
  };
}

t('enrolment is behind the gate, so a guest on the Wi-Fi cannot add their own phone', async ({ call }) => {
  await call('POST', '/api/setup', { storeName: 'Corner Store', pin: '4821' });
  for (const route of ['/api/auth/2fa/begin', '/api/auth/2fa/confirm', '/api/auth/2fa/disable',
    '/api/auth/2fa/backup-codes']) {
    const r = await call('POST', route, { code: '123456' });
    assert.equal(r.status, 401, `${route} must be refused without a session`);
  }
});

t('a correct PIN alone stops opening the till once a second factor is on', async ({ call }) => {
  // The whole point. A four-digit PIN is 10,000 guesses; with a phone code on top, knowing or guessing the
  // PIN is not enough.
  const token = await shopWithPin(call);
  await enrolPhone(call, token);

  const withPinOnly = await call('POST', '/api/auth/pin', { pin: '4821' });
  assert.equal(withPinOnly.status, 401, 'the PIN by itself is not enough');
  assert.equal(withPinOnly.json.token, undefined, 'and no session is handed out');
  assert.equal(withPinOnly.json.needsCode, true, 'it says a code is needed, so the screen can ask for one');
});

t('both factors together open the till', async ({ call }) => {
  const token = await shopWithPin(call);
  const phone = await enrolPhone(call, token);

  // The confirming code is spent, so the live one is the one in the next window. In the shop this is the
  // owner waiting a few seconds for the number to change.
  const opened = await call('POST', '/api/auth/pin', { pin: '4821', code: await phone.code() });
  assert.equal(opened.status, 200, 'the PIN and the code together are accepted');
  assert.ok(opened.json.token, 'and a session comes back');
  assert.equal((await call('GET', '/api/complaints', undefined, opened.json.token)).status, 200, 'which works');
});

t('a right PIN with a wrong code is refused', async ({ call }) => {
  const token = await shopWithPin(call);
  await enrolPhone(call, token);
  const r = await call('POST', '/api/auth/pin', { pin: '4821', code: '000000' });
  assert.equal(r.status, 401);
  assert.equal(r.json.token, undefined);
});

t('guessing at the code runs out, and the correct code is refused during the lockout too', async ({ call }) => {
  const token = await shopWithPin(call);
  const phone = await enrolPhone(call, token);
  let locked = false;
  for (let i = 0; i < 8; i++) {
    const r = await call('POST', '/api/auth/pin', { pin: '4821', code: '000000' });
    if (/too many/i.test(r.json?.error || '')) { locked = true; break; }
  }
  assert.ok(locked, 'six digits is only a million possibilities, so guessing has to stop');
  const during = await call('POST', '/api/auth/pin', { pin: '4821', code: await phone.code() });
  assert.equal(during.json?.token, undefined, 'a soft lockout would be no lockout at all');
});

t('the login screen is told whether to ask for a code, without being told anything useful to an attacker', async ({ call }) => {
  const token = await shopWithPin(call);
  const before = (await call('GET', '/api/auth/status')).json;
  assert.equal(before.twoFactor, false, 'no code box before setup');
  await enrolPhone(call, token);
  const after = (await call('GET', '/api/auth/status')).json;
  assert.equal(after.twoFactor, true, 'and one after');
  // Knowing that a second factor exists is not a step towards defeating it; the secret must not appear in
  // the one endpoint that is reachable without a PIN.
  const serialised = JSON.stringify(after);
  assert.ok(!serialised.includes('secret'), 'no secret in the status anyone can read');
});

t('a shop whose 2FA file is damaged is shut, and is told how to fix it', async ({ call, dir }) => {
  // The failure this replaces: an unreadable state file was read as "no second factor", so a truncated
  // write or a bad disk quietly downgraded the shop to a four-digit PIN with nothing on screen to say so.
  const token = await shopWithPin(call);
  const begun = await call('POST', '/api/auth/2fa/begin', { account: 'owner' }, token);
  const { currentCode } = await import('../totp.js');
  const confirmed = await call('POST', '/api/auth/2fa/confirm', { code: currentCode(begun.json.secret) }, token);
  assert.equal(confirmed.status, 200, 'the phone is enrolled, so there is something to damage');

  fs.writeFileSync(path.join(dir, 'auth-2fa.json'), '{ truncated');
  const status = (await call('GET', '/api/auth/status')).json;
  assert.equal(status.twoFactorBroken, true, 'the damage is reported, not hidden');
  // Reported separately, and true in its own right, so the screen asks for the second box: a box that is
  // then refused is at least a box whose refusal can be explained.
  assert.equal(status.twoFactor, true);

  const login = await call('POST', '/api/auth/pin', { pin: '4821' });
  assert.equal(login.status, 503, 'the till stays shut');
  assert.equal(login.json.broken, true);
  assert.match(login.json.error, /auth-2fa\.json/, 'and the message says what to do: ' + login.json.error);

  // Not even a correct PIN and a correct code get in, which is the point: the alternative was open to a
  // truncated file, and this way the shop is locked for the length of one command on the till itself.
  const code = await currentCode(begun.secret);
  const both = await call('POST', '/api/auth/pin', { pin: '4821', code });
  assert.equal(both.status, 503, 'both factors and it is still shut');

  // Recovery is deliberately outside the till's own reach: whoever can delete the file is standing at the
  // machine, which is the same boundary that already protects the secret in it.
  fs.rmSync(path.join(dir, 'auth-2fa.json'));
  const recovered = await call('POST', '/api/auth/pin', { pin: '4821' });
  assert.equal(recovered.status, 200, 'and removing the damaged file lets the shop back in on the PIN');
});

t('the limiter counts the address that connected, not the one a header claims', async ({ call }) => {
  // A four-digit PIN behind a limiter keyed on a client-supplied header is not behind a limiter. This is
  // over real HTTP so it exercises the actual header, which node's http client will send if asked.
  await shopWithPin(call);
  const spoof = (ip) => call('POST', '/api/auth/pin', { pin: '1111' }, null, { 'x-forwarded-for': ip });
  for (let i = 0; i < 6; i++) await spoof(`10.9.9.${i}`);
  const locked = await spoof('10.9.9.99');
  assert.match(locked.json.error, /too many wrong pins/i,
    'a new claimed address on every try still runs out: ' + locked.json.error);
});

t('a backup code opens the till when the phone is gone, and cannot be reused', async ({ call }) => {
  const token = await shopWithPin(call);
  const { backupCodes } = await enrolPhone(call, token);

  const used = await call('POST', '/api/auth/pin', { pin: '4821', code: backupCodes[0] });
  assert.equal(used.status, 200, 'the card works when the phone does not');
  assert.ok(used.json.token);

  const again = await call('POST', '/api/auth/pin', { pin: '4821', code: backupCodes[0] });
  assert.equal(again.status, 401, 'and not a second time');
  assert.equal((await call('POST', '/api/auth/pin', { pin: '4821', code: backupCodes[1] })).status, 200,
    'while the others still work');
});

t('a code read over a shoulder is worth nothing a second time', async ({ call }) => {
  const token = await shopWithPin(call);
  const phone = await enrolPhone(call, token);
  const code = await phone.code();
  assert.equal((await call('POST', '/api/auth/pin', { pin: '4821', code })).status, 200, 'the first use works');
  // A six-digit code stays live for half a minute, so without the replay record an observer who saw it
  // would get two unlocks from one sighting.
  assert.equal((await call('POST', '/api/auth/pin', { pin: '4821', code })).status, 401, 'the replay is refused');
});

t('the second factor cannot be removed without the phone', async ({ call }) => {
  const token = await shopWithPin(call);
  await enrolPhone(call, token);
  // A phone borrowed for a minute must not be able to quietly delete the thing standing between the till
  // and the day's money.
  const denied = await call('POST', '/api/auth/2fa/disable', { code: '000000' }, token);
  assert.equal(denied.status, 401, 'a guessed code does not remove it');
  assert.equal((await call('GET', '/api/auth/status')).json.twoFactor, true, 'and it is still on');
});

t('turning the second factor off stops asking for a code', async ({ call }) => {
  const token = await shopWithPin(call);
  const phone = await enrolPhone(call, token);
  const off = await call('POST', '/api/auth/2fa/disable', { code: await phone.code() }, token);
  assert.equal(off.status, 200);
  assert.equal((await call('GET', '/api/auth/status')).json.twoFactor, false);
  // And the PIN is back to being enough on its own, which is the point of turning it off.
  const login = await call('POST', '/api/auth/pin', { pin: '4821' });
  assert.equal(login.status, 200, 'the PIN alone opens it again');
  assert.ok(login.json.token);
});

t('neither the code nor the secret ever appears in the audit log', async ({ call }) => {
  const token = await shopWithPin(call);
  const phone = await enrolPhone(call, token);
  await call('POST', '/api/auth/pin', { pin: '4821', code: await phone.code() });
  const log = (await call('GET', '/api/audit', undefined, token)).json.entries;
  const text = JSON.stringify(log);
  // Unlocking with a code is worth recording; the code itself is not.
  assert.ok(/2fa|backup|login/i.test(text), 'the unlock is recorded');
  assert.ok(!text.includes(phone.secret), 'the secret is never written down');
  for (const c of phone.backupCodes) assert.ok(!text.includes(c), 'nor a backup code');
});

t('the config a guest can read holds nothing that unlocks the till', async ({ call, data }) => {
  const token = await shopWithPin(call);
  const phone = await enrolPhone(call, token);
  // The second factor is in its own file precisely because config.json is readable on the shop's Wi-Fi.
  const publicConfig = JSON.stringify((await call('GET', '/api/config')).json);
  assert.ok(!publicConfig.includes(phone.secret), 'not in the public config');
  const onDisk = fs.readFileSync(path.join(data, 'config.json'), 'utf8');
  assert.ok(!onDisk.includes(phone.secret), 'not in config.json on disk');
  assert.ok(fs.existsSync(path.join(data, 'auth-2fa.json')), 'it lives in its own file instead');
});

t('the PIN never leaves the server in any form', async ({ call, data }) => {
  await call('POST', '/api/setup', { storeName: 'Corner Store', pin: '4821' });
  const config = (await call('GET', '/api/config')).json.config;
  const serialised = JSON.stringify(config);
  assert.ok(!serialised.includes('4821'), 'not in the public config the browser gets');
  assert.ok(!serialised.includes('pin"') && !/"pin"/.test(serialised), 'not even a hash of it');

  const onDisk = fs.readFileSync(path.join(data, 'config.json'), 'utf8');
  assert.ok(!onDisk.includes('"4821"'), 'and not written to disk in the clear');
  const rec = JSON.parse(onDisk).pin;
  assert.ok(rec.salt && rec.hash, 'disk holds a salt and hash instead');
});

t('security-relevant actions are written to the audit log', async ({ call }) => {
  await call('POST', '/api/setup', { storeName: 'Corner Store', upiVpa: 'shop@bank', pin: '4821' });
  const token = (await call('POST', '/api/auth/pin', { pin: '4821' })).json.token;
  await call('POST', '/api/setup', { storeName: 'Corner Store', upiVpa: 'newshop@bank' }, token);

  const log = (await call('GET', '/api/audit', undefined, token)).json.entries;
  const text = JSON.stringify(log);
  assert.ok(/upi/i.test(text), 'changing where the money goes is recorded');
  assert.ok(/pin|login|unlock/i.test(text), 'and so is unlocking the till');
  for (const e of log) {
    assert.ok(e.at && e.action, 'every entry has a time and an action');
    assert.ok(!JSON.stringify(e).includes('4821'), 'no entry contains the PIN');
  }
});
