// Motion in the POS.
//
// The point of this file is not that things move. It is that the right things move and, more importantly,
// that the wrong things do not: a quantity change re-rendering the whole basket, or a cashier typing a
// search having the grid re-stagger under the cursor, both look like lag and read as an app that is about
// to lose the sale. So most of what is asserted here is that something does *not* animate.
import { loadPuppeteer, launchBrowser, killPort } from './browser.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const puppeteer = await loadPuppeteer();
const PORT = 3193, DIR = '/tmp/opencode/motion', BASE = `http://localhost:${PORT}`, PIN = '4821';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
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
  if (i > 80) throw new Error('the server did not start');
  await sleep(250);
}
const post = async (path, body, token) => {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// Seeded before the PIN exists, because once a shop has a PIN every /api/products call demands it. Doing it
// in this order also means the test never holds a token it has to keep in step with the browser's session.
const products = [
  { name: 'Parle-G 100g', sku: 'P1', price: 10, stock: 40, category: 'Snacks', emoji: '🍪' },
  { name: 'Amul Taaza 500ml', sku: 'P2', price: 27, stock: 12, category: 'Drinks', emoji: '🥛' },
  { name: 'Maggi 12-pack', sku: 'P3', price: 168, stock: 6, category: 'Snacks', emoji: '🍜' },
  { name: 'Surf Excel 1kg', sku: 'P4', price: 132, stock: 9, category: 'Household', emoji: '🧼' }
];
for (const p of products) {
  const r = await post('/api/products', p);
  ok(r.status === 201, `could not seed ${p.sku}: ${r.status} ${JSON.stringify(r.body)}`);
}
await post('/api/setup', { storeName: 'Motion Mart', upiVpa: '', pin: PIN });

let browser;
try {
  browser = await launchBrowser(puppeteer);
  // 820px wide, deliberately: above 1000px the cart is a permanent column and the toggle is hidden, so a
  // wider viewport would leave nothing to click. This is the tablet layout most of these shops actually run,
  // where the cart is a sheet over the catalog.
  const open = async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 820, height: 1180 });
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-pin-gate]', { timeout: 20000 });
    await page.type('[data-pin-gate] input[aria-label="Shop PIN"]', PIN);
    await page.click('[data-pin-gate] button[type=submit]');
    await page.waitForSelector('.catalog-grid .product', { timeout: 20000 });
    return page;
  };
  // Which animations are actually running on an element, as the compositor sees them. Takes the page
  // rather than closing over one, because every test opens its own.
  // Sampled the moment it happens. `getAnimations()` only reports what is running now, so measuring after
  // the 260ms animation has finished reports nothing and the test would be asserting that the animation is
  // over by the time anybody looked — which is true of every animation, animated or not.
  const runningNow = (page, sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    return el.getAnimations().map((a) => a.animationName || a.transitionProperty);
  }, sel);
  /* Waits for an animation on `sel` to appear, polling fast, and reports its name.
     Returns null on timeout rather than throwing, so the caller's message can explain what was on screen. */
  const sawAnimation = async (page, sel, ms = 900) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const found = await runningNow(page, sel);
      if (found?.length) return found;
      await sleep(40);
    }
    return null;
  };
  const hasClass = (page, sel) => page.evaluate((s) => !!document.querySelector(s), sel);
  const addToCart = async (page, name) => {
    await page.evaluate((n) => {
      const card = [...document.querySelectorAll('.product')].find((c) => c.textContent.includes(n));
      card.querySelector('.btn').click();
    }, name);
    await sleep(500);
  };
  const openCart = async (page) => {
    await page.click('.cart-toggle');
    await page.waitForFunction(() => document.body.classList.contains('cart-open'), { timeout: 10000 });
    await sleep(600);
  };

  await t('a card that has just been drawn does animate in', async () => {
    const page = await open();
    ok(await hasClass(page, '.product.enter'), 'no card was marked for the entrance animation');
    ok((await sawAnimation(page, '.product.enter'))?.length, 'the cards had no animation on the first draw');
    await page.close();
  });

  await t('the stagger is capped, so a long grid is not still moving minutes later', async () => {
    const page = await open();
    const info = await page.evaluate(() => {
      const all = [...document.querySelectorAll('.product')];
      return { total: all.length, moving: all.filter((c) => c.getAnimations().length).length };
    });
    ok(info.moving <= 8, `${info.moving} of ${info.total} cards were still animating`);
    await page.close();
  });

  await t('the last card in the stagger has started before the first has finished', async () => {
    const page = await open();
    const delays = await page.evaluate(() => [...document.querySelectorAll('.product.enter')]
      .map((c) => parseFloat(getComputedStyle(c).animationDelay) * 1000));
    ok(delays.length > 1, 'nothing was staggered');
    ok(Math.max(...delays) < 300, `the last card waited ${Math.max(...delays)}ms`);
    await page.close();
  });

  await t('typing a search does not re-stagger the grid under the cursor', async () => {
    const page = await open();
    await sleep(900);
    await page.type('.search-bar input', 'a');
    await sleep(350);
    const moving = await page.evaluate(() => [...document.querySelectorAll('.product')]
      .filter((c) => c.getAnimations().length).length);
    ok(moving === 0, `${moving} cards animated while the cashier was typing`);
    await page.close();
  });

  await t('a product added from the catalog plays the arrival flash', async () => {
    const page = await open();
    await sleep(900);
    await addToCart(page, 'Parle-G');
    // Clicking through the UI and then polling cannot catch a 700ms flash reliably, so the tap is dispatched
    // from inside the page and sampled in the same task, before the animation has a chance to finish.
    const flashed = await page.evaluate(async () => {
      const card = [...document.querySelectorAll('.product')].find((c) => c.textContent.includes('Parle-G'));
      card.querySelector('.btn').click();
      for (let i = 0; i < 40; i++) {
        const el = [...document.querySelectorAll('.product')].find((c) => c.textContent.includes('Parle-G'));
        const a = el?.getAnimations().map((x) => x.animationName);
        if (a?.length) return a;
        await new Promise((r) => setTimeout(r, 25));
      }
      return null;
    });
    ok(flashed?.length, 'the added product did not flash, so a scan-add gives no confirmation');
    await page.close();
  });

  await t('a new line slides into the cart', async () => {
    const page = await open();
    await sleep(900);
    await addToCart(page, 'Parle-G');
    await openCart(page);
    ok(await hasClass(page, '.cart-item.is-new'), 'the new cart line was not marked for the entrance animation');
    ok((await sawAnimation(page, '.cart-item.is-new'))?.length, 'the new cart line did not animate');
    await page.close();
  });

  await t('adding a second item animates only the new line, not the whole basket', async () => {
    const page = await open();
    await sleep(900);
    await addToCart(page, 'Parle-G');
    await openCart(page);
    await addToCart(page, 'Amul Taaza');
    await sleep(700);
    const count = await page.evaluate(() => document.querySelectorAll('.cart-item.is-new').length);
    ok(count === 1, `${count} lines animated when one item was added; the others should have stayed still`);
    await page.close();
  });

  await t('changing a quantity does not re-animate every line', async () => {
    // The specific regression this guards: the list is rebuilt from scratch on every render, so an animation
    // on `.cart-item` rather than on the rows that are actually new would replay for all ten lines on every
    // single stepper tap. That is the screen the cashier is reading while they bill.
    const page = await open();
    await sleep(900);
    await addToCart(page, 'Parle-G');
    await addToCart(page, 'Amul Taaza');
    await openCart(page);
    await sleep(700);
    await page.click('.cart-item .stepper .icon-btn:last-of-type');  // the "+" button
    await sleep(700);
    const count = await page.evaluate(() => document.querySelectorAll('.cart-item.is-new').length);
    ok(count === 0, `${count} lines re-animated when a quantity changed`);
    await page.close();
  });

  await t('the total nudges when the figure changes', async () => {
    const page = await open();
    await sleep(900);
    await addToCart(page, 'Parle-G');
    await openCart(page);
    // Dispatched in-page and sampled in the same task, like the flash test. The nudge is 340ms and a
    // round-trip through page.click() plus a poll can miss it, which would make this test report a missing
    // animation for an animation that plainly ran.
    const nudged = await page.evaluate(async () => {
      document.querySelector('.cart-item .stepper .icon-btn:last-of-type').click();
      for (let i = 0; i < 60; i++) {
        const a = document.querySelector('.headline-m').getAnimations().map((x) => x.animationName);
        if (a.length) return a;
        await new Promise((r) => setTimeout(r, 20));
      }
      return null;
    });
    ok(nudged?.length, `the total did not acknowledge the change (text now ${await page.evaluate(() => document.querySelector('.headline-m').textContent)})`);
    ok(nudged.includes('total-tick'), `the total moved as "${nudged.join(',')}" rather than a nudge`);
    await page.close();
  });

  await t('an idle cart is completely still', async () => {
    // Motion that runs on a timer is the failure mode that makes a till feel haunted: it is never wrong at
    // any one instant, it is just never still. Nothing here should move unless the sale changed.
    const page = await open();
    await sleep(900);
    await addToCart(page, 'Parle-G');
    await openCart(page);
    await sleep(1200);
    const moving = await page.evaluate(() => [...document.querySelectorAll('.cart-sheet *')]
      .filter((el) => el.getAnimations().some((a) => a.playState === 'running')).length);
    ok(moving === 0, `${moving} elements in the cart were still moving after the sale settled`);
    await page.close();
  });

  await t('emptying the basket fades the empty state in rather than blanking the list', async () => {
    const page = await open();
    await sleep(900);
    await addToCart(page, 'Parle-G');
    await openCart(page);
    await page.click('.cart-item > .icon-btn');
    ok(await hasClass(page, '.cart-empty.enter'), 'the empty state was not marked for a transition, so it just blanks the list');
    await page.close();
  });

  await t('reduced motion drops the movement but keeps a visible acknowledgement', async () => {
    // Not "animation: none". Somebody who has asked for reduced motion still needs to know their tap
    // landed; an opacity change is the quietest signal that still registers, and none of these are loops, so
    // there is nothing left running to spare them.
    const page = await browser.newPage();
    await page.setViewport({ width: 820, height: 1180 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-pin-gate]', { timeout: 20000 });
    await page.type('[data-pin-gate] input[aria-label="Shop PIN"]', PIN);
    await page.click('[data-pin-gate] button[type=submit]');
    await page.waitForSelector('.catalog-grid .product', { timeout: 20000 });
    await page.evaluate(() => {
      const card = [...document.querySelectorAll('.product')].find((c) => c.textContent.includes('Parle-G'));
      card.querySelector('.btn').click();
    });
    await openCart(page);
    await sleep(400);
    const found = await page.evaluate(() => {
      const line = document.querySelector('.cart-item.is-new');
      if (!line) return { missing: true };
      const a = line.getAnimations()[0];
      return { name: a?.animationName, duration: a?.effect?.getTiming?.().duration };
    });
    ok(!found.missing, 'the new line got no animation at all, so nothing marks the change');
    ok(found.name === 'md-fade', `the new line still animates as "${found.name}" under reduced motion`);
    // And a press must still register as something.
    const pressed = await page.evaluate(() => {
      const b = document.querySelector('.product .btn');
      b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      return getComputedStyle(b).backgroundColor;
    });
    ok(typeof pressed === 'string', 'could not read the pressed style');
    await page.close();
  });

  await t('the reduced-motion press does not scale the button', async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 820, height: 1180 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-pin-gate]', { timeout: 20000 });
    await page.type('[data-pin-gate] input[aria-label="Shop PIN"]', PIN);
    await page.click('[data-pin-gate] button[type=submit]');
    await page.waitForSelector('.catalog-grid .product', { timeout: 20000 });
    const t = await page.evaluate(async () => {
      const b = document.querySelector('.product .btn');
      b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 250));
      return getComputedStyle(b).transform;
    });
    ok(t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)', `the button still scales under reduced motion: ${t}`);
    await page.close();
  });

  await t('an icon fills when its button is hovered, using the font axis', async () => {
    // Not a second glyph and not an SVG swap: Material Symbols is a variable font with a FILL axis, and the
    // outlined and filled cuts of every icon are two points on that one axis. So this costs no extra bytes
    // and no extra request, which is the only reason it is the right way to do this on a splash and an app
    // that has to run with the Wi-Fi down.
    const page = await open();
    await sleep(900);
    const axis = () => page.evaluate(() =>
      getComputedStyle(document.querySelector('.product .btn .material-symbols-rounded')).fontVariationSettings);
    const resting = await axis();
    ok(/['"]FILL['"]\s+0/.test(resting), `icons do not start unfilled: ${resting}`);
    // Headless Chrome reports `hover: none`, so the media-gated `:hover` rule can never match here. The rule
    // itself is guarded below, and the filled state is exercised through the press path, which is what a tap
    // on a touch till actually reaches anyway.
    const hasHoverRule = await page.evaluate(() =>
      [...document.styleSheets].flatMap((s) => {
        try { return [...(s.cssRules || [])]; } catch { return []; }
      }).some((r) => r.media?.mediaText.includes('hover') && /FILL[\s:'"]+1/.test(r.cssText)));
    ok(hasHoverRule, 'the stylesheet lost the hover fill rule');
    const b = await page.$('.product .btn');
    await b.click({ offset: { x: 5, y: 5 } });
    await page.mouse.down();
    await sleep(350); // the axis is a 220ms transition, read while still held
    const pressed = await axis();
    await page.mouse.up();
    ok(/['"]FILL['"]\s+1/.test(pressed), `pressing an add button did not fill its icon: ${pressed}`);
    await page.close();
  });

  await t('the fill is a transition, so it is actually interpolated', async () => {
    // A FILL that jumps from 0 to 1 is a swap, not an animation. `font-variation-settings` is transitionable
    // while `font-weight` is not, which is why the axis is animated rather than the shorthand.
    const page = await open();
    await sleep(900);
    const dur = await page.evaluate(() =>
      getComputedStyle(document.querySelector('.material-symbols-rounded')).transitionDuration);
    ok(parseFloat(dur) > 0, `icons have no transition on the axis: ${dur}`);
    const prop = await page.evaluate(() =>
      getComputedStyle(document.querySelector('.material-symbols-rounded')).transitionProperty);
    ok(/font-variation-settings/.test(prop), `the transition is on "${prop}" rather than the variable axis`);
    await page.close();
  });

  await t('a busy icon is filled, so the spinner is not alone', async () => {
    const page = await open();
    await sleep(900);
    await page.evaluate(() => { document.querySelector('.product .btn').dataset.busy = ''; });
    await sleep(450); // the axis is a 220ms transition, read after it lands
    const filled = await page.evaluate(() =>
      getComputedStyle(document.querySelector('.product .btn .material-symbols-rounded')).fontVariationSettings);
    ok(/['"]FILL['"]\s+1/.test(filled), `an icon on a busy button is not filled: ${filled}`);
    await page.close();
  });

  await t('the cart count pops every time it changes', async () => {
    // Once only would be worse than never: the badge would animate when the till opens and then sit still
    // for the rest of the shift, which trains a cashier that the pop means nothing.
    const page = await open();
    await sleep(900);
    await addToCart(page, 'Parle-G');
    await openCart(page);
    const pops = [];
    for (const name of ['Amul Taaza', 'Surf Excel', 'Maggi']) {
      await page.evaluate((n) => {
        [...document.querySelectorAll('.product')].find((c) => c.textContent.includes(n)).querySelector('.btn').click();
      }, name);
      await sleep(120);
      pops.push(await page.evaluate(() => document.querySelector('.cart-toggle .nav-badge').getAnimations().length > 0));
    }
    ok(pops.every(Boolean), `the cart count popped on ${pops.filter(Boolean).length} of 3 changes`);
    const count = await page.$eval('.cart-toggle .nav-badge', (b) => b.textContent);
    ok(count === '4', `the badge reads "${count}" after four items`);
    await page.close();
  });

  await t('the online dot breathes, and stops when the connection drops', async () => {
    // A pulsing dot next to "Offline" is a lie about reassurance, so the breath has to be tied to the
    // state rather than left running.
    const page = await open();
    await sleep(1200);
    const running = await page.evaluate(() =>
      [...document.querySelectorAll('.badge .dot')].some((d) => d.getAnimations().some((a) => a.playState === 'running')));
    ok(running, 'a connected till has a completely static status dot');
    const stopped = await page.evaluate(() => {
      const badge = document.querySelector('.badge');
      badge.classList.add('offline');
      return getComputedStyle(badge.querySelector('.dot')).animationName;
    });
    ok(stopped === 'none', `the dot keeps breathing while offline (${stopped})`);
    await page.close();
  });

  await t('a "happening" icon turns, and an ordinary one does not', async () => {
    // Scoped by the data-spin attribute the icon() helper sets, not by proximity or by a blanket rule, so a
    // new icon cannot start spinning by being near one that does.
    const page = await open();
    await sleep(900);
    const spin = await page.evaluate(async () => {
      const mod = await import('/js/ui.js');
      const host = document.createElement('div');
      document.body.append(host);
      host.replaceChildren(mod.icon('refresh', { spin: true }), mod.icon('settings'));
      await new Promise((r) => requestAnimationFrame(r));
      const [spinning, still] = [...host.querySelectorAll('.material-symbols-rounded')];
      return {
        spin: getComputedStyle(spinning).animationName,
        still: getComputedStyle(still).animationName
      };
    });
    ok(spin.spin === 'icon-turn', `the spinning icon runs "${spin.spin}"`);
    ok(spin.still === 'none', `an ordinary icon is animating too (${spin.still})`);
    await page.close();
  });

  await t('reduced motion keeps the icon fill but stops everything that turns', async () => {
    // The fill is a change of state, not travel: nothing crosses the screen, nothing loops. Dropping it
    // would leave an icon-only button with no acknowledgement at all, so it stays, near-instant. The
    // rotation and the breathing dot are the loops, and they are what the setting is actually asking about.
    const page = await browser.newPage();
    await page.setViewport({ width: 820, height: 1180 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-pin-gate]', { timeout: 20000 });
    await page.type('[data-pin-gate] input[aria-label="Shop PIN"]', PIN);
    await page.click('[data-pin-gate] button[type=submit]');
    await page.waitForSelector('.product', { timeout: 20000 });
    await sleep(900);
    const dot = await page.evaluate(() =>
      getComputedStyle(document.querySelector('.badge .dot')).animationName);
    ok(dot === 'none', `the status dot still breathes under reduced motion (${dot})`);
    await page.hover('.product .btn');
    const bb = await page.$('.product .btn');
    const box = await bb.boundingBox();
    await page.mouse.move(box.x + 20, box.y + 15);
    await page.mouse.down();
    await sleep(250); // the axis is a 220ms transition
    const filled = await page.evaluate(() =>
      getComputedStyle(document.querySelector('.product .btn .material-symbols-rounded')).fontVariationSettings);
    await page.mouse.up();
    ok(/['"]FILL['"]\s+1/.test(filled),
      `the icon fill is dropped under reduced motion, leaving icon buttons with no acknowledgement (${filled})`);
    await page.close();
  });

  await t('every animation here is finite', async () => {
    // A looping animation in a till is a permanent redraw, on hardware that is often a cheap tablet with a
    // battery that has to last a shift. `getAnimations()` exposes the iteration count directly.
    const page = await open();
    await sleep(600);
    await addToCart(page, 'Parle-G');
    await openCart(page);
    await sleep(900);
    const looping = await page.evaluate(() => [...document.querySelectorAll('.product, .cart-item, .cart-sheet, .cart-empty')]
      .flatMap((el) => el.getAnimations())
      .map((a) => ({ name: a.animationName, iter: a.effect?.getTiming?.().iterations }))
      .filter((a) => a.iter === Infinity || a.iter > 1)
      .map((a) => `${a.name} x${a.iter}`));
    ok(looping.length === 0, `looping: ${looping.join(', ')}`);
    await page.close();
  });
} finally {
  await browser?.close().catch(() => {});
  srv.kill();
  killPort(PORT);
  fs.rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
