import crypto from "node:crypto";

// These alerts are for a staff-authored, original retailer post, never replies,
// bot-generated SKU controls, webhook checkouts or non-retailer announcements.
export function isRetailerSkuPost(message, guildId, retailerDropLabels = {}) {
  return Boolean(message?.id && message.guild_id === guildId &&
    Object.hasOwn(retailerDropLabels, String(message.channel_id || "")) &&
    !message.author?.bot && !message.webhook_id &&
    !message.message_reference?.message_id &&
    (message.type === 0 || message.type === undefined));
}

export function dropSkuFingerprint(products) {
  const entries = (Array.isArray(products) ? products : []).map(item => [
    String(item?.sku || "").trim().toUpperCase(),
    String(item?.name || "").trim().replace(/\s+/g, " ")
  ]).filter(item => item[0]);
  if (!entries.length) return "";
  entries.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

// Repeated gateway events and cosmetic edits do not alert twice. Rapid edits
// update the stored fingerprint but don't flood a member's phone or Discord DM.
export function decideSkuAlert(previous, fingerprint, now = Date.now(), cooldownMs = 90_000) {
  if (!fingerprint || previous?.fingerprint === fingerprint) return { remember: false, notify: false };
  const elapsed = now - Date.parse(previous?.notifiedAt || "");
  return { remember: true, notify: !Number.isFinite(elapsed) || elapsed >= cooldownMs };
}

export function skuAlertPayload({ retailer, products, guildId, channelId, messageId }) {
  const label = String(retailer || "Retailer").replace(/\s+Drops?$/i, "").trim();
  const count = Array.isArray(products) ? products.length : 0;
  return {
    kind: "drop_skus_updated",
    title: label + " drop SKUs updated",
    message: count + " SKU" + (count === 1 ? " is" : "s are") +
      " available for " + label + ". Open Drops to choose your products and one quantity (1 or 2) for all selected SKUs.",
    tab: "drops",
    sourceUrl: "https://discord.com/channels/" + guildId + "/" + channelId + "/" + messageId
  };
}
