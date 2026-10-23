const DAY_MS = 86400000;

function timestamp(value) {
  if (value == null || value === "") return 0;
  const n = value instanceof Date ? value.getTime() :
    typeof value === "number" ? (value < 100000000000 ? value * 1000 : value) : Date.parse(String(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function addMonthsClamped(value, months) {
  const original = new Date(value);
  const next = new Date(value);
  next.setUTCDate(1);
  next.setUTCMonth(original.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(original.getUTCDate(), lastDay));
  return next.getTime();
}

export function membershipExtensionBounds({now = new Date(), periodEnd, trialEnd, previousGiftEnd, billingCycleAnchor}) {
  const nowMs = timestamp(now);
  const stripeEnd = Math.max(timestamp(periodEnd), timestamp(trialEnd));
  if (!nowMs || !stripeEnd) throw new Error("Stripe did not provide a verified renewal date.");
  const currentMs = Math.max(nowMs, stripeEnd, timestamp(previousGiftEnd));
  const anchorMs = timestamp(billingCycleAnchor) || nowMs;
  // Stripe limits trial_end to two years after its billing-cycle anchor.
  // The local two-year guard also avoids unintended very-long billing deferrals.
  const maxMs = Math.min(addMonthsClamped(nowMs, 24), addMonthsClamped(anchorMs, 24));
  return {currentRenewalAt: new Date(currentMs).toISOString(), maxRenewalAt: new Date(maxMs).toISOString()};
}

export function calculateMembershipExtension({durationQuantity, durationUnit, until, ...boundsInput}) {
  const bounds = membershipExtensionBounds(boundsInput);
  const start = Date.parse(bounds.currentRenewalAt);
  const maximum = Date.parse(bounds.maxRenewalAt);
  let end;
  if (until != null && until !== "") {
    if (typeof until !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(until)) {
      throw new Error("Choose a valid renewal date.");
    }
    end = Date.parse(until);
  } else {
    const quantity = Number(durationQuantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000 ||
        !["days", "weeks", "months", "years"].includes(durationUnit)) {
      throw new Error("Choose a positive number of days, weeks, months, or years.");
    }
    end = durationUnit === "days" ? start + quantity * DAY_MS :
      durationUnit === "weeks" ? start + quantity * 7 * DAY_MS :
      addMonthsClamped(start, quantity * (durationUnit === "years" ? 12 : 1));
  }
  if (!Number.isFinite(end) || end <= start) {
    throw new Error("The new renewal date must be later than the current renewal date.");
  }
  if (end > maximum) {
    throw new Error("Stripe allows this billing extension only within its two-year trial limit. Choose a shorter period.");
  }
  return {startsAt: bounds.currentRenewalAt, expiresAt: new Date(end).toISOString(), stripeTrialEnd: Math.floor(end / 1000)};
}
