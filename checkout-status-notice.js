/**
 * A retailer bot reporting that its module was unlocked is NOT reporting a
 * purchase, even if its Discord embed title says "Successful Checkout!".
 * Be intentionally narrow: do not require a picture, SKU, quantity or price
 * because genuine retailer checkout webhooks may omit any of those fields.
 */
export function isModuleUnlockNoticeText(raw) {
  const text = String(raw || "").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
  return /\bmodules?\s+(?:has|have)\s+been\s+unlocked\b/i.test(text) ||
    /\bmodules?\s+(?:was|were|is|are)\s+unlocked\b/i.test(text) ||
    /\b(?:unlocked|unlocking)\s+(?:the\s+)?[\w ,/-]{0,65}\bmodule\b/i.test(text);
}

/** Source webhook fields, not the presence of a product image, determine this. */
export function isModuleUnlockNoticeMessage(message) {
  const parts = [message?.content];
  for (const embed of Array.isArray(message?.embeds) ? message.embeds : []) {
    parts.push(embed?.title, embed?.description);
    for (const field of Array.isArray(embed?.fields) ? embed.fields : []) parts.push(field?.value);
  }
  return parts.some(isModuleUnlockNoticeText);
}

/**
 * Legacy false hits stay in the private source ledger for rollback and hit
 * deletion, but never enter customer, Admin, community or push totals.
 */
export function isModuleUnlockNoticeRecord(record) {
  if (!record || typeof record !== "object") return false;
  return [record.productName, record.productTitle, record.description,
    ...(Array.isArray(record.items) ? record.items.flatMap(item =>
      [item?.name, item?.title, item?.product]) : [])]
    .some(isModuleUnlockNoticeText);
}
