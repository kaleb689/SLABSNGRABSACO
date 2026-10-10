// Isolated app demonstration. These records never enter production account,
// payment, checkout, shipping, IMAP, or Discord stores.
export const DEMO_ID = 'APP-DEMO-CUSTOMER';
export const demoLogin = { email: 'app-demo@slabsngrabsaco.com', passwordSalt: '0b03a1bb977b53ba05f4cc7075d4abcb', passwordHash: '4dc4d7d5ffd7790bad2e40aabfaa56db16536c7bb81186cc33f4687249427bc6c273b6fa300a07e1fae00610f83251160426cc23f9627b7b443146d19ec4e62e' };

export function demoAccount() {
  return { id: DEMO_ID, email: demoLogin.email, demo: true, sessionVersion: 1,
    emailVerified: true, emailVerifiedAt: '2026-09-01T12:00:00Z', createdAt: '2026-09-01T12:00:00Z',
    discordUsername: 'DemoCustomer', checkoutOnboardingComplete: true,
    imapOnboardingCompletedAt: '2026-09-01T12:00:00Z' };
}

export function buildDemoData(now = new Date()) {
  const date = days => new Date(now.getTime() + days * 86400000).toISOString();
  const address = { id: 'demo-address', label: 'Demo home — fictional', firstName: 'Demo', lastName: 'Customer',
    name: 'Demo Customer', address: '123 Sample Street', address2: 'Apt 4', city: 'New York', state: 'NY', zip: '10001', country: 'US', phone: '2025550147' };
  const card = { id: 'demo-card', cardLabel: 'Demo Visa — test card', cardholder: 'Demo Customer',
    acoCardNumber: '4242424242424242', maskedNumber: '•••• •••• •••• 4242', expMonth: '12', expYear: '2030', cvv: '123' };
  const imap = { id: 'demo-imap', label: 'Demo mailbox', email: 'demo-mailbox@example.invalid', appPassword: 'abcd efgh ijkl mnop', passwordConfigured: true,
    connectionStatus: { connected: true, demo: true } };
  const customerProfile = { ...address, email: 'demo-mailbox@example.invalid', imapEmail: imap.email, imapAppPassword: imap.appPassword };
  const membership = { tier: 8, name: 'Ultimate', planName: 'Ultimate', amount: 800, profiles: 100, status: 'active', activationStatus: 'activated',
    currentPeriodStart: date(-8), currentPeriodEnd: date(22), subscriptionEndDate: date(22), cancelAtPeriodEnd: false };
  const orders = [{ ...membership, id: 'demo-membership', orderNumber: 'DEMO-MEMBER-1001', paidAt: date(-8),
    plan: { tier: 8, name: 'Ultimate', profiles: 100, amount: 800 }, profile: customerProfile,
    customerProfile, customerCard: card, activationStatus: 'activated', activationLabel: 'Active' }];
  const profiles = Array.from({ length: 100 }, (_, i) => ({ id: `demo-profile-${i + 1}`, slot: i + 1,
    profileName: `Demo profile ${i + 1}`, locked: false, customerProfile, customerCard: card,
    retailers: Object.fromEntries(['target', 'walmart', 'pokemoncenter'].map(retailer => [retailer,
      { username: `demo-${i + 1}@example.invalid`, password: 'DemoRetailerOnly123!', passwordConfigured: true }])),
    readiness: { ready: true, shippingReady: true, cardReady: true, missing: [] },
    activationStatus: 'activated', activationLabel: 'Active', activatedAt: date(-7) }));
  const stages = ['confirmed', 'shipped', 'in_transit', 'out_for_delivery', 'delivered', 'delivered'];
  const retailers = ['Target', 'Walmart', 'Pokemon Center'];
  const names = ['Pokémon Paldean Fates Booster Bundle', 'Pokémon Trading Card Tin', 'Pokémon Elite Trainer Box'];
  const checkouts = stages.map((stage, i) => {
    const quantity = i % 3 + 1, price = [29.99, 24.99, 49.99][i % 3];
    return { id: `demo-checkout-${i + 1}`, customerAccountId: DEMO_ID, retailer: retailers[i % 3],
      orderNumber: `DEMO-ORDER-${1001 + i}`, checkoutAt: date(-i * 2), status: 'confirmed',
      itemCount: quantity, orderTotal: Math.round(quantity * price * 100) / 100,
      orderTotalKnown: true, orderTotalBasis: 'order_total',
      items: [{ name: names[i % 3], quantity, price, imageUrl: '/demo-product.svg' }],
      shipping: { status: stage === 'confirmed' ? 'awaiting_shipment' : stage, carrier: 'Demo carrier',
        trackingNumber: `DEMO-TRACK-${1001 + i}`, estimatedDelivery: stage === 'delivered' ? date(-1).slice(0, 10) : date(3).slice(0, 10),
        address, shippedAt: stage === 'confirmed' ? null : date(-2), updatedAt: date(0) } };
  });
  const notifications = [
    ['order_confirmed', 'Demo order confirmed', 'Your sample Target order was placed successfully.'],
    ['shipping_update', 'Demo package in transit', 'Your sample package is in transit. Estimated delivery is in 3 days.'],
    ['admin_message', 'Demo owner message', 'This is where messages from SLABSNGRABSACO appear.'],
    ['account_update', 'Demo account ready', 'Your Ultimate tier and all 100 sample profiles are active.']
  ].map(([kind, title, message], i) => ({ id: `demo-note-${i}`, kind, title, message, createdAt: date(-i), tab: kind === 'shipping_update' ? 'success' : 'notifications' }));
  return { account: demoAccount(), membership, orders, profiles, address, card, imap, checkouts, notifications };
}

