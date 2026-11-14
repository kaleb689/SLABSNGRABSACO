/** Evidence-based interpretation for checkout webhooks originating in the
 * exact SLABSNGRABSTC #success source (not the public Hits mirror).
 *
 * Direct source audit on Nov 13 2026 found 25 green/orange messages with
 * Quantity=2 and "Price"=49.98/79.98/159.98. Those fields represent the
 * EXTENDED line price, not a per-unit price; the old parser multiplied twice.
 * An explicit "Unit Price" field still means price per item.
 */
export const SLABSNGRABSTC_SUCCESS_CHANNEL_ID = "1532179373292257290";

export function sourcePriceIsLineTotal({ channelId, fieldLabel, quantity } = {}) {
  if (String(channelId || "") !== SLABSNGRABSTC_SUCCESS_CHANNEL_ID) return false;
  const label = String(fieldLabel || "")
    .replace(/[*_\u200b]/g, "").replace(/:\s*$/, "").trim();
  if (!/^price$/i.test(label)) return false;
  const qty = Number(quantity);
  return Number.isSafeInteger(qty) && qty >= 1 && qty <= 999;
}

/** An empty retailer field on these specific source embeds can be resolved
 * from a Target-hosted product thumbnail, but an explicit retailer wins.
 * Never infer from an arbitrary CDN or an unrelated Discord channel. */
export function retailerFromTrustedSourceImage({ channelId, retailerLabel, imageUrl } = {}) {
  const explicit = String(retailerLabel || "").trim();
  if (explicit) return explicit;
  if (String(channelId || "") !== SLABSNGRABSTC_SUCCESS_CHANNEL_ID) return explicit;
  try {
    const url = new URL(String(imageUrl || ""));
    if (url.protocol === "https:" && url.hostname.toLowerCase() === "target.scene7.com") {
      return "Target";
    }
  } catch { /* No trustworthy product thumbnail. */ }
  return explicit;
}
