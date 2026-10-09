// Customer orders may originate only from an actual Discord Success webhook message.
// Mailbox imports, including customer-owned purchases, are never checkouts.
const DISCORD_CHECKOUT_ID = /^discord:(\d{17,22}):(\d{17,22})$/;

export function discordCheckoutIds(record) {
  return [...new Set([record?.id, ...(Array.isArray(record?.sourceIds) ? record.sourceIds : [])]
    .map(value => String(value || "")).filter(id => DISCORD_CHECKOUT_ID.test(id)))];
}

export function isVerifiedDiscordCheckout(record) {
  return discordCheckoutIds(record).length > 0;
}

function discordTimestamp(id) {
  const match = String(id).match(DISCORD_CHECKOUT_ID);
  if (!match) return null;
  try {
    const milliseconds = Number((BigInt(match[2]) >> 22n) + 1420070400000n);
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
  } catch { return null; }
}

// Called on all reads and writes; migration can additionally discard old,
// weakly matched email-derived shipment information.
export function webhookOnlyCheckouts(records, { resetLegacyShipping = false } = {}) {
  if (!Array.isArray(records)) return [];
  const seen = new Set();
  return records.flatMap(record => {
    if (!record || typeof record !== "object") return [];
    const ids = discordCheckoutIds(record);
    if (!ids.length) return [];
    const canonicalId = DISCORD_CHECKOUT_ID.test(String(record.id || "")) ? record.id : ids[0];
    if (seen.has(canonicalId)) return [];
    seen.add(canonicalId);
    const sourceIds = [record.id, ...(Array.isArray(record.sourceIds) ? record.sourceIds : [])]
      .filter(Boolean).map(String);
    const mixedWithMailbox = sourceIds.some(id => !DISCORD_CHECKOUT_ID.test(id)) ||
      /^(imap-live-|managed-work-mailbox-|community-mailbox:)/i.test(String(record.source || ""));
    const next = { ...record, id: canonicalId, source: "discord_success", sourceIds: ids };
    if (mixedWithMailbox) {
      // Email-created records may have inherited the wrong customer and order number.
      // The next Discord scan will re-attribute solely from the webhook profile identity.
      next.customerAccountId = null;
      delete next.profileName;
      delete next.profileSlot;
      delete next.managedAccountId;
      delete next.managedAssignmentId;
      delete next.managedAssignmentType;
      next.orderNumber = "";
      next.checkoutAt = discordTimestamp(canonicalId) || next.checkoutAt;
      if (next.priceSource !== "checkout_webhook") {
        next.orderTotal = 0;
        next.orderTotalBasis = "unknown";
        next.priceSource = null;
      }
    }
    if (mixedWithMailbox || (resetLegacyShipping && next.shipping?.source === "retailer_email")) {
      delete next.shipping;
    }
    // The old mailbox scanner could cancel otherwise valid webhook orders.
    if (resetLegacyShipping && next.cancelledAt) {
      delete next.cancelledAt;
      next.status = "confirmed";
    }
    return [next];
  });
}

// Shipment email can enrich *only* an existing webhook checkout, using an
// exact retailer order number, never matching loosely by product name.
export function hasExactWebhookOrderNumber(record, text) {
  if (!isVerifiedDiscordCheckout(record)) return false;
  const number = String(record.orderNumber || "").trim().replace(/^#/, "");
  if (number.length < 5 || number.length > 150) return false;
  const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i").test(String(text || ""));
}

export function isTrustedRetailerSender(retailer, fromAddresses) {
  const addresses = Array.isArray(fromAddresses) ? fromAddresses : [];
  const normalized = String(retailer || "").toLowerCase();
  const domains = normalized === "target" ? ["target.com", "targetemail.com"] :
    normalized === "walmart" ? ["walmart.com"] :
    ["pkc", "pokemon center", "pokemoncenter"].includes(normalized) ? ["pokemoncenter.com", "pokemon.com"] :
    normalized === "costco" ? ["costco.com"] :
    ["sam's club", "sams club", "samsclub"].includes(normalized) ? ["samsclub.com"] : [];
  if (!domains.length) return false;
  return addresses.some(item => {
    const email = String(typeof item === "string" ? item : item?.address || "").trim().toLowerCase();
    const host = email.split("@")[1] || "";
    return domains.some(domain => host === domain || host.endsWith("." + domain));
  });
}

/**
 * Locate one pre-existing, verified webhook checkout for a retailer shipment or
 * cancellation email. The sender must be on the allowlist, the retailer order
 * number must match exactly, and the email must follow the checkout.
 *
 * Never use product names, shipping addresses, buyer emails, or account owner
 * similarity to guess a purchase; the mailbox may contain personal purchases.
 */
export function matchVerifiedWebhookEmail(records, { senders = [], subject = "", text = "", html = "", receivedAt } = {}) {
  if (!Array.isArray(records)) return null;
  const received = new Date(receivedAt).getTime();
  if (!Number.isFinite(received) || received > Date.now() + 24 * 60 * 60 * 1000) return null;
  const body = [subject, text, html].filter(Boolean).join("\n");
  const matches = records.filter(record => {
    const placed = new Date(record?.checkoutAt).getTime();
    return isVerifiedDiscordCheckout(record) &&
      Number.isFinite(placed) &&
      received >= placed - 48 * 60 * 60 * 1000 &&
      isTrustedRetailerSender(record.retailer, senders) &&
      hasExactWebhookOrderNumber(record, body);
  });
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Keep previously imported webhook records in the store for audit/rollback,
 * but include in customer/public Success only records containing a message
 * from the ONE currently authoritative Discord checkout source.
 */
export function authoritativeDiscordCheckouts(records, channelIds) {
  const allowed = new Set((Array.isArray(channelIds) ? channelIds : [])
    .map(String).filter(value => /^\d{17,22}$/.test(value)));
  if (!allowed.size) return [];
  return (Array.isArray(records) ? records : []).filter(record =>
    discordCheckoutIds(record).some(id => allowed.has(id.split(":")[1])));
}
