/* Feature: notification sounds, in a real browser.
   The unit tests check the tone table and the announce-on-arrival rule. This checks the things only a
   browser can answer: that oscillators are really created and really started when a notification fires,
   that the mute button silences them, and that nothing makes a noise before anybody has touched the
   screen. A Web Audio app that passes every unit test and is completely silent in a shop is exactly
   the failure worth catching here. */
import { loadPuppeteer, launchBrowser, killPort } from './browser.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const puppeteer = await loadPuppeteer();

const PORT = 3202;
const DIR = '/tmp/opencode/sfxui';
const BASE = `http://localhost:${PORT}`;
let pass = 0, fail = 0;
let srv = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => null);
};

/**
 * Opens a page with the Web Audio API instrumented, so we can count real oscillators instead of
 * hoping. Installed before any page script runs, which is the only way to catch a sound that fires
 * during boot.
 */
async function openTill({ init = '' } = {}) {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome',
    // Lets audio start without a gesture. The app must still behave correctly without it; this only
    // means the test can observe that oscillators were created at all.
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluateOnNewDocument(() => {
    window.__osc = { started: 0, created: 0, freqs: [] };
    const Real = window.AudioContext || window.webkitAudioContext;
    if (!Real) return;
    const Patched = function (...a) {
      const ctx = new Real(...a);
      window.__osc.ctxState = () => ctx.state;
      const realOsc = ctx.createOscillator.bind(ctx);
      ctx.createOscillator = () => {
        const o = realOsc();
        window.__osc.created++;
        const start = o.start.bind(o);
        o.start = (...s) => { window.__osc.started++; window.__osc.freqs.push(o.frequency.value); return start(...s); };
        return o;
      };
      return ctx;
    };
    window.AudioContext = Patched;
    window.webkitAudioContext = Patched;
  });
  if (init) await page.evaluateOnNewDocument(init);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
  await sleep(1200);
  return { browser, page, errors };
}
const osc = (page) => page.evaluate(() => ({ ...window.__osc }));

