import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HISTORICAL_COMMUNITY_SNAPSHOT,
  historicalPlusVerified,
  moneyToCents,
  safeAdminProfileLabel
} from "../checkout-reporting.js";

test("archived 240 checkouts and original amount combine with live 82 once", () => {
  const current = historicalPlusVerified({
    checkouts: 82, spent: 4623.65, unknownPrices: 10
  });
  assert.equal(current.totalCheckouts, 322);
  assert.equal(current.totalSpent, 20499.80);
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

test("public and Admin endpoints read one authoritative live source and keep the archive separate", () => {
  const server=readFileSync(new URL("../server.js",import.meta.url),"utf8");
  const mobile=readFileSync(new URL("../public/admin-mobile.js",import.meta.url),"utf8");
  const site=readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
  const publicStart=server.indexOf('"/api/public/success"');
  const adminStart=server.indexOf('"/api/admin/success-overview"');
  const publicRoute=server.slice(publicStart,server.indexOf("async function saveSuccessCheckouts(",publicStart));
  const adminRoute=server.slice(adminStart,server.indexOf('app.get("/api/admin/discord-success-status"',adminStart));
  assert.match(publicRoute,/historicalPlusVerified\(/);
  assert.match(publicRoute,/visibleDiscordSuccessRecords/);
  assert.match(adminRoute,/const confirmed = allRecords\.filter\(confirmedDiscordPurchase\)/);
  assert.match(adminRoute,/confirmed\.filter\(record => !record\.customerAccountId\)/);
  assert.doesNotMatch(adminRoute,/filter\(record => Boolean\(record\.customerAccountId\) && confirmedDiscordPurchase/);
  assert.match(adminRoute,/safeAdminProfileLabel/);
  assert.match(mobile,/Customer checkout breakdown/);
  assert.match(mobile,/Which accounts checked out/);
  assert.match(mobile,/success-customer-filter/);
  assert.match(mobile,/success-account-filter/);
  assert.match(mobile,/orderTotalKnown/);
  assert.match(site,/historicalCheckouts/);
});
