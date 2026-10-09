import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
const script = fs.readFileSync(new URL("../public/admin-pool-search.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../public/admin-pool-search.css", import.meta.url), "utf8");

function harness() {
  const elements = new Map();
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  function node(id) {
    if (!elements.has(id)) {
      const listeners = new Map();
      elements.set(id, {
        id, value: "", textContent: "", open: false, hidden: true,
        disabled: false, dataset: {}, listeners, children: [],
        addEventListener(name, handler) { listeners.set(name, handler); },
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; },
        add(option) { this.children.push(option); }
      });
    }
    return elements.get(id);
  }
  const document = {
    getElementById: node,
    createElement(tag) { return node("created-" + tag + "-" + Math.random()); }
  };
  const window = { confirm: () => true };
  const sandbox = {
    document, window, URLSearchParams,
    Option: class { constructor(label, value) { this.label = label; this.value = value; } },
    fetch: async path => {
      requests.push(path);
      return { ok: true, status: 200, json: async () => ({
        profiles: [], customers: [], total: 24, page: Number(new URL(path, "https://example.test").searchParams.get("page")),
        pageSize: 10, pageCount: 3
      }) };
    },
    MutationObserver: class { observe() {} },
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  node("adminPoolRetailer").value = "all";
  node("adminPoolStatus").value = "all";
  vm.runInNewContext(script, sandbox, { filename: "admin-pool-search.js" });
  async function settle() {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  }
  async function flush() {
    const scheduled = [...timers.values()];
    timers.clear();
    for (const callback of scheduled) callback();
    await settle();
  }
  return { node, window, requests, settle, flush };
}

test("View Available Profiles is a collapsed, keyboard-accessible dropdown containing existing search and pagination", () => {
  const start = html.indexOf('<details id="adminPoolDisclosure"');
  const end = html.indexOf("</details>", start);
  assert.ok(start > 0 && end > start, "profile pool disclosure exists");
  const block = html.slice(start, end);
  assert.match(block, /<summary id="adminPoolBrowserTitle"/);
  assert.match(block, /VIEW AVAILABLE PROFILES/);
  assert.doesNotMatch(block.slice(0, block.indexOf(">")), /\sopen(?:\s|=|$)/, "starts collapsed");
  for (const control of ["adminPoolQuery", "adminPoolRetailer", "adminPoolStatus", "adminPoolSearchButton", "adminPoolResults", "adminPoolPrevious", "adminPoolNext"]) {
    assert.ok(block.includes('id="' + control + '"'), control + " stays inside dropdown");
  }
  assert.match(css, /admin-pool-disclosure\[open\]/);
  assert.match(css, /admin-pool-browser-toggle:focus-visible/);
});

test("opening loads profiles, existing filters and pagination work, closing does not fetch or lose state", async () => {
  const h = harness();
  const disclosure = h.node("adminPoolDisclosure");
  assert.equal(h.requests.length, 0, "no profile pool request while collapsed");

  await h.window.refreshAdminPoolSearch();
  assert.equal(h.requests.length, 0, "background refresh does not reopen or fetch hidden profiles");

  disclosure.open = true;
  disclosure.listeners.get("toggle")();
  await h.settle();
  assert.equal(h.requests.length, 1, "opening fetches latest profiles");
  assert.match(h.requests[0], /page=1/);

  h.node("adminPoolQuery").value = "member@example.test";
  h.node("adminPoolRetailer").value = "target";
  h.node("adminPoolStatus").value = "available";
  h.node("adminPoolQuery").listeners.get("input")();
  await h.flush();
  assert.equal(h.requests.length, 2, "search uses one debounced fetch");
  assert.match(h.requests[1], /member%40example.test/);
  assert.match(h.requests[1], /retailer=target/);
  assert.match(h.requests[1], /status=available/);

  h.node("adminPoolNext").listeners.get("click")();
  await h.settle();
  assert.match(h.requests.at(-1), /page=2/, "Next continues to work");

  disclosure.open = false;
  disclosure.listeners.get("toggle")();
  await h.window.refreshAdminPoolSearch();
  assert.equal(h.requests.length, 3, "closing suppresses subsequent background requests");

  disclosure.open = true;
  disclosure.listeners.get("toggle")();
  await h.settle();
  assert.equal(h.requests.length, 4, "reopening gets fresh matching profiles");
  assert.match(h.requests.at(-1), /page=2/, "page is preserved on reopen");
  assert.equal(h.node("adminPoolQuery").value, "member@example.test");
  assert.equal(h.node("adminPoolRetailer").value, "target");
  assert.equal(h.node("adminPoolStatus").value, "available");
});
