import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import {
  verifiedCarrierTracking, parseOfficialCarrierTrackingUrl,
  carrierFromTrackingNumber, normalizeTrackingNumber
} from "../carrier-tracking-links.js";

test("official FedEx tracking link carries the verified number without additional input", () => {
  const result=verifiedCarrierTracking({carrier:"FedEx",trackingNumber:"9876 5432 1012",
    trackingUrl:"https://click.example.invalid/shipping/status"});
  assert.equal(result.carrier,"FedEx");
  assert.equal(result.trackingNumber,"987654321012");
  assert.equal(result.url,"https://www.fedex.com/fedextrack/?trknbr=987654321012");
});

test("UPS and USPS links lead to official carrier tracking results with exact numbers", () => {
  const ups=verifiedCarrierTracking({carrier:"UPS",trackingNumber:"1Z999AA10123456784"});
  assert.equal(ups.url,"https://www.ups.com/track?loc=en_US&tracknum=1Z999AA10123456784");
  const usps=verifiedCarrierTracking({carrier:"USPS",trackingNumber:"9400111202555012345678"});
  assert.equal(usps.url,"https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111202555012345678");
  const intl=verifiedCarrierTracking({trackingNumber:"EA123456789US"});
  assert.equal(intl.carrier,"USPS");
  assert.match(intl.url,/^https:\/\/tools\.usps\.com\/go\/TrackConfirmAction\?tLabels=EA123456789US$/);
});

test("official tracking URL can safely supply missing carrier and number", () => {
  const fedex=verifiedCarrierTracking({
    trackingUrl:"https://www.fedex.com/fedextrack/?trknbr=987654321012&junk=ignore"});
  assert.equal(fedex.carrier,"FedEx");
  assert.equal(fedex.trackingNumber,"987654321012");
  assert.equal(fedex.url,"https://www.fedex.com/fedextrack/?trknbr=987654321012");
  assert.deepEqual(parseOfficialCarrierTrackingUrl("https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111202555012345678"),{
    carrier:"USPS",trackingNumber:"9400111202555012345678"
  });
});

test("homepages, redirects, credentials, unsupported URLs and invalid numbers cannot become links", () => {
  for (const link of [
    "https://www.fedex.com/", "https://www.ups.com/track", "https://tools.usps.com/",
    "https://fedex.com.attacker.example/track?trknbr=987654321012",
    "https://click.example.com/tracking?trackingNumber=987654321012",
    "http://www.fedex.com/fedextrack/?trknbr=987654321012",
    "https://user:password@www.fedex.com/fedextrack/?trknbr=987654321012"
  ]) assert.equal(parseOfficialCarrierTrackingUrl(link),null,link);
  assert.equal(verifiedCarrierTracking({carrier:"FedEx"}).url,null);
  assert.equal(verifiedCarrierTracking({trackingNumber:"987654321012"}).url,null);
  assert.equal(verifiedCarrierTracking({carrier:"UPS",trackingNumber:"not-an-order"}).url,null);
  assert.equal(normalizeTrackingNumber("000000000000"),null);
  assert.equal(carrierFromTrackingNumber("987654321012"),null,"Do not guess a carrier from ambiguous digits");
});

test("inconsistent official carrier proof suppresses misleading result", () => {
  const result=verifiedCarrierTracking({carrier:"FedEx",trackingNumber:"987654321012",
    trackingUrl:"https://www.ups.com/track?tracknum=1Z999AA10123456784"});
  assert.equal(result.url,null);
});

test("production shipping adapter only uses official links and verified status transitions", () => {
  const source=readFileSync(new URL("../server.js",import.meta.url),"utf8");
  const start=source.indexOf('function shippingTrackingUrl(html = "", text = "") {');
  const end=source.indexOf("\nfunction compactShippingAddress(",start);
  assert.ok(start>0 && end>start);
  const context={html:'<a href="https://example.com/track?num=bad">x</a><a href="https://www.fedex.com/fedextrack/?trknbr=987654321012">Track</a>',
    text:"",computed:null,parseOfficialCarrierTrackingUrl,verifiedCarrierTracking};
  vm.runInNewContext(source.slice(start,end)+"\ncomputed=shippingTrackingUrl(html,text);",context);
  assert.equal(context.computed,"https://www.fedex.com/fedextrack/?trknbr=987654321012");
  assert.match(source,/trackingUrl: verifiedCarrierTracking\(record\.shipping\)\.url/);
  assert.match(source,/events: Array\.isArray\(record\.shipping\.events\)/);
  assert.match(source,/history\.push\(\{status, at: messageAt, source: "retailer_email"\}\)/);
  assert.doesNotMatch(source.slice(start,end),/\/(?:tracking\|track(?:ing)?)/);
});

test("no sensitive identifiers or order emails are included in customer tracking link", () => {
  const link=verifiedCarrierTracking({carrier:"FedEx",trackingNumber:"987654321012",
    accountEmail:"private@example.test",orderNumber:"P0042243143"}).url;
  assert.doesNotMatch(link,/private|example|P0042243143/i);
  assert.match(link,/fedex\.com/);
});
