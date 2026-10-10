import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifiedRetailerOrderTotal } from "../retailer-order-total.js";
import { adminVerifiedReceiptTotal } from "../checkout-admin-receipt-policy.js";
import { verifiedOrderSpend, dashboardTotals, dashboardActivity } from "../public/app-dashboard-data.js";

const source=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");

test("verified retailer receipts parse final charged totals from real plaintext and HTML layouts",()=>{
  assert.equal(verifiedRetailerOrderTotal("Order total: $42.57"),42.57);
  assert.equal(verifiedRetailerOrderTotal("Total paid:\n$49.23"),49.23);
  assert.equal(verifiedRetailerOrderTotal("Subtotal: $39.20\nOrder total\n$41.99"),41.99);
  assert.equal(verifiedRetailerOrderTotal("Payment total: USD 29.45"),29.45);
  assert.equal(verifiedRetailerOrderTotal("",
    '<table><tr><td>Subtotal</td><td>$45.90</td></tr><tr><td>Order total</td><td>$49.32</td></tr></table>'),49.32);
  assert.equal(verifiedRetailerOrderTotal("",
    '<div>Final Total</div><div>US$52.10</div>'),52.1);
  assert.equal(verifiedRetailerOrderTotal("Subtotal: $25.00\nTax: $2.35"),null);
  assert.equal(verifiedRetailerOrderTotal("Estimated total: $28.40"),null);
  assert.equal(verifiedRetailerOrderTotal("Amount due: $28.40"),null);
  assert.equal(verifiedRetailerOrderTotal("Item price: $19.99"),null);
  assert.equal(verifiedRetailerOrderTotal("Total paid: $42.00\nTotal charged: $43.00"),null);
  assert.equal(verifiedRetailerOrderTotal("Please pay 123456789"),null);
});

test("verified receipt entry requires exact order number and explicit Admin attestation",()=>{
  const order={orderNumber:"T-123456789"};
  const entry={paidTotal:"57.82",orderNumberConfirmation:"t-123456789",verifiedReceipt:true};
  assert.equal(adminVerifiedReceiptTotal(entry,order),57.82);
  assert.equal(adminVerifiedReceiptTotal({...entry,paidTotal:"57"},order),57);
  assert.equal(adminVerifiedReceiptTotal({...entry,paidTotal:"0.01"},order),.01);
  assert.equal(adminVerifiedReceiptTotal({...entry,verifiedReceipt:false},order),null);
  assert.equal(adminVerifiedReceiptTotal({...entry,orderNumberConfirmation:"T-123456780"},order),null);
  assert.equal(adminVerifiedReceiptTotal(entry,{orderNumber:""}),null);
  for(const price of ["",0,"0","-2.00","9.999","$20.00","NaN","1e3","99999999.99","Infinity"]){
    assert.equal(adminVerifiedReceiptTotal({...entry,paidTotal:price},order),null);
  }
});

test("trusted business mailbox can enrich an ownerless confirmed Discord checkout without creating or assigning an order",()=>{
  const server=source("server.js");
  const start=server.indexOf("async function scanMailboxForShipping(");
  const finish=server.indexOf("function startShippingTrackerScheduler(",start);
  const tracker=server.slice(start,finish);
  assert.ok(start>0&&finish>start);
  assert.match(tracker,/const unmatchedBusinessReceipt = Boolean\(mailbox\.managedHost/);
  assert.match(tracker,/matchVerifiedWebhookEmail\(records/);
  assert.match(tracker,/if \(!account \|\| !status\) continue/);
  assert.match(tracker,/businessPriceCandidates = records\.filter/);
  assert.match(tracker,/confirmedDiscordPurchase\(record\)/);
  assert.match(tracker,/}, businessPriceCandidates, accountsById, pendingChanges\)/);
  assert.match(tracker,/String\(update\.customerAccountId \|\| ""\)/);
  assert.match(tracker,/let receiptChanged = false/);
  assert.match(tracker,/changedAccounts\.size \|\| receiptChanged/);
  assert.match(tracker,/queueDiscordSuccessScan\(350\)/);
  assert.doesNotMatch(tracker,/record\.customerAccountId\s*=/);
});

