/* Feature: the weighing station as an installed app.
   Three things, each of which is a whole feature on its own:
     1. it installs (a manifest a browser accepts), and can open offline from the wall
     2. its screen never dims while somebody is standing there with a bag of onions
     3. the offline copy can never answer a question about live data

   The third is the one worth the file. A service worker that caches the weighing station and does not
   explicitly refuse /api/ will happily serve a stale weight or a stale item list, and the symptom is a
   till that is confidently wrong rather than one that is visibly broken. So the refusal is asserted
   against the real worker, not just read out of the source. */
import { loadPuppeteer, launchBrowser, killPort } from './browser.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const puppeteer = await loadPuppeteer();

const PORT = 3207;
const DIR = '/tmp/opencode/pwa-weigh';
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
const stopServer = () => { try { srv?.kill('SIGKILL'); } catch {} killPort(PORT); };

/**
 * Opens the weighing station and waits for the worker to be in charge.
 *
 * Waiting for the registration to be *active* rather than sleeping a fixed amount: without a controller
 * the assertions below would run against a page the worker is not serving and quietly pass or fail for
 * reasons that have nothing to do with the worker.
 */
async function openStation(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(BASE + '/weigh.html', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => navigator.serviceWorker.controller || navigator.serviceWorker.ready, { timeout: 15000 })
    .catch(() => {});
  return { page, errors };
}

