// Reconcile the same checkout across email and bot sources without double counting.
export function sameCheckout(a, b) {
  const aliases = new Set([a.id, ...(a.sourceIds || [])].filter(Boolean).map(String));
  if ([b.id, ...(b.sourceIds || [])].filter(Boolean).map(String).some(id => aliases.has(id))) return true;
  const number = v => String(v || '').replace(/^#/, '').trim().toLowerCase();
  const orderNumber = number(a.orderNumber);
  // Exact retailer order IDs can be shared by two webhook feeds. Never use a
  // generic label ("Success") or an empty value to merge unrelated orders.
  return Boolean(orderNumber.length >= 5 && /\d/.test(orderNumber) &&
    orderNumber === number(b.orderNumber) && a.retailer === b.retailer);
}

export function reconcileWebhookCheckout(records, order, attribution = null) {
  const matches = records.filter(record => sameCheckout(record, order));
  const owners = new Set(matches.map(record => record.customerAccountId).filter(Boolean));
  // Never move an already-attributed checkout based on a current assignment.
  const owner = owners.size === 1 ? [...owners][0] : owners.size ? null : attribution?.customerAccountId || null;
  if (owners.size > 1) return { changed: false, conflict: true, record: null };
  const prior = matches.find(record => record.customerAccountId) || matches[0] || {};
  const priced = order.orderTotalBasis !== 'unknown' && Number.isFinite(order.orderTotal) && order.orderTotal > 0;
  // Discord webhooks about the SAME retailer order can arrive as green,
  // orange and red messages at different times. Use only the newest event
  // color for status, not whichever webhook happens to be scanned last.
  // A later verified retailer-email cancellation must not be undone by the
  // regular rescan of an older green Discord message.
  const when = value => {
    const date = Date.parse(value || '');
    return Number.isFinite(date) ? date : -Infinity;
  };
  const oldStatusTime = Math.max(when(prior.statusUpdatedAt || prior.checkoutAt), when(prior.cancelledAt || prior.canceledAt));
  const newStatusTime = when(order.statusUpdatedAt || order.checkoutAt);
  const updateStatus = !matches.length || (newStatusTime >= oldStatusTime && order.status !== 'unverified');
  const nextStatus = updateStatus ? (order.status || 'unverified') : (prior.status || 'unverified');
  const nextStatusAt = updateStatus ? (order.statusUpdatedAt || order.checkoutAt || null) :
    (prior.statusUpdatedAt || null);
  let nextCancelledAt = prior.cancelledAt || prior.canceledAt || null;
  if (updateStatus) nextCancelledAt = nextStatus === 'cancelled' ?
    (order.cancelledAt || nextStatusAt) : null;
  let placedAt = prior.checkoutAt || order.checkoutAt;
  // A cancellation-only webhook is not proof of the original placement
  // time. A later-discovered older GREEN/ORANGE hook supplies that time.
  if (order.status !== 'cancelled' && when(order.checkoutAt) < when(placedAt)) placedAt = order.checkoutAt;
  const merged = {
    ...prior,
    ...(owner && !prior.customerAccountId ? attribution : {}),
    id: prior.id || order.id,
    customerAccountId: owner,
    retailer: order.retailer,
    orderNumber: order.orderNumber || prior.orderNumber || '',
    sourceProfileLabel: String(order.sourceProfileLabel || prior.sourceProfileLabel || '').slice(0, 100),
    checkoutAt: placedAt,
    statusUpdatedAt: nextStatusAt,
    ...(nextCancelledAt ? { cancelledAt: nextCancelledAt } : { cancelledAt: null }),
    orderTotal: priced ? order.orderTotal : prior.orderTotal || 0,
    orderTotalBasis: priced ? order.orderTotalBasis : prior.orderTotalBasis || 'unknown',
    priceSource: priced ? 'checkout_webhook' : prior.priceSource || null,
    itemCount: order.itemCount,
    items: order.items.map(item => {
      const previous = (prior.items || []).find(old => old.name === item.name);
      return { ...item, imageUrl: item.imageUrl || previous?.imageUrl || null };
    }),
    status: nextStatus,
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

export function reconcileEmailCheckoutIdentity(records, emailOrder) {
  const prior = records.find(record => record.id === emailOrder.id || (record.sourceIds || []).includes(emailOrder.id));
  if (!prior || !emailOrder.orderNumber || prior.retailer !== emailOrder.retailer) return { changed: false };
  const normalize = value => String(value || '').replace(/^#/, '').trim().toLowerCase();
  if (prior.orderNumber && normalize(prior.orderNumber) !== normalize(emailOrder.orderNumber)) return { changed: false, conflict: true };
  const missing = !prior.orderNumber;
  if (missing) prior.orderNumber = emailOrder.orderNumber;
  const webhook = records.find(record => record !== prior && record.priceSource === 'checkout_webhook' && sameCheckout(record, prior));
  if (webhook) {
    const merged = reconcileWebhookCheckout(records, webhook);
    return { ...merged, changed: missing || merged.changed };
  }
  return { changed: missing, record: prior };
}
