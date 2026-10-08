export function activeSitewideDiscount(records, tier, now = Date.now()) {
  return records.filter(item => item.sitewide === true && item.active && !item.exhausted && !item.usageUnavailable && item.stripePromotionCodeId &&
    !item.recipientEmail && item.ogOnly !== true &&
    (item.tier === "all" || Number(item.tier) === Number(tier)) &&
    (!item.expiresAt || Date.parse(item.expiresAt) > now))
    .sort((a, b) => Number(b.percent) - Number(a.percent))[0] || null;
}

export function activeOgDiscount(records, tier, now = Date.now()) {
  return records.filter(item => item.ogOnly === true && item.active && !item.exhausted && !item.usageUnavailable && item.stripeCouponId &&
    !item.recipientEmail &&
    (item.tier === "all" || Number(item.tier) === Number(tier)) &&
    (!item.expiresAt || Date.parse(item.expiresAt) > now))
    .sort((a, b) => Number(b.percent) - Number(a.percent))[0] || null;
}

export function membershipDiscountOptions(
  records,
  input,
  tier,
  now = Date.now(),
  accountEmail = "",
  isOgMember = false
) {
  const code = String(input || "").trim().toUpperCase();

  let discount = null;
  if (code) {
    discount = records.find(item => item.code === code) || null;
  } else if (isOgMember) {
    discount = activeOgDiscount(records, tier, now) || activeSitewideDiscount(records, tier, now);
  } else {
    discount = activeSitewideDiscount(records, tier, now);
  }

  if (!code && !discount) return { allow_promotion_codes: true };
  if (discount?.exhausted) throw new Error("This discount code has reached its maximum number of uses.");
  if (discount?.usageUnavailable) throw new Error("Discount availability could not be verified. Please try again.");

  const usableStripeDiscount =
    discount?.stripePromotionCodeId ||
    ((discount?.recipientEmail || discount?.ogOnly === true) && discount?.stripeCouponId);

  if (!discount?.active || !usableStripeDiscount ||
      (discount.expiresAt && !(Date.parse(discount.expiresAt) > now))) {
    throw new Error("This discount code is invalid, inactive, or expired.");
  }

  if (discount.tier !== "all" && Number(discount.tier) !== Number(tier)) {
    throw new Error("This discount code does not apply to your selected membership tier.");
  }

  if (discount.recipientEmail && discount.recipientEmail.toLowerCase() !== String(accountEmail).toLowerCase()) {
    throw new Error("This discount code is assigned to a different user.");
  }

  if (discount.ogOnly === true && !isOgMember) {
    throw new Error("This discount is available only to OG members.");
  }

  return {
    discounts: [
      discount.recipientEmail || discount.ogOnly === true
        ? { coupon: discount.stripeCouponId }
        : { promotion_code: discount.stripePromotionCodeId }
    ]
  };
}
