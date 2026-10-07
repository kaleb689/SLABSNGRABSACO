import { shippingStage, selectedOrders, dashboardTotals, dashboardProducts, dashboardActivity, metricChanges } from './app-dashboard-data.js';

const appEnabled = window.self === window.top && (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true ||
  (new URLSearchParams(location.search).get('appPreview') === '1' && ADMIN_PREVIEW_MODE));
if (appEnabled) {
  const icons = {
    home: '<path d="m3 10 9-7 9 7v11h-6v-7H9v7H3z"/>',
    tracking: '<path d="m5 5-3 7v8h3v-3h14v3h3v-8l-3-7zM2 12h20M6 14h1m10 0h1"/>',
    notifications: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="m2 6 10 8L22 6"/>',
    products: '<rect x="3" y="7" width="18" height="14" rx="3"/><path d="M8 7V3h8v4M3 12h18"/>',
    history: '<path d="M3 21h18M5 21V12h3v9m3 0V5h3v16m3 0V8h3v13"/>',
    profile: '<circle cx="12" cy="7" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>'
    ,settings: '<path d="m9 3 1-1h4l1 1 1 3 3 1 2 2v4l-2 2-3 1-1 3-1 1h-4l-1-1-1-3-3-1-2-2V9l2-2 3-1z"/><circle cx="12" cy="12" r="3"/>',
    box: '<path d="m3 6 9-4 9 4v12l-9 4-9-4zM3 6l9 4 9-4M12 10v12M7 4l9 4"/>'
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
  const labels = { home: 'Home', tracking: 'Tracking', products: 'Products', history: 'History', profile: 'Profile', notifications: 'Notifications', settings: 'Settings' };
  const navLabels = ['home', 'tracking', 'products', 'profile', 'history'].map(id => [id, labels[id]]);
  let theme = 'night';
  try { theme = localStorage.getItem('sng-app-theme') || 'night'; } catch {}
  const snapshots = new Map(), changes = new Map();
  const stageLabels = { ordered: 'Ordered', shipped: 'Shipped', in_transit: 'In transit', out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled' };
  const e = value => escapeHtml(String(value ?? ''));
  const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value) || 0);
  const dateLabel = value => value ? new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'Pending';
  let view = ({ success: 'home', membership: 'profile', notifications: 'notifications' })[new URLSearchParams(location.search).get('appTab')] || 'home';
  let days = 30, status = 'all', query = '', orders = [], busy = false, queued = false, error = '', accountId = null;
  let profileTab = 'membership', stream = null;
  const expanded = new Set();
  const root = document.createElement('div');
  root.id = 'app-dashboard'; root.hidden = true;
  root.innerHTML = `<header class="sng-app-header"><div class="sng-app-brand"><img src="/slabsngrabs-aco-logo-transparent.png" alt=""><div><strong>SLABSNGRABSACO</strong><span id="sng-app-title"></span></div></div>
    <div class="sng-app-header-actions"><button type="button" data-app-theme aria-label="Switch to day mode">${icon('sun')}</button><button type="button" data-app-view="settings" aria-label="Settings">${icon('settings')}</button><button type="button" data-app-view="notifications" aria-label="Notifications">${icon('notifications')}<span id="sng-app-unread" hidden></span></button></div></header>
    <div id="sng-app-content"></div><nav class="sng-app-nav" aria-label="App navigation">${navLabels.map(([id, label]) => `<button type="button" data-app-view="${id}" aria-label="${label}">${icon(id)}<span>${label}</span></button>`).join('')}</nav>`;
  document.getElementById('customer-dashboard').before(root);
  document.body.classList.add('app-dashboard');
  document.body.dataset.appView = view;

  const rangeName = () => days === 'ytd' ? 'Year to date' : days === 1 ? 'Last 24 hours' : `Last ${days} days`;
  const rangeButtons = () => `<div class="sng-range" role="group" aria-label="Date range">${[1, 7, 30, 90, 180, 'ytd'].map(n => `<button type="button" data-app-days="${n}" aria-pressed="${n === days}">${n === 'ytd' ? 'YTD' : n === 1 ? '24HR' : n === 180 ? '6M' : `${n}D`}</button>`).join('')}</div><p class="sng-period-label">${rangeName()}</p>`;
  const metric = (label, value, tone = '', symbol = '', delta = null) => `<div class="sng-metric ${tone}"><span>${symbol ? icon(symbol) : ''}${e(label)}</span><strong>${e(value)}</strong>${delta === null ? '' : `<small class="sng-delta" title="Change since the previous refresh of this date range">${delta >= 0 ? '+' : ''}${delta} since last update</small>`}</div>`;
  const hero = (label, value, note, tone = '') => {
    const activity = dashboardActivity(selectedOrders(orders, days), days);
    const max = Math.max(1, ...activity.map(day => day.value));
    const path = activity.map((day, i) => `${i ? 'L' : 'M'}${i / Math.max(1, activity.length - 1) * 300} ${50 - day.value / max * 43}`).join(' ');
    return `<section class="sng-hero ${tone}"><div>${e(label)}</div><strong>${e(value)}</strong><p>${e(note)}</p><svg viewBox="0 0 300 55" preserveAspectRatio="none" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="2"/></svg></section>`;
  };
  const image = product => {
    const fallback = '/slabsngrabs-aco-logo-transparent.png';
    const url = String(product?.imageUrl || '');
    const safe = /^(https:\/\/|\/(?!\/))/.test(url);
    const src = safe ? url : fallback;
    return `<img src="${e(src)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${fallback}'">`;
  };
  const productRows = (products, ranked = false) => products.map((product, index) => `<article class="sng-product-row">${ranked ? `<b class="sng-rank">${index + 1}</b>` : ''}<div class="sng-product-image">${image(product)}</div><div class="sng-row-main"><strong>${e(product.name)}</strong><small>${e(product.retailer)} · ${product.quantity} secured · ${product.delivered} delivered</small><div class="sng-progress"><span style="width:${product.quantity ? product.delivered / product.quantity * 100 : 0}%"></span></div></div><div class="sng-row-value"><strong>${money(product.value)}</strong><small>VALUE</small></div></article>`).join('') || '<p class="sng-empty">No products in this date range.</p>';
  function orderRows(records, tracking = false) {
    return records.map(order => {
      const stage = shippingStage(order), item = order.items?.[0] || {}, shipping = order.shipping || {};
      const steps = ['ordered', 'shipped', 'in_transit', 'delivered'];
      const step = stage === 'out_for_delivery' ? 2 : steps.indexOf(stage);
      const address = shipping.address || {};
      const trackingUrl = /^https:\/\//i.test(shipping.trackingUrl || '') ? shipping.trackingUrl : '';
      return `<details class="sng-order-card stage-${stage}" data-order-id="${e(order.id || order.orderNumber)}" ${expanded.has(order.id || order.orderNumber) ? 'open' : ''}>
        <summary><div class="sng-product-image">${image(item)}</div><div class="sng-row-main"><strong>${e(item.name || `${order.retailer} order`)}</strong><small>${e(order.retailer)} · ${dateLabel(order.checkoutAt)} · ${Number(order.itemCount) || 0} items</small></div><div class="sng-row-value"><strong>${money(order.orderTotal)}</strong><small class="sng-stage">● ${stageLabels[stage]}</small></div></summary>
        ${tracking ? `<div class="sng-shipping-steps">${steps.map((s, i) => `<span class="${i <= step ? 'done' : ''}">${stageLabels[s]}</span>`).join('')}</div><p class="sng-delivery">${stage === 'delivered' ? 'Delivered' : 'Expected delivery'} · ${e(shipping.estimatedDelivery || 'Waiting for carrier update')}</p>` : ''}
        <div class="sng-order-details"><span>Order ${e(order.orderNumber || '—')}</span>${(order.items || []).map(product => `<p class="sng-detail-product"><span class="sng-product-image">${image(product)}</span>${e(product.name)} × ${Number(product.quantity) || 1}</p>`).join('')}
        <p>${e(shipping.carrier || 'Carrier pending')}${shipping.trackingNumber ? ` · ${e(shipping.trackingNumber)}` : ''}</p>
        ${trackingUrl ? `<a href="${e(trackingUrl)}" target="_blank" rel="noopener noreferrer">Track with carrier ↗</a>` : ''}
        ${address.address ? `<p>${e([address.name, address.address, address.address2, address.city, address.state, address.zip].filter(Boolean).join(', '))}</p>` : ''}</div></details>`;
    }).join('') || '<p class="sng-empty">No orders match this view.</p>';
  }
  function breakdown(title, entries, total) {
    const colors = ['#9561ff', '#ffd235', '#17d9b0', '#28b9ff', '#ff59b7', '#ff8b36'];
    let offset = 0;
    const segments = entries.map(([,count], i) => { const start = offset; offset += total ? count / total * 100 : 0; return `${colors[i % colors.length]} ${start}% ${offset}%`; });
    return `<section class="sng-chart-card"><div class="sng-section-title"><h2>${title}</h2><span>${entries.length}</span></div><div class="sng-breakdown"><div class="sng-donut" role="img" aria-label="${e(title)}: ${entries.map(([name,count]) => `${e(name)} ${count}`).join(', ')}" style="background:conic-gradient(${segments.join(',') || '#303440 0% 100%'})"><div><strong>${total}</strong><small>ORDERS</small></div></div><div class="sng-legend">${entries.map(([name,count],i) => `<p><i style="background:${colors[i % colors.length]}"></i><span>${e(name)}</span><b>${total ? (count / total * 100).toFixed(1) : 0}%</b></p>`).join('') || '<p>No orders in this period.</p>'}</div></div>${entries.map(([name,count],i) => `<div class="sng-breakdown-row"><span>${e(name)}</span><b>${count} orders</b><div class="sng-progress"><span style="width:${total ? count / total * 100 : 0}%;background:${colors[i % colors.length]}"></span></div></div>`).join('')}</section>`;
  }
  function bars(records) {
    const activity = dashboardActivity(records, days);
    const max = Math.max(1, ...activity.map(day => day.value));
    return `<div class="sng-bar-chart" role="img" aria-label="Order value · ${rangeName()}">${activity.map(day => `<div class="sng-bar-column" title="${e(day.date)}: ${day.count} orders, ${money(day.value)}"><div class="sng-bar" style="height:${Math.max(day.value ? 4 : 0, day.value / max * 100)}%"></div></div>`).join('')}</div><div class="sng-chart-axis"><span>${dateLabel(activity[0]?.date + 'T12:00:00')}</span><span>${dateLabel(activity.at(-1)?.date + 'T12:00:00')}</span></div>`;
  }
  function render() {
    if (!state.customer) { root.hidden = true; document.body.classList.remove('app-signed-in'); orders = []; accountId = null; snapshots.clear(); changes.clear(); stream?.close(); stream = null; return; }
    root.hidden = false; document.body.classList.add('app-signed-in'); document.body.dataset.appView = view;
    document.body.dataset.profileTab = profileTab;
    document.body.dataset.appTheme = theme;
    const themeButton = root.querySelector('[data-app-theme]');
    themeButton.setAttribute('aria-label', `Switch to ${theme === 'night' ? 'day' : 'night'} mode`);
    themeButton.setAttribute('aria-pressed', String(theme === 'day'));
    document.getElementById('sng-app-title').textContent = labels[view].toUpperCase();
    const unread = state.customerNotifications?.length || 0;
    const badge = document.getElementById('sng-app-unread'); badge.hidden = !unread; badge.textContent = unread;
    root.querySelectorAll('[data-app-view]').forEach(button => {
      button.classList.toggle('active', button.dataset.appView === view);
      button.setAttribute('aria-pressed', String(button.dataset.appView === view));
    });
    const records = selectedOrders(orders, days), totals = dashboardTotals(records), products = dashboardProducts(records);
    const previous = snapshots.get(days);
    if (accountId && (!previous || JSON.stringify(previous) !== JSON.stringify(totals))) {
      changes.set(days, metricChanges(previous, totals)); snapshots.set(days, totals);
    }
    const delta = changes.get(days) || { orders: 0, transit: 0, delivered: 0 };
    const content = document.getElementById('sng-app-content');
    const currentFocus = document.activeElement?.id, cursor = document.activeElement?.selectionStart;
    const common = rangeButtons() + (state.customer.demo || ADMIN_PREVIEW_MODE ? '<div class="sng-demo-label">DEMO · Sample account</div>' : '') + (error ? `<p class="sng-error" role="status">${e(error)} <button type="button" data-app-refresh>Retry</button></p>` : '') + (busy && !accountId ? '<p class="sng-demo-label" role="status">Loading your checkout data…</p>' : '');
    let html = '';
    if (view === 'home') html = common + hero('TOTAL CHECKOUT VALUE', money(totals.spend), `${totals.orders} orders · ${totals.items} items secured · ${state.membership?.name || state.membership?.planName || 'Member'}`) +
      `<button class="sng-arrival" type="button" data-app-view="tracking">${icon('tracking')}<span><strong>${records.filter(r => shippingStage(r) === 'out_for_delivery').length} packages out for delivery</strong><small>View your shipping tracker</small></span><b>›</b></button>` +
      `<div class="sng-metrics three">${metric('ORDERED', totals.orders, '', 'box', delta.orders)}${metric('IN TRANSIT', totals.transit, 'cyan', 'tracking', delta.transit)}${metric('DELIVERED', totals.delivered, 'green', 'home', delta.delivered)}</div><div class="sng-section-title"><h2>Top products</h2><button type="button" data-app-view="products">View all</button></div>${productRows(products.slice(0, 3), true)}<div class="sng-section-title"><h2>Recent orders</h2><button type="button" data-app-view="tracking">Track all</button></div>${orderRows(records.slice(0, 5))}`;
    if (view === 'tracking') html = common + hero('IN TRANSIT', `${totals.transit} packages`, `${totals.awaiting} awaiting shipment · ${totals.delivered} delivered`, 'orange') +
      `<label class="sng-search">Search retailer, product or tracking number<input id="sng-search" value="${e(query)}" placeholder="Search packages" type="search"></label><div class="sng-status-filters" role="group" aria-label="Shipping status">${['all', 'ordered', 'shipped', 'in_transit', 'out_for_delivery', 'delivered'].map(s => `<button type="button" data-app-status="${s}" aria-pressed="${s === status}">${s === 'all' ? 'All' : stageLabels[s]} <span>${s === 'all' ? records.length : records.filter(r => shippingStage(r) === s).length}</span></button>`).join('')}</div><div class="sng-section-title"><h2>Packages</h2><span>Live updates</span></div><div id="sng-search-results"></div>`;
    if (view === 'products') html = common + `<div class="sng-segment-label">PRODUCTS SECURED</div>` + hero('PRODUCT VALUE', money(totals.spend), `${totals.items} items · ${products.length} products`, 'pink') +
      `<div class="sng-section-title"><h2>Metrics</h2></div><div class="sng-metrics">${metric('TOTAL QUANTITY', totals.items)}${metric('DELIVERED ORDERS', totals.delivered)}${metric('IN TRANSIT', totals.transit)}${metric('AWAITING SHIPMENT', totals.awaiting)}${metric('ORDER VALUE', money(totals.spend))}${metric('PRODUCTS', products.length)}</div><label class="sng-search">Search products<input id="sng-search" value="${e(query)}" placeholder="Search products" type="search"></label><div class="sng-section-title"><h2>Products <span>${products.length}</span></h2></div><div id="sng-search-results"></div>`;
    if (view === 'history') {
      const activity = dashboardActivity(records, days);
      const biggest = activity.reduce((best, bucket) => bucket.value > best.value ? bucket : best, { value: 0 });
      const retailers = Object.entries(records.reduce((all, order) => { all[order.retailer] = (all[order.retailer] || 0) + 1; return all; }, {})).sort((a,b) => b[1]-a[1]);
      const statuses = Object.entries(records.reduce((all, order) => { const name = stageLabels[shippingStage(order)]; all[name] = (all[name] || 0) + 1; return all; }, {}));
      html = common + `<div class="sng-segment-label">OVERVIEW · YOUR ORDERS</div>` + hero('TOTAL SPENT · ' + rangeName().toUpperCase(), money(totals.spend), `${totals.orders} orders · avg ${money(totals.orders ? totals.spend / totals.orders : 0)}`, 'insights') +
        `<div class="sng-metrics">${metric('AVG ORDER', money(totals.orders ? totals.spend / totals.orders : 0), 'cyan')}${metric('ORDERS', totals.orders, 'violet')}${metric('BIGGEST PERIOD', money(biggest.value))}${metric('RETAILERS', retailers.length)}</div>` +
        breakdown('By retailer', retailers, totals.orders) + breakdown('By status', statuses, totals.orders) +
        `<div class="sng-section-title"><h2>Order history</h2></div>${orderRows(records)}`;
    }
    if (view === 'settings') html = `<div class="sng-page-intro"><h1>Settings</h1><p>Manage your app and account preferences.</p></div><div class="sng-settings-list"><button type="button" data-app-theme>${icon('sun')} ${theme === 'night' ? 'Switch to day mode' : 'Switch to night mode'}</button><button type="button" data-app-notification-settings>${icon('notifications')} Notification preferences</button><button type="button" data-setting-profile="edit-profile">${icon('profile')} Saved information</button><button type="button" data-setting-profile="security">${icon('settings')} Account security</button><button type="button" data-setting-profile="orders">${icon('box')} Billing and orders</button></div>`;
    if (view === 'notifications') html = `<div class="sng-page-intro"><h1>Notifications</h1><p>Orders, shipping and messages from SLABSNGRABSACO.</p></div>`;
    if (view === 'profile') html = `<div class="sng-page-intro"><h1>My profile</h1><p>Your tier, saved information and account settings.</p></div><div class="sng-profile-menu" role="group" aria-label="Profile sections">${[['membership', 'Membership'], ['edit-profile', 'Saved info'], ['orders', 'Billing orders'], ['security', 'Security']].map(([id, label]) => `<button type="button" data-profile-tab="${id}" aria-pressed="${profileTab === id}">${label}</button>`).join('')}</div>`;
    content.innerHTML = html;
    renderSearch();
    if (currentFocus === 'sng-search') { const input = document.getElementById(currentFocus); input?.focus({ preventScroll: true }); if (input && cursor !== null) input.setSelectionRange(cursor, cursor); }
    renderSetupChecklist();
  }
  function renderSearch() {
    const target = document.getElementById('sng-search-results'); if (!target) return;
    const records = selectedOrders(orders, days), needle = query.toLowerCase();
    target.innerHTML = view === 'products' ? productRows(dashboardProducts(records).filter(p => `${p.name} ${p.retailer}`.toLowerCase().includes(needle))) :
      orderRows(records.filter(order => (status === 'all' || shippingStage(order) === status) && `${order.retailer} ${order.orderNumber} ${order.shipping?.trackingNumber || ''} ${(order.items || []).map(p => p.name).join(' ')}`.toLowerCase().includes(needle)), true);
  }
  function setView(next) {
    if (!labels[next]) return;
    view = next; query = ''; document.body.dataset.appView = view;
    if (location.hash !== '#my-profile') go('my-profile');
    if (view === 'notifications') document.querySelector('button[data-account-tab="notifications"]')?.click();
    if (view === 'profile') document.querySelector(`button[data-account-tab="${profileTab}"]`)?.click();
    render(); window.scrollTo({ top: 0, behavior: 'auto' });
  }
  root.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.appView) setView(button.dataset.appView);
    if (button.dataset.appDays) { days = button.dataset.appDays === 'ytd' ? 'ytd' : Number(button.dataset.appDays); render(); }
    if (button.dataset.appStatus) { status = button.dataset.appStatus; render(); }
    if (button.dataset.profileTab) { profileTab = button.dataset.profileTab; document.querySelector(`button[data-account-tab="${profileTab}"]`)?.click(); render(); }
    if (button.dataset.settingProfile) { profileTab = button.dataset.settingProfile; setView('profile'); }
    if (button.hasAttribute('data-app-theme')) { theme = theme === 'night' ? 'day' : 'night'; try { localStorage.setItem('sng-app-theme', theme); } catch {} render(); }
    if (button.hasAttribute('data-app-notification-settings')) document.getElementById('account-notification-settings')?.click();
    if (button.hasAttribute('data-app-refresh')) void refresh();
  });
  root.addEventListener('input', event => { if (event.target.id === 'sng-search') { query = event.target.value; renderSearch(); } });
  root.addEventListener('toggle', event => { if (event.target.matches('details[data-order-id]')) { const id = event.target.dataset.orderId; event.target.open ? expanded.add(id) : expanded.delete(id); } }, true);
  async function refresh() {
    if (!state.customer || document.hidden) return render();
    if (busy) { queued = true; return; }
    const id = state.customer.id; busy = true;
    try {
      if (ADMIN_PREVIEW_MODE) orders = adminPreviewSuccessData().recentCheckouts;
      else {
        const end = new Date(), start = new Date(); start.setUTCDate(start.getUTCDate() - 365);
        const response = await fetch(`/api/account/success?appView=1&start=${start.toISOString().slice(0, 10)}&end=${end.toISOString().slice(0, 10)}`, { credentials: 'same-origin', cache: 'no-store' });
        const data = await readJson(response);
        if (!response.ok) throw new Error(data.error || 'Unable to refresh order data.');
        if (state.customer?.id !== id) return;
        orders = Array.isArray(data.checkouts) ? data.checkouts : data.recentCheckouts || [];
      }
      error = ''; accountId = id;
    } catch (failure) { error = failure.message; }
    finally { busy = false; render(); if (queued) { queued = false; void refresh(); } }
  }
  function connect() {
    if (!state.customer || document.hidden || ADMIN_PREVIEW_MODE) { stream?.close(); stream = null; return; }
    if (stream) return;
    stream = new EventSource('/api/account/success/events');
    stream.addEventListener('checkout', () => void refresh());
    stream.addEventListener('open', () => void refresh());
  }
  document.addEventListener('account-session-changed', () => { render(); connect(); if (state.customer && state.customer.id !== accountId) { snapshots.clear(); changes.clear(); void refresh(); } });
  document.addEventListener('account-data-updated', () => { render(); void refresh(); });
  document.addEventListener('account-notifications-updated', render);
  document.addEventListener('visibilitychange', () => { connect(); if (!document.hidden) void refresh(); });
  window.addEventListener('pageshow', () => { connect(); void refresh(); });
  window.addEventListener('pagehide', () => { stream?.close(); stream = null; });
  document.getElementById('app-demo-tools')?.addEventListener('click', () => setTimeout(() => void refresh(), 800));
  document.addEventListener('click', event => { if (event.target.closest('[data-demo-event]')) setTimeout(() => void refresh(), 800); });
  setInterval(() => { if (!document.hidden && state.customer) void refresh(); }, 30000);
  render(); connect(); void refresh();
}
