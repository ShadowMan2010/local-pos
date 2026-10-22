/* One-time passwords, tested on their own against the specification's own examples.
 *
 * The RFC 6238 vectors come first and deliberately. Everything else in this file is a rule I decided on,
 * and a rule I decided on can be wrong without anything noticing; the vectors are fixed by a document
 * other people also read, so if the arithmetic is right it is right in a way that can be checked.
 *
 * A mistake in here is not a crash. It is a shopkeeper whose phone says 287082, the till saying "that code
 * is not right", and no way at all to tell whether the phone is broken, the till is broken, or somebody
 * is guessing. So these are the tests that matter most in the repository. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  base32Decode, generateSecret, currentCode, verifyCode, otpauthUrl, FAIL, totpInternals
} from '../totp.js';

const { hotp } = totpInternals;

// The specification's example secret, the twenty ASCII characters "12345678901234567890", written the way
// an authenticator app would hold it.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

/* ---------- the published examples ---------- */

test('produces the exact codes the specification lists', () => {
  // RFC 6238 appendix B. The RFC prints eight digits because it is describing the underlying HOTP; every
  // phone app shows the last six, so that is what is compared here. The final vector is at a time whose
  // step counter is 2222222222, which does not fit in 32 bits — it is here to prove the 64-bit counter
  // is real and not an accident that only works for dates before 2038.
  const vectors = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130']
  ];
  for (const [seconds, code] of vectors) {
    assert.equal(currentCode(RFC_SECRET, seconds * 1000), code, `at t=${seconds}s`);
  }
});

test('the underlying counter also matches the eight-digit specification values', () => {
  // Checked at eight digits as well, so a bug in the truncation would be caught here rather than hiding
  // behind a modulo that happened to agree for six digits.
  //
  // The counter is the time divided by the step size, which is not the same as the value quoted in the
  // specification's own third column — that column is the resulting code. Worth stating because the two
  // are easy to swap, and a swapped pair produces a test that passes for the wrong reason.
  const key = Buffer.from('12345678901234567890', 'ascii');
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130']
  ];
  for (const [seconds, code] of vectors) {
    assert.equal(hotp(key, Math.floor(seconds / 30), 8), code, `at t=${seconds}s`);
  }
});

test('a counter past two billion still works, because the counter is written as two words', () => {
  // The last specification vector sits at a step count of about 667 million, comfortably inside 32 bits, so
  // nothing in that table can tell a working 64-bit counter from a 32-bit truncation that happens to give
  // the right answer. This is the test that can.
  //
  // Where it actually bites: 2^32 steps is about 4,082 years, so this is not a realistic date problem. It
  // is that `Buffer.writeUInt32BE` refuses anything larger and throws, so the alternative was not a
  // silently wrong code but a crash on a phone that had been enrolled for longer than anyone imagined.
  const key = Buffer.from('12345678901234567890', 'ascii');
  const high = 2 ** 32 + 5;
  assert.notEqual(hotp(key, high, 8), hotp(key, 5, 8), 'the low word alone is not the answer');
  assert.equal(hotp(key, high, 8).length, 8);
});

test('the example secret decodes back to the twenty characters it stands for', () => {
  // If this is wrong then every vector above would still pass while real phones failed, because the
  // vectors and the real enrolment path would be decoding the same wrong thing.
  assert.equal(base32Decode(RFC_SECRET).toString('ascii'), '12345678901234567890');
});

/* ---------- secrets ---------- */

test('a generated secret is accepted as base32 and is long enough to matter', () => {
  for (let i = 0; i < 25; i++) {
    const secret = generateSecret();
    assert.equal(base32Decode(secret).length, 20, 'twenty bytes');
    assert.notEqual(secret, generateSecret(), 'and a different one each time');
  }
});

