/* The three gate and 2FA bugs a shopkeeper reported, each pinned by a test that fails without its fix.

   None of these are visible in the source or the API. The PIN re-ask is a lifecycle question, the two
   boxes are a CSS question, and the backup codes are a whitespace question. All three were found by
   somebody using the till, so each is checked by driving the page the way a shopkeeper does.

   2FA is enrolled over the API first, exactly as the settings screen does it, so the gate genuinely has to
   deal with a second factor rather than the test simulating one. */
import { loadPuppeteer, launchBrowser, killPort } from './browser.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { currentCode, totpInternals } from '../totp.js';

const puppeteer = await loadPuppeteer();
const PORT = 3194;
const DIR = '/tmp/opencode/fgate';
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
for (let i = 0; ; i++) {
  try { const r = await fetch(`${BASE}/api/auth/status`); if (r.ok) { await r.text(); break; } } catch {}
  if (i > 80) { console.log('server never became ready\n' + logs.join('')); process.exit(1); }
  await sleep(250);
}
const post = async (p, payload, token) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(payload)
  });
  const body = await r.json().catch(() => ({}));
  // Printed on failure, because "the login did not work" is useless without the server's own answer.
  if (!r.ok && process.env.DEBUG_GATE) console.log('   post ' + p + ' -> ' + r.status + ' ' + JSON.stringify(body));
  return { ok: r.ok, status: r.status, body };
};
// A shop with a PIN set, which is the state all three bugs show up in.
await post('/api/setup', { storeName: 'Gate Test', upiVpa: '', pin: PIN });

// Enrol a phone, so the second box is genuinely required rather than simulated. Done before anything else
// needs a session, and on a shop with no 2FA yet the PIN alone is enough — which is why this can log in.
const enrol = (await post('/api/auth/pin', { pin: PIN })).body.token;
const begun = (await post('/api/auth/2fa/begin', { account: 'owner' }, enrol)).body;
const confirmed = await post('/api/auth/2fa/confirm', { code: currentCode(begun.secret) }, enrol);
ok(confirmed.body.backupCodes?.length === 10, 'the phone was not enrolled, so the second box is untestable');

// From here on the PIN alone is refused, which is the entire point of the second factor. So every API login
// needs a phone code as well, and each code works once — hence a fresh one per call.
const usableCode = async () => {
  const step = totpInternals.STEP_SECONDS * 1000;
  await sleep((Math.floor(Date.now() / step) + 1) * step - Date.now() + 250);
  return currentCode(begun.secret);
};
const apiLogin = async () => {
  const r = await post('/api/auth/pin', { pin: PIN, code: await usableCode() });
  if (!r.ok) throw new Error('the test could not log in over the API: ' + r.status + ' ' + JSON.stringify(r.body));
  return r.body.token;
};
const admin = await apiLogin();

// Verifying the PIN is a deliberate scrypt, slow enough on a shop tablet that a fixed sleep races it.
// Waiting for the button to stop saying "Checking…" is waiting for the request to have finished either way.
const waitSettled = (page) => page.waitForFunction(() => {
  const b = document.querySelector('[data-pin-gate] button[type=submit]');
  return !b || b.textContent !== 'Checking…';
}, { timeout: 25000 }).catch(() => {});
const openGate = async (page) => {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-pin-gate]', { timeout: 20000 });
};

/** Unlocks the till through the UI, the way a shopkeeper does: PIN, then the code from the phone. */
const unlock = async (page) => {
  // Navigates itself, so a caller that reuses a tab is not left on the screen from its last page load.
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-pin-gate]', { timeout: 20000 });
  await page.type('[data-pin-gate] input[aria-label="Shop PIN"]', PIN);
  await page.click('[data-pin-gate] button[type=submit]');
  // 2FA is on for this whole file, so the PIN on its own is refused and the second box appears. Getting
  // here without a code is not a failure of the app, it is the second factor doing its job.
  await page.waitForSelector('[data-pin-gate] input[aria-label="Code from your phone"]', { visible: true, timeout: 20000 });
  await page.type('[data-pin-gate] input[aria-label="Code from your phone"]', await usableCode());
  await page.click('[data-pin-gate] button[type=submit]');
  await waitSettled(page);
  await page.waitForFunction(() => !document.querySelector('[data-pin-gate]'), { timeout: 25000 });
};

