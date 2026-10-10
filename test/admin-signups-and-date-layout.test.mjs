import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read=path=>fs.readFileSync(new URL("../"+path,import.meta.url),"utf8");
const css=read("public/custom-date-controls.css");
const app=read("public/app-dashboard.js");
const admin=read("public/admin-mobile.js");
const full=read("public/admin-success.html");

test("customer and Admin global date filters fit fully without horizontal scrolling",()=>{
  assert.match(css,/body\.app-dashboard\.app-signed-in #app-dashboard \.sng-range,\s*body\.sng-admin-app #workspace \.admin-spend-ranges,\s*body\.admin-page #dashboard \.periods\s*\{/);
  assert.match(css,/grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(css,/grid-auto-flow:row/);
  assert.match(css,/overflow-x:visible/);
  assert.match(css,/grid-column:span 2/);
  assert.match(css,/width:100%/);
  assert.match(css,/@media\(max-width:355px\)/);
  assert.match(app,/const presets=\[1,7,30,90,'ytd','all'\]/);
  assert.match(admin,/const ranges=\[\[1,"24H"\],\[7,"7D"\],\[30,"30D"\],\[90,"90D"\],\["ytd","YTD"\],\["all","ALL"\]\]/);
  assert.match(full,/const periods = \[\[1,'24H'\],\[7,'7D'\],\[30,'30D'\],\[90,'90D'\],\['ytd','YTD'\],\['all','ALL'\]\]/);
});

test("calendar stays accessible and customer drilldowns use a four-column row",()=>{
  assert.match(css,/body\.sng-admin-app #workspace \.success-user-period,\s*body\.admin-page #dashboard \.user-periods\s*\{/);
  assert.match(css,/min-height:44px/);
  assert.match(css,/button\.sng-calendar-button svg/);
  assert.match(app,/data-app-calendar/);
  assert.match(admin,/data-success-user-calendar/);
  assert.match(full,/data-user-calendar/);
  assert.match(css,/@media\(min-width:820px\)/);
});

test("registered and unpaid website signups are included in Admin live data, not guessed from paid orders",()=>{
  assert.match(admin,/get\("\/api\/admin\/submissions"\),\s*get\("\/api\/admin\/free-submissions"\)/);
  assert.match(admin,/stream\.addEventListener\("data-change",scheduleMobileRefresh\)/);
  assert.match(admin,/stream\.addEventListener\("checkout",scheduleMobileRefresh\)/);
  assert.match(admin,/accountOnly===true/);
  assert.doesNotMatch(admin,/collapsiblePanel\("Latest website signups"/);
  assert.match(admin,/Registered customers/);
  assert.match(admin,/ACTIVE PAID MEMBERSHIPS/);
  assert.match(admin,/Awaiting activation/);
  assert.match(admin,/APP USERS · 7 DAYS/);
  assert.match(admin,/data-view/);
  const customerPage=read("public/index.html");
  const adminPage=read("public/admin-app.html");
  const fullAdminPage=read("public/admin-success.html");
  for(const page of [customerPage,adminPage,fullAdminPage]){
    assert.match(page,/custom-date-controls\.css\?v=20261010-fit2/);
  }
  assert.match(adminPage,/admin-mobile\.js\?v=33-member-activation-20261010/);
});
