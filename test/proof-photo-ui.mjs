/* Feature 11 UI: the deliveries dialog in a real browser, against a throwaway instance.
   Checks the optional Photo button, that a code alone still closes a delivery, and that the
   recently-delivered list shows a real thumbnail or an honest "no photo" marker. */
import { loadPuppeteer, launchBrowser, killPort } from './browser.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// puppeteer-core is a test-only dependency kept outside the repo, so nothing here adds it to the shop's
// own package.json. It is resolved by name rather than by a hardcoded path into its internals: that
// path moves between major versions (lib/puppeteer -> lib/cjs/puppeteer), and pinning it made this file
// break on a clean reinstall instead of on a real change.
const puppeteer = await loadPuppeteer();

const PORT = 3195;
const DIR = '/tmp/opencode/f11ui';
const BASE = `http://localhost:${PORT}`;
let pass = 0, fail = 0;
let srv = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = async (name, fn) => { try { await fn(); console.log('  ok   ' + name); pass++; } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; } };
const ok = (c, m) => { if (!c) throw new Error(m); };

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
// The browser cannot be handed a Buffer, it needs a real file to attach. Written from the same bytes
// used for the direct API call below, so this test no longer depends on a PNG somebody once left
// lying in the temp directory — which is why it passed on a machine with leftover state and failed
// on a clean one.
const UPLOAD_PNG = '/tmp/opencode/uitest/onepx.png';

const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => null);
};
const get = async (p) => (await fetch(BASE + p)).json();

killPort(PORT);
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(path.dirname(UPLOAD_PNG), { recursive: true });
fs.writeFileSync(UPLOAD_PNG, PNG_1PX);
fs.cpSync('data', DIR, { recursive: true });
// The real WhatsApp login must never be copied into a throwaway dir: with the session present the
// server would link the shop's actual account and could text real customers from a synthetic bill.
fs.rmSync(path.join(DIR, 'whatsapp-session'), { recursive: true, force: true });
// The shop PIN goes too, for the same class of reason. These tests were written before the till had a
// lock and drive the API directly with no session; the day somebody set a PIN on the real till, a
// copied config silently turned every request into a 401 and the suite reported "server never became
// ready" — which reads like a broken server rather than a copied secret. Dropped here so these keep
// testing the thing they were written to test, against an unlocked instance.
{
  const cfgPath = path.join(DIR, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath));
  delete cfg.pin;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
}
// Register a synthetic delivery boy in the copied settings. The server refuses a bill whose rider is
// not on the list, so the test cannot just invent a number — and the real list is replaced rather
// than appended to, so nothing here depends on (or copies out of) the shop's actual riders.
{
  const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json')));
  cfg.deliveryBoys = [{ name: 'Test Rider', phone: '9000000001' }];
  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify(cfg));
}
fs.writeFileSync(path.join(DIR, 'orders.jsonl'), '');

srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: String(PORT), POS_DATA_DIR: DIR, POS_NO_WHATSAPP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
const logs = [];
srv.stdout.on('data', (d) => logs.push(d.toString()));
srv.stderr.on('data', (d) => logs.push(d.toString()));
for (let i = 0; ; i++) {
  try { const r = await fetch(`${BASE}/api/stats/daily`); if (r.ok) { await r.text(); break; } } catch {}
  if (i > 80) { console.log('server never became ready\n' + logs.join('')); process.exit(1); }
  await sleep(250);
}

const prod = JSON.parse(fs.readFileSync(path.join(DIR, 'products.json'))).find((p) => p.stock > 5);
async function seed(id, code) {
  const r = await post('/api/orders', {
    id, items: [{ id: prod.id, sku: prod.sku, name: prod.name, price: prod.price, qty: 1 }],
    subtotal: prod.price, discount: 0, total: prod.price, status: 'paid', paymentMethod: 'cash',
    paidAt: new Date().toISOString(), deliveryBoy: { name: 'Test Rider', phone: '9000000001' },
    customer: { name: 'Test Customer', phone: '9000000002' }, waCode: 'WA-' + code
  });
  await post(`/api/orders/${id}/delivery/pickup`, { by: 'Test Rider' });
  return r.order.delivery.code;
}

