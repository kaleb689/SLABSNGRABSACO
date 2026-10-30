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
// Dates from <input type="date"> are local calendar days, not UTC strings.
// In particular, an end date is inclusive across DST and timezone changes.
export function customDateBounds(range) {
  const parseDay = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 &&
      date.getDate() === day ? date : null;
  };
  const first = parseDay(range?.from), last = parseDay(range?.to);
  if (!first || !last || first > last) return null;
  return {
    start: first.getTime(),
    end: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).getTime()
  };
}
export function periodBounds(days, now = new Date(), range = null) {
  if (days === 'custom') {
    const bounds = customDateBounds(range);
    return bounds ? {start:bounds.start, end:Math.min(bounds.end, now.getTime()+1)}
      : {start:Infinity, end:-Infinity};
  }
  return {start:periodStart(days,now).getTime(),end:now.getTime()+1};
}
export function periodStart(days, now = new Date(), range = null) {
  if (days === 'custom') return new Date(customDateBounds(range)?.start ?? NaN);
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
export function selectedOrders(orders, days, now = new Date(), range = null) {
  const {start, end} = periodBounds(days, now, range);
  return orders.filter(order => Date.parse(order.checkoutAt) >= start && Date.parse(order.checkoutAt) < end &&
    shippingStage(order) !== 'cancelled')
    .sort((a, b) => Date.parse(b.checkoutAt) - Date.parse(a.checkoutAt));
}
export function checkoutRequestRange(days, now = new Date(), range = null) {
  const {start, end} = periodBounds(days, now, range);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw Error('Choose a valid checkout date range.');
  return { start: new Date(start).toISOString().slice(0, 10),
    end: new Date(end - 1).toISOString().slice(0, 10),
    startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(),
    ...(days === 'all' || days === 'lifetime' ? {lifetime:'1'} : {}) };
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
export function customerOrderValue(order) {
  const value = Number(order?.checkoutValue);
  if (order?.checkoutValueKnown === true && Number.isFinite(value) && value > 0 && value <= 1000000) return Math.round(value * 100) / 100;
  return verifiedOrderSpend(order);
}
export function dashboardTotals(orders) {
  orders = orders.filter(order => shippingStage(order) !== 'cancelled');
  return { orders: orders.length, items: orders.reduce((sum, r) => sum + (Number(r.itemCount) || 0), 0),
    spend: orders.reduce((sum, r) => sum + Math.round(customerOrderValue(r) * 100), 0) / 100,
    transit: orders.filter(r => ['shipped', 'in_transit', 'out_for_delivery'].includes(shippingStage(r))).length,
    delivered: orders.filter(r => shippingStage(r) === 'delivered').length,
    awaiting: orders.filter(r => shippingStage(r) === 'ordered').length };
}
/**
 * Presentation only: never alter stored webhook titles or SKU identity.
 * Preserve real pack/edition information such as (3-Pack) and (151).
 */
export function displayProductName(value) {
  let name = String(value || "").trim(), match;
  const prefix = /^\\s*\\((?:(?:sku|pid|tcin|dpci)\\s*[:#]?\\s*)?([a-z0-9]+(?:-[a-z0-9]+)+|\\d{8,})\\)\\s*/i;
  while ((match = name.match(prefix)) && /\\d/.test(match[1]) &&
    !/\\b(?:pack|count|pk|ct|edition|anniversary)\\b/i.test(match[1]))
    name = name.slice(match[0].length).trim();
  return name || "Product";
}
export function dashboardProducts(orders) {
  const products = new Map();
  for (const order of orders) {
    const entries = (Array.isArray(order.items) ? order.items : [])
      .filter(item => item && Number(item.quantity) > 0 && String(item.name || "").trim());
    const identity = item => String(item.productKey || displayProductName(item.name)
      .normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, " ").trim());
    const singleProduct = new Set(entries.map(identity)).size === 1;
    const counted = new Set();
    for (const item of entries) {
      const key = identity(item);
      if (!key) continue;
      const retailer = String(order.retailer || "Retailer");
      const product = products.get(key) || {
        name: displayProductName(item.name), retailer, retailers: new Set(),
        imageUrl: item.imageUrl, quantity: 0, value: 0, delivered: 0, orders: 0,
        pricedQuantity: 0, unpricedQuantity: 0,
        singleProductOrders: true, knownOrderValues: true,
        verifiedOrderValues: true, orderValueCents: 0
      };
      product.retailers.add(retailer);
      if (!product.imageUrl && item.imageUrl) product.imageUrl = item.imageUrl;
      const qty = Math.max(0, Number(item.quantity) || 0);
      const price = Number(item.price);
      product.quantity += qty;
      if (Number.isFinite(price) && price > 0 && price <= 1000000) {
        product.value += qty * price;
        product.pricedQuantity += qty;
      } else {
        product.unpricedQuantity += qty;
      }
      if (shippingStage(order) === "delivered") product.delivered += qty;
      // The FULL retailer order total belongs to a product only if that
      // product is the sole distinct product on the order (including qty > 1).
      // Multi-product orders must never allocate tax or fees arbitrarily.
      if (!counted.has(key)) {
        product.orders++;
        product.singleProductOrders &&= singleProduct;
        if (singleProduct) {
          const orderValue = customerOrderValue(order);
          if (orderValue > 0) product.orderValueCents += Math.round(orderValue * 100);
          else product.knownOrderValues = false;
          const verifiedPaid = Number(order.verifiedPaidTotal) > 0 ||
            (order.orderTotalKnown === true &&
             ["retailer_receipt", "discord_webhook"].includes(order.priceSource));
          if (!verifiedPaid) product.verifiedOrderValues = false;
        }
        counted.add(key);
      }
      products.set(key, product);
    }
  }
  return [...products.values()].map(product => ({
    ...product, retailer: [...product.retailers].join(" · "),
    retailers: [...product.retailers],
    orderValue: product.orderValueCents / 100
  })).sort((a, b) => (b.singleProductOrders && b.knownOrderValues ? b.orderValue : b.value) -
    (a.singleProductOrders && a.knownOrderValues ? a.orderValue : a.value));
}
export function dashboardActivity(orders, days, now = new Date(), range = null) {
  const source = Array.isArray(orders) ? orders : [];
  const bounds = periodBounds(days, now, range);
  if (bounds.end <= bounds.start) return [];
  const earliest = source.map(order => Date.parse(order?.checkoutAt || ''))
    .filter(Number.isFinite).reduce((min, at) => Math.min(min, at), now.getTime());
  const start = days === 'all' || days === 'lifetime'
    ? new Date(Math.max(0, earliest)) : new Date(bounds.start);
  const end = bounds.end;
  const hours = days === 1;
  const duration = Math.max(86400000, end - 1 - start.getTime());
  const bucketMs = hours ? 3600000 : Math.ceil(duration / 86400000 / 24) * 86400000;
  const length = hours ? 24 : Math.max(1, Math.ceil(duration / bucketMs));
  const buckets = new Map();
  for (let i = 0; i < length; i++) buckets.set(i, {
    date: new Date(start.getTime() + i * bucketMs).toISOString().slice(0, 10),
    count: 0, value: 0
  });
  for (const order of source) {
    const at = Date.parse(order?.checkoutAt || '');
    if (!Number.isFinite(at) || at < start.getTime() || at >= end) continue;
    // A purchase made exactly at the end of a period belongs to its last bar.
    const index = Math.min(length - 1, Math.floor((at - start.getTime()) / bucketMs));
    const bucket = buckets.get(index);
    if (bucket && shippingStage(order) !== 'cancelled') { bucket.count++; bucket.value += customerOrderValue(order); }
  }
  return [...buckets.values()];
}
