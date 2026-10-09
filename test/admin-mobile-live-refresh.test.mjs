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
  return { node, document, window, streams, requests, scrolls, settle, flushTimers,
    onDocument(name) { return documentListeners.get(name); } };
}

test("mobile Admin automatically syncs without interrupting a focused customer search", async () => {
  const h = createMobileHarness();
  await h.settle();
  assert.equal(h.requests.length, 5, "initial dashboard fetched four management sources and Success");
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
  assert.equal(h.requests.length, 5, "live event cannot overwrite focused form");

  h.document.activeElement = null;
  h.onDocument("focusout")();
  await h.flushTimers();
  assert.equal(h.requests.length, 10, "pending event reloads when input loses focus");
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
  assert.equal(h.requests.length, 10, "stream reconnection refreshes data");
  h.node("refresh").onclick();
  await h.settle();
  assert.equal(h.requests.length, 15, "manual refresh runs immediately");
  assert.match(mobileSource, /setInterval\(\(\)=>\{if\(authenticated&&!document\.hidden\)scheduleMobileRefresh\(\);\},60000\)/);
  assert.match(mobileSource, /window\.addEventListener\("pagehide",\(\)=>\{stream\?\.close\(\);stream=null;\}\)/);
  assert.match(mobileSource, /mobileRefreshRunning=false/);
  assert.match(mobileSource, /mobileRefreshPending=true/);
});
