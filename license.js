/**
 * Local POS — license key system.
 *
 * A key is a signed, self-contained token: it carries who it is for and when it expires, and a
 * signature that only the vendor can produce. That is deliberately the whole design — validation is
 * a signature check done locally, with no call home. A neighbourhood shop's till has to keep working
 * when the internet is down, and a licensing scheme that dials the vendor on every boot would turn a
 * dropped connection into a shop that cannot bill.
 *
 * Format (three dot-separated parts, base32-ish so it can be read over the phone and retyped):
 *
 *     LPOS-<payload>-<signature>
 *
 *   payload    base64url(JSON) — {v, id, type, features, expires, issued}
 *   signature  base64url(Ed25519(payload bytes))
 *
 * The public key below verifies keys; the private key never exists on a shop's machine. Keys are
 * produced by tools/make-license.mjs, which is run by the vendor against a private key held offline.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// The vendor's public key. Ed25519, so the public half cannot be used to mint keys. This is the
// public half of the pair in ~/.config/local-pos/license-private.pem, which never leaves the vendor's
// machine. Overridable by env only so the tests can verify against a throwaway key.
const PUBLIC_KEY = process.env.POS_LICENSE_PUBKEY
  || 'MCowBQYDK2VwAyEAInzE9v4DDG/EdAjGVBcf57aCTizqVduNAR1SozSgQkA=';

// Where a shop that wants a Pro key should write. Kept as a constant rather than repeated in strings
// so a hosted build can change one line.
export const VENDOR_CONTACT = process.env.POS_VENDOR_CONTACT || 'edupulse.tech2010@gmail.com';

// The one file a shop's machine keeps. It holds the key string they were given, nothing else.
// Honours POS_DATA_DIR the same way server.js does, so a test (or a shop that moved its data drive)
// keeps the licence beside the rest of its data rather than in the working directory.
const LICENSE_FILE = path.join(process.env.POS_DATA_DIR || path.join(process.cwd(), 'data'), 'license.json');

/** Every feature that is Pro. Kept as one list so the server and the docs cannot drift apart. */
export const PREMIUM_FEATURES = Object.freeze([
  'ai_scan',           // AI catalog scanning
  'voice_ordering',    // Voice ordering
  'whatsapp_announce', // WhatsApp announcements
  'whatsapp_payment'   // Payment screenshots
]);

/** What a paying customer can ask for by name. "everything" is expanded by the vendor tool. */
export const KNOWN_TYPES = Object.freeze(['pro', 'commercial', 'enterprise']);

const CORE_FEATURES = new Set(['billing', 'products', 'customers', 'receipts', 'inventory', 'delivery', 'reports']);

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * Decodes the payload without checking the signature.
 * Used only to show a shop what a key claims before it is trusted, never to grant a feature.
 */
