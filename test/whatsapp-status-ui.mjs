/* The WhatsApp status message on the settings screen, in a real browser, after the phone revokes the till.

   This exists because the fix for "WhatsApp is stuck on Starting…" was written, reviewed and tested, and the
   shop still saw the bug. Nothing was wrong with the code under test. The problem was that no test had ever
   loaded the page, so what "fixed" meant was decided by reading a status function and not by looking at
   what a person would see.

   The real shape of the failure: when the phone unlinks the device, the server reported
   {connected:false, qr:null} — the same JSON as a socket that has not finished starting. The screen has one
   branch for "Starting…", and a revoke fell into it. That state never resolves on its own, because there is
   nothing to wait for, so the message was a lie that could not be waited out.

   So this test asserts on the text on the screen, in the place a shopkeeper looks, rather than on the JSON
   that produced it. */
import { loadPuppeteer, launchBrowser, killPort } from './browser.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const puppeteer = await loadPuppeteer();

const PORT = 3195;
const DIR = '/tmp/opencode/fwastatus';
const BASE = `http://localhost:${PORT}`;
const PIN = '4821';
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

const startServer = async (status) => {
  killPort(PORT);
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'orders.jsonl'), '');
  fs.writeFileSync(path.join(DIR, 'counters.json'), '{}');
  srv = spawn('node', ['server.js'], {
    // The stand-in reports whatever state is asked for here, so a revoked device can be reproduced without
    // a phone and a real WhatsApp account — neither of which a test run may assume it has.
    env: {
      ...process.env, PORT: String(PORT), POS_DATA_DIR: DIR, POS_NO_WHATSAPP: '1',
      POS_FAKE_WHATSAPP: '1', POS_FAKE_WHATSAPP_STATUS: JSON.stringify(status)
    },
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
  await post('/api/setup', { storeName: 'WA Status Test', upiVpa: '', pin: PIN });
  const { token } = await post('/api/auth/pin', { pin: PIN });
  ok(token, 'the shop PIN was not accepted');
  return token;
};

/** Signs in the way the till does and opens Settings, so the WhatsApp card is really on screen. */
const openSettings = async (page) => {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-pin-gate]', { timeout: 15000 });
  await page.type('[data-pin-gate] input', PIN);
  await page.click('[data-pin-gate] button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('[data-pin-gate]'), { timeout: 15000 });
  // Settings is found the way a person finds it: by the label on the button, not by a test-only selector.
  const opened = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')]
      .find((b) => /settings|set up/i.test(b.getAttribute('aria-label') || b.title || b.innerText || ''));
    if (!btn) return false;
    btn.click();
    return true;
  });
  ok(opened, 'there is no way into settings from the till');
  // The card polls its status on a timer, so the revoked branch arrives a moment after the card opens.
  await page.waitForSelector('[data-wa-status]', { timeout: 15000 });
  await sleep(900);
  return page.$eval('[data-wa-status]', (el) => el.textContent.trim());
};

