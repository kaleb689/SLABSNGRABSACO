import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const admin = fs.readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
const customer = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

function section(source, first, last) {
  const start = source.indexOf(first);
  const end = source.indexOf(last, start);
  assert.ok(start >= 0 && end > start, "refresh block is present");
  return source.slice(start, end);
}

function harness(script, side) {
  let editing = false;
  let nextTimer = 0;
  const timers = new Map();
  const requests = [];
  const document = {
    hidden: false,
    visibilityState: "visible",
    activeElement: {
      matches: () => editing,
      closest: () => null
    },
    addEventListener: () => {},
    querySelector: () => ({ dataset: { accountTab: "membership" } })
  };
  const window = {
    scrollX: 14,
    scrollY: 25,
    scrollTo: (x, y) => requests.push(["scroll", x, y]),
    addEventListener: () => {},
    refreshAdminPoolSearch: async () => requests.push(["pool"])
  };
  const sandbox = {
    document,
    window,
    console,
    setTimeout: fn => {
      const id = ++nextTimer;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: id => timers.delete(id),
    setInterval: () => {},
    requestAnimationFrame: fn => fn(),
    MutationObserver: class { observe() {} },
    EventSource: class {
      constructor(url) { requests.push(["stream", url]); }
      addEventListener() {}
      close() {}
    },
    dashboard: { hidden: false },
    submissionTypeFilter: { value: "paid" },
    load: async () => requests.push(["admin-load"]),
    state: { customer: { id: "member" } },
    ADMIN_PREVIEW_MODE: false,
    loadMemberProfile: async (...args) => requests.push(["customer-load", ...args]),
    switchAccountTab: tab => requests.push(["tab", tab]),
    loadSuccessDashboard: async () => requests.push(["success"])
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(script, context, { filename: side + "-live-block.js" });
  return {
    requests,
    setEditing(value) { editing = value; },
    schedule() { vm.runInContext(
      side === "admin" ? "scheduleAdminLiveRefresh()" : "scheduleCustomerLiveRefresh()",
      context
    ); },
    async flush() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach(fn => fn());
      await new Promise(resolve => setImmediate(resolve));
    }
  };
}

test("all successful API mutations publish generic updates, never route identifiers", () => {
  assert.match(server, /req\.path\.startsWith\("\/api\/"\)/);
  assert.match(server, /res\.statusCode >= 200 && res\.statusCode < 400/);
  assert.match(server, /broadcastLiveDataChange\(\);/);
  assert.doesNotMatch(server, /broadcastLiveDataChange\(\x60\$\{method\} \$\{req\.path\}\x60\)/);
  assert.match(server, /openSuccessEventStream\(req, res, adminLiveDataListeners\)/);
  assert.match(server, /openSuccessEventStream\(req, res, customerLiveDataListeners\)/);
});

test("Admin live updates refresh its management view and pool search, but not active edits", async () => {
  const block = section(admin, "let adminLiveRefreshTimer = null;", "/* =========================================\n   INITIALIZE");
  const h = harness(block, "admin");
  assert.ok(h.requests.some(item => item[0] === "stream" && item[1] === "/api/admin/live/events"));
  h.schedule();
  await h.flush();
  assert.equal(h.requests.filter(item => item[0] === "admin-load").length, 1);
  assert.equal(h.requests.filter(item => item[0] === "pool").length, 1);
  assert.ok(h.requests.some(item => item[0] === "scroll" && item[1] === 14 && item[2] === 25));
  h.setEditing(true);
  h.schedule();
  await h.flush();
  assert.equal(h.requests.filter(item => item[0] === "admin-load").length, 1);
  h.setEditing(false);
  h.schedule();
  await h.flush();
  assert.equal(h.requests.filter(item => item[0] === "admin-load").length, 2);
});

test("Customer live updates run silently and retain active tab, while typing blocks rerender", async () => {
  const block = section(customer, "let customerLiveRefreshTimer = null;", "function homepageSampleSuccessData()");
  const h = harness(block, "customer");
  assert.ok(h.requests.some(item => item[0] === "stream" && item[1] === "/api/account/live/events"));
  h.setEditing(true);
  h.schedule();
  await h.flush();
  assert.equal(h.requests.filter(item => item[0] === "customer-load").length, 0);
  h.setEditing(false);
  h.schedule();
  await h.flush();
  const loaded = h.requests.filter(item => item[0] === "customer-load");
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0], ["customer-load", true, true]);
  assert.ok(h.requests.some(item => item[0] === "tab" && item[1] === "membership"));
  assert.match(customer, /await loadCustomerNotifications\(\{ showPopup: !background \}\)/);
  assert.match(customer, /!ANY_ADMIN_PREVIEW_MODE && !background && !accountOnboardingWasDismissed\(\)/);
});