export function decodeLicenseKey(key) {
  try {
    const parts = String(key || '').trim().split('.');
    if (parts.length !== 2) return null;
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * True when the key's signature matches the payload. This is the gate everything else stands on:
 * without it, anyone could edit "expires" in the payload and hand themselves a permanent license.
 */
export function verifyLicenseKey(key, publicKey = PUBLIC_KEY) {
  try {
    const parts = String(key || '').trim().split('.');
    if (parts.length !== 2) return false;
    const [payload, sig] = parts;
    const keyObject = publicKey.includes('BEGIN')
      ? crypto.createPublicKey(publicKey)
      : crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(payload, 'base64url'), keyObject, Buffer.from(sig, 'base64url'));
  } catch {
    return false;
  }
}

// Set by the tests to drive verification without touching the real vendor key.
let cachedLicense = null;

function emptyLicense() {
  return { type: 'community', features: [], valid: true, source: 'none' };
}

/**
 * The license currently in force.
 *
 * `valid:false` is a distinct state from community: a key that was entered but is forged, tampered
 * with, or expired. A shop in that state keeps all its core features — this never bricks a till —
 * and the settings screen explains what happened rather than silently dropping to free.
 */
export function loadLicense({ file = LICENSE_FILE } = {}) {
  if (cachedLicense && file === LICENSE_FILE) return cachedLicense;
  let stored = null;
  try {
    if (fs.existsSync(file)) stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    stored = null;
  }

  let result;
  if (!stored?.key) {
    result = emptyLicense();
  } else if (!verifyLicenseKey(stored.key)) {
    result = { ...emptyLicense(), valid: false, reason: 'signature', source: stored.key };
  } else {
    const payload = decodeLicenseKey(stored.key) || {};
    const expires = Number(payload.expires) || 0;
    const expired = expires > 0 && Date.now() > expires;
    result = {
      type: payload.type || 'pro',
      features: Array.isArray(payload.features) ? payload.features : [],
      customerId: payload.id || null,
      expiresAt: expires ? new Date(expires).toISOString() : null,
      valid: !expired,
      reason: expired ? 'expired' : null,
      source: stored.key
    };
  }
  if (file === LICENSE_FILE) cachedLicense = result;
  return result;
}

/** Whether a named feature is available. Community gets core features; a valid key gets what it lists. */
export function hasFeature(feature) {
  if (CORE_FEATURES.has(feature)) return true;
  const license = loadLicense();
  if (!license.valid) return false;
  if (license.type === 'commercial' || license.type === 'enterprise') return true;
  if (license.type === 'pro') {
    return license.features.includes('*') || license.features.includes(feature);
  }
  return false;
}

/**
 * Throws with a shop-readable message when a feature is not licensed.
 *
 * The message names the feature in plain words and says how to fix it, because it is shown in the
 * till's own settings screen — "requires a Local POS Pro subscription" with an activation hint.
 */
export function requireFeature(feature) {
  if (hasFeature(feature)) return;
  const license = loadLicense();
  if (!license.valid && license.reason === 'expired') {
    throw new Error('Your Local POS Pro subscription has expired. Renew it and enter the new key in Settings.');
  }
  if (!license.valid && license.reason === 'signature') {
    throw new Error('The licence key on this till is not valid. Enter the key from your purchase again in Settings.');
  }
  throw new Error(`This is a Local POS Pro feature. Enter your Pro licence key in Settings, or write to ${VENDOR_CONTACT} to get one.`);
}

/** A redacted summary safe to show in the browser: no signature, no way to reconstruct the key. */
export function getLicenseInfo() {
  const license = loadLicense();
  return {
    type: license.type || 'community',
    valid: license.valid !== false,
    reason: license.reason || null,
    features: license.features || [],
    expiresAt: license.expiresAt || null,
    customerId: license.customerId ? String(license.customerId).slice(0, 8) + '…' : null
  };
}

/**
 * Stores a key after checking it. Returns {ok, error} rather than throwing so the settings route can
 * report a bad key in words instead of a 500. Verifying before writing means a mistyped key is
 * rejected at the door rather than saved and discovered later.
 */
export function setLicenseKey(key, { file = LICENSE_FILE } = {}) {
  const trimmed = String(key || '').trim();
  if (!trimmed) return { ok: false, error: 'Enter a licence key.' };
  if (!verifyLicenseKey(trimmed)) {
    return { ok: false, error: 'That key is not valid. Check it was copied in full and try again.' };
  }
  const payload = decodeLicenseKey(trimmed) || {};
  const expires = Number(payload.expires) || 0;
  if (expires > 0 && Date.now() > expires) {
    return { ok: false, error: `That key expired on ${new Date(expires).toLocaleDateString()}.` };
  }
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ key: trimmed, enteredAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    cachedLicense = null;
    return { ok: true };
  } catch (err) {
    console.error('Failed to save licence key:', err.message);
    return { ok: false, error: 'Could not save the key on this machine.' };
  }
}

/** Removes the key, returning the till to the community edition. Core features are unaffected. */
export function clearLicense({ file = LICENSE_FILE } = {}) {
  try {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    cachedLicense = null;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
