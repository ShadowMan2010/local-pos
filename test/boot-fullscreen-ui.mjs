/* The boot screen and the full screen button, in a real browser.

   Both are things that only exist in the first seconds of a page's life, so both are exactly the kind of
   thing that is never looked at once it works. The boot screen in particular is the first thing a shop
   sees every morning and the last thing anybody thinks to test.

   The failure this file is written against is a splash that never goes away. There is no timeout on the
   till's API requests, so on a shop's flaky connection the request that reveals the dashboard can sit open
   for minutes — and a splash with no deadline of its own means the till shows a logo instead of a till. */
import { loadPuppeteer, launchBrowser, killPort } from './browser.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const puppeteer = await loadPuppeteer();

const PORT = 3198;
const DIR = '/tmp/opencode/fbootui';
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
  body: JSON.stringify({ storeName: 'Boot Test', upiVpa: '', pin: PIN })
});

/** The worker's own cache name, read from its source rather than repeated in the test.
 *
 *  Hardcoding it here meant this file had to be edited every time the shell changed, and it silently went
 *  stale once already: it opened a cache that no longer existed, so every "is it in the cache?" check
 *  passed against an empty store and proved nothing.
 */
const currentCacheName = async () => {
  const src = await (await fetch(`${BASE}/sw.js`)).text();
  const m = src.match(/VERSION\s*=\s*'([^']+)'/);
  if (!m) throw new Error('the worker has no VERSION, so there is no cache name to look for');
  return m[1];
};

