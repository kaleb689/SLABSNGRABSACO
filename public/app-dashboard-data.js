export function shippingStage(order) {
  if (/cancel|refund|failed|declined/i.test(order.status || '')) return 'cancelled';
  const status = order.shipping?.status;
  return ['shipped', 'in_transit', 'out_for_delivery', 'delivered'].includes(status) ? status : 'ordered';
}
export function periodStart(days, now = new Date()) {
  const start = new Date(now);
  if (days === 1) return new Date(now.getTime() - 86400000);
  start.setHours(0, 0, 0, 0);
  if (days === 'ytd') start.setMonth(0, 1);
  else start.setDate(start.getDate() - days + 1);
  return start;
}
export function selectedOrders(orders, days, now = new Date()) {
  const start = periodStart(days, now).getTime();
  return orders.filter(order => Date.parse(order.checkoutAt) >= start && Date.parse(order.checkoutAt) <= now.getTime() && shippingStage(order) !== 'cancelled')
    .sort((a, b) => Date.parse(b.checkoutAt) - Date.parse(a.checkoutAt));
}
export function metricChanges(previous, next) {
  return Object.fromEntries(['orders', 'transit', 'delivered'].map(key => [key, previous ? next[key] - previous[key] : 0]));
}
export function dashboardTotals(orders) {
  return { orders: orders.length, items: orders.reduce((sum, r) => sum + (Number(r.itemCount) || 0), 0),
    spend: orders.reduce((sum, r) => sum + (Number(r.orderTotal) || 0), 0),
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
  const start = periodStart(days, now);
  const hours = days === 1;
  const count = hours ? 24 : days === 'ytd' ? Math.floor((now - start) / 86400000) + 1 : days;
  const bucketMs = hours ? 3600000 : (count > 30 ? Math.ceil(count / 24) : 1) * 86400000;
  const buckets = new Map();
  const length = Math.ceil((hours ? 86400000 : count * 86400000) / bucketMs);
  for (let i = 0; i < length; i++) buckets.set(i, {
    date: new Date(start.getTime() + i * bucketMs).toISOString().slice(0, 10), count: 0, value: 0
  });
  for (const order of orders) {
    const bucket = buckets.get(Math.floor((Date.parse(order.checkoutAt) - start.getTime()) / bucketMs));
    if (bucket) { bucket.count++; bucket.value += Number(order.orderTotal) || 0; }
  }
  return [...buckets.values()];
}
