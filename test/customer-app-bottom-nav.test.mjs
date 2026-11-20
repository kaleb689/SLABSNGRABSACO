import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const app=fs.readFileSync(new URL("../public/app-dashboard.js",import.meta.url),"utf8");
const css=fs.readFileSync(new URL("../public/app-ui-uniform.css",import.meta.url),"utf8");
const html=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
test("five small customer tabs precede equal-width Home and Messages actions",()=>{
  assert.match(app,/const navLabels = \['success', 'tracking', 'profile', 'products', 'history', 'home', 'messages'\]/);
  assert.match(css,/grid-template-columns:repeat\(10,minmax\(0,1fr\)\)!important/);
  assert.match(css,/\.sng-app-nav > button \{\s*grid-column:span 2/);
  assert.match(css,/\.sng-app-nav > button\[data-app-view="messages"\] \{\s*grid-column:span 5/);
  assert.match(css,/white-space:normal/);
});
test("new navigation assets are cache-busted for installed PWAs",()=>{
  assert.match(html,/app-ui-uniform\.css\?v=20261119-nav2/);
  assert.match(html,/app-dashboard\.js\?v=20261119-nav2/);
});
