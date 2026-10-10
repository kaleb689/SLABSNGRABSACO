import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { checkoutIdentityFromDiscord, checkoutStatusFromDiscord, checkoutProductFromDiscord } from "../discord-checkout-identity.js";
import { reconcileWebhookCheckout, uniqueCheckoutOwner } from "../webhook-success.js";
import { lateCancellation } from "../order-notifications.js";
import { verifiedRetailerOrderTotal } from "../retailer-order-total.js";
import { checkoutExplicitPaidTotal } from "../checkout-price-policy.js";

const channel = "1532179373292257290";
const product = "Pokemon Trading Card Game: Mega Evolution Delta Reign Three-Booster Blister";
const makeMessage = (color, id, timestamp, orderId = "102003802680520") => ({
  id, timestamp, content: "",
  embeds: [{
    title: "Successful Checkout!", color,
    description: [
      "Successful Checkout!", "[" + product + "](https://www.target.com/p/example-product)",
      "Site", "Target", "Profile", "Customer Example 4", "Order ID", orderId,
      "Quantity", "2", "Account", "retailer_test@example.test:FAKE_SECRET_VALUE",
      "Proxy", "private"
    ].join("\n")
  }]
});

function parseLiveWebhook(message) {
  const source = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const start = source.indexOf("function discordCheckoutFromMessage(");
  const end = source.indexOf("const DISCORD_HIT_MIRROR_FILE", start);
  assert.ok(start > 0 && end > start, "extract actual production parser");
  const sandbox = {
    message, channel, parsed: null, discordCheckoutIdentity: checkoutIdentityFromDiscord,
    checkoutStatusFromDiscord, checkoutProductFromDiscord, checkoutExplicitPaidTotal,
    publicSuccessProductName: s => String(s || "").slice(0, 120).trim(),
    isSafeDiscordCheckoutProductName: s => !/@|password/i.test(s),
    publicSuccessImageUrl: s => s || null,
    normalizeSuccessRetailer: s => s
  };
  vm.runInNewContext(source.slice(start, end) + "\nparsed = discordCheckoutFromMessage(message, channel);", sandbox);
  return JSON.parse(JSON.stringify(sandbox.parsed));
}

test("Shikari Account email:password is used transiently; only email is extracted", () => {
  const input = makeMessage(0x57f287,"1580000000000000001","2026-10-09T08:00:00Z");
  const parsed = checkoutIdentityFromDiscord(input);
  assert.deepEqual(parsed, { email: "retailer_test@example.test", profileName: "Customer Example 4",
    orderNumber: "102003802680520" });
  assert.ok(!JSON.stringify(parsed).includes("FAKE_SECRET_VALUE"));
  assert.equal(checkoutProductFromDiscord(input), product);
});

test("green confirmed, orange review hold, red cancelled, unknown NOT confirmed", () => {
  for (const [color, expected] of [[0x57f287,"confirmed"],[0x00ff00,"confirmed"],
    [0xff9900,"review_hold"],[0xf1c40f,"review_hold"],[0xf04747,"cancelled"],
    [0xff0000,"cancelled"],[0x5865f2,null],[0xaaaaaa,null]]) {
    assert.equal(checkoutStatusFromDiscord(makeMessage(color,"1580000000000000001","2026-10-09T08:00:00Z")), expected);
  }
});

test("actual production parser uses linked item, quantity, retailer Order ID and no account credential", () => {
  const parsed = parseLiveWebhook(makeMessage(0x57f287,"1580000000000000001","2026-10-09T08:00:00Z"));
  assert.equal(parsed.id, "discord:"+channel+":1580000000000000001");
  assert.equal(parsed.orderNumber, "102003802680520");
  assert.equal(parsed.sourceProfileLabel, "Customer Example 4");
  assert.equal(parsed.retailer, "Target");
  assert.equal(parsed.items[0].name, product);
  assert.equal(parsed.items[0].quantity, 2);
  assert.equal(parsed.itemCount, 2);
  assert.equal(parsed.status,"confirmed");
  assert.equal(parsed.orderTotalBasis,"unknown");
  assert.equal(parsed.orderTotal,0);
  assert.ok(!JSON.stringify(parsed).includes("retailer_test@example.test"));
  assert.ok(!JSON.stringify(parsed).includes("FAKE_SECRET_VALUE"));
  assert.equal("email" in parsed, false);
  assert.equal("password" in parsed, false);
});

