import { isVerifiedDiscordCheckout } from "./success-source-policy.js";
import { cleanTrackingNumber, knownCarrier } from "./carrier-tracking.js";

// Carrier alert emails are an optional, free source of shipping status changes.
// They may enrich exactly ONE known webhook checkout with an ALREADY STORED
// tracking number. They can never create orders, move owners, or change prices.
const supportedDomains = new Map([
  ["ups.com", "UPS"],
  ["fedex.com", "FedEx"],
  ["usps.com", "USPS"]
]);
const normalize = value => String(value || "").replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();

function addressDomain(entry) {
  const address = typeof entry === "string" ? entry : entry?.address;
  const match = String(address || "").trim().toLowerCase().match(/^[^@\s<>]+@([a-z0-9.-]+)$/);
  return match ? match[1] : null;
}

export function trustedCarrierNoticeSender(senders) {
  const supplied = Array.isArray(senders) ? senders : [];
  if (supplied.length !== 1) return null;
  const domain = addressDomain(supplied[0]);
  if (!domain) return null;
  for (const [root, carrier] of supportedDomains) {
    // Proper subdomains accepted; lookalikes like ups.com.evil.invalid denied.
    if (domain === root || domain.endsWith("." + root)) return carrier;
  }
  return null;
}

export function matchVerifiedCarrierNotice(records, {senders, trackingNumber, receivedAt} = {}) {
  const carrier = trustedCarrierNoticeSender(senders);
  const number = cleanTrackingNumber(trackingNumber);
  const received = Date.parse(receivedAt || "");
  if (!carrier || !number || !Number.isFinite(received) ||
      received > Date.now() + 10 * 60_000 ||
      received < Date.now() - 121 * 24 * 60 * 60_000) return null;
  const candidates = (Array.isArray(records) ? records : []).filter(record => {
    if (!isVerifiedDiscordCheckout(record) || !record.customerAccountId ||
        !record.orderNumber || !record.shipping) return false;
    if (record.cancelledAt || record.canceledAt ||
        /cancel|refund|failed|declined/i.test(String(record.status || ""))) return false;
    if (cleanTrackingNumber(record.shipping.trackingNumber) !== number) return false;
    if (knownCarrier(record.shipping.carrier, number) !== carrier) return false;
    const checkoutAt = Date.parse(record.checkoutAt || "");
    return Number.isFinite(checkoutAt) && received >= checkoutAt - 24 * 60 * 60_000;
  });
  return candidates.length === 1 ? candidates[0] : null;
}

export function shippingNoticeFromEmail(subject = "", text = "") {
  const compactSubject = normalize(subject).toLowerCase();
  // Status boilerplate in retailer footers must not become a customer alert.
  const cleanBody = String(text || "").replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&");
  const lines = cleanBody.split(/\r?\n/).slice(0, 45)
    .map(line => normalize(line).toLowerCase())
    .filter(line => line && line.length <= 220 &&
      !/^(?:if |when |once |for questions|click |learn |view |contact |see |to change |manage )/.test(line));
  const phrases = [compactSubject, ...lines];
  const labels = [
    ["Delivery attempted", /\b(?:delivery attempted|attempted delivery|attempt to deliver|we attempted to deliver|delivery attempt was made)\b/],
    ["Delivery delayed", /\b(?:delivery|shipment|package)\s+(?:has\s+been\s+|is\s+|was\s+)?delay(?:ed)?\b|\bdelay(?:ed)?\s+(?:delivery|shipment|package)\b/],
    ["Delivery exception", /\b(?:delivery|shipment)\s+exception\b|\bexception\s+(?:with|for)\s+(?:your\s+)?(?:shipment|delivery|package)\b/],
    ["Delivery rescheduled", /\b(?:delivery|arrival)\s+(?:has\s+been\s+|was\s+|is\s+)?reschedul(?:ed|ing)\b|\brescheduled delivery\b/],
    ["Available for pickup", /\b(?:available|ready)\s+for\s+(?:customer\s+)?pick\s*-?\s*up\b/],
    ["Returning to sender", /\b(?:returning|returned|return)\s+to\s+sender\b/],
    ["Address issue reported", /\b(?:address correction needed|incorrect address|address issue|address information required)\b/]
  ];
  for (const phrase of phrases) {
    if (!phrase || /\b(?:might|may|could|can|would|if|when|once)\s+(?:be\s+)?(?:delayed|rescheduled|attempted)\b/.test(phrase)) continue;
    for (const [label, pattern] of labels) if (pattern.test(phrase)) return label;
  }
  return null;
}

export function shippingEstimateFromEmail(subject = "", text = "") {
  const normalized = normalize(String(subject) + "\n" + String(text || "").slice(0, 6500).replace(/<[^>]+>/g, " "));
  const keywords = /\b(?:estimated|expected|scheduled|revised|updated|new)\s+(?:date\s+of\s+)?(?:delivery|arrival)\s*(?:date|time)?\b|\b(?:arriving|arrives?|delivered)\s+(?:on|by)\b|\b(?:delivery|arrival)\s+(?:date|estimate|expected|scheduled)\b|\bETA\b/gi;
  const dates = /^[:\s\-–]*(?:is\s+|has\s+been\s+|for\s+|on\s+|by\s+|now\s+)?(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s*,?\s+)?((?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:\s*,?\s*\d{4})?)|(?:\d{4}-\d{2}-\d{2})|(?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})?))\b/i;
  for (const match of normalized.matchAll(keywords)) {
    const rest = normalized.slice(match.index + match[0].length, match.index + match[0].length + 110);
    const date = rest.match(dates);
    if (!date) continue;
    const literal = normalize(date[1]);
    // Reject bogus date literals. Do not infer an ETA from "today/tomorrow",
    // which is ambiguous after retailer timezone and email processing delays.
    const parsed = Date.parse(literal);
    if (!Number.isFinite(parsed)) continue;
    const year = new Date(parsed).getUTCFullYear();
    if (year < 2020 || year > 2100) continue;
    return literal.slice(0, 80);
  }
  return null;
}
