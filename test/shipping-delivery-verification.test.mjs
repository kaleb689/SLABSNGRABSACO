import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
  shippingStatusFromMessage, explicitDeliveryConfirmation,
  evaluateVerifiedEmailShippingTransition, verifiedShippingStatus
} from "../shipping-tracking-policy.js";
import {mergeCarrierShipping} from "../carrier-tracking.js";
import {orderEvents,orderSnapshot} from "../order-notifications.js";

const number = "1ZWY06570310017016";
const morning = "2026-10-30T12:17:00Z";

test("Target arriving-today notice is OUT FOR DELIVERY, never delivered",()=>{
  const subject = "Michael, your order arrives today!";
  const text = [
    "Pokémon Trading Card Game: 30th Celebration Booster Bundle Box",
    "2 items from Target Corporation",
    "Arriving today",
    "Shipped · Out for delivery",
    "From UPS",
    "Order number 902003896022010",
    "Tracking number " + number,
    "Once delivered, you can review the item",
    "If your package is delivered late, contact support"
  ].join("\n");
  assert.equal(explicitDeliveryConfirmation(subject,text),false);
  assert.equal(shippingStatusFromMessage(subject,text),"out_for_delivery");
  const html = "<h1>Arriving today</h1><p>Shipped · Out for delivery</p><p>Once delivered, contact support</p>";
  assert.equal(shippingStatusFromMessage(subject,html),"out_for_delivery");
});
test("Conditional/estimated delivery must never trigger Delivered",()=>{
  for (const subject of ["Your order will be delivered today","Your package is expected to be delivered",
    "Delivery expected today","Your shipment may be delivered"]) {
    assert.notEqual(shippingStatusFromMessage(subject,"Estimated arrival: today. Once delivered, review your order."),"delivered",subject);
  }
  assert.equal(explicitDeliveryConfirmation("Tracking update","Once delivered, contact us for support"),false);
  assert.equal(shippingStatusFromMessage("Shipment notice","If your order has been delivered, share your feedback"),null);
});
test("Clear affirmative retailer delivery notices still count as Delivered",()=>{
  assert.equal(shippingStatusFromMessage("Your package has been delivered!",
    "Tracking number "+number+"\nOut for delivery yesterday\nDelivered today"),"delivered");
  assert.equal(shippingStatusFromMessage("Shipping status",
    "Tracking status: Delivered\nOrder number 902003896022010"),"delivered");
  assert.equal(explicitDeliveryConfirmation("Your order was delivered!",""),true);
  assert.equal(shippingStatusFromMessage("Your order is on its way","Label Created\nJust Shipped"),"shipped");
});
test("Only proven delivery can advance to delivered and unproven legacy can be corrected",()=>{
  const wrong={status:"delivered",source:"retailer_email",
    deliveredAt:"2026-10-30T12:30:00Z",updatedAt:"2026-10-30T12:30:00Z",
    trackingNumber:number};
  const earlier={status:"out_for_delivery",eventAt:morning};
  assert.deepEqual(evaluateVerifiedEmailShippingTransition(wrong,earlier),{accept:true,correction:true});
  assert.equal(verifiedShippingStatus(wrong),"shipped");
  assert.equal(verifiedShippingStatus({...wrong,trackingNumber:null}),null);
  assert.deepEqual(evaluateVerifiedEmailShippingTransition(wrong,{
    status:"delivered",eventAt:"2026-10-30T12:35:00Z",deliveryProof:null
  }),{accept:false,correction:false});
  assert.deepEqual(evaluateVerifiedEmailShippingTransition(wrong,{
    status:"delivered",eventAt:"2026-10-30T12:35:00Z",deliveryProof:"explicit_email"
  }),{accept:true,correction:false});
  const proven={...wrong,deliveryProof:"explicit_email"};
  assert.equal(verifiedShippingStatus(proven),"delivered");
  assert.equal(evaluateVerifiedEmailShippingTransition(proven,earlier).accept,false);
  assert.equal(evaluateVerifiedEmailShippingTransition({
    ...wrong,source:"carrier_api",deliveryProof:"carrier_api"
  },earlier).accept,false);
});
test("Actual UPS API status corrects unproven email delivery but preserves proven delivery",()=>{
  const wrong={status:"delivered",source:"retailer_email",trackingNumber:number,
    deliveredAt:"2026-10-30T12:20:00Z"};
  const out={trackingNumber:number,carrier:"UPS",status:"out_for_delivery",
    events:[{status:"Out for delivery",stage:"out_for_delivery",at:morning}]};
  const corrected=mergeCarrierShipping(wrong,out,"2026-10-30T12:35:00Z");
  assert.equal(corrected.status,"out_for_delivery");
  assert.equal(corrected.deliveredAt,null);
  assert.equal(corrected.source,"carrier_api");
  const proven={...wrong,source:"carrier_api",deliveryProof:"carrier_api"};
  const preserved=mergeCarrierShipping(proven,out,"2026-10-30T12:35:00Z");
  assert.equal(preserved.status,"delivered");
  const delivered={...out,status:"delivered",events:[{status:"Delivered",stage:"delivered",
    at:"2026-10-30T14:30:00Z"}]};
  const actual=mergeCarrierShipping(corrected,delivered,"2026-10-30T14:31:00Z");
  assert.equal(actual.status,"delivered");
  assert.equal(actual.deliveryProof,"carrier_api");
  assert.equal(mergeCarrierShipping(actual,delivered,"2026-10-30T14:40:00Z"),null);
});
test("Customer push notifications cannot announce Delivered from unverified legacy email",()=>{
  const record={id:"discord:123:456",customerAccountId:"customer-1",retailer:"Target",
    orderNumber:"902003896022010",status:"confirmed",
    items:[{name:"30th Celebration Booster Bundle Box"}],
    shipping:{status:"delivered",source:"retailer_email",trackingNumber:number}};
  const previous={eligible:true,shipping:JSON.stringify(["shipped"])};
  assert.equal(JSON.parse(orderSnapshot(record).shipping)[0],"shipped");
  assert.equal(orderEvents(record,previous).filter(x=>x.kind==="shipping_update").length,0);
  const corrected={...record,shipping:{...record.shipping,status:"out_for_delivery"}};
  const previousFalse={eligible:true,shipping:JSON.stringify(["delivered"])};
  const note=orderEvents(corrected,previousFalse).find(x=>x.kind==="shipping_update");
  assert.match(note.title,/status corrected: out for delivery/);
  const legit={...corrected,shipping:{...corrected.shipping,status:"delivered",deliveryProof:"explicit_email"}};
  assert.equal(orderEvents(legit,{eligible:true,shipping:JSON.stringify(["out_for_delivery"])}).
    find(x=>x.kind==="shipping_update").title,"Target order delivered");
});
test("Shipping API, owner-only inbox scan and atomic store guard use delivery verification",()=>{
  const server=readFileSync(new URL("../server.js",import.meta.url),"utf8");
  assert.match(server,/shippingStatusFromMessage\(subject, shippingEmailBody\)/);
  assert.match(server,/evaluateVerifiedEmailShippingTransition\(prior/);
  assert.match(server,/statusCorrection: transition\.correction/);
  assert.match(server,/prior\.deliveryProof !== "explicit_email"/);
  assert.match(server,/verifiedShippingStatus\(record\.shipping\)/);
  assert.doesNotMatch(server.slice(server.indexOf("async function syncShippingTrackers()"),
    server.indexOf("function startShippingTrackerScheduler()")),/getCustomerSuccessMailboxes\(/);
});
