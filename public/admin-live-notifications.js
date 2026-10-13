// Client-side Admin change feed. No credentials, addresses, or order numbers are stored.
(() => {
  "use strict";
  const KEY = "sng-admin-live-notifications-v1";
  const MAX_HISTORY = 70;
  const MAX_AGE = 30 * 86400000;
  const $ = id => document.getElementById(id);
  const safe = value => String(value ?? "").replace(/[&<>"']/g, c =>
    ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const short = (value, len=100) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, len);
  let signedIn = false, snapshot = null, currentToast = null, toastTimer = null;
  let trayOpen = false, toastQueue = [], shown = [];
  let tasks = new Map(), dismissed = new Set(), history = [];
  try {
    const saved = JSON.parse(window.localStorage?.getItem(KEY) || "{}");
    const now = Date.now();
    history = (Array.isArray(saved.history) ? saved.history : []).filter(item =>
      item && item.kind === "activity" && typeof item.title === "string" &&
      Number.isFinite(item.at) && item.at <= now && now - item.at < MAX_AGE
    ).slice(0, MAX_HISTORY);
    dismissed = new Set((Array.isArray(saved.dismissed) ? saved.dismissed : [])
      .filter(x => typeof x === "string" && x.length < 300).slice(0, 200));
  } catch { /* Private browsing and disabled storage still support an in-memory tray. */ }
  function save() {
    try { window.localStorage?.setItem(KEY, JSON.stringify({
      history:history.slice(0, MAX_HISTORY), dismissed:[...dismissed].slice(0, 200)
    })); } catch {}
  }
  function profiles(source) {
    const result = new Map();
    for (const person of (Array.isArray(source?.activation?.customers) ? source.activation.customers : [])) {
      for (const profile of (Array.isArray(person.profiles) ? person.profiles : [])) {
        if (profile?.type !== "paid") continue;
        const id = String(profile.id || [profile.retailer, profile.slot, profile.profileName].join(":"));
        const key = "activation:" + String(person.customerAccountId || person.accountId || person.id || "") + ":" + id;
        result.set(key, {
          key, status:short(profile.status, 40),
          name:short(person.name || person.customerName || person.profileName || "Customer", 60),
          retailer:short(profile.retailer || "Profile", 30),
          slot:short(profile.slot || "", 10)
        });
      }
    }
    return result;
  }
  function roster(source) {
    const map = new Map();
    const paid = Array.isArray(source?.customers) ? source.customers : source?.customers?.submissions || [];
    for (const person of [...(Array.isArray(source?.registered) ? source.registered : []),
      ...(Array.isArray(paid) ? paid : [])]) {
      if (!person || typeof person !== "object") continue;
      const id = String(person.customerAccountId || person.accountId ||
        person.profile?.email || person.email || person.id || "");
      if (!id) continue;
      map.set(id, short([person.profile?.firstName,person.profile?.lastName].filter(Boolean).join(" ") ||
        person.profile?.profileName || person.customerName || "New customer", 65));
    }
    return map;
  }
  function checkouts(source) {
    const map = new Map();
    const records = Array.isArray(source?.success?.records) ? source.success.records : [];
    for (const record of records.slice(-150)) {
      const key = String(record.id || record.orderId || record.checkoutId || "");
      if (!key) continue;
      const first = Array.isArray(record.items) ? record.items[0] : null;
      map.set(key, {
        retailer:short(record.retailer || "Retailer", 28),
        product:short(first?.name || record.productName || "Confirmed checkout", 85)
      });
    }
    return map;
  }
  function capture(source) {
    return {
      profiles:profiles(source), customers:roster(source), orders:checkouts(source),
      totalOrders:Number(source?.success?.communityTotals?.totalCheckouts),
      totalSpent:Number(source?.success?.communityTotals?.totalSpent),
      activeMemberships:Number(source?.billing?.activePaidMemberships)
    };
  }
  function taskText(profile) {
    return profile.name + " · " + profile.retailer +
      (profile.slot ? " #" + profile.slot : "");
  }
  function displayItems() {
    const action = [...tasks.values()].filter(x => !dismissed.has(x.key))
      .map(x => ({id:x.key, kind:"task", title:"Profile awaiting activation",
        detail:taskText(x), at:0}));
    return [...action, ...history].sort((a,b) => (a.kind === "task" ? 1 : 0) ===
      (b.kind === "task" ? 1 : 0) ? b.at - a.at : a.kind === "task" ? -1 : 1);
  }
  function mount() {
    if ($("sng-admin-live-bell")) return;
    const header = document.querySelector("body > header");
    if (!header) return;
    const button = document.createElement("button");
    button.type = "button";
    button.id = "sng-admin-live-bell";
    button.title = "Notifications";
    button.setAttribute("aria-label", "Notifications");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", "sng-admin-live-tray");
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg><span id="sng-admin-live-count" hidden>0</span>';
    header.insertBefore(button, $("refresh"));
    const tray = document.createElement("section");
    tray.id = "sng-admin-live-tray";
    tray.hidden = true;
    tray.setAttribute("aria-label", "Admin notifications");
    tray.innerHTML = '<div class="sng-live-tray-head"><div><strong>Notifications</strong><small>Live updates and tasks needing action</small></div><button type="button" data-close-tray aria-label="Close notifications">×</button></div><div class="sng-live-tray-actions"><button type="button" data-clear-all>CLEAR ALL</button></div><div id="sng-admin-live-items" class="sng-live-items"></div>';
    document.body.append(tray);
    const toast = document.createElement("aside");
    toast.id = "sng-admin-live-toast";
    toast.hidden = true;
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.append(toast);
    button.addEventListener("click", () => setTray(!trayOpen));
    tray.addEventListener("click", event => {
      if (event.target.closest("[data-close-tray]")) { setTray(false); return; }
      if (event.target.closest("[data-clear-all]")) {
        for (const key of tasks.keys()) dismissed.add(key);
        history = [];
        save(); render(); return;
      }
      const close = event.target.closest("[data-dismiss]");
      if (close) {
        const item = shown[Number(close.dataset.dismiss)];
        if (!item) return;
        if (item.kind === "task") dismissed.add(item.id);
        else history = history.filter(x => x.id !== item.id);
        save(); render(); return;
      }
      if (event.target.closest("[data-open-task]")) {
        setTray(false);
        document.querySelector('[data-tab="profiles"]')?.click();
      }
    });
    toast.addEventListener("click", event => {
      if (event.target.closest("[data-close-toast]")) endToast();
    });
    document.addEventListener("pointerdown", event => {
      if (trayOpen && !tray.contains(event.target) && !button.contains(event.target)) setTray(false);
    }, true);
    document.addEventListener("keydown", event => {
      if (trayOpen && event.key === "Escape") { setTray(false); button.focus(); }
    });
  }
  function setTray(open) {
    trayOpen = Boolean(open && signedIn);
    const tray = $("sng-admin-live-tray");
    if (tray) tray.hidden = !trayOpen;
    $("sng-admin-live-bell")?.setAttribute("aria-expanded", String(trayOpen));
    if (trayOpen) render();
  }
  function render() {
    if (!signedIn) return;
    mount();
    const items = displayItems();
    shown = items;
    const badge = $("sng-admin-live-count");
    const button = $("sng-admin-live-bell");
    if (badge) {
      badge.textContent = items.length > 99 ? "99+" : String(items.length);
      badge.hidden = items.length === 0;
    }
    if (button) button.setAttribute("aria-label", "Notifications, " + items.length + " updates");
    const list = $("sng-admin-live-items");
    if (list) list.innerHTML = items.length ? items.map((item,i) =>
      '<article class="sng-live-item'+(item.kind === "task" ? " sng-live-task" : "")+'">' +
      '<div class="sng-live-copy"><strong>'+safe(item.title)+'</strong><p>'+safe(item.detail)+'</p>'+
      (item.at ? '<time>'+safe(new Date(item.at).toLocaleString())+'</time>' : '<small>Action needed</small>')+
      '</div><div class="sng-live-item-actions">'+
      (item.kind === "task" ? '<button type="button" data-open-task>VIEW</button>' : "")+
      '<button type="button" data-dismiss="'+i+'" aria-label="Clear this notification">×</button></div></article>'
    ).join("") : '<p class="sng-live-empty">You’re all caught up. No notifications.</p>';
    const clear = $("sng-admin-live-tray")?.querySelector("[data-clear-all]");
    if (clear) clear.disabled = items.length === 0;
  }
  function endToast() {
    clearTimeout(toastTimer);
    currentToast = null;
    const toast = $("sng-admin-live-toast");
    if (toast) toast.hidden = true;
    if (toastQueue.length && signedIn) showNextToast();
  }
  function showNextToast() {
    if (!signedIn || currentToast || !toastQueue.length) return;
    mount();
    currentToast = toastQueue.shift();
    const toast = $("sng-admin-live-toast");
    if (!toast) { currentToast = null; return; }
    toast.innerHTML = '<div><strong>'+safe(currentToast.title)+'</strong><p>'+safe(currentToast.detail)+'</p>'+
      '<small>Saved to notifications</small></div><button type="button" data-close-toast aria-label="Dismiss update">×</button>';
    toast.hidden = false;
    toastTimer = setTimeout(endToast, 10000);
  }
  function add(title, detail, kind="activity", taskKey="") {
    const item = {
      id:kind === "task" ? taskKey : "evt:" + Date.now() + ":" + Math.random().toString(36).slice(2),
      kind, title:short(title, 90), detail:short(detail, 190), at:Date.now()
    };
    if (kind === "activity") {
      history.unshift(item);
      history = history.slice(0, MAX_HISTORY);
      save();
    }
    // Large batch updates should not queue minutes of stale popups.
    if (toastQueue.length < 5) toastQueue.push(item);
  }
  function apply(source) {
    if (!signedIn || !source) return;
    const next = capture(source);
    const currentTasks = new Map([...next.profiles].filter(([,p]) => p.status === "awaiting_activation"));
    // Resolved tasks disappear automatically, even when previously dismissed.
    for (const key of dismissed) if (!currentTasks.has(key)) dismissed.delete(key);
    tasks = currentTasks;
    if (snapshot) {
      for (const [key,profile] of next.profiles) {
        const previous = snapshot.profiles.get(key);
        if (!previous && profile.status === "awaiting_activation") add("Profile needs activation", taskText(profile));
        else if (previous && previous.status !== profile.status) {
          const title = profile.status === "activated" ? "Profile activated" :
            profile.status === "awaiting_activation" ? "Profile awaiting activation" : "Profile status changed";
          add(title, taskText(profile) + " · " + short(previous.status,30) + " → " + profile.status);
        }
      }
      for (const [id,name] of next.customers) if (!snapshot.customers.has(id))
        add("New customer registered", name);
      const added = [...next.orders].filter(([id]) => !snapshot.orders.has(id));
      if (added.length > 4) add("New confirmed checkouts", added.length + " checkout records received");
      else for (const [,order] of added)
        add("New " + order.retailer + " checkout", order.product);
      if (Number.isFinite(next.totalSpent) && Number.isFinite(snapshot.totalSpent) &&
          next.totalSpent !== snapshot.totalSpent && !added.length)
        add("Checkout total updated", "Reported total changed from " +
          snapshot.totalSpent.toLocaleString("en-US",{style:"currency",currency:"USD"}) + " to " +
          next.totalSpent.toLocaleString("en-US",{style:"currency",currency:"USD"}));
      if (Number.isFinite(next.activeMemberships) && Number.isFinite(snapshot.activeMemberships) &&
          next.activeMemberships !== snapshot.activeMemberships)
        add("Paid memberships updated",
          snapshot.activeMemberships + " → " + next.activeMemberships + " active memberships");
    }
    snapshot = next;
    save();
    render();
    showNextToast();
  }
  function setAuthenticated(value) {
    signedIn = Boolean(value);
    if (!signedIn) {
      snapshot = null; tasks.clear(); toastQueue = [];
      clearTimeout(toastTimer); currentToast = null;
      if ($("sng-admin-live-toast")) $("sng-admin-live-toast").hidden = true;
      setTray(false);
      if ($("sng-admin-live-bell")) $("sng-admin-live-bell").hidden = true;
      return;
    }
    mount();
    if ($("sng-admin-live-bell")) $("sng-admin-live-bell").hidden = false;
    render();
  }
  window.AdminLiveNotifications = {setAuthenticated, apply, close:() => setTray(false), open:() => setTray(true)};
})();