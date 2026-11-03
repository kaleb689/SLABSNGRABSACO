import test from "node:test";
import assert from "node:assert/strict";
import { parseDropNews, dropNewsPayloads, isDropNewsPaste, parseReleaseDate } from "../drop-news-format.js";
import { parseDropSkus, withoutSupersededSkus } from "../discord-community.js";
import { isFormattedDropPost } from "../drop-monitor-format.js";

const NOW = Date.parse("2026-11-02T21:00:00-05:00");
const POST = `Friday, November 6, 2026 at 03:00-06:00
Product: 30th Anni + Other SKU's
Demand Level: greencheck: / High/Medium
Resale Outlook: -$30-$100+ profit per item

Ultra Premium Collection Night
SKU: 1012850572
Retail: $249.99
Resale: ~$400
Market: eBay Sold
Link: https://howl.link/6kq9a4yu13j3a

Figure Collection Mewtwo
SKU: 1012850573
Retail: $39.99
Market: eBay sold
Link: https://howl.link/jg9hnwuwchqys
Figure Collection Mew 1012793603
Retail: $39.99
Link: https://howl.link/hrjtkphex6net

Additional Info
Releasing 11/06 in-store at select stores.`;

test("owner drop paste becomes quote-bar header, SKU chips, spaced products and a notes box", () => {
  const [card, ...rest] = dropNewsPayloads(parseDropNews(POST, NOW), "Target Drops");
  assert.equal(rest.length, 0);
  const text = card.embeds[0].description;
  assert.equal(card.embeds[0].title, "Target Drop");
  assert.match(text, /^> \*\*Release:\*\* <t:\d+:F> – <t:\d+:t>/);
  assert.match(text, /> \*\*Demand Level:\*\* ✅/);
  assert.match(text, /\*\*Ultra Premium Collection Night\*\* `1012850572`\n> \*\*Retail:\*\* \$249\.99/);
  assert.match(text, /\*\*Figure Collection Mew\*\* `1012793603`/);
  assert.match(text, /\n\n\*\*Figure Collection Mewtwo\*\*/, "blank line between products");
  assert.match(text, /\*\*Additional Info\*\*\n```\nReleasing 11\/06/);
  assert.doesNotMatch(text, /Market/i, "owner asked to drop the Market line");
  assert.ok(isFormattedDropPost({ author: { id: "1", bot: true }, embeds: card.embeds }, "1"));
});

test("formatted cards keep exactly the raw paste's SKUs, including an unlabeled one", () => {
  const raw = parseDropSkus({ content: POST }).map(x => x.sku).sort();
  const cards = dropNewsPayloads(parseDropNews(POST, NOW), "Target Drops");
  const formatted = cards.flatMap(card => parseDropSkus(card).map(x => x.sku)).sort();
  assert.deepEqual(raw, ["1012793603", "1012850572", "1012850573"]);
  assert.deepEqual(formatted, raw);
});

test("release times are Eastern; date-only releases keep their wording", () => {
  const timed = parseReleaseDate("Friday, November 6, 2026 at 03:00-06:00", NOW);
  assert.equal(new Date(timed.start * 1000).toISOString(), "2026-11-06T08:00:00.000Z");
  assert.equal(timed.end - timed.start, 3 * 3600);
  const dateOnly = parseReleaseDate("Friday, Nov 6 @ Store Open", NOW);
  assert.equal(dateOnly.hasTime, false);
  assert.equal(dateOnly.rest, "@ Store Open");
  assert.equal(parseReleaseDate("no date here", NOW), null);
});

test("plain chat is never reformatted; a product list without SKUs is", () => {
  assert.equal(isDropNewsPaste(parseDropNews("Heads up, restock soon!", NOW)), false);
  assert.equal(isDropNewsPaste(parseDropNews("Heads up\nrestock Friday at Target", NOW)), false);
  assert.equal(isDropNewsPaste(parseDropNews("Some Box\nRetail: $10", NOW)), true);
});

test("a bare ID only counts at the end of a product line, never in times or links", () => {
  assert.deepEqual(parseDropSkus({ content: "Friday at 03:00-06:00\nhttps://x.co/1234567\nOrder total: 1234567" }), []);
});

test("confirming a newer copy of a drop replaces the same SKU from the older copy only", () => {
  const items = [
    { key: "c1:old:111111", sku: "111111" }, { key: "c1:old:222222", sku: "222222" },
    { key: "c2:other:111111", sku: "111111" }, { key: "c1:new:111111", sku: "111111" }
  ];
  assert.deepEqual(withoutSupersededSkus(items, "c1", "new", ["111111"]).map(x => x.key),
    ["c1:old:222222", "c2:other:111111", "c1:new:111111"]);
});

test("Upcoming and Tonight cards name the one retailer the post mentions; SKU-less lists still format", () => {
  const text = "Target restock this Friday\nNov 6 @ Store Open\n\nPrismatic ETB\nRetail: $49.99\nResale: ~$90";
  const [card] = dropNewsPayloads(parseDropNews(text, NOW), "Upcoming Drops", text);
  assert.equal(card.embeds[0].title, "Upcoming Drop · Target");
  assert.match(card.embeds[0].description, /\*\*Prismatic ETB\*\*\n> \*\*Retail:\*\* \$49\.99/);
  assert.doesNotMatch(card.embeds[0].description, /SKU/);
  const [tonight] = dropNewsPayloads(parseDropNews(POST, NOW), "Dropping Tonight", POST);
  assert.equal(tonight.embeds[0].title, "Dropping Tonight");
});

test("owner SKU request breakdown lists SKUs under each retailer", async () => {
  const { skuOwnerDetails } = await import("../discord-community.js");
  const rows = [
    { key: "t:1:111111", sku: "111111", quantity: 2 },
    { key: "w:2:222222", sku: "222222", quantity: 2 },
    { key: "t:3:333333", sku: "333333", quantity: 2 }
  ];
  const label = row => ({ t: "Target", w: "Walmart" })[row.key.split(":")[0]];
  const text = skuOwnerDetails(rows, label).description;
  assert.match(text, /^\*\*Target\*\* \(2\)\n\(111111, 333333\)\n\n\*\*Walmart\*\* \(1\)\n\(222222\)\n\n\*\*Qty: 2 for ALL SKUs\*\*$/);
});
