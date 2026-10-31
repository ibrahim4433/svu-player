/**
 * SVU Player service worker (Root Scope PWA)
 * ------------------------------------------
 * Caches the app shell so the player works 100% offline as an installable PWA.
 */

const CACHE_NAME = "svu-player-local-v33";

const APP_SHELL = [
  "/",
  "/index.html",
  "/app.js",
  "/src/config.js",
  "/assets/core.wasm",
  "/assets/logo.svg",
  "/assets/logo.png",
  "/assets/logo-192.png",
  "/assets/logo-512.png",
  "/assets/svu-material-codes.csv",
  "/favicon.svg",
  "/site.webmanifest",
  "/fonts/ReadexPro-arabic.woff2",
  "/fonts/ReadexPro-latin.woff2"
];

function skipCache(request) {
  return new URL(request.url).searchParams.has("nocache");
}

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key !== CACHE_NAME)
            .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  if (event.request.method !== "GET" ||
      url.origin !== location.origin ||
      url.pathname.startsWith("/api/")) {
    return;
  }

  if (skipCache(event.request)) {
    event.respondWith(fetch(event.request));
    return;
  }

  const cacheOptions = { ignoreSearch: true };

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME)
            .then(cache => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(event.request, cacheOptions)
          .then(cached => cached || caches.match("/index.html") || caches.match("/"))
      )
  );
});
