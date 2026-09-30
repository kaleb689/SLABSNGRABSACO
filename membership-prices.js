export async function correctedMembershipPrice(stripe, tier, plan, cachedId) {
  const original = await stripe.prices.retrieve(plan.priceId);
  const product = typeof original.product === 'string' ? original.product : original.product?.id;
  if (!product || original.currency !== 'usd' || original.type !== 'recurring' || original.recurring?.interval !== 'month' || (original.recurring?.interval_count || 1) !== 1) {
    throw new Error('Membership requires a monthly USD Stripe price.');
  }
  const target = plan.amount * 100;
  const matches = price => price?.active && price.currency === 'usd' && price.unit_amount === target &&
    (typeof price.product === 'string' ? price.product : price.product?.id) === product &&
    price.type === 'recurring' && price.recurring?.interval === 'month' && (price.recurring.interval_count || 1) === 1;
  if (matches(original)) return { price: original, original };
  if (cachedId) {
    try { const cached = await stripe.prices.retrieve(cachedId); if (matches(cached)) return { price: cached, original }; }
    catch (error) { if (error?.code !== 'resource_missing') throw error; }
  }
  const lookupKey = `sng-membership-${tier}-${product}-usd-${target}-monthly`;
  const existing = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 10 });
  const found = existing.data.find(matches);
  if (found) return { price: found, original };
  const price = await stripe.prices.create({ product, currency: 'usd', unit_amount: target,
    recurring: { interval: 'month', interval_count: 1 }, lookup_key: lookupKey,
    nickname: `${plan.name} — ${plan.profiles} accounts — $${plan.amount}/month`
  }, { idempotencyKey: lookupKey });
  if (!matches(price)) throw new Error('Stripe returned an unexpected membership price.');
  return { price, original };
}
