import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { checkoutPaidAmount, checkoutItemSubtotal, checkoutUnitPrice, checkoutPriceSignature } from "../checkout-price-policy.js";
import { planDiscordCommunityHits } from "../discord-hit-mirror-policy.js";

const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");

function renderHit(order) {
  const start = server.indexOf("function publicDiscordHitPayload(order) {");
  const end = server.indexOf("\nasync function postDiscordHit(", start);
  assert.ok(start !== -1 && end > start, "use actual Discord hit renderer");
  const context = {
    order, payload: null,
    confirmedDiscordPurchase: o => o.status === "confirmed",
    normalizeSuccessRetailer: r => r === "PKC" ? "PKC" : String(r || "Retailer"),
    publicSuccessProductName: s => String(s || "").trim().replace(/^\*\*(.+)\*\*$/, "$1"),
    publicSuccessProductImage: (_n, _r, url) => url || null,
    clean: (s, len) => String(s || "").slice(0, len),
    checkoutPaidAmount, checkoutItemSubtotal, checkoutUnitPrice
  };
  vm.runInNewContext(server.slice(start, end) +
    "\npayload = publicDiscordHitPayload(order);", context);
  return JSON.parse(JSON.stringify(context.payload));
}

test("Discord hits show verified paid totals, per-item prices and thumbnails without any identity", () => {
  const payload = renderHit({
    status:"confirmed", retailer:"Target",orderTotal:199.99,orderTotalBasis:"order_total",
    orderNumber:"123456789",sourceProfileLabel:"private profile",
    items:[
      {name:"Pokémon Charmander Tech Sticker",quantity:2,price:19.99,imageUrl:"https://target.scene7.com/is/image/Target/verified"},
      {name:"Pokémon Delta Reign Three-Booster Blister",quantity:3,price:14.99,imageUrl:"https://target.scene7.com/is/image/Target/second"}
    ]
  });
  assert.equal(payload.embeds[0].title,"Successful Checkout!");
  assert.equal(payload.embeds[0].color,0x00ff00);
  assert.equal(payload.embeds[0].thumbnail.url,"https://target.scene7.com/is/image/Target/verified");
  assert.equal(payload.embeds[1].thumbnail.url,"https://target.scene7.com/is/image/Target/second");
  assert.deepEqual(payload.embeds[0].fields.map(field=>field.name),[
    "Site","Product (1)","Quantity (1)","Unit price (1)",
    "Product (2)","Quantity (2)","Unit price (2)","Total paid at checkout"
  ]);
  assert.equal(payload.embeds[0].fields[3].value,"$19.99");
  assert.equal(payload.embeds[0].fields[6].value,"$14.99");
  assert.equal(payload.embeds[0].fields[7].value,"$199.99");
  const json=JSON.stringify(payload);
  for(const secret of ["123456789","private profile","Account","Password","Shipping"]){
    assert.equal(json.includes(secret),false,"Never expose private order information: "+secret);
  }
});

test("item subtotal is labelled estimated, never misrepresented as actual paid total",()=>{
  const hit=renderHit({
    status:"confirmed",retailer:"Target",orderTotal:79.98,orderTotalBasis:"item_subtotal",
    items:[{name:"Pokémon Elite Trainer Box",quantity:2,price:39.99}]
  });
  const fields=hit.embeds[0].fields;
  assert.equal(fields.find(f=>f.name==="Unit price (1)")?.value,"$39.99");
  assert.equal(fields.find(f=>f.name==="Items subtotal (before tax / shipping)")?.value,"$79.98");
  assert.equal(fields.find(f=>f.name==="Total paid at checkout")?.value,"Pending verification");
});

test("unknown prices visibly await verification and do not produce a broken image",()=>{
  const hit=renderHit({status:"confirmed",retailer:"Target",
    items:[{name:"Pokémon item",quantity:2,price:0}]});
  assert.equal(hit.embeds.length,1);
  assert.equal(hit.embeds[0].thumbnail,undefined);
  assert.equal(hit.embeds[0].fields.find(f=>f.name==="Unit price (1)")?.value,"Pending verification");
  assert.equal(hit.embeds[0].fields.find(f=>f.name==="Total paid at checkout")?.value,"Pending verification");
});

test("unconfirmed and cancelled source orders never become green public hits",()=>{
  const base={retailer:"Target",items:[{name:"Pokémon item",quantity:1,price:20}]};
  assert.equal(renderHit({...base,status:"review_hold"}),null);
  assert.equal(renderHit({...base,status:"cancelled"}),null);
});

test("price enrichment edits the existing Discord hit without generating a duplicate",()=>{
  const channel="1532179373292257290";
  const sourceId="1599999999999999999";
  const key="discord:"+channel+":"+sourceId;
  const before={id:key,status:"confirmed",retailer:"Target",
    orderTotal:0,orderTotalBasis:"unknown",items:[{name:"TCG tin",quantity:2,price:0}]};
  const after={...before,orderTotal:46.95,orderTotalBasis:"retailer_receipt"};
  const sent={[sourceId]:{messageId:"1599999999999998888",renderVersion:4,
    priceSignature:checkoutPriceSignature(before)}};
  const plan=planDiscordCommunityHits([after],channel,sent,4);
  assert.equal(plan.newHits.length,0);
  assert.equal(plan.updates.length,1);
  assert.equal(plan.updates[0].messageId,sent[sourceId].messageId);
});

test("hits mirror backfills unmatched canonical orders without resetting sent history", () => {
  const start = server.indexOf("async function mirrorDiscordCheckoutHits(");
  const end = server.indexOf("\nfunction discordCheckoutIdentity(", start);
  assert.ok(start > -1 && end > start);
  const mirror = server.slice(start, end);
  assert.match(mirror, /planDiscordCommunityHits\(records/);
  assert.match(mirror, /method: "PATCH"/);
  assert.match(mirror, /method: "DELETE"/);
  assert.match(mirror, /No fallback to POST/);
  assert.match(mirror, /if \(state\.sent\[entry\.sourceMessageId\]\) continue;/);
  assert.match(mirror, /const plan = planDiscordCommunityHits/);
  assert.doesNotMatch(mirror, /clearBotHitMessages\(token/);
  assert.doesNotMatch(mirror, /customerAccountId/);
  assert.match(mirror, /DISCORD_HIT_RENDER_VERSION/);
});

test("Discord scanner mirrors reconciled orders, not raw green-only imports", () => {
  const start = server.indexOf("async function scanDiscordSuccessChannel(");
  const end = server.indexOf("\n// Secure review of checkout labels", start);
  assert.ok(start > -1 && end > start);
  const scan = server.slice(start, end);
  assert.match(scan, /authoritativeDiscordCheckouts\(\s*await getSuccessCheckouts\(\), channels\)/);
  assert.match(scan, /mirrorDiscordCheckoutHits\(\s*communityRecords, token, channels\[0\]\)/);
  assert.doesNotMatch(scan, /mirrorDiscordCheckoutHits\(imports\.filter/);
});

test("community total logic counts unassigned confirmed checkouts but not cancellations or holds", () => {
  const start = server.indexOf('"/api/public/success"');
  const end = server.indexOf("async function saveSuccessCheckouts(", start);
  assert.ok(start > 0 && end > start);
  const handler = server.slice(start, end);
  assert.match(handler, /visibleDiscordSuccessRecords/);
  assert.match(handler, /totalCheckouts \+= 1/);
  assert.doesNotMatch(handler, /customerAccountId/);
  assert.match(handler, /pricePendingCheckouts/);
  assert.match(handler, /publicSuccessProductImage/);
});
