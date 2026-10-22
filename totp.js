// One-time passwords, as Google Authenticator and every other authenticator app produces them.
//
// This is RFC 6238 (TOTP) over RFC 4226 (HOTP), with the defaults every phone app already uses: HMAC-SHA1,
// a 30-second step, six digits. Written out rather than pulled in as a package for two reasons. The first
// is size: a shop's release is a few hundred kilobytes and a TOTP library would be a dependency tree in
// exchange for about eighty lines. The second is that the verification is the one piece of this that has
// to be exactly right, and code you can read end to end is worth more here than code you did not write.
//
// The important property, and the reason this file is careful about everything: a TOTP secret is not
// hashable. Unlike the PIN, the server has to *recompute* the code, so it has to keep something it can
// reverse. That is a genuinely different kind of secret and it is treated as one — see `auth.js`.
import crypto from 'node:crypto';

const STEP_SECONDS = 30;   // what every authenticator app uses; changing it breaks every enrolled phone
const DIGITS = 6;           // ditto
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // base32, the alphabet Google Authenticator expects

/* ---------- base32 ---------- */

/**
 * Base32 without padding, which is how authenticator apps carry a secret.
 *
 * Case-folded and tolerant of the spaces and dashes people paste in by hand, because the alternative is a
 * setup screen that fails for a reason the shopkeeper cannot see or fix.
 */
export function base32Decode(secret) {
  const clean = String(secret || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!clean) return Buffer.alloc(0);
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) return null; // not a secret; refuse rather than guess
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** A fresh 20-byte secret. 160 bits is the size RFC 4226 recommends and every app accepts. */
export function generateSecret(bytes = 20) {
  const raw = crypto.randomBytes(bytes);
  let bits = '';
  for (const b of raw) bits += b.toString(2).padStart(8, '0');
  const out = [];
  for (let i = 0; i < bits.length; i += 5) out.push(ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]);
  return out.join('');
}

/* ---------- the code itself ---------- */

/**
 * The HOTP value for one counter, per RFC 4226.
 *
 * Dynamic truncation: the last nibble of the HMAC picks which four bytes are the number, and the top bit
 * of the first of them is masked off. The masking is not optional — without it a code could reach 10^8 and
 * the modulo below would quietly produce the wrong digits for a slice of secrets.
 */
function hotp(key, counter, digits = DIGITS) {
  const buf = Buffer.alloc(8);
  // Big-endian 64-bit counter, written as a high and a low word. writeUInt32BE is capped at 32 bits, so
  // the naive `writeBigInt64BE` alternative is avoided here and the arithmetic is done by hand instead.
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const digest = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The code a phone is showing right now, for this secret and this moment. */
export function currentCode(secret, atMs = Date.now()) {
  const key = base32Decode(secret);
  if (!key || !key.length) return null;
  return hotp(key, Math.floor(atMs / 1000 / STEP_SECONDS));
}

/**
 * The URI a phone camera scans to enrol.
 *
 * `otpauth://totp/...` is the de facto standard, and the issuer and label are the only two fields that
 * make an authenticator app list this account under something recognisable. The digits and period are
 * stated explicitly even though they are the defaults, because a scan that lands in an app with different
 * defaults produces codes that never match and gives the shopkeeper nothing to go on.
 */
export function otpauthUrl({ secret, account, issuer, digits = DIGITS, period = STEP_SECONDS }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(digits),
    period: String(period)
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* ---------- checking one ---------- */

/**
 * Everything about why a code was refused.
 *
 * The distinction that matters most is `clock`: a phone whose clock has drifted produces codes that are
 * simply wrong, and it looks identical to somebody guessing. Telling the owner "your phone's clock is
 * off" is the difference between a fixable annoyance and a shop that thinks it has been hacked.
 */
export const FAIL = {
  WRONG: 'wrong',
  CLOCK: 'clock',
  REPLAY: 'replay',
  MALFORMED: 'malformed',
  NOT_SET_UP: 'not-set-up'
};

/**
 * Checks a code a person typed.
 *
 * `window` of 1 accepts the previous, current and next step — about 90 seconds of tolerance in total. That
 * covers ordinary clock drift between a phone and a shop's till, which is the normal case and not an
 * attack. A larger window would meaningfully widen the guessable space, so it is not the default.
 *
 * `lastStep` is the anti-replay half: the same code must not work twice, because a code shoulder-surfed
 * off a screen is still a valid code until its window rolls over. Step numbers only ever go up, so an
 * out-of-order code is refused too.
 *
 * @returns {{ok: boolean, reason?: string, step?: number}}
 */
export function verifyCode(secret, code, { atMs = Date.now(), window = 1, lastStep = 0 } = {}) {
  const key = base32Decode(secret);
  if (!key || !key.length) return { ok: false, reason: FAIL.NOT_SET_UP };

  // Compared as a string, but only after reducing to exactly six digits, so "012345" and "12345" and
  // " 12345 " are the same code. This is about the owner's thumbs, not about an attacker.
  const typed = String(code || '').replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(typed)) return { ok: false, reason: FAIL.MALFORMED };

  const now = Math.floor(atMs / 1000 / STEP_SECONDS);
  for (let w = -window; w <= window; w++) {
    const step = now + w;
    if (step < 0) continue;
    // timingSafeEqual needs equal lengths, and both sides are already six digits.
    if (crypto.timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(typed))) {
      if (step <= lastStep) return { ok: false, reason: FAIL.REPLAY };
      // A code that matched a neighbouring step is accepted, and `drifted` tells the caller why: the
      // owner's phone clock is off, not an attacker. That is a fixable annoyance and worth saying so
      // rather than reporting a plain "wrong code".
      return { ok: true, step, drifted: w !== 0 };
    }
  }
  return { ok: false, reason: FAIL.WRONG };
}

export const totpInternals = { STEP_SECONDS, DIGITS, hotp };
