/**
 * A retailer automation module opening/closing is not a checkout, even when
 * its Discord webhook embed is green or contains a retailer name.
 */
const MODULE_LIFECYCLE = /\bmodules?\b.{0,120}?\b(?:unlocked|closed)\b|\b(?:unlocked|closed)\b.{0,120}?\bmodules?\b/i;

export function isModuleLifecycleText(value) {
  if (value == null) return false;
  const text = String(value).replace(/[*_\x60~|]/g, "").replace(/\s+/g, " ").trim();
  return MODULE_LIFECYCLE.test(text);
}

export function isModuleLifecycleDiscordMessage(message) {
  if (isModuleLifecycleText(message?.content)) return true;
  return (Array.isArray(message?.embeds) ? message.embeds : []).some(embed =>
    isModuleLifecycleText(embed?.title) ||
    isModuleLifecycleText(embed?.description) ||
    (Array.isArray(embed?.fields) ? embed.fields : []).some(field =>
      isModuleLifecycleText(String(field?.name || "") + ": " + String(field?.value || ""))));
}

export function isModuleLifecycleCheckout(record) {
  const items = Array.isArray(record?.items) ? record.items : [];
  return [record?.title, record?.description, record?.message, record?.content,
    record?.product, record?.productName,
    ...items.flatMap(item => [item?.name, item?.title, item?.description])]
    .some(isModuleLifecycleText);
}
