/* Kleingarten – Service Worker: App offline verfügbar, Updates kommen automatisch. */
const VERSION = "kg-2026-10-13-2";
const SHELL = ["./", "index.html", "js/config.js", "js/backend.js", "vendor/supabase.js", "manifest.webmanifest",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && !k.startsWith("kg-fotos")).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Fotos aus Supabase: einmal geladen, offline verfügbar
  if (url.pathname.includes("/storage/v1/object/public/")) {
    e.respondWith(caches.open("kg-fotos").then(async c => {
      const hit = await c.match(req); if (hit) return hit;
      const res = await fetch(req); if (res.ok) c.put(req, res.clone()); return res;
    }));
    return;
  }
  if (url.origin !== location.origin) return; // Datenbank-Abfragen nie zwischenspeichern
  // App-Dateien: zuerst Netz (für Updates), sonst Zwischenspeicher
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then(r => r || caches.match("index.html"))));
});