let browser;
try {
  browser = await launchBrowser(puppeteer);

  await t('the splash is in the HTML, so it covers the page before any script runs', async () => {
    // Not built by JavaScript. A splash created by script arrives after the blank white page it was
    // supposed to cover, which is the whole problem it was added to solve.
    const html = await (await fetch(`${BASE}/`)).text();
    ok(html.includes('id="boot"'), 'there is no boot element in the served HTML');
    const bodyAt = html.indexOf('<div id="app"');
    const bootAt = html.indexOf('id="boot"');
    ok(bootAt < bodyAt, 'the splash comes after the app in the document, so it would not cover it');
  });

  await t('the splash shows the logo, the app name, and who built it', async () => {
    const page = await browser.newPage();
    // Hold the splash on screen by asking for it to never be dismissed, so it can be measured.
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      // Hang the config request the way a half-open connection would.
      if (r.url().endsWith('/api/config')) return;
      r.continue();
    });
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#boot', { timeout: 15000 });
    await sleep(400);

    const boot = await page.evaluate(() => {
      const el = document.getElementById('boot');
      const r = el.getBoundingClientRect();
      return {
        covers: r.width >= innerWidth && r.height >= innerHeight,
        onTop: getComputedStyle(el).zIndex,
        // Highest number anywhere in the document, so "on top" is measured against the real competition.
        maxZ: Math.max(...[...document.querySelectorAll('*')].map((n) => Number(getComputedStyle(n).zIndex) || 0)),
        name: el.querySelector('.boot-name')?.textContent.trim(),
        nameFont: getComputedStyle(el.querySelector('.boot-name')).fontSize,
        by: el.querySelector('.boot-by')?.textContent.replace(/\s+/g, ' ').trim(),
        logoOk: (() => { const i = el.querySelector('.boot-logo'); return i && i.complete && i.naturalWidth > 0; })(),
        eduOk: (() => { const i = el.querySelector('.boot-edupulse'); return i && i.complete && i.naturalWidth > 0; })(),
        eduAlt: el.querySelector('.boot-edupulse')?.getAttribute('alt'),
        eduH: el.querySelector('.boot-edupulse')?.getBoundingClientRect().height
      };
    });
    ok(boot.covers, 'the splash does not cover the whole screen');
    ok(Number(boot.onTop) >= boot.maxZ, `the splash is at z-index ${boot.onTop} but something else is at ${boot.maxZ}`);
    ok(boot.logoOk, 'the shop logo on the splash never loaded');
    ok(boot.name === 'LOCAL POS', `the splash says "${boot.name}" under the logo`);
    ok(boot.by.startsWith('Built for Bharat by'), `the credit line reads "${boot.by}"`);
    // The EduPulse name has to be the logo, not typed text — and it still has to be readable aloud.
    ok(boot.eduAlt === 'EduPulse', `the EduPulse logo has alt="${boot.eduAlt}", so a screen reader reads nothing useful`);
    ok(boot.eduOk, 'the EduPulse logo never loaded');
    ok(boot.eduH > 20, `the EduPulse logo is ${boot.eduH}px tall, too small to read as a mark`);

    // The tagline is set in a serif. It has to actually be one, and it has to be local: the weighing
    // station launches with the shop's Wi-Fi down as often as not, so a webfont here would either arrive
    // late or not at all, and the line that says who built the till is the wrong one to show late.
    const tag = await page.evaluate(() => {
      const el = document.querySelector('.boot-tagline');
      const cs = getComputedStyle(el);
      return { text: el.textContent.trim(), family: cs.fontFamily, size: cs.fontSize };
    });
    ok(tag.text === 'Built for Bharat by', `the tagline reads "${tag.text}"`);
    ok(!/Roboto|Inter|sans-serif/.test(tag.family),
      `the tagline is still set in the app's sans (${tag.family}), so it reads as another label`);
    ok(/serif/i.test(tag.family), `the tagline family is "${tag.family}", which has no serif in its stack`);

    // The stack has to lead with faces that actually carry serif contrast, or it lands on Georgia and
    // reads as the serif you get when nobody chose a serif. And it must not lead with a font nothing
    // loads, which is how 'Instrument Serif' sat first here for a while while every device fell through it.
    const first = tag.family.split(',')[0].replace(/["']/g, '').trim();
    ok(!/Instrument Serif/i.test(first),
      `the stack leads with "${first}", which the project never loads, so every device silently falls through`);

    /* It has to actually load the face, which is the difference between a premium typeface and the name of
       one. A stack that only *names* premium faces renders as Georgia on every device that does not
       happen to have them installed, which is the failure this replaced twice already. Measured with
       document.fonts, and asserted against the local files rather than a CDN, so the splash is still right
       with no network. */
    const font = await page.evaluate(async () => {
      await document.fonts.ready;
      const loaded = [...document.fonts].map((f) => `${f.family}|${f.weight}|${f.status}`);
      const t = document.querySelector('.boot-tagline');
      // What the glyphs actually measure is the real proof the face is in use, not a stack declaration.
      const width = (family) => {
        const c = document.createElement('canvas').getContext('2d');
        c.font = `100px ${family}`;
        return c.measureText('Built for Bharat by').width;
      };
      const cs = getComputedStyle(t).fontFamily;
      return {
        loaded,
        used: document.fonts.check(`18px ${cs.split(',')[0].replace(/["']/g, '')}`),
        distinct: Math.abs(width(cs) - width('Georgia')) > 0.5,
        size: getComputedStyle(t).fontSize
      };
    });
    ok(font.loaded.some((f) => /^Bodoni Moda\|/.test(f) && /loaded/.test(f)),
      `the self-hosted face never loaded (fonts: ${font.loaded.join(', ') || 'none declared'})`);
    ok(font.used, 'the browser reports the face is unavailable, so this is still rendering in a fallback');
    ok(font.distinct, 'the tagline measures identically to Georgia, so the premium face is not actually in use');
    const contrastFaces = /Bodoni|Didot|Hoefler|Baskerville|Playfair|Garamond|Old Standard|Iowan/i;
    ok(contrastFaces.test(tag.family),
      `no high-contrast face in the stack (${tag.family}), so it will always resolve to Georgia or Times`);
    ok(/serif\s*$/.test(tag.family.trim()),
      'the stack does not end in the generic `serif`, so an unusual system could fall back to the sans');

    // Which of the named faces exist on the machine actually running this. Not a failure either way: the
    // whole point of the stack is that it degrades. What matters is that *some* serif resolves, so the line
    // never falls back into the app's sans on whatever hardware the till happens to be.
    const faces = await page.evaluate((stack) => {
      const sample = (family) => {
        const c = document.createElement('canvas').getContext('2d');
        c.font = `100px ${family}`;
        return c.measureText('Built for Bharat by').width;
      };
      const base = sample('monospace');
      const listed = stack.split(',').map((f) => f.replace(/["']/g, '').trim());
      const installed = listed.filter((f) => f !== 'serif' && Math.abs(sample(`"${f}", monospace`) - base) > 0.5);
      const sans = sample('Roboto, sans-serif');
      return {
        listed: listed.length, installed,
        resolvesToSerif: Math.abs(sample(getComputedStyle(document.querySelector('.boot-tagline')).fontFamily) - sans) > 0.5
      };
    }, tag.family);
    ok(faces.installed.length > 0 || /serif$/.test(tag.family.trim()),
      'not one face in the stack exists, and the generic fallback is missing');
    ok(faces.resolvesToSerif, 'the tagline measures identical to the app sans, so it is not rendering as a serif at all');
    ok(parseFloat(tag.size) >= 14, `the tagline is ${tag.size}, too small for a serif to read`);
    await page.close();
  });

  await t('the splash has its own deadline, so a hung request cannot strand the till', async () => {
    // The request the splash is waiting on has no timeout on it. Without a deadline of its own, this page
    // would show a logo for as long as the network felt like it.
    const html = await (await fetch(`${BASE}/`)).text();
    const hasDeadline = /setTimeout\(function\s*\(\)\s*\{[^}]*\.remove\(\)[^}]*\},\s*\d{3,}\)/.test(html);
    ok(hasDeadline, 'there is no self-removing deadline in the splash markup');
  });

  await t('the splash goes away once the till is up', async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#boot', { timeout: 15000 });
    await page.waitForFunction(() => !document.getElementById('boot'), { timeout: 15000 });
    const busy = await page.$eval('#app', (el) => el.getAttribute('aria-busy'));
    ok(busy === null, `#app is still marked aria-busy="${busy}" after the splash went`);
    await page.close();
  });

  await t('the till is genuinely usable after the splash, not just uncovered', async () => {
    // Removing an overlay is not the same as having a working app behind it, and this is the check that
    // tells the two apart.
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.getElementById('boot'), { timeout: 15000 });
    await page.waitForSelector('[data-pin-gate]', { timeout: 15000 });
    await page.type('[data-pin-gate] input', PIN);
    await page.click('[data-pin-gate] button[type=submit]');
    await page.waitForFunction(() => !document.querySelector('[data-pin-gate]'), { timeout: 15000 });
    ok(await page.$('header, .app-bar, .dashboard'), 'nothing rendered behind the splash');
    ok(!errs.length, `page errors: ${errs.join(' | ')}`);
    await page.close();
  });

  await t('the splash leaves nothing behind that could swallow the first tap', async () => {
    // The failure mode of a splash that fades out: it is still in the DOM with pointer-events disabled, or
    // worse still enabled, and the first click on the till goes to a logo.
    const page = await browser.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#boot', { timeout: 15000 });
    await page.waitForFunction(() => !document.getElementById('boot'), { timeout: 15000 });
    await sleep(200);
    const left = await page.evaluate(() => document.querySelectorAll('#boot').length);
    ok(left === 0, 'the splash element is still in the document after it faded');
    await page.close();
  });

  await t('the weighing station can go full screen and come back', async () => {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(`${BASE}/weigh.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-weigh-fullscreen]', { timeout: 15000 });

    const before = await page.evaluate(() => ({
      label: document.querySelector('[data-weigh-fullscreen]').getAttribute('aria-label')
    }));
    await page.click('[data-weigh-fullscreen]');
    await page.waitForFunction(() => !!document.fullscreenElement, { timeout: 8000 });

    const during = await page.evaluate(() => {
      const btn = document.querySelector('[data-weigh-fullscreen]');
      // The whole document goes full screen rather than an inner panel: if the app bar went with it, the
      // button that undoes the full screen would go too, and a tablet stuck in full screen with no way
      // out is a tablet somebody has to power-cycle.
      const barVisible = !!document.querySelector('.app-bar')?.getBoundingClientRect().width;
      return {
        onDocument: document.fullscreenElement === document.documentElement,
        barVisible,
        label: btn.getAttribute('aria-label'),
        stillPressable: !btn.disabled
      };
    });
    ok(during.onDocument, 'full screen was applied to an inner element instead of the page');
    ok(during.barVisible, 'the app bar disappeared in full screen, so there is no way back out');
    ok(/leave/i.test(during.label), `the button still offers "${during.label}" while full screen`);
    ok(during.stillPressable, 'the exit button is disabled, so the till cannot be got out of full screen');
    ok(/full screen/i.test(before.label), `the button does not say what it does before being pressed: "${before.label}"`);

    await page.click('[data-weigh-fullscreen]');
    await page.waitForFunction(() => !document.fullscreenElement, { timeout: 8000 });
    const back = await page.$eval('[data-weigh-fullscreen]', (b) => b.getAttribute('aria-label'));
    ok(/full screen/i.test(back), `after leaving, the button says "${back}"`);
    ok(!errs.length, `page errors: ${errs.join(' | ')}`);
    await page.close();
  });

  await t('the installed app asks for full screen', async () => {
    const m = JSON.parse(await (await fetch(`${BASE}/manifest.webmanifest`)).text());
    ok(m.display === 'fullscreen', `the manifest asks for "${m.display}"`);
    ok(Array.isArray(m.display_override) && m.display_override.includes('fullscreen'),
      'display_override is missing, so a browser that understands it may fall back to standalone');
    ok(m.orientation === 'landscape', `the manifest locks orientation to "${m.orientation}"`);
  });

  await t('the installed station carries the same splash, with its images in the offline shell', async () => {
    // The station is launched from the home screen with the shop's Wi-Fi down as often as not. If the
    // splash's images are not in the worker's shell they are the two things a customer sees broken.
    const html = await (await fetch(`${BASE}/weigh.html`)).text();
    ok(html.includes('id="boot"'), 'the weighing station has no boot screen');
    ok(html.includes('Built for Bharat by'), 'and it does not carry the credit line');

    const sw = await (await fetch(`${BASE}/sw.js`)).text();
    ok(sw.includes('/logo.png'), 'the shop logo is not in the worker shell, so it cannot load offline');
    ok(sw.includes('/edupulse-logo.png'), 'the EduPulse mark is not in the worker shell');
    // The splash's typeface belongs here for the same reason. Self-hosted so the station is not waiting on
    // a CDN, but "self-hosted" only helps if the file is actually cached — a font served from this origin
    // and absent from the shell renders as Georgia the moment the Wi-Fi drops, which is the whole reason
    // the face was self-hosted rather than fetched at splash time.
    ok(sw.includes('/fonts/bodoni-moda-latin.woff2'),
      'the splash typeface is not in the worker shell, so the tagline falls back to Georgia offline');
    // The cache name has to change when the shell changes, or an installed station keeps serving the old
    // shell — including the version of the splash without these images — until the tablet is closed.
    ok(/VERSION\s*=\s*'weigh-v\d+'/.test(sw), 'the worker has no versioned cache name, so a stale shell is never replaced');
  });

  await t('the station boots with no network at all', async () => {
    // The condition the whole shell exists for. Checked on a settled cache, and on the splash images being
    // genuinely decodable rather than merely present in the cache.
    const page = await browser.newPage();
    await page.goto(`${BASE}/weigh.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 15000 });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await sleep(1500);

    // Both images decoded out of the cache before the network went, which is the assertion that would fail
    // if they were in the shell list but had failed to cache. The cache name comes from outside the page:
    // reading it in here would mean re-implementing the regex on the other side of the boundary.
    const decoded = await page.evaluate(async (cacheName) => {
      const c = await caches.open(cacheName);
      const keys = (await c.keys()).map((r) => new URL(r.url).pathname);
      const load = (src) => new Promise((res) => {
        const i = new Image();
        i.onload = () => res({ src, w: i.naturalWidth });
        i.onerror = () => res({ src, w: 0 });
        i.src = src;
      });
      return {
        keys,
        images: await Promise.all([load('/logo.png'), load('/edupulse-logo.png')]),
        font: await (async () => {
          // Read out of the cache rather than through document.fonts. The weighing station boots on its own
          // here, so the splash is already gone by this point and no glyph is asking for the face — its
          // status is `unloaded` because nothing wanted it, not because it is missing. What has to be proven
          // is that the bytes survive offline, so the file itself is fetched from the cache and checked for
          // the woff2 signature.
          const res = await c.match('/fonts/bodoni-moda-latin.woff2');
          if (!res) return { cached: false };
          // `cache.match()` resolves to the stored Response itself, not to a wrapper with a `.response` on
          // it. Read the body off it directly.
          const bytes = new Uint8Array(await res.arrayBuffer());
          return {
            cached: true,
            magic: String.fromCharCode(...bytes.slice(0, 4)),
            bytes: bytes.length
          };
        })()
      };
    }, await currentCacheName());
    ok(decoded.keys.includes('/logo.png'), 'the shop logo is not in the cache');
    ok(decoded.keys.includes('/edupulse-logo.png'), 'the EduPulse mark is not in the cache');
    ok(decoded.images.every((i) => i.w > 0),
      'an image in the cache could not be decoded: ' + JSON.stringify(decoded.images));
    ok(decoded.keys.includes('/fonts/bodoni-moda-latin.woff2'), 'the splash typeface is not in the cache');
    ok(decoded.font.cached, 'the typeface could not be read back out of the cache');
    // "wOF2" is the woff2 signature: capital w, capital O, capital F, digit 2. Read as characters rather
    // than as the decimal byte values, so the failure message names what the file actually says instead of
    // making whoever reads it decode four numbers.
    ok(decoded.font.magic === 'wOF2',
      `the cached typeface is not woff2 (it begins "${decoded.font.magic}"), so it cannot be a font`);
    // A splash must not ship a font it does not need. 46KB for seven words is only worth carrying if it is
    // the difference between the intended face and a fallback, which is what the assertion above checks.
    ok(decoded.font.bytes > 2000 && decoded.font.bytes < 120 * 1024,
      `the typeface is ${decoded.font.bytes} bytes, which is either empty or too heavy for a splash`);

    await page.setOfflineMode(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    // The station has to come up on its own, with no splash left on top of it.
    await page.waitForSelector('.app-bar', { timeout: 15000 });
    await sleep(600);
    const up = await page.evaluate(() => ({
      splash: !!document.getElementById('boot'),
      bar: !!document.querySelector('.app-bar'),
      busy: document.getElementById('app')?.getAttribute('aria-busy')
    }));
    ok(up.bar, 'the station did not come up with the network down');
    ok(!up.splash, 'the splash was still covering the station once it had loaded');
    ok(up.busy === null, '#app is still marked aria-busy after loading offline');
    await page.setOfflineMode(false);
    await page.close();
  });

  await t('both logos shine while the splash is up, and stay still when asked to', async () => {
    // The shine is the difference between a splash and a frozen screen. It is also the first thing to be
    // quietly dropped by a later CSS edit, since nothing about the app breaks when it disappears.
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (r) => { if (r.url().endsWith('/api/config')) return; r.continue(); });
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#boot', { timeout: 15000 });

    const read = () => page.evaluate(() => {
      const after = (sel) => getComputedStyle(document.querySelector(sel), '::after');
      return {
        logo: after('.boot-logo-shine').animationName,
        edu: after('.boot-edupulse-shine').animationName,
        logoDur: after('.boot-logo-shine').animationDuration,
        // The sweep has to be masked to the artwork, or it is a rectangle of glare across the plate.
        logoMask: after('.boot-logo-shine').webkitMaskImage,
        eduMask: after('.boot-edupulse-shine').webkitMaskImage,
        pos: after('.boot-logo-shine').backgroundPosition
      };
    });

    const a = await read();
    await sleep(450);
    const b = await read();
    ok(a.logo === 'boot-sheen', `the shop logo does not shine: "${a.logo}"`);
    ok(a.edu === 'boot-sheen', `the EduPulse mark does not shine: "${a.edu}"`);
    ok(parseFloat(a.logoDur) >= 1.5, `the shine runs in ${a.logoDur}, too fast to read as a sweep`);
    ok(a.logoMask.includes('logo.png'), 'the shine is not masked to the shop logo, so it glares across the plate');
    ok(a.eduMask.includes('edupulse-logo'), 'the shine is not masked to the EduPulse mark');
    ok(a.pos !== b.pos, 'the shine is named but not moving: ' + a.pos + ' == ' + b.pos);
    await page.close();

    // And a visitor who has asked for less motion gets a still splash rather than an override.
    const calm = await browser.newPage();
    await calm.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await calm.setRequestInterception(true);
    calm.on('request', (r) => { if (r.url().endsWith('/api/config')) return; r.continue(); });
    await calm.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await calm.waitForSelector('#boot', { timeout: 15000 });
    const c = await calm.evaluate(() => {
      const after = (sel) => getComputedStyle(document.querySelector(sel), '::after');
      return { anim: after('.boot-logo-shine').animationName, bg: after('.boot-logo-shine').backgroundImage };
    });
    ok(c.anim === 'none', `reduced motion still animates: "${c.anim}"`);
    ok(c.bg === 'none', 'reduced motion still draws the sweep');
    await calm.close();
  });

  await t('the logos are legible in the dark theme, not just the light one', async () => {
    // Caught by measurement, not by eye. The shop logo is a white-background PNG and the EduPulse strip is
    // dark ink: on the dark splash one shows as a white rectangle and the other disappears. Both are fixed
    // by a light plate, and this checks the plate is actually painted white and actually inside a dark splash.
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.setRequestInterception(true);
    page.on('request', (r) => { if (r.url().endsWith('/api/config')) return; r.continue(); });
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#boot', { timeout: 15000 });
    await sleep(450);

    const look = await page.evaluate(() => {
      const lum = (c) => {
        const m = c.match(/\d+/g).map(Number);
        return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
      };
      return {
        theme: document.documentElement.dataset.theme,
        bootLum: lum(getComputedStyle(document.getElementById('boot')).backgroundColor),
        plateBg: getComputedStyle(document.querySelector('.boot-plate')).backgroundColor
      };
    });
    ok(look.theme === 'dark', 'the page did not go dark: ' + look.theme);
    ok(look.bootLum < 60, `the splash itself is not dark (luminance ${Math.round(look.bootLum)}), so this is not the dark-theme case`);
    // The whole point: a light plate in the middle of a dark splash, or the artwork has nothing to sit on.
    ok(look.plateBg === 'rgb(255, 255, 255)', `the logo plate is ${look.plateBg}, so a white-background logo disappears into the splash`);
    await page.close();
  });

  await t('the splash renders both marks with visible artwork, light and dark', async () => {
    // The one that catches a logo 404-ing, a transparent mark on a transparent plate, or an artwork that
    // has been flattened to a flat rectangle. Measured from the actual painted pixels.
    for (const scheme of ['light', 'dark']) {
      const page = await browser.newPage();
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      await page.setRequestInterception(true);
      page.on('request', (r) => { if (r.url().endsWith('/api/config')) return; r.continue(); });
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#boot', { timeout: 15000 });
      await sleep(450);

      const box = await page.evaluate(() => {
        const r = document.querySelector('.boot-plate').getBoundingClientRect();
        return { x: Math.max(0, Math.floor(r.x)), y: Math.max(0, Math.floor(r.y)), w: Math.ceil(r.width), h: Math.ceil(r.height) };
      });
      const png = await page.screenshot({ encoding: 'binary' });
      const { analysePlate } = await import('./png-probe.mjs');
      const res = await analysePlate(png, box);
      ok(res.inkFraction > 0.02,
        `${scheme}: the plate looks blank (${(res.inkFraction * 100).toFixed(1)}% ink), so a logo is missing or blank`);
      ok(res.darkest < 140,
        `${scheme}: nothing dark enough to read on the plate (darkest luminance ${Math.round(res.darkest)}), so the mark has no contrast`);
      await page.close();
    }
  });

  await t('the EduPulse logo is a real PNG, not a broken reference or a stray SVG', async () => {
    // Was checking for the SVG placeholder this replaced, so it passed on a deleted file and failed on the
    // real asset. Checked by what the file actually is: served, an image, and carrying visible artwork.
    const r = await fetch(`${BASE}/edupulse-logo.png`);
    ok(r.ok, `the EduPulse logo returned ${r.status}`);
    ok((r.headers.get('content-type') || '').startsWith('image/png'),
      `served as ${r.headers.get('content-type')}, not a PNG`);
    const buf = Buffer.from(await r.arrayBuffer());
    ok(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      'the file does not begin with a PNG signature');
    // The mark is a dark wordmark on transparency, so an empty or fully transparent file is the failure
    // this catches: present in the cache, correct MIME type, nothing to draw.
    const { analysePlate } = await import('./png-probe.mjs');
    const { data, info } = await (await import('sharp')).default(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let opaque = 0, darkest = 255;
    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i + 3] < 40) continue;
      opaque++;
      const L = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (L < darkest) darkest = L;
    }
    ok(opaque > info.width * info.height * 0.02,
      `only ${opaque} opaque pixels of ${info.width * info.height}, so the mark is blank`);
    ok(darkest < 140, `the mark's darkest pixel is ${Math.round(darkest)}, so it is invisible on the white plate`);
    ok(Math.abs(info.width / info.height - 6.19) < 0.6,
      `the mark is ${info.width}x${info.height}, ratio ${(info.width / info.height).toFixed(2)}, which is not the 6:1 wordmark`);
    ok(buf.length < 150 * 1024, `${(buf.length / 1024).toFixed(0)}KB, which is too heavy for a splash on a slow tablet`);
  });
} finally {
  await browser?.close().catch(() => {});
  srv?.kill();
  killPort(PORT);
  fs.rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);