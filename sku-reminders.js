// Owner-only Discord reminders for customers who have not answered a specific drop.
// Pure helpers live here so eligibility and drop boundaries are easy to test.
const DISCORD_USER_ID = /^\d{17,22}$/;
export const SKU_REMINDER_COOLDOWN_MS = 30 * 60 * 1000;

export function hasRespondedToSkuDrop(record, { channelId, sourceId, tonightChannelId, today } = {}) {
  if (!record || !channelId || !sourceId) return false;
  const prefix = String(channelId) + ":" + String(sourceId) + ":";
  if (Array.isArray(record.items) && record.items.some(item => {
    const key = String(item?.key || "");
    return key.startsWith(prefix) && key.length > prefix.length;
  })) return true;
  // The Tonight opt-out is saved for the current New York date, not each SKU.
  if (String(channelId) === String(tonightChannelId) && today &&
      record.skipTonightDate === today) return true;
  return Array.isArray(record.skippedUpcomingDrops) &&
    record.skippedUpcomingDrops.some(skip =>
      String(skip?.channelId) === String(channelId) &&
      String(skip?.sourceId) === String(sourceId));
}

export function unselectedSkuRecipientIds(accounts, selections, paidAccountIds, drop, ownerId) {
  const eligible = new Set();
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const userId = String(account?.discordUserId || "");
    if (!account?.discordLinkedAt || account.disabled || !DISCORD_USER_ID.test(userId) ||
        userId === String(ownerId || "") || !paidAccountIds?.has(String(account.id))) continue;
    if (hasRespondedToSkuDrop(selections?.[userId], drop)) continue;
    eligible.add(userId);
  }
  return [...eligible];
}

export function canRepeatSkuReminder(lastSentAt, now = Date.now(), cooldownMs = SKU_REMINDER_COOLDOWN_MS) {
  const when = Date.parse(String(lastSentAt || ""));
  return !Number.isFinite(when) || now - when >= cooldownMs;
}

const cleanLabel = value => String(value || "Drop").replace(/[\r\n<>*_\x60~|]/g, " ").trim().slice(0, 70);
const dropUrl = (guildId, channelId, sourceId) =>
  "https://discord.com/channels/" + guildId + "/" + channelId + "/" + sourceId;

export function skuReminderOwnerPanel({ guildId, channelId, sourceId, retailer, skuCount }) {
  const url = dropUrl(guildId, channelId, sourceId);
  return {
    embeds: [{
      title: "SKU reminder — " + cleanLabel(retailer),
      description: "**" + Number(skuCount || 0) + " SKU(s)** in this drop. Use the bell to DM active linked members who have not confirmed SKU choices or opted out of this drop. Members already reminded in the past 30 minutes will not get a duplicate.\n\n[View original SKU post](" + url + ")",
      color: 0xf1c40f
    }],
    components: [{ type: 1, components: [
      { type: 2, style: 1, emoji: { name: "🔔" }, label: "Remind unselected members",
        custom_id: "sku:remind:" + channelId + ":" + sourceId },
      { type: 2, style: 5, label: "View drop", url }
    ] }],
    allowed_mentions: { parse: [] }
  };
}

export function skuReminderDirectMessage({ guildId, channelId, sourceId, retailer }) {
  const url = dropUrl(guildId, channelId, sourceId);
  return {
    embeds: [{
      title: "🔔 SKU selections needed — " + cleanLabel(retailer),
      description: "You have not made your selections for this drop. Please choose your SKUs and confirm your quantity (1 or 2 for all SKUs), or choose **Don't run my profiles** if you want to skip it.\n\n[View the SKU post](" + url + ")",
      color: 0xf1c40f
    }],
    components: [{ type: 1, components: [
      { type: 2, style: 5, label: "Select SKUs in app", url: "https://slabsngrabsaco.com/?appTab=drops#my-profile" },
      { type: 2, style: 5, label: "View Discord drop", url }
    ] }],
    allowed_mentions: { parse: [] }
  };
}
