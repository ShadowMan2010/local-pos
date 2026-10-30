/* Settings must stay reachable when the top bar runs out of room.

   The dashboard has more actions than fit across a laptop or tablet window. The old app bar was one
   unwrapped row, so the last buttons - Store settings on a laptop, and the cart on a phone - were
   pushed past the right edge with no way to scroll to them. This drives the real page at several
   widths and insists both are inside the viewport, then opens Settings to prove it is not just
   measuring a button that does nothing. */
import { loadPuppeteer, launchBrowser, killPort } from './browser.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const puppeteer = await loadPuppeteer();
const PORT = 3281;
const DIR = '/tmp/opencode/settings-visible-ui';
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
};
const ok = (c, m) => { if (!c) throw new Error(m); };

killPort(PORT);
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
  storeName: 'Test Bazaar', address: '', phone: '', upiVpa: 'shop@bank', qrMode: 'receipt', displayUrl: ''
}));

const srv = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: String(PORT), POS_DATA_DIR: DIR, POS_NO_WHATSAPP: '1' }, stdio: 'ignore'
});
for (let i = 0; ; i++) {
  try { const r = await fetch(`${BASE}/api/config`); if (r.ok) { await r.text(); break; } } catch {}
  if (i > 80) process.exit(1);
  await sleep(250);
}

let b;
try {
  b = await launchBrowser(puppeteer);
  for (const width of [1100, 900, 800, 500, 390]) {
    await t(`Settings and the cart are on screen at ${width}px`, async () => {
      const page = await b.newPage();
      try {
        await page.setViewport({ width, height: 800 });
        await page.goto(BASE, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('button[aria-label="Store settings"]', { timeout: 20000 });
        const boxes = await page.evaluate(() => {
          const box = (sel) => {
            const el = document.querySelector(sel);
            if (!el || el.offsetParent === null) return null;
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
          };
          return { settings: box('button[aria-label="Store settings"]'), cart: box('.cart-toggle') };
        });
        const inside = (r) => r && r.left >= 0 && r.right <= width && r.top >= 0 && r.bottom <= 800;
        ok(inside(boxes.settings), `Store settings is outside the ${width}px viewport: ${JSON.stringify(boxes.settings)}`);
        if (width <= 1000) ok(inside(boxes.cart), `cart toggle is outside the ${width}px viewport: ${JSON.stringify(boxes.cart)}`);

        if (width === 390) {
          await page.click('button[aria-label="Store settings"]');
          await page.waitForFunction(() => /Store settings/.test(document.body.innerText), { timeout: 10000 });
        }
      } finally { await page.close(); }
    });
  }
} finally {
  await b.close();
  srv.kill('SIGKILL');
  fs.rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
