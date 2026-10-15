import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { checkoutStatusFromDiscord, checkoutIdentityFromDiscord, checkoutProductFromDiscord } from "../discord-checkout-identity.js";
import { checkoutExplicitPaidTotal, checkoutPaidAmount } from "../checkout-price-policy.js";
import { authoritativeDiscordCheckouts } from "../success-source-policy.js";
import { planDiscordCommunityHits } from "../discord-hit-mirror-policy.js";

const server = fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
const sourceChannelId = "1532179373292257290";
const parserStart = server.indexOf("function discordCheckoutFromMessage(");
const parserEnd = server.indexOf("const DISCORD_HIT_MIRROR_FILE",parserStart);
assert.ok(parserStart >= 0 && parserEnd > parserStart);

function parse(message) {
  const scope = {
    message, channelId: sourceChannelId, result: null,
    checkoutStatusFromDiscord, checkoutIdentityFromDiscord, checkoutProductFromDiscord,
    checkoutExplicitPaidTotal,
    discordCheckoutIdentity: checkoutIdentityFromDiscord,
    publicSuccessProductName: s => String(s || "").slice(0,120).trim(),
    isSafeDiscordCheckoutProductName: s => Boolean(String(s || "").trim().length>=3 && !/@|password|account|address/i.test(s)),
    publicSuccessImageUrl: () => null,
    normalizeSuccessRetailer: s => String(s || "")
  };
  vm.runInNewContext(server.slice(parserStart,parserEnd) +
    "\nresult=discordCheckoutFromMessage(message,channelId);",scope);
  return JSON.parse(JSON.stringify(scope.result));
}
function rawGreen(id, quantity, statusColor=0x57f287) {
  return {
    id,webhook_id:"1580000000000000777",timestamp:"2026-10-15T19:00:00Z",
    embeds:[{title:"Checkout Success",color:statusColor,fields:[
      {name:"Site",value:"Pokemon Center US"},
      {name:"Product (1)",value:"Pokemon TCG: 30th Celebration Mini Tin"},
      {name:"Quantity (1)",value:quantity},
      {name:"Price (1)",value:"9.99"}
    ]}]
  };
}
test("unlinked green Discord checkout is eligible for hits without email, owner, or order number",()=>{
  const parsed=parse(rawGreen("1580000000000002001","||2||"));
  assert.ok(parsed);
  assert.equal(parsed.customerAccountId,null);
  assert.equal(parsed.orderNumber,"");
  assert.equal(parsed.items[0].quantity,2);
  const plan=planDiscordCommunityHits([parsed],sourceChannelId);
  assert.equal(plan.eligible,1);
  assert.equal(plan.unmatched,1);
  assert.equal(plan.newHits.length,1);
});
test("quantity text accepts unambiguous units and rejects ambiguous multi-values",()=>{
  assert.equal(parse(rawGreen("1580000000000002002","2 units")).items[0].quantity,2);
  assert.equal(parse(rawGreen("1580000000000002003","1.0 ea")).items[0].quantity,1);
  assert.equal(parse(rawGreen("1580000000000002004","Qty: x3")).items[0].quantity,3);
  assert.equal(parse(rawGreen("1580000000000002005","1/2")),null);
});
test("the real public community success handler counts unmatched green checkouts, excluding holds and cancels",async()=>{
  const green=parse(rawGreen("1580000000000002006","2"));
  const linked={...green,id:"discord:"+sourceChannelId+":1580000000000002007",
    customerAccountId:"member-123"};
  const cancelled={...green,id:"discord:"+sourceChannelId+":1580000000000002008",
    status:"cancelled",cancelledAt:"2026-10-15T19:01:00Z"};
  const hold={...green,id:"discord:"+sourceChannelId+":1580000000000002009",
    status:"review_hold"};
  const records=[green,linked,cancelled,hold];
  const routeStart=server.indexOf('app.get(\n  "/api/public/success",');
  const routeEnd=server.indexOf("\nasync function saveSuccessCheckouts(",routeStart);
  assert.ok(routeStart>=0&&routeEnd>routeStart);
  let handler;
  const context={
    app:{get:(route,h)=>{assert.equal(route,"/api/public/success");handler=h;}},
    discordSuccessConfig:()=>({token:""}),
    resolveDiscordHitsChannelId:async()=>null,
    getSuccessCheckouts:async()=>records,
    discordCheckoutSourceChannels:async()=>({channels:[sourceChannelId]}),
    visibleDiscordSuccessRecords:(arr,excluded,allowed)=>authoritativeDiscordCheckouts(arr,allowed),
    confirmedDiscordPurchase:r=>r.status==="confirmed",
    publicSuccessProductName:s=>String(s||"").trim(),
    isSafeDiscordCheckoutProductName:s=>Boolean(s),
    checkoutPaidAmount,
    publicSuccessProductImage:()=>null,
    historicalPlusVerified:current=>current,
    console
  };
  vm.runInNewContext(server.slice(routeStart,routeEnd),context);
  let payload=null,code=200;
  const response={
    setHeader(){},json(value){payload=value;return value;},
    status(next){code=next;return this;}
  };
  await handler({},response);
  assert.equal(code,200);
  assert.equal(payload.checkouts,2);
  assert.equal(payload.products[0].quantity,4);
  // Item unit prices are not proof of the final amount paid.
  assert.equal(payload.unknownPrices,2);
});