test("green, orange and red webhook transitions reuse one exact retailer Order ID", () => {
  const green = parseLiveWebhook(makeMessage(0x57f287,"1580000000000000001","2026-10-08T05:00:00Z"));
  const orange = parseLiveWebhook(makeMessage(0xff9900,"1580000000000000002","2026-10-08T06:00:00Z"));
  const red = parseLiveWebhook(makeMessage(0xff0000,"1580000000000000003","2026-10-09T07:00:00Z"));
  const records=[];
  assert.equal(reconcileWebhookCheckout(records,green,{customerAccountId:"member-a"}).added,true);
  assert.equal(reconcileWebhookCheckout(records,orange).added,false);
  assert.equal(records.length,1);
  assert.equal(records[0].status,"review_hold");
  assert.equal(records[0].customerAccountId,"member-a");
  assert.equal(reconcileWebhookCheckout(records,red).added,false);
  assert.equal(records[0].status,"cancelled");
  assert.equal(records[0].cancelledAt,red.checkoutAt);
  assert.equal(records[0].checkoutAt,green.checkoutAt);
  assert.equal(lateCancellation(records[0]),true);
  assert.equal(reconcileWebhookCheckout(records,green).changed,false);
  assert.equal(records.length,1);
  assert.equal(records[0].status,"cancelled");
});

test("repeated hooks do not create new checkouts or invent costs", () => {
  const record = parseLiveWebhook(makeMessage(0x57f287,"1580000000000000009","2026-10-08T12:00:00Z"));
  const records=[];
  reconcileWebhookCheckout(records,record,{customerAccountId:"member-a"});
  assert.equal(reconcileWebhookCheckout(records,record).changed,false);
  assert.equal(records.length,1);
  assert.equal(records[0].orderTotalBasis,"unknown");
});

test("when Shikari provides Account email, a wrong profile label cannot override owner matching", () => {
  const source = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const start = source.indexOf("function discordCheckoutCandidateEligible(");
  const end = source.indexOf("let discordSuccessScanQueued =",start);
  const sandbox = {
    uniqueCheckoutOwner, resolveApprovedCheckoutAlias: () => ({customerAccountId:"wrong-from-alias"}),
    assignmentTimeContainsCheckout: () => true,
    order: {retailer:"Target",checkoutAt:"2026-10-09T08:00:00Z",sourceProfileLabel:"Example profile"},
    candidates: [
      {customerAccountId:"correct",retailer:"Target",email:"retailer_test@example.test",profileName:"Different profile"},
      {customerAccountId:"wrong",retailer:"Target",email:"other@example.test",profileName:"Example profile"}
    ]
  };
  vm.runInNewContext(source.slice(start,end) +
    "\nmatched=discordCheckoutAttribution(order,{email:'retailer_test@example.test',profileName:'Example profile'},candidates);" +
    "\nwrong=discordCheckoutAttribution(order,{email:'not-linked@example.test',profileName:'Example profile'},candidates);",sandbox);
  assert.equal(sandbox.matched.customerAccountId,"correct");
  assert.equal(sandbox.wrong,null);
});

test("customer Success payload never exposes login email, password or profile name", () => {
  const source = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const start = source.indexOf("function safeSuccessCheckout(");
  const end = source.indexOf("async function sendDiscordSuccessNotification(",start);
  const payload = source.slice(start,end);
  assert.doesNotMatch(payload,/profileName:\s*/);
  assert.doesNotMatch(payload,/accountEmail:\s*|password:\s*|sourceProfileLabel:\s*/);
  assert.match(payload,/orderNumber:/);
  assert.match(payload,/orderTotalKnown:/);
  assert.match(payload,/itemCount:/);
});

