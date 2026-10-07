import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../public/pwa.js", import.meta.url), "utf8");
function surface({ native = true, frame = false, search = "", hash = "#home" } = {}) {
  const timers = [];
  const classes = () => {
    const values = new Set();
    return { add: v => values.add(v), contains: v => values.has(v),
      toggle: (v, enabled) => enabled ? values.add(v) : values.delete(v) };
  };
  function element(tag) {
    return { tag, dataset: {}, children: [], attributes: {}, events: {}, classList: classes(),
      setAttribute(k, v) { this.attributes[k] = v; }, removeAttribute(k) { delete this.attributes[k]; },
      append(...children) { this.children.push(...children); },
      addEventListener(k, f) { this.events[k] = f; },
      querySelectorAll() { return this.children.filter(c => c.tag === "a"); } };
  }
  const tabs = Object.fromEntries(["membership", "success"].map(id => [id, { classList: classes(),
    click() { for (const [name, tab] of Object.entries(tabs)) tab.classList.toggle("active", name === id); } }]));
  tabs.membership.click();
  const body = element("body");
  const location = { search, hash };
  const window = { matchMedia: () => ({matches: native}), self: {}, top: {}, events: {},
    addEventListener(k, f) { this.events[k] = f; } };
  if (!frame) window.top = window.self;
  const document = { body, createElement: element, createTextNode: text => ({ text }), addEventListener() {},
    querySelector(selector) { return tabs[selector.match(/data-account-tab="([^"]+)"/)?.[1]]; } };
  vm.runInNewContext(source, { window, document, location, navigator: { userAgent: "Browser" },
    URLSearchParams, setTimeout: f => timers.push(f) });
  return { body, window, location, tabs, flush: () => { while (timers.length) timers.shift()(); } };
}
test("ordinary website does not gain app navigation", () => {
  const s = surface({ native: false });
  assert.equal(s.body.children.length, 0);
  assert.equal(s.body.classList.contains("installed-app"), false);
});
test("embedded Success preview does not gain app navigation", () => {
  assert.equal(surface({ frame: true }).body.children.length, 0);
});
test("installed app has five accessible destinations and follows hash routing", () => {
  const s = surface();
  const links = s.body.children[0].children;
  assert.equal(links.length, 5);
  assert.equal(links[0].attributes["aria-current"], "page");
  s.location.hash = "#pricing";
  s.window.events.hashchange();
  assert.equal(links[1].attributes["aria-current"], "page");
  assert.equal(links[0].attributes["aria-current"], undefined);
});
test("Success and Profile switch tabs even when they share the same URL", () => {
  const s = surface({ hash: "#my-profile" });
  const links = s.body.children[0].children;
  links[3].events.click(); s.flush();
  assert.equal(s.tabs.success.classList.contains("active"), true);
  assert.equal(links[3].attributes["aria-current"], "page");
  links[2].events.click(); s.flush();
  assert.equal(s.tabs.membership.classList.contains("active"), true);
  assert.equal(links[2].attributes["aria-current"], "page");
});
