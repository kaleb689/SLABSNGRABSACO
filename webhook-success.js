// Reconcile the same checkout across email and bot sources without double counting.
export function sameCheckout(a, b) {
  const aliases = new Set([a.id, ...(a.sourceIds || [])]);
  if ([b.id, ...(b.sourceIds || [])].some(id => aliases.has(id))) return true;
  const number = v => String(v || '').replace(/^#/, '').trim().toLowerCase();
  return Boolean(number(a.orderNumber) && number(a.orderNumber) === number(b.orderNumber) && a.retailer === b.retailer);
}

export function reconcileWebhookCheckout(records, order, attribution = null) {
  const matches = records.filter(record => sameCheckout(record, order));
  const owners = new Set(matches.map(record => record.customerAccountId).filter(Boolean));
  // Never move an already-attributed checkout based on a current assignment.
  const owner = owners.size === 1 ? [...owners][0] : owners.size ? null : attribution?.customerAccountId || null;
  if (owners.size > 1) return { changed: false, conflict: true, record: null };
  const prior = matches.find(record => record.customerAccountId) || matches[0] || {};
  const priced = order.orderTotalBasis !== 'unknown' && Number.isFinite(order.orderTotal) && order.orderTotal > 0;
  const merged = {
    ...prior,
    ...(owner && !prior.customerAccountId ? attribution : {}),
    id: prior.id || order.id,
    customerAccountId: owner,
    retailer: order.retailer,
    orderNumber: order.orderNumber || prior.orderNumber || '',
    checkoutAt: prior.checkoutAt || order.checkoutAt,
    orderTotal: priced ? order.orderTotal : prior.orderTotal || 0,
    orderTotalBasis: priced ? order.orderTotalBasis : prior.orderTotalBasis || 'unknown',
    priceSource: priced ? 'checkout_webhook' : prior.priceSource || null,
    itemCount: order.itemCount,
    items: order.items.map(item => {
      const previous = (prior.items || []).find(old => old.name === item.name);
      return { ...item, imageUrl: item.imageUrl || previous?.imageUrl || null };
    }),
    status: prior.status || 'confirmed',
    sourceIds: [...new Set([...matches.flatMap(record => [record.id, ...(record.sourceIds || [])]), order.id])]
  };
  const changed = matches.length !== 1 || JSON.stringify(merged) !== JSON.stringify(prior);
  if (changed) {
    const index = matches.length ? records.indexOf(matches[0]) : records.length;
    for (let i = records.length - 1; i >= 0; i--) if (matches.includes(records[i])) records.splice(i, 1);
    records.splice(Math.min(index, records.length), 0, merged);
  }
  return { changed, added: matches.length === 0, record: merged };
}

export function uniqueCheckoutOwner(candidates) {
  const ids = new Set(candidates.map(item => item.customerAccountId).filter(Boolean));
  return ids.size === 1 ? candidates.find(item => item.customerAccountId === [...ids][0]) : null;
}