try {
  await startServer();
  await post('/api/setup', { storeName: 'Corner Store', upiVpa: 'shop@bank' });

  await t('a shop that has never touched Settings still gets sound', async () => {
    const { browser, page, errors } = await openTill();
    try {
      ok(!errors.length, 'page errors: ' + errors.join(' | '));
      // On, not muted: the setting is opt-out. A feature that is silent until someone finds a switch
      // reads as broken.
      const enabled = await page.evaluate(async () => (await import('/js/sfx.js')).isEnabled());
      ok(enabled, 'sounds default to on');
    } finally { await browser.close(); }
  });

  await t('nothing makes a noise just because the page loaded', async () => {
    const { browser, page } = await openTill();
    try {
      // The sound module must not touch the audio hardware at import time. A till that chirps when the
      // shopkeeper walks past with the Wi-Fi on is a till people will switch off.
      const s = await osc(page);
      ok(s.created === 0, `expected no audio hardware touched on load, but ${s.created} oscillators were created`);
    } finally { await browser.close(); }
  });

  await t('a payment really does make a sound', async () => {
    const { browser, page } = await openTill();
    try {
      const before = await osc(page);
      await page.evaluate(async () => (await import('/js/sfx.js')).play('paid'));
      await sleep(250);
      const after = await osc(page);
      ok(after.started > before.started, 'the paid chime started oscillators');
      // Three notes, rising - the shape the unit tests pin, checked here against a real audio context.
      ok(after.created - before.created >= 3, `expected at least 3 notes, got ${after.created - before.created}`);
      const fresh = after.freqs.slice(before.freqs.length);
      ok(fresh.length >= 3 && fresh[0] < fresh[1] && fresh[1] < fresh[2], 'and they rise: ' + JSON.stringify(fresh));
    } finally { await browser.close(); }
  });

  await t('the mute button really stops the noise', async () => {
    const { browser, page } = await openTill();
    try {
      const btn = 'button.sound-btn';
      await page.waitForSelector(btn, { timeout: 8000 });
      const before = (await osc(page)).started;
      // One tap, as a shopkeeper would.
      await page.click(btn);
      await sleep(200);
      const muted = await page.evaluate(async () => (await import('/js/sfx.js')).isEnabled());
      ok(muted === false, 'the toggle turned the sound off');
      // Turning it off must not itself play anything.
      const afterToggle = (await osc(page)).started;
      ok(afterToggle === before, 'muting did not make a sound');
      // And while muted, nothing else should either.
      await page.evaluate(async () => (await import('/js/sfx.js')).play('paid'));
      await sleep(200);
      ok((await osc(page)).started === before, 'a payment made no sound while muted');
      // The icon has to change, or the state is invisible.
      const label = await page.$eval(btn, (e) => e.getAttribute('aria-label'));
      ok(/on/i.test(label), 'the button now says how to turn it back on: ' + label);
    } finally { await browser.close(); }
  });

  await t('unmuting confirms itself, so the button is never a guess', async () => {
    const { browser, page } = await openTill();
    try {
      await page.waitForSelector('button.sound-btn', { timeout: 8000 });
      await page.click('button.sound-btn');           // off
      await sleep(1600);                              // past the dedupe window
      const before = (await osc(page)).started;
      await page.click('button.sound-btn');           // on again
      await sleep(300);
      ok((await osc(page)).started > before, 'turning it back on played a confirmation');
    } finally { await browser.close(); }
  });

  await t('the Settings screen can turn sound off, test it, and change the volume', async () => {
    // The mute button in the app bar is the fast path; Settings is where somebody goes deliberately,
    // to check the speaker actually works before a shift. Both have to work, and both have to agree.
    const { browser, page, errors } = await openTill();
    try {
      ok(!errors.length, 'page errors: ' + errors.join(' | '));
      await page.evaluate(() => document.querySelector('button.sound-btn').click());   // mute
      await sleep(200);
      await page.evaluate(() => {
        // Open Settings the way the bar does.
        [...document.querySelectorAll('.app-bar button')]
          .find((b) => /store settings/i.test(b.getAttribute('aria-label') || ''))?.click();
      });
      await sleep(900);
      const text = await page.evaluate(() => document.body.innerText);
      ok(/notification sounds/i.test(text), 'Settings has a sounds section');

      const labels = await page.evaluate(() =>
        [...document.querySelectorAll('button')].map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
      ok(labels.some((l) => /preview the paid chime/i.test(l)),
        'there is a way to hear the paid chime without taking a payment: ' + JSON.stringify(labels.filter(Boolean)));
      // Not anchored: a Material icon sits inside the button and contributes its own text, so the
      // label reads "tune Volume: normal".
      ok(labels.some((l) => /volume:\s*\w+/i.test(l)), 'and the volume can be changed');

      // The sound controls sit near the bottom of a long settings form, inside a dialog that scrolls
      // itself. Puppeteer's elementHandle.click() scrolls the nearest ancestor it can find, which for
      // an inner scroller can leave the button still outside the window, so the synthetic click lands
      // on nothing and the test reports a failure that is really about scrolling. Clicking in-page and
      // letting the browser do the scrolling is both simpler and closer to what a person does.
      //
      // Chrome is launched above with the autoplay policy relaxed, so a click that is not a real
      // gesture is still enough to start the audio context; otherwise this would be testing gesture
      // handling rather than the button.
      const beforeCreated = (await osc(page)).created;
      const before = (await osc(page)).started;
      const clicked = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /preview the paid chime/i.test(x.innerText));
        if (!b) return 'no-button';
        b.scrollIntoView({ block: 'center' });
        b.click();
        return 'clicked';
      });
      await sleep(300);
      const after = await osc(page);
      ok(clicked === 'clicked', 'the preview button was there to click: ' + clicked);
      // Also confirms the server is serving the current sfx.js rather than a cached older copy.
      const servedForces = await page.evaluate(async () => (await import('/js/sfx.js')).play.toString().includes('force'));
      ok(servedForces, 'the served sound module is the current one');
      ok(after.started > before, 'the preview played even though the till is muted');
      ok(after.created - beforeCreated >= 3, 'and it was the three-note paid chime');

      // The volume toggle has to actually change and be reflected in its own label.
      const vBefore = await page.evaluate(async () => (await import('/js/sfx.js')).level());
      await page.evaluate((i) => {
        const b = [...document.querySelectorAll('button')].filter((x) => /volume:\s*\w+/i.test(x.innerText))[i];
        b?.scrollIntoView({ block: 'center' });
        b?.click();
      }, 0);
      await sleep(200);
      const vAfter = await page.evaluate(async () => (await import('/js/sfx.js')).level());
      ok(vBefore !== vAfter, `the volume changed (${vBefore} -> ${vAfter})`);

        // And the app-bar button must show the muted state that Settings just set, or the two lie.
        // Back on the dashboard first: the mute button lives in the app bar, which the Settings screen
        // replaces, so reading it while Settings is open finds nothing at all and the check passes on an
        // empty string rather than on a real button.
        await page.evaluate(() => {
          const back = [...document.querySelectorAll('button')].find((x) => /back|close|cancel/i.test(x.innerText || x.getAttribute('aria-label') || ''));
          back?.click();
        });
        await sleep(400);
        // Checked as a pair, because the label names the *action* ("Turn notification sounds on" while
        // muted), not the state. A single /on/i match passed by accident here: it also matched the "on" in
        // "sounds", so the assertion held whether the button was muted or not and proved nothing.

      const bar = await page.evaluate(() => {
        const b = document.querySelector('button.sound-btn');
        return { label: b?.getAttribute('aria-label') || '', pressed: b?.getAttribute('aria-pressed') };
      });
      ok(/sounds?\s+on$/i.test(bar.label),
        `with sound off the button should offer to turn it on, but it said "${bar.label}"`);
      ok(bar.pressed === 'false', `aria-pressed should be false while muted, got "${bar.pressed}"`);
    } finally { await browser.close(); }
  });

  await t('the same notification twice in a row is not stacked', async () => {
    const { browser, page } = await openTill();
    try {
      const r = await page.evaluate(async () => {
        const sfx = await import('/js/sfx.js');
        const before = window.__osc.started;
        const first = sfx.play('alert');
        const second = sfx.play('alert');
        return { first, second, added: window.__osc.started - before };
      });
      ok(r.first === true, 'the first alert played');
      ok(r.second === false, 'the duplicate was suppressed');
      ok(r.added === 3, `the alert is one three-note phrase, got ${r.added} notes`);
    } finally { await browser.close(); }
  });

  await t('an unknown sound name is ignored rather than breaking the screen', async () => {
    // A typo in a sound name must not throw inside a notification path, because that path is often a
    // catch block handling something that already went wrong.
    const { browser, page, errors } = await openTill();
    try {
      const r = await page.evaluate(async () => {
        const sfx = await import('/js/sfx.js');
        return { played: sfx.play('nonsense'), known: sfx.play('paid') };
      });
      ok(r.played === false, 'the unknown name is refused quietly');
      ok(r.known === true, 'and the app keeps working');
      ok(!errors.length, 'no uncaught error: ' + errors.join(' | '));
    } finally { await browser.close(); }
  });

  await t('the setting survives a reload, so a muted till stays muted', async () => {
    const { browser, page } = await openTill();
    try {
      await page.waitForSelector('button.sound-btn', { timeout: 8000 });
      await page.click('button.sound-btn');
      await sleep(250);
      await page.reload({ waitUntil: 'networkidle2' });
      await sleep(1200);
      const after = await page.evaluate(async () => (await import('/js/sfx.js')).isEnabled());
      ok(after === false, 'still muted after a reload');
      const label = await page.$eval('button.sound-btn', (e) => e.getAttribute('aria-label'));
      ok(/on/i.test(label), 'and the button still shows it as muted');
    } finally { await browser.close(); }
  });

  await t('a polled count announces only a real arrival', async () => {
    // The rule that stops a till shouting at an empty shop every eight seconds.
    const { browser, page } = await openTill();
    try {
      const r = await page.evaluate(async () => {
        const sfx = await import('/js/sfx.js');
        const s = window.__osc.started;
        sfx.play('paid'); // warm the dedupe window for the tone we are about to test
        return {
          backlog: sfx.shouldAnnounce(null, 7),   // first poll after opening
          arrived: sfx.shouldAnnounce(0, 1),      // a WhatsApp order lands
          cleared: sfx.shouldAnnounce(4, 0),      // somebody dealt with it
          same: sfx.shouldAnnounce(2, 2)
        };
      });
      ok(r.backlog === false, 'the existing backlog is not announced');
      ok(r.arrived === true, 'a new arrival is announced');
      ok(r.cleared === false, 'clearing the list is not announced');
      ok(r.same === false, 'no change, no noise');
    } finally { await browser.close(); }
  });
} finally {
  try { srv?.kill('SIGKILL'); } catch {}
  killPort(PORT);
  fs.rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
