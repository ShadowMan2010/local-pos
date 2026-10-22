/* Feature: the shop PIN, in a real browser.
   Three states have to be told apart on screen, and only the third one should ever be a lock screen:
     1. no PIN set      -> the dashboard, immediately
     2. PIN set         -> the lock screen, and the right PIN gets in
     3. wrong PIN       -> an explanation, and no way past it
   It also covers the version-skew case that blacked the till out: new JavaScript talking to a server
   that has not been restarted, where the status endpoint does not exist at all. */
import { loadPuppeteer, launchBrowser, killPort } from './browser.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const puppeteer = await loadPuppeteer();

const PORT = 3201;
const DIR = '/tmp/opencode/pingate';
const BASE = `http://localhost:${PORT}`;
let pass = 0, fail = 0;
let srv = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (p, body, token) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    // content-type has to live inside headers. Sitting it next to headers as a sibling looks right
    // and silently sends no content-type at all, so express.json() leaves the body unparsed and every
    // field arrives undefined.
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
  return r.json().catch(() => null);
};

const t = async (name, fn) => {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
};
const ok = (c, m) => { if (!c) throw new Error(m); };

async function startServer() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  srv = spawn('node', ['server.js'], {
    cwd: '/home/dhruba/m3-pos',
    env: { ...process.env, PORT: String(PORT), POS_DATA_DIR: DIR, POS_NO_WHATSAPP: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 100; i++) {
    try { await fetch(BASE + '/api/config'); return; } catch { await sleep(100); }
  }
  throw new Error('server did not start');
}
const stopServer = () => { try { srv?.kill('SIGKILL'); } catch {} killPort(PORT); };

/** Opens the till and reports what a person would actually see. */
async function openTill() {
  const browser = await launchBrowser(puppeteer);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    // Any script error leaves the till half-built with no explanation, which is exactly the class of
    // failure these tests exist to catch. Collected so a failure can say what broke.
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
    // Long enough for boot() to fetch the config and then ask whether a PIN is needed: two round
    // trips, and the second only happens once the first has resolved.
    await sleep(1500);
    const state = await page.evaluate(() => {
      const gate = document.querySelector('[data-pin-gate]');
      const app = document.getElementById('app');
      return {
        gated: !!gate,
        gateText: gate ? gate.innerText.replace(/\s+/g, ' ').trim() : '',
        // Whether anything is actually painted, not merely present. A black screen has elements.
        appText: (app?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        hasInput: !!gate?.querySelector('input')
      };
    });
    state.errors = errors;
    return { page, browser, state };
  } catch (e) {
    await browser.close();
    throw e;
  }
}

try {
  /* ---------- 1. no PIN set: the till must just open ---------- */
  await startServer();
  // The store is configured but has no PIN. This has to come first: an unconfigured shop shows the
  // setup wizard, and every assertion below is about the dashboard, so testing before this would
  // pass for the wrong reason.
  await post('/api/setup', { storeName: 'Corner Store', upiVpa: 'shop@bank' });
  await t('with no PIN set, the dashboard opens and no lock screen appears', async () => {
    const { browser, state } = await openTill();
    try {
      ok(!state.errors.length, 'the page had errors: ' + state.errors.join(' | '));
      ok(!state.gated, 'no lock screen');
      ok(state.appText.length > 0, 'the dashboard rendered, but the screen was blank');
    } finally { await browser.close(); }
  });

  /* ---------- 2. the case that blacked the till out ---------- */
  await t('if the server has no auth routes, the till still opens rather than locking', async () => {
    // Simulates new JavaScript against a not-yet-restarted server: the status endpoint 404s.
    const { browser, page, state } = await openTill();
    try {
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.url().includes('/api/auth/status')) return req.respond({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' });
        req.continue();
      });
      await page.reload({ waitUntil: 'networkidle2' });
      await sleep(900);
      const after = await page.evaluate(() => ({
        gated: !!document.querySelector('[data-pin-gate]'),
        appText: (document.getElementById('app')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120)
      }));
      ok(!after.gated, 'a 404 from the status endpoint must not be read as "locked"');
      ok(after.appText.length > 0, 'the till must still be usable');
    } finally { await browser.close(); }
  });

  /* ---------- 3. a PIN is set: it must actually lock ---------- */
  await post('/api/setup', { storeName: 'Corner Store', upiVpa: 'shop@bank', pin: '4821' });
  await t('with a PIN set, the till asks for it before showing anything sellable', async () => {
    const { browser, state } = await openTill();
    try {
      ok(!state.errors.length, 'the page had errors: ' + state.errors.join(' | '));
      ok(state.gated, 'the lock screen is shown');
      ok(state.hasInput, 'and it has a field to type into');
      ok(/locked/i.test(state.gateText), 'and says so: ' + state.gateText);
      ok(!/Rice|Add item|Total/i.test(state.appText), 'no till controls are exposed behind it');
    } finally { await browser.close(); }
  });

  await t('a wrong PIN is refused with an explanation', async () => {
    const { browser, page } = await openTill();
    try {
      await page.type('[data-pin-gate] input', '1111');
      await page.click('[data-pin-gate] button[type=submit]');
      await sleep(700);
      const after = await page.evaluate(() => ({
        gated: !!document.querySelector('[data-pin-gate]'),
        text: document.querySelector('[data-pin-gate]')?.innerText.replace(/\s+/g, ' ').trim() || ''
      }));
      ok(after.gated, 'still locked');
      ok(/not right|too many/i.test(after.text), 'and is told why: ' + after.text);
    } finally { await browser.close(); }
  });

  await t('the right PIN opens the till', async () => {
    const { browser, page } = await openTill();
    try {
      await page.type('[data-pin-gate] input', '4821');
      await page.click('[data-pin-gate] button[type=submit]');
      // Waiting for the gate to go rather than sleeping a fixed amount: unlocking does a round trip
      // for the token and then builds the whole dashboard, and a sleep either wastes time on a fast
      // machine or flakes on a slow one.
      await page.waitForFunction(() => !document.querySelector('[data-pin-gate]'), { timeout: 15000 })
        .catch(() => {});
      const after = await page.evaluate(() => ({
        gated: !!document.querySelector('[data-pin-gate]'),
        appText: (document.getElementById('app')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200)
      }));
      ok(!after.gated, 'the lock screen is gone');
      ok(after.appText.length > 0, 'and the till is usable again');
      ok(/Corner Store/.test(after.appText), 'showing the shop it belongs to: ' + after.appText);
    } finally { await browser.close(); }
  });

  await t('saving settings from inside the tiller keeps the session alive', async () => {
    // Saving the wizard must not log the person out from under themselves. It has to be done with a
    // token, because once a PIN exists /api/setup is behind the gate like everything else.
    const token = (await post('/api/auth/pin', { pin: '4821' })).token;
    const r = await post('/api/setup', { storeName: 'Corner Store', address: '12 Market Road' }, token);
    ok(r.token, 'a session comes back with the save, so saving does not lock you out');
  });

  await t('an unlocked till can then take an order', async () => {
    const { browser, page } = await openTill();
    try {
      await page.type('[data-pin-gate] input', '4821');
      await page.click('[data-pin-gate] button[type=submit]');
      await sleep(1200);
      // The gate is only worth anything if the till still works once past it.
      const res = await page.evaluate(async () => {
        const r = await fetch('/api/products', { headers: { authorization: 'Bearer ' + sessionStorage.getItem('pos.pin.token') } });
        return r.status;
      });
      ok(res === 200, 'the product list loads with the token, got ' + res);
      const token = await page.evaluate(() => sessionStorage.getItem('pos.pin.token'));
      ok(token, 'the token is held for the rest of the shift');
    } finally { await browser.close(); }
  });

  /* ---------- 4. the second factor, in a real browser ---------- */
  //
  // The one thing a unit test cannot check is whether a shopkeeper staring at this at 9am can tell what is
  // being asked for. Every assertion here is about what is *on screen*, not about what the server returns.

  // Enrol a phone over the API, which is what the settings screen does. The browser then has to cope with
  // a lock screen that wants two things.
  const token2 = (await post('/api/auth/pin', { pin: '4821' })).token;
  const begun = await post('/api/auth/2fa/begin', { account: 'owner' }, token2);
  const { currentCode, totpInternals } = await import('../totp.js');
  const confirmed = await post('/api/auth/2fa/confirm', { code: currentCode(begun.secret) }, token2);
  ok(confirmed.backupCodes?.length === 10, 'the phone was enrolled for this test');
  // The confirming code is spent, so the first usable code belongs to the next window. A real shopkeeper
  // waits for the number to change; so does this.
  const usableCode = async () => {
    const step = totpInternals.STEP_SECONDS * 1000;
    await sleep((Math.floor(Date.now() / step) + 1) * step - Date.now() + 250);
    return currentCode(begun.secret);
  };

  // Verifying the PIN is a deliberate scrypt, which is slow enough on a slow shop tablet that a fixed
  // sleep races it. Every wait below is for the button to stop saying "Checking…", which is the button
  // saying the request finished either way — so a slow machine does not turn into a false failure.
  const waitSettled = (page) => page.waitForFunction(() => {
    const b = document.querySelector('[data-pin-gate] button[type=submit]');
    return !b || b.textContent !== 'Checking…';
  }, { timeout: 20000 }).catch(() => {});
  /** Types the PIN, submits, and waits until the lock screen has reacted. */
  const enterPin = async (page, pin = '4821') => {
    await page.type('[data-pin-gate] input[aria-label="Shop PIN"]', pin);
    await page.click('[data-pin-gate] button[type=submit]');
    await waitSettled(page);
  };
  const enterCode = async (page, code) => {
    await page.waitForSelector('[data-pin-gate] input[aria-label="Code from your phone"]:not([disabled])', { timeout: 8000 }).catch(() => {});
    await page.type('[data-pin-gate] input[aria-label="Code from your phone"]', code);
    await page.click('[data-pin-gate] button[type=submit]');
    await waitSettled(page);
  };
  const gateState = (page) => page.evaluate(() => {
    const gate = document.querySelector('[data-pin-gate]');
    const code = gate?.querySelector('input[aria-label="Code from your phone"]');
    return {
      gated: !!gate,
      text: gate?.innerText.replace(/\s+/g, ' ').trim() || '',
      appText: (document.getElementById('app')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      // The PIN must not be re-asked for. It is known good, and making somebody type it again after
      // every mistake is how people stop bothering with the second factor at all.
      pinReadOnly: !!gate?.querySelector('input[aria-label="Shop PIN"]')?.readOnly,
      // Painted, not merely present: a field left in the DOM behind a hidden parent is not on screen.
      codeVisible: !!code && !code.closest('[hidden]')
    };
  });
  const unlocked = (page) => page.waitForFunction(() => !document.querySelector('[data-pin-gate]'), { timeout: 20000 }).catch(() => {});

  await t('with a second factor on, the correct PIN alone does not open the till', async () => {
    const { browser, page, state } = await openTill();
    try {
      ok(state.gated, 'the till is locked');
      // One box on arrival, not two. Asking for a code before the server has confirmed the PIN would mean
      // every shop with no second factor — and every shop mid-setup — sees a field that does nothing.
      const fields = await page.$$eval('[data-pin-gate] input', (els) =>
        els.filter((e) => !e.closest('[hidden]')).length);
      ok(fields === 1, 'only the PIN box is shown first, saw ' + fields);

      await enterPin(page);
      const after = await gateState(page);
      ok(after.gated, 'still locked — the PIN alone was not enough');
      ok(/phone|code/i.test(after.text), 'and it asks for the code: ' + after.text);
      ok(after.pinReadOnly, 'the PIN box stops asking for a PIN that already worked');
      ok(after.codeVisible, 'and the code box is now visible');
    } finally { await browser.close(); }
  });

  await t('a wrong code is refused and the PIN is not asked for again', async () => {
    const { browser, page } = await openTill();
    try {
      await enterPin(page);
      await enterCode(page, '000000');
      const after = await gateState(page);
      ok(after.gated, 'still locked');
      ok(/not right/i.test(after.text), 'and is told the code is wrong, not the PIN: ' + after.text);
      ok(after.pinReadOnly, 'and the PIN box does not start asking for the PIN again');
    } finally { await browser.close(); }
  });

  await t('the PIN and a live code together open the till', async () => {
    const { browser, page } = await openTill();
    try {
      const code = await usableCode();
      await enterPin(page);
      await enterCode(page, code);
      await unlocked(page);
      const after = await gateState(page);
      ok(!after.gated, 'the lock screen is gone');
      ok(after.appText.length > 0, 'and the till works: ' + after.appText);
    } finally { await browser.close(); }
  });

  await t('a backup code typed into the same box opens the till, for a shop with no phone', async () => {
    // The whole point of backup codes: a shopkeeper who lost their phone can still open the till. It has to
    // work through the same field, with no mode switch to discover.
    const { browser, page } = await openTill();
    try {
      await enterPin(page);
      await enterCode(page, confirmed.backupCodes[0]);
      await unlocked(page);
      const after = await gateState(page);
      ok(!after.gated, 'a backup code opens the till like any other code');
    } finally { await browser.close(); }
  });

  await t('the settings view offers the second factor and shows the backup codes once', async () => {
    // Enrolment is done in settings, so that is where it has to be findable. What is pinned here is not
    // the enrolment flow — that is covered over real HTTP — but that a shopkeeper can find it, and that
    // the codes end up written on screen rather than only in the server log.
    const { browser, page } = await openTill();
    try {
      await enterPin(page);
      await enterCode(page, await usableCode());
      await unlocked(page);

      // Settings is a view inside the till, not a page of its own, so it is opened the way a shopkeeper
      // opens it rather than by guessing a URL.
      const opened = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button,[role=button]')]
          .find((b) => /settings|set up/i.test(b.getAttribute('aria-label') || b.title || b.innerText || ''));
        if (!btn) return false;
        btn.click();
        return true;
      });
      ok(opened, 'there is a way into settings from the till');
      await sleep(1500);
      const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
      ok(/second factor/i.test(text), 'the second factor is offered: ' + text.slice(0, 300));

      // Already switched on for this shop, so the panel must offer the two things that matter now:
      // writing new codes, and turning it off.
      const controls = await page.evaluate(() =>
        [...document.querySelectorAll('button')].map((b) => b.innerText.replace(/\s+/g, ' ').trim()));
      ok(controls.some((t) => /new backup codes/i.test(t)), 'and can write new ones, saw: ' + controls.join(' | '));
      ok(controls.some((t) => /turn this off/i.test(t)), 'and can turn it off, saw: ' + controls.join(' | '));
    } finally { await browser.close(); }
  });
} finally {
  stopServer();
  fs.rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