const browser = await launchBrowser(puppeteer);
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const codeA = await seed('INV-260926-9201', 'A');
  const codeB = await seed('INV-260926-9202', 'B');
  // Give the second bill a photo on disk so the recent list has both kinds to show.
  await fetch(`${BASE}/api/orders/INV-260926-9202/delivery-photo`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG_1PX });

  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE, { waitUntil: 'networkidle2' });

  await t('the deliveries dialog opens', async () => {
    // The entry point is an icon-only button, so it has no text to match on — its aria-label is
    // the handle, which is also what a screen reader would use.
    const clicked = await page.evaluate(() => {
      const b = document.querySelector('button[aria-label="Out for delivery"]');
      if (!b) return false;
      b.click();
      return true;
    });
    ok(clicked, 'found the "Out for delivery" button by its aria-label');
    await page.waitForSelector('.dlg-head', { timeout: 8000 });
    ok(await page.$eval('.dlg-head h2', (e) => /on delivery/i.test(e.textContent)), 'heading says "On delivery"');
  });

  await t('each out-for-delivery bill offers the 4-digit code box and an optional Photo button', async () => {
    const rows = await page.$$('.pm-row');
    ok(rows.length >= 2, `found ${rows.length} live delivery rows`);
    const codes = await page.$$eval('.code-input', (n) => n.map((e) => e.maxLength));
    ok(codes.length >= 2 && codes.every((m) => Number(m) === 4), `code boxes are 4 digits (${codes.join(',')})`);
    const photos = await page.$$eval('.proof-input', (n) => n.length);
    ok(photos >= 2, `each row has a photo input (${photos})`);
    const labels = await page.$$eval('button', (n) => n.map((e) => e.textContent.trim()));
    ok(labels.filter((l) => l === 'Photo').length >= 2, 'each row has a Photo button');
  });

  await t('the hidden file input really is hidden from the layout', async () => {
    const box = await page.$eval('.proof-input', (e) => { const b = e.getBoundingClientRect(); return { w: b.width, h: b.height }; });
    ok(box.w <= 1 && box.h <= 1, `input is ${box.w}x${box.h} on screen`);
  });

  await t('typing the 4-digit code alone marks the bill delivered', async () => {
    const inputs = await page.$$('.code-input');
    await inputs[0].type(codeA);
    const btns = await page.$$('.code-row .btn-filled');
    await btns[0].click();
    await page.waitForFunction(
      (id) => fetch('/api/deliveries').then((r) => r.json())
        .then((d) => d.deliveries.some((x) => x.id === id) === false),
      { timeout: 10000 }, 'INV-260926-9201'
    );
    const recent = (await get('/api/deliveries')).recentDelivered;
    const done = recent.find((d) => d.id === 'INV-260926-9201');
    ok(done, 'the bill is in recently delivered');
    ok(done.proofPhoto == null, 'recorded with no photo, exactly as a code-only handover should be');
  });

  await t('the recent list shows an honest "no photo" marker for a code-only delivery', async () => {
    await page.waitForFunction(() => document.body.innerText.includes('Recently delivered'), { timeout: 8000 });
    const none = await page.$$eval('.proof-none', (n) => n.map((e) => e.textContent.trim()));
    ok(none.length >= 1, `found ${none.length} "no photo" markers`);
    ok(none.some((t) => /no photo/i.test(t)), 'the marker says "no photo"');
  });

  await t('a photo can be attached when confirming the second bill', async () => {
    const inputs = await page.$$('.code-input');
    await inputs[0].type(codeB);
    // Attach through the real input rather than the button, because a headless browser will not
    // open a file chooser on its own.
    const fileInputs = await page.$$('.proof-input');
    await fileInputs[0].uploadFile(UPLOAD_PNG);
    const btns = await page.$$('.code-row .btn-filled');
    await btns[0].click();
    await page.waitForFunction(
      (id) => fetch('/api/deliveries').then((r) => r.json())
        .then((d) => d.deliveries.some((x) => x.id === id) === false),
      { timeout: 15000 }, 'INV-260926-9202'
    );
    const recent = (await get('/api/deliveries')).recentDelivered;
    const done = recent.find((d) => d.id === 'INV-260926-9202');
    ok(done && done.proofPhoto, 'the photo is recorded against the bill');
    const r = await fetch(BASE + done.proofPhoto);
    ok(r.ok, 'and the stored file is served back');
  });

  await t('the recent list shows a real thumbnail for a delivery that has a photo', async () => {
    // Only a delivered bill appears in the recent list, so this can only be checked once the
    // photo-bearing handover is actually closed and the dialog has reloaded itself.
    await page.waitForSelector('.proof-thumb', { timeout: 10000 });
    const srcs = await page.$$eval('.proof-thumb', (n) => n.map((e) => e.getAttribute('src')));
    ok(srcs.length >= 1, `found ${srcs.length} thumbnails`);
    // The original bug: proofPhoto was an object on the wire, so this rendered "[object Object]".
    ok(srcs.every((s) => /^\/delivery-photos\/INV-\d{6}-\d{4,}-\d+-[\da-f]{8}\.(png|jpg|webp)$/.test(s)),
      `every src is a real stored file: ${srcs.join(', ')}`);
    const loaded = await page.$$eval('.proof-thumb', (n) => Promise.all(n.map((e) => e.complete && e.naturalWidth > 0)));
    ok(loaded.every(Boolean), 'the thumbnails actually load in the browser');
    const stillMarked = await page.$$eval('.proof-none', (n) => n.length);
    ok(stillMarked >= 1, 'the code-only delivery still shows "no photo" alongside it');
  });

  await t('no uncaught errors anywhere in that flow', async () => {
    ok(errors.length === 0, `page errors: ${errors.join(' | ')}`);
  });
} finally {
  await browser.close();
  if (srv) srv.kill();
  killPort(PORT);
  fs.rmSync(DIR, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('\n--- server output ---\n' + logs.join(''));
process.exitCode = fail ? 1 : 0;
