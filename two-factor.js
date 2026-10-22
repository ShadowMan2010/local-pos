// The second factor: a code from the owner's phone, on top of the shop PIN.
//
// Why this lives beside the PIN and not inside the complaint or the updater: the PIN is the thing standing
// between somebody standing at the till and the day's money, and a four-digit code is 10,000 guesses. The
// phone adds a factor that is not written down anywhere in the shop, which is the whole point — a PIN taped
// to the monitor is one factor, twice.
//
// Design notes, because the obvious version of this is worse than none:
//   - Both factors are checked, and both are rate limited together. Verifying the PIN and then checking the
//     code separately would let somebody discover the PIN through the two-stage gate and then keep hammering
//     the second factor from a fresh counter.
//   - A wrong code costs the same as a wrong PIN: one shared budget, one lockout. A second factor with its
//     own generous counter is a second factor that protects nothing, because the PIN half is the weak one.
//   - The TOTP secret is *not* hashed, because the server has to recompute the code from it. That makes it
//     the only secret in this file that has to be stored reversibly, and it is kept out of config.json for
//     exactly that reason — see where it is written below.
//   - Used codes and spent backup codes are recorded, so a shoulder-surfed six-digit code is worth nothing
//     and a backup code works once.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { generateSecret, otpauthUrl, verifyCode, FAIL } from './totp.js';

// Shares the PIN's budget deliberately. See the note above.
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

// Per-address is the right unit for a shop with one till, but it is not the whole story: a second machine
// on the same Wi-Fi is a different address with the same five guesses. So there is a shop-wide ceiling as
// well, set well above the per-address one so that one person fumbling their own code is never locked out
// by it. It exists to make "walk around the shop and try from four devices" arithmetic that stops.
const SHOP_MAX_ATTEMPTS = 20;

const BACKUP_CODES = 10;      // enough for a year of lost phones, few enough to write down
// Twelve digits, in three groups of four.
//
// Digits and not hex, which was the first attempt. A hex code needs letters, and the box it is typed into
// is the same box as a phone code on a phone keyboard and beside the till's own on-screen keypad: a
// numeric layout cannot produce a letter, so the one person who most needs their backup codes — the
// shopkeeper whose phone is lost and who is reading the code off a card — is the one person who cannot
// type one. Twelve digits is about a trillion, against five guesses every five minutes.
//
// The dashes are for reading aloud, not typing: they are stripped on the way in, so both "000011112222"
// and "0000-1111-2222" work.
const BACKUP_CODE_DIGITS = 12;

/* ---------- where the secret lives ---------- */

/**
 * The 2FA state file, deliberately outside config.json.
 *
 * Two reasons, and the first is the important one. This secret must be *reversible* — the till has to
 * recompute a code from it — which makes it unlike the PIN, and the one thing the rest of auth.js insists
 * on is that a config file readable on the LAN never holds anything that unlocks the till. Putting it in
 * config.json would undo that. It also means the shop's ordinary settings backup carries no second factor
 * at all, so restoring a config onto a new machine cannot silently re-enrol somebody else's phone.
 *
 * The file is 0600 because the directory holding it may be looser than the file itself.
 */
function statePath(dir) {
  return path.join(dir, 'auth-2fa.json');
}

