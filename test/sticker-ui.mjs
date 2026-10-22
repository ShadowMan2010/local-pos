/* The package sticker in a real browser, against a throwaway instance.

   This exists because the pickup QR was reported as "not working" from the live shop, and every test
   that existed passed anyway. The reason is that nothing ever loaded the sticker the way the shop does.
   The tests called the server's route directly with a valid session and got a perfect PNG; the shop got
   that same route through an <img> tag, which is the one request in a browser that carries no shop PIN.
   The server answered 401, the image never arrived, and the sticker window printed an empty box with no
   error anywhere - so the code was fine, the decoder was fine, and the feature was still broken.

   So this test loads the sticker the way the till does, through the page, and fails if the picture that
   reaches the screen is not a real QR. */
import { loadPuppeteer, launchBrowser, killPort } from './browser.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readQrFromBuffer } from '../qr-reader.js';

const puppeteer = await loadPuppeteer();

const PORT = 3193;
const DIR = '/tmp/opencode/fsticker';
const BASE = `http://localhost:${PORT}`;
let pass = 0, fail = 0;
let srv = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = async (name, fn) => {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
};
const ok = (c, m) => { if (!c) throw new Error(m); };

const post = async (p, body, token) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
  return r.json().catch(() => null);
};
const get = async (p, token) => {
  const r = await fetch(BASE + p, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.status, type: r.headers.get('content-type') || '', buf: Buffer.from(await r.arrayBuffer()) };
};

const PIN = '4821';

killPort(PORT);
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
// A real PIN is set on purpose here. The whole point of the test is the authenticated path, and a copy
// of the shop's data with its PIN stripped would have made the sticker load while the live shop's did not.
fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({ storeName: 'Sticker Test', deliveryBoys: [{ name: 'Test Rider', phone: '9000000001' }] }));
fs.writeFileSync(path.join(DIR, 'products.json'), JSON.stringify([
  { id: 'p1', sku: 'SKU1', name: 'Test Item', price: 10, stock: 50, unit: 'pc' }
]));
fs.writeFileSync(path.join(DIR, 'orders.jsonl'), '');
fs.writeFileSync(path.join(DIR, 'counters.json'), '{}');

srv = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: String(PORT), POS_DATA_DIR: DIR, POS_NO_WHATSAPP: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
const logs = [];
srv.stdout.on('data', (d) => logs.push(d.toString()));
srv.stderr.on('data', (d) => logs.push(d.toString()));
for (let i = 0; ; i++) {
  try { const r = await fetch(`${BASE}/api/auth/status`); if (r.ok) { await r.text(); break; } } catch {}
  if (i > 80) { console.log('server never became ready\n' + logs.join('')); process.exit(1); }
  await sleep(250);
}

// The PIN is set through /api/setup, which is the one route that can create one: it is reachable with no
// session precisely until a PIN exists, and afterwards the server ignores the field. Posting straight to
// /api/auth/pin with no PIN stored is refused, which is the first-run behaviour and not a bug.
const setup = await post('/api/setup', { storeName: 'Sticker Test', upiVpa: '', pin: PIN });
ok(setup?.token, `setting the shop PIN did not hand back a session: ${JSON.stringify(setup)}`);
const { token } = await post('/api/auth/pin', { pin: PIN });
ok(token, 'the shop PIN was accepted and handed back a session');

const bill = 'INV-260928-0001';
// waCode is what makes a bill a delivery. Without it the server records an ordinary shop sale with no
// delivery attached at all, which is why seeding a delivery has to go through the WhatsApp-order path.
const created = await post('/api/orders', {
  id: bill,
  items: [{ id: 'p1', sku: 'SKU1', name: 'Test Item', price: 10, qty: 1 }],
  subtotal: 10, discount: 0, total: 10, status: 'paid', paymentMethod: 'cash',
  paidAt: new Date().toISOString(), waCode: 'WA-TEST-1',
  deliveryBoy: { name: 'Test Rider', phone: '9000000001' },
  customer: { name: 'Test Customer', phone: '9000000002' }
}, token);
ok(created?.order?.delivery?.pickupToken,
  `the test bill was not saved as a delivery: ${JSON.stringify(created).slice(0, 200)}`);