test("only a verified retailer receipt with an explicit unambiguous charge can supply actual total cost", () => {
  assert.equal(verifiedRetailerOrderTotal("Order Total: $39.98"),39.98);
  assert.equal(verifiedRetailerOrderTotal("Grand Total: USD $1,240.15"),1240.15);
  assert.equal(verifiedRetailerOrderTotal("","<div>Order Total: $58.49</div>"),58.49);
  assert.equal(verifiedRetailerOrderTotal("Subtotal: $38.00\nSales tax $2.50\nShipping $4.99"),null);
  assert.equal(verifiedRetailerOrderTotal("Your order ships when ready. Total estimated: $39.98"),null);
  assert.equal(verifiedRetailerOrderTotal("Order Total: $39.98\nTotal Paid: $39.99"),null);
  assert.equal(verifiedRetailerOrderTotal("Order Total: $0.00"),null);
  assert.equal(verifiedRetailerOrderTotal("Order Total: $39.98","Order Total: $39.98"),39.98);
});
test("retailer emails enrich only existing exact-number webhook orders, never invent orders or owner logins", () => {
  const source = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const scan = source.slice(source.indexOf("async function scanMailboxForShipping("),
    source.indexOf("async function syncShippingTrackers("));
  assert.match(scan,/matchVerifiedWebhookEmail\(records/);
  assert.match(scan,/verifiedRetailerOrderTotal\(decoded\.text, decoded\.html\)/);
  assert.match(scan,/record\.orderTotalBasis = "retailer_receipt"/);
  const merge = source.slice(source.indexOf("async function syncShippingTrackers("),
    source.indexOf("function startShippingTrackerScheduler("));
  assert.match(merge,/withSuccessStoreLock\(async \(\) => \{/);
  assert.match(merge,/record\.priceSource = "verified_retailer_receipt"/);
});

test("real Discord spoiler wrappers are stripped for Shikari Account, Profile and Order ID without persisting secrets", () => {
  const fields = [
    {name: "Site", value: "Target"},
    {name: "Profile", value: "|| Customer 4 ||"},
    {name: "Order ID", value: "||102003802680520||"},
    {name: "Quantity", value: "2"},
    {name: "Account", value: "||retailer_test@example.test:EXAMPLE_PRIVATE_PASSWORD||"}
  ];
  const message = {id:"1580000000000000010",timestamp:"2026-10-09T08:00:00Z",
    embeds:[{title:"Successful Checkout!",color:0x57f287,fields,
      description:"["+product+"](https://www.target.com/p/example-product)"}]};
  const identity = checkoutIdentityFromDiscord(message);
  assert.deepEqual(identity,{email:"retailer_test@example.test",orderNumber:"102003802680520",profileName:"Customer 4"});
  const checkout = parseLiveWebhook(message);
  assert.equal(checkout.orderNumber,"102003802680520");
  assert.equal(checkout.itemCount,2);
  assert.equal(checkout.status,"confirmed");
  assert.equal(checkout.retailer,"Target");
  assert.ok(!JSON.stringify(checkout).includes("retailer_test@example.test"));
  assert.ok(!JSON.stringify(checkout).includes("EXAMPLE_PRIVATE_PASSWORD"));
});
test("spoiler values remain exact on two-line Shikari webhook descriptions", () => {
  const input = makeMessage(0xff9900,"1580000000000000011","2026-10-09T08:00:00Z");
  input.embeds[0].description = input.embeds[0].description
    .replace("Customer Example 4", "||Customer Example 4||")
    .replace("102003802680520", "||102003802680520||")
    .replace("retailer_test@example.test:FAKE_SECRET_VALUE",
      "||retailer_test@example.test:FAKE_SECRET_VALUE||");
  const identity = checkoutIdentityFromDiscord(input);
  assert.equal(identity.email,"retailer_test@example.test");
  assert.equal(identity.orderNumber,"102003802680520");
  assert.equal(identity.profileName,"Customer Example 4");
  const record = parseLiveWebhook(input);
  assert.equal(record.status,"review_hold");
  assert.equal(record.orderNumber,"102003802680520");
  assert.equal(record.sourceProfileLabel,"Customer Example 4");
  assert.equal(record.itemCount,2);
});
