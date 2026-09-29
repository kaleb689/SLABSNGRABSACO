export function activeSitewideDiscount(records, tier, now = Date.now()) {
  return records.filter(item => item.sitewide === true && item.active && item.stripePromotionCodeId &&
    !item.recipientEmail && (item.tier === "all" || Number(item.tier) === Number(tier)) &&
    (!item.expiresAt || Date.parse(item.expiresAt) > now))
    .sort((a, b) => Number(b.percent) - Number(a.percent))[0] || null;
}

export function membershipDiscountOptions(records, input, tier, now = Date.now(), accountEmail = "") {
  const code = String(input || "").trim().toUpperCase();
  const discount = code ? records.find(item => item.code === code) : activeSitewideDiscount(records, tier, now);
  if (!code && !discount) return { allow_promotion_codes: true };
  if (!discount?.active || !(discount.stripePromotionCodeId || (discount.recipientEmail && discount.stripeCouponId)) ||
      (discount.expiresAt && !(Date.parse(discount.expiresAt) > now))) {
    throw new Error("This discount code is invalid, inactive, or expired.");
  }
  if (discount.tier !== "all" && Number(discount.tier) !== Number(tier)) {
    throw new Error("This discount code does not apply to your selected membership tier.");
  }
  if (discount.recipientEmail && discount.recipientEmail.toLowerCase() !== String(accountEmail).toLowerCase()) {
    throw new Error("This discount code is assigned to a different user.");
  }
  return { discounts: [discount.recipientEmail ? { coupon: discount.stripeCouponId } : { promotion_code: discount.stripePromotionCodeId }] };
}