function readState(dir) {
  const file = statePath(dir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // Absent is the ordinary state of a shop that has not set one up, and must not be confused with
    // unreadable. Only a file that is *there* is treated as damaged below.
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const parsed = JSON.parse(raw); // throws on a truncated or half-written file
  return parsed && typeof parsed === 'object' ? parsed : null;
}

/**
 * Reads the state for a decision that matters, and refuses to guess.
 *
 * A file that exists but cannot be read is *not* treated as "no second factor". That is the whole point of
 * this function: readState on its own cannot tell a shop that never enrolled from a shop whose enrolled
 * state has been corrupted, and quietly answering "not enrolled" for the second one turns a disk problem
 * into the till opening on the PIN alone. The only honest answer to a file we cannot understand is that we
 * do not know, and the till stays shut until somebody sorts it out.
 */
function readStateStrict(dir) {
  try {
    return readState(dir);
  } catch (e) {
    const err = new Error('The second factor file could not be read, so the till is staying locked');
    err.code2faCorrupt = true;
    err.cause = e;
    throw err;
  }
}

/** Writes atomically, so a power cut mid-write cannot leave a half file that disables the second factor. */
function writeState(dir, state) {
  const file = statePath(dir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // A filesystem that refuses chmod is not a reason to refuse the write; the umask did what it could.
  }
}

/* ---------- the two stages of enrolment ---------- */

/**
 * Starts enrolment and returns the secret and the link to scan.
 *
 * This does *not* switch anything on. The phone has to prove it can produce a code first (see
 * `confirmEnrolment`), because a secret handed over unconfirmed is a second factor that was never really
 * set up, and the owner discovers that at 9pm on a locked till rather than during setup where it can be
 * fixed in a minute.
 */
export function beginEnrolment(dir, { account, issuer }) {
  const secret = generateSecret();
  const url = otpauthUrl({ secret, account, issuer });
  writeState(dir, { ...(readState(dir) || {}), pendingSecret: secret, pendingAccount: account });
  return { secret, url };
}

/**
 * Confirms a pending enrolment with a code from the phone, then turns the second factor on.
 *
 * @param atMs  Present only so the tests can put the phone in a known window rather than waiting 30 seconds
 *              for the code to roll over. Never passed by the server.
 */
export function confirmEnrolment(dir, code, { atMs } = {}) {
  const state = readState(dir);
  if (!state?.pendingSecret) return { ok: false, error: 'Start the setup again' };

  const res = verifyCode(state.pendingSecret, code, { window: 1, atMs });
  if (!res.ok) {
    return {
      ok: false,
      error: res.reason === FAIL.MALFORMED ? 'Enter the six digits from your phone' : 'That code is not right'
    };
  }

  const backup = makeBackupCodes();
  writeState(dir, {
    secret: state.pendingSecret,
    enabled: true,
    // The confirming step is recorded, so that same code is spent rather than becoming the first real unlock.
    // The owner's screen is showing it at the end of setup, in the shop. The cost is that the first unlock
    // after setup waits for the next window, which is a few seconds of "wait for it to change" rather than
    // a security hole.
    lastStep: res.step,
    backupHashes: backup.map(hashBackup)
  });
  return { ok: true, backupCodes: backup };
}

/** Turns the second factor off. Needs a working code, so a borrowed phone cannot quietly do this. */
export function disable(dir, code, { atMs } = {}) {
  const state = readState(dir);
  if (!state?.enabled || !state.secret) return { ok: false, error: 'There is no second factor to turn off' };
  const res = verifyCode(state.secret, code, { window: 1, atMs });
  if (!res.ok) return { ok: false, error: 'That code is not right' };
  try {
    fs.rmSync(statePath(dir), { force: true });
  } catch {
    // Already gone, which is the state we wanted.
  }
  return { ok: true };
}

/* ---------- backup codes ---------- */

// Backup codes are twelve digits in three groups of four, so the shape alone tells a phone code and a
// backup code apart before either is hashed.
function makeBackupCodes() {
  return Array.from({ length: BACKUP_CODES }, () => {
    let digits = '';
    // randomInt rather than taking a byte and modding it, so every digit is equally likely. The bias would
    // be a fraction of a percent, but a code that is very slightly easier to guess is still a code that is
    // very slightly easier to guess, and this is a one-line difference.
    for (let i = 0; i < BACKUP_CODE_DIGITS; i++) digits += crypto.randomInt(10);
    return digits.match(/.{4}/g).join('-');
  });
}

/**
 * The exact form a backup code is hashed in.
 *
 * Both sides of the comparison must agree on this down to the character, so it lives in one function that
 * `hashBackup` and `backupMatches` both call. When the two each normalised the code themselves they drifted
 * apart — the hash included the dashes, the comparison stripped them — and every backup code stopped
 * working while still looking entirely correct in the file.
 */
function normaliseBackup(code) {
  return String(code).replace(/[\s-]/g, '');
}

/** Hashed like the PIN, so a stolen state file does not hand over a working way in. */
function hashBackup(code) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(normaliseBackup(code), salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { salt, hash };
}

function backupMatches(code, stored) {
  try {
    // Folded the same way the stored hash was, so a code read off a printed card in any case and with or
    // without its dashes still matches. The dashes are in neither form, which is why they can be optional.
    const hash = crypto.scryptSync(normaliseBackup(code), stored.salt, 32, { N: 16384, r: 8, p: 1 });
    const want = Buffer.from(String(stored.hash), 'hex');
    if (hash.length !== want.length) return false;
    return crypto.timingSafeEqual(hash, want);
  } catch {
    return false;
  }
}

/** A fresh set, invalidating the old one. Only reachable with a working code. */
export function regenerateBackupCodes(dir, code, { atMs } = {}) {
  const state = readState(dir);
  if (!state?.enabled || !state.secret) return { ok: false, error: 'There is no second factor' };
  // No `lastStep` here, unlike at the gate. Regenerating is an owner action at a desk, not an unlock, and
  // the phone is showing whatever code it is showing — refusing it because the last unlock a minute ago
  // already spent that number would make the button fail for no reason the owner can see.
  const res = verifyCode(state.secret, code, { window: 1, atMs });
  if (!res.ok) return { ok: false, error: 'That code is not right' };
  const backup = makeBackupCodes();
  // The spent list is dropped along with the old set: after a regeneration the previous codes belong to a
  // card that no longer exists, so recognising them adds nothing and the shop only ever holds one set at a
  // time. Which means an old card reads as "not one of ours" rather than "already used", and that is the
  // honest answer — the owner is holding a code from a set that was cancelled on purpose.
  writeState(dir, { ...state, backupHashes: backup.map(hashBackup), spentBackupHashes: [] });
  return { ok: true, backupCodes: backup };
}

/* ---------- the gate itself ---------- */

const attempts = new Map(); // address -> { n, until }
let shopWide = { n: 0, until: 0 };

/**
 * The address the second factor's limiter counts against: the socket, and only the socket.
 *
 * Same reasoning as the PIN's limiter in auth.js, and the same mistake avoided. `X-Forwarded-For` is set by
 * whoever sends the request, so preferring it meant a guesser could present a new identity on every try and
 * the five-guess budget was never reached by anybody.
 */
function clientKey(req) {
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Forgets the guesses, once a real code has been accepted. Somebody who has just proved they hold the
 * phone is not an attacker working through a list, so neither budget keeps counting against them.
 */
function forgetAttempts(key) {
  attempts.delete(key);
  shopWide = { n: 0, until: 0 };
}

function sweep(now) {
  for (const [k, a] of attempts) if (a.until && a.until <= now) attempts.delete(k);
  if (shopWide.until && shopWide.until <= now) shopWide = { n: 0, until: 0 };
}

/**
 * Records one wrong guess against both the address and the shop, and answers with the lockout message if
 * either budget is now spent. One function, because the three call sites that used to do this arithmetic
 * inline are exactly how the replay case and the plain wrong-code case drifted apart.
 */
function charge(key) {
  const n = (attempts.get(key)?.n || 0) + 1;
  attempts.set(key, { n, until: n >= MAX_ATTEMPTS ? Date.now() + LOCKOUT_MS : 0 });
  shopWide = {
    n: shopWide.n + 1,
    until: shopWide.n + 1 >= SHOP_MAX_ATTEMPTS ? Date.now() + LOCKOUT_MS : 0
  };
  return null;
}

/** True when this shop has a second factor switched on. The UI asks so it can show the code box. */
export function isEnabled(dir) {
  const state = readState(dir);
  return Boolean(state?.enabled && state.secret);
}

/**
 * True when the file is there but unreadable — damaged, truncated, or not ours.
 *
 * Separate from `isEnabled` because the two must never be confused again. A corrupt file is not "off", and
 * answering `false` for it is how a disk error becomes an unlocked till.
 */
export function isBroken(dir) {
  try {
    readState(dir);
    return false;
  } catch {
    return true;
  }
}

/**
 * Checks the phone code, or a backup code if the phone is gone.
 *
 * The caller has already established that the PIN was right. This is the second half, and it counts the
 * same wrong guesses the PIN counts — the two are one budget, so getting the PIN right buys no free attempts
 * here.
 *
 * @returns {{ok: true} | {ok: false, error: string, clockDrift?: boolean, spent?: boolean}}
 */
export function verifySecondFactor(dir, req, code, { atMs } = {}) {
  const now = atMs ?? Date.now();
  sweep(now);
  const key = clientKey(req);
  const rec = attempts.get(key);
  // Wall-clock for the limiter, injected time for the code. A lockout is a real five minutes of the
  // shop's evening, so it must not be moved by a test's clock; the code window is what tests need to
  // control, because waiting out a 30-second step thirty times is not a test suite anybody runs.
  if ((rec && rec.until > Date.now()) || shopWide.until > Date.now()) {
    const until = Math.max(rec?.until || 0, shopWide.until);
    const mins = Math.ceil((until - Date.now()) / 60000);
    return { ok: false, error: `Too many wrong codes. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` };
  }

  const state = readStateStrict(dir);
  if (!state?.enabled || !state.secret) {
    // Reached only if 2FA was switched off between the PIN check and this one. Answering "no second factor"
    // would let a caller turn it off mid-request and walk in, so this is a refusal.
    return { ok: false, error: 'Second factor is not set up' };
  }

  const typed = String(code || '').trim();
  const spent = state.backupHashes || [];

  // A backup code and a phone code cannot be confused for one another, because they are different shapes:
  // six digits, or four-four-four hex. That means the caller can be told which kind of mistake they made,
  // which matters more than it sounds — somebody who lost their phone is typing a code off a card and needs
  // to be told the card is wrong, not asked for six digits.
  const looksLikeBackup = !/^\d{6}$/.test(typed.replace(/[\s-]/g, ''));

  // Backup codes are tried first, and only in their own shape, so a mistyped phone code never gets hashed
  // against ten scrypt records — which would turn one unlock attempt into most of a second of CPU and make
  // the till feel like it had hung.
  if (looksLikeBackup) {
    for (let i = 0; i < spent.length; i++) {
      if (backupMatches(typed, spent[i])) {
        forgetAttempts(key);
        // Moved out of the usable list as it is spent. A backup code that stayed valid would be a permanent
        // way past the phone, which is the opposite of what a backup code is for. Its hash is kept, though,
        // so a spent code can be recognised as spent rather than as a code this shop never issued.
        writeState(dir, {
          ...state,
          backupHashes: spent.filter((_, j) => j !== i),
          spentBackupHashes: [...(state.spentBackupHashes || []), spent[i]].slice(-BACKUP_CODES * 2)
        });
        return { ok: true, usedBackup: true, remaining: spent.length - 1 };
      }
    }
    // Not one of ours. An unrecognised backup code is somebody guessing at a code they cannot see, so it is
    // charged like any other wrong guess. A code of the wrong length is not: it is a misread card, and
    // charging for that locks a shopkeeper out mid-recovery.
    const digitsOnly = typed.replace(/[\s-]/g, '');
    if (digitsOnly.length === 12 && /^\d+$/.test(digitsOnly)) {
      // Charged *before* the answer, including when the code turns out to be one that was already spent.
      // Ten scrypt comparisons is real work, so an endpoint that hashes without counting is both a free
      // guessing oracle and a way to make the till feel hung by a script.
      const n = (rec?.n || 0) + 1;
      charge(key);
      // A spent code, or one from an old set, is named as such rather than as an unknown code. Somebody who
      // has already used code 3 off their card needs to be told to tick it off — not left wondering whether
      // they misread it, because they will try the next one and the one after that either way.
      const known = (state.spentBackupHashes || []).some((h) => backupMatches(typed, h));
      return {
        ok: false,
        error: known ? 'That backup code has already been used' : 'That backup code is not one of ours',
        spent: known
      };
    }
    return { ok: false, error: 'Enter the six digits from your phone' };
  }

  const res = verifyCode(state.secret, typed, { window: 1, lastStep: state.lastStep || 0, atMs: now });

  if (res.ok) {
    forgetAttempts(key);
    // Recorded before returning, so a second request carrying the same code is a replay and is refused.
    writeState(dir, { ...state, lastStep: res.step });
    return { ok: true };
  }

  // A replayed code is a code somebody has already seen, so it is treated as a wrong guess and charged.
  if (res.reason === FAIL.REPLAY) {
    charge(key);
    return { ok: false, error: 'That code was already used. Wait for the next one.' };
  }

  const n = (rec?.n || 0) + 1;
  charge(key);
  const left = MAX_ATTEMPTS - n;
  if (left <= 0) return { ok: false, error: `Too many wrong codes. Try again in ${Math.ceil(LOCKOUT_MS / 60000)} minutes.` };

  return { ok: false, error: 'That code is not right' };
}

/** Clears the second factor's limiter. Called when the PIN changes, alongside revoking every session. */
export function clearAttempts() {
  attempts.clear();
  shopWide = { n: 0, until: 0 };
}

export const twoFactorInternals = { MAX_ATTEMPTS, LOCKOUT_MS, SHOP_MAX_ATTEMPTS, BACKUP_CODES, statePath };
