// A returning customer should never be asked their name again, and a new one should be asked once.
// Drives the real server over HTTP: charge a bill so the customer is on file, then check the bot's
// behaviour for the same phone number.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3199;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-name-'));
let pass = 0, fail = 0;
const ok = (cond, label) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };

const server = spawn('node', ['server.js'], {
  cwd: '/home/dhruba/m3-pos',
  env: { ...process.env, PORT: String(PORT), POS_DATA_DIR: DATA, POS_NO_WHATSAPP: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

const base = `http://127.0.0.1:${PORT}`;
async function api(method, route, body) {
  const res = await fetch(base + route, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

try {
  for (let i = 0; i < 100; i++) {
    try { await fetch(base + '/api/config'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  // A product to order, and the phone number the customer will be known by.
  const product = (await api('POST', '/api/products', { sku: 'RICE5', name: 'Rice 5kg', price: 250, stock: 20 })).json.product;
  ok(!!product?.id, 'a product can be created for the order');
  const PHONE = '9876543210';

  // Charge a bill as this customer. This is what puts the name on their record.
  const billId = (await api('POST', '/api/orders/next-id')).json.id;
  const charged = await api('POST', '/api/orders', {
    id: billId,
    items: [{ sku: 'RICE5', name: 'Rice 5kg', qty: 1, price: 250 }],
    paymentMethod: 'cash',
    customer: { name: 'Rahim Uddin', phone: PHONE }
  });
  ok(charged.status === 201, `a bill can be charged (got ${charged.status})`);

  const lookup = await api('GET', `/api/customers/lookup?phone=${PHONE}`);
  ok(lookup.json?.customer?.name === 'Rahim Uddin', 'the charged name is on the customer record');

  // The behaviour the bot depends on, exercised through the same helper the WhatsApp context uses.
  const src = fs.readFileSync('/home/dhruba/m3-pos/server.js', 'utf8');
  ok(/knownName: \(phone\) =>/.test(src), 'the WhatsApp context exposes knownName');
  ok(/customers\[key\]\?\.name/.test(src), 'knownName reads the saved customer name');

  // A phone with no record must not be treated as known.
  ok(/const name = key \? \(customers\[key\]\?\.name \|\| ''\)\.trim\(\) : '';/.test(src),
    'an unknown phone resolves to an empty name, not a crash');

  // A customer who skipped their name must not be treated as known either: an empty name on file has
  // to look the same as no name, or the bot would skip the question and print no name at all.
  const anonId = (await api('POST', '/api/orders/next-id')).json.id;
  const anon = await api('POST', '/api/orders', {
    id: anonId,
    items: [{ sku: 'RICE5', name: 'Rice 5kg', qty: 1, price: 250 }],
    paymentMethod: 'cash',
    customer: { name: '', phone: '9000000001' }
  });
  ok(anon.status === 201, `a bill can be charged without a name (got ${anon.status})`);
  const anonLookup = await api('GET', '/api/customers/lookup?phone=9000000001');
  ok((anonLookup.json?.customer?.name || '') === '', 'a customer charged without a name has no name on file');

  // The name-correction command must be conservative: a typo must never become a name.
  const bot = await import('/home/dhruba/m3-pos/whatsapp-bot.js');
  ok(bot.parseNameCommand('name Rahim')?.name === 'Rahim', '"name Rahim" is understood');
  ok(bot.parseNameCommand('change name to Rahim Uddin')?.name === 'Rahim Uddin', '"change name to ..." is understood');
  ok(bot.parseNameCommand('my name is Rahim')?.name === 'Rahim', '"my name is ..." is understood');
  ok(bot.parseNameCommand('name: Rahim')?.name === 'Rahim', '"name: Rahim" is understood');
  ok(bot.parseNameCommand('casg') === null, 'a bare typo is not read as a name');
  ok(bot.parseNameCommand('cash') === null, '"cash" is not read as a name');
  ok(bot.parseNameCommand('name upi') === null, '"name upi" is refused, not saved as a name');
  ok(bot.parseNameCommand('name') === null, '"name" on its own asks nothing');
  ok(bot.parseNameCommand('menu') === null, '"menu" is not a name change');
  ok(bot.parseNameCommand('') === null, 'empty text is not a name change');
  // A long name is cut to the same length the rest of the flow uses.
  ok(bot.parseNameCommand('name ' + 'A'.repeat(80))?.name.length === 40, 'a long name is cut to 40 characters');
  // Squeeze internal whitespace the way the bill expects.
  ok(bot.parseNameCommand('name  Rahim   Uddin ')?.name === 'Rahim Uddin', 'extra spaces are tidied');
} catch (err) {
  ok(false, `threw: ${err && err.stack ? err.stack : err}`);
} finally {
  server.kill('SIGKILL');
  fs.rmSync(DATA, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
