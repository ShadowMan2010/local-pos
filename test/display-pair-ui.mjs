/* The POS and the customer display, side by side on one device, in a real browser.

   Every part of this suite is about a failure that was invisible. The customer display is fed over a
   WebSocket, and for as long as this file has existed that WebSocket has died about one frame after the
   handshake — the server's first message arrived and decoded, and then a second WebSocket server sharing
   the same HTTP server wrote a plain "400 Bad Request" into the socket that had just been upgraded.
   Browsers read those bytes as a malformed frame, log "Invalid frame header" and close.

   Nothing in the app said so. The display showed its welcome screen through every payment. The push
   succeeded and answered {"clients": 0}. The cashier's own status line said "QR sent". The only place the
   fault was visible was a browser console nobody opens on a shop till. So this suite asserts the two
   things that were actually wrong, and would have caught both:

     - the display's socket stays registered on the server (displays.size > 0), and
     - a frame the server sends is actually rendered on the second screen.

   The rest covers the states that were added afterwards: the loading state between Charge and the QR, the
   customer name from the bill, the method named on the thank-you, and the reconnect mark.

   Also asserted here because it is the cheapest possible place to catch it: an authenticated push works,
   and an unauthenticated one is still refused. Making /api/display/push public would fix the 401 and open
   the shop's Wi-Fi to anyone who wants to put a fake payment QR on the customer's screen. */
import { loadPuppeteer, launchBrowser, killPort } from './browser.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const puppeteer = await loadPuppeteer();

const PORT = 3228;
const DIR = '/tmp/opencode/fdisplaypair';
const BASE = `http://localhost:${PORT}`;
const PIN = '4821';
let pass = 0, fail = 0;
let srv = null;
let browser = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const t = async (name, fn) => {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
};
const ok = (c, m) => { if (!c) throw new Error(m); };

const req = (p, o = {}) => fetch(BASE + p, {
  ...o,
  headers: { 'content-type': 'application/json', ...(o.headers || {}) }
});
const post = (p, b, tok) => req(p, {
  method: 'POST',
  headers: tok ? { authorization: 'Bearer ' + tok } : {},
  body: JSON.stringify(b)
});

/** Push a display state as the till does, carrying the session token. */
const push = (msg, tok) => post('/api/display/push', msg, tok);

killPort(PORT);
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(path.join(DIR, 'orders.jsonl'), '');
srv = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: String(PORT), POS_DATA_DIR: DIR, POS_NO_WHATSAPP: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
const logs = [];
srv.stdout.on('data', (d) => logs.push(d.toString()));
srv.stderr.on('data', (d) => logs.push(d.toString()));
for (let i = 0; i < 200; i++) {
  try { const r = await req('/api/config'); if (r.ok) { await r.json(); break; } } catch { /* not up yet */ }
  if (i === 199) { console.error('server never came up\n' + logs.join('')); process.exit(1); }
  await sleep(250);
}

await post('/api/setup', { storeName: 'Two Screen Mart', upiVpa: 'shop@bank', pin: PIN });
const session = (await (await post('/api/auth/pin', { pin: PIN })).json()).token;
await post('/api/products', { name: 'Apple', price: 30, stock: 10, category: 'Fruit' }, session);

browser = await launchBrowser(puppeteer);

// Two windows, one device, same origin: the customer display on one side, the till on the other.
const display = await browser.newPage();
await display.setViewport({ width: 620, height: 820 });
const displayErrors = [];
display.on('pageerror', (e) => displayErrors.push(e.message));
await display.goto(`${BASE}/display.html`, { waitUntil: 'domcontentloaded' });

const till = await browser.newPage();
await till.setViewport({ width: 900, height: 1000 });
await till.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await till.waitForSelector('[data-pin-gate]', { timeout: 20000 });
await till.type('[data-pin-gate] input[aria-label="Shop PIN"]', PIN);
await till.click('[data-pin-gate] button[type=submit]');
await till.waitForFunction(() => !document.querySelector('[data-pin-gate]'), { timeout: 20000 });
await sleep(1200);

const until = (page, fn, ms = 15000) => page.waitForFunction(fn, { timeout: ms });
const stageText = () => display.$eval('#stage', (e) => e.innerText.replace(/\s+/g, ' ').trim());
const clients = async () => (await (await req('/api/display/status', { headers: { authorization: 'Bearer ' + session } })).json()).clients;

await t('the display screen registers itself on the server', async () => {
  await until(display, () => !document.querySelector('#d-net'), 10000);
  ok(await clients() === 1, `server reports ${await clients()} connected screens, expected 1 — the display socket is not staying open`);
});