export function demoSuccess(data, query = {}) {
  const start = String(query.start || ''), end = String(query.end || '');
  const records = data.checkouts.filter(order => (!start || order.checkoutAt.slice(0, 10) >= start) && (!end || order.checkoutAt.slice(0, 10) <= end));
  const days = new Map();
  for (const order of records) {
    const key = order.checkoutAt.slice(0, 10), day = days.get(key) || { date: key, count: 0, value: 0 };
    day.count++; day.value += order.orderTotal; days.set(key, day);
  }
  return { ok: true, sync: { status: 'Demo data — sample orders', lastSyncedAt: new Date().toISOString() },
    summary: { totalCheckouts: records.length, totalItems: records.reduce((sum, r) => sum + r.itemCount, 0),
      checkoutValue: Math.round(records.reduce((sum, r) => sum + r.orderTotal, 0) * 100) / 100,
      bestDay: Math.max(0, ...[...days.values()].map(day => day.count)) },
    activity: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)), recentCheckouts: records, checkouts: records };
}

export function createDemoMiddleware({ authenticate, verifyPassword, setSession, clearSession, loginRateLimit, sendTestNotification }) {
  const data = buildDemoData();
  const listeners = new Set();
  const emit = () => { for (const res of listeners) res.write('event: data-change\ndata: {}\n\nevent: checkout\ndata: {}\n\n'); };
  return async function demoMiddleware(req, res, next) {
    try {
      if (req.path === '/api/account/register' && String(req.body?.email || '').trim().toLowerCase() === demoLogin.email) {
        return res.status(409).json({ error: 'This email is reserved for the demo login.' });
      }
      if (req.path === '/api/account/login' && req.method === 'POST' && String(req.body?.email || '').trim().toLowerCase() === demoLogin.email) {
        return loginRateLimit(req, res, async () => {
          try {
            if (!await verifyPassword(String(req.body?.password || ''), demoLogin)) return res.status(401).json({ error: 'Incorrect email or password.' });
            setSession(res, demoAccount());
            res.set('Cache-Control', 'no-store');
            res.json({ ok: true, account: demoAccount(), message: 'Signed in to your demo account.' });
          } catch (error) { next(error); }
        });
      }
      if (!req.path.startsWith('/api/')) return next();
      const account = await authenticate(req);
      if (account?.id !== DEMO_ID) return next();
      res.set('Cache-Control', 'no-store');
      if (/^\/api\/account\/push-(preferences|key|subscriptions)$/.test(req.path)) return next();
      if (req.path === '/api/account/logout' && req.method === 'POST') { clearSession(res); return res.json({ ok: true }); }
      if (req.path === '/api/account/demo/simulate' && req.method === 'POST') {
        const shipping = req.body?.event === 'shipping';
        if (!shipping && req.body?.event !== 'order') return res.status(400).json({ error: 'Choose order or shipping.' });
        const createdAt = new Date().toISOString();
        if (shipping) {
          const order = data.checkouts[0];
          const stages = ['awaiting_shipment', 'shipped', 'in_transit', 'out_for_delivery', 'delivered'];
          order.shipping.status = stages[(stages.indexOf(order.shipping.status) + 1) % stages.length];
          order.shipping.updatedAt = createdAt;
        } else {
          data.checkouts.unshift({ ...structuredClone(data.checkouts[0]), id: `demo-${Date.now()}`, orderNumber: `DEMO-${Date.now()}`,
            checkoutAt: createdAt, shipping: { ...data.checkouts[0].shipping, status: 'awaiting_shipment' } });
          data.checkouts = data.checkouts.slice(0, 30);
        }
        const note = { id: `demo-note-${Date.now()}`, kind: shipping ? 'shipping_update' : 'order_confirmed',
          title: shipping ? 'Demo shipping update' : 'Demo order confirmed',
          message: shipping ? `Sample package: ${data.checkouts[0].shipping.status.replaceAll('_', ' ')}.` : 'A new sample order was placed successfully.', createdAt, tab: 'success' };
        data.notifications.unshift(note); data.notifications = data.notifications.slice(0, 30);
        emit();
        const delivery = await sendTestNotification(DEMO_ID, note);
        return res.json({ ok: true, message: `${note.message} Phone alerts sent to ${delivery.sent} enabled device(s).` });
      }
      if (req.path === '/api/account/notifications' && req.method === 'DELETE') { data.notifications = []; return res.json({ ok: true }); }
      if (!['GET', 'HEAD'].includes(req.method)) return res.status(403).json({ error: 'Demo account: sample information is read-only. Real purchases and external changes are disabled.' });
      if (req.path === '/api/my-profile') return res.json({ ok: true, account: data.account, membership: data.membership,
        orders: data.orders, profileAllowance: 100, accountStats: { userSince: data.account.createdAt, displayName: 'Demo Customer', ogMember: false,
          lifetimeSpend: 800, totalOrders: data.orders.length } });
      if (req.path === '/api/account/session') return res.json({ authenticated: true, account: data.account });
      if (req.path === '/api/discord/oauth/start') return res.status(403).json({ error: 'Discord linking is disabled for the fictional demo account.' });
      if (req.path === '/api/account/saved-details') return res.json({ addresses: [data.address], paymentMethods: [data.card] });
      if (req.path === '/api/account/imap-credentials') return res.json({ entries: [data.imap] });
      if (req.path === '/api/account/retailer-profiles') return res.json({ ok: true, allowance: 100, profiles: data.profiles, specialProfiles: [] });
      if (/^\/api\/account\/(free|rented)-memberships$/.test(req.path)) return res.json({ memberships: [] });
      if (req.path === '/api/managed-availability') return res.json({ target: { available: 0 }, walmart: { available: 0 }, pokemoncenter: { available: 0 } });
      if (req.path === '/api/account/notifications') return res.json({ notifications: data.notifications,
        checklist: ['Shipping address', 'Payment card', 'Retailer login', 'IMAP credentials'].map(label => ({ label, complete: true })) });
      if (req.path === '/api/account/success') return res.json(demoSuccess(data, req.query));
      if (['/api/account/live/events', '/api/account/success/events'].includes(req.path)) {
        res.set({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.flushHeaders(); res.write(': demo connected\n\n'); listeners.add(res);
        const timer = setInterval(() => res.write(': keep-alive\n\n'), 25000); timer.unref?.();
        req.on('close', () => { clearInterval(timer); listeners.delete(res); }); return;
      }
      if (req.path.startsWith('/api/account/')) return res.status(403).json({ error: 'This action is unavailable in the demo account.' });
      next();
    } catch (error) { next(error); }
  };
}
