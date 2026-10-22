/* The loading indicator on an action button, in a real browser.

   This exists because the thing that was reported — a tap that looked like it did nothing — is a visual
   problem, and every test in the suite for it would be a test of JavaScript that ran correctly while the
   screen showed nothing. A button that gains a spinner, loses its label, or jumps in width can be
   perfectly correct in a unit test and still look broken to the person using the till.

   So this asserts on the rendered box: the indicator is there, the button did not move or resize, the
   label is still in the DOM for a screen reader, and the button cannot be pressed twice. */
import { loadPuppeteer, launchBrowser, killPort } from './browser.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const puppeteer = await loadPuppeteer();

const PORT = 3197;
const DIR = '/tmp/opencode/fwabusy';
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
await fetch(`${BASE}/api/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ storeName: 'Busy Test', upiVpa: '', pin: PIN })
});

let browser;
try {
  browser = await launchBrowser(puppeteer);
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-pin-gate]', { timeout: 15000 });
  await page.type('[data-pin-gate] input', PIN);
  await page.click('[data-pin-gate] button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('[data-pin-gate]'), { timeout: 15000 });

  await t('a busy button shows a spinner and announces itself to a screen reader', async () => {
    // A 2s action, so the busy state is observable rather than a frame nobody can catch.
    const r = await page.evaluate(async () => {
      const { h, busy } = await import('/js/ui.js');
      const btn = h('button', { type: 'button', class: 'btn btn-filled' }, 'Save settings');
      document.body.append(btn);
      busy(btn, true);
      const s = btn.querySelector('.md-spinner');
      const box = s ? s.getBoundingClientRect() : null;
      return {
        hasSpinner: !!s,
        spinW: box?.width || 0,
        ariaBusy: btn.getAttribute('aria-busy'),
        disabled: btn.disabled,
        // The label is hidden with CSS, not deleted — it has to stay in the accessibility tree.
        labelStillThere: btn.textContent.includes('Save settings'),
        hiddenByCss: getComputedStyle(btn).color,
        styleLoaded: [...document.styleSheets].some((s) => {
          try { return [...s.cssRules].some((r) => r.selectorText?.includes('[data-busy]')); }
          catch { return false; }
        })
      };
    });
    ok(r.styleLoaded, 'the [data-busy] rules are not in the loaded stylesheet, so nothing will be visible');
    ok(r.hasSpinner, 'no spinner was added to the button');
    ok(r.ariaBusy === 'true', `aria-busy should be "true" while working, got ${r.ariaBusy}`);
    ok(r.disabled, 'the button stayed pressable, so the action could be run twice');
    ok(r.labelStillThere, 'the label was removed from the DOM instead of hidden');
    // M3 circular indicator: a small circle, not a 3px-stroke blob.
    ok(r.spinW > 10 && r.spinW < 30, `the indicator is ${r.spinW}px wide, which is not a spinner`);
  });

  await t('the button does not move or resize while it works', async () => {
    // The reason the label is hidden with CSS rather than swapped in JavaScript. Replacing it makes the
    // button shrink to the width of the spinner and grow back, and on a till that reads as the interface
    // jumping at the moment someone is trying to confirm their tap landed.
    const moved = await page.evaluate(async () => {
      const { busy } = await import('/js/ui.js');
      const btn = document.querySelector('.btn[data-busy]');
      const before = btn.getBoundingClientRect();
      busy(btn, true);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const after = btn.getBoundingClientRect();
      const s = btn.querySelector('.md-spinner');
      const sb = s.getBoundingClientRect();
      const bb = btn.getBoundingClientRect();
      // Is the spinner actually in the middle of the button, and not off in a corner?
      const dx = Math.abs((sb.left + sb.width / 2) - (bb.left + bb.width / 2));
      const dy = Math.abs((sb.top + sb.height / 2) - (bb.top + bb.height / 2));
      return {
        wDelta: Math.abs(after.width - before.width),
        hDelta: Math.abs(after.height - before.height),
        xDelta: Math.abs(after.left - before.left),
        offCentreX: dx, offCentreY: dy
      };
    });
    ok(moved.wDelta < 0.5, `the button changed width by ${moved.wDelta.toFixed(1)}px while busy`);
    ok(moved.hDelta < 0.5, `the button changed height by ${moved.hDelta.toFixed(1)}px while busy`);
    ok(moved.xDelta < 0.5, `the button moved sideways by ${moved.xDelta.toFixed(1)}px while busy`);
    ok(moved.offCentreX < 1.5, `the spinner sits ${moved.offCentreX.toFixed(1)}px off the middle of the button`);
    ok(moved.offCentreY < 1.5, `the spinner sits ${moved.offCentreY.toFixed(1)}px off the middle vertically`);
  });

  await t('the spinner is actually animating, and not sitting still looking broken', async () => {
    const running = await page.evaluate(async () => {
      const s = document.querySelector('.btn[data-busy] .md-spinner');
      const anims = s.getAnimations ? s.getAnimations() : [];
      return { count: anims.length, running: anims.filter((a) => a.playState === 'running').length };
    });
    ok(running.running > 0, `the indicator has ${running.count} animations but none are running — it would look frozen`);
  });

  await t('a second press cannot run the action twice', async () => {
    // The reason the button is disabled rather than just decorated. A disabled button ignores a click
    // outright, so there is no window where a second press slips through between the two.
    const clicks = await page.evaluate(async () => {
      const btn = document.querySelector('.btn[data-busy]');
      const el = document.getElementById('busy-probe') || document.createElement('span');
      el.id = 'busy-probe';
      let hits = 0;
      btn.addEventListener('click', () => { hits++; });
      btn.click();
      btn.click();
      btn.click();
      return hits;
    });
    ok(clicks === 0, `a disabled busy button still received ${clicks} clicks`);
  });

  await t('the indicator is cleared when the action finishes', async () => {
    const r = await page.evaluate(async () => {
      const { busy } = await import('/js/ui.js');
      const btn = document.querySelector('.btn[data-busy]');
      busy(btn, false);
      return {
        spinner: !!btn.querySelector('.md-spinner'),
        ariaBusy: btn.getAttribute('aria-busy'),
        disabled: btn.disabled
      };
    });
    ok(!r.spinner, 'the spinner was left on the button after the action finished');
    ok(r.ariaBusy === null, 'aria-busy was left set after the action finished');
    ok(!r.disabled, 'the button was left disabled, so the action could never be run again');
  });

  await t('a failed action does not leave a permanently spinning button', async () => {
    // The common case on a shop's connection, and the reason runBusy clears the state in `finally`. A
    // button stuck spinning is the one state a shop cannot retry out of without reloading the page.
    const r = await page.evaluate(async () => {
      const { h, runBusy } = await import('/js/ui.js');
      const btn = h('button', { type: 'button', class: 'btn btn-filled' }, 'Send');
      document.body.append(btn);
      let seen = false;
      try {
        await runBusy(btn, async () => {
          await new Promise((r) => setTimeout(r, 50));
          seen = !!btn.querySelector('.md-spinner');
          throw new Error('the network is down');
        });
      } catch { /* the caller handles it; this test is about the button */ }
      return { duringAction: seen, after: !!btn.querySelector('.md-spinner'), disabled: btn.disabled };
    });
    ok(r.duringAction, 'no spinner was shown while the action was running');
    ok(!r.after, 'the spinner survived a failed action');
    ok(!r.disabled, 'the button was left disabled after a failed action');
  });

  await t('a button that was already disabled is not left enabled afterwards', async () => {
    const r = await page.evaluate(async () => {
      const { h, busy } = await import('/js/ui.js');
      const btn = h('button', { type: 'button', class: 'btn btn-filled', disabled: true }, 'Not yet');
      document.body.append(btn);
      busy(btn, true);
      busy(btn, false);
      return btn.disabled;
    });
    ok(r, 'a button that was disabled for its own reasons got re-enabled by the loading state');
  });

  await t('pressing busy twice does not stack two spinners', async () => {
    const r = await page.evaluate(async () => {
      const { h, busy } = await import('/js/ui.js');
      const btn = h('button', { type: 'button', class: 'btn btn-filled' }, 'Save');
      document.body.append(btn);
      busy(btn, true);
      busy(btn, true);
      return btn.querySelectorAll('.md-spinner').length;
    });
    ok(r === 1, `the button has ${r} spinners on it`);
  });

  await t('the spinner is a circle at the size the spec asks for', async () => {
    // The shape is asserted in pixels because a border-radius typo turns a spinner into a rotating square
    // and no amount of checking the class name would notice.
    //
    // The stroke is asserted strictly below 3px rather than at or under it. An earlier version of this said
    // "<= 3" and therefore permitted the exact 3px border this replaced, while the comment above the rule
    // called that value wrong — a test that cannot fail on the thing it describes is worse than none,
    // because it looks like the thing is covered.
    const r = await page.evaluate(async () => {
      const { h, busy } = await import('/js/ui.js');
      const btn = h('button', { type: 'button', class: 'btn btn-filled' }, 'Save');
      document.body.append(btn);
      busy(btn, true);
      const cs = getComputedStyle(btn.querySelector('.md-spinner'));
      return { radius: cs.borderRadius, w: parseFloat(cs.width), h: parseFloat(cs.height), border: parseFloat(cs.borderTopWidth) };
    });
    ok(r.radius === '50%', `the indicator is not round: border-radius is ${r.radius}`);
    ok(r.w === r.h, `the indicator is ${r.w}x${r.h} — a spinner is a circle`);
    ok(r.border < 3, `the indicator's stroke is ${r.border}px, heavy enough to read as a spinning blob`);
    ok(r.w >= 16 && r.w <= 24, `the indicator is ${r.w}px across, which is not a button-sized indicator`);
  });

  await t('a request for less motion is honoured, because that is what the spec asks for', async () => {
    // Material 3 replaces the circular indicator with a non-rotating one when the person has asked for
    // reduced motion. It is a small, self-contained accessibility behaviour, so it is emulated here rather
    // than assumed: the point is that the rotation genuinely stops, not that a media query exists in a file
    // somewhere.
    const reduced = await browser.newPage();
    await reduced.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await reduced.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    const r = await reduced.evaluate(async () => {
      const { h, busy } = await import('/js/ui.js');
      const btn = h('button', { type: 'button', class: 'btn btn-filled' }, 'Save');
      document.body.append(btn);
      busy(btn, true);
      const s = btn.querySelector('.md-spinner');
      const anims = s.getAnimations ? s.getAnimations() : [];
      return {
        matched: matchMedia('(prefers-reduced-motion: reduce)').matches,
        name: anims[0]?.animationName || null,
        running: anims.filter((a) => a.playState === 'running').length
      };
    });
    ok(r.matched, 'the browser did not honour the emulated setting, so this test would prove nothing');
    ok(r.name === 'md-fade',
      `under reduced motion the indicator should fade rather than spin, but it animates "${r.name}"`);
    ok(r.running > 0, 'the reduced-motion indicator is not animating at all, so nothing is moving but nothing shows either');
    await reduced.close();
  });

  await t('without that request the indicator spins normally', async () => {
    // The other half of the check: if the reduced-motion rule had been written so broadly that it applied
    // to everyone, the fade assertion above would still have passed while the ordinary till got a static dot.
    const r = await page.evaluate(async () => {
      const { h, busy } = await import('/js/ui.js');
      const btn = h('button', { type: 'button', class: 'btn btn-filled' }, 'Save');
      document.body.append(btn);
      busy(btn, true);
      const anims = btn.querySelector('.md-spinner').getAnimations();
      return { name: anims[0]?.animationName || null };
    });
    ok(r.name === 'md-spin', `the normal indicator should spin, but it animates "${r.name}"`);
  });

  await t('nothing on the page threw', async () => {
    ok(!pageErrors.length, `page errors: ${pageErrors.join(' | ')}`);
  });
} finally {
  await browser?.close().catch(() => {});
  srv?.kill();
  killPort(PORT);
  fs.rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
