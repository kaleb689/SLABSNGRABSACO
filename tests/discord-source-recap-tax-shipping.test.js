import test from "node:test";
import assert from "node:assert/strict";
import {ownerRecapExpectedChargeCents} from "../discord-checkout-tax-inclusive-policy.js";
import {buildDiscordSourceRecap,easternLocalInstant} from "../discord-source-recap-report.js";
import {SLABSNGRABSTC_SUCCESS_CHANNEL_ID} from "../discord-source-price-field-policy.js";

const FROM="2026-11-13T08:00:00.000Z";
const TO="2026-11-13T13:00:00.000Z";
const LATER="2026-11-13T20:00:00.000Z";
function webhook({id,at=FROM,order,qty=1,price=null,product="Pokemon 30th Celebration Tin 4pk",state="green",paid=null}={}) {
  const colors={green:0x00cc66,orange:0xffaa00,red:0xf00000};
  const fields=[{name:"Site",value:"Target"},{name:"Quantity",value:String(qty)}];
  if(order)fields.push({name:"Order ID",value:order});
  if(price!==null)fields.push({name:"Price",value:String(price)});
  return {id:String(id),timestamp:at,webhook_id:"111111111111111111",
    embeds:[{title:state==="red"?"Checkout Cancelled":"Checkout Success",
      color:colors[state],fields,
      description:"["+product+"](https://www.target.com/p/example)"}],
    sampleOrder:order,sampleQty:qty,samplePrice:price,sampleProduct:product,samplePaid:paid};
}
function parseCheckout(msg) {
  return {orderNumber:msg.sampleOrder||"",
    retailer:"Target",items:[{name:msg.sampleProduct,quantity:msg.sampleQty,
      price:msg.samplePrice??0}],
    orderTotal:msg.samplePaid??0,
    orderTotalBasis:msg.samplePaid===null?"unknown":"order_total"};
}
function recap(messages,{complete=true}={}) {
  return buildDiscordSourceRecap(messages,{channelId:SLABSNGRABSTC_SUCCESS_CHANNEL_ID,
    from:FROM,toExclusive:TO,asOf:LATER,retailer:"Target",
    parseCheckout,historyComplete:complete});
}

test("7% tax plus $5.99 shipping when merchandise is below $35",()=>{
  assert.deepEqual(ownerRecapExpectedChargeCents(2499),{
    subtotalCents:2499,taxCents:175,shippingCents:599,totalCents:3273,
    basis:"owner_confirmed_7pct_tax_shipping_under_35",
    taxAppliesTo:"merchandise",shippingThresholdCents:3500
  });
});

test("$35.00 has free shipping; $34.99 has $5.99 shipping",()=>{
  assert.equal(ownerRecapExpectedChargeCents(3500).totalCents,3745);
  assert.equal(ownerRecapExpectedChargeCents(3499).totalCents,4343);
  assert.equal(ownerRecapExpectedChargeCents(4998).totalCents,5348);
  assert.equal(ownerRecapExpectedChargeCents(0),null);
  assert.equal(ownerRecapExpectedChargeCents(-1),null);
});

test("per-order shipping and 7% per-order taxes, not tax on drop grand total",()=>{
  const m1=webhook({id:"1511111111111111101",order:"TGT00111",qty:1,price:24.99});
  const m2=webhook({id:"1511111111111111102",at:"2026-11-13T09:01:00Z",
    order:"TGT00112",qty:2,price:null,state:"orange"});
  const result=recap([m1,m2]);
  assert.equal(result.ordersPlaced,2);
  assert.equal(result.totalUnits,3);
  assert.equal(result.ruleSubtotalCents,7497);
  assert.equal(result.ruleTaxCents,525);
  assert.equal(result.ruleShippingCents,599);
  assert.equal(result.totalSpentCents,8621);
  assert.equal(result.shippingChargedOrders,1);
  assert.equal(result.freeShippingOrders,1);
  assert.equal(result.ruleUnpricedOrders,0);
  assert.equal(result.readyToPublish,true);
  assert.equal(result.totalSpentBasis,"rule_calculated_7pct_tax_shipping_under_35");
});

test("red cancellations lacking order IDs or prices are ignored",()=>{
  const kept=webhook({id:"1511111111111111103",order:"TGT00113",price:24.99});
  const red=webhook({id:"1511111111111111104",at:"2026-11-13T09:03:00Z",
    state:"red",order:null,price:null});
  const report=recap([kept,red]);
  assert.equal(report.ordersPlaced,1);
  assert.equal(report.redWithoutOrderIdIgnored,1);
  assert.equal(report.totalSpentCents,3273);
  assert.equal(report.readyToPublish,true);
});

test("same-order red event removes previous successful order without including a cancellation box",()=>{
  const kept=webhook({id:"1511111111111111105",order:"TGT00114",price:24.99});
  const removed=webhook({id:"1511111111111111106",
    at:"2026-11-13T09:05:00Z",order:"TGT00115",price:24.99});
  const red=webhook({id:"1511111111111111107",at:"2026-11-13T10:00:00Z",
    state:"red",order:"TGT00115"});
  const report=recap([kept,removed,red]);
  assert.equal(report.ordersPlaced,1);
  assert.equal(report.totalUnits,1);
  assert.equal(report.totalSpentCents,3273);
});

test("unknown unique product prices block total spend, never guess",()=>{
  const m=webhook({id:"1511111111111111108",order:"TGT00116",price:null,
    product:"Pokemon Unseen New Product"});
  const report=recap([m]);
  assert.equal(report.ruleUnpricedOrders,1);
  assert.equal(report.totalSpentCents,null);
  assert.equal(report.readyToPublish,false);
  assert.ok(report.blockedReasons.includes("missing_source_unit_prices_for_rule_total"));
});

test("discord paid-order charge conflicting with owner rule blocks publication",()=>{
  const m=webhook({id:"1511111111111111109",order:"TGT00117",
    price:24.99,paid:38.99});
  const report=recap([m]);
  assert.equal(report.ruleExplicitPaidConflicts,1);
  assert.equal(report.readyToPublish,false);
  assert.ok(report.blockedReasons.includes("explicit_paid_amount_disagrees_with_tax_shipping_rule"));
});

test("incomplete Discord history blocks posting even with complete prices",()=>{
  const m=webhook({id:"1511111111111111110",order:"TGT00118",price:24.99});
  const report=recap([m],{complete:false});
  assert.equal(report.readyToPublish,false);
  assert.ok(report.blockedReasons.includes("incomplete_discord_history"));
});

test("November Target local 3-8 AM window follows Eastern DST offset",()=>{
  assert.equal(easternLocalInstant("2026-11-13",3),FROM);
  assert.equal(easternLocalInstant("2026-11-13",8),TO);
  assert.equal(easternLocalInstant("2026-07-13",3),"2026-07-13T07:00:00.000Z");
});
