import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import webpush from "web-push";
import {createNotificationDeliveryGuard} from "./notification-delivery-guard.js";

const shippingLabels = { shipped: "Shipped", in_transit: "In transit", out_for_delivery: "Out for delivery", delivered: "Delivered" };
export function cancelledOrder(record) {
  return Boolean(record?.cancelledAt || record?.canceledAt || record?.cancelled === true || record?.canceled === true ||
    /cancel|refund|failed|declined/i.test(String(record?.status || "")));
}
// Early cancellations are filtered entirely from customer tracking and alerts.
// Exactly 24 hours after checkout is the first visible cancellation moment.
// Missing, ambiguous, or impossible event timestamps are not guessed.
export function lateCancellation(record) {
  if (!cancelledOrder(record)) return false;
  const placed = Date.parse(record?.checkoutAt || "");
  const cancelled = Date.parse(record?.cancelledAt || record?.canceledAt || "");
  return Number.isFinite(placed) && Number.isFinite(cancelled) &&
    cancelled - placed >= 24 * 60 * 60 * 1000 && cancelled <= Date.now() + 60 * 1000;
}
export function orderKey(record) {
  return `${record.customerAccountId}:${String(record.retailer || "").toLowerCase()}:${record.id}`;
}
export function orderSnapshot(record) {
  const cancelled = cancelledOrder(record);
  return { eligible: !cancelled && /^(confirmed|success|successful|placed|paid|completed|shipped|delivered)$/i.test(record.status || ""),
    reviewHold: !cancelled && record.status === "review_hold",
    cancelled, shipping: JSON.stringify([record.shipping?.status || "", record.shipping?.estimatedDelivery || "", record.shipping?.trackingUrl || "", record.shipping?.trackingNumber || "", record.shipping?.events?.[0]?.status || "", record.shipping?.events?.[0]?.at || "", record.shipping?.events?.[0]?.location || ""]) };
}
export function orderEvents(record, previous) {
  const next = orderSnapshot(record);
  if (!record.customerAccountId || (!next.eligible && !next.reviewHold)) return [];
  const events = [];
  const retailer = String(record.retailer || "Retailer").slice(0, 50);
  const product = String(record.items?.[0]?.name || record.productName || "Your order").slice(0, 110);
  const orderNumber = record.orderNumber ? `Order #${String(record.orderNumber).slice(0, 50)}` : "Order placed";
  if (next.reviewHold) return previous?.reviewHold ? [] : [{
    kind: "order_review_hold",
    title: `${retailer} order on review hold`,
    message: `${product} • ${orderNumber} • Retailer may still cancel`,
    tab: "tracking"
  }];
  if (!previous || !previous.eligible) events.push({
    kind: "order_confirmed",
    title: `${retailer} order confirmed`,
    message: `${product} • ${orderNumber}`,
    tab: "success"
  });
  // Changing the ETA or receiving the same carrier stage again updates
  // tracking, but must not generate another "shipped" push notification.
  let previousStage = null;
  try { previousStage = JSON.parse(previous?.shipping || "[]")[0] || null; } catch {}
  if (shippingLabels[record.shipping?.status] && previousStage !== record.shipping.status) {
    const status = shippingLabels[record.shipping.status];
    events.push({
      kind: "shipping_update",
      title: `${retailer} order ${status.toLowerCase()}`,
      message: `${product} • ${orderNumber}${record.shipping?.events?.[0]?.source === "carrier_api" ? ` • ${String(record.shipping.events[0].status || "").slice(0, 90)}${record.shipping.events[0].location ? ` (${String(record.shipping.events[0].location).slice(0, 60)})` : ""}` : ""}${record.shipping.estimatedDelivery ? ` • Est. delivery ${String(record.shipping.estimatedDelivery).slice(0, 80)}` : ""}`,
      tab: "success"
    });
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

export const notificationDefaults = { orders: true, shipping: true, messages: true, account: true, drops: true };
export function notificationCategory(event) {
  if (["order_confirmed", "order_cancelled", "order_review_hold"].includes(event.kind)) return "orders";
  if (event.kind === "shipping_update") return "shipping";
  if (event.kind === "drop_skus_updated") return "drops";
  if (/admin_message|missing|action_needed|setup_complete/.test(event.kind || "")) return "messages";
  return "account";
}
export function accountNoticeFingerprint(event) {
  return 'content:' + JSON.stringify([event.kind, event.title, event.message, [...(event.missingItems || [])].sort()]);
}
export function createOrderNotifications({ dataDir, baseUrl, getRecords, getAccounts, getAccountUpdates = async () => [], sendPush = webpush.sendNotification.bind(webpush) }) {
  const storePath = path.join(dataDir, "app-order-notifications.json");
  const keysPath = path.join(dataDir, "app-push-vapid.json");
  const deliveryGuard = createNotificationDeliveryGuard({dataDir});
  let state;
  let keys;
  let queue = Promise.resolve();
  let running = false;
  let rerunRequested = false;
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
    if (!state.webhookOnlyNotificationsVersion) {
      // The old IMAP importer could have created checkout alerts for personal
      // purchases. Rebuild order snapshots from the verified store once and
      // clear legacy order/shipping notices without touching account notices.
      const verified = (await getRecords()).filter(record => record.customerAccountId);
      state.snapshots = Object.fromEntries(verified.map(record => [orderKey(record), orderSnapshot(record)]));
      const orderKinds = new Set(["order_confirmed", "shipping_update"]);
      for (const id of Object.keys(state.inbox || {})) {
        state.inbox[id] = (state.inbox[id] || []).filter(event => !orderKinds.has(event.kind));
      }
      state.outbox = (state.outbox || []).filter(event => !orderKinds.has(event.notification?.kind));
      state.webhookOnlyNotificationsVersion = 1;
      await save();
    }
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
    if (!notification.deliveryEventKey && key && notification.kind)
      notification.deliveryEventKey = key + ":" + notification.kind;
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
            enqueue(account.id, { ...notification, tab: "notifications",
              deliveryEventKey: "notice:" + account.id + ":" + notification.id + ":" + accountNoticeFingerprint(notification) });
          }
          if (previous.verified !== next.verified) {
            const event = { id: crypto.randomUUID(), kind: "account_update", title: "Account updated", message: next.verified ? "Your email is now verified." : "Please verify your account email.", createdAt: new Date().toISOString(), tab: "notifications" };
            (state.inbox[account.id] ||= []).push(event);
            event.deliveryEventKey = "account_verified:" + account.id + ":" + next.verified;
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
          event.deliveryEventKey = "membership:" + membership.id + ":" + next;
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
        const previous = state.snapshots[key];
        const next = orderSnapshot(record);
        // Retire checkout-confirmed or shipping alerts when the authoritative
        // hook changes to orange/unknown. Previously delivered pushes cannot
        // be recalled, but the in-app inbox and queued pushes must not lie.
        if (!next.cancelled && !next.eligible) {
          state.outbox = state.outbox.filter(item => item.key !== key ||
            !["order_confirmed", "shipping_update", ...(next.reviewHold ? [] : ["order_review_hold"])].includes(item.notification?.kind));
          state.inbox[record.customerAccountId] = (state.inbox[record.customerAccountId] || [])
            .filter(item => item.orderKey !== key ||
              !["order_confirmed", "shipping_update", ...(next.reviewHold ? [] : ["order_review_hold"])].includes(item.kind));
        }
        if (!next.cancelled && !next.eligible && !next.reviewHold) {
          state.snapshots[key] = next;
          continue;
        }
        if (next.eligible && previous?.cancelled) {
          state.outbox = state.outbox.filter(item => item.key !== key ||
            item.notification?.kind !== "order_cancelled");
          state.inbox[record.customerAccountId] = (state.inbox[record.customerAccountId] || [])
            .filter(item => item.orderKey !== key || item.kind !== "order_cancelled");
        }
        if (next.cancelled) {
          // Retract all pending confirmation/shipment pushes and stale notices.
          // Only a prior valid ACO success can produce a cancellation event.
          state.outbox = state.outbox.filter(item =>
            item.key !== key || item.notification?.kind === "order_cancelled");
          const inbox = state.inbox[record.customerAccountId] ||= [];
          state.inbox[record.customerAccountId] = inbox.filter(item =>
            item.orderKey !== key || item.kind === "order_cancelled");
          if ((previous?.eligible || previous?.reviewHold) && !previous.cancelled && lateCancellation(record) &&
              Date.now() - Date.parse(record.cancelledAt || record.canceledAt) < 24 * 60 * 60 * 1000) {
            const retailer = String(record.retailer || "Retailer").slice(0, 50);
            const product = String(record.items?.[0]?.name || "Your order").slice(0, 110);
            const refunded = /refund/i.test(String(record.status || ""));
            const event = {
              id: crypto.randomUUID(), kind: "order_cancelled",
              title: retailer + (refunded ? " order refunded" : " order cancelled"),
              message: product + (record.orderNumber ? " • Order #" + String(record.orderNumber).slice(0, 50) : ""),
              tab: "tracking", orderKey: key, deliveryEventKey:key + ":order_cancelled", createdAt: new Date().toISOString()
            };
            state.inbox[record.customerAccountId].push(event);
            enqueue(record.customerAccountId, event, key);
          }
          state.snapshots[key] = next;
          continue;
        }
        const checkoutAge = Date.now() - Date.parse(record.checkoutAt || "");
        const historic = !previous && Number.isFinite(checkoutAge) && checkoutAge > 24 * 60 * 60 * 1000;
        for (const event of orderEvents(record, previous)) {
          // A manually reviewed historical alias should update Success totals
          // without producing dozens of old "new order" pushes.
          if (historic && ["order_confirmed", "order_review_hold"].includes(event.kind)) continue;
          if (historic && event.kind === "shipping_update" &&
              Date.now() - Date.parse(record.shipping?.updatedAt || "") > 24 * 60 * 60 * 1000) continue;
          const notification = { ...event, orderKey: key, id: crypto.randomUUID(),
            deliveryEventKey:key + ":" + event.kind +
              (event.kind === "shipping_update" ? ":" + String(record.shipping?.status || "") : ""),
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
          const inbox = state.inbox[record.customerAccountId] ||= [];
          inbox.push(notification);
          if (inbox.length > 200) inbox.splice(0, inbox.length - 200);
          // Capture recipients when the event occurs; later subscribers receive only future events.
          enqueue(record.customerAccountId, notification, key);
        }
        state.snapshots[key] = next;
      }
      await save();
    });
  }
  async function tick() {
    // A new checkout may be saved while a previous delivery pass is still
    // sending pushes. Schedule an immediate second pass instead of making
    // that customer wait for the 30-second timer.
    if (running) { rerunRequested = true; return; }
    running = true;
    try {
      const records = await getRecords();
      await reconcile(records);
      const accounts = await getAccounts();
      await reconcileAccountEvents(accounts, await getAccountUpdates());
      const active = new Set(accounts.filter(account => !account.disabled).map(account => String(account.id)));
      const eligible = new Set(records.filter(record => orderSnapshot(record).eligible).map(orderKey));
      const cancelled = new Set(records.filter(lateCancellation).map(orderKey));
      const holds = new Set(records.filter(record => record.status === "review_hold" && !cancelledOrder(record)).map(orderKey));
      await locked(async () => {
        const pending = [];
        for (const item of state.outbox) {
          const validOrderState = !item.key || (item.notification.kind === "order_cancelled" ?
            cancelled.has(item.key) : item.notification.kind === "order_review_hold" ?
            holds.has(item.key) : eligible.has(item.key));
          if (!active.has(String(item.accountId)) || !validOrderState ||
              Date.now() - Date.parse(item.notification.createdAt) > 24 * 60 * 60 * 1000) continue;
          if ((state.preferences[item.accountId] || notificationDefaults)[notificationCategory(item.notification)] === false) continue;
          const subscription = (state.subscriptions[item.accountId] || []).find(sub => sub.endpoint === item.endpoint);
          if (!subscription) continue;
          let deliveryClaimed = false;
          try {
            // One provider attempt per logical event and subscribed device.
            const claim = await deliveryGuard.claim({
              channel:"push:customer",
              recipient:String(item.accountId) + ":" + item.endpoint,
              eventKey:item.notification.deliveryEventKey || item.notification.id
            });
            if (!claim.send) continue;
            deliveryClaimed = true;
            await sendPush(subscription, JSON.stringify({
              title:item.notification.title, body:item.notification.message,
              tag:item.key || item.notification.id, tab:item.notification.tab || "notifications"
            }), {TTL:3600, timeout:5000});
          } catch (error) {
            if ([404,410].includes(error.statusCode))
              state.subscriptions[item.accountId] = state.subscriptions[item.accountId].filter(sub=>sub.endpoint!==item.endpoint);
            // A ledger-write error may retry, but a provider failure after
            // the claim is ambiguous and must not spam this same device.
            if (!deliveryClaimed && ++item.attempts < 5) pending.push(item);
            console.error("App push delivery failed:", error.statusCode || error.code || "network_error");
          }
        }
        state.outbox = pending;
        await save();
      });
    } catch (error) { console.error("App order alerts:", error.code || error.name); }
    finally {
      running = false;
      if (rerunRequested) {
        rerunRequested = false;
        void tick();
      }
    }
  }
  return {
    initialize, reconcile, tick,
    // Record an announcement for every eligible account. A subscribed device
    // receives an app push; callers can DM members with no eligible push
    // subscription. Persist event IDs so reconnects and restarts never replay.
    notifyDropUpdate: (accountIds, notification, eventKey) => locked(async () => {
      if (!String(eventKey || "").startsWith("drop:") || notification?.kind !== "drop_skus_updated") {
        throw new Error("Invalid drop announcement");
      }
      state.dropAnnouncements ||= {};
      state.inbox ||= {};
      const pushAccountIds = [];
      const dmAccountIds = [];
      const now = new Date().toISOString();
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      for (const [key, timestamp] of Object.entries(state.dropAnnouncements)) {
        if (!Number.isFinite(Date.parse(timestamp)) || Date.parse(timestamp) < cutoff) {
          delete state.dropAnnouncements[key];
        }
      }
      for (const accountId of new Set((Array.isArray(accountIds) ? accountIds : [])
        .map(value => String(value || "").trim()).filter(Boolean))) {
        const key = eventKey + ":" + accountId;
        if (state.dropAnnouncements[key]) continue;
        const event = {
          ...notification, id: crypto.randomUUID(), createdAt: now, updatedAt: now
        };
        // Keep one actionable in-app notice and pending push per drop post.
        // A meaningful edit replaces a still-queued previous SKU version.
        state.outbox = state.outbox.filter(item =>
          String(item.accountId) !== accountId ||
          item.notification?.kind !== "drop_skus_updated" ||
          item.notification?.sourceUrl !== notification.sourceUrl);
        const inbox = state.inbox[accountId] ||= [];
        state.inbox[accountId] = inbox.filter(item =>
          item.kind !== "drop_skus_updated" || item.sourceUrl !== notification.sourceUrl);
        const currentInbox = state.inbox[accountId];
        currentInbox.push(event);
        if (currentInbox.length > 200) currentInbox.splice(0, currentInbox.length - 200);
        const prefs = { ...notificationDefaults, ...state.preferences[accountId] };
        if (prefs.drops && (state.subscriptions[accountId] || []).length) {
          // key=null means this is not an order and must not be subjected to
          // confirmed-checkout validation by the order delivery loop.
          event.deliveryEventKey = key;
          enqueue(accountId, event);
          pushAccountIds.push(accountId);
        } else if (prefs.drops) {
          dmAccountIds.push(accountId);
        }
        state.dropAnnouncements[key] = now;
      }
      await save();
      return { pushAccountIds, dmAccountIds };
    }),
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
