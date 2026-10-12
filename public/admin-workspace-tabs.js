(() => {
  "use strict";
  const dashboard = document.getElementById("dashboard");
  const select = document.getElementById("submissionTypeFilter");
  const header = dashboard?.querySelector(".admin-head");
  if (!dashboard || !select || !header || document.getElementById("adminWorkspaceTabs")) return;

  const tabNames = [
    ["home", "Home"], ["customers", "Customers"], ["gifted", "Gifted"],
    ["rented", "Rented"], ["available", "Available Memberships"]
  ];
  const viewTypes = {home:"paid", customers:"paid", gifted:"free-profile", rented:"rented-profile", available:"available-memberships"};
  const nav = document.createElement("nav");
  nav.id = "adminWorkspaceTabs";
  nav.className = "admin-workspace-tabs";
  nav.setAttribute("aria-label", "Admin sections");

  function region(id) {
    const element = document.createElement("section");
    element.id = id;
    element.className = "admin-workspace-page";
    return element;
  }
  const home = region("adminHomePage");
  const available = region("adminAvailablePage");
  const customerTools = region("adminCustomerTools");
  const recordArea = region("adminRecordArea");
  for (const item of [nav, home, available, customerTools, recordArea]) {
    header.insertAdjacentElement("afterend", item);
  }
  // insertAdjacentElement places each element directly after the header; restore intended order.
  header.after(nav, home, available, customerTools, recordArea);

  function move(selector, target) {
    const element = dashboard.querySelector(selector);
    if (element) target.append(element);
    return element;
  }
  // One home for tools not tied to a customer's account or the available pool.
  const headerActions = header.querySelector(".admin-head-actions");
  const homeActions = document.createElement("div");
  homeActions.className = "admin-home-action-links";
  if (headerActions) {
    [...headerActions.children].filter(item => item.id !== "logout" && item.id !== "adminNotifications")
      .forEach(item => homeActions.append(item));
  }
  home.append(homeActions);
  [
    ".admin-membership-kpis",
    ".admin-member-billing-breakdown",
    ".admin-feature-grid",
    ".admin-mailbox-status"
  ].forEach(selector => move(selector, home));

  move(".admin-global-profile-search", customerTools);
  move("#profileActivationTracker", customerTools);
  move("#managedAvailabilityTracker", available);
  const poolBrowser = move("#adminPoolBrowser", available);
  const disclosure = document.getElementById("adminPoolDisclosure");
  if (disclosure) disclosure.open = true;
  const bulk = move(".inventory-manager-shell", available);
  if (bulk) {
    const advanced = document.createElement("details");
    advanced.className = "admin-advanced-inventory";
    const summary = document.createElement("summary");
    summary.textContent = "Bulk import / replace retailer accounts";
    advanced.append(summary, bulk);
    available.append(advanced);
  }

  // Keep the existing filter and render functions, but replace the old dropdown UX with tabs.
  move(".admin-summary", recordArea);
  move("#rows", recordArea);
  const notifications = document.getElementById("adminNotifications");
  if (notifications && headerActions) {
    const broadcasts = notifications.querySelector(".admin-broadcast-manager");
    if (broadcasts) home.append(broadcasts);
    headerActions.prepend(notifications);
    const summary = notifications.querySelector("summary");
    const badge = document.getElementById("adminNotificationCount");
    if (summary && badge) {
      summary.replaceChildren();
      const bell = document.createElement("span");
      bell.textContent = "🔔";
      bell.setAttribute("aria-hidden", "true");
      summary.append(bell, badge);
      summary.setAttribute("aria-label", "Admin notifications");
      summary.title = "Open admin notifications";
    }
  }

  const buttons = new Map();
  for (const [id, title] of tabNames) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "admin-workspace-tab";
    button.textContent = title;
    button.dataset.adminPage = id;
    button.setAttribute("aria-controls", id === "home" ? home.id : id === "available" ? available.id : recordArea.id);
    nav.append(button);
    buttons.set(id, button);
  }

  const allowed = new Set(tabNames.map(item => item[0]));
  let activePage = "";
  function applyPage(page, reload = true) {
    const next = allowed.has(page) ? page : "home";
    const changed = activePage !== next;
    activePage = next;
    dashboard.dataset.adminPage = next;
    home.hidden = next !== "home";
    available.hidden = next !== "available";
    customerTools.hidden = !["customers","gifted","rented"].includes(next);
    recordArea.hidden = next === "home";
    const pageTitle = header.querySelector("h1");
    if (pageTitle) pageTitle.textContent = ({home:"Admin Home",customers:"Paid Customers",gifted:"Gifted Accounts",rented:"Rented Accounts",available:"Available Memberships"})[next];
    nav.querySelectorAll("button").forEach(button => {
      const current = button.dataset.adminPage === next;
      button.classList.toggle("active", current);
      button.setAttribute("aria-current", current ? "page" : "false");
    });
    if (next === "available" && disclosure) {
      disclosure.open = true;
      if (changed) void window.refreshAdminPoolSearch?.();
    }
    const wanted = viewTypes[next];
    const changeFilter = Boolean(wanted && select.value !== wanted);
    if (changeFilter) select.value = wanted;
    // Home billing, consent and operational settings should refresh on return,
    // including when the customer page already used the Paid filter.
    if (reload && (changeFilter || (next === "home" && changed))) {
      select.dispatchEvent(new Event("change", {bubbles:true}));
    }
    if (changed && history.replaceState) {
      const url = new URL(location.href);
      url.searchParams.set("page", next);
      history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    }
    return changed;
  }
  nav.addEventListener("click", event => {
    const button = event.target.closest("[data-admin-page]");
    if (!button) return;
    applyPage(button.dataset.adminPage);
    window.scrollTo({top:0,behavior:"smooth"});
  });

  async function goToIssue(profileId, profileType) {
    const page = profileType === "gifted" || profileType === "free" ? "gifted" :
      profileType === "rented" ? "rented" : "customers";
    const filter = viewTypes[page] || "paid";
    applyPage(page);
    if (select.value !== filter) {
      select.value = filter;
      select.dispatchEvent(new Event("change", {bubbles:true}));
    }
    const notificationPanel = document.getElementById("adminNotifications");
    if (notificationPanel) notificationPanel.open = false;
    const id = String(profileId || "");
    for (let attempt = 0; attempt < 14; attempt++) {
      const target = [...document.querySelectorAll("[data-activation-profile-id]")]
        .find(node => node.dataset.activationProfileId === id);
      if (target && !target.hidden) {
        const group = target.closest(".activation-group");
        if (group) group.open = true;
        target.scrollIntoView({behavior:"smooth",block:"center"});
        target.focus?.({preventScroll:true});
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 125));
    }
  }
  // The previous list's handler scrolls to hidden content when the user is on Available.
  document.addEventListener("click", event => {
    const button = event.target.closest("[data-notification-profile-id]");
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void goToIssue(button.dataset.notificationProfileId,button.dataset.notificationProfileType);
  }, true);

  // A search result can switch from any page to a customer's page.
  document.addEventListener("click", event => {
    if (event.target.closest("#adminGlobalProfileSearchResults [data-view]")) {
      applyPage("customers", false);
    }
  }, true);

  // Preserve navigation after normal page refresh, including notifications.
  const queryPage = new URLSearchParams(location.search).get("page");
  applyPage(queryPage || "home", false);
  window.adminGoToPage = applyPage;
})();

