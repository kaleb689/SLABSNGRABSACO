import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  hasRespondedToSkuDrop,
  unselectedSkuRecipientIds,
  canRepeatSkuReminder,
  SKU_REMINDER_COOLDOWN_MS,
  skuReminderOwnerPanel,
  skuReminderDirectMessage
} from "../sku-reminders.js";
import { skuControlPayload } from "../discord-community.js";

const uid1 = "1551070928039845924";
const uid2 = "1551070928039845925";
const uid3 = "1551070928039845926";
const owner = "1551070928039845923";
const channelId = "1234567890123456788";
const sourceId = "1234567890123456789";
const otherSourceId = "1234567890123456790";
const drop = { channelId, sourceId, tonightChannelId: "1234567890123456799", today: "2026-10-12" };

test("a selection is specific to its drop post and not just to its retailer", () => {
  assert.equal(hasRespondedToSkuDrop({ items: [{ key: channelId + ":" + sourceId + ":ABC" }] }, drop), true);
  assert.equal(hasRespondedToSkuDrop({ items: [{ key: channelId + ":" + otherSourceId + ":ABC" }] }, drop), false);
  assert.equal(hasRespondedToSkuDrop({ items: [{ key: "other:" + sourceId + ":ABC" }] }, drop), false);
  assert.equal(hasRespondedToSkuDrop({ items: [{ key: channelId + ":" + sourceId + ":" }] }, drop), false);
  assert.equal(hasRespondedToSkuDrop({ items: [] }, drop), false);
  assert.equal(hasRespondedToSkuDrop(undefined, drop), false);
});

test("a customer who skips that upcoming drop does not get reminded for it", () => {
  const record = { skippedUpcomingDrops: [{ channelId, sourceId: otherSourceId }] };
  assert.equal(hasRespondedToSkuDrop(record, drop), false);
  record.skippedUpcomingDrops.push({ channelId, sourceId });
  assert.equal(hasRespondedToSkuDrop(record, drop), true);
});

test("tonight opt-outs apply only on the saved New York calendar date", () => {
  const tonightDrop = { ...drop, channelId: drop.tonightChannelId };
  assert.equal(hasRespondedToSkuDrop({ skipTonightDate: "2026-10-12" }, tonightDrop), true);
  assert.equal(hasRespondedToSkuDrop({ skipTonightDate: "2026-10-11" }, tonightDrop), false);
  assert.equal(hasRespondedToSkuDrop({ skipTonightDate: "2026-10-12" }, drop), false);
});

test("only active, paid, linked members without answers are eligible; IDs deduplicate", () => {
  const accounts = [
    { id: "paid1", discordLinkedAt: "2026-10-01", discordUserId: uid1 },
    { id: "paid1-duplicate", discordLinkedAt: "2026-10-01", discordUserId: uid1 },
    { id: "paid2", discordLinkedAt: "2026-10-01", discordUserId: uid2 },
    { id: "paid3", discordLinkedAt: "2026-10-01", discordUserId: uid3 },
    { id: "owner", discordLinkedAt: "2026-10-01", discordUserId: owner },
    { id: "disabled", discordLinkedAt: "2026-10-01", discordUserId: "1551070928039845927", disabled: true },
    { id: "unlinked", discordUserId: "1551070928039845928" },
    { id: "unpaid", discordLinkedAt: "2026-10-01", discordUserId: "1551070928039845929" }
  ];
  const paid = new Set(["paid1", "paid1-duplicate", "paid2", "paid3", "owner", "disabled", "unlinked"]);
  const selections = {
    [uid2]: { items: [{ key: channelId + ":" + sourceId + ":SKU1" }] },
    [uid3]: { skippedUpcomingDrops: [{ channelId, sourceId }] }
  };
  assert.deepEqual(unselectedSkuRecipientIds(accounts, selections, paid, drop, owner), [uid1]);
  assert.deepEqual(unselectedSkuRecipientIds(accounts, selections, paid,
    { ...drop, sourceId: otherSourceId }, owner), [uid1, uid2, uid3]);
});

test("recipient filtering does not mutate saved selection records", () => {
  const selections = { [uid1]: { items: [{ key: channelId + ":" + sourceId + ":SKU1" }] } };
  const before = JSON.stringify(selections);
  unselectedSkuRecipientIds([{ id: 1, discordLinkedAt: "date", discordUserId: uid1 }],
    selections, new Set(["1"]), drop, owner);
  assert.equal(JSON.stringify(selections), before);
});

test("a 30-minute per-recipient cooldown prevents accidental duplicate DMs", () => {
  const now = Date.parse("2026-10-12T15:00:00.000Z");
  assert.equal(SKU_REMINDER_COOLDOWN_MS, 1800000);
  assert.equal(canRepeatSkuReminder(null, now), true);
  assert.equal(canRepeatSkuReminder(new Date(now - 10000).toISOString(), now), false);
  assert.equal(canRepeatSkuReminder(new Date(now - 1799999).toISOString(), now), false);
  assert.equal(canRepeatSkuReminder(new Date(now - 1800000).toISOString(), now), true);
});

test("private owner panel displays a bell and links to exactly that drop", () => {
  const panel = skuReminderOwnerPanel({
    guildId: "guild", channelId, sourceId, retailer: "Target Drops", skuCount: 8
  });
  const buttons = panel.components.flatMap(row => row.components);
  assert.equal(buttons[0].emoji.name, "🔔");
  assert.equal(buttons[0].custom_id, "sku:remind:" + channelId + ":" + sourceId);
  assert.match(buttons[0].label, /Remind unselected/);
  assert.equal(buttons[1].url, "https://discord.com/channels/guild/" + channelId + "/" + sourceId);
  assert.equal(panel.embeds[0].description.includes("8 SKU(s)"), true);
});

test("customer DM explains selecting or skipping without exposing account details", () => {
  const payload = skuReminderDirectMessage({ guildId: "guild", channelId, sourceId, retailer: "Target Drops" });
  assert.match(payload.embeds[0].title, /SKU selections needed/);
  assert.match(payload.embeds[0].description, /Don't run my profiles/);
  assert.match(payload.embeds[0].description, /\/channels\/guild\//);
  assert.equal(payload.components[0].components[0].url.includes("appTab=drops"), true);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
});

test("public SKU selection panel remains unchanged and does not expose the owner bell", () => {
  const panel = skuControlPayload({ id: sourceId, channel_id: channelId },
    [{ sku: "SKU123", name: "TCG Product" }], "another-channel", { [channelId]: "Target Drops" });
  assert.equal(JSON.stringify(panel).includes("sku:remind:"), false);
  assert.equal(panel.components.length, 2);
});

test("owner-only handler verifies exact guild owner and private channel before sending", () => {
  const src = readFileSync(new URL("../discord-community.js", import.meta.url), "utf8");
  assert.match(src, /isGuildOwnerSkuTester\(userId, ownerId\)/);
  assert.match(src, /d\.channel_id !== skuRequestsChannelId \|\| !isGuildOwnerSkuTester\(userId, ownerId\)/);
  assert.match(src, /await ensureOwnerSkuReminderPanel\(message, products\)/);
  assert.match(src, /await retireOwnerSkuReminderPanels\(retiredSources\)/);
  assert.match(src, /await remindUnselectedSkuDrop\(channelId, sourceId\)/);
  assert.match(src, /await webActiveDropSources\(\)/);
});