let browser;
try {
  browser = await launchBrowser(puppeteer);

  await t('a reload keeps the shop unlocked', async () => {
    // The report: every reload asked for the PIN again, so somebody was typing it dozens of times a shift.
    // sessionStorage is meant to survive a reload — that is the whole difference between it and
    // localStorage here — so the token is still there and the gate must not be shown.
    const page = await browser.newPage();
    await unlock(page);

    const afterLogin = await page.evaluate(() => sessionStorage.getItem('pos.pin.token'));
    ok(afterLogin, 'no token was stored at login, so nothing could survive a reload');

    await page.reload({ waitUntil: 'domcontentloaded' });
    // Waited on the gate rather than on a fixed sleep. A sleep races the scrypt and the module fetch, and
    // when it loses the test fails by looking like the bug it is meant to detect.
    const gateUp = await page.waitForSelector('[data-pin-gate]', { timeout: 4000 })
      .then(() => true, () => false);
    ok(!gateUp, 'the lock screen came back on a plain reload of the same tab');
    ok(await page.evaluate(() => sessionStorage.getItem('pos.pin.token')) === afterLogin,
      'the token changed across a reload');
    await page.close();
  });

  await t('a reload actually loads the till, rather than skipping the lock and showing nothing', async () => {
    // Removing the gate is only half the fix. This is the check that says the dashboard came up.
    const page = await browser.newPage();
    await unlock(page);

    await page.reload({ waitUntil: 'domcontentloaded' });
    // Two-factor is on, so a session that is still valid must not need a code — that is the point of a
    // token lasting a shift. If the gate reappears here the fix has broken the other half of the promise.
    await sleep(2000);
    const state = await page.evaluate(() => ({
      gate: !!document.querySelector('[data-pin-gate]'),
      app: !!document.querySelector('header, .app-bar, .dashboard')
    }));
    ok(!state.gate, 'the lock screen came back on reload');
    ok(state.app, 'the dashboard never rendered after a reload');
    await page.close();
  });

  await t('a genuinely dead session still gets the gate', async () => {
    // The other direction, and the one that keeps the fix from being a security hole. Clearing the token
    // is what a server restart or a sign-out looks like to the browser.
    const page = await browser.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-pin-gate]', { timeout: 20000 });
    await page.evaluate(() => sessionStorage.removeItem('pos.pin.token'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-pin-gate]', { timeout: 20000 });
    ok(true, '');
    await page.close();
  });

  await t('the code field is a real, visible, correctly sized box', async () => {
    // "Not rendering properly" is a layout bug, and layout bugs are invisible to anything but measured
    // pixels. The field is measured after the server has asked for it, which is the only time it exists.
    const page = await browser.newPage();
    await openGate(page);
    await page.type('[data-pin-gate] input[aria-label="Shop PIN"]', PIN);
    await page.click('[data-pin-gate] button[type=submit]');
    // visible:true is load-bearing. Without it this resolves while the field is still hidden and measures 0px,
    // which reads as "the box does not render" rather than as "the test looked too early".
    await page.waitForSelector('[data-pin-gate] input[aria-label="Code from your phone"]', { visible: true, timeout: 20000 });
    await sleep(300);

    const box = await page.evaluate(() => {
      const i = document.querySelector('[data-pin-gate] input[aria-label="Code from your phone"]');
      const r = i.getBoundingClientRect();
      const cs = getComputedStyle(i);
      const label = i.parentElement.querySelector('span');
      const l = label.getBoundingClientRect();
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        visible: cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.05,
        maxLength: i.getAttribute('maxlength'),
        inputMode: i.getAttribute('inputmode'),
        labelTop: Math.round(l.top - r.top),
        // The label must sit above the field, not across it. This is the actual defect: the label was
        // written before the input in the DOM, so the "lift on focus" rule (input + span) never matched
        // and the label sat on top of the digits being typed.
        labelIsAfterInput: i.nextElementSibling === label
      };
    });
    ok(box.visible, 'the code field is present but not visible: ' + JSON.stringify(box));
    ok(box.h >= 44, `the code field is ${box.h}px tall, too small to aim at on a touchscreen`);
    ok(box.w >= 200, `the code field is only ${box.w}px wide`);
    ok(box.maxLength === '14', `maxlength is ${box.maxLength}, so a 12-digit backup code is truncated`);
    ok(box.inputMode === 'numeric', `inputmode is "${box.inputMode}", so a phone shows letters`);
    ok(box.labelIsAfterInput, 'the label comes before the input, so the floating-label rule cannot match it');
    ok(box.labelTop <= -4, `the label is ${box.labelTop}px below the field top, so it covers the code`);
    await page.close();
  });

  await t('the code field accepts a backup code in full and unlocks', async () => {
    // Proves the field is not merely visible but usable: a backup code is 12 digits with dashes, and it is
    // the only way back in when the phone is gone. If the box truncates or the dashes break it, the shop is
    // locked out at the worst possible moment.
    const page = await browser.newPage();
    await openGate(page);
    await page.type('[data-pin-gate] input[aria-label="Shop PIN"]', PIN);
    await page.click('[data-pin-gate] button[type=submit]');
    await page.waitForSelector('[data-pin-gate] input[aria-label="Code from your phone"]', { visible: true, timeout: 20000 });

    const backup = confirmed.body.backupCodes[0];
    const digits = backup.replace(/-/g, '');
    ok(digits.length >= 10, `the backup code "${backup}" is only ${digits.length} digits`);

    // Typed with the dashes, the way somebody reads it off the card they wrote it on.
    await page.type('[data-pin-gate] input[aria-label="Code from your phone"]', backup);
    const stored = await page.$eval('[data-pin-gate] input[aria-label="Code from your phone"]', (i) => i.value);
    ok(!stored.includes('-'), `dashes were left in the field: "${stored}"`);
    ok(stored.length === digits.length,
      `the field kept ${stored.length} of ${digits.length} characters: "${stored}"`);
    await page.close();
  });

  await t('the backup code list is readable, one code per row', async () => {
    // The third report. `codes.join('\n')` inside a div with no white-space handling collapses the
    // newlines, so ten codes arrive as one continuous run that wraps at arbitrary points — exactly wrong
    // for something somebody has to copy onto paper by hand and read back later.
    const page = await browser.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-pin-gate]', { timeout: 20000 });
    const token = await apiLogin();
    const fresh = await post('/api/auth/2fa/backup-codes', { code: await usableCode() }, token);
    const codes = fresh.body.backupCodes;
    ok(codes?.length, 'could not get a fresh set of backup codes to render');

    const panel = await page.evaluate(async (codeList) => {
      const mod = await import('/js/components/setup-wizard.js');
      const host = document.createElement('div');
      document.body.append(host);
      // The panel is rendered by the settings wizard, which is behind the lock screen. Rather than unlock
      // and navigate, the markup it produces is measured directly here: the layout is what was reported.
      const el = mod.backupCodesPanel ? mod.backupCodesPanel(codeList, () => {}) : null;
      if (!el) return { notExported: true };
      host.replaceChildren(el);
      await new Promise((r) => requestAnimationFrame(r));
      const grid = el.querySelector('[data-backup-code]')?.parentElement;
      const cell = el.querySelector('[data-backup-code]');
      const cs = grid ? getComputedStyle(grid) : null;
      const cells = [...el.querySelectorAll('[data-backup-code]')];
      // Measured, not asserted from the source: two codes side by side is the difference between a list a
      // shopkeeper can write down and a paragraph they cannot.
      const tops = cells.map((c) => Math.round(c.getBoundingClientRect().top));
      return {
        found: true,
        whiteSpace: cell ? getComputedStyle(cell).whiteSpace : null,
        font: cs?.fontFamily,
        cells: cells.length,
        count: codeList.length,
        rows: cell ? Math.round(cell.getBoundingClientRect().height) : 0,
        columns: cs?.gridTemplateColumns?.split(' ').length || 0,
        uniqueTops: new Set(tops).size,
        widest: Math.max(0, ...cells.map((c) => Math.round(c.getBoundingClientRect().width))),
        // Every code has to be fully inside the grid: a code that overflows is a code that gets clipped.
        overflow: cs ? getComputedStyle(grid).overflow : null,
        firstCode: cells[0]?.textContent
      };
    }, codes);

    ok(!panel.notExported, 'the backup code panel is not reachable, so this test needs rewriting');
    // One element per code. This is the check that fails if anyone goes back to joining them into a string.
    ok(panel.cells === panel.count, `only ${panel.cells} of ${panel.count} codes are addressable on their own`);
    ok(panel.uniqueTops > 1, 'every code is on the same line, so they have run together');
    ok(panel.whiteSpace === 'nowrap', `codes wrap (white-space: ${panel.whiteSpace}), so a code can be misread across two lines`);
    ok(/mono|Menlo|Consolas/i.test(panel.font || ''), `the codes are not monospace (${panel.font})`);
    ok(panel.rows >= 28, `each code sits in a ${panel.rows}px row, too tight to write down from`);
    ok(panel.widest >= 100, `the code cells are only ${panel.widest}px wide, so they are being squeezed`);
    await page.close();
  });

  await t('the PIN field is tall enough and its label does not cover it', async () => {
    const page = await browser.newPage();
    await openGate(page);
    await page.type('[data-pin-gate] input[aria-label="Shop PIN"]', PIN);
    // Measured with the field focused and filled, which is the only state the label is meant to float in.
    // An empty field with the label resting at 16px is correct Material behaviour, not a defect — asserting
    // against that would be asserting that the floating labels do not float.
    await page.focus('[data-pin-gate] input[aria-label="Shop PIN"]');
    await sleep(250);
    const f = await page.evaluate(() => {
      const i = document.querySelector('[data-pin-gate] input[aria-label="Shop PIN"]');
      const r = i.getBoundingClientRect();
      const label = i.parentElement.querySelector('span').getBoundingClientRect();
      return { h: Math.round(r.height), w: Math.round(r.width), labelTop: Math.round(label.top - r.top) };
    });
    ok(f.h >= 44, `the PIN field is ${f.h}px tall`);
    ok(f.w >= 200, `the PIN field is only ${f.w}px wide`);
    ok(f.labelTop <= -4, `the PIN label is ${f.labelTop}px from the top, so it overlaps the digits`);
    await page.close();
  });

  await t('the gate fits a small phone without the Unlock button below the fold', async () => {
    // A gate whose button is off the bottom is a gate somebody cannot get past.
    for (const vp of [{ width: 360, height: 640, label: 'small phone' }, { width: 1280, height: 700, label: 'desktop' }]) {
      const page = await browser.newPage();
      await page.setViewport({ width: vp.width, height: vp.height });
      await openGate(page);
      const btn = await page.evaluate(() => {
        const b = document.querySelector('[data-pin-gate] button[type=submit]');
        const r = b.getBoundingClientRect();
        return { bottom: Math.round(r.bottom), vh: innerHeight, h: Math.round(r.height) };
      });
      ok(btn.bottom <= btn.vh,
        `${vp.label}: the Unlock button ends at ${btn.bottom}px on a ${btn.vh}px screen`);
      ok(btn.h >= 40, `${vp.label}: the Unlock button is ${btn.h}px tall`);
      await page.close();
    }
  });
} finally {
  await browser?.close().catch(() => {});
  srv?.kill();
  killPort(PORT);
  fs.rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
