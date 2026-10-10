import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = path => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const page = read("../public/index.html");
const style = read("../public/app-ui-uniform.css");
const dashboard = read("../public/app-dashboard.js");
const pwa = read("../public/pwa.js");

test("approved customer app stylesheet loads after premium controls", () => {
  const premium = page.indexOf('href="/sng-premium-controls.css?v=2"');
  const uniform = page.indexOf('href="/app-ui-uniform.css?v=20261010"');
  assert.ok(premium !== -1, "Premium controls stylesheet retained");
  assert.ok(uniform > premium, "Approved final overrides must load last");
  assert.match(page, /src="\/app-dashboard\.js\?v=20261010-member-v3"/);
});

test("five navigation tiles have real spacing and readable labels", () => {
  assert.match(dashboard, /const navLabels = \['home', 'tracking', 'profile', 'products', 'history'\]/);
  assert.match(style, /\.sng-app-nav \{\s*grid-template-columns:repeat\(5,minmax\(0,1fr\)\);\s*gap:/);
  assert.match(style, /\.sng-app-nav > button span \{[^}]*font-size:clamp\(9px/);
  assert.match(style, /@media\(max-width:360px\)/);
});

test("top-right actions and refined gear use matching accessible icons", () => {
  assert.match(style, /\.sng-app-header-actions \{[^}]*gap:/);
  assert.match(style, /\.sng-app-header-actions > button \{[^}]*border-radius:14px!important/);
  assert.match(dashboard, /,settings: '<path d="M10\.2 2\.5h3\.6l\.5 2\.3/);
  assert.match(dashboard, /data-app-view="settings" aria-label="Settings"/);
  assert.match(dashboard, /data-app-theme aria-label="Switch to day mode"/);
});

test("notification settings keep their functionality but unify all buttons", () => {
  for (const action of ["enable-push", "phone-settings", "disable-push", "close-settings"]) {
    assert.match(pwa, new RegExp('data-' + action));
  }
  assert.match(pwa, /\/api\/account\/push-preferences/);
  assert.match(pwa, /\/api\/account\/push-subscriptions/);
  assert.match(style, /dialog\.app-notification-dialog \.account-onboarding-actions > button\[data-disable-push\] \{/);
  assert.match(style, /background:linear-gradient\(135deg,#262052,#05384e\) padding-box/);
  assert.match(style, /dialog\.app-notification-dialog form button\[type="submit"\] \{/);
  assert.match(style, /max-height:min\(87dvh,calc\(100dvh - 26px\)\)/);
});

test("day theme and reduced motion are preserved", () => {
  assert.match(style, /body\.app-dashboard\[data-app-theme="day"\]/);
  assert.match(style, /@media\(prefers-reduced-motion:reduce\)/);
});