test('a secret that is not base32 is refused rather than half-decoded', () => {
  // Returning a short or wrong key here would produce codes that never match, so the caller must be able
  // to tell "this is not a secret" from "this secret works".
  assert.equal(base32Decode('not base32 at all!'), null, 'a stray character makes the whole thing void');
  assert.equal(base32Decode('18'), null, 'digits 1 and 8 are not in the base32 alphabet');
  // An absent secret is not corrupt, it is simply nothing, and comes back empty rather than as an error.
  // The distinction matters: `verifyCode` turns an empty key into "not set up", which tells an owner to go
  // and enrol, where a null would have read as a broken file.
  assert.equal(base32Decode('').length, 0);
  assert.equal(base32Decode(null).length, 0);
});

test('a pasted secret is forgiven for spaces, dashes and lower case', () => {
  // People retype these from a screen. Lower case and a space every few characters is the normal shape of
  // a secret that was written on paper.
  const messy = 'gezd gnbv-gy3t qojq gezdgnbvgy3tqojq';
  assert.equal(base32Decode(messy).toString('ascii'), '12345678901234567890');
});

/* ---------- checking a code ---------- */

test('a code the phone is showing right now is accepted', () => {
  const at = 1111111109 * 1000;
  const res = verifyCode(RFC_SECRET, currentCode(RFC_SECRET, at), { atMs: at });
  assert.equal(res.ok, true);
  assert.equal(res.drifted, false, 'and not reported as a clock problem when the clock is fine');
});

test('a code a little early or late is still accepted, and the clock is named as the reason', () => {
  // A till's clock and a phone's clock drift apart, and the owner has no way to make them agree. Refusing
  // an otherwise-correct code because the phone is eleven seconds fast would read as "somebody is guessing
  // at your till", which is a very different thing to tell a shopkeeper.
  //
  // Started deliberately near a window edge. A 30-second step means most instants sit a long way from a
  // boundary, and a test that picked a convenient round timestamp would silently compare the code against
  // the step it came from and never exercise the neighbouring-step path at all.
  const nowStep = Math.floor(1111111109 * 1000 / 30000);
  const at = (nowStep * 30000) + 12000; // 12 seconds into the window
  for (const offset of [-24000, -15000, 15000, 24000]) {
    const code = currentCode(RFC_SECRET, at + offset);
    const res = verifyCode(RFC_SECRET, code, { atMs: at });

    assert.equal(res.ok, true, `offset ${offset}ms`);

    // Only the codes that actually came from a *different* window should be called drift. A phone fifteen
    // seconds fast while the till is twelve seconds into its window is, at that instant, showing the code
    // for the same window the till expects — the two genuinely agree, and claiming the clock is wrong
    // there would be crying wolf on the one case where there is nothing to fix.
    const sameWindow = Math.floor((at + offset) / 30000) === nowStep;
    assert.equal(
      res.drifted,
      !sameWindow,
      `offset ${offset}ms: ${sameWindow ? 'same window' : 'neighbouring window'}, drifted=${res.drifted}`
    );
  }
});

test('a code from too far away in time is refused', () => {
  // Twice the window on either side, so this is about the size of the window and not about a near miss.
  const nowStep = Math.floor(1111111109 * 1000 / 30000);
  const at = (nowStep * 30000) + 12000;
  for (const offset of [-75000, 75000]) {
    const res = verifyCode(RFC_SECRET, currentCode(RFC_SECRET, at + offset), { atMs: at });
    assert.equal(res.ok, false, `offset ${offset}ms must be refused`);
  }
});

test('a code that already worked cannot be used a second time', () => {
  // The reason for this rule: a code read off somebody's phone over their shoulder is still a live code
  // until its window rolls over, and without a record of what was used it would work for another half
  // minute. Recorded as a step rather than the digits themselves, so the stored value is not a code.
  const at = 1111111109 * 1000;
  const code = currentCode(RFC_SECRET, at);
  const first = verifyCode(RFC_SECRET, code, { atMs: at });
  assert.equal(first.ok, true);

  const again = verifyCode(RFC_SECRET, code, { atMs: at, lastStep: first.step });
  assert.equal(again.ok, false);
  assert.equal(again.reason, FAIL.REPLAY);
});

