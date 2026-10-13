import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const read = name => readFileSync(new URL("../" + name, import.meta.url), "utf8");
const html = read("public/admin.html");
const css = read("public/admin-workspace-tabs.css");
const workspace = read("public/admin-workspace-tabs.js");

test("paid customer summary gives all six children their own grid areas", () => {
  const summary = html.slice(html.indexOf('<summary class="customer-order-summary">'));
  assert.ok(summary.startsWith('<summary class="customer-order-summary">'));
  const markup = summary.slice(0, summary.indexOf('</summary>'));
  assert.match(markup, /class="customer-main"/);
  assert.equal((markup.match(/class="order-meta(?: order-status-meta)?"/g) || []).length, 4);
  assert.match(markup, /class="order-chevron"/);
  assert.match(css, /grid-template-areas:\s*"identity tier profiles payment state expand"\s*!important/);
  assert.match(css, /grid-template-columns:\s*minmax\(260px,2\.3fr\)[^;]*20px\s*!important/);
  for (const [position, area] of [[2,"tier"],[3,"profiles"],[4,"payment"]]) {
    assert.ok(css.includes('> .order-meta:nth-child(' + position + ') { grid-area: ' + area + '; }'));
  }
  assert.match(css, /> \.order-meta\.order-status-meta\s*\{ grid-area: state; \}/);
  assert.match(css, /> \.order-chevron\s*\{ grid-area: expand;/);
  assert.match(css, /grid-template-areas:\s*"identity identity tier profiles expand"\s*"payment payment state state expand"/);
  assert.match(css, /grid-template-areas:\s*"identity expand"\s*"tier profiles"\s*"payment state"/);
  assert.match(css, /grid-template-areas:\s*"identity expand"\s*"tier profiles"\s*"payment payment"\s*"state state"/);
  assert.match(css, /\.customer-order-summary > \.order-meta\s*\{\s*display: block !important;/);
});

test("compact bell popover scrolls instead of covering navigation", () => {
  assert.match(css, /#adminNotificationList\s*\{[\s\S]*?max-height:\s*min\(238px, calc\(100dvh - 120px\)\) !important/);
  assert.match(css, /#adminNotificationList\s*\{[\s\S]*?overflow-y: auto !important/);
  assert.match(css, /#adminNotificationList > button\.admin-notification-item\s*\{/);
  assert.match(workspace, /notifications\.open = false;/);
  assert.match(workspace, /document\.addEventListener\("pointerdown", event =>/);
  assert.match(workspace, /document\.addEventListener\("keydown", event =>/);
  assert.match(workspace, /event\.key === "Escape"/);
  assert.match(workspace, /aria-expanded/);
  assert.match(html, /profile\.retailer \? ` ·/);
  assert.match(html, /profile\.slot \? ` #/);
});

test("bell open state is excluded from the consolidated Admin dropdown manager", () => {
  assert.match(html, /detail\.id === "adminNotifications"/);
  assert.match(html, /sng-details-v3:/);
  assert.doesNotMatch(html, /sng-admin-details:/);
  assert.doesNotMatch(html, /sng-details-v2:/);
  assert.match(html, /admin-workspace-tabs\.css\?v=20261013-sixcol-1/);
  assert.match(html, /admin-workspace-tabs\.js\?v=20261013-biometric-1/);
});

test("Admin JS and inline template scripts parse", () => {
  assert.doesNotThrow(() => new vm.Script(workspace));
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (match[1].trim()) assert.doesNotThrow(() => new vm.Script(match[1]));
  }
});
