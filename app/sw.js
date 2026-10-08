/* Pantri service worker.
 *
 * Two modes, selected by the stamp block below:
 *  - dev (VERSION === '__BUILD__', as committed): same-origin GETs are network-first with a
 *    runtime-cache fallback, so local edits always show up and the app still works offline
 *    after one visit. A changed sw.js activates immediately.
 *  - production (block rewritten by tools/stamp.mjs in CI): FILES are precached into
 *    `pantry-<VERSION>`; same-origin GETs are cache-first (navigations get ./index.html),
 *    falling back to the network. A new version installs and then WAITS until a page posts
 *    {type: 'SKIP_WAITING'}.
 * Both modes: Open Food Facts images (images.openfoodfacts.org) are cache-first in
 * `pantry-images` (oldest evicted beyond IMAGE_CACHE_MAX); every other cross-origin request
 * (e.g. the Open Food Facts API) is not touched: straight to the network, never cached.
 *
 * Messages from pages:
 *   {type: 'SKIP_WAITING'} -> activate this (waiting) worker now
 *   {type: 'GET_VERSION'}  -> replies {type: 'VERSION', version, dev} on event.ports[0] if
 *                             given (MessageChannel), else to the sending client
 *
 * Reminders (Web Push from the server): a push carries JSON {title, body, url, tag} and is shown
 * as a notification (a newer one with the same tag replaces the older one quietly). Tapping it
 * focuses an open app window and shows `url` there, or opens the app at `url`.
 */

// <stamp> rewritten by tools/stamp.mjs at deploy time; keep '__BUILD__' and [] in the repo
const VERSION = '__BUILD__';
const FILES = [];
// </stamp>

const DEV = VERSION === '__BUILD__';
const CACHE_PREFIX = 'pantry-';
const APP_CACHE = DEV ? 'pantry-dev' : `pantry-${VERSION}`;
const IMAGE_CACHE = 'pantry-images';
const IMAGE_HOSTS = new Set(['images.openfoodfacts.org']);
const IMAGE_CACHE_MAX = 300;
const SCOPE = self.registration.scope;
const INDEX_URL = new URL('./index.html', self.location.href).href;
const ROOT_URL = new URL('./', self.location.href).href;

self.addEventListener('install', (event) => {
  if (DEV) {
    event.waitUntil(self.skipWaiting());
    return;
  }
  // cache: 'reload' bypasses the HTTP cache, so a new version never mixes in stale files.
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) => cache.addAll(FILES.map((url) => new Request(url, { cache: 'reload' })))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([APP_CACHE, IMAGE_CACHE]);
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX) && !keep.has(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  } else if (type === 'GET_VERSION') {
    const reply = { type: 'VERSION', version: VERSION, dev: DEV };
    if (event.ports && event.ports[0]) event.ports[0].postMessage(reply);
    else if (event.source) event.source.postMessage(reply);
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.headers.has('range')) return;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return; // DevTools quirk
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    // The origin (e.g. <user>.github.io) may host other apps: only handle our own scope.
    if (!request.url.startsWith(SCOPE)) return;
    event.respondWith(DEV ? networkFirst(event) : cacheFirst(request));
    return;
  }
  if (IMAGE_HOSTS.has(url.hostname)) {
    event.respondWith(cachedImage(event));
  }
  // Any other cross-origin request: no respondWith -> plain network, uncached.
});

// ---- production: cache-first ------------------------------------------------------------------
async function cacheFirst(request) {
  const cache = await caches.open(APP_CACHE);
  if (request.mode === 'navigate') {
    // A precached file (e.g. a licence text) is served as itself; every other in-scope page is
    // the app shell. Search and hash are ignored (hash never reaches the network anyway).
    const page =
      (await cache.match(request, { ignoreSearch: true, ignoreVary: true })) ||
      (await cache.match(INDEX_URL, { ignoreVary: true }));
    return page ? withoutRedirect(page) : fetch(request);
  }
  return (await cache.match(request, { ignoreVary: true })) || fetch(request);
}

// ---- dev: network-first with runtime cache fallback ---------------------------------------------
async function networkFirst(event) {
  const { request } = event;
  const cache = await caches.open(APP_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      event.waitUntil(cache.put(request, response.clone()).catch(() => {}));
    }
    return response;
  } catch (error) {
    let cached = await cache.match(request, { ignoreVary: true });
    if (!cached && request.mode === 'navigate') {
      cached =
        (await cache.match(request, { ignoreSearch: true, ignoreVary: true })) ||
        (await cache.match(INDEX_URL, { ignoreVary: true })) ||
        (await cache.match(ROOT_URL, { ignoreVary: true }));
    }
    if (cached) return request.mode === 'navigate' ? withoutRedirect(cached) : cached;
    throw error;
  }
}

// ---- Open Food Facts images: cache-first, bounded -----------------------------------------------
async function cachedImage(event) {
  const { request } = event;
  const cache = await caches.open(IMAGE_CACHE);
  const cached = await cache.match(request, { ignoreVary: true });
  // An opaque (no-cors) copy cannot satisfy a CORS request (<img crossorigin>): refetch instead.
  if (cached && !(request.mode === 'cors' && cached.type === 'opaque')) return cached;
  const response = await fetch(request);
  if (response.ok || response.type === 'opaque') {
    event.waitUntil(
      cache
        .put(request, response.clone())
        .then(() => trimCache(cache, IMAGE_CACHE_MAX))
        .catch(() => {}), // e.g. QuotaExceededError: just don't cache
    );
  }
  return response;
}

async function trimCache(cache, max) {
  const keys = await cache.keys(); // insertion order: oldest first
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

// Navigations must not be answered with a redirected response (redirect mode 'manual').
async function withoutRedirect(response) {
  if (!response.redirected) return response;
  return new Response(await response.blob(), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// ---- reminders: Web Push -------------------------------------------------------------------------
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = (event.data && event.data.json()) || {};
  } catch {
    data = { body: event.data ? event.data.text() : '' }; // not JSON: show the text as it is
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Pantri', {
      body: data.body || 'Open Pantri to see what needs attention today.',
      icon: './icons/icon-192.png',
      tag: data.tag || 'pantri',
      renotify: false,
      data: { url: data.url || './#/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const asked = new URL((event.notification.data && event.notification.data.url) || './#/', SCOPE).href;
  const url = asked.startsWith(SCOPE) ? asked : ROOT_URL; // only ever open the app itself
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const app = windows.find((c) => c.url.startsWith(SCOPE));
      if (!app) {
        await self.clients.openWindow(url);
        return;
      }
      await app.focus().catch(() => {});
      // Only possible for windows this worker controls (all of them, once it has activated).
      if (app.url !== url) await app.navigate(url).catch(() => {});
    })(),
  );
});