test("manual checkout price endpoint is admin-only, audited, existing-record-only and deduplicated",()=>{
  const server=source("server.js");
  const first=server.indexOf('app.get("/api/admin/checkout-paid-verification"');
  const last=server.indexOf('app.get("/api/admin/discord-success-status"',first);
  assert.ok(first>0&&last>first);
  const segment=server.slice(first,last);
  assert.match(segment,/app\.get\("\/api\/admin\/checkout-paid-verification", requireAdmin/);
  assert.match(segment,/app\.post\("\/api\/admin\/checkout-paid-verification", requireAdmin/);
  assert.match(segment,/isAuthoritativeCheckoutRecord\(item, source\.channels\[0\]\)/);
  assert.match(segment,/confirmedDiscordPurchase\(item\)/);
  assert.match(segment,/isVerifiedDiscordCheckout\(item\)/);
  assert.match(segment,/checkoutPaidAmount\(order\) !== null/);
  assert.match(segment,/adminVerifiedReceiptTotal\(req\.body, order\)/);
  assert.match(segment,/withSuccessStoreLock/);
  assert.match(segment,/await saveSuccessCheckouts\(records\)/);
  assert.match(segment,/checkout-price-verification-audit\.json/);
  assert.match(segment,/broadcastLiveDataChange\("checkout-paid-verified"\)/);
  assert.match(segment,/queueDiscordSuccessScan\(350\)/);
  assert.doesNotMatch(segment,/recordSuccessCheckout\(/);
  assert.doesNotMatch(segment,/order\.customerAccountId\s*=/);
});

test("customer lifetime totals and charts exclude prices that were never verified",()=>{
  const priced={checkoutAt:"2026-10-09T12:00:00Z",orderTotal:42.35,orderTotalKnown:true,retailer:"Target",items:[]};
  const unknown={checkoutAt:"2026-10-09T13:00:00Z",orderTotal:102.99,orderTotalKnown:false,retailer:"PKC",items:[]};
  assert.equal(verifiedOrderSpend(priced),42.35);
  assert.equal(verifiedOrderSpend(unknown),0);
  assert.equal(verifiedOrderSpend({orderTotal:999,orderTotalKnown:false}),0);
  assert.equal(dashboardTotals([priced,unknown]).spend,42.35);
  const buckets=dashboardActivity([priced,unknown],1,new Date("2026-10-09T18:00:00Z"));
  assert.equal(buckets.reduce((sum,x)=>sum+x.value,0),42.35);
  const server=source("server.js");
  assert.match(server,/retailerCheckoutRecords\.reduce\(\(sum, order\) =>\s*sum \+ \(checkoutPaidAmount\(order\) \?\? 0\), 0\)/);
});

test("Admin and customer style files load vivid controls with light/dark modes and tap-safe date filters",()=>{
  const app=source("public/admin-app.html"),site=source("public/index.html"),admin=source("public/admin.html");
  const mobile=source("public/admin-mobile-controls.css"),shared=source("public/sng-controls.css");
  const script=source("public/admin-mobile.js"),review=source("public/admin-checkout-prices.html");
  assert.match(app,/admin-mobile-controls\.css\?v=1/);
  assert.match(site,/sng-controls\.css\?v=2/);
  assert.match(admin,/sng-controls\.css\?v=1/);
  assert.match(admin,/admin-checkout-prices\.html/);
  assert.match(script,/success-filter-select/);
  assert.match(script,/admin-checkout-prices\.html/);
  assert.match(review,/\/api\/admin\/checkout-paid-verification/);
  assert.match(mobile,/grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(mobile,/data-admin-mobile-theme="light"/);
  assert.match(shared,/data-app-theme="day"/);
  assert.match(shared,/data-admin-theme="light"/);
  assert.match(shared,/sng-range button\[aria-pressed="true"\]/);
  assert.match(shared,/min-height:44px/);
});
