(() => {
  if (window.self !== window.top || new URLSearchParams(location.search).get("successDemo") === "1") return;
  const installed = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const dashboard = document.getElementById("customer-dashboard");
  const installButton = document.getElementById("account-install-app");
  let installPrompt = null;
  let appInstalled = installed;
  let dialog = null;
  const signedIn = () => dashboard && !dashboard.hidden;
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {});
  }
  window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); installPrompt = event; });
  window.addEventListener("appinstalled", () => { appInstalled = true; installPrompt = null; dialog?.close(); sync(); });

  function showInstall() {
    if (!signedIn() || appInstalled || dialog) return;
    dialog = document.createElement("dialog");
    dialog.className = "pwa-install-dialog";
    dialog.setAttribute("aria-labelledby", "pwa-install-title");
    const heading = document.createElement("h2");
    heading.id = "pwa-install-title";
    heading.textContent = "Add app";
    const intro = document.createElement("p");
    intro.textContent = "Keep SLABSNGRABSACO on your Home Screen. Your tier, orders, shipments and notifications, together in one app.";
    const actions = document.createElement("div");
    actions.className = "account-onboarding-actions";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "primary";
    add.textContent = "Add to Home Screen";
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "secondary";
    skip.textContent = "Don’t add";
    const status = document.createElement("p");
    status.className = "fine";
    status.setAttribute("aria-live", "polite");
    add.addEventListener("click", async () => {
      if (installPrompt) {
        const prompt = installPrompt;
        installPrompt = null;
        add.disabled = true;
        try {
          await prompt.prompt();
          const choice = await prompt.userChoice;
          if (choice.outcome === "accepted") dialog?.close();
        } catch { status.textContent = "Open your browser menu and choose Install app or Add to Home Screen."; }
        finally { add.disabled = false; }
      } else {
        const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
        status.textContent = ios
          ? "On iPhone: tap Share → Add to Home Screen → Add. Turn on Open as Web App if shown."
          : /Android/.test(navigator.userAgent)
            ? "In Chrome, tap ⋮ → Install app or Add to Home Screen."
            : "Use your browser’s Install app option. In Safari on Mac, choose File → Add to Dock.";
      }
    });
    skip.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => { dialog.remove(); dialog = null; if (!installButton?.hidden) installButton?.focus(); });
    actions.append(add, skip);
    dialog.append(heading, intro, actions, status);
    document.body.append(dialog);
    dialog.showModal();
  }
  installButton?.addEventListener("click", showInstall);
  document.addEventListener("account-install-request", showInstall);

  const notificationSettings = document.getElementById("app-notification-settings");
  const notificationStatus = document.getElementById("app-notification-permission");
  const supportsPush = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  let settingsDialog = null;
  async function pushRequest(path, method = "GET", body) {
    const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store",
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to update notifications. Please try again.");
    return data;
  }
  function phoneSettingsText() {
    return /iPhone|iPad|iPod/.test(navigator.userAgent)
      ? "Open iPhone Settings → Notifications → SLABSNGRABSACO → Allow Notifications."
      : "Open your phone’s Settings → Apps → SLABSNGRABSACO or your browser → Notifications, and allow notifications.";
  }
  window.disconnectAccountPush = async () => {
    if (!supportsPush()) return;
    const registration = await navigator.serviceWorker.getRegistration("/");
    if (!registration) return;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    await pushRequest("/api/account/push-subscriptions", "DELETE", { endpoint: subscription.endpoint });
    await subscription.unsubscribe();
  };
  async function enablePush(status) {
    if (!supportsPush()) {
      status.textContent = "For phone notifications, add SLABSNGRABSACO to your Home Screen and open the app. Your account notifications are still available here.";
      return;
    }
    if (window.Notification.permission === "denied") { status.textContent = phoneSettingsText(); return; }
    // Permission is requested immediately from the button click, before network calls consume user activation.
    const permission = await window.Notification.requestPermission();
    if (permission !== "granted") { status.textContent = permission === "denied" ? phoneSettingsText() : "Notifications were not enabled. You can try again anytime."; return; }
    const config = await pushRequest("/api/account/push-key");
    const registration = await navigator.serviceWorker.getRegistration("/");
    if (!registration?.active) throw new Error("The app is still getting ready. Refresh and try enabling notifications again.");
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      const raw = atob(config.publicKey.replace(/-/g, "+").replace(/_/g, "/"));
      const key = Uint8Array.from(raw, char => char.charCodeAt(0));
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
    await pushRequest("/api/account/push-subscriptions", "POST", subscription.toJSON());
    status.textContent = "Notifications enabled on this device. Choose the alerts you want below.";
    if (notificationStatus) notificationStatus.textContent = "Phone notifications enabled. Manage your alerts in Notification Settings.";
  }
  async function openNotificationSettings(event) {
    if (!signedIn() || settingsDialog) return;
    settingsDialog = document.createElement("dialog");
    settingsDialog.className = "pwa-install-dialog app-notification-dialog";
    settingsDialog.setAttribute("aria-labelledby", "notification-settings-title");
    settingsDialog.innerHTML = `<h2 id="notification-settings-title">Notification Settings</h2>
      <p>Choose your alerts from SLABSNGRABSACO.</p>
      <p class="fine" data-push-status aria-live="polite">Loading your settings…</p>
      <div class="account-onboarding-actions"><button type="button" class="primary" data-enable-push>Enable phone notifications</button><button type="button" class="secondary" data-phone-settings>Phone settings help</button></div>
      <form><fieldset disabled><legend>Send me notifications for</legend>
        <label><input type="checkbox" name="orders"> Order confirmations</label>
        <label><input type="checkbox" name="shipping"> Shipping and delivery updates</label>
        <label><input type="checkbox" name="messages"> Messages and information needed</label>
        <label><input type="checkbox" name="account"> Account and membership updates</label>
        <button type="submit" class="primary">Save notification preferences</button></fieldset></form>
      <div class="account-onboarding-actions"><button type="button" class="text-button" data-disable-push>Disable on this device</button><button type="button" class="secondary" data-close-settings>Done</button></div>`;
    const current = settingsDialog;
    const opener = event.currentTarget;
    const status = current.querySelector("[data-push-status]");
    const form = current.querySelector("form");
    const fieldset = current.querySelector("fieldset");
    current.querySelector("[data-enable-push]").addEventListener("click", async event => {
      event.currentTarget.disabled = true;
      try { await enablePush(status); } catch (error) { status.textContent = error.message; }
      finally { event.currentTarget.disabled = false; }
    });
    current.querySelector("[data-phone-settings]").addEventListener("click", () => { status.textContent = phoneSettingsText(); });
    current.querySelector("[data-disable-push]").addEventListener("click", async () => {
      try { await window.disconnectAccountPush(); status.textContent = "Phone notifications disabled on this device. Account notifications remain available in the app."; }
      catch (error) { status.textContent = error.message; }
    });
    current.querySelector("[data-close-settings]").addEventListener("click", () => current.close());
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const preferences = Object.fromEntries(["orders", "shipping", "messages", "account"].map(key => [key, form.elements[key].checked]));
      fieldset.disabled = true;
      try { await pushRequest("/api/account/push-preferences", "PUT", preferences); status.textContent = "Notification preferences saved."; }
      catch (error) { status.textContent = error.message; }
      finally { fieldset.disabled = false; }
    });
    current.addEventListener("close", () => { current.remove(); settingsDialog = null; opener.focus(); });
    document.body.append(current);
    current.showModal();
    try {
      const data = await pushRequest("/api/account/push-preferences");
      for (const key of ["orders", "shipping", "messages", "account"]) form.elements[key].checked = data.preferences[key];
      fieldset.disabled = false;
      status.textContent = !supportsPush() ? "Open the Home Screen app to enable phone notifications." : window.Notification.permission === "denied" ? phoneSettingsText() : "Tap Enable phone notifications to allow alerts on this device.";
    } catch (error) { status.textContent = error.message; }
  }
  notificationSettings?.addEventListener("click", openNotificationSettings);
  document.getElementById("account-notification-settings")?.addEventListener("click", openNotificationSettings);
  let initialAppTabApplied = false;

  let nav;
  if (installed) {
    document.body.classList.add("installed-app");
    if (!location.hash || location.hash === "#home") location.hash = "#my-profile";
    const communityLink = document.querySelector('.main-nav [data-page="home"]');
    if (communityLink) communityLink.textContent = "Community";
    nav = document.createElement("nav");
    nav.className = "pwa-bottom-nav";
    nav.setAttribute("aria-label", "My Profile navigation");
    const destinations = [
      ["Membership", "membership", "◇"], ["Success", "success", "✓"],
      ["Orders", "orders", "▤"], ["Profiles", "edit-profile", "◎"],
      ["Notifications", "notifications", "♧"], ["Security", "security", "⚙"]
    ];
    for (const [label, tab, icon] of destinations) {
      const link = document.createElement("a");
      link.href = "#my-profile";
      link.dataset.appTab = tab;
      link.setAttribute("aria-label", label);
      const glyph = document.createElement("span");
      glyph.textContent = icon;
      glyph.setAttribute("aria-hidden", "true");
      link.append(glyph, document.createTextNode(label));
      link.addEventListener("click", () => {
        setTimeout(() => { document.querySelector(`button[data-account-tab="${tab}"]`)?.click(); sync(); }, 0);
      });
      nav.append(link);
    }
    document.body.append(nav);
  }
  function sync() {
    const hideInstall = !signedIn() || appInstalled;
    if (installButton && installButton.hidden !== hideInstall) installButton.hidden = hideInstall;
    if (!signedIn() && dialog) dialog.close();
    if (!signedIn() && settingsDialog) settingsDialog.close();
    if (signedIn() && !initialAppTabApplied) {
      initialAppTabApplied = true;
      const tab = new URLSearchParams(location.search).get("appTab");
      if (["success", "membership", "notifications"].includes(tab)) setTimeout(() => document.querySelector(`button[data-account-tab="${tab}"]`)?.click(), 0);
    }
    if (!nav) return;
    if (nav.hidden !== !signedIn()) nav.hidden = !signedIn();
    for (const link of nav.querySelectorAll("a")) {
      const tab = document.querySelector(`button[data-account-tab="${link.dataset.appTab}"]`);
      const active = location.hash === "#my-profile" && tab?.classList.contains("active");
      link.classList.toggle("active", Boolean(active));
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
      if (link.dataset.appTab === "notifications") {
        const light = document.getElementById("account-notification-light");
        const unread = light && !light.classList.contains("clear");
        link.classList.toggle("has-notifications", Boolean(unread));
        link.setAttribute("aria-label", unread ? "Notifications, unread updates" : "Notifications");
      }
    }
  }
  if (dashboard) new MutationObserver(sync).observe(dashboard, { attributes: true, subtree: true, attributeFilter: ["hidden", "class"] });
  window.addEventListener("hashchange", sync);
  sync();
})();
