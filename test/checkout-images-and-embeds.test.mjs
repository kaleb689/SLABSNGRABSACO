import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { verifiedSkuProductImage, verifiedTinVariants } from "../checkout-product-image-policy.js";
import { dashboardProducts } from "../public/app-dashboard-data.js";
import {
  checkoutIdentityFromDiscord, checkoutStatusFromDiscord, checkoutProductFromDiscord
} from "../discord-checkout-identity.js";
import { checkoutExplicitPaidTotal } from "../checkout-price-policy.js";
import { isModuleLifecycleDiscordMessage } from "../discord-checkout-event-policy.js";

const src=readFileSync(new URL("../server.js",import.meta.url),"utf8");
const start=src.indexOf("function discordCheckoutFromMessage(");
const end=src.indexOf("const DISCORD_HIT_MIRROR_FILE",start);
assert.ok(start>0 && end>start);
const parseSource=src.slice(start,end);
const channel="1532179373292257290";
function parse(message) {
  const scope = {
    message,channel,parsed:null,
    discordCheckoutIdentity:checkoutIdentityFromDiscord,
    checkoutStatusFromDiscord,checkoutProductFromDiscord,checkoutExplicitPaidTotal,
    isModuleLifecycleDiscordMessage,
    publicSuccessProductName:s=>String(s||"").slice(0,120).trim(),
    isSafeDiscordCheckoutProductName:s=>Boolean(
      String(s||"").length>=3 && !/@|https?:|password|account|address/i.test(s)),
    publicSuccessImageUrl:v=>v||null,
    normalizeSuccessRetailer:v=>String(v||"")
  };
  vm.runInNewContext(parseSource+"\nparsed=discordCheckoutFromMessage(message,channel);",scope);
  return JSON.parse(JSON.stringify(scope.parsed));
}
const itemName=x=>"Pokemon TCG: 30th Celebration Mini Tin – "+x.name;
const productFields=(products,reset=false)=>products.flatMap((item,index)=>{
  const n=reset?index+1:index+1;
  return [
    {name:"Product Name ("+n+")",value:itemName(item)},
    {name:"Qty ("+n+")",value:"1"},
    {name:"Unit Price ("+n+")",value:"$9.99"}
  ];
});
const envelope=embeds=>({
  id:"1580000000000009001",timestamp:"2026-10-15T17:30:00Z",
  webhook_id:"1580000000000009002",embeds
});

test("multi-embed Discord webhook restores ten distinct products and one taxed order total",()=>{
  const products=verifiedTinVariants();
  const first={title:"Checkout Success",color:0x57f287,
    thumbnail:{url:"https://example.test/first.png"},
    fields:[{name:"Site",value:"Pokemon Center US"},
      {name:"Order Total",value:"$106.40"},
      ...productFields(products.slice(0,7))]};
  const second={title:"Additional products",color:0x57f287,
    thumbnail:{url:"https://example.test/second.png"},
    fields:productFields(products.slice(7))}; // Numbering restarts at 1.
  const result=parse(envelope([first,second]));
  assert.ok(result);
  assert.equal(result.items.length,10);
  assert.equal(result.itemCount,10);
  assert.equal(result.orderTotal,106.40);
  assert.equal(result.orderTotalBasis,"order_total");
  assert.equal(new Set(result.items.map(x=>x.name)).size,10);
  assert.equal(result.items[0].name,itemName(products[0]));
  assert.equal(result.items[9].name,itemName(products[9]));
  // An embed thumbnail does not prove the identity of seven distinct SKUs.
  assert.equal(result.items[0].imageUrl,null);
  assert.equal(result.items[9].imageUrl,null);
});

test("individual embed images stay with their own SKU and duplicated embed is ignored",()=>{
  const items=verifiedTinVariants();
  const fields=(x)=>[{name:"Site",value:"Pokemon Center US"},
    {name:"Product",value:itemName(x)},{name:"Quantity",value:"1"},{name:"Unit Price",value:"9.99"}];
  const result=parse(envelope([
    {title:"Checkout Success",color:0x57f287,
      thumbnail:{url:"https://example.test/mew.png"},fields:fields(items[0])},
    {title:"Extra product",color:0x57f287,
      thumbnail:{url:"https://example.test/lapras.png"},fields:fields(items[3])},
    {title:"Repeat",color:0x57f287,
      thumbnail:{url:"https://example.test/duplicate.png"},fields:fields(items[0])}
  ]));
  assert.equal(result.items.length,2);
  assert.equal(result.itemCount,2);
  assert.equal(result.items[0].imageUrl,"https://example.test/mew.png");
  assert.equal(result.items[1].imageUrl,"https://example.test/lapras.png");
});

test("SKU catalog assigns ten distinct named product pictures with collision guards",()=>{
  const variants=verifiedTinVariants();
  assert.equal(variants.length,10);
  assert.equal(new Set(variants.map(x=>x.sku)).size,10);
  assert.equal(new Set(variants.map(x=>x.imageUrl)).size,10);
  for (const item of variants) {
    const name=itemName(item);
    assert.equal(verifiedSkuProductImage(name,"PKC",item.sku),item.imageUrl);
    assert.match(item.imageUrl,/^https:\/\//);
    assert.doesNotMatch(item.imageUrl,/slabsngrabs/i);
    assert.equal(verifiedSkuProductImage(name,"Target",item.sku),null);
  }
  assert.equal(verifiedSkuProductImage(itemName(variants[0]),"PKC",variants[9].sku),null);
  assert.equal(verifiedSkuProductImage("Unknown Pokemon Tin","PKC","invalid"),null);
});

test("unknown unit prices are not represented as zero-dollar purchases",()=>{
  const rows=[{retailer:"PKC",status:"confirmed",
    items:[{name:"30th Celebration Mini Tin",quantity:1,price:9.99},
      {name:"Different tin",quantity:2,price:0}]}];
  const products=dashboardProducts(rows);
  assert.equal(products.length,2);
  assert.equal(products[0].pricedQuantity,1);
  assert.equal(products[1].unpricedQuantity,2);
  assert.equal(products[1].value,0);
  const dashboard=readFileSync(new URL("../public/app-dashboard.js",import.meta.url),"utf8");
  assert.match(dashboard,/Price pending/);
  assert.match(dashboard,/PARTIAL ITEM VALUE/);
  assert.match(dashboard,/product-image-pending\.svg/);
  assert.doesNotMatch(dashboard,/fallback = '\/slabsngrabs-aco-logo-transparent\.png'/);
});

test("customer server displays SKUs but never retailer logins or master inbox",()=>{
  const start=src.indexOf("function safeSuccessCheckout(");
  const end=src.indexOf("async function sendDiscordSuccessNotification(",start);
  const customer=src.slice(start,end);
  assert.match(customer,/safe\.sku/);
  assert.match(customer,/verifiedSkuProductImage/);
  assert.doesNotMatch(customer,/masterInbox:|accountEmail:|retailerPassword:/);
  assert.match(src,/const extraImage = localNumbered\.size === 1/);
});
