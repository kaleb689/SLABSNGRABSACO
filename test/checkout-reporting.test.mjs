import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HISTORICAL_COMMUNITY_SNAPSHOT,
  historicalPlusVerified,
  moneyToCents,
  safeAdminProfileLabel,
  adminCheckoutCustomerName,
  summarizeUnmatchedCheckouts
} from "../checkout-reporting.js";

test("archived 240 checkouts and original amount combine with live 82 once", () => {
  const current = historicalPlusVerified({
    checkouts: 82, spent: 4623.65, unknownPrices: 10
  });
  assert.equal(current.totalCheckouts, 322);
  assert.equal(current.totalSpent, 20499.76);
  assert.equal(historicalPlusVerified({checkouts:0,spent:0}).totalSpent, 15876.11);
  // The four-cent reference discrepancy is not verified retailer spend.
  assert.equal(current.totalSpent-current.liveVerifiedSpent,15876.11);
  assert.equal(current.historicalCheckouts, 240);
  assert.equal(current.historicalSpent, 15876.11);
  assert.equal(current.reportedReconciliation, .04);
  assert.equal(current.liveVerifiedSpent, 4623.65);
  assert.equal(current.pricePendingCheckouts, 10);
  assert.equal(current.historicalSummaryOnly, true);
  assert.equal(HISTORICAL_COMMUNITY_SNAPSHOT.itemizedRecordsAvailable, false);
});

test("repeated scans cannot double count a stable live order set", () => {
  const prior = historicalPlusVerified({checkouts:82,spent:4623.65});
  const rescan = historicalPlusVerified({checkouts:82,spent:4623.65});
  const newOrder = historicalPlusVerified({checkouts:83,spent:4642.65});
  assert.deepEqual(prior,rescan);
  assert.equal(newOrder.totalCheckouts-prior.totalCheckouts,1);
  assert.equal(moneyToCents(newOrder.totalSpent-prior.totalSpent),1900);
});

test("unknown prices are not converted into fabricated paid amounts", () => {
  assert.equal(moneyToCents(null),0);
  assert.equal(moneyToCents(""),0);
  assert.equal(moneyToCents("not-a-total"),0);
  const current=historicalPlusVerified({checkouts:3,spent:0,unknownPrices:3});
  assert.equal(current.liveVerifiedSpent,0);
  assert.equal(current.pricePendingCheckouts,3);
});

test("account labels retain useful profile identity without login emails or secrets", () => {
  const linked=safeAdminProfileLabel({
    retailer:"Target",managedAccountId:"managed-7",
    profileName:"Mike example123@gmail.com password:Secret123"
  });
  assert.equal(linked.accountKind,"linked");
  assert.equal(linked.accountKey,"managed:managed-7");
  assert.ok(linked.accountLabel.includes("Mike"));
  assert.doesNotMatch(linked.accountLabel,/example123@gmail.com|Secret123/);
  const paid=safeAdminProfileLabel({retailer:"Walmart",profileSlot:3});
  assert.equal(paid.accountKind,"paid");
  assert.match(paid.accountLabel,/Walmart paid profile 3/);
});

test("Admin checkout names prefer real saved customer names, not webhook profile labels", () => {
  const account={id:"member-12345678",email:"customer@example.test",
    adminProfile:{firstName:"Amy",lastName:"Example"}};
  const paid={profile:{firstName:"Old",lastName:"Name"}};
  assert.equal(adminCheckoutCustomerName(account,paid),"Amy Example");
  assert.equal(adminCheckoutCustomerName({id:"abc",email:"customer@example.test"},paid),"Old Name");
  assert.equal(adminCheckoutCustomerName({id:"abc",email:"customer@example.test"}),"customer@example.test");
  assert.equal(adminCheckoutCustomerName({id:"user-last-8"}),"Customer account r-last-8");
});


