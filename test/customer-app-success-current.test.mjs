import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dashboardTotals, selectedOrders} from "../public/app-dashboard-data.js";

const app=readFileSync(new URL("../public/app-dashboard.js",import.meta.url),"utf8");
const styles=readFileSync(new URL("../public/app-dashboard.css",import.meta.url),"utf8");

test("Customer app has a dedicated Success nav tab without removing current features",()=>{
  assert.match(app,/const navLabels = \['home', 'success', 'tracking', 'profile', 'products', 'history'\]/);
  assert.match(app,/success: 'success'/);
  assert.match(app,/if \(view === 'success'\)/);
  assert.match(app,/if \(view === 'drops'\) html = dropEditor\.render\(\)/);
  assert.match(app,/cancelledOrders/);
  assert.match(styles,/grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/);
});
test("Success UI never displays order numbers, shipping, addresses or tracking",()=>{
  const start=app.indexOf("    if (view === 'success') {");
  const end=app.indexOf("    if (view === 'tracking')",start);
  assert.ok(start>=0&&end>start);
  const ui=app.slice(start,end);
  for(const privateField of ["orderNumber","trackingNumber","shipping.address","trackingSheetHtml","orderRows("]){
    assert.equal(ui.includes(privateField),false,privateField);
  }
  assert.match(ui,/\[1, 7, 30\]/);
  assert.match(ui,/breakdown\('Orders by retailer'/);
  assert.match(ui,/Products purchased/);
});
test("24h, 7d and 30d metrics are independent and include only confirmed noncancelled rows",()=>{
  const now=new Date("2026-11-14T20:00:00.000Z");
  const row=(hoursAgo,value,quantity=1,status="confirmed")=>({
    checkoutAt:new Date(now.getTime()-hoursAgo*3600000).toISOString(),
    orderTotalKnown:true,orderTotal:value,itemCount:quantity,status
  });
  const rows=[row(1,12,2),row(48,30),row(192,100),row(3,14,1,"cancelled")];
  assert.deepEqual([1,7,30].map(days=>dashboardTotals(selectedOrders(rows,days,now)).spend),[12,42,142]);
  assert.deepEqual([1,7,30].map(days=>dashboardTotals(selectedOrders(rows,days,now)).orders),[1,2,3]);
});
test("Fetching Success includes 30-day baseline even when 24h or custom period is selected",()=>{
  assert.match(app,/if \(view === 'success' && days !== 'all'\)/);
  assert.match(app,/const thirty = checkoutRequestRange\(30, new Date\(\)\)/);
  assert.match(app,/Math\.min\(Date\.parse\(requestedRange\.startAt\), Date\.parse\(thirty\.startAt\)\)/);
  assert.match(app,/if \(view === 'success'\) void refresh\(\)/);
});
