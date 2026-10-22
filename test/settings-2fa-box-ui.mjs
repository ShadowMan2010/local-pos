/* The 2FA enrolment code box in Settings, one bug pinned.

   The report: the box a shopkeeper types the first code into looked broken — the "Type the code your app
   is showing" label lay across the box instead of floating above it. The floating label is driven by
   `.m3-field input:focus + span`, which matches only when the label comes AFTER the input in the markup;
   the enrolment box had them the other way round.
*/
import { loadPuppeteer, launchBrowser, killPort } from './browser.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const puppeteer = await loadPuppeteer();
const PORT = 3239;
const DIR = '/tmp/opencode/s2fa';
const BASE = `http://localhost:${PORT}`;
const PIN = '4821';
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
const srv = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: String(PORT), POS_DATA_DIR: DIR, POS_NO_WHATSAPP: '1' }, stdio: 'ignore'
});
for (let i = 0; ; i++) {
  try { const r = await fetch(`${BASE}/api/auth/status`); if (r.ok) { await r.text(); break; } } catch {}
  if (i > 80) process.exit(1);
  await sleep(250);
}
const post = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
};
// A shop with a PIN but no second factor yet, which is the only state the enrolment box exists in.
await post('/api/setup', { storeName: 'Settings 2FA', upiVpa: '', pin: PIN });

// The enrolment box lives inside the settings view, which is reached through the till.
const open = async () => {
  const page = await b.newPage();
  await page.setViewport({ width: 1000, height: 900 });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-pin-gate]', { timeout: 20000 });
  await page.type('[data-pin-gate] input[aria-label="Shop PIN"]', PIN);
  await page.click('[data-pin-gate] button[type=submit]');
  await page.waitForSelector('.app-bar', { timeout: 20000 });
  await sleep(400);
  return page;
};
const openSettings = async (page) => {
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button,[role=button]')]
      .find((b) => /settings|set up/i.test(b.getAttribute('aria-label') || b.title || b.innerText || ''));
    if (btn) btn.click();
  });
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some((b) => /show the code to scan/i.test(b.textContent)),
    { timeout: 15000 });
};

let b;
try {
  b = await launchBrowser(puppeteer);

  await t('the enrolment code box opens from settings, label below the input', async () => {
    const page = await open();
    await openSettings(page);
    // Step one: the phone scans the QR shown by the settings screen itself, not by a separate page.
    await page.evaluate(() => [...document.querySelectorAll('button')]
      .find((bt) => /show the code to scan/i.test(bt.textContent)).click());
    await page.waitForFunction(() =>
      document.querySelector('.m3-field input[aria-label="Code from your phone"]'), { timeout: 15000 });

    const order = await page.evaluate(() => {
      const input = document.querySelector('.m3-field input[aria-label="Code from your phone"]');
      const field = input.closest('.m3-field');
      return [...field.children].map((c) => c.tagName);
    });
    ok(order[0] === 'INPUT' && order[1] === 'SPAN',
      `the label must follow the input, saw: ${order.join(' -> ')}`);

    const labelIsNext = await page.evaluate(() => {
      const input = document.querySelector('.m3-field input[aria-label="Code from your phone"]');
      return input.nextElementSibling?.tagName === 'SPAN' &&
        input.nextElementSibling.textContent.includes('Type the code');
    });
    ok(labelIsNext, 'the label text belongs to the code field it floats above');

    const boxRenders = await page.evaluate(() => {
      const input = document.querySelector('.m3-field input[aria-label="Code from your phone"]');
      const r = input.getBoundingClientRect();
      return r.width >= 280 && r.height >= 50 && input.offsetParent !== null;
    });
    ok(boxRenders, 'the box is a real, visible, full-width input');

    const floats = await page.evaluate(async () => {
      const input = document.querySelector('.m3-field input[aria-label="Code from your phone"]');
      const label = input.nextElementSibling;
      const before = label.getBoundingClientRect().top;
      const inputTop = input.getBoundingClientRect().top;
      input.focus();
      await new Promise((r) => setTimeout(r, 250));
      const after = label.getBoundingClientRect().top;
      return { before, after, inputTop };
    });
    ok(floats.after < floats.before - 8 && floats.after < floats.inputTop,
      `the label does not float off the box: ${JSON.stringify(floats)}`);
    await page.close();
  });
} finally {
  if (b) await b.close().catch(() => {});
  srv.kill();
  killPort(PORT);
  fs.rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);