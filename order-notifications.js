import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import webpush from "web-push";

const shippingLabels = { shipped: "Shipped", in_transit: "In transit", out_for_delivery: "Out for delivery", delivered: "Delivered" };
export function cancelledOrder(record) {
  return Boolean(record?.cancelledAt || record?.canceledAt || record?.cancelled === true || record?.canceled === true ||
    /cancel|refund|failed|declined/i.test(String(record?.status || "")));
}
export function orderKey(record) {
  return `${record.customerAccountId}:${String(record.retailer || "").toLowerCase()}:${record.orderNumber || record.id}`;
}
export function orderSnapshot(record) {
  return { eligible: !cancelledOrder(record) && /^(confirmed|success|successful|placed|paid|completed|shipped|delivered)$/i.test(record.status || "confirmed"),
    shipping: JSON.stringify([record.shipping?.status || "", record.shipping?.estimatedDelivery || "", record.shipping?.trackingUrl || ""]) };
}
export function orderEvents(record, previous) {
  const next = orderSnapshot(record);
  if (!record.customerAccountId || !next.eligible) return [];
  const events = [];
  const label = `${String(record.retailer || "Retailer").slice(0, 80)} order${record.orderNumber ? ` #${String(record.orderNumber).slice(0, 80)}` : ""}`;
  if (!previous || !previous.eligible) events.push({ kind: "order_confirmed", title: "Order confirmed", message: `${label} was placed successfully.`, tab: "success" });
  if (shippingLabels[record.shipping?.status] && (!previous || !previous.eligible || previous.shipping !== next.shipping)) {
    events.push({ kind: "shipping_update", title: shippingLabels[record.shipping.status],
      message: `${label}: ${shippingLabels[record.shipping.status].toLowerCase()}.${record.shipping.estimatedDelivery ? ` Estimated delivery: ${String(record.shipping.estimatedDelivery).slice(0, 80)}.` : ""}`, tab: "success" });
  }
  return events;
}
export function validPushSubscription(value) {
  try {
    const endpoint = new URL(value?.endpoint);
    // Only browser push providers; customer input must never become an arbitrary server-side HTTP request.
    const host = endpoint.hostname;
    const allowed = host === "fcm.googleapis.com" || host === "android.googleapis.com" || host === "updates.push.services.mozilla.com" ||
      host === "web.push.apple.com" || host.endsWith(".push.apple.com") || host.endsWith(".notify.windows.com");
    return allowed && endpoint.protocol === "https:" && !endpoint.username && !endpoint.password && (!endpoint.port || endpoint.port === "443") &&
      endpoint.href.length < 2048 && /^[\w-]{87,88}={0,2}$/.test(value.keys?.p256dh || "") && /^[\w-]{22,24}={0,2}$/.test(value.keys?.auth || "");
  } catch { return false; }
}

