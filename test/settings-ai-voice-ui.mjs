/* Saving the AI key and the voice-ordering switch from Settings, one bug pinned.

   The report: a shopkeeper pasted a Gemini API key, toggled voice ordering, tapped Save, and nothing
   stuck — the key was gone on reload and voice stayed off. The cause was invisible to every other test
   because nothing sent the request: both cards were built as a <section>, not a <form>, and the save
   handlers did `new FormData(saveBtn.closest('section'))`. FormData only accepts an HTMLFormElement and
   throws on anything else, so the handler died before `fetch` and no request was ever made. A second bug
   rode along: the provider picker was seeded from the *detected* host, so pasting a Gemini key saved an
   explicit OpenRouter provider and sent the Gemini key to the wrong host.

   So this test drives the real buttons and insists on the bytes on disk, not on a status label. */
import { loadPuppeteer, launchBrowser, killPort } from './browser.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const puppeteer = await loadPuppeteer();
const PORT = 3241;
const DIR = '/tmp/opencode/saiuv';
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
};
const ok = (c, m) => { if (!c) throw new Error(m); };
const readConfig = () => JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));

killPort(PORT);
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
// A shop that already exists, so Settings (not the first-run wizard) is what opens.
fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
  storeName: 'AI Voice Shop', address: '', phone: '9999999999', upiVpa: 'shop@bank',
  qrMode: 'receipt', displayUrl: ''
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
  const page = await b.newPage();
  await page.setViewport({ width: 1100, height: 950 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button[aria-label="Store settings"]', { timeout: 20000 });
  await page.click('button[aria-label="Store settings"]');
  await page.waitForSelector('input[name="aiKey"]', { timeout: 20000 });

  await t('the Gemini key is on disk after tapping "Save key"', async () => {
    await page.type('input[name="aiKey"]', 'AIzaSyUITestKey000000000');
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((x) => /Save key/.test(x.textContent));
      if (btn) btn.click();
      return Boolean(btn);
    });
    ok(clicked, 'the "Save key" button was not found');
    await page.waitForFunction(() => /On — using gemini/.test(document.body.innerText), { timeout: 10000 });
    const cfg = readConfig();
    ok(cfg.ai?.apiKey === 'AIzaSyUITestKey000000000', 'the key did not reach config.json');
    // The picked provider must stay blank so it is detected from the key, not pinned to OpenRouter.
    ok(!cfg.ai?.provider, `an explicit provider was saved: ${cfg.ai?.provider}`);
  });

  await t('no page error is thrown while saving (the FormData bug is gone)', async () => {
    ok(!errors.some((e) => /FormData/.test(e)), errors.join(' | '));
  });

  await t('the voice-ordering switch is on disk after tapping Save', async () => {
    await page.evaluate(() => {
      const cb = document.querySelector('input[name="voiceEnabled"]');
      cb.checked = true;
      const btn = [...cb.closest('section').querySelectorAll('button')].find((x) => /Save/.test(x.textContent));
      if (btn) btn.click();
    });
    await page.waitForFunction(() => /heard with your Gemini key/.test(document.body.innerText), { timeout: 10000 });
    ok(readConfig().voice?.enabled === true, 'voice ordering did not reach config.json');
  });
} finally {
  if (b) await b.close();
  srv.kill('SIGKILL');
  killPort(PORT);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
