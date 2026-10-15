import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  checkoutIdentityFromDiscord, checkoutStatusFromDiscord, checkoutProductFromDiscord
} from "../discord-checkout-identity.js";
import { checkoutExplicitPaidTotal } from "../checkout-price-policy.js";

// Read the actual production checkout parser. Fixtures never contain customer data.
const source = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const start = source.indexOf("function discordCheckoutFromMessage(");
const end = source.indexOf("const DISCORD_HIT_MIRROR_FILE", start);
assert.ok(start > -1 && end > start);
const parseSource = source.slice(start, end);
const channel = "1532179373292257290";
function parse(message) {
  const scope = {
    message, channel, parsed: null,
    discordCheckoutIdentity: checkoutIdentityFromDiscord,
    checkoutStatusFromDiscord, checkoutProductFromDiscord, checkoutExplicitPaidTotal,
    publicSuccessProductName: s => String(s || "").slice(0, 120).trim(),
    isSafeDiscordCheckoutProductName: s => Boolean(
      String(s || "").length >= 3 && !/@|https?:|password|account|address/i.test(s)),
    publicSuccessImageUrl: url => url || null,
    normalizeSuccessRetailer: value => String(value || "")
  };
  vm.runInNewContext(parseSource +
    "\nparsed = discordCheckoutFromMessage(message, channel);", scope);
  return JSON.parse(JSON.stringify(scope.parsed));
}
const green = 0x57f287;
const red = 0xf04747;

function message(id, options = {}) {
  const { title = "Retailer report", color = green, description = "",
    fields = [], webhook = true } = options;
  return {
    id, timestamp: "2026-10-15T17:30:00Z",
    ...(webhook ? { webhook_id: "1580000000000000501" } : {}),
    embeds: [{ title, color, description, fields }]
  };
}
const product = "Pokemon TCG: 30th Celebration Mini Tin";

test("neutral GREEN numbered-product webhook without order ID or email is a real checkout", () => {
  const result = parse(message("1580000000000001001", {
    fields: [
      { name: "Site", value: "Pokemon Center US" },
      { name: "Product Name (1):", value: product },
      { name: "Quantity (1)", value: "1" },
      { name: "Unit Price (1)", value: "9.99" }
    ]
  }));
  assert.equal(result.status, "confirmed");
  assert.equal(result.orderNumber, "");
  assert.equal(result.customerAccountId, null);
  assert.equal(result.itemCount, 1);
  assert.equal(result.items[0].name, product);
  assert.equal(result.items[0].price, 9.99);
});

test("mixed plain Product field and numbered quantity/price fields keep product and quantity", () => {
  const result = parse(message("1580000000000001002", {
    fields: [
      { name: "Product", value: product },
      { name: "Qty (1)", value: "x2" },
      { name: "Price (1)", value: "9.99" }
    ]
  }));
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].name, product);
  assert.equal(result.items[0].quantity, 2);
  assert.equal(result.orderTotal, 19.98);
});

test("green checkout with a description-only linked product works without identity", () => {
  const result = parse(message("1580000000000001003", {
    description: "[Pokemon TCG: 30th Celebration Mini Tin](https://www.pokemoncenter.com/sku)\nQuantity: 2"
  }));
  assert.equal(result.status, "confirmed");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].name, product);
  assert.equal(result.items[0].quantity, 2);
});

test("a plain green informational message without a product does not count", () => {
  assert.equal(parse(message("1580000000000001004", {
    description: "Inventory synchronization completed"
  })), null);
});

test("neutral non-webhook announcements never count as completed checkouts", () => {
  assert.equal(parse(message("1580000000000001005", {
    webhook: false, fields: [{ name: "Product", value: product }]
  })), null);
});

test("red confirmed-heading webhook stays cancelled even with product and identity", () => {
  const result = parse(message("1580000000000001006", {
    title: "Checkout cancelled", color: red,
    fields: [
      { name: "Product", value: product },
      { name: "Quantity", value: "1" }
    ]
  }));
  assert.equal(result.status, "cancelled");
});

test("identity is never copied from source fields into the saved checkout", () => {
  const raw = message("1580000000000001007", {
    fields: [
      { name: "Product", value: product },
      { name: "Account Email", value: "private-buyer@example.test" }
    ]
  });
  const result = parse(raw);
  assert.ok(result);
  assert.doesNotMatch(JSON.stringify(result), /private-buyer@example\.test/);
});

test("marked-up source quantities are recognized without an account link", () => {
  for (const [i, label] of ["||2||", "**2**", "2 pcs", "Qty: (2)", "2×", "2.0"].entries()) {
    const checkout = parse(message("1580000000000002" + String(i).padStart(3, "0"), {
      fields: [
        { name: "Site", value: "Pokemon Center US" },
        { name: "Product (1)", value: product },
        { name: "Quantity (1)", value: label },
        { name: "Price (1)", value: "9.99" }
      ]
    }));
    assert.ok(checkout, "Rejected safe quantity form");
    assert.equal(checkout.status, "confirmed");
    assert.equal(checkout.customerAccountId, null);
    assert.equal(checkout.orderNumber, "");
    assert.equal(checkout.itemCount, 2);
    assert.equal(checkout.orderTotal, 19.98);
  }
});
test("ambiguous quantities containing multiple numbers are not fabricated", () => {
  const ambiguous = parse(message("1580000000000002555", {
    fields: [
      { name: "Product (1)", value: product },
      { name: "Quantity (1)", value: "2/4" }
    ]
  }));
  assert.equal(ambiguous, null);
});
