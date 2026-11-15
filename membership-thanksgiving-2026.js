// Thanksgiving 2026 upcoming price display, rounded DOWN to nearest $5 on Nov 28.
export const THANKSGIVING_2026 = Object.freeze({
  code: "THANKS25",
  discountPercent: 25,
  saleEndExclusive: "2026-11-28T05:00:00.000Z", // Nov 27, 11:59:59 PM EST
  upcomingEffectiveAt: "2026-11-28T05:00:00.000Z",
  increasePercent: 42
});

const cents = price => {
  const value = Number(price);
  if (!Number.isFinite(value) || value < 0 || Math.round(value * 100) !== value * 100)
    throw new Error("Membership price must be a non-negative USD amount with at most two decimals.");
  return Math.round(value * 100);
};

export function proposedThanksgivingPrice(amount) {
  return Math.round(cents(amount) * (100 - THANKSGIVING_2026.discountPercent) / 100);
}

export function proposedUpcomingPrice(amount) {
  return Math.floor((cents(amount) * (100 + THANKSGIVING_2026.increasePercent) / 100) / 500) * 500;
}

export function approvedUpcomingSchedule(plans, { approved = false, now = Date.now() } = {}) {
  if (approved !== true || !Number.isFinite(now) ||
      now >= Date.parse(THANKSGIVING_2026.upcomingEffectiveAt)) return null;
  return {
    effectiveAt: THANKSGIVING_2026.upcomingEffectiveAt,
    increasePercent: THANKSGIVING_2026.increasePercent,
    prices: Object.fromEntries(Object.entries(plans).map(([tier, plan]) =>
      [tier, proposedUpcomingPrice(plan.amount)]))
  };
}
