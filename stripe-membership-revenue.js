// Admin-only Stripe membership revenue source of truth.
// Count actual paid subscription invoices (including discounts), not price-list estimates.
export async function stripeMembershipRevenue(stripe, now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const periodStart = Math.floor(Date.UTC(year, month, 1) / 1000);
  const nextPeriod = Math.floor(Date.UTC(year, month + 1, 1) / 1000);
  async function allPages(list, params) {
    const output = [];
    let cursor;
    do {
      const page = await list({...params, limit: 100, ...(cursor ? {starting_after: cursor} : {})});
      output.push(...(page.data || []));
      if (output.length > 10000) throw new Error("Stripe result exceeds safety bound");
      cursor = page.has_more ? page.data?.at(-1)?.id : null;
      if (page.has_more && !cursor) throw new Error("Stripe pagination failed");
    } while (cursor);
    return output;
  }
  const [active, paidInvoices] = await Promise.all([
    allPages(params => stripe.subscriptions.list(params), {status: "active"}),
    allPages(params => stripe.invoices.list(params), {
      status: "paid", created: {gte: periodStart, lt: nextPeriod}
    })
  ]);
  const receipts = paidInvoices.filter(invoice => {
    const subscription = invoice.parent?.subscription_details?.subscription || invoice.subscription;
    const when = invoice.status_transitions?.paid_at;
    return Boolean(subscription) && invoice.status === "paid" &&
      invoice.currency === "usd" &&
      Number.isFinite(when) && when >= periodStart && when < nextPeriod;
  });
  // Recurring amount means the sum of CURRENT monthly subscription prices.
  // Upgrade/proration invoices and payments already collected do not affect MRR.
  // Fail closed for recurring discounts or non-monthly prices until a verified
  // discount-aware monthly equivalent is available.
  const monthlyAmounts=active.map(subscription=>{
    if ((subscription.discounts||[]).length || subscription.discount) return null;
    let cents=0;
    for (const item of subscription.items?.data||[]) {
      const price=item.price;
      const every=Number(price?.recurring?.interval_count||1);
      const quantity=Number(item.quantity||1);
      if (!price?.recurring || price.recurring.interval!=="month" ||
          !Number.isFinite(every) || every<=0 ||
          !Number.isFinite(Number(price.unit_amount)) ||
          price.currency!=="usd") return null;
      cents+=Number(price.unit_amount)*quantity/every;
    }
    return (subscription.items?.data||[]).length ? Math.round(cents) : null;
  });
  const recurringTotalVerified=monthlyAmounts.every(amount=>amount!==null);
  return {
    activePaidMemberships: active.length,
    monthlyRecurringCents: recurringTotalVerified ? monthlyAmounts.reduce((a,b)=>a+b,0) : null,
    recurringCalculation: "current_subscription_prices",
    monthlyPaidCents: receipts.reduce((sum, invoice) => sum + Math.max(0, Number(invoice.amount_paid) || 0), 0),
    paidInvoiceCount: receipts.length,
    currency: "usd",
    period: new Date(periodStart * 1000).toISOString().slice(0,7),
    timezone: "UTC",
    calculatedAt: now.toISOString()
  };
}
