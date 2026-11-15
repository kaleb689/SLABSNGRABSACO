// Thanksgiving 2026 offer. Approval of base-price changes is separate from
// promotional eligibility and must never mutate active Stripe subscriptions.
export const THANKSGIVING_CODE = "THANKS25";
export const THANKSGIVING_DISCOUNT_PERCENT = 25;
export const THANKSGIVING_MAX_DISCOUNT_MONTHS = 6;
export const THANKSGIVING_END_AT = "2026-11-28T05:00:00.000Z"; // Nov 27, 11:59:59 EST
export const UPCOMING_PRICE_EFFECTIVE_AT = "2026-11-28T05:00:00.000Z";
export const UPCOMING_INCREASE_PERCENT = 42;

export function isThanksgivingCode(code) {
  return String(typeof code === "object" ? code?.code : code || "")
    .trim().toUpperCase() === THANKSGIVING_CODE;
}

export function validateThanksgivingExtensionMonths({months, code, priorMonths=0}) {
  if (!isThanksgivingCode(code)) return;
  const requested = Number(months), already = Number(priorMonths);
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > THANKSGIVING_MAX_DISCOUNT_MONTHS)
    throw Error("THANKS25 is valid only for 1–6 prepaid membership months. Choose up to 6 months or remove the code.");
  if (!Number.isSafeInteger(already) || already < 0 || already + requested > THANKSGIVING_MAX_DISCOUNT_MONTHS)
    throw Error("THANKS25 is limited to 6 discounted extension months per membership, including earlier purchases or pending checkouts.");
}

export function thanksgivingDiscountedMonths(months, code) {
  validateThanksgivingExtensionMonths({months,code});
  return Number(months);
}

export function upcomingMembershipPrices(plans, {approved=false}={}) {
  if (!approved) return null;
  const prices = {};
  for (const [tier,plan] of Object.entries(plans||{})) {
    const cents = Math.round(Number(plan?.amount)*100);
    if (!Number.isSafeInteger(cents) || cents < 0) throw Error("Invalid approved base membership price.");
    prices[tier] = Math.round(cents*1.42);
  }
  return {effectiveAt:UPCOMING_PRICE_EFFECTIVE_AT,
    increasePercent:UPCOMING_INCREASE_PERCENT,prices};
}