let browser;
try {
  browser = await launchBrowser(puppeteer);

  await t('a revoked device does not read as "Starting…"', async () => {
    await startServer({ connected: false, qr: null, phone: null, loggedOut: true });
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    const text = await openSettings(page);
    ok(errs.length === 0, `the page threw: ${errs.join(' | ')}`);
    ok(!/starting/i.test(text),
      `the screen still says "${text}" — a revoke must not look like a socket that is still starting`);
    ok(!/starting/i.test(await page.$eval('[data-wa-status]', (el) => el.textContent)),
      'the starting message came back on a later poll');
    await page.close();
  });

  await t('the relink button goes back to waiting for a QR', async () => {
    // The message on its own is only half the fix. A shop told "orders are not being received" with no way
    // to act has to phone someone, and the previous advice was to restart the server, which is not something
    // a person can do from a browser on the same machine.
    await startServer({ connected: false, qr: null, phone: null, loggedOut: true });
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    const before = await openSettings(page);
    ok(!/starting/i.test(before), `the screen still reads "${before}"`);
    const clicked = await page.evaluate(() => {
      const btn = document.querySelector('[data-wa-relink]');
      if (!btn) return false;
      btn.click();
      return true;
    });
    ok(clicked, 'no relink button was offered on the revoked screen');
    // The stand-in answers a relink with a pending QR, which is the state the real socket moves to.
    await sleep(1200);
    const body = await page.$eval('[data-wa-status]', (el) => el.textContent);
    ok(!/not receiving|unlinked|starting/i.test(body),
      `after linking again the screen still reads "${body}"`);
    const st = await (await fetch(`${BASE}/api/whatsapp/status`)).json();
    ok(st.loggedOut === false, 'the server still reports the device as revoked after relinking');
    ok(errs.length === 0, `the page threw: ${errs.join(' | ')}`);
    await page.close();
  });

  await t('a slow start still says Starting…', async () => {
    // The fix must not simply have replaced one lie with another. A socket that is genuinely still
    // starting should keep saying so.
    await startServer({ connected: false, qr: null, phone: null, loggedOut: false });
    const page = await browser.newPage();
    const text = await openSettings(page);
    ok(/starting/i.test(text), `a socket that is still starting reads "${text}"`);
    await page.close();
  });

  await t('a bot the shop stopped does not read as a slow start', async () => {
    // A stopped bot is not connected and shows no QR — the same two facts a starting socket has. Without a
    // state of its own it lands in the "Starting…" branch and promises a connection nobody asked for, which
    // is the bug this card was already rewritten for, in a new costume.
    await startServer({ connected: false, qr: null, phone: null, loggedOut: false, enabled: false });
    const page = await browser.newPage();
    const text = await openSettings(page);
    ok(!/starting/i.test(text), `a stopped bot reads "${text}" — that is the one message it must never show`);
    ok(/stopped/i.test(text), `a stopped bot should say so plainly, but it reads "${text}"`);
    await page.close();
  });

  await t('the start button is offered when the bot is stopped, and Stop when it is running', async () => {
    // One switch, and its label has to match what the next press will do. A button reading "Stop" on a bot
    // that is already stopped is a shop's first impression of a feature that does not work.
    await startServer({ connected: true, qr: null, phone: '919000000000', loggedOut: false, enabled: true });
    const page = await browser.newPage();
    const label = async () => page.$eval('[data-wa-toggle]', (b) => b.textContent.trim());
    await openSettings(page);
    ok(/stop/i.test(await label()), `a running bot offers "${await label()}"`);
    await page.click('[data-wa-toggle]');
    await sleep(900);
    const st = await (await fetch(`${BASE}/api/whatsapp/status`)).json();
    ok(st.enabled === false, 'the button did not stop the bot');
    ok(/start/i.test(await label()), `a stopped bot offers "${await label()}"`);
    await page.close();
  });

  await t('the loading indicator appears while the switch is being pressed', async () => {
    // Otherwise the switch has the exact problem it was added to fix: a tap that looks like it did nothing.
    await startServer({ connected: true, qr: null, phone: '919000000000', loggedOut: false, enabled: true });
    const page = await browser.newPage();
    await openSettings(page);
    const seen = await page.evaluate(async () => {
      const btn = document.querySelector('[data-wa-toggle]');
      btn.click();
      // Synchronously after the click, before the request can come back.
      return { busy: btn.dataset.busy, spinner: !!btn.querySelector('.md-spinner') };
    });
    ok(seen.busy, 'the start/stop button showed no loading state at all');
    ok(seen.spinner, 'the start/stop button has no indicator on it');
    await page.close();
  });

  await t('unlinking does not leave the card promising a connection', async () => {
    // The bug this guards: unlink() set `stopped` but left `enabled` true, so the status it reported was
    // {connected:false, qr:null} with nothing revoked about it — which is byte-for-byte the "Starting…"
    // branch. The screen then waited on a connection that unlinking had just made impossible, from a button
    // whose own message said to start the bot again.
    await startServer({ connected: true, qr: null, phone: '919000000000', loggedOut: false, enabled: true });
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await openSettings(page);
    const clicked = await page.evaluate(() => {
      window.confirm = () => true; // the card asks before destroying the linked number
      const btn = [...document.querySelectorAll('button')].find((b) => /unlink/i.test(b.innerText || ''));
      if (!btn || btn.hidden) return false;
      btn.click();
      return true;
    });
    ok(clicked, 'a connected bot offered no Unlink button');
    // Long enough for the card's own 3s poll. Waiting less than that would read the screen as it looked
    // before the press, which is exactly the kind of timing assumption that makes a UI test lie.
    await sleep(4200);
    const st = await (await fetch(`${BASE}/api/whatsapp/status`)).json();
    ok(st.enabled === false, `after unlinking the switch still reads enabled:${st.enabled}`);
    const text = await page.$eval('[data-wa-status]', (el) => el.textContent);
    ok(!/starting/i.test(text), `after unlinking the card reads "${text}"`);
    ok(!/unlinked from the phone/i.test(text),
      `after unlinking the card blames the phone: "${text}" — nothing revoked anything, the shop did`);
    const label = await page.$eval('[data-wa-toggle]', (b) => b.textContent.trim());
    ok(/start/i.test(label), `after unlinking the switch offers "${label}", not a way to start again`);
    ok(errs.length === 0, `the page threw: ${errs.join(' | ')}`);
    await page.close();
  });

  await t('unlinking forgets the number it had linked', async () => {
    // The credentials are gone, so reporting a linked number is a claim the shop has to disprove rather
    // than a fact they can act on — and the number on screen is what they would act on.
    const token = await startServer({ connected: true, qr: null, phone: '919000000000', loggedOut: false, enabled: true });
    // With the token: the route is behind the shop PIN, which is right, but it means an unauthenticated
    // call here would 401 and the assertion would pass for the wrong reason.
    const res = await post('/api/whatsapp/unlink', {}, token);
    ok(res?.ok, 'the authenticated unlink call was refused');
    const st = await (await fetch(`${BASE}/api/whatsapp/status`)).json();
    ok(st.phone === null, `the card still claims a link to ${st.phone} after the credentials were deleted`);
  });

  await t('a connected number does not read as a problem', async () => {
    await startServer({ connected: true, qr: null, phone: '919000000000', loggedOut: false });
    const page = await browser.newPage();
    const text = await openSettings(page);
    ok(!/starting|unlinked|not receiving/i.test(text), `a linked bot reads "${text}"`);
    ok(/919000000000/.test(text), `the phone number is not shown: "${text}"`);
    await page.close();
  });
} finally {
  await browser?.close().catch(() => {});
  srv?.kill();
  killPort(PORT);
  fs.rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
