import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const read=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");

test("shipping sheet offers official server-provided direct carrier link or a pending label", () => {
  const dashboard=read("public/app-dashboard.js");
  assert.match(dashboard,/Track with carrier/);
  assert.match(dashboard,/Carrier tracking link pending verification/);
  assert.match(dashboard,/trackingNumber/);
  assert.match(dashboard,/shipping\.estimatedDelivery/);
  assert.match(dashboard,/shipping\.events/);
  assert.match(dashboard,/order\.items/);
});

test("SSE reconciliation preserves scroll and expanded tracking history", () => {
  const dashboard=read("public/app-dashboard.js");
  assert.match(dashboard,/function updateTrackingSheetMarkup/);
  assert.match(dashboard,/priorHistoryOpen/);
  assert.match(dashboard,/nextScroller\.scrollTop = previousScroll/);
  assert.match(dashboard,/updateTrackingSheetMarkup\(markup\)/);
  assert.match(dashboard,/if \(content\._sngMarkup !== html\)/);
});

test("admin and customer product photographs never fall back to company logo", () => {
  for(const path of ["public/admin-mobile.js","public/admin-success.js","public/app.js","public/app-dashboard.js"]){
    const source=read(path);
    const productSection=path==="public/app.js"?
      source.slice(source.indexOf("function renderSuccessProductPreview("),source.indexOf("function renderSuccessError(")):source;
    assert.doesNotMatch(productSection,/slabsngrabs-aco-logo-transparent\.png/,
      path+" must not use brand image for a missing product");
  }
  assert.match(read("public/admin-mobile.js"),/product-image-pending\.svg/);
  assert.match(read("public/app-dashboard.js"),/product-image-pending\.svg/);
  assert.match(read("public/app.js"),/onerror="this\.onerror=null;this\.src=/);
});
