(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const money = value => new Intl.NumberFormat("en-US", {style:"currency", currency:"USD"}).format(Number(value) || 0);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[char]));
  const historicalOrders = 240;
  const historicalSpend = 15876.11;
  let report = {records:[], communityRecords:[]};
  let period = 30;
  let scope = "all";

  function recordDate(row) {
    const raw = row?.confirmedAt || row?.checkoutAt || row?.createdAt || row?.timestamp || row?.date || row?.paidAt;
    const ms = new Date(raw || 0).getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  function paid(row) {
    return row?.orderTotalKnown === true && Number(row?.orderTotal) > 0 ? Number(row.orderTotal) : 0;
  }
  function quantity(row) {
    return Array.isArray(row?.items) ? row.items.reduce((sum, item) => sum + Math.max(1, Number(item?.quantity) || 1), 0) : 0;
  }
  function selectedWindow(now = new Date()) {
    if (period === "all") return {start:0,end:Infinity,label:"All time"};
    if (period === "ytd") return {start:new Date(now.getFullYear(),0,1).getTime(),end:now.getTime()+60000,label:"Year to date"};
    if (period === "custom") {
      const from = $("dateFrom")?.value;
      const to = $("dateTo")?.value;
      if (from && to) {
        const start = new Date(`${from}T00:00:00`).getTime();
        const end = new Date(`${to}T23:59:59.999`).getTime();
        if (Number.isFinite(start) && Number.isFinite(end) && start <= end) return {start,end,label:`${from} through ${to}`};
      }
      return {start:now.getTime()-30*86400000,end:now.getTime()+60000,label:"Last 30 days"};
    }
    const days = Number(period) || 30;
    return {start:now.getTime()-days*86400000,end:now.getTime()+60000,label:days === 1 ? "Last 24 hours" : `Last ${days} days`};
  }
  function visibleRows() {
    const all = Array.isArray(report.communityRecords) ? report.communityRecords : [];
    const linked = Array.isArray(report.records) ? report.records : [];
    let source;
    if (scope === "all") source = all.length ? all : linked;
    else if (scope === "linked") source = all.length ? all.filter(row => row?.linked || row?.customerAccountId) : linked;
    else if (scope === "unmatched") source = all.filter(row => !(row?.linked || row?.customerAccountId));
    else if (scope.startsWith("customer:")) source = linked.filter(row => `customer:${row?.customerAccountId}` === scope);
    else source = linked;
    const window = selectedWindow();
    return source.filter(row => { const t = recordDate(row); return t >= window.start && t <= window.end; });
  }
  function stat(label, value) {
    return `<div class="stat"><small>${esc(label)}</small><strong>${esc(value)}</strong></div>`;
  }
  function rebuildScope() {
    const select = $("scope");
    if (!select) return;
    const names = new Map();
    for (const row of Array.isArray(report.records) ? report.records : []) {
      if (row?.customerAccountId) names.set(String(row.customerAccountId), String(row.customerName || row.customerEmail || "Customer"));
    }
    select.innerHTML = '<option value="all">All confirmed checkouts</option><option value="linked">Linked customer checkouts</option><option value="unmatched">Unmatched community checkouts</option>' +
      [...names.entries()].sort((a,b)=>a[1].localeCompare(b[1])).map(([id,name]) => `<option value="customer:${esc(id)}">${esc(name)}</option>`).join("");
    if ([...select.options].some(option => option.value === scope)) select.value = scope;
    else { scope = "all"; select.value = scope; }
  }
  function renderRetailers(rows) {
    const map = new Map();
    for (const row of rows) {
      const name = String(row?.retailer || row?.store || "Unknown retailer");
      const current = map.get(name) || {orders:0, spend:0, items:0};
      current.orders += 1; current.spend += paid(row); current.items += quantity(row); map.set(name,current);
    }
    $("retailers").innerHTML = map.size ? `<div class="rows">${[...map.entries()].sort((a,b)=>b[1].orders-a[1].orders).map(([name,x]) => `<div class="line"><div><strong>${esc(name)}</strong><small>${x.orders} order${x.orders===1?"":"s"} · ${x.items} item${x.items===1?"":"s"}</small></div><span class="money">${money(x.spend)}</span></div>`).join("")}</div>` : '<p>No retailer orders in this period.</p>';
  }
  function renderProducts(rows) {
    const map = new Map();
    for (const row of rows) for (const item of Array.isArray(row?.items) ? row.items : []) {
      const name = String(item?.name || item?.title || item?.product || "Product");
      const key = name.toLowerCase();
      const current = map.get(key) || {name, qty:0, image:item?.image || item?.imageUrl || ""};
      current.qty += Math.max(1, Number(item?.quantity) || 1); if (!current.image) current.image = item?.image || item?.imageUrl || ""; map.set(key,current);
    }
    $("products").innerHTML = map.size ? `<div class="products">${[...map.values()].sort((a,b)=>b.qty-a.qty).map(item => `<div class="product">${item.image?`<img src="${esc(item.image)}" alt="">`:'<div class="product-placeholder">SNG</div>'}<div><strong>${esc(item.name)}</strong><small>Purchased quantity</small></div><span class="pill">× ${item.qty}</span></div>`).join("")}</div>` : '<p>No products in this period.</p>';
  }
  function renderCustomers(rows) {
    const map = new Map();
    for (const row of rows) {
      const id = String(row?.customerAccountId || "");
      if (!id) continue;
      const current = map.get(id) || {name:String(row?.customerName || row?.customerEmail || "Customer"), rows:[]};
      current.rows.push(row); map.set(id,current);
    }
    $("customers").innerHTML = map.size ? [...map.entries()].map(([id,user]) => {
      const spend = user.rows.reduce((sum,row)=>sum+paid(row),0);
      const items = user.rows.reduce((sum,row)=>sum+quantity(row),0);
      const details = user.rows.slice().sort((a,b)=>recordDate(b)-recordDate(a)).slice(0,40).map(row => `<div class="detail-item"><strong>${esc(row?.retailer || row?.store || "Retailer")}</strong> · ${new Date(recordDate(row)).toLocaleString()} · ${row?.orderTotalKnown === true ? money(row.orderTotal) : "price pending"}</div>`).join("");
      return `<details class="user-card"><summary><span>${esc(user.name)}</span><span class="pill">${user.rows.length} orders</span></summary><div class="body"><div class="user-metrics"><div><small>Confirmed orders</small><strong>${user.rows.length}</strong></div><div><small>Verified spend</small><strong>${money(spend)}</strong></div><div><small>Items</small><strong>${items}</strong></div></div><div class="detail-list">${details}</div></div></details>`;
    }).join("") : '<p>No linked customer orders in this period.</p>';
  }
  function render() {
    const rows = visibleRows();
    const spend = rows.reduce((sum,row)=>sum+paid(row),0);
    const unknown = rows.filter(row => row?.orderTotalKnown !== true).length;
    $("period-stats").innerHTML = stat("Confirmed checkouts", rows.length) + stat("Verified paid total", money(spend)) + stat("Items purchased", rows.reduce((sum,row)=>sum+quantity(row),0)) + stat("Prices pending", unknown);
    $("period-caption").textContent = `${selectedWindow().label}. Only verified retailer totals are included in spend.`;
    renderRetailers(rows); renderProducts(rows); renderCustomers(rows);
    document.querySelectorAll("[data-period]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.period === String(period))));
    $("customDates").hidden = period !== "custom";
  }
  async function refresh() {
    const status = $("status");
    try {
      const response = await fetch("/api/admin/success-overview", {credentials:"same-origin", cache:"no-store"});
      const json = await response.json().catch(()=>({}));
      if (!response.ok) throw new Error(json?.error || `HTTP ${response.status}`);
      report = {...json, records:Array.isArray(json?.records)?json.records:[], communityRecords:Array.isArray(json?.communityRecords)?json.communityRecords:[]};
      const all = report.communityRecords.length ? report.communityRecords : report.records;
      const liveOrders = all.length;
      const liveSpend = all.reduce((sum,row)=>sum+paid(row),0);
      $("liveOrders").textContent = String(liveOrders);
      $("combinedSpend").textContent = money(historicalSpend + liveSpend);
      rebuildScope(); render();
      status.textContent = `Live checkout reporting loaded · ${new Date(report.sourceCheckedAt || Date.now()).toLocaleString()}`;
    } catch (error) {
      status.textContent = `Could not load checkout reporting: ${error.message}`;
      status.classList.add("error");
    }
  }

  $("periods")?.addEventListener("click", event => {
    const button = event.target.closest("[data-period]"); if (!button) return;
    const value = button.dataset.period; period = /^\d+$/.test(value) ? Number(value) : value; render();
  });
  $("scope")?.addEventListener("change", event => { scope = event.target.value; render(); });
  $("applyCustom")?.addEventListener("click", render);
  $("theme-toggle")?.addEventListener("click", () => {
    const next = document.body.dataset.adminTheme === "light" ? "dark" : "light";
    document.body.dataset.adminTheme = next;
    try { localStorage.setItem("sng-admin-theme", next); } catch {}
  });
  try { document.body.dataset.adminTheme = localStorage.getItem("sng-admin-theme") || "dark"; } catch { document.body.dataset.adminTheme = "dark"; }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
  setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
  void refresh();
})();