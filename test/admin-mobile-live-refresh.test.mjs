import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const mobileSource = fs.readFileSync(
  new URL("../public/admin-mobile.js", import.meta.url), "utf8"
);

function createMobileHarness() {
  const elements = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const streams = [];
  const pendingTimers = new Map();
  const requests = [];
  const scrolls = [];
  let nextTimer = 0;

  function node(id) {
    if (!elements.has(id)) {
      const listeners = new Map();
      elements.set(id, {
        id, hidden: false, textContent: "", innerHTML: "", value: "", disabled: false,
        style: {}, dataset: {}, listeners,
        classList: { toggle: () => {} },
        addEventListener(name, callback) { listeners.set(name, callback); },
        querySelectorAll() { return []; },
        querySelector() { return null; },
        closest(selector) { return selector === "#workspace" ? node("workspace") : null; },
        matches(selector) { return selector.includes("input"); }
      });
    }
    return elements.get(id);
  }

  const document = {
    hidden: false, activeElement: null,
    getElementById: node,
    querySelectorAll: () => [],
    addEventListener(name, callback) { documentListeners.set(name, callback); }
  };
  const window = {
    scrollX: 14, scrollY: 44,
    addEventListener(name, callback) { windowListeners.set(name, callback); },
    scrollTo(x, y) { scrolls.push([x, y]); }
  };
  const fixtures = {
    "/api/admin/submissions": { submissions: [
      { id: "order1", customerAccountId: "user1", profile: { firstName: "Amy", email: "amy@example.test" } }
    ] },
    "/api/admin/free-submissions": [],
    "/api/admin/profile-activation-tracker": { customers: [] },
    "/api/managed-availability": {},
    "/api/admin/app-usage": {}
  };
  class EventSource {
    constructor(url) { this.url = url; this.callbacks = new Map(); streams.push(this); }
    addEventListener(name, callback) { this.callbacks.set(name, callback); }
    close() { this.closed = true; }
    emit(name) { this.callbacks.get(name)?.(); }
  }
  const sandbox = {
    document, window, navigator: {}, EventSource,
    fetch: async path => {
      requests.push(path);
      return { status: 200, ok: true, json: async () => fixtures[path] || {} };
    },
    setTimeout: callback => {
      const id = ++nextTimer;
      pendingTimers.set(id, callback);
      return id;
    },
    clearTimeout: id => pendingTimers.delete(id),
    setInterval: () => 99,
    requestAnimationFrame: callback => callback(),
    console,
    alert: () => {},
    confirm: () => true
  };
  vm.runInNewContext(mobileSource, sandbox, { filename: "admin-mobile.js" });

  async function settle() {
    for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  }
  async function flushTimers() {
    const callbacks = [...pendingTimers.values()];
    pendingTimers.clear();
    for (const callback of callbacks) callback();
    await settle();
  }
  return { node, document, window, fixtures, streams, requests, scrolls, settle, flushTimers,
    onDocument(name) { return documentListeners.get(name); } };
}

test("mobile Admin automatically syncs without interrupting a focused customer search", async () => {
  const h = createMobileHarness();
  await h.settle();
  assert.equal(h.requests.length, 6, "initial dashboard fetched paid and registered customers plus management sources");
  assert.equal(h.streams.length, 1, "one live connection established");
  assert.equal(h.streams[0].url, "/api/admin/live/events");

  h.node("tabs").listeners.get("click")({
    target: { closest: () => ({ dataset: { tab: "customers" } }) }
  });
  const search = h.node("customer-search");
  search.value = "amy@example";
  search.listeners.get("input")();
  assert.match(h.node("customer-results").innerHTML, /Amy/);

  h.document.activeElement = search;
  h.streams[0].emit("data-change");
  await h.flushTimers();
  assert.equal(h.requests.length, 6, "live event cannot overwrite focused form");

  h.document.activeElement = null;
  h.onDocument("focusout")();
  await h.flushTimers();
  assert.equal(h.requests.length, 12, "pending event reloads when input loses focus");
  assert.equal(search.value, "amy@example", "customer search text survives rerender");
  assert.match(h.node("customer-results").innerHTML, /Amy/);
  assert.ok(h.scrolls.some(([x,y]) => x === 14 && y === 44), "scroll restored");
});

test("mobile Admin reconnects and retains same tab, with periodic catchup and forced refresh", async () => {
  const h = createMobileHarness();
  await h.settle();
  const stream = h.streams[0];
  stream.emit("open");
  await h.flushTimers();
  assert.equal(h.requests.length, 12, "stream reconnection refreshes data");
  h.node("refresh").onclick();
  await h.settle();
  assert.equal(h.requests.length, 18, "manual refresh runs immediately");
  assert.match(mobileSource, /setInterval\(\(\)=>\{if\(authenticated&&!document\.hidden\)scheduleMobileRefresh\(\);\},60000\)/);
  assert.match(mobileSource, /window\.addEventListener\("pagehide",\(\)=>\{stream\?\.close\(\);stream=null;\}\)/);
  assert.match(mobileSource, /mobileRefreshRunning=false/);
  assert.match(mobileSource, /mobileRefreshPending=true/);
});

test("new website signup updates mobile Admin across Success, Home, Customers and Profiles without refresh", async () => {
  const h = createMobileHarness();
  await h.settle();
  assert.equal(h.node("content").innerHTML.includes("jill@example.test"), false);
  assert.match(h.node("content").innerHTML, /Registered customers/);
  const click = h.node("tabs").listeners.get("click");
  click({target: {closest: () => ({dataset: {tab: "success"}})}});
  // A newly created account is initially in /free-submissions, not paid orders.
  h.fixtures["/api/admin/free-submissions"] = [{
    id: "new-account", customerAccountId: "new-account", accountOnly: true,
    createdAt: "2026-10-10T12:30:00.000Z",
    profile: {firstName: "Jill", lastName: "New", email: "jill@example.test"},
    plan: {name: "No Paid Membership", profiles: 0}
  }];
  const requestsBeforeSignup = h.requests.length;
  h.streams[0].emit("data-change");
  await h.flushTimers();
  assert.equal(h.requests.length, requestsBeforeSignup + 6,
    "all six sources fetched even while viewing Success");
  click({target: {closest: () => ({dataset: {tab: "overview"}})}});
  assert.doesNotMatch(h.node("content").innerHTML, /Latest website signups/);
  assert.match(h.node("content").innerHTML, /Registered customers<\/small><strong>2<\/strong>/);
  click({target: {closest: () => ({dataset: {tab: "customers"}})}});
  assert.match(h.node("customer-results").innerHTML, /Jill New/);
  assert.match(h.node("customer-results").innerHTML, /No paid membership/);
  click({target: {closest: () => ({dataset: {tab: "profiles"}})}});
  assert.match(h.node("content").innerHTML, /Registered customers/);
  assert.ok(h.requests.includes("/api/admin/free-submissions"));
});

test("newly paid website accounts are not double-counted when snapshots overlap", async () => {
  const h = createMobileHarness();
  h.fixtures["/api/admin/free-submissions"] = [{
    id:"order1", customerAccountId:"user1", accountOnly:true,
    profile:{firstName:"Amy",email:"amy@example.test"}
  }];
  await h.settle();
  // Same customer exists in both API responses temporarily. The paid state wins.
  assert.match(h.node("content").innerHTML, /Registered customers/);
  assert.doesNotMatch(h.node("content").innerHTML, /New signups · no plan<\/small><strong>1<\/strong>/);
  assert.doesNotMatch(h.node("content").innerHTML, /Paid customers<\/small>/);
});
