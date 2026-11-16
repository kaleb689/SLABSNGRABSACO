import test from "node:test";
import assert from "node:assert/strict";
import {parseMonitorDropProducts,parseSkuStockDropProducts,formattedDropPayloads,FORMATTED_DROP_MARKER} from "../drop-monitor-format.js";
import {withVerifiedTargetRetail,addFixedTargetRetail,VERIFIED_TARGET_RETAIL_20261115} from "../target-sku-fixed-retail.js";
import {initialTargetMaster} from "../target-sku-master.js";
import {parseDropSkus} from "../discord-community.js";

const screenshot = `Target Online Drop Goes live at Wednesday 11/18 | 3:00 AM EST as always there may be a couple more SKUS

30th Celebration Ultra-Premium Collection - Night
SKU: 1012850572
Stock: 40k+
30th Celebration Figure Collection - Mewtwo
SKU: 1012850573
Stock: 50k+
Delta Reign Elite Trainer Box
SKU: 1012793604
Stock: 4k+
Delta Reign Booster Bundle
SKU: 1013166578
Stock: 30k+
Delta Reign Three-Booster Blister
SKU: 1013166573Ś
Stock: 9k+
30th Celebration Ultra-Premium Collection - Day
SKU: 1012850570
Stock: 10k+
Delta Reign Booster Display
SKU: 1013166576
Stock: 3k+
30th Celebration Figure Collection - Mew
SKU: 1012793603
Stock: 20k+
30th Celebration Ditto Premium Collection
SKU: 1012663804
Stock: 9k+
Ascended Heroes Premium Poster Collection Mega Lucario
SKU: 95093981
Stock: 3k+`;

const verified = addFixedTargetRetail(initialTargetMaster()).master;

test("owner stock-only screenshot parses 10 SKUs without an entered price",()=>{
  assert.equal(parseMonitorDropProducts(screenshot).length,0);
  const parsed=parseSkuStockDropProducts(screenshot);
  assert.equal(parsed.products.length,10);
  assert.equal(new Set(parsed.products.map(x=>x.sku)).size,10);
  assert.equal(parsed.products[4].sku,"1013166573");
  assert.equal(parsed.products[4].itemNumberNeedsReview,true);
  assert.deepEqual(parseDropSkus({content:screenshot}).map(x=>x.sku),parsed.products.map(x=>x.sku));
  assert.deepEqual(parsed.products.map(x=>x.stock),[
    "40k+","50k+","4k+","30k+","9k+","10k+","3k+","20k+","9k+","3k+"
  ]);
  assert.match(parsed.header,/Wednesday 11\/18 \| 3:00 AM EST/);
});

test("verified Target retail fills ten recognized products and never changes posted IDs",()=>{
  const parsed=parseSkuStockDropProducts(screenshot);
  const filled=withVerifiedTargetRetail(parsed.products,verified);
  assert.deepEqual(filled.map(x=>x.price),[
    "249.99","39.99","59.99","31.99","14.99",
    "249.99","179.99","39.99","49.99","54.99"
  ]);
  assert.equal(filled[4].sku,"1013166573");
  assert.equal(filled[4].itemNumberNeedsReview,true);
  assert.equal(VERIFIED_TARGET_RETAIL_20261115["1013166573"],14.99);
  const cards=formattedDropPayloads(filled,"Target Drops",{header:parsed.header});
  assert.equal(cards.length,1);
  assert.equal(cards[0].embeds.length,10);
  assert.deepEqual(cards[0].allowed_mentions,{parse:[]});
  assert.ok(cards[0].embeds.every(x=>x.color===0x38dce8&&x.footer.text===FORMATTED_DROP_MARKER));
  assert.match(cards[0].embeds[0].description,/Price \$249\.99\nSKU: 1012850572\nStock: 40k\+/);
  assert.match(cards[0].embeds[4].description,/Posted item number needs verification/);
  assert.match(cards[0].embeds[0].description,/Wednesday 11\/18/);
  assert.deepEqual(cards.flatMap(x=>parseDropSkus(x).map(y=>y.sku)),
    parsed.products.map(x=>x.sku));
});

test("unverified or non-Target prices stay pending; explicit price is preserved",()=>{
  const list=[{name:"Unverified Product",sku:"99999111",stock:"9k+"},
    {name:"Mystery Product",sku:"99999222",price:"21.23"},
    {name:"Old Target name",sku:"1012850572",price:"129.99"}];
  const enriched=withVerifiedTargetRetail(list,verified);
  assert.equal(enriched[0].price,undefined);
  assert.equal(enriched[1].price,"21.23");
  assert.equal(enriched[2].price,"129.99");
  const output=formattedDropPayloads(enriched,"Walmart Drops");
  assert.match(output[0].embeds[0].description,/Price pending/);
  assert.doesNotMatch(output[0].embeds[0].description,/Price \$NaN/);
});

test("stock parser refuses chat, duplicate IDs, and rich resale posts",()=>{
  assert.deepEqual(parseSkuStockDropProducts("restock soon!\nSKU: 1012850572").products,[]);
  assert.deepEqual(parseSkuStockDropProducts("Name\nSKU: 1012850572\nRetail: $5.00").products,[]);
  const parsed=parseSkuStockDropProducts("First item\nSKU: 12345678\nStock: 10k+\nFirst item\nSKU: 12345678\nStock: 20k+");
  assert.equal(parsed.products.length,1);
  assert.equal(parsed.products[0].stock,"10k+");
});

test("more than ten stock-only products keep all IDs across multiple cyan cards",()=>{
  const list=Array.from({length:21},(_,i)=>({name:"Product "+i,sku:String(80000000+i),stock:"10k+"}));
  const cards=formattedDropPayloads(list,"Target Drops");
  assert.deepEqual(cards.map(x=>x.embeds.length),[10,10,1]);
  assert.equal(cards.flatMap(x=>parseDropSkus(x)).length,21);
});


test("an accidental duplicate SKU in the Target master cannot hide a verified name match",()=>{
  const polluted=structuredClone(verified);
  polluted.entries["1013166573S"]={
    sku:"1013166573S",name:"Delta Reign Three-Booster Blister",source:"discord"
  };
  const rows=withVerifiedTargetRetail([
    {sku:"1013166573S",name:"Delta Reign Three-Booster Blister",stock:"9k+"}
  ],polluted);
  assert.equal(rows[0].price,"14.99");
  assert.equal(rows[0].sku,"1013166573S");
  assert.equal(rows[0].itemNumberNeedsReview,true);
});