test('an earlier code is refused once a later one has been used, however out of order it arrives', () => {
  // Phones in a shop are set to the time they are switched on, so codes can arrive out of order. Allowing
  // that would hand an attacker a free pass: work forwards to the live code, then walk back through every
  // window inside the tolerance.
  const at = 1111111109 * 1000;
  const live = verifyCode(RFC_SECRET, currentCode(RFC_SECRET, at), { atMs: at });
  const old = currentCode(RFC_SECRET, at - 30000);
  const res = verifyCode(RFC_SECRET, old, { atMs: at, lastStep: live.step });
  assert.equal(res.ok, false);
  assert.equal(res.reason, FAIL.REPLAY);
});

test('a wrong code is simply wrong, and says so', () => {
  const at = 1111111109 * 1000;
  const res = verifyCode(RFC_SECRET, '000000', { atMs: at });
  assert.equal(res.ok, false);
  assert.equal(res.reason, FAIL.WRONG);
});

test('anything that is not six digits is refused before it is compared', () => {
  // Five digits is the code one step away from being valid after a missed keystroke, so the length check
  // has to come first and it has to be exactly six.
  for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56 78', null, undefined, 123456]) {
    const res = verifyCode(RFC_SECRET, bad, { atMs: 1111111109 * 1000 });
    assert.equal(res.ok, false, `${String(bad)} must be refused`);
  }
});

test('a code typed with a stray space is still the code', () => {
  // The owner's thumbs on a touchscreen, not an attack: six digits split into groups is a natural thing to
  // type. This is about forgiving input, and it happens before any comparison.
  const at = 1111111109 * 1000;
  const code = currentCode(RFC_SECRET, at);
  assert.equal(verifyCode(RFC_SECRET, ` ${code.slice(0, 3)} ${code.slice(3)} `, { atMs: at }).ok, true);
});

test('an enrolled-but-empty secret is reported as not set up, not as a wrong code', () => {
  // These mean the shop deleted its config mid-shift rather than that a code was mistyped, and the owner
  // has to be told the difference so they do not sit there retyping a perfectly good code.
  for (const bad of ['', null, undefined, '!!!!!!!!!!!!!!!!']) {
    const res = verifyCode(bad, '287082', { atMs: 59000 });
    assert.equal(res.ok, false);
    assert.equal(res.reason, FAIL.NOT_SET_UP);
  }
});

/* ---------- enrolment ---------- */

test('the enrolment link is one an authenticator app can actually read', () => {
  const url = otpauthUrl({ secret: RFC_SECRET, account: 'owner', issuer: 'M3 POS' });
  assert.ok(url.startsWith('otpauth://totp/'), 'otpauth scheme and type');
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('secret'), RFC_SECRET);
  // These three are the fields where a scan can land in an app with different defaults and silently
  // produce codes that never match. Stating them makes the enrolment deterministic.
  assert.equal(parsed.searchParams.get('digits'), '6');
  assert.equal(parsed.searchParams.get('period'), '30');
  assert.equal(parsed.searchParams.get('algorithm'), 'SHA1');
  assert.equal(parsed.searchParams.get('issuer'), 'M3 POS');
  assert.ok(decodeURIComponent(parsed.pathname).includes('M3 POS:owner'), 'shows the shop in the app list');
});

test('a shop name with an ampersand in it does not produce a broken link', () => {
  // A scannable link is a URL, and URLs are unforgiving about spaces, ampersands and non-Latin text.
  const url = otpauthUrl({ secret: RFC_SECRET, account: 'owner@shop', issuer: 'M3 & Sons দোকান' });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('issuer'), 'M3 & Sons দোকান');
  assert.equal(parsed.searchParams.get('secret'), RFC_SECRET);
});
