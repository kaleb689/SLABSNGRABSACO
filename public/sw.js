// Offline fallback only. Account data, payments, HTML and API responses remain network-only.
const OFFLINE_CACHE = "sng-pwa-offline-v1";
self.addEventListener("install", event => {
  event.waitUntil(caches.open(OFFLINE_CACHE).then(cache => cache.add("/offline.html")).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("sng-pwa-offline-") && key !== OFFLINE_CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || request.mode !== "navigate" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(request).catch(async () => {
    const fallback = await caches.open(OFFLINE_CACHE).then(cache => cache.match("/offline.html"));
    return fallback || new Response("You’re offline. Reconnect and try again.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }));
});
