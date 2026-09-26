// End-to-end test for handover photos. Runs against a real server on its own port with a throwaway
// copy of the data dir, so the shop's real orders, customers and photos are never touched.
//
//   node test/proof-photo.test.mjs
//
// The rule this file exists to protect: the 4-digit code is a complete confirmation and must keep
// working on its own. A photo is stored when one is supplied and its absence is never a reason to
// refuse a delivery that really happened.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PORT = Number(process.env.TEST_PORT || 3211);
const BASE = `http://localhost:${PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-proof-photo-'));

let pass = 0;
let fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '  ok   ' : '  FAIL ') + m); };
const section = (t) => console.log(`\n--- ${t} ---`);

const postJson = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const getJson = async (p) => {
  const r = await fetch(BASE + p);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A 1x1 PNG. Real bytes, so the server's image check has something genuine to accept.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function postImage(id, buf, type = 'image/png') {
  const r = await fetch(`${BASE}/api/orders/${id}/delivery-photo`, { method: 'POST', headers: { 'content-type': type }, body: buf });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** Charges a WhatsApp bill and walks it to `out` so there is something to hand over. */
async function makeOutOrder(id, waCode) {
  const prod = JSON.parse(fs.readFileSync(path.join(DIR, 'products.json'))).find((p) => p.stock > 5);
  const charged = await postJson('/api/orders', {
    id,
    items: [{ id: prod.id, sku: prod.sku, name: prod.name, price: prod.price, qty: 1 }],
    subtotal: prod.price, discount: 0, total: prod.price,
    status: 'paid', paymentMethod: 'cash', paidAt: new Date().toISOString(),
    deliveryBoy: { name: 'Test Rider', phone: '9000000001' },
    customer: { name: 'Test Customer', phone: '9000000002' },
    waCode
  });
  // The handover code is read from the create response, not from the delivery list: the list is a
  // shop-floor view and deliberately never carries the code that closes a job.
  const code = charged.body?.order?.delivery?.code;
  // The bill starts packed. The shop-side pickup is the same code path a sticker scan takes, and it
  // is the only way to get to `out` without a live WhatsApp connection.
  const picked = await postJson(`/api/orders/${id}/delivery/pickup`, { by: 'Test Rider' });
  if (picked.status !== 200) return null;
  return code || null;
}

const orderState = async (id) => {
  const { body } = await getJson('/api/deliveries');
  return [...(body.deliveries || []), ...(body.recentDelivered || [])].find((d) => d.id === id) || null;
};

fs.rmSync(DIR, { recursive: true, force: true });
fs.cpSync('data', DIR, { recursive: true });
// The real WhatsApp login must never be copied into a throwaway dir: with the session present the
// server would link the shop's actual account and could text real customers from a synthetic bill.
fs.rmSync(path.join(DIR, 'whatsapp-session'), { recursive: true, force: true });
// No live WhatsApp, so messages are recorded as failed instead of texting real people.
// Register a synthetic delivery boy in the copied settings. The server refuses a bill whose rider is
// not on the list, so the test cannot just invent a number — and the real list is replaced rather
// than appended to, so nothing here depends on (or copies out of) the shop's actual riders.
{
  const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json')));
  cfg.deliveryBoys = [{ name: 'Test Rider', phone: '9000000001' }];
  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify(cfg));
}
// Keep products, drop real orders, so the bill numbers below are predictable.
fs.writeFileSync(path.join(DIR, 'orders.jsonl'), '');

let srv = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: String(PORT), POS_DATA_DIR: DIR, POS_NO_WHATSAPP: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
const logs = [];
srv.stdout.on('data', (d) => logs.push(d.toString()));
srv.stderr.on('data', (d) => logs.push(d.toString()));

// Poll for readiness rather than sleeping a fixed interval: under load a fixed wait is sometimes
// not long enough and the first checks then fail against a port nothing is listening on yet.
for (let i = 0; ; i++) {
  try {
    const r = await fetch(`${BASE}/api/stats/daily`);
    if (r.ok) { await r.text(); break; }
  } catch { /* not up yet */ }
  if (i > 80) { console.log('server never became ready'); console.log(logs.join('')); srv.kill(); process.exit(1); }
  await sleep(250);
}

try {
  section('1. the 4-digit code on its own still completes a delivery');
  const code1 = await makeOutOrder('INV-260926-9101', 'WA-CODE-ONLY');
  ok(!!code1, `bill is out for delivery with code ${code1}`);
  const r1 = await postJson('/api/orders/INV-260926-9101/deliver', { code: code1, by: 'Test Rider' });
  ok(r1.status === 200, `code-only handover accepted (HTTP ${r1.status})`);
  const s1 = r1.body?.order?.delivery;
  ok(s1?.status === 'delivered', 'bill is delivered');
  ok(s1?.proofPhoto == null, 'recorded with no photo rather than refused');

  section('2. a handover photo is stored and returned');
  const code2 = await makeOutOrder('INV-260926-9102', 'WA-WITH-PHOTO');
  const up = await postImage('INV-260926-9102', PNG_1PX);
  ok(up.status === 200, `photo upload accepted (HTTP ${up.status})`);
  ok(typeof up.body?.url === 'string' && up.body.url.startsWith('/delivery-photos/'),
    `photo stored at ${up.body?.url}`);
  ok(fs.existsSync(path.join(DIR, 'delivery-photos', path.basename(up.body?.url || 'x'))),
    'the file really exists on disk');
  const r2 = await postJson('/api/orders/INV-260926-9102/deliver', { code: code2, by: 'Test Rider', photo: up.body.url });
  const s2 = r2.body?.order?.delivery;
  ok(s2?.status === 'delivered', 'bill is delivered');
  ok(s2?.proofPhoto === up.body.url, 'the photo is recorded against the bill');
  ok(s2?.confirmedBy === 'Test Rider', 'the handover is attributed to who typed the code');

  section('3. the stored photo is served back over HTTP');
  const img = await fetch(BASE + up.body.url);
  ok(img.ok, `photo URL is fetchable (HTTP ${img.status})`);
  ok((await img.arrayBuffer()).byteLength === PNG_1PX.length, 'the bytes served are the bytes stored');

  section('4. bytes that are not an image are refused, and cannot be used to close a bill');
  const junk = Buffer.from('<?php system($_GET[0]); ?>');
  const badUp = await postImage('INV-260926-9102', junk, 'image/png');
  ok(badUp.status === 400, `a text file dressed as a PNG is rejected (HTTP ${badUp.status})`);
  const big = Buffer.concat([PNG_1PX, Buffer.alloc(5 * 1024 * 1024)]);
  const bigUp = await postImage('INV-260926-9102', big);
  ok(bigUp.status === 413 || bigUp.status === 400, `an oversized upload is rejected (HTTP ${bigUp.status})`);

  section('5. a photo URL the shop never stored is rejected at confirmation');
  const code3 = await makeOutOrder('INV-260926-9103', 'WA-FAKE-PHOTO');
  const fake = await postJson('/api/orders/INV-260926-9103/deliver', {
    code: code3, by: 'Test Rider', photo: 'https://evil.example.com/x.png'
  });
  ok(fake.status === 400, `an off-server photo URL is rejected (HTTP ${fake.status})`);
  const fakeLocal = await postJson('/api/orders/INV-260926-9103/deliver', {
    code: code3, by: 'Test Rider', photo: '/delivery-photos/../../orders.jsonl'
  });
  ok(fakeLocal.status === 400, 'a path pointing outside the photo folder is rejected');
  ok((await orderState('INV-260926-9103'))?.status === 'out', 'bill 9103 is still out, not delivered');

  section('6. a photo cannot be attached to a bill that is not out for delivery');
  const early = await postImage('INV-260926-9101', PNG_1PX);
  ok(early.status === 400, `uploading to a delivered bill is refused (HTTP ${early.status})`);

  section('7. recently delivered carries the proof details, and no secrets');
  const list = await getJson('/api/deliveries');
  const recent = list.body?.recentDelivered || [];
  ok(recent.length === 2, `two finished jobs listed (got ${recent.length})`);
  if (recent.length !== 2) { console.log('  (skipping the shape checks below: nothing was delivered)'); }
  ok(recent.some((d) => d.id === 'INV-260926-9101' && d.proofPhoto == null), 'the code-only job is listed as having no photo');
  ok(recent.some((d) => d.id === 'INV-260926-9102' && d.proofPhoto === up.body.url), 'the photographed job carries its photo');
  ok(recent.length > 0 && recent.every((d) => d.code === undefined && d.token === undefined),
    'no handover code or token is exposed in the recent list');
  ok(recent.length > 0 && recent.every((d) => typeof d.deliveredAt === 'string' && !Number.isNaN(Date.parse(d.deliveredAt))),
    'each entry has a usable delivered timestamp');

  section('8. the photo survives a restart');
  srv.kill('SIGTERM');
  await sleep(1200);
  const srv2 = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(PORT), POS_DATA_DIR: DIR, POS_NO_WHATSAPP: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv2.stdout.on('data', (d) => logs.push(d.toString()));
  srv2.stderr.on('data', (d) => logs.push(d.toString()));
  srv = srv2;
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`${BASE}/api/stats/daily`);
      if (r.ok) { await r.text(); break; }
    } catch { /* not up yet */ }
    if (i > 80) { ok(false, 'server restarted'); break; }
    await sleep(250);
  }
  const after = await getJson('/api/deliveries');
  ok(after.body?.recentDelivered?.some((d) => d.id === 'INV-260926-9102' && d.proofPhoto === up.body.url),
    'the photo is still recorded after a restart');
  const img2 = await fetch(BASE + up.body.url);
  ok(img2.ok, 'and the file is still served');

  section('9. the customer is told which delivery boy is bringing and handed over the order');
  const bot = await import('../whatsapp-bot.js');
  const boy = { orderId: 'INV-260926-9102', code: '4417', itemCount: 2, boyName: 'Test Rider', boyPhone: '9000000001' };
  ok(bot.buildOutForDeliveryText('M3 Mart', boy).includes('*Test Rider*'),
    'the "out for delivery" message names him');
  ok(bot.buildOutForDeliveryText('M3 Mart', boy).includes('9000000001'),
    'and gives the customer a number to call');
  ok(bot.buildDeliveredText('M3 Mart', { orderId: boy.orderId, boyName: 'Test Rider' }).includes('*Test Rider*'),
    'the delivered message names him too');
  ok(bot.buildNewCodeText('M3 Mart', boy).includes('*Test Rider*'),
    'the replacement-code message repeats the name');
  // Older bills have no boy recorded, and a message that says "Delivered by undefined." is worse
  // than one that simply omits the line.
  for (const [name, txt] of [
    ['out for delivery', bot.buildOutForDeliveryText('M3 Mart', { orderId: 'X', code: '1', itemCount: 1 })],
    ['delivered', bot.buildDeliveredText('M3 Mart', { orderId: 'X' })],
    ['new code', bot.buildNewCodeText('M3 Mart', { orderId: 'X', code: '1' })]
  ]) {
    ok(!/undefined|null|NaN/.test(txt), `the ${name} message stays clean when no boy is recorded`);
  }
  // The code must never travel in the same message as the rider's name in a way that leaks the
  // handover secret to anyone forwarding it; the name is on its own line for that reason.
  ok(!bot.buildDeliveredText('M3 Mart', { orderId: 'X', boyName: 'Test Rider' }).includes('4417'),
    'the delivered message carries no handover code');
} catch (err) {
  ok(false, `threw: ${err && err.stack ? err.stack : err}`);
}

srv.kill();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('\n--- server output ---\n' + logs.join(''));
fs.rmSync(DIR, { recursive: true, force: true });
process.exitCode = fail ? 1 : 0;
