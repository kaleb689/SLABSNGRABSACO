// Offline fallback only. Account data, payments, HTML and API responses remain network-only.
const OFFLINE_CACHE = "sng-pwa-offline-v2";
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

self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let payload = {};
    try { payload = event.data?.json() || {}; } catch {}
    await self.registration.showNotification(payload.title || "SLABSNGRABSACO", {
      body: payload.body || "You have a new account update.", icon: "/icons/app-192.png", badge: "/icons/app-192.png",
      tag: payload.tag || "account-update", data: { tab: ["success", "membership", "notifications"].includes(payload.tab) ? payload.tab : "notifications" }
    });
  })());
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const tab = ["success", "membership", "notifications"].includes(event.notification.data?.tab) ? event.notification.data.tab : "notifications";
    const url = new URL(`/?appTab=${tab}#my-profile`, self.location.origin).href;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      await client.navigate(url);
      return client.focus();
    }
    return self.clients.openWindow(url);
  })());
});
