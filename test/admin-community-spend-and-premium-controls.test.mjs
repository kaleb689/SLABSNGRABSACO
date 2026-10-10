import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifiedRetailerOrderTotal } from "../retailer-order-total.js";
const source=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");

test("all-order Admin reporting includes unmatched confirmed webhooks but does not expose source identities",()=>{
  const server=source("server.js");
  const from=server.indexOf('app.get("/api/admin/success-overview"');
  const to=server.indexOf('app.get("/api/admin/checkout-paid-verification"',from);
  assert.ok(from>0&&to>from);
  const endpoint=server.slice(from,to);
  assert.match(endpoint,/app.get\("\/api\/admin\/success-overview", requireAdmin/);
  assert.match(endpoint,/const confirmed = allRecords.filter\(confirmedDiscordPurchase\)/);
  assert.match(endpoint,/const communityRecords = confirmed.map\(record =>/);
  assert.match(endpoint,/orderTotal: safe.orderTotal, orderTotalKnown: safe.orderTotalKnown/);
  assert.match(endpoint,/ok:true,records,communityRecords,unmatchedCount/);
  const community=endpoint.slice(endpoint.indexOf("const communityRecords ="),endpoint.indexOf('res.setHeader("Cache-Control"',endpoint.indexOf("const communityRecords =")));
  assert.doesNotMatch(community,/orderNumber\s*:/);
  assert.doesNotMatch(community,/customerAccountId\s*:/);
  assert.doesNotMatch(community,/sourceProfileLabel\s*:/);
  assert.match(endpoint,/\.filter\(record => record.customerAccountId &&/);
  assert.match(endpoint,/spent: confirmed.reduce\(\(sum, record\) =>/);
});

test("hiding a product from a public view cannot mutate the verified final amount charged",()=>{
  const server=source("server.js");
  const start=server.indexOf("function visibleDiscordSuccessRecords(");
  const end=server.indexOf("function isAuthoritativeCheckoutRecord(",start);
  assert.ok(start>0&&end>start);
  const snippet=server.slice(start,end);
  assert.match(snippet,/const removedItems/);
  assert.match(snippet,/items,\s*itemCount: items.reduce/);
  assert.doesNotMatch(snippet,/removedValue|orderTotal\s*=\s*removedValue/);
});

test("authentic retailer paid labels, split HTML cells and USD notation are supported without trusting subtotals",()=>{
  assert.equal(verifiedRetailerOrderTotal("Total charged to your card: $52.78"),52.78);
  assert.equal(verifiedRetailerOrderTotal("Total paid today: $22.45"),22.45);
  assert.equal(verifiedRetailerOrderTotal("Order total (USD): $32.90"),32.90);
  assert.equal(verifiedRetailerOrderTotal("Grand total: US$49.99"),49.99);
  assert.equal(verifiedRetailerOrderTotal("Payment total:\nUSD 17.29"),17.29);
  assert.equal(verifiedRetailerOrderTotal("",'<tr><td>Final order total</td><td>US$69.23</td></tr>'),69.23);
  assert.equal(verifiedRetailerOrderTotal("Subtotal: $35.00\nEstimated total: $37.80"),null);
  assert.equal(verifiedRetailerOrderTotal("Amount due: $37.80"),null);
  assert.equal(verifiedRetailerOrderTotal("Total paid: $39.00\nTotal charged: $45.00"),null);
});

test("Admin Success uses global confirmed records, independent customer breakdowns, and seven live periods",()=>{
  const js=source("public/admin-mobile.js");
  const html=source("public/admin-success.html");
  const app=source("public/admin-app.html");
  const admin=source("public/admin.html");
  const customer=source("public/index.html");
  const css=source("public/sng-premium-controls.css");
  assert.match(js,/data.success\?\.communityRecords/);
  assert.match(js,/allSuccess=Array.isArray\(data.success\?\.records\)\?data.success.records.filter\(x=>Boolean\(x.customerAccountId\)\)/);
  assert.match(js,/const inRange=allCommunity.filter/);
  assert.match(js,/successUserDays=new Map/);
  assert.match(js,/\["all","linked","unmatched"\]/);
  assert.match(js,/\[\[1,"24H"\],\[7,"7D"\],\[30,"30D"\],\[90,"90D"\]/);
  assert.match(html,/\/api\/admin\/success-overview/);
  assert.match(html,/communityRecords/);
  assert.match(html,/historical\.historicalSpent/);
  assert.match(html,/id="customer-panel"/);
  assert.match(html,/id="product-panel"/);
  assert.match(html,/userPeriods=new Map/);
  assert.match(html,/credentials:'same-origin',cache:'no-store'/);
  assert.match(html,/setInterval\(\(\)=>\{if\(!document.hidden\)void refresh\(\);\},15000\)/);
  for (const page of [app,admin,customer]) assert.match(page,/sng-premium-controls\.css\?v=2/);
  assert.match(app,/admin-mobile\.js\?v=33-member-activation-20261010/);
  assert.match(js,/\/admin-success\.html/);
  assert.match(admin,/\/admin-success\.html/);
  assert.match(css,/min-height:46px/);
  assert.match(css,/appearance:none/);
  assert.match(css,/data-admin-mobile-theme="light"/);
  assert.match(css,/aria-pressed="true"/);
});