test("unmatched PKC confirmed successes remain separate from linked customer checkout metrics", () => {
  const at=Date.parse("2026-10-09T21:00:00Z");
  const orders=[
    {retailer:"PKC",checkoutAt:"2026-10-09T08:00:00Z"},
    {retailer:"PKC",checkoutAt:"2026-10-06T08:00:00Z"},
    {retailer:"Target",checkoutAt:"2026-09-29T12:00:00Z"}
  ];
  const unmatched=summarizeUnmatchedCheckouts(orders,at);
  assert.equal(unmatched.total,3);
  assert.equal(unmatched.last24h,1);
  assert.equal(unmatched.last7d,2);
  assert.equal(unmatched.last30d,3);
  assert.deepEqual(unmatched.byRetailer[0],
    {retailer:"PKC",total:2,last24h:1,last7d:2,last30d:2});
  assert.deepEqual(summarizeUnmatchedCheckouts([],at).byRetailer,[]);
});

test("public and Admin endpoints read one authoritative live source and keep the archive separate", () => {
  const server=readFileSync(new URL("../server.js",import.meta.url),"utf8");
  const mobile=readFileSync(new URL("../public/admin-mobile.js",import.meta.url),"utf8");
  const site=readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
  const home=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
  const publicStart=server.indexOf('"/api/public/success"');
  const adminStart=server.indexOf('"/api/admin/success-overview"');
  const publicRoute=server.slice(publicStart,server.indexOf("async function saveSuccessCheckouts(",publicStart));
  const adminRoute=server.slice(adminStart,server.indexOf('app.get("/api/admin/discord-success-status"',adminStart));
  assert.match(publicRoute,/historicalPlusVerified\(/);
  assert.match(publicRoute,/visibleDiscordSuccessRecords/);
  assert.ok(adminRoute.includes("const unmatchedCount = unassignedConfirmed.length;"));
  assert.ok(adminRoute.includes("!record.customerAccountId || !customersById.has"));
  assert.ok(adminRoute.includes("const confirmed = allRecords.filter(confirmedDiscordPurchase)"));
  assert.doesNotMatch(adminRoute,/filter\(record => Boolean\(record\.customerAccountId\) && confirmedDiscordPurchase/);
  assert.match(adminRoute,/safeAdminProfileLabel/);
  assert.match(adminRoute,/adminCheckoutCustomerName/);
  assert.match(adminRoute,/customersById\.has/);
  assert.match(adminRoute,/\.filter\(record => record\.customerAccountId/);
  assert.match(mobile,/esc\(x\.name\)\+\x27 checkout breakdown/);
  assert.match(mobile,/data-success-user-days/);
  assert.match(mobile,/successUserDays/);
  assert.doesNotMatch(mobile,/Unmatched \/ unassigned checkouts/);
  assert.match(mobile,/Which accounts checked out/);
  assert.match(mobile,/success-customer-filter/);
  assert.match(mobile,/success-account-filter/);
  assert.match(mobile,/orderTotalKnown/);
  assert.match(site,/rollSuccessMetric\("public-success-spent"/);
  assert.doesNotMatch(site,/public-success-spent-note|public-success-historical-products/);
  assert.doesNotMatch(home,/id="public-success-spent-note"|id="public-success-historical-products"/);
});


test("PKC matching review includes only confirmed orders and safe item descriptions", () => {
  const server=readFileSync(new URL("../server.js",import.meta.url),"utf8");
  const begin=server.indexOf('app.get("/api/admin/discord-checkout-profile-matching"');
  const end=server.indexOf('app.post("/api/admin/discord-checkout-profile-matching"',begin);
  assert.ok(begin>=0&&end>begin);
  const matching=server.slice(begin,end);
  assert.match(matching,/confirmedDiscordPurchase\(record\)/);
  assert.match(matching,/isSafeDiscordCheckoutProductName\(name\)/);
  assert.match(matching,/products: \[\.\.\.productCount\.values\(\)\]/);
  const page=readFileSync(new URL("../public/admin-checkout-match.html",import.meta.url),"utf8");
  assert.match(page,/requestedRetailer/);
  assert.match(page,/match-products/);
  assert.match(page,/Choose a verified customer/);
});
