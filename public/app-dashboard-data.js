export function shippingStage(order) {
  if (/cancel|refund|failed|declined/i.test(order.status || '')) return 'cancelled';
  const status = order.shipping?.status;
  return ['shipped', 'in_transit', 'out_for_delivery', 'delivered'].includes(status) ? status : 'ordered';
}
export function selectedOrders(orders, days, now = new Date()) {
  const start = new Date(now); start.setUTCHours(0, 0, 0, 0); start.setUTCDate(start.getUTCDate() - days + 1);
  return orders.filter(order => Date.parse(order.checkoutAt) >= start.getTime() && shippingStage(order) !== 'cancelled')
    .sort((a, b) => Date.parse(b.checkoutAt) - Date.parse(a.checkoutAt));
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
    const qty = Math.max(0, Number(item.quantity) || 1);
    product.quantity += qty; product.value += qty * (Number(item.price) || 0); product.orders++;
    if (shippingStage(order) === 'delivered') product.delivered += qty;
    products.set(key, product);
  }
  return [...products.values()].sort((a, b) => b.value - a.value);
}
export function dashboardActivity(orders, days, now = new Date()) {
  const buckets = new Map();
  const bucketDays = days > 30 ? Math.ceil(days / 24) : 1;
  const start = new Date(now); start.setUTCHours(0, 0, 0, 0); start.setUTCDate(start.getUTCDate() - days + 1);
  for (let i = 0; i < days; i += bucketDays) {
    const date = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
    buckets.set(Math.floor(i / bucketDays), { date, count: 0, value: 0 });
  }
  for (const order of orders) {
    const offset = Math.floor((Date.parse(order.checkoutAt) - start.getTime()) / 86400000);
    const bucket = buckets.get(Math.floor(offset / bucketDays));
    if (bucket) { bucket.count++; bucket.value += Number(order.orderTotal) || 0; }
  }
  return [...buckets.values()];
}
