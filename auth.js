// A shop PIN, so that being on the same Wi-Fi is not the same as being allowed to run the till.
//
// Before this existed every /api route was open to anyone who could reach the port. That is not a
// theoretical problem on a shop's own network: the till is deliberately reachable from phones and
// other computers, and /api/setup in particular would let a passerby repoint the bill QR at their own
// UPI ID, which is a direct theft of customer payments.
//
// Design notes, because the obvious version of this is worse than none:
//   - The PIN is stored as a scrypt hash with a per-shop salt. A config file that anyone on the LAN can
//     read must never contain the PIN itself, or the whole thing is a speed bump.
//   - Wrong guesses are rate limited per address, then locked out entirely for a while. A four-digit
//     PIN is 10,000 possibilities; without a limiter it would fall to an offline guesser in minutes.
//   - Verification is constant-time (scrypt.verify is), and the limiter counts every attempt whether
//     the PIN was right or wrong, so a correct guess cannot be used to probe the space.
//   - Tokens are held in memory, so restarting the POS signs everybody out. That is the safe direction
//     to fail: the till is unattended far more often than it is restarted.
import crypto from 'crypto';

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // a long idle spell, then ask again
const RENEW_AFTER_MS = 60 * 60 * 1000;    // top the session up when under an hour is left
const MAX_ATTEMPTS = 5;                    // before the lockout
const LOCKOUT_MS = 5 * 60 * 1000;          // 5 minutes

/* ---------- PIN hashing ---------- */

/** Creates the stored form of a PIN: salt + scrypt hash, never the PIN itself. */
export function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { salt, hash, algo: 'scrypt' };
}

/**
 * Checks a PIN against what is stored. Returns false for a missing or malformed record rather than
 * throwing, so a half-written config cannot turn into an endpoint that errors instead of refusing.
 */
export function verifyPin(pin, stored) {
  if (!stored || !stored.salt || !stored.hash) return false;
  try {
    const hash = crypto.scryptSync(String(pin), stored.salt, 32, { N: 16384, r: 8, p: 1 });
    const want = Buffer.from(String(stored.hash), 'hex');
    // Length check first: timingSafeEqual throws on a length mismatch, and a wrong-length hash is a
    // corrupt record, not a near miss.
    if (hash.length !== want.length) return false;
    return crypto.timingSafeEqual(hash, want);
  } catch {
    return false;
  }
}

/* ---------- sessions and rate limiting ---------- */

const tokens = new Map();   // token -> expiry
const attempts = new Map(); // address -> { n, until }

/**
 * The address the limiter counts against: the socket, and only the socket.
 *
 * This used to prefer `X-Forwarded-For`, which is a header a client is free to invent. A four-digit PIN
 * behind a limiter that counts by client-supplied header is not behind a limiter at all — a script sends a
 * different value on every request, never gets counted twice, and tries 10,000 PINs in the time it takes
 * to make coffee. The header is only trustworthy behind a proxy we configured ourselves, and this till is
 * not: it is a bare HTTP server on the shop's own LAN that anyone on that LAN can talk to directly.
 *
 * If somebody does put it behind a reverse proxy, the consequence is that every client shares one address
 * and the limit gets *stricter*, not weaker. That is the right way round for a till: a few wrong guesses
 * from one device briefly lock the same person out, rather than unbounded guesses from any number of
 * devices going unrecorded.
 */
function clientKey(req) {
  return req.socket?.remoteAddress || 'unknown';
}

/** Drops expired entries so a long-running till does not accumulate them forever. */
function sweep() {
  const now = Date.now();
  for (const [k, t] of tokens) if (t <= now) tokens.delete(k);
  // Only clear a counter once a real lockout has run out. A record that is still counting wrong
  // guesses has until === 0, and treating that as "expired" wiped the count on the very next attempt —
  // so the counter could never reach its own limit, never locked anybody out, and a four-digit PIN
  // stayed guessable one request at a time indefinitely. The guard on a.until is what makes the
  // limiter count at all.
  for (const [k, a] of attempts) if (a.until && a.until <= now) attempts.delete(k);
}

export function issueToken() {
  sweep();
  const token = crypto.randomBytes(24).toString('base64url');
  tokens.set(token, Date.now() + TOKEN_TTL_MS);
  return { token, expiresAt: Date.now() + TOKEN_TTL_MS };
}

