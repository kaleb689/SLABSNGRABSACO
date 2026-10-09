// Retailer email changes shipping state ONLY for an existing, exact-number
// Discord-confirmed checkout. Classification must not interpret generic
// "will be delivered" boilerplate as proof a package was delivered.
const normalized = value => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();

export function cancellationFromSubject(subject = "") {
  const s = normalized(subject);
  if (!s) return null;
  if (/\b(?:request|requested|pending|how to|instructions|can i|can you)\b/.test(s)) return null;
  if (/\brefund\b/.test(s) && /\b(?:issued|processed|complete|completed|confirmed)\b/.test(s)) return "refunded";
  if (/\b(?:order|purchase|item)\b.{0,80}\brefund(?:ed)?\b/.test(s) ||
      /\brefund(?:ed)?\b.{0,80}\b(?:order|purchase|item)\b/.test(s)) return "refunded";
  if (/\b(?:order|purchase|item)\b.{0,100}\b(?:cancell?ed|cancellation)\b/.test(s) ||
      /\b(?:cancell?ed|cancellation)\b.{0,100}\b(?:order|purchase|item)\b/.test(s)) return "cancelled";
  return null;
}

export function shippingStatusFromMessage(subject = "", text = "") {
  const subjectText = normalized(subject);
  const body = normalized(text);
  // A subject can be authoritative on its own; it outranks informational
  // email footers such as "once delivered, contact support".
  if (cancellationFromSubject(subjectText)) return null;
  if (/\b(?:has been |was |is )?delivered\b|\bdelivery (?:complete|confirmation)\b|\bpackage arrived\b/.test(subjectText) &&
      !/\b(?:not|will|when|once|expected|scheduled|pending)\b/.test(subjectText)) return "delivered";
  if (/\bout for delivery\b/.test(subjectText)) return "out_for_delivery";
  if (/\bin transit\b|\bon (?:its|the) way\b|\ben route\b/.test(subjectText)) return "in_transit";
  if (/\b(?:shipped|has shipped|shipping confirmation|shipment confirmation)\b/.test(subjectText)) return "shipped";

  const explicit = body.match(/\b(?:tracking|shipping|shipment|package|delivery)\s+status\s*[:\-]\s*(delivered|out for delivery|in transit|shipped)\b/);
  if (explicit) {
    const stage = explicit[1];
    return stage === "out for delivery" ? "out_for_delivery" : stage === "in transit" ? "in_transit" : stage;
  }
  if (/\b(?:your|the)\s+(?:package|shipment|order)\s+(?:has been|was|is)\s+delivered\b/.test(body)) return "delivered";
  if (/\b(?:your|the)\s+(?:package|shipment|order)\s+is\s+out for delivery\b/.test(body)) return "out_for_delivery";
  if (/\b(?:your|the)\s+(?:package|shipment|order)\s+(?:is|was)\s+in transit\b/.test(body)) return "in_transit";
  if (/\b(?:your|the)\s+(?:package|shipment|order)\s+(?:has|has been|was)\s+shipped\b/.test(body)) return "shipped";
  return null;
}