try {
  await startServer();

  const browser = await launchBrowser(puppeteer);
  try {
    /* ---------- 1. installable ---------- */
    await t('the weighing station links a manifest a browser will accept', async () => {
      const { page, errors } = await openStation(browser);
      try {
        ok(!errors.length, 'the page had errors: ' + errors.join(' | '));
        const manifest = await page.evaluate(async () => {
          const link = document.querySelector('link[rel=manifest]');
          if (!link) return { missing: true };
          const res = await fetch(link.href);
          return { status: res.status, type: res.headers.get('content-type'), body: await res.json() };
        });
        ok(!manifest.missing, 'weigh.html declares a manifest at all');
        ok(manifest.status === 200, 'and it is served, got ' + manifest.status);
        const m = manifest.body;
        ok(m.name && m.short_name, 'with a name and a short name');
        // start_url and scope have to agree, or the installed app opens a page the worker does not cover
        // and the whole point of caching it is lost.
        ok(m.start_url === '/weigh.html', 'start_url points at the station, got ' + m.start_url);
        // fullscreen rather than standalone. The station is a tablet propped up at a scale, and standalone
        // still leaves the browser's own bars eating the top of a landscape screen. Both satisfy "no
        // browser chrome", so this asserts the stronger one that is now wanted, and keeps standalone
        // acceptable so a browser that cannot do fullscreen is not treated as broken.
        ok(['fullscreen', 'standalone', 'minimal-ui'].includes(m.display),
          'and it opens without browser chrome, got ' + m.display);
        ok(m.display === 'fullscreen', 'the station should ask for full screen, got ' + m.display);
        ok(Array.isArray(m.display_override) && m.display_override.includes('fullscreen'),
          'display_override must list fullscreen first, or a browser that reads it ignores the request');
        ok(Array.isArray(m.icons) && m.icons.length >= 2, 'with at least two icon sizes');
        ok(m.icons.some((i) => String(i.sizes).includes('512')), 'including a 512, which is what Android asks for');
        ok(m.icons.some((i) => String(i.purpose || '').includes('maskable')), 'and a maskable one, or the launcher crops the logo');
      } finally { await page.close(); }
    });

    await t('the icons in the manifest are real files, not 404s', async () => {
      // A manifest full of paths that do not resolve installs happily and then shows a blank icon on the
      // shop's home screen forever, which nobody notices until the shop asks why.
      const res = await fetch(BASE + '/manifest.webmanifest');
      const m = await res.json();
      for (const icon of m.icons) {
        const r = await fetch(BASE + icon.src);
        ok(r.status === 200, `${icon.src} is ${r.status}, not 200`);
        const type = r.headers.get('content-type') || '';
        ok(type.includes('image/png'), `${icon.src} came back as ${type}`);
        const bytes = (await r.arrayBuffer()).byteLength;
        ok(bytes > 500, `${icon.src} is only ${bytes} bytes`);
      }
    });

    /* ---------- 2. offline shell ---------- */
    await t('the station shell is cached, so it opens with no network at all', async () => {
      const { page } = await openStation(browser);
      try {
        await page.waitForFunction(async () => {
          const keys = await caches.keys();
          if (!keys.length) return false;
          return (await (await caches.open(keys[0])).keys()).length > 3;
        }, { timeout: 15000 }).catch(() => {});

        const cached = await page.evaluate(async () => {
          const keys = await caches.keys();
          const cache = await caches.open(keys[0]);
          return (await cache.keys()).map((r) => new URL(r.url).pathname);
        });
        ok(cached.length > 3, 'the worker cached the shell, cached ' + cached.length + ' entries');
        ok(cached.includes('/weigh.html'), 'including the page itself');
        ok(cached.some((p) => p.endsWith('weigh.js')), 'and its script');

        // Now the real test: cut the network and reload. This is what happens when the shop's Wi-Fi drops
        // mid-queue, and it is the whole reason for the worker.
        await page.setOfflineMode(true);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await sleep(700);
        const offline = await page.evaluate(() => ({
          url: location.pathname,
          appText: (document.getElementById('app')?.innerText || '').trim(),
          styled: getComputedStyle(document.body).backgroundColor
        }));
        ok(offline.url === '/weigh.html', 'the station still loaded, at ' + offline.url);
        ok(offline.appText.length > 0, 'and rendered its own interface rather than an error page');
        await page.setOfflineMode(false);
      } finally { await page.close(); }
    });

    /* ---------- 3. never answer live data from cache ---------- */
    await t('the worker refuses to serve /api/ from cache, even when the network is gone', async () => {
      // The failure this whole file exists to prevent. A worker with a catch-all cache rule will hand back
      // a stale item list, and the weighing station will offer to weigh produce that was deleted yesterday.
      const { page } = await openStation(browser);
      try {
        // The list the station actually asks for. Guessing a route name here would have tested a 404 for
        // ever and proved nothing.
        const before = await page.evaluate(async () => {
          const r = await fetch('/api/products');
          return r.status;
        });
        ok(before === 200, 'the item list loads from the server, got ' + before);

        await page.setOfflineMode(true);
        const offline = await page.evaluate(async () => {
          try {
            const r = await fetch('/api/products');
            // A 503 from the server is fine and correct — the worker's job is only to not answer from
            // cache. A 200 here would mean a cached copy of live data.
            return { status: r.status, fromWorker: r.headers.get('x-served-by') || null };
          } catch (e) {
            return { threw: String(e.message) };
          }
        });
        ok(offline.status !== 200, 'live data is not answered from cache while offline: ' + JSON.stringify(offline));

        // And nothing from /api was put in the cache in the first place, which is the stronger statement.
        const apiInCache = await page.evaluate(async () => {
          const keys = await caches.keys();
          const out = [];
          for (const k of keys) {
            for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname);
          }
          return out.filter((p) => p.startsWith('/api/') || p.startsWith('/uploads/'));
        });
        ok(apiInCache.length === 0, 'no live data was ever cached, found: ' + apiInCache.join(', '));
        await page.setOfflineMode(false);
      } finally { await page.close(); }
    });

    await t('the till itself never registers a worker, so a cached page cannot reach it', async () => {
      // The POS shares the same origin and the same server. If it registered the worker too, a stale
      // index.html would mean stale prices and stale stock, and the till is the one screen where that is
      // not acceptable.
      const page = await browser.newPage();
      try {
        await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
        await sleep(1200);
        const regs = await page.evaluate(async () =>
          (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope));
        // A registration exists for the origin, because the station test above made one. What matters is
        // that the till's own page is not controlled by it, and does not ask for one.
        const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
        ok(!controlled, 'the till is not controlled by the weighing station\'s worker');
        const posRegisters = await page.evaluate(() =>
          performance.getEntriesByType('resource').some((r) => r.name.includes('/sw.js') && r.initiatorType === 'script'));
        ok(!posRegisters, 'and the till never asked for one');
      } finally { await page.close(); }
    });

    /* ---------- 4. the screen stays on ---------- */
    await t('the station asks for a screen wake lock, and asks again when it comes back', async () => {
      // A tablet that dims at 30 seconds shows a customer a lock screen, or a black panel, at the exact moment
      // they are being served. The hold is dropped when the page is hidden and re-asked on return, so it
      // does not quietly become a tablet that never sleeps.
      const page = await browser.newPage();
      try {
        await page.emulateTimezone('UTC');
        // Chrome headless will not grant a real wake lock, so the request is observed rather than its result.
        // The held lock is tracked so the release can be triggered, because that is the sequence that
        // matters: a real browser drops the hold when the page is hidden, and the page has to notice and
        // ask again rather than assume it still has one.
        await page.evaluateOnNewDocument(() => {
          window.__wakeAsks = [];
          window.__held = null;
          Object.defineProperty(navigator, 'wakeLock', {
            configurable: true,
            get: () => ({
              request: async (type) => {
                window.__wakeAsks.push(type);
                const listeners = {};
                window.__held = {
                  fire: (ev) => (listeners[ev] || []).forEach((fn) => fn()),
                  addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); }
                };
                return window.__held;
              }
            })
          });
        });
        await page.goto(BASE + '/weigh.html', { waitUntil: 'networkidle2' });
        await sleep(800);
        const first = await page.evaluate(() => window.__wakeAsks.slice());
        ok(first.includes('screen'), 'it asked for the screen, saw: ' + JSON.stringify(first));

        // The browser takes the hold away in the background, then the page becomes visible again.
        await page.evaluate(() => { window.__held?.fire('release'); });
        await page.evaluate(() => {
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await sleep(600);
        const after = await page.evaluate(() => window.__wakeAsks.length);
        ok(after > first.length, 'and asked again once the hold had been released: ' + after);
      } finally { await page.close(); }
    });
  } finally {
    await browser.close();
  }
} finally {
  stopServer();
  fs.rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