export const notificationDefaults = { orders: true, shipping: true, messages: true, account: true };
export function notificationCategory(event) {
  if (event.kind === "order_confirmed") return "orders";
  if (event.kind === "shipping_update") return "shipping";
  if (/admin_message|missing|action_needed|setup_complete/.test(event.kind || "")) return "messages";
  return "account";
}
export function accountNoticeFingerprint(event) {
  return 'content:' + JSON.stringify([event.kind, event.title, event.message, [...(event.missingItems || [])].sort()]);
}
export function createOrderNotifications({ dataDir, baseUrl, getRecords, getAccounts, getAccountUpdates = async () => [], sendPush = webpush.sendNotification.bind(webpush) }) {
  const storePath = path.join(dataDir, "app-order-notifications.json");
  const keysPath = path.join(dataDir, "app-push-vapid.json");
  let state;
  let keys;
  let queue = Promise.resolve();
  let running = false;
  const locked = operation => { const result = queue.then(operation); queue = result.catch(() => {}); return result; };
  async function save() {
    const temp = `${storePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(temp, storePath);
  }
  async function initialize() {
    await fs.mkdir(dataDir, { recursive: true });
    try { keys = JSON.parse(await fs.readFile(keysPath, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      keys = webpush.generateVAPIDKeys();
      await fs.writeFile(keysPath, JSON.stringify(keys), { mode: 0o600, flag: "wx" });
    }
    webpush.setVapidDetails(new URL(baseUrl).protocol === "https:" ? new URL(baseUrl).origin : "https://slabsngrabsaco.com", keys.publicKey, keys.privateKey);
    try { state = JSON.parse(await fs.readFile(storePath, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      state = { snapshots: {}, inbox: {}, subscriptions: {}, outbox: [] };
      // First rollout establishes a baseline; historical orders do not trigger a flood of alerts.
      for (const record of await getRecords()) if (record.customerAccountId) state.snapshots[orderKey(record)] = orderSnapshot(record);
      await save();
    }
    state.preferences ||= {};
    if (!state.accountEvents) {
      state.accountEvents = {};
      for (const account of await getAccounts()) state.accountEvents[account.id] = accountEventSnapshot(account);
      state.memberships = Object.fromEntries((await getAccountUpdates()).map(item => [item.id, membershipSnapshot(item)]));
      await save();
    }
  }
  function accountEventSnapshot(account) {
    return { notices: Object.fromEntries((account.notifications || []).map(event => [event.id, accountNoticeFingerprint(event)])),
      verified: Boolean(account.emailVerifiedAt), disabled: Boolean(account.disabled) };
  }
  function membershipSnapshot(item) {
    return JSON.stringify([item.plan?.tier || "", item.status || "", Boolean(item.cancelAtPeriodEnd), item.subscriptionEndDate || item.currentPeriodEnd || ""]);
  }
  function enqueue(accountId, notification, key = null) {
    for (const subscription of state.subscriptions[accountId] || []) {
      state.outbox.push({ accountId, key, endpoint: subscription.endpoint, notification, attempts: 0 });
    }
  }
  async function reconcileAccountEvents(accounts, memberships) {
    return locked(async () => {
      for (const account of accounts) {
        const previous = state.accountEvents[account.id];
        const next = accountEventSnapshot(account);
        if (previous) {
          for (const notification of account.notifications || []) {
            const old = previous.notices[notification.id];
            // Migrate old timestamp snapshots without replaying existing alerts.
            if (old === accountNoticeFingerprint(notification) || (old && !old.startsWith('content:'))) continue;
            enqueue(account.id, { ...notification, tab: "notifications" });
          }
          if (previous.verified !== next.verified) {
            const event = { id: crypto.randomUUID(), kind: "account_update", title: "Account updated", message: next.verified ? "Your email is now verified." : "Please verify your account email.", createdAt: new Date().toISOString(), tab: "notifications" };
            (state.inbox[account.id] ||= []).push(event);
            enqueue(account.id, event);
          }
        }
        state.accountEvents[account.id] = next;
      }
      for (const membership of memberships) {
        if (!membership.customerAccountId) continue;
        const next = membershipSnapshot(membership);
        if (state.memberships[membership.id] !== next) {
          const event = { id: crypto.randomUUID(), kind: "account_update", title: "Membership updated", message: "Your membership details have changed. View your tier and account in My Profile.", createdAt: new Date().toISOString(), tab: "membership" };
          (state.inbox[membership.customerAccountId] ||= []).push(event);
          enqueue(membership.customerAccountId, event);
          state.memberships[membership.id] = next;
        }
      }
      for (const id of Object.keys(state.inbox)) state.inbox[id] = state.inbox[id].slice(-200);
      await save();
    });
  }
  async function reconcile(records) {
    return locked(async () => {
      if (!state) return;
      for (const record of records) {
        if (!record.customerAccountId) continue;
        const key = orderKey(record);
        for (const event of orderEvents(record, state.snapshots[key])) {
          const notification = { ...event, orderKey: key, id: crypto.randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
          const inbox = state.inbox[record.customerAccountId] ||= [];
          inbox.push(notification);
          if (inbox.length > 200) inbox.splice(0, inbox.length - 200);
          // Capture recipients when the event occurs; later subscribers receive only future events.
          enqueue(record.customerAccountId, notification, key);
        }
        state.snapshots[key] = orderSnapshot(record);
        if (cancelledOrder(record)) {
          state.outbox = state.outbox.filter(item => item.key !== key);
          state.inbox[record.customerAccountId] = (state.inbox[record.customerAccountId] || []).filter(item => item.orderKey !== key);
        }
      }
      await save();
    });
  }
  async function tick() {
    if (running) return;
    running = true;
    try {
      const records = await getRecords();
      await reconcile(records);
      const accounts = await getAccounts();
      await reconcileAccountEvents(accounts, await getAccountUpdates());
      const active = new Set(accounts.filter(account => !account.disabled).map(account => String(account.id)));
      const eligible = new Set(records.filter(record => orderSnapshot(record).eligible).map(orderKey));
      await locked(async () => {
        const pending = [];
        for (const item of state.outbox) {
          if (!active.has(String(item.accountId)) || (item.key && !eligible.has(item.key)) || Date.now() - Date.parse(item.notification.createdAt) > 24 * 60 * 60 * 1000) continue;
          if ((state.preferences[item.accountId] || notificationDefaults)[notificationCategory(item.notification)] === false) continue;
          const subscription = (state.subscriptions[item.accountId] || []).find(sub => sub.endpoint === item.endpoint);
          if (!subscription) continue;
          try {
            await sendPush(subscription, JSON.stringify({ title: item.notification.title, body: item.notification.message,
              tag: item.key || item.notification.id, tab: item.notification.tab || "notifications" }), { TTL: 3600, timeout: 5000 });
          } catch (error) {
            if ([404, 410].includes(error.statusCode)) state.subscriptions[item.accountId] = state.subscriptions[item.accountId].filter(sub => sub.endpoint !== item.endpoint);
            else if (++item.attempts < 5) pending.push(item);
            console.error("App push delivery failed:", error.statusCode || "network_error");
          }
        }
        state.outbox = pending;
        await save();
      });
    } catch (error) { console.error("App order alerts:", error.code || error.name); }
    finally { running = false; }
  }
  return {
    initialize, reconcile, tick,
    // The isolated demo uses the same subscriptions and category preferences,
    // without inserting fake records into the production order event queue.
    sendDemoNotification: (accountId, notification) => locked(async () => {
      if (accountId !== "APP-DEMO-CUSTOMER") throw new Error("Demo account required.");
      if ((state.preferences[accountId] || notificationDefaults)[notificationCategory(notification)] === false) return { sent: 0 };
      let sent = 0;
      for (const subscription of state.subscriptions[accountId] || []) {
        try {
          await sendPush(subscription, JSON.stringify({ title: notification.title, body: notification.message,
            tag: notification.id, tab: "success" }), { TTL: 300, timeout: 5000 });
          sent++;
        } catch (error) {
          if ([404, 410].includes(error.statusCode)) state.subscriptions[accountId] = state.subscriptions[accountId].filter(sub => sub.endpoint !== subscription.endpoint);
        }
      }
      await save();
      return { sent };
    }),
    publicKey: () => keys.publicKey,
    preferences: accountId => locked(() => ({ ...notificationDefaults, ...state.preferences[accountId] })),
    setPreferences: (accountId, input) => locked(async () => {
      const preferences = { ...notificationDefaults, ...state.preferences[accountId] };
      for (const key of Object.keys(notificationDefaults)) if (typeof input?.[key] === "boolean") preferences[key] = input[key];
      state.preferences[accountId] = preferences;
      await save();
      return preferences;
    }),
    list: accountId => locked(() => [...(state.inbox[accountId] || [])]),
    clear: accountId => locked(async () => { state.inbox[accountId] = []; await save(); }),
    subscribe: (accountId, subscription) => locked(async () => {
      if (!validPushSubscription(subscription)) throw new Error("Invalid browser push subscription.");
      for (const id of Object.keys(state.subscriptions)) state.subscriptions[id] = state.subscriptions[id].filter(sub => sub.endpoint !== subscription.endpoint);
      const owned = state.subscriptions[accountId] ||= [];
      if (owned.length >= 10) owned.shift();
      owned.push({ endpoint: subscription.endpoint, keys: { auth: subscription.keys.auth, p256dh: subscription.keys.p256dh } });
      await save();
    }),
    unsubscribe: (accountId, endpoint) => locked(async () => {
      state.subscriptions[accountId] = (state.subscriptions[accountId] || []).filter(sub => sub.endpoint !== endpoint);
      state.outbox = state.outbox.filter(item => !(String(item.accountId) === String(accountId) && item.endpoint === endpoint));
      await save();
    }),
    start: () => { const timer = setInterval(() => void tick(), 30_000); timer.unref?.(); }
  };
}