export function tokenValid(req) {
  const raw = String(req.headers.authorization || '');
  const token = raw.startsWith('Bearer ') ? raw.slice(7).trim() : String(req.headers['x-pos-token'] || '');
  if (!token) return false;
  const exp = tokens.get(token);
  if (!exp) return false;
  const now = Date.now();
  if (exp <= now) { tokens.delete(token); return false; }
  // Slide the expiry forward on every use, so the timeout measures *idle* time rather than time since
  // the PIN was typed. Without this the 12 hours were counted from the moment of login, and a shop that
  // opened at 9am was locked out at 9pm in the middle of a shift - the till demanding the PIN again
  // while a customer was standing there, with nothing on screen to explain why. Idle time is also the
  // more useful thing to expire: a till nobody has touched in half a day is unattended, and locking
  // that one is the whole point of the gate. Renewing is written back at most once per RENEW_AFTER_MS
  // so a busy till does not rewrite the map on every single poll.
  if (exp - now < RENEW_AFTER_MS) tokens.set(token, now + TOKEN_TTL_MS);
  return true;
}

/** Signs every current session out. Used when the PIN itself is changed. */
export function revokeAll() {
  tokens.clear();
}

/**
 * Checks a PIN and, if it is right, hands back a session token.
 *
 * Every attempt is counted, right or wrong. The one thing that must not happen is a caller learning
 * *which* attempts were correct, so a correct guess cannot be used to measure progress toward the PIN.
 */
export function tryPin(req, pin, stored) {
  sweep();
  const key = clientKey(req);
  const rec = attempts.get(key);
  if (rec && rec.until > Date.now()) {
    const mins = Math.ceil((rec.until - Date.now()) / 60000);
    return { error: `Too many wrong PINs. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` };
  }
  if (verifyPin(pin, stored)) {
    attempts.delete(key);
    return issueToken();
  }
  const n = (rec?.n || 0) + 1;
  attempts.set(key, { n, until: n >= MAX_ATTEMPTS ? Date.now() + LOCKOUT_MS : 0 });
  const left = MAX_ATTEMPTS - n;
  if (left <= 0) return { error: `Too many wrong PINs. Try again in ${Math.ceil(LOCKOUT_MS / 60000)} minutes.` };
  // Deliberately vague about the count remaining: naming it turns the endpoint into an oracle for
  // "how close am I", which is free information for whoever is guessing.
  return { error: 'That PIN is not right' };
}

/* ---------- the gate ---------- */

// Only these are reachable without the PIN. Everything else needs a token.
//
// The list is short on purpose and each entry earns its place:
//   - GET /api/config, GET /api/products: the customer display and the weigh station are separate
//     devices with no way to type a PIN, and they genuinely need the store name, UPI ID and product
//     list to render. The product list is prices and names, which are printed on the shelf anyway.
//   - POST /api/auth/pin, GET /api/auth/status: asking for a token, and asking whether one is needed at
//     all. Deliberately just those two: /api/auth/change-pin must NOT be reachable without a token.
//   - POST /api/weigh/tickets: the scale creates a ticket. It holds no money and is spent once.
//   - GET /api/whatsapp/status: whether the shop is connected, so a till can say so.
//
// The method is part of each rule, not just the path. That distinction is the whole reason this is a
// table and not a list of paths: /api/products serves both the device-readable list on GET and product
// creation on POST, and matching on the path alone left the ability to change prices and stock open to
// anyone on the Wi-Fi — while still looking locked. Same for /api/weigh/tickets, where creating a
// ticket must be open but redeeming one is the till writing state and is not.
// Anything touching money, customers, complaints, reports, proofs or settings is behind the PIN.
const PUBLIC = [
  ['GET', /^\/api\/config$/],
  ['GET', /^\/api\/products$/],
  ['POST', /^\/api\/auth\/pin$/],
  ['GET', /^\/api\/auth\/status$/],
  ['POST', /^\/api\/weigh\/tickets$/],
  ['GET', /^\/api\/whatsapp\/status$/]
];

/** True when this exact method-and-path is one of the few things a device without a PIN may do. */
export function isPublic(method, path) {
  return PUBLIC.some(([m, re]) => m === method && re.test(path));
}

/**
 * Express middleware requiring a valid session token for everything outside PUBLIC.
 *
 * The refusal is deliberately unhelpful to a caller with no token (it says only that a PIN is needed,
 * not whether one exists), and specific enough to be usable by the till's own login screen.
 */
export function requirePin(getPin) {
  return (req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    // A shop that has not set a PIN is not protected yet, and refusing every route would leave the
    // till dead on its very first run with no way back in. The gate is opt-in and switches itself on
    // the moment a PIN is stored, which is why this returns early here and why the rule below is the
    // only thing that decides anything afterwards.
    if (!getPin()) return next();
    if (isPublic(req.method, req.path)) return next();
    if (tokenValid(req)) return next();
    res.status(401).json({
      error: 'Enter the shop PIN to use this screen',
      needsPin: true,
      pinSet: Boolean(getPin())
    });
  };
}

export const authInternals = { MAX_ATTEMPTS, LOCKOUT_MS, TOKEN_TTL_MS, RENEW_AFTER_MS, PUBLIC };
