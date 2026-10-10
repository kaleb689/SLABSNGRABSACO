import {membershipRate} from "./membership-billing-math.js";
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
  const [allSubscriptions, paidInvoices] = await Promise.all([
    allPages(params => stripe.subscriptions.list(params), {status:"all"}),
    allPages(params => stripe.invoices.list(params), {
      status:"paid",created:{gte:periodStart,lt:nextPeriod}
    })
  ]);
  const active=allSubscriptions.filter(sub=>["active","trialing"].includes(sub.status));
  const receipts=paidInvoices.filter(invoice=>{
    const subscription=invoice.parent?.subscription_details?.subscription||invoice.subscription;
    const when=invoice.status_transitions?.paid_at;
    return Boolean(subscription)&&invoice.status==="paid"&&invoice.currency==="usd"&&
      Number.isFinite(when)&&when>=periodStart&&when<nextPeriod;
  });
  const members=await Promise.all(active.map(async sub=>{
    let detailed=sub;
    if((sub.discounts||[]).length||sub.discount){
      try {detailed=await stripe.subscriptions.retrieve(sub.id,{expand:["discounts.coupon"]});}
      catch {detailed=sub;}
    }
    const rate=membershipRate(detailed,now.getTime());
    let invoice=null;
    try {
      const paid=await stripe.invoices.list({subscription:sub.id,status:"paid",limit:1});
      invoice=paid.data?.[0]||null;
    }catch { /* No fabricated past payment when invoice lookup is unavailable. */ }
    return {subscriptionId:sub.id,status:sub.status,
      currentAmountCents:rate.currentMonthlyCents??null,
      regularAmountCents:rate.regularMonthlyCents??null,
      nextInvoiceCents:rate.nextChargeCents??null,
      nextBillingAt:rate.nextChargeAt||null,
      giftedUntil:rate.giftedUntil||null,
      lastPaidCents:invoice?.status==="paid"?Number(invoice.amount_paid):null,
      lastPaidAt:invoice?.status_transitions?.paid_at?new Date(invoice.status_transitions.paid_at*1000).toISOString():null,
      lastPaymentKind:invoice?.billing_reason||null
    };
  }));
  const amountVerified=members.every(m=>m.currentAmountCents!==null);
  return {
    activePaidMemberships: active.length,
    monthlyRecurringCents: amountVerified ? members.reduce((sum,m)=>sum+m.currentAmountCents,0) : null,
    memberships: members,
    recurringCalculation: "current_subscription_prices",
    monthlyPaidCents: receipts.reduce((sum, invoice) => sum + Math.max(0, Number(invoice.amount_paid) || 0), 0),
    paidInvoiceCount: receipts.length,
    currency: "usd",
    period: new Date(periodStart * 1000).toISOString().slice(0,7),
    timezone: "UTC",
    calculatedAt: now.toISOString()
  };
}
