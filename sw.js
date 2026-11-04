// Chess Review Lab service worker: lets the app open and analyze games offline.
const VERSION = "crl-v5";
const SHELL = [
  "./", "index.html", "app.js", "core.js", "chess.js",
  "stockfish-19-lite-single.js", "stockfish-19-lite-single.wasm",
  "manifest.webmanifest", "starter-games.json",
  "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png", "icons/apple-touch-icon.png",
];
self.addEventListener("install", e => {
  // cache: "reload" skips the browser's HTTP cache, so an update never re-caches old files
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })))));
});
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener("message", e => { if (e.data === "skipWaiting") self.skipWaiting(); });
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // the app page (including share-target and #game links) always resolves to the cached shell
  if (req.mode === "navigate") {
    e.respondWith(caches.match("index.html", { ignoreSearch: true }).then(r => r || fetch(req)));
    return;
  }
  if (url.pathname.endsWith("/version.json")) return; // always ask the network
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
    if (res.ok && res.type === "basic") { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  })));
});
