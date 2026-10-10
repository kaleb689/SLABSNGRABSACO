import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

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
    clean: (s, len) => String(s || "").slice(0, len)
  };
  vm.runInNewContext(server.slice(start, end) +
    "\npayload = publicDiscordHitPayload(order);", context);
  return JSON.parse(JSON.stringify(context.payload));
}

test("community hit includes product quantity, thumbnails, and no Price field or private info", () => {
  const payload = renderHit({
    status: "confirmed", retailer: "Target", orderTotal: 199.99,
    orderNumber: "123456789", sourceProfileLabel: "private profile",
    items: [
      { name: "Pokémon Charmander Tech Sticker", quantity: 2, price: 19.99,
        imageUrl: "https://target.scene7.com/is/image/Target/verified" },
      { name: "Pokémon Delta Reign Three-Booster Blister", quantity: 3, price: 14.99,
        imageUrl: "https://target.scene7.com/is/image/Target/second" }
    ]
  });
  assert.equal(payload.embeds[0].title, "Successful Checkout!");
  assert.equal(payload.embeds[0].color, 0x00ff00);
  assert.equal(payload.embeds[0].thumbnail.url, "https://target.scene7.com/is/image/Target/verified");
  assert.equal(payload.embeds[1].thumbnail.url, "https://target.scene7.com/is/image/Target/second");
  assert.deepEqual(payload.embeds[0].fields.map(f => f.name),
    ["Site", "Product (1)", "Quantity (1)", "Product (2)", "Quantity (2)"]);
  assert.equal(payload.embeds[0].fields[2].value, "2");
  assert.equal(payload.embeds[0].fields[4].value, "3");
  const publicMessage = JSON.stringify(payload);
  for (const secret of ["Price", "199.99", "19.99", "14.99", "123456789", "private profile",
    "Account", "Password", "Shipping"]) {
    assert.equal(publicMessage.includes(secret), false, "public Discord hit must not expose " + secret);
  }
});

test("provisional checkout and cancellation never create a green Discord hit", () => {
  const base = { retailer: "Target", items: [{name: "Pokémon item", quantity: 1}] };
  assert.equal(renderHit({ ...base, status: "review_hold" }), null);
  assert.equal(renderHit({ ...base, status: "cancelled" }), null);
});

test("missing product picture does not produce a misleading price or broken thumbnail", () => {
  const hit = renderHit({ status: "confirmed", retailer: "Target",
    items: [{ name: "Pokémon item", quantity: 2, price: 0 }] });
  assert.equal(hit.embeds.length, 1);
  assert.equal(hit.embeds[0].thumbnail, undefined);
  assert.equal(hit.embeds[0].fields.some(f => /price/i.test(f.name)), false);
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
