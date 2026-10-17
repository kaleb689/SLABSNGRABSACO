import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { isModuleLifecycleDiscordMessage } from "../discord-checkout-event-policy.js";
import {
  checkoutIdentityFromDiscord, checkoutStatusFromDiscord, checkoutProductFromDiscord
} from "../discord-checkout-identity.js";
import { checkoutExplicitPaidTotal } from "../checkout-price-policy.js";

// Exercise the real production parser with sanitized versions of the two
// checkout layouts shown by Valor and Stellar AIO. No customer data or tokens.
const source = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const start = source.indexOf("function discordCheckoutFromMessage(");
const end = source.indexOf("const DISCORD_HIT_MIRROR_FILE", start);
assert.ok(start > -1 && end > start);
const channel = "1532179373292257290";
function parse(message) {
  const scope = {
    message, channel, parsed:null, discordCheckoutIdentity:checkoutIdentityFromDiscord,
    checkoutStatusFromDiscord, checkoutProductFromDiscord, checkoutExplicitPaidTotal,
    isModuleLifecycleDiscordMessage,
    publicSuccessProductName:s=>String(s||"").slice(0,120).trim(),
    isSafeDiscordCheckoutProductName:s=>Boolean(String(s||"").length>=3 &&
      !/@|https?:|password|account/i.test(s)),
    publicSuccessImageUrl:url=>url||null,
    normalizeSuccessRetailer:value=>String(value||"")
  };
  vm.runInNewContext(source.slice(start,end) +
    "\nparsed = discordCheckoutFromMessage(message, channel);", scope);
  return JSON.parse(JSON.stringify(scope.parsed));
}
const green = 0x57f287;
const valor = {
  id:"1580000000000000401",webhook_id:"1580000000000000501",
  timestamp:"2026-10-15T17:30:00Z",
  embeds:[{title:"Checked Out! 🎉",color:green,fields:[
    {name:"Site",value:"Pokemon Center US"},
    {name:"Product",value:"[10-10465-174](https://www.pokemoncenter.com/example) Pokemon TCG: 30th Celebration Mini Tin - Greninja (Night)"},
    {name:"Quantity",value:"1"},{name:"Price",value:"9.99"},
    {name:"Order Number",value:"ABC000012345"},{name:"Email",value:"example-buyer@example.test"}
  ]}]
};
test("Valor Checked Out webhook retains full product title after linked SKU",()=>{
  const result=parse(valor);
  assert.ok(result);
  assert.equal(result.status,"confirmed");
  assert.equal(result.items.length,1);
  assert.equal(result.items[0].quantity,1);
  assert.match(result.items[0].name,/Pokemon TCG: 30th Celebration Mini Tin/);
  assert.doesNotMatch(result.items[0].name,/https?:/);
  assert.equal(result.orderNumber,"ABC000012345");
  assert.doesNotMatch(JSON.stringify(result),/example-buyer@example.test/);
});
test("Stellar numbered checkout fields keep every mini-tin as a line item",()=>{
  const message={id:"1580000000000000402",timestamp:"2026-10-15T17:31:00Z",
    embeds:[{title:"Successful Checkout!",color:green,fields:[
      {name:"Site",value:"Pokemon Center US"},
      {name:"Product (1)",value:"Pokemon TCG: 30th Celebration Mini Tin - Mew (Day)"},
      {name:"Quantity (1)",value:"1"},{name:"Price (1)",value:"9.99"},
      {name:"Product (2)",value:"Pokemon TCG: 30th Celebration Mini Tin - Pikachu (Day)"},
      {name:"Quantity (2)",value:"1"},{name:"Price (2)",value:"9.99"},
      {name:"Product (3)",value:"Pokemon TCG: 30th Celebration Mini Tin - Espeon (Day)"},
      {name:"Quantity (3)",value:"1"},{name:"Price (3)",value:"9.99"},
      {name:"Order ID",value:"ABC000012346"}
    ]}]};
  const result=parse(message);
  assert.ok(result);
  assert.equal(result.items.length,3);
  assert.equal(result.itemCount,3);
});
test("numbered Product Name, Qty and Unit Price aliases are accepted",()=>{
  const message={id:"1580000000000000403",webhook_id:"1580000000000000503",
    timestamp:"2026-10-15T17:32:00Z",
    embeds:[{title:"Checked Out!",color:green,fields:[
      {name:"Site",value:"Target"},
      {name:"Product Name (1)",value:"Pokemon Trading Card Tins"},
      {name:"Qty (1)",value:"2"},{name:"Unit Price (1)",value:"14.99"},
      {name:"Order Number",value:"ABC000012347"}
    ]}]};
  const result=parse(message);
  assert.equal(result.items.length,1);
  assert.equal(result.items[0].quantity,2);
  assert.equal(result.items[0].price,14.99);
});
test("red Checked Out webhook stays cancelled and cannot count as a green hit",()=>{
  const message={...valor,id:"1580000000000000404",
    embeds:[{...valor.embeds[0],color:0xf04747}]};
  const result=parse(message);
  assert.equal(result.status,"cancelled");
  assert.equal(result.cancelledAt,message.timestamp);
});