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

test("orange Review Hold checkouts count as placed orders, units, spend, and top products",()=>{
  const green=webhook({id:"1511111111111111800",order:"TGT0800",qty:1,price:24.99,state:"green"});
  const review=webhook({id:"1511111111111111801",at:"2026-11-13T09:30:00Z",
    order:"TGT0801",qty:2,price:24.99,state:"orange"});
  const result=recap([green,review]);
  assert.equal(result.ordersPlaced,2);
  assert.equal(result.confirmedCheckouts,1);
  assert.equal(result.reviewHoldCheckouts,1);
  assert.equal(result.totalUnits,3);
  assert.equal(result.topProducts[0].quantity,3);
  assert.equal(result.totalSpentCents,3273+5348);
  assert.equal(result.readyToPublish,true);
});
test("November 19 Target 30th Day, Ditto and Night checkouts use owner's verified TCIN retail when Discord omits prices",()=>{
  const products=[
    {name:"Pokémon Trading Card Game: 30th Celebration Ultra-Premium Collection – Day",count:7,price:249.99},
    {name:"Pokémon Trading Card Game: 30th Celebration Ditto Premium Collection",count:2,price:49.99},
    {name:"Pokémon Trading Card Game: 30th Celebration Ultra-Premium Collection – Night",count:2,price:249.99}
  ];
  const records=[];
  let order=0;
  for(const product of products)for(let i=0;i<product.count;i++){
    order++;
    const row=webhook({id:String(1511111111111111100n+BigInt(order)),
      at:"2026-11-13T09:10:00.000Z",order:"TGT2026"+order,
      qty:2,price:null,product:product.name,
      state:i%2?"orange":"green"});
    records.push(row);
  }
  const report=recap(records);
  assert.equal(report.ordersPlaced,11);
  assert.equal(report.reviewHoldCheckouts,4);
  assert.equal(report.totalUnits,22);
  assert.equal(report.ruleUnpricedOrders,0);
  assert.equal(report.targetReferencePricedOrders,11);
  assert.equal(report.targetReferencePricedUnits,22);
  assert.equal(report.readyToPublish,true);
  assert.equal(report.totalSpentCents,502876);
  assert.equal(report.totalSpentBasis,"owner_verified_target_reference_retail_plus_7pct_tax_shipping");
});
test("unknown products are never assigned a Target reference price",()=>{
  const unknown=webhook({id:"1511111111111111900",order:"TGTUNKNOWN",qty:2,
    price:null,product:"Pokemon Unverified New Product"});
  const report=recap([unknown]);
  assert.equal(report.readyToPublish,false);
  assert.equal(report.missingVerifiedChargeOrders,1);
});
test("explicit original checkout price outranks Target reference retail",()=>{
  const m=webhook({id:"1511111111111111901",order:"TGTPRICE",qty:2,
    product:"Pokemon TCG: 30th Celebration Ditto Premium Collection",price:39.99});
  const report=recap([m]);
  assert.equal(report.readyToPublish,true);
  assert.equal(report.targetReferencePricedOrders,0);
  assert.equal(report.totalSpentCents,8558);
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

test("verified original Discord Total Paid can supply exact recap spend without an item price",()=>{
  const m=webhook({id:"1511111111111111400",order:"TGT00400",
    product:"Pokemon Product With Checkout Total",price:null,paid:32.73});
  const report=recap([m]);
  assert.equal(report.readyToPublish,true);
  assert.equal(report.totalSpentCents,3273);
  assert.equal(report.totalUnits,1);
  assert.equal(report.sourcePaidFallbackOrders,1);
  assert.equal(report.missingVerifiedChargeOrders,0);
  assert.equal(report.totalSpentBasis,"source_verified_paid_totals_plus_rule_calculated_orders");
});
test("mix of item-priced and explicitly paid Discord checkouts sums without double tax",()=>{
  const a=webhook({id:"1511111111111111401",order:"TGT00401",
    product:"Pokemon $24.99 Item",price:24.99});
  const b=webhook({id:"1511111111111111402",at:"2026-11-13T09:30:00Z",
    order:"TGT00402",product:"Pokemon $49.98 Checkout Only",price:null,paid:53.48});
  const report=recap([a,b]);
  assert.equal(report.readyToPublish,true);
  assert.equal(report.ruleCalculatedOrders,1);
  assert.equal(report.sourcePaidFallbackOrders,1);
  assert.equal(report.totalSpentCents,3273+5348);
});
test("unknown paid total and unknown price still block publishing",()=>{
  const m=webhook({id:"1511111111111111403",order:"TGT00403",price:null});
  const report=recap([m]);
  assert.equal(report.readyToPublish,false);
  assert.equal(report.missingVerifiedChargeOrders,1);
  assert.equal(report.totalSpentCents,null);
});
test("unknown unique product prices block total spend, never guess",()=>{
  const m=webhook({id:"1511111111111111108",order:"TGT00116",price:null,
    product:"Pokemon Unseen New Product"});
  const report=recap([m]);
  assert.equal(report.ruleUnpricedOrders,1);
  assert.equal(report.totalSpentCents,null);
  assert.equal(report.readyToPublish,false);
  assert.ok(report.blockedReasons.includes("missing_source_verified_order_total_or_unit_prices"));
});

test("blocked recap lists only safe missing-price products and counts",()=>{
  const m=webhook({id:"1511111111111111120",order:"TGT00119",price:null,
    product:"Pokemon Unseen Product"});
  const report=recap([m]);
  assert.equal(report.ruleUnpricedOrders,1);
  assert.equal(report.missingProductListOrders,0);
  assert.deepEqual(report.missingPriceProducts,[{
    name:"Pokemon Unseen Product",affectedOrders:1,affectedUnits:1
  }]);
  assert.equal(report.readyToPublish,false);
});
test("missing source order IDs block preview without crashing",()=>{
  const noId=webhook({id:"1511111111111111121",order:null,price:24.99});
  const report=recap([noId]);
  assert.equal(report.greenWithoutOrderId,1);
  assert.equal(report.readyToPublish,false);
  assert.ok(report.blockedReasons.includes("green_or_orange_missing_order_id"));
});

test("recap uses only original Discord-hosted product images from Success",()=>{
  const m=webhook({id:"1511111111111111190",order:"TGT00990",price:24.99});
  m.sampleProduct="Pokemon Original Discord Image";
  const withImage={...m,sampleImage:"https://cdn.discordapp.com/attachments/123/456/real.png"};
  const result=buildDiscordSourceRecap([withImage],{
    channelId:SLABSNGRABSTC_SUCCESS_CHANNEL_ID,from:FROM,toExclusive:TO,
    asOf:LATER,retailer:"Target",historyComplete:true,
    parseCheckout:msg=>({...parseCheckout(msg),items:[{
      name:msg.sampleProduct,quantity:1,price:24.99,imageUrl:msg.sampleImage
    }]})
  });
  assert.equal(result.readyToPublish,true);
  assert.equal(result.topProducts[0].imageUrl,withImage.sampleImage);
  const substituted=buildDiscordSourceRecap([{...withImage,sampleImage:"https://example.com/random-stock.png"}],{
    channelId:SLABSNGRABSTC_SUCCESS_CHANNEL_ID,from:FROM,toExclusive:TO,
    asOf:LATER,retailer:"Target",historyComplete:true,
    parseCheckout:msg=>({...parseCheckout(msg),items:[{
      name:msg.sampleProduct,quantity:1,price:24.99,imageUrl:msg.sampleImage
    }]})
  });
  assert.equal(substituted.topProducts[0].imageUrl,null);
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
