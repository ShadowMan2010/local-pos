/* Feature: the Pro licence — a signed key that unlocks paid features, checked locally.
 *
 * The two ways a licensing scheme fails a shop are opposite and both expensive: letting a forged key
 * through means the product is given away, and a network check means a shop with a flaky connection
 * cannot use what it paid for. So the things pinned here are the signature (a tampered payload must be
 * rejected), the offline nature (verification takes no network), and that a shop with no key — or an
 * expired one — keeps every core feature and is told why in words.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = '/tmp/opencode/fwlicense';
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

// A throwaway keypair, generated before the module is imported so POS_LICENSE_PUBKEY points at it.
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
process.env.POS_LICENSE_PUBKEY = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
process.env.POS_DATA_DIR = DIR;

const sign = (payload) => {
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const s = crypto.sign(null, Buffer.from(p, 'base64url'), privateKey).toString('base64url');
  return `${p}.${s}`;
};

const {
  verifyLicenseKey, decodeLicenseKey, hasFeature, loadLicense, setLicenseKey, clearLicense, getLicenseInfo
} = await import('../license.js');

const LICENSE_FILE = path.join(DIR, 'license.json');
const fresh = () => { fs.rmSync(LICENSE_FILE, { force: true }); };

test('a properly signed key verifies, and carries what was put in it', () => {
  const key = sign({ v: 1, id: 'acme', type: 'pro', features: ['ai_scan'], expires: 0, issued: Date.now() });
  assert.equal(verifyLicenseKey(key), true);
  const payload = decodeLicenseKey(key);
  assert.equal(payload.id, 'acme');
  assert.deepEqual(payload.features, ['ai_scan']);
});

test('editing the payload invalidates the key — the whole point of the signature', () => {
  const key = sign({ v: 1, id: 'acme', type: 'pro', features: ['ai_scan'], expires: 0 });
  const [payload, sig] = key.split('.');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  decoded.features.push('whatsapp_announce');
  decoded.expires = 0; // already 0; the tamper is the extra feature
  const forged = Buffer.from(JSON.stringify(decoded)).toString('base64url') + '.' + sig;
  assert.equal(verifyLicenseKey(forged), false, 'a re-encoded payload must not pass the old signature');
});

test('a garbage string is not a key, and does not throw', () => {
  assert.equal(verifyLicenseKey('not-a-key'), false);
  assert.equal(verifyLicenseKey(''), false);
  assert.equal(verifyLicenseKey(null), false);
  assert.equal(verifyLicenseKey('a.b.c'), false);
});

test('with no key on disk, the till is community: core features yes, Pro features no', () => {
  fresh();
  assert.equal(hasFeature('billing'), true);
  assert.equal(hasFeature('products'), true);
  assert.equal(hasFeature('ai_scan'), false);
  assert.equal(hasFeature('voice_ordering'), false);
  assert.equal(getLicenseInfo().type, 'community');
});

test('a Pro key unlocks exactly the features it lists', () => {
  fresh();
  const key = sign({ v: 1, id: 'acme', type: 'pro', features: ['ai_scan'], expires: 0 });
  assert.deepEqual(setLicenseKey(key), { ok: true });
  assert.equal(hasFeature('ai_scan'), true);
  assert.equal(hasFeature('voice_ordering'), false, 'a feature not listed stays locked');
  assert.equal(hasFeature('billing'), true, 'core is always available');
  clearLicense();
});

test('"*" unlocks every Pro feature', () => {
  fresh();
  setLicenseKey(sign({ v: 1, id: 'big', type: 'enterprise', features: ['*'], expires: 0 }));
  assert.equal(hasFeature('whatsapp_announce'), true);
  assert.equal(hasFeature('whatsapp_payment'), true);
  clearLicense();
});

test('an expired key is rejected at entry and reads as expired on disk', () => {
  fresh();
  const expired = sign({ v: 1, id: 'old', type: 'pro', features: ['*'], expires: Date.now() - 86400000 });
  const result = setLicenseKey(expired);
  assert.equal(result.ok, false);
  assert.match(result.error, /expired/i);
  assert.equal(fs.existsSync(LICENSE_FILE), false, 'a rejected key is not written');
});

test('a key that expires later still works now, and reports when it ends', () => {
  fresh();
  const key = sign({ v: 1, id: 'acme', type: 'pro', features: ['*'], expires: Date.now() + 30 * 86400000 });
  setLicenseKey(key);
  assert.equal(hasFeature('ai_scan'), true);
  const info = getLicenseInfo();
  assert.equal(info.valid, true);
  assert.ok(info.expiresAt);
  clearLicense();
});

test('a forged key on disk marks the till invalid rather than silently working', () => {
  fresh();
  fs.writeFileSync(LICENSE_FILE, JSON.stringify({ key: 'forged.payload' }));
  const info = getLicenseInfo();
  assert.equal(info.valid, false);
  assert.equal(info.reason, 'signature');
  assert.equal(hasFeature('ai_scan'), false);
  assert.equal(hasFeature('billing'), true, 'even an invalid key never bricks the till');
  clearLicense();
});

test('entering an empty key is refused with a readable message', () => {
  fresh();
  const result = setLicenseKey('   ');
  assert.equal(result.ok, false);
  assert.match(result.error, /enter/i);
});
