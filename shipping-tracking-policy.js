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

// Retailer email can prove delivery only with a CURRENT, affirmative delivery
// statement. Arrival estimates and generic "after delivery" footers are not proof.
const messageLines = value => String(value || "")
  .replace(/<\/(?:p|div|h[1-6]|tr|li|td|section|table)>/gi, "\n")
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<[^>]*>/g, " ")
  .split(/[\r\n]+/).map(normalized).filter(Boolean);

const conditionalDelivery = /\b(?:will|may|could|would|should|expected|estimated|scheduled|when|once|if|unless|until|not yet|has not)\b.{0,75}\bdelivered\b/;
const deliveredSubject = /\b(?:your|the)?\s*(?:order|package|shipment)\s+(?:has been|was|is)?\s*delivered\b|\bdelivered\s*[:!\-]\s*(?:your|the)\s+(?:order|package|shipment)\b/;

export function explicitDeliveryConfirmation(subject = "", text = "") {
  const s = normalized(subject);
  if (!/\bout for delivery\b/.test(s) &&
      deliveredSubject.test(s) && !conditionalDelivery.test(s)) return true;
  for (const line of messageLines(text)) {
    if (line.length > 220 || conditionalDelivery.test(line) ||
        /\b(?:track your package|once delivered|if delivered|has not arrived|not delivered)\b/.test(line)) continue;
    if (/^(?:current\s+)?(?:tracking|shipping|shipment|package|delivery)\s+status\s*[:\-]\s*delivered(?:[.!,\s]|$)/.test(line) ||
        /^(?:(?:[\w.' -]{1,35}),\s*)?(?:your|the)\s+(?:order|package|shipment)\s+(?:has been|was|is)\s+delivered(?:[.!:,]|\s+(?:today|yesterday|on|at)\b|$)/.test(line) ||
        /^delivered(?:[!:.]|\s+(?:at|on|today|yesterday)\b.*)?$/.test(line)) return true;
  }
  return false;
}

export function shippingStatusFromMessage(subject = "", text = "") {
  const s = normalized(subject);
  const body = normalized(text);
  if (cancellationFromSubject(s)) return null;
  if (/\b(?:out for delivery|on vehicle for delivery)\b/.test(s)) return "out_for_delivery";
  if (explicitDeliveryConfirmation(s, "")) return "delivered";
  const current = body.match(/\b(?:current\s+)?(?:tracking|shipping|shipment|package|delivery)\s+status\s*[:\-]\s*(delivered|out for delivery|in transit|shipped)\b/);
  if (current && current[1] !== "delivered")
    return current[1] === "out for delivery" ? "out_for_delivery" :
      current[1] === "in transit" ? "in_transit" : "shipped";
  // Target's "Arriving today" email says "Shipped · Out for delivery".
  // Never treat that as a delivery confirmation even if legal/FAQ copy
  // elsewhere in the message discusses packages after delivery.
  if (/\b(?:out for delivery|on vehicle for delivery)\b/.test(body.slice(0, 1600))) return "out_for_delivery";
  if (explicitDeliveryConfirmation("", text)) return "delivered";
  if (/\b(?:out for delivery|on vehicle for delivery)\b/.test(body)) return "out_for_delivery";
  if (/\bon (?:its|the) way\b/.test(s) &&
      /\b(?:label created|just shipped)\b/.test(body) &&
      !/\b(?:arrived at facility|picked up by carrier)\b/.test(body)) return "shipped";
  if (/\b(?:in transit|on (?:its|the) way|en route)\b/.test(s)) return "in_transit";
  if (/\b(?:shipped|shipping confirmation|shipment confirmation)\b/.test(s)) return "shipped";
  if (/\b(?:your|the)\s+(?:package|shipment|order)\s+(?:is|was)\s+in transit\b/.test(body)) return "in_transit";
  if (/\b(?:your|the)\s+(?:package|shipment|order)\s+(?:has|has been|was)\s+shipped\b/.test(body)) return "shipped";
  return null;
}
const shippingRank = stage => ({shipped:1,in_transit:2,out_for_delivery:3,delivered:4})[stage] || 0;

export function verifiedShippingStatus(shipping = {}) {
  // Any pre-fix, unverified retailer-email "Delivered" must not be
  // shown or pushed to customers until a real delivery notice confirms it.
  if (shipping?.status === "delivered" &&
      shipping.source === "retailer_email" &&
      shipping.deliveryProof !== "explicit_email") return "shipped";
  return shipping?.status || null;
}

export function evaluateVerifiedEmailShippingTransition(prior = {}, incoming = {}) {
  const stage = String(incoming.status || "");
  const at = Date.parse(incoming.eventAt || "");
  if (!shippingRank(stage) || !Number.isFinite(at) ||
      (stage === "delivered" && incoming.deliveryProof !== "explicit_email"))
    return {accept:false, correction:false};
  const priorAt = Date.parse(prior.statusUpdatedAt ||
    (prior.status === "delivered" ? prior.deliveredAt : null) ||
    prior.updatedAt || "");
  const fresh = !Number.isFinite(priorAt) || at >= priorAt - 60000;
  // Prior "Delivered" without actual proof is invalid. A trusted exact-order
  // out-for-delivery notice can correct it even if the earlier parser stored
  // the bad "Delivered" timestamp later than the real shipment event.
  const correction = prior.status === "delivered" &&
    stage === "out_for_delivery" && prior.source === "retailer_email" &&
    prior.deliveryProof !== "explicit_email";
  if (correction) return {accept:true,correction:true};
  if (!fresh || shippingRank(stage) < shippingRank(prior.status))
    return {accept:false,correction:false};
  if (stage === prior.status)
    return {accept:stage === "delivered" &&
      prior.deliveryProof !== "explicit_email",correction:false};
  return {accept:true,correction:false};
}
