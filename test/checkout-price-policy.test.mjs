import test from "node:test";
import assert from "node:assert/strict";
import { checkoutPaidAmount, checkoutItemSubtotal, checkoutUnitPrice, checkoutExplicitPaidTotal } from "../checkout-price-policy.js";
import { reconcileWebhookCheckout } from "../webhook-success.js";

test("verified spending counts only explicit order totals and matched retailer receipts",()=>{
  assert.equal(checkoutPaidAmount({orderTotal:79.98,orderTotalBasis:"item_subtotal"}),null);
  assert.equal(checkoutItemSubtotal({orderTotal:79.98,orderTotalBasis:"item_subtotal"}),79.98);
  assert.equal(checkoutPaidAmount({orderTotal:82.47,orderTotalBasis:"order_total"}),82.47);
  assert.equal(checkoutPaidAmount({orderTotal:82.47,orderTotalBasis:"retailer_receipt"}),82.47);
  assert.equal(checkoutPaidAmount({orderTotal:0,orderTotalBasis:"order_total"}),null);
  assert.equal(checkoutUnitPrice({price:39.99}),39.99);
  assert.equal(checkoutUnitPrice({price:"n/a"}),null);
});

test("authoritative Discord webhook parses an explicit paid total but never substitutes item prices",()=>{
  const message=(fields,description="")=>({content:"",embeds:[{description,fields}]});
  assert.equal(checkoutExplicitPaidTotal(message([
    {name:"Price",value:"$39.99"},{name:"Quantity",value:"2"}
  ])),null);
  assert.equal(checkoutExplicitPaidTotal(message([
    {name:"Subtotal",value:"$79.98"},{name:"Order Total",value:"$85.41"}
  ])),85.41);
  assert.equal(checkoutExplicitPaidTotal(message([],
    "Order Total\n$85.41\nPrice\n$39.99")),85.41);
  assert.equal(checkoutExplicitPaidTotal(message([
    {name:"Order Total",value:"$85.41"},{name:"Total Charged",value:"$88.00"}
  ])),null);
  assert.equal(checkoutExplicitPaidTotal(message([
    {name:"Price",value:"$39.99"}
  ],"Order estimate: $99.99")),null);
});

test("receipt verified paid amount is not overwritten by later unpriced or subtotal-only webhook",()=>{
  const id="discord:1532179373292257290:1599999999999999999";
  const order={id,retailer:"Target",orderNumber:"123456789",checkoutAt:"2026-10-09T08:00:00Z",
    status:"confirmed",items:[{name:"TCG tin",quantity:2,price:0}],itemCount:2,
    orderTotalBasis:"unknown",orderTotal:0};
  const records=[];
  reconcileWebhookCheckout(records,order,{customerAccountId:"member-123"});
  const priced={...order,orderTotalBasis:"item_subtotal",orderTotal:39.98,
    items:[{name:"TCG tin",quantity:2,price:19.99}]};
  reconcileWebhookCheckout(records,priced);
  assert.equal(records[0].orderTotal,39.98);
  assert.equal(records[0].orderTotalBasis,"item_subtotal");
  const real={...priced,orderTotal:44.82,orderTotalBasis:"retailer_receipt",
    priceSource:"verified_retailer_receipt"};
  reconcileWebhookCheckout(records,real);
  assert.equal(records[0].orderTotal,44.82);
  assert.equal(records[0].orderTotalBasis,"retailer_receipt");
  assert.equal(records[0].customerAccountId,"member-123");
  // A status-only webhook that omits product prices must retain the
  // original unit price so the public Discord price is not erased.
  const missingPrice={...priced,orderTotalBasis:"unknown",orderTotal:0,
    items:[{name:"TCG tin",quantity:2}]};
  reconcileWebhookCheckout(records,missingPrice);
  assert.equal(records[0].items[0].price,19.99);
  reconcileWebhookCheckout(records,priced);
  assert.equal(records.length,1);
  assert.equal(records[0].orderTotal,44.82);
  assert.equal(records[0].orderTotalBasis,"retailer_receipt");
});
