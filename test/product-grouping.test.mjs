import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { productGroupKey } from "../public/product-grouping.js";
import { dashboardProducts } from "../public/app-dashboard-data.js";

test("retailer naming variants group without collapsing product variants or pack sizes", () => {
  const equivalent = [
    ["Pokémon TCG: Scarlet & Violet—Prismatic Evolutions Booster Bundle", "Pokemon Trading Card Game Scarlet and Violet: Prismatic Evolutions Booster Bundle"],
    ["Target: Pokémon TCG Charizard ex Elite Trainer Box", "Walmart - Pokemon Charizard EX ETB"],
    ["Pokemon TCG Scarlet & Violet 151 Binder Collection", "Pokémon 151 Scarlet + Violet Collection Binder"],
    ["Pokemon SV Prismatic Evolutions Booster Bundle", "Pokémon Scarlet & Violet Prismatic Evolutions Booster Bundle"],
    ["Pokémon Paldean Fates Booster Bundle 6pk", "Pokemon TCG Paldean Fates Booster Bundle 6-Pack"]
  ];
  for (const [a, b] of equivalent) assert.equal(productGroupKey(a), productGroupKey(b));
  const different = [
    ["Pokémon Prismatic Evolutions 3-pack Blister", "Pokemon Prismatic Evolutions 6-pack Blister"],
    ["Pokémon Prismatic Evolutions Booster Bundle", "Pokemon Prismatic Evolutions Elite Trainer Box"],
    ["Pokemon Center Elite Trainer Box", "Pokemon Elite Trainer Box"],
    ["Pokemon Elite Trainer Box - Pokemon Center", "Pokemon Elite Trainer Box"]
  ];
  for (const [a, b] of different) assert.notEqual(productGroupKey(a), productGroupKey(b));
});

test("customer app shows one grouped product with correct quantities, value and source retailers", () => {
  const products = dashboardProducts([
    {retailer:"Target", items:[
      {name:"Pokémon TCG: Paldean Fates Booster Bundle",quantity:2,price:24.99,imageUrl:"https://example.com/product.jpg"},
      {name:"Pokemon Paldean Fates Booster Bundle",quantity:1,price:24.99}
    ]},
    {retailer:"Walmart", shipping:{status:"delivered"}, items:[
      {name:"Pokemon Trading Card Game: Paldean Fates Booster Bundle",quantity:3,price:23.99}
    ]}
  ]);
  assert.equal(products.length, 1);
  assert.equal(products[0].quantity, 6);
  assert.equal(products[0].delivered, 3);
  assert.equal(products[0].orders, 2);
  assert.equal(Math.round(products[0].value * 100), 3*2499 + 3*2399);
  assert.equal(products[0].retailer, "Target · Walmart");
  assert.equal(products[0].imageUrl, "https://example.com/product.jpg");
});

test("public home product cards combine cross-retailer item counts without changing checkout totals", async () => {
  const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const start = server.indexOf("/* Public totals contain only aggregate values and product counts. */");
  const end = server.indexOf("async function saveSuccessCheckouts(records)", start);
  assert.ok(start > 0 && end > start);
  const records = [
    {status:"confirmed",retailer:"Target",checkoutAt:"2026-10-08T00:00:00Z",orderTotal:50,
      items:[{name:"Pokémon TCG: Paldean Fates Booster Bundle",quantity:2,imageUrl:"https://example.com/product.jpg"}]},
    {status:"confirmed",retailer:"Walmart",checkoutAt:"2026-10-09T00:00:00Z",orderTotal:25,
      items:[{name:"Pokemon Trading Card Game Paldean Fates Booster Bundle",quantity:1}]},
    {status:"confirmed",retailer:"PKC",checkoutAt:"2026-10-10T00:00:00Z",orderTotal:66,
      items:[{name:"Pokémon Paldean Fates Elite Trainer Box",quantity:1}]},
    {status:"cancelled",retailer:"Walmart",checkoutAt:"2026-10-11T00:00:00Z",orderTotal:500,
      items:[{name:"Pokémon Paldean Fates Booster Bundle",quantity:20}]}
  ];
  let handler, output;
  const context = {
    app:{get:(_path,fn)=>{handler=fn;}},
    discordSuccessConfig:()=>({token:null}),
    getSuccessCheckouts:async()=>records,
    discordCheckoutSourceChannels:async()=>({channels:[]}),
    visibleDiscordSuccessRecords:rows=>rows,
    confirmedDiscordPurchase:r=>r.status==="confirmed",
    publicSuccessProductName:v=>String(v||"").trim(),
    isSafeDiscordCheckoutProductName:v=>v.length>=3,
    publicSuccessProductImage:(_name,_retailer,image)=>image||null,
    checkoutPaidAmount:r=>r.orderTotal,
    productGroupKey,
    historicalPlusVerified:({checkouts,spent})=>({totalCheckouts:checkouts,totalSpent:spent}),
    console:{error:message=>{throw Error(message);}}
  };
  vm.runInNewContext(server.slice(start,end),context);
  await handler({}, {setHeader:()=>{},json:data=>{output=data;},status:()=>{throw Error("Unexpected error");}});
  assert.equal(output.totalCheckouts, 3);
  assert.equal(output.totalSpent, 141);
  assert.equal(output.products.length, 2);
  const bundle = output.products.find(p=>/Bundle/i.test(p.name));
  assert.equal(bundle.quantity, 3);
  assert.equal(bundle.imageUrl, "https://example.com/product.jpg");
});
