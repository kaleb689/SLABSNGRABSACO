import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
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
