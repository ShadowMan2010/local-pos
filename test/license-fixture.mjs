/* A throwaway licence keypair for tests that need a Pro feature to be unlocked.
   Never the vendor's real key: a test that could mint production licences would be a test that can
   hand out the product for free if it ever leaked into a build. This generates a fresh pair per run,
   signs a key with it, and hands back the env the server needs to trust that key. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {object} opts
 * @param {string} opts.dir       the test's POS_DATA_DIR — the licence file is written here
 * @param {string} [opts.type]    pro | commercial | enterprise
 * @param {string[]} [opts.features]
 * @param {number} [opts.days]    days until expiry
 * @returns {{ env: object, key: string }} env additions to merge into the server's spawn env
 */
export function issueTestLicense({ dir, type = 'pro', features = ['*'], days = 30 } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const payload = {
    v: 1,
    id: 'test-suite',
    type,
    features,
    expires: Date.now() + days * 86400000,
    issued: Date.now()
  };
  const payloadPart = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.sign(null, Buffer.from(payloadPart, 'base64url'), privateKey).toString('base64url');
  const key = `${payloadPart}.${signature}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify({ key, enteredAt: new Date().toISOString() }));
  return { env: { POS_LICENSE_PUBKEY: pubB64 }, key };
}
