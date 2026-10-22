#!/usr/bin/env node
/**
 * Local POS — licence key generator (VENDOR ONLY).
 *
 * This mints Pro keys. It needs the private key, so it must never be run on a shop's machine and the
 * private key must never be committed. The public half lives in license.js; this is the other half.
 *
 * Keys are signed, not stored: a key carries its own customer, type, feature list and expiry, and a
 * till checks the signature locally. Nothing to look up, nothing to keep online, and it works with
 * the shop's internet unplugged.
 *
 *   npm run license:key -- --id gupta-store --type pro --months 12
 *   npm run license:key -- --id bigchain --type enterprise --months 0 --features "*"
 *   npm run license:key -- --id trail --type pro --days 14
 *
 *   --months 0 / --days 0  → never expires (the enterprise case)
 *   --features             comma list, or "*" for everything (enterprise always gets everything)
 *
 * The private key is read from ~/.config/local-pos/license-private.pem by default, or $POS_LICENSE_PRIVKEY.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

const PRIVATE_KEY_FILE = process.env.POS_LICENSE_PRIVKEY
  || path.join(os.homedir(), '.config', 'local-pos', 'license-private.pem');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
  console.log(`Usage: node tools/make-license.mjs --id <customer> --type <pro|commercial|enterprise> [options]

  --id        customer reference shown on the till (required)
  --type      pro | commercial | enterprise          (default: pro)
  --features  comma list or "*"                       (default: all Pro features)
  --months    months until expiry, 0 = never          (default: 12)
  --days      days until expiry, overrides --months
  --privkey   path to the private key (default: ${PRIVATE_KEY_FILE})
`);
  process.exit(0);
}

const id = String(args.id || '').trim();
if (!id) {
  console.error('Missing --id. Run with --help for usage.');
  process.exit(1);
}

const ALL_PRO = ['ai_scan', 'voice_ordering', 'whatsapp_announce', 'whatsapp_payment'];
const type = String(args.type || 'pro').toLowerCase();
if (!['pro', 'commercial', 'enterprise'].includes(type)) {
  console.error(`Unknown --type "${type}". Use pro, commercial or enterprise.`);
  process.exit(1);
}

let features;
if (type === 'enterprise' || args.features === '*' || args.features === true) {
  features = ['*'];
} else if (args.features) {
  features = String(args.features).split(',').map((f) => f.trim()).filter(Boolean);
} else {
  features = [...ALL_PRO];
}

let expires = 0;
if (args.days !== undefined) {
  expires = Date.now() + Number(args.days) * 86400000;
} else {
  const months = args.months === undefined ? 12 : Number(args.months);
  expires = months > 0 ? Date.now() + months * 30 * 86400000 : 0;
}
if (expires && (Number.isNaN(expires) || expires < Date.now())) {
  console.error('Expiry works out to the past. Check --months / --days.');
  process.exit(1);
}

const privPath = args.privkey || PRIVATE_KEY_FILE;
if (!fs.existsSync(privPath)) {
  console.error(`Private key not found at ${privPath}\nGenerate one first, or point --privkey at it.`);
  process.exit(1);
}

const privateKey = crypto.createPrivateKey(fs.readFileSync(privPath, 'utf8'));

const payload = {
  v: 1,
  id,
  type,
  features,
  expires,
  issued: Date.now()
};
const payloadPart = Buffer.from(JSON.stringify(payload)).toString('base64url');
const signature = crypto.sign(null, Buffer.from(payloadPart, 'base64url'), privateKey).toString('base64url');
const key = `${payloadPart}.${signature}`;

console.log('\n' + key + '\n');
console.error('Customer : ' + id);
console.error('Type     : ' + type);
console.error('Features : ' + features.join(', '));
console.error('Expires  : ' + (expires ? new Date(expires).toISOString().slice(0, 10) : 'never'));
console.error('\nGive the shop the key above. They paste it into Settings → Pro licence.');