let browser;
try {
  await t('the sticker route is refused without the PIN, so it must stay behind the gate', async () => {
    const r = await get(`/api/orders/${bill}/delivery/sticker.png`);
    ok(r.status === 401, `expected 401 for a request with no token, got ${r.status}`);
  });

  await t('the sticker route serves a real QR to a signed-in till', async () => {
    const r = await get(`/api/orders/${bill}/delivery/sticker.png`, token);
    ok(r.status === 200, `expected 200 with a token, got ${r.status}`);
    ok(/image\/png/.test(r.type), `expected a PNG, got "${r.type}"`);
    const read = await readQrFromBuffer(r.buf);
    ok(read, 'the PNG the server produced has no readable QR in it');
  });

  await t('the QR a delivery boy would scan is the pickup token for that bill', async () => {
    const r = await get(`/api/orders/${bill}/delivery/sticker.png`, token);
    const orders = fs.readFileSync(path.join(DIR, 'orders.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l));
    const o = orders.find((x) => x.id === bill);
    ok(o?.delivery?.pickupToken, 'the bill has no pickup token to encode');
    const read = await readQrFromBuffer(r.buf);
    ok(read === o.delivery.pickupToken,
      `the sticker shows "${read}" but the pickup token is "${o.delivery.pickupToken}" - the boy would scan a code that matches nothing`);
  });

  browser = await launchBrowser(puppeteer);
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));

  await t('the sticker picture actually reaches the screen in the till', async () => {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    // Log in the way the till does, through the gate, so the token is a real one in real storage.
    await page.waitForSelector('[data-pin-gate]', { timeout: 15000 });
    await page.type('[data-pin-gate] input', PIN);
    await page.click('[data-pin-gate] button[type=submit]');
    await page.waitForFunction(() => !document.querySelector('[data-pin-gate]'), { timeout: 15000 });

    // The real fix loads the PNG with the PIN and hands back a blob URL. Calling the module directly is
    // the honest check: it is the code path the sticker button runs, and an <img src> cannot be used
    // here because that is precisely what was broken.
    const result = await page.evaluate(async () => {
      const api = await import('/js/api.js');
      const id = 'INV-260928-0001';
      let url;
      try { url = await api.deliveryStickerImage(id); }
      catch (e) { return { error: e.message }; }
      // A blob: URL is what makes this a real test of the fix - the old code produced a plain path that
      // the browser then fetched with no PIN and got a 401.
      const isBlob = url.startsWith('blob:');
      const img = new Image();
      const loaded = await new Promise((res) => {
        img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => res(null);
        img.src = url;
      });
      URL.revokeObjectURL(url);
      return { isBlob, loaded };
    });
    ok(!result.error, `loading the sticker threw: ${result.error}`);
    ok(result.isBlob, 'the sticker must be fetched with the PIN and shown from a blob, not a bare path');
    ok(result.loaded, 'the image never rendered - this is the broken-sticker bug, still happening');
    ok(result.loaded.w > 100 && result.loaded.h > 100,
      `the sticker rendered at ${result.loaded?.w}x${result.loaded?.h}, which is too small to scan`);
  });

  await t('an <img> pointed straight at the route is exactly what must not be relied on', async () => {
    // Kept as an explicit test of the old behaviour, so the reason the sticker is fetched in JavaScript
    // is written down where the next person will find it instead of being "simplified" back.
    const bare = await page.evaluate(async () => {
      const img = new Image();
      return await new Promise((res) => {
        img.onload = () => res(true);
        img.onerror = () => res(false);
        img.src = '/api/orders/INV-260928-0001/delivery/sticker.png';
      });
    });
    ok(!bare, 'a bare <img> unexpectedly loaded the sticker - if this ever passes, the route went public and the pickup token is exposed');
  });

  await t('nothing on the page threw while doing it', async () => {
    ok(!consoleErrors.length, `page errors: ${consoleErrors.join(' | ')}`);
  });
} finally {
  await browser?.close().catch(() => {});
  srv?.kill();
  killPort(PORT);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
