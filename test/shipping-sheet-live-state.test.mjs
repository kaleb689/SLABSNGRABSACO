import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
const source=readFileSync(new URL("../public/app-dashboard.js",import.meta.url),"utf8");
test("live shipping updates preserve expanded history and exact sheet scroll",()=>{
 assert.match(source,/function updateTrackingSheetMarkup\(markup\)/);
 assert.match(source,/const scrollTop = scroller\?\.scrollTop \|\| 0/);
 assert.match(source,/const openHistory = Boolean\(trackingSheet\.querySelector\('\.sng-sheet-history'\)\?\.open\)/);
 assert.match(source,/if \(openHistory\) trackingSheet\.querySelector\('\.sng-sheet-history'\)\?\.setAttribute\('open', ''\)/);
 assert.match(source,/if \(nextScroller\) nextScroller\.scrollTop = scrollTop/);
 assert.ok((source.match(/updateTrackingSheetMarkup\(markup\)/g)||[]).length>=3);
});
test("customer tracking keeps carrier links or explains pending verified links",()=>{
 assert.match(source,/Carrier tracking link pending verification/);
 assert.match(source,/Tracking link pending carrier verification/);
 assert.match(source,/Track with carrier/);
 assert.match(source,/shipping\.estimatedDelivery/);
 assert.match(source,/shipping\.events/);
});
test("the shipping change does not navigate or recreate customer account",()=>{
 const start=source.indexOf("function updateTrackingSheetMarkup(markup)");
 const end=source.indexOf("function orderRows(",start);
 assert.ok(start>0&&end>start);
 assert.doesNotMatch(source.slice(start,end),/location\.reload|window\.location|window\.scrollTo/);
});

test("customer order details identify the last verified shipping update and its source",()=>{
 assert.match(source,/Latest shipping update/);
 assert.match(source,/Tracking source/);
 assert.match(source,/Verified shipping email/);
 assert.match(source,/Official carrier scan/);
 assert.match(source,/No verified shipping update yet/);
});

test("authenticated Success response exposes safe shipping status provenance",()=>{
 const server=readFileSync(new URL("../server.js",import.meta.url),"utf8");
 assert.match(server,/source: \["carrier_api", "retailer_email"\]\.includes\(record\.shipping\.source\)/);
 assert.match(server,/updatedAt: record\.shipping\.updatedAt \|\| null/);
});

test("carrier action resolves only official direct result links with tracking number",()=>{
 const start=source.indexOf("const officialCarrierHref =");
 const end=source.indexOf("const trackingRecords =",start);
 assert.ok(start>0&&end>start);
 const run=shipping=>{
  const scope={shipping,URL,out:null};
  vm.runInNewContext(source.slice(start,end)+"\nout=officialCarrierHref(shipping);",scope);
  return scope.out;
 };
 assert.equal(run({carrier:"UPS",trackingNumber:"1Z999AA10123456784"}),
   "https://www.ups.com/track?loc=en_US&tracknum=1Z999AA10123456784");
 assert.equal(run({carrier:"FedEx",trackingNumber:"987654321012"}),
   "https://www.fedex.com/fedextrack/?trknbr=987654321012");
 assert.equal(run({trackingUrl:"https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111202555012345678"}),
   "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111202555012345678");
 for(const link of [
  "https://fedex.com.attacker.invalid/fedextrack/?trknbr=987654321012",
  "https://example.org/redirect?url=https://fedex.com/fedextrack/?trknbr=987654321012",
  "https://www.ups.com/track",
  "http://www.fedex.com/fedextrack/?trknbr=987654321012"
 ]) assert.equal(run({trackingUrl:link}),"",link);
 assert.equal(run({carrier:"UPS",trackingNumber:"not-a-real-tracking-number"}),"");
});
