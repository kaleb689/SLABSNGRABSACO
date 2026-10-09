import test from "node:test";
import assert from "node:assert/strict";
import { checkoutIdentityFromDiscord, checkoutSourceSelection } from "../discord-checkout-identity.js";

const bot = { bot: true, id: "1553628642372751431" };

test("identifies order number and paid profile email from fields", () => {
  const result = checkoutIdentityFromDiscord({
    author: bot,
    embeds: [{ title: "Successful Checkout!", fields: [
      { name: "Site", value: "Target" }, { name: "Product (1)", value: "30th Celebration Tin" },
      { name: "**Order ID**", value: "#T-1923-0494" },
      { name: "**Account Email**", value: "Buyer+one@example.com" },
      { name: "Profile Name", value: "Customer 2" }
    ] }]
  });
  assert.deepEqual(result, { orderNumber: "T-1923-0494", email: "buyer+one@example.com", profileName: "Customer 2" });
});

test("reads labeled checkout details from webhook description without guessing from free text", () => {
  const result = checkoutIdentityFromDiscord({
    content: "A notification for random@not-the-buyer.example",
    embeds: [{ title: "Checkout Success", description:
      "**Checkout Email:** mike@example.com\n**Order Number:** #AB123449\n**Profile:** Mike 1\nsupport@retailer.example" }]
  });
  assert.deepEqual(result, { orderNumber: "AB123449", email: "mike@example.com", profileName: "Mike 1" });
});

test("rejects ambiguous checkout identity and unlabeled notification addresses", () => {
  assert.deepEqual(checkoutIdentityFromDiscord({
    content: "buyer@example.com",
    embeds: [{ fields: [
      { name: "Email", value: "one@example.com" }, { name: "Account Email", value: "two@example.com" },
      { name: "Order ID", value: "T-100" }, { name: "Order Number", value: "T-200" }
    ] }]
  }), { orderNumber: "", email: "", profileName: "" });
});

test("prefers exactly one explicit checkout feed and rejects the hits mirror", () => {
  const a = "1532179373292257290", b = "1551090141693485156", hits = "1551090141693485999";
  assert.deepEqual(checkoutSourceSelection({
    checkoutChannelId: a, successChannelId: b, hitsChannelId: hits
  }), { channels: [a], source: "checkout_source" });
  assert.deepEqual(checkoutSourceSelection({
    checkoutChannelId: hits, successChannelId: b, hitsChannelId: hits
  }), { channels: [], source: "mirror_rejected" });
});

test("safe discovery refuses ambiguous checkout channels rather than importing both", () => {
  const a = "1532179373292257290", b = "1551090141693485156";
  assert.deepEqual(checkoutSourceSelection({ discoveredChannelIds: [a,a] }), {
    channels: [a], source: "discovered"
  });
  assert.deepEqual(checkoutSourceSelection({ discoveredChannelIds: [a,b] }), {
    channels: [], source: "unconfigured_or_ambiguous"
  });
});
