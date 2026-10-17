import test from "node:test";
import assert from "node:assert/strict";
import { reconcileWebhookCheckout } from "../webhook-success.js";
import { checkoutOrderValue } from "../checkout-price-policy.js";
import { cancelledOrder } from "../order-notifications.js";
import { readFileSync } from "node:fs";

const id="discord:1532179373292257290:1580000000000000650";
const original={
  id, retailer:"Target", orderNumber:"ABC123456789", customerAccountId:null,
  checkoutAt:"2026-10-16T10:00:00Z", statusUpdatedAt:"2026-10-16T10:00:00Z",
  status:"confirmed", orderTotalBasis:"item_subtotal", orderTotal:157.97,
  itemCount:3, items:[
    {name:"Pokemon Ultra Premium Collection",quantity:1,price:119.99},
    {name:"TCG Booster Tin",quantity:2,price:18.99}
  ]
};

test("a later partial webhook cannot erase Ultra Premium Collection, quantities, or preorder value",()=>{
  const records=[];
  reconcileWebhookCheckout(records,original,{customerAccountId:"mike"});
  const partial={...original,id:"discord:1532179373292257290:1580000000000000651",
    statusUpdatedAt:"2026-10-16T10:03:00Z",checkoutAt:"2026-10-16T10:03:00Z",
    customerAccountId:null,orderTotal:37.98,itemCount:2,
    items:[{name:"TCG Booster Tin",quantity:2,price:18.99}]};
  const result=reconcileWebhookCheckout(records,partial);
  assert.equal(result.conflict,undefined);
  assert.equal(records.length,1);
  assert.equal(records[0].customerAccountId,"mike");
  assert.equal(records[0].itemCount,3);
  assert.equal(records[0].items.find(item=>item.name==="Pokemon Ultra Premium Collection")?.price,119.99);
  assert.equal(checkoutOrderValue(records[0]).amount,157.97);
  assert.equal(records[0].sourceIds.length,2);
  reconcileWebhookCheckout(records,partial);
  assert.equal(records.length,1);
  assert.equal(records[0].itemCount,3);
  const withHigherSourceTotal=[];
  reconcileWebhookCheckout(withHigherSourceTotal,{...original,orderTotal:200},{customerAccountId:"mike"});
  reconcileWebhookCheckout(withHigherSourceTotal,partial);
  assert.equal(withHigherSourceTotal[0].orderTotal,200,"an explicitly reported higher checkout total cannot be replaced by a reconstructed subtotal");
});

test("verified retailer receipts remain authoritative and cancelled orders stop counting",()=>{
  const records=[];
  reconcileWebhookCheckout(records,{...original,orderTotal:165.02,
    orderTotalBasis:"retailer_receipt",priceSource:"verified_retailer_receipt"},
    {customerAccountId:"mike"});
  reconcileWebhookCheckout(records,{...original,checkoutAt:"2026-10-16T10:05:00Z",
    statusUpdatedAt:"2026-10-16T10:05:00Z",
    id:"discord:1532179373292257290:1580000000000000652",
    itemCount:1,items:[original.items[1]],orderTotal:18.99});
  assert.equal(checkoutOrderValue(records[0]).amount,165.02);
  const cancelled={...original,id:"discord:1532179373292257290:1580000000000000653",
    checkoutAt:"2026-10-16T10:10:00Z",statusUpdatedAt:"2026-10-16T10:10:00Z",
    status:"cancelled",cancelledAt:"2026-10-16T10:10:00Z"};
  reconcileWebhookCheckout(records,cancelled);
  assert.equal(cancelledOrder(records[0]),true);
  const displayable=records.filter(order=>!cancelledOrder(order));
  assert.equal(displayable.length,0);
});

test("Admin and customer paths expose placed values separately from payments",()=>{
  const server=readFileSync(new URL("../server.js",import.meta.url),"utf8");
  const mobile=readFileSync(new URL("../public/admin-mobile.js",import.meta.url),"utf8");
  assert.match(server,/checkoutValue: safe.checkoutValue/);
  assert.match(server,/checkoutValueKnown: safe.checkoutValueKnown/);
  assert.match(server,/verifiedSameDayCheckoutOwner\(order, identity, verifiedPastOrders/);
  assert.match(mobile,/const amount=x=>x\?\.checkoutValueKnown===true/);
  assert.match(mobile,/TOTAL CHECKOUT VALUE/);
  assert.match(mobile,/Order value unavailable from checkout source/);
  assert.doesNotMatch(mobile,/known\?dollars\(order.orderTotal\):"\$0.00"/);
  assert.match(mobile,/tab!=="success"/);
  assert.match(mobile,/#content details\[open\]/);
});
