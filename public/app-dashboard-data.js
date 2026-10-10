// Only cancellations that occurred at least 24 hours after checkout belong
// in a customer's tracking/history display. This mirrors the server rule.
export function visibleLateCancellation(order, now = new Date()) {
  const cancelled = Boolean(order?.cancelledAt || order?.canceledAt ||
    /cancel|refund|failed|declined/i.test(String(order?.status || '')));
  if (!cancelled) return false;
  const placed = Date.parse(order?.checkoutAt || '');
  const ended = Date.parse(order?.cancelledAt || order?.canceledAt || '');
  return Number.isFinite(placed) && Number.isFinite(ended) &&
    ended - placed >= 24 * 60 * 60 * 1000 && ended <= now.getTime() + 60 * 1000;
}
export function shippingStage(order) {
  if (order?.cancelledAt || order?.canceledAt ||
      /cancel|refund|failed|declined/i.test(order.status || '')) return 'cancelled';
  if (order?.status === 'review_hold') return 'review_hold';
  const status = order.shipping?.status;
  return ['shipped', 'in_transit', 'out_for_delivery', 'delivered'].includes(status) ? status : 'ordered';
}
export function periodStart(days, now = new Date()) {
  // Use the same rolling windows and local calendar boundaries as Admin.
  // Avoid invalid dates for MTD/lifetime and day-window drift at midnight.
  if (days === 'all' || days === 'lifetime') return new Date(0);
  if (days === 'mtd') return new Date(now.getFullYear(), now.getMonth(), 1);
  if (days === 'ytd') return new Date(now.getFullYear(), 0, 1);
  const durationDays = Number(days);
  return Number.isFinite(durationDays) && durationDays > 0
    ? new Date(now.getTime() - Math.floor(durationDays) * 86400000)
    : new Date(0);
}
export function selectedOrders(orders, days, now = new Date()) {
  const start = periodStart(days, now).getTime();
  return orders.filter(order => Date.parse(order.checkoutAt) >= start && Date.parse(order.checkoutAt) <= now.getTime() &&
    !['cancelled', 'review_hold'].includes(shippingStage(order)))
    .sort((a, b) => Date.parse(b.checkoutAt) - Date.parse(a.checkoutAt));
}
export function metricChanges(previous, next) {
  return Object.fromEntries(['orders', 'transit', 'delivered'].map(key => [key, previous ? next[key] - previous[key] : 0]));
}
// Unknown subtotals are not verified charges, even if legacy payloads still
// contain a numeric orderTotal. Customer and Admin spending must agree.
export function verifiedOrderSpend(order) {
  const amount = Number(order?.orderTotal);
  // A legacy numeric amount or a unit subtotal is not proof of money paid.
  // API responses explicitly set orderTotalKnown; trusted raw records may
  // instead carry the same verified basis used by the server and Admin.
  const paidBasis = ['order_total', 'retailer_receipt'].includes(String(order?.orderTotalBasis || '').toLowerCase());
  const receiptSource = order?.priceSource === 'verified_retailer_receipt' ||
    order?.priceSource === 'admin_verified_retailer_receipt';
  const verified = order?.orderTotalKnown === true ||
    (order?.orderTotalKnown !== false && (paidBasis || receiptSource));
  return verified && Number.isFinite(amount) && amount > 0 && amount <= 1000000
    ? Math.round(amount * 100) / 100 : 0;
}
export function dashboardTotals(orders) {
  return { orders: orders.length, items: orders.reduce((sum, r) => sum + (Number(r.itemCount) || 0), 0),
    spend: orders.reduce((sum, r) => sum + verifiedOrderSpend(r), 0),
    transit: orders.filter(r => ['shipped', 'in_transit', 'out_for_delivery'].includes(shippingStage(r))).length,
    delivered: orders.filter(r => shippingStage(r) === 'delivered').length,
    awaiting: orders.filter(r => shippingStage(r) === 'ordered').length };
}
export function dashboardProducts(orders) {
  const products = new Map();
  for (const order of orders) for (const item of order.items || []) {
    const key = `${order.retailer}:${item.name}`;
    const product = products.get(key) || { name: item.name || 'Product', retailer: order.retailer, imageUrl: item.imageUrl,
      quantity: 0, value: 0, delivered: 0, orders: 0 };
    if (!product.imageUrl && item.imageUrl) product.imageUrl = item.imageUrl;
    const qty = Math.max(0, Number(item.quantity) || 1);
    product.quantity += qty; product.value += qty * (Number(item.price) || 0); product.orders++;
    if (shippingStage(order) === 'delivered') product.delivered += qty;
    products.set(key, product);
  }
  return [...products.values()].sort((a, b) => b.value - a.value);
}
export function dashboardActivity(orders, days, now = new Date()) {
  const source = Array.isArray(orders) ? orders : [];
  const earliest = source.map(order => Date.parse(order?.checkoutAt || ''))
    .filter(Number.isFinite).reduce((min, at) => Math.min(min, at), now.getTime());
  const start = days === 'all' || days === 'lifetime'
    ? new Date(Math.max(0, earliest)) : periodStart(days, now);
  const hours = days === 1;
  const duration = Math.max(86400000, now.getTime() - start.getTime());
  const bucketMs = hours ? 3600000 : Math.ceil(duration / 86400000 / 24) * 86400000;
  const length = hours ? 24 : Math.max(1, Math.ceil(duration / bucketMs));
  const buckets = new Map();
  for (let i = 0; i < length; i++) buckets.set(i, {
    date: new Date(start.getTime() + i * bucketMs).toISOString().slice(0, 10),
    count: 0, value: 0
  });
  for (const order of source) {
    const at = Date.parse(order?.checkoutAt || '');
    if (!Number.isFinite(at) || at < start.getTime() || at > now.getTime()) continue;
    // A purchase made exactly at the end of a period belongs to its last bar.
    const index = Math.min(length - 1, Math.floor((at - start.getTime()) / bucketMs));
    const bucket = buckets.get(index);
    if (bucket) { bucket.count++; bucket.value += verifiedOrderSpend(order); }
  }
  return [...buckets.values()];
}
