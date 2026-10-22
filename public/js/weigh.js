// Turning the weighing station into something a shop can install, and keeping it awake.
//
// Both of these are about the tablet on the wall. A browser tab that gets evicted, or a screen that dims
// halfway through a customer's weight, is a till that says "connection error" to somebody standing there —
// so the shell is cached for offline use and the screen is held awake while the page is actually on screen.
//
// Nothing here is loaded by the POS. weigh.html is the only page that calls either of these, on purpose: a
// worker that also cached the till could serve a stale price list or a stock count, and the till is the last
// thing in this project that should ever do that.
import { initTheme, dismissBoot } from './ui.js';
import { renderWeighStation } from './components/weigh-station.js';

initTheme();
renderWeighStation(document.getElementById('app'));
// After the frame that paints the station, not before: dismissing on the same tick would leave the splash
// up until something else happened to yield, which on a fast tablet means it never showed at all and on a
// slow one means it showed over a blank page. One frame later the scale is genuinely on screen.
requestAnimationFrame(dismissBoot);
window.addEventListener('error', dismissBoot, { once: true });

/* ---------- keep the station installed and available ---------- */

// Registered after first paint rather than in the head, so it never competes with the first paint for
// bandwidth on a tablet that may be on a slow connection. A failed registration is ignored: the station
// works fine without it, and an offline shell is a convenience rather than the thing keeping the shop open.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Scoped to /weigh.html, and the scope is the load-bearing part rather than a detail. A worker
    // registered at the root takes control of *every* page on the origin, the till included, which would
    // put the POS's own index.html and scripts through this cache — a cached page is a stale price list.
    // Scoped to its one page, the till is never controlled and never reaches this code at all.
    navigator.serviceWorker.register('/sw.js', { scope: '/weigh.html' }).catch(() => {});
  });
}

/* ---------- keep the screen on ---------- */

// The Wake Lock API, held while the page is on screen and released when it is not.
//
// Released on hide rather than left to run: a tablet that keeps a wake lock in the background is a tablet
// that never sleeps, and the battery lasts a shift instead of a week. It is also dropped by the browser on
// its own under memory pressure, which is why visibilitychange re-asks rather than assuming it is held.
let wakeLock = null;

async function holdWakeLock() {
  if (wakeLock || !navigator.wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    // Released out from under us, e.g. when the tab was hidden. Re-acquired on the next visibilitychange.
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch {
    // Denied because the battery is low, or unsupported. The station still works; the screen just dims.
  }
}

if (navigator.wakeLock) {
  holdWakeLock();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') holdWakeLock();
  });
}
