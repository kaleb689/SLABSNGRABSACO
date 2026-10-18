import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { pokemonCenterFulfillmentDetails, mergeRetailerFulfillmentItems } from "../retailer-order-enrichment.js";
import { checkoutOrderValue, checkoutPaidAmount, checkoutItemSubtotal,
  checkoutPriceSignature, checkoutUnitPrice } from "../checkout-price-policy.js";
import { shippingStatusFromMessage } from "../shipping-tracking-policy.js";

const products = [
  ["Mew", "Day", "166"], ["Lapras", "Day", "169"],
  ["Pikachu", "Night", "172"], ["Pikachu", "Day", "167"],
  ["Espeon", "Day", "168"], ["Greninja", "Night", "174"],
  ["Moltres", "Day", "170"], ["Zapdos", "Night", "175"],
  ["Mewtwo", "Night", "171"], ["Umbreon", "Night", "173"]
];
const name = ([pokemon, time]) => "Pokémon TCG: 30th Celebration Mini Tin – " + pokemon + " (" + time + ")";
const detail = products.map(row => name(row) + "\nSKU # : 10-10465-" + row[2] + "\nQty : 1").join("\n\n");
const text = "Hello!\nYour package has shipped!\nTracking Number: 987654321012\nFedEx\n" +
  "Order Details\nOrder Subtotal: $99.90\nOrder Number: TEST-PKC-20261015\n" +
  "Order Summary\n" + detail + "\nCustomer Support";
const receipt = () => pokemonCenterFulfillmentDetails({
  subject: "Your Pokémon Center order is on its way!", text
});

test("PKC shipping receipt yields all ten distinct SKU lines and carrier number", () => {
  const parsed=receipt();
  assert.equal(parsed.items.length, 10);
  assert.equal(parsed.items.reduce((sum,item)=>sum+item.quantity,0), 10);
  assert.equal(new Set(parsed.items.map(item=>item.sku)).size, 10);
  assert.equal(parsed.subtotal, 99.90);
  assert.equal(parsed.carrier, "FedEx");
  assert.equal(parsed.trackingNumber, "987654321012");
  assert.match(parsed.items[9].name, /Umbreon \(Night\)/);
});

test("PKC matching keeps prior unit prices while restoring six missing products", () => {
  const existing=receipt().items.slice(0,4).map(item=>({...item,price:10.64,imageUrl:"https://example.test/img.png"}));
  const complete=mergeRetailerFulfillmentItems(existing,receipt().items);
  assert.equal(complete.itemCount,10);
  assert.equal(complete.items.length,10);
  assert.equal(complete.items[0].price,10.64);
  assert.equal(complete.items[0].imageUrl,existing[0].imageUrl);
  assert.equal(complete.items[9].quantity,1);
  assert.equal(complete.items[9].price,0,"Do not invent a unit price from subtotal");
  const repeat=mergeRetailerFulfillmentItems(complete.items,receipt().items);
  assert.equal(repeat.changed,false);
  assert.equal(repeat.itemCount,10);
});

test("item subtotal stays provisional; exact tax-inclusive final order total wins", () => {
  const items=receipt().items.map(item=>({...item,price:9.99}));
  const provisional={items,orderTotal:99.90,orderTotalBasis:"item_subtotal"};
  const final={...provisional,orderTotal:106.40,orderTotalBasis:"retailer_receipt"};
  assert.equal(checkoutOrderValue(provisional).amount,99.90);
  assert.equal(checkoutPaidAmount(provisional),null);
  assert.equal(checkoutItemSubtotal(provisional),99.90);
  assert.equal(checkoutOrderValue(final).amount,106.40);
  assert.equal(checkoutPaidAmount(final),106.40);
});

test("PKC label-created email is shipped, not falsely in-transit",()=>{
  assert.equal(shippingStatusFromMessage("Your Pokémon Center order is on its way!",
    "Label Created. Date pending. Your package has shipped!"),"shipped");
});

test("public Hits include the tenth PKC item and the verified tax-inclusive amount",()=>{
  const source=readFileSync(new URL("../server.js",import.meta.url),"utf8");
  const start=source.indexOf("function publicDiscordHitPayload(");
  const end=source.indexOf("async function postDiscordHit(",start);
  assert.ok(start > 0 && end > start);
  const order={
    retailer:"PKC",status:"confirmed",orderNumber:"TEST-PRIVATE-ORDER",
    sourceProfileLabel:"private owner",orderTotal:106.40,orderTotalBasis:"retailer_receipt",
    items:receipt().items.map(item=>({...item,price:9.99}))
  };
  const context={order,payload:null,
    isModuleLifecycleCheckout:()=>false,confirmedDiscordPurchase:o=>o.status==="confirmed",
    normalizeSuccessRetailer:()=> "PKC", publicSuccessProductName:v=>String(v||"").trim(),
    publicSuccessProductImage:()=>null,clean:(v,n)=>String(v||"").slice(0,n),
    checkoutUnitPrice,checkoutPaidAmount,checkoutItemSubtotal};
  vm.runInNewContext(source.slice(start,end)+"\npayload=publicDiscordHitPayload(order);",context);
  const payload=JSON.parse(JSON.stringify(context.payload));
  assert.equal(payload.embeds.length,10,"One main embed and nine item cards fit Discord limits");
  assert.equal(payload.embeds[0].fields.at(-1).value,"$106.40");
  assert.match(payload.embeds[9].description,/Umbreon \(Night\)/);
  const all=JSON.stringify(payload);
  assert.doesNotMatch(all,/TEST-PRIVATE-ORDER|private owner|master inbox|customerAccountId/i);
});

test("changing product ten changes the public Hit cache signature",()=>{
  const order={orderTotal:106.40,orderTotalBasis:"retailer_receipt",
    items:receipt().items.map(item=>({...item,price:9.99}))};
  assert.notEqual(checkoutPriceSignature(order),checkoutPriceSignature({...order,
    items:order.items.map((item,i)=>i===9?{...item,quantity:2}:item)}));
  assert.notEqual(checkoutPriceSignature(order),checkoutPriceSignature({...order,
    items:order.items.map((item,i)=>i===9?{...item,name:"Another valid item"}:item)}));
  assert.equal(checkoutPriceSignature(order),checkoutPriceSignature(order));
});

test("customer payload exposes shipment status, carrier and tracking but no business mailbox",()=>{
  const source=readFileSync(new URL("../server.js",import.meta.url),"utf8");
  const customer=source.slice(source.indexOf("function safeSuccessCheckout("),
    source.indexOf("async function sendDiscordSuccessNotification("));
  assert.match(customer,/carrier: clean\(record\.shipping\.carrier/);
  assert.match(customer,/trackingNumber: clean\(record\.shipping\.trackingNumber/);
  assert.doesNotMatch(customer,/accountEmail:|masterInbox:|sourceProfileLabel:/);
  assert.match(source,/mergeRetailerFulfillmentItems\(record\.items, pkcDetails\.items\)/);
  assert.match(source,/queueDiscordSuccessScan\(350\)/);
});
