// Service worker for the weighing station only.
//
// Why this exists, and why it is so narrow: the weighing station is a tablet on the shop wall that nobody
// touches, and a browser that decides to evict the page is a browser that decides the scale is at a
// "connection error" when somebody is standing there with a bag of onions. So the app itself is kept
// available offline.
//
// The narrowness is the important part. This worker:
//   - caches the weighing station's own files, and nothing else;
//   - never sees, never stores and never serves anything from /api/, so a weight or a ticket can never be
//     answered from a stale copy. Live till data served from cache is a bug that looks like a bug only
//     after money has moved;
//   - is registered only by weigh.html, never by the POS itself, so no amount of caching here can make the
//     till serve yesterday's prices, stock or customer list.
//
// Everything is a cache-first fetch with a background refresh, because the alternative — network-first —
// puts a round trip in front of every tap on a tablet that may be on weak shop Wi-Fi. The weights and
// items still come from the server every time; only the shell is cached.
const VERSION = 'weigh-v4';
const SHELL = [
  '/weigh.html',
  '/css/m3.css',
  '/js/weigh.js',
  '/js/ui.js',
  '/js/sfx.js',
  '/js/weigh-api.js',
  '/js/camera-scan.js',
  '/js/components/weigh-station.js',
  '/vendor/qrcode.min.js',
  // The boot screen's own images. A splash that is still fading as the station appears, showing a broken
  // image where the logo should be, is worse than no splash: this station is often launched with the
  // network down, so anything not in this list is not guaranteed to be there when the splash shows it.
  '/logo.png',
  '/edupulse-logo.png',
  // The splash's typeface. Cached for the same reason the logos are: a weighing station with no signal is
  // the normal case, not the edge case, and a splash that renders its tagline in Georgia because the font
  // did not load is the one place the branding would visibly fall apart.
  '/fonts/bodoni-moda-latin.woff2',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      // Individually, so one missing optional file does not fail the whole install and leave the station
      // with no worker at all. addAll is all-or-nothing, and "no worker" is a worse state than "no icon".
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** The one question this worker must never get wrong. */
const isLiveData = (url) =>
  url.pathname.startsWith('/api/') ||
  url.pathname.startsWith('/uploads/') ||
  url.pathname.startsWith('/delivery-photos/');

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Anything but a plain GET is not a cache question. A POST to the server is a weight being recorded or a
  // ticket being made, and there is no version of "serve that from cache" that means anything sensible.
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  const url = new URL(request.url);
  // Live data goes straight to the server, always, with the worker's cache nowhere in the path. Said here as
  // well as in the shell list because this is the line that matters and it is the one worth re-reading.
  if (isLiveData(url)) return;

  event.respondWith(
    caches.match(request).then((hit) => {
      // Refresh in the background so the next load has the new version, without making this one wait.
      const fresh = fetch(request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => hit); // offline with nothing cached: let the browser's own error page have it
      return hit || fresh;
    })
  );
});