/* Keep every rendered paid-customer status card synchronized with a visual time-left bar.
   The existing Admin renderer already supplies the authoritative "N days left" text;
   this enhancement only visualizes it, so it cannot change subscription state. */
(() => {
  "use strict";
  const root = document.getElementById("dashboard");
  if (!root) return;

  function enhanceMembershipBars() {
    for (const status of root.querySelectorAll(".customer-order-summary .order-status-meta")) {
      const text = String(status.textContent || "").replace(/\s+/g, " ").trim();
      const match = text.match(/(\d+)\s+days?\s+left/i);
      const existing = status.querySelector(".membership-time-left");
      if (!match) {
        existing?.remove();
        continue;
      }
      const days = Math.max(0, Number(match[1]) || 0);
      // Paid memberships are monthly; cap at a full 30-day visual cycle.
      const percent = Math.max(0, Math.min(100, Math.round((days / 30) * 100)));
      const level = percent <= 20 ? "red" : percent <= 50 ? "yellow" : "green";
      const bar = existing || document.createElement("div");
      bar.className = "membership-time-left";
      bar.dataset.level = level;
      bar.style.setProperty("--membership-left", `${percent}%`);
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-label", "Membership time remaining");
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", "30");
      bar.setAttribute("aria-valuenow", String(Math.min(days, 30)));
      bar.innerHTML = '<div class="membership-time-left-track"><div class="membership-time-left-fill"></div></div><span class="membership-time-left-label"></span>';
      bar.querySelector(".membership-time-left-label").textContent = `${days} day${days === 1 ? "" : "s"} remaining`;
      if (!existing) status.append(bar);
    }
  }

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      enhanceMembershipBars();
    });
  };

  const observer = new MutationObserver(schedule);
  observer.observe(root, {subtree:true,childList:true,characterData:true});
  document.addEventListener("change", schedule, true);
  schedule();
})();