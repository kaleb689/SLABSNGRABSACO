// Owner-approved OG membership grants, November 15, 2026.
// Stripe customer IDs avoid storing personal names or addresses in source code.
export const APPROVED_OG_CUSTOMER_IDS = Object.freeze([
  "cus_VLAAENkEqC1ekg", // original qualifying member
  "cus_VP8a1d0VupEuZ8",
  "cus_VPtudIKIiqgwwJ",
  "cus_VQz0AGCerkLgKL",
  "cus_VUWiZMuef33D6U",
  "cus_VInR6yyvYtuvuA"  // owner-approved early-member exception
]);
export const OG_DISCOUNT_COUPON_ID = "SNG_OG10_LIFETIME_2026";
const approved = new Set(APPROVED_OG_CUSTOMER_IDS);

export function approvedOgAccountIds(paidRecords, subscriptionsByCustomer) {
  const accountIds = new Set();
  const matchedCustomers = new Set();
  for (const record of Array.isArray(paidRecords) ? paidRecords : []) {
    const id = String(record?.customerAccountId || "");
    if (!id) continue;
    const matches = APPROVED_OG_CUSTOMER_IDS.filter(customerId =>
      String(record?.stripeCustomerId || "") === customerId ||
      (subscriptionsByCustomer.get(customerId) || []).some(sub =>
        String(record?.stripeSubscriptionId || "") === String(sub.id)
      )
    );
    if (!matches.length) continue;
    accountIds.add(id);
    for (const match of matches) matchedCustomers.add(match);
  }
  for (const [customerId, subs] of subscriptionsByCustomer) {
    if (!approved.has(customerId)) continue;
    for (const sub of subs) {
      const id = String(sub?.metadata?.customer_account_id || "");
      if (id) {
        accountIds.add(id);
        matchedCustomers.add(customerId);
      }
    }
  }
  return { accountIds, matchedCustomers };
}

export function ogDiscountAction(subscription) {
  if (!["active", "trialing"].includes(String(subscription?.status || ""))) return "inactive";
  // Do not stack the OG offer with Thanksgiving or an existing, larger discount.
  const discounts = [
    ...(Array.isArray(subscription?.discounts) ? subscription.discounts : []),
    ...(subscription?.discount ? [subscription.discount] : [])
  ];
  return discounts.length ? "preserve_existing_discount" : "apply_og_10";
}

export async function reconcileApprovedOgMembers({
  stripe, loadAccounts, saveAccounts, loadPaid, savePaid,
  log = console, approvedAt = new Date().toISOString()
}) {
  if (!stripe || !loadAccounts || !saveAccounts || !loadPaid || !savePaid)
    throw new Error("Missing OG reconciliation dependencies.");
  const subscriptionsByCustomer = new Map();
  for (const customerId of APPROVED_OG_CUSTOMER_IDS) {
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId, status: "all", limit: 100
    });
    if (subscriptions?.has_more) throw new Error("OG subscription list is incomplete: " + customerId);
    subscriptionsByCustomer.set(customerId, subscriptions?.data || []);
  }

  const [accounts, paid] = await Promise.all([loadAccounts(), loadPaid()]);
  if (!Array.isArray(accounts) || !Array.isArray(paid))
    throw new Error("OG account and payment storage must contain arrays.");
  const { accountIds, matchedCustomers } = approvedOgAccountIds(paid, subscriptionsByCustomer);
  const presentAccountIds = new Set(accounts.map(a => String(a.id)));
  let accountChanges = 0, recordChanges = 0;
  for (const account of accounts) {
    if (accountIds.has(String(account.id)) && !account.ogMemberGrantedAt) {
      account.ogMemberGrantedAt = approvedAt;
      account.updatedAt = new Date().toISOString();
      accountChanges++;
    }
  }
  for (const record of paid) {
    if (accountIds.has(String(record?.customerAccountId || "")) &&
        presentAccountIds.has(String(record?.customerAccountId || "")) &&
        record.ogMember !== true) {
      record.ogMember = true;
      recordChanges++;
    }
  }
  if (accountChanges) await saveAccounts(accounts);
  if (recordChanges) await savePaid(paid);

  let coupon;
  try {
    coupon = await stripe.coupons.retrieve(OG_DISCOUNT_COUPON_ID);
  } catch (error) {
    if (error?.code !== "resource_missing") throw error;
    coupon = await stripe.coupons.create({
      id: OG_DISCOUNT_COUPON_ID,
      name: "SLABSNGRABSACO OG 10% Lifetime",
      percent_off: 10,
      duration: "forever",
      metadata: { sng_purpose: "og_renewal", sng_nonstacking: "true" }
    }, { idempotencyKey: "sng-og-10-forever-v1" });
  }
  if (coupon?.percent_off !== 10 || coupon?.duration !== "forever")
    throw new Error("Existing OG coupon does not match approved terms.");

  let discounted = 0, preserved = 0, inactive = 0;
  const errors = [];
  for (const customerId of APPROVED_OG_CUSTOMER_IDS) {
    try {
      const customer = await stripe.customers.retrieve(customerId);
      if (customer?.deleted) throw new Error("Stripe customer is deleted.");
      if (customer?.metadata?.sng_og_member !== "true" ||
          customer?.metadata?.sng_og_discount !== "10") {
        await stripe.customers.update(customerId, {
          metadata: {
            sng_og_member: "true",
            sng_og_discount: "10",
            sng_og_approved_on: "2026-11-15"
          }
        });
      }
      for (const sub of subscriptionsByCustomer.get(customerId) || []) {
        const action = ogDiscountAction(sub);
        if (action === "inactive") { inactive++; continue; }
        if (action === "preserve_existing_discount") { preserved++; continue; }
        await stripe.subscriptions.update(sub.id, {
          discounts: [{ coupon: OG_DISCOUNT_COUPON_ID }],
          proration_behavior: "none",
          metadata: { sng_og_member: "true", sng_og_discount: "10" }
        });
        discounted++;
      }
    } catch (error) {
      errors.push({ customerId, message: String(error?.message || error) });
      log.error?.("OG member reconciliation failed", customerId, error?.message || error);
    }
  }
  const missing = APPROVED_OG_CUSTOMER_IDS.filter(id => !matchedCustomers.has(id));
  if (missing.length)
    log.error?.("Approved OG customers not linked to a website paid account", missing);
  return {
    approvedCustomers: APPROVED_OG_CUSTOMER_IDS.length,
    linkedAccounts: [...accountIds].filter(id => presentAccountIds.has(id)).length,
    missingWebsiteMatches: missing,
    accountChanges, recordChanges, discounted, preserved, inactive, errors
  };
}
