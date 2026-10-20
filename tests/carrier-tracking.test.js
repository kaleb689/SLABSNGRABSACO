import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanTrackingNumber, knownCarrier, officialTrackingUrl, trackingEvidenceFromEmail,
  normalizeCarrierResponse, mergeCarrierShipping, createCarrierTrackingClient,
  carrierStage
} from "../carrier-tracking.js";

const ups = "1Z999AA10123456784";
const fedex = "612999988888";
const usps = "9400111899223856929447";

test("tracking numbers and official links are normalized without guessing unknown carriers", () => {
  assert.equal(cleanTrackingNumber(" 1z999aa1 0123456784 "), ups);
  assert.equal(cleanTrackingNumber("invalid-not-a-tracking-number!"), null);
  assert.equal(knownCarrier(null, ups), "UPS");
  assert.match(officialTrackingUrl("UPS", ups), /ups\.com\/track.*tracknum=/);
  assert.match(officialTrackingUrl("FedEx", fedex), /fedex\.com\/fedextrack.*trknbr=/);
  assert.match(officialTrackingUrl("USPS", usps), /usps\.com\/go\/TrackConfirmAction.*tLabels=/);
  assert.equal(officialTrackingUrl("Unverified courier", fedex), null);
});

test("trusted retailer emails can enrich a previously verified checkout's carrier/number", () => {
  const out = trackingEvidenceFromEmail({
    subject: "Your order shipped",
    text: "UPS Tracking Number: " + ups + "\nEstimated arrival Oct 23"
  });
  assert.equal(out.trackingNumber, ups);
  assert.equal(out.carrier, "UPS");
  assert.ok(out.trackingUrl.includes("tracknum=" + ups));
});

test("HTML-only carrier links are parsed without depending on visible anchor text", () => {
  const out = trackingEvidenceFromEmail({
    html: '<a href="https://www.fedex.com/fedextrack/?trknbr=' + fedex + '&amp;foo=bar">Track Package</a>'
  });
  assert.equal(out.trackingNumber, fedex);
  assert.equal(out.carrier, "FedEx");
});

test("carrier state must be based on actual evidence", () => {
  assert.equal(carrierStage("Label created"), "shipped");
  assert.equal(carrierStage("Out for delivery"), "out_for_delivery");
  assert.equal(carrierStage("Delivered, Front Door/Porch"), "delivered");
  assert.equal(carrierStage("Expected delivery tomorrow"), null);
});

test("UPS responses include detailed scans and delivery estimate", () => {
  const result = normalizeCarrierResponse("UPS", ups, { trackResponse: { shipment: [{
    package: [{trackingNumber: ups,
      currentStatus: {description: "Out for delivery"},
      activity: [
        {status: {description: "Out for delivery"}, gmtDate: "20261020", gmtTime: "130000",
          location: {address: {city: "Davie", stateProvince: "FL", countryCode: "US"}}},
        {status: {description: "Label Created"}, gmtDate: "20261019", gmtTime: "130000",
          location: {address: {city: "Miami", stateProvince: "FL", countryCode: "US"}}}
      ], deliveryDate: [{type: "SDD", date: "20261020"}]
    }]
  }] }});
  assert.equal(result.status, "out_for_delivery");
  assert.equal(result.estimatedDelivery, "2026-10-20");
  assert.equal(result.events[0].status, "Out for delivery");
  assert.equal(result.events[0].location, "Davie, FL, US");
  assert.equal(result.events.length, 2);
});

test("FedEx matching rejects another package's tracking number", () => {
  const data = {output: {completeTrackResults: [{trackResults: [{
    trackingNumberInfo: {trackingNumber: "999999999999"},
    scanEvents: [{eventDescription: "Delivered", date: "2026-10-20T10:00:00Z"}]
  }]}]}};
  assert.equal(normalizeCarrierResponse("FedEx", fedex, data), null);
});

test("FedEx scans are normalized", () => {
  const result = normalizeCarrierResponse("FedEx", fedex,
    {output: {completeTrackResults: [{trackResults: [{
      trackingNumberInfo: {trackingNumber: fedex},
      latestStatusDetail: {description: "In transit"},
      scanEvents: [{eventDescription: "Arrived at facility", date: "2026-10-20T09:40:00Z",
        scanLocation: {city: "Orlando", stateOrProvinceCode: "FL", countryCode: "US"}}]
    }]}]}});
  assert.equal(result.status, "in_transit");
  assert.equal(result.events[0].stage, "in_transit");
  assert.equal(result.events[0].location, "Orlando, FL, US");
});

test("USPS v3r2 response tracks status and delivery history", () => {
  const out = normalizeCarrierResponse("USPS", usps, [{
    trackingNumber: usps, status: "Delivered, Front Door/Porch",
    deliveryDateExpectation: {expectedDeliveryDate: "2026-10-20"},
    trackingEvents: [{eventType: "Delivered, Front Door/Porch",
      GMTTimestamp: "2026-10-20T13:55:12Z", eventCity: "Davie", eventState: "FL", eventCountry: "US"}]
  }]);
  assert.equal(out.status, "delivered");
  assert.equal(out.estimatedDelivery, "2026-10-20");
  assert.equal(out.events[0].stage, "delivered");
});

test("carrier history updates without duplicate events or backwards shipping state", () => {
  const sample = {carrier:"UPS",trackingNumber:ups,status:"in_transit",
    estimatedDelivery:"2026-10-21",
    events:[{status:"Arrived at facility", at:"2026-10-20T09:00:00Z",location:"Davie, FL"}]};
  const prior = {status:"delivered",trackingNumber:ups,deliveredAt:"2026-10-20T13:00:00Z"};
  const next = mergeCarrierShipping(prior,sample,"2026-10-20T14:00:00Z");
  assert.equal(next.status, "delivered");
  const again=mergeCarrierShipping(next,sample,"2026-10-20T14:01:00Z");
  assert.equal(again,null);
  assert.equal(mergeCarrierShipping(prior,{...sample,trackingNumber:fedex}),null);
});

test("USPS client uses documented JSON POST and bearer token, never browser credentials", async () => {
  let calls = [];
  const mockFetch = async (url,opts) => {
    calls.push({url,opts});
    if (url === "https://apis.usps.com/oauth2/v3/token") return {
      ok: true, text: async () => JSON.stringify({access_token:"opaque-test-token",expires_in:3600})
    };
    if (url === "https://apis.usps.com/tracking/v3r2/tracking") return {
      ok: true, text: async () => JSON.stringify([{
        trackingNumber:usps,status:"Delivered",trackingEvents:[
          {eventType:"Delivered",GMTTimestamp:"2026-10-20T14:00:00Z"}
        ]
      }])
    };
    throw new Error("Unexpected request "+url);
  };
  const client=createCarrierTrackingClient({config:{USPS_CLIENT_ID:"test-id",USPS_CLIENT_SECRET:"test-secret"},fetchImpl:mockFetch});
  const out=await client.lookup("USPS",usps);
  assert.equal(out.status,"delivered");
  assert.equal(calls.length,2);
  assert.equal(calls[1].opts.method,"POST");
  assert.deepEqual(JSON.parse(calls[1].opts.body),[{trackingNumber:usps}]);
  assert.equal(calls[1].opts.headers.Authorization,"Bearer opaque-test-token");
});