await t('an authenticated push is accepted', async () => {
  const r = await push({ type: 'payment', storeName: 'Two Screen Mart', amount: 250, qrPayload: 'upi://pay?pa=shop@bank&am=250.00' }, session);
  ok(r.status === 200, `push returned ${r.status}, expected 200`);
});

await t('an unauthenticated push is still refused', async () => {
  const r = await req('/api/display/push', { method: 'POST', body: JSON.stringify({ type: 'paid' }) });
  ok(r.status === 401, `push without a token returned ${r.status}, expected 401 — the display route must stay behind the shop PIN`);
});

await t('a frame the server sends is rendered on the display', async () => {
  await push({ type: 'payment', storeName: 'Two Screen Mart', amount: 250, qrPayload: 'upi://pay?pa=shop@bank&am=250.00' }, session);
  await until(display, () => !!document.querySelector('.d-qr img'));
  ok((await stageText()).includes('250'), 'the amount did not reach the second screen');
});

await t('Charge shows a loading state before the QR', async () => {
  await push({ type: 'preparing', storeName: 'Two Screen Mart', amount: 250, orderId: 'B1' }, session);
  await until(display, () => !!document.querySelector('.d-qr-wait'));
  const spin = await display.evaluate(() => {
    const s = document.querySelector('.d-qr-wait .progress');
    return s ? getComputedStyle(s).animationName : '';
  });
  ok(spin === 'md-spin', `the waiting state shows "${spin}" rather than the M3 indicator`);
  await push({ type: 'payment', storeName: 'Two Screen Mart', amount: 250, orderId: 'B1', qrPayload: 'upi://pay?pa=shop@bank&am=250.00' }, session);
  await until(display, () => !!document.querySelector('.d-qr img'));
  ok(await display.evaluate(() => !document.querySelector('.d-qr-wait')), 'the loading state is still up after the QR arrived');
});

await t('the name on the bill reaches the display', async () => {
  await push({ type: 'payment', storeName: 'Two Screen Mart', amount: 250, customerName: 'Riya Sharma', qrPayload: 'upi://pay?pa=shop@bank&am=250.00' }, session);
  await until(display, () => !!document.querySelector('.d-name'));
  ok((await stageText()).includes('Riya Sharma'), 'the customer name is missing from the display');
});

await t('the thank-you names the payment method', async () => {
  await push({ type: 'paid', storeName: 'Two Screen Mart', amount: 250, method: 'cash', customerName: 'Riya Sharma' }, session);
  await until(display, () => /received/i.test(document.querySelector('#stage').innerText));
  const txt = await stageText();
  ok(/cash received/i.test(txt), `expected cash to be named, screen said "${txt}"`);
  ok(txt.includes('Riya Sharma'), 'the customer name was dropped from the thank-you');
});

await t('a walk-in bill shows no name line at all', async () => {
  await push({ type: 'paid', storeName: 'Two Screen Mart', amount: 250, method: 'upi' }, session);
  await until(display, () => /received/i.test(document.querySelector('#stage').innerText));
  ok(await display.evaluate(() => !document.querySelector('.d-name')), 'an empty name line was rendered, shifting the layout for a walk-in');
});

await t('going idle clears the previous customer name', async () => {
  await push({ type: 'payment', storeName: 'Two Screen Mart', amount: 250, customerName: 'Riya Sharma', qrPayload: 'upi://pay?pa=shop@bank&am=250.00' }, session);
  await until(display, () => !!document.querySelector('.d-name'));
  await push({ type: 'idle', storeName: 'Two Screen Mart' }, session);
  await until(display, () => !document.querySelector('.d-name'));
  ok(!(await stageText()).includes('Riya'), 'the next customer would be greeted as the last one');
});

await t('an unknown state is refused rather than broadcast', async () => {
  const r = await push({ type: 'nonsense' }, session);
  ok(r.status === 400, `an unknown type returned ${r.status}, expected 400`);
});

await t('the till is still usable with the display open', async () => {
  ok(await till.evaluate(() => !!document.querySelector('.catalog-grid')), 'the POS stopped working');
  ok(await till.evaluate(() => !document.querySelector('[data-pin-gate]')), 'the PIN gate came back over a working session');
});

await t('the display page raised no script errors', async () => {
  ok(displayErrors.length === 0, displayErrors.join(' | '));
});

await browser.close();
srv.kill();
killPort(PORT);
fs.rmSync(DIR, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.error(logs.join('').slice(-2000)); process.exit(1); }
