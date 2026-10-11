import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
function worker(fetcher = async () => "live response") {
  const events = {};
  const saved = [], notifications = [];
  const cache = { add: async url => saved.push(url), match: async url => url === "/offline.html" ? "offline page" : undefined };
  const self = { location: { origin: "https://slabsngrabsaco.com" }, addEventListener: (key, fn) => events[key] = fn,
    skipWaiting: async () => {}, clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} },
    registration: { showNotification: async (title, options) => notifications.push({ title, ...options }) } };
  const caches = { open: async () => cache, keys: async () => [], delete: async () => {} };
  vm.runInNewContext(source, { self, caches, fetch: fetcher, URL, Response });
  return { events, saved, self, notifications };
}
test("only the generic offline page is cached", async () => {
  const w = worker(); let promise;
  w.events.install({ waitUntil: value => promise = value }); await promise;
  assert.deepEqual(w.saved, ["/offline.html"]);
});
test("API, live streams, POSTs and external navigation are not intercepted", () => {
  const w = worker();
  for (const request of [
    {method:"GET",mode:"cors",url:"https://slabsngrabsaco.com/api/account/profile"},
    {method:"POST",mode:"navigate",url:"https://slabsngrabsaco.com/api/account/save"},
    {method:"GET",mode:"navigate",url:"https://checkout.stripe.com/session"}
  ]) w.events.fetch({request, respondWith: () => assert.fail("Unexpected interception")});
});
test("online documents use the original request, without caching the response", async () => {
  const request = {method:"GET",mode:"navigate",url:"https://slabsngrabsaco.com/",credentials:"include"};
  let received, response;
  const w = worker(async req => { received = req; return "live account"; });
  w.events.fetch({request,respondWith: value => response = value});
  assert.equal(await response, "live account");
  assert.equal(received, request);
  assert.deepEqual(w.saved, []);
});
test("disconnected navigation shows a generic reconnect page", async () => {
  const w = worker(async () => { throw new Error("offline"); }); let response;
  w.events.fetch({request:{method:"GET",mode:"navigate",url:"https://slabsngrabsaco.com/"},respondWith:value=>response=value});
  assert.equal(await response,"offline page");
});


test("drop SKU push alerts open the installed customer's Drops selection page", async () => {
  const w = worker(); let completed;
  w.events.push({
    data: { json: () => ({ title: "Target drop SKUs updated", body: "Choose your SKUs", tab: "drops" }) },
    waitUntil: promise => { completed = promise; }
  });
  await completed;
  assert.equal(w.notifications.length, 1);
  assert.equal(w.notifications[0].data.tab, "drops");
  let destination = "";
  w.self.clients.openWindow = async url => { destination = url; };
  w.events.notificationclick({
    notification: { data: { tab: "drops" }, close: () => {} },
    waitUntil: promise => { completed = promise; }
  });
  await completed;
  assert.equal(destination, "https://slabsngrabsaco.com/?appTab=drops#my-profile");
});
