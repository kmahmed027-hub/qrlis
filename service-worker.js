const CACHE_NAME = "qr-lab-shell-v13";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./app.js",
  "./calc.cjs",
  "./style.css",
  "./firebase-config.js",
  "./lot-to-lot-reference.js",
  "./manifest.json",
  "./assets/logo.png",
  "./assets/logo-icon.png",
  "./assets/apple-touch-icon.png",
  "./assets/favicon-32.png",
  "./assets/favicon-16.png",
  "./assets/og-image.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => { /* ok if an asset is missing */ })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
  );
  self.clients.claim();
});

// Only handle same-origin GET requests for the static shell — Firebase/Firestore/auth calls (a
// different origin) are left completely untouched and always go straight to the network.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.ok) caches.open(CACHE_NAME).then((cache) => cache.put(req, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
