import { shippingStage, visibleLateCancellation, periodStart, periodBounds, customDateBounds, selectedOrders, dashboardTotals, dashboardProducts, dashboardActivity, metricChanges } from './app-dashboard-data.js';
import { createCustomerDropEditor } from './app-drop-controls.js';

const appEnabled = window.self === window.top && (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true ||
  (new URLSearchParams(location.search).get('appPreview') === '1' && ADMIN_PREVIEW_MODE));
if (appEnabled) {
  const icons = {
    home: '<path d="m3 10 9-7 9 7v11h-6v-7H9v7H3z"/>',
    tracking: '<path d="m5 5-3 7v8h3v-3h14v3h3v-8l-3-7zM2 12h20M6 14h1m10 0h1"/>',
    notifications: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="m2 6 10 8L22 6"/>',
    products: '<rect x="3" y="7" width="18" height="14" rx="3"/><path d="M8 7V3h8v4M3 12h18"/>',
    history: '<path d="M3 21h18M5 21V12h3v9m3 0V5h3v16m3 0V8h3v13"/>',
    profile: '<path d="M3 9V5h18v4M5 10h14v11H5zM9 14h6M9 18h6"/>',
    drops: '<path d="M4 7h16M4 12h16M4 17h16M7 4v16"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>'
    ,settings: '<path d="M10.2 2.5h3.6l.5 2.3a7.8 7.8 0 0 1 1.5.65l2-1.3 2.55 2.55-1.3 2a7.8 7.8 0 0 1 .65 1.5l2.3.5v3.6l-2.3.5a7.8 7.8 0 0 1-.65 1.5l1.3 2-2.55 2.55-2-1.3a7.8 7.8 0 0 1-1.5.65l-.5 2.3h-3.6l-.5-2.3a7.8 7.8 0 0 1-1.5-.65l-2 1.3-2.55-2.55 1.3-2a7.8 7.8 0 0 1-.65-1.5l-2.3-.5v-3.6l2.3-.5a7.8 7.8 0 0 1 .65-1.5l-1.3-2 2.55-2.55 2 1.3a7.8 7.8 0 0 1 1.5-.65z"/><circle cx="12" cy="12" r="3.2"/>',
    box: '<path d="m3 6 9-4 9 4v12l-9 4-9-4zM3 6l9 4 9-4M12 10v12M7 4l9 4"/>'
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
  const labels = { home: 'Home', tracking: 'Tracking', products: 'Products', history: 'History', profile: 'Membership', drops: 'Drops', notifications: 'Notifications', settings: 'Settings' };
  const navLabels = ['home', 'tracking', 'profile', 'products', 'history'].map(id => [id, labels[id]]);
  let theme = 'night';
  try { theme = localStorage.getItem('sng-app-theme') || 'night'; } catch {}
  const snapshots = new Map(), changes = new Map();
  const stageLabels = { ordered: 'Ordered', shipped: 'Shipped', in_transit: 'In transit', out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled', review_hold: 'Review hold' };
  const e = value => escapeHtml(String(value ?? ''));
  const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value) || 0);
  const dateLabel = value => value ? new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'Pending';
  let view = ({ success: 'home', membership: 'profile', drops: 'drops', notifications: 'notifications', tracking: 'tracking' })[new URLSearchParams(location.search).get('appTab')] || 'home';
  let days = 30, status = 'all', query = '', orders = [], cancelledOrders = [], reviewHoldOrders = [], busy = false, queued = false, error = '', accountId = null;
  let profileTab = 'membership', stream = null;
  let calendarOpen = false, calendarError = '', customRange = null;
  let calendarDraft = {from:'',to:''};
  const dayKey = date => [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),
    String(date.getDate()).padStart(2,'0')].join('-');
  const defaultDraft = () => {
    const today=new Date(), from=new Date(today.getFullYear(),today.getMonth(),today.getDate()-29);
    return {from:dayKey(from),to:dayKey(today)};
  };
  const calendarLabel = range => {
    const display = day => new Date(day+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
    return range ? display(range.from)+' – '+display(range.to) : 'Custom dates';
  };
  const dateWindow = () => periodBounds(days,new Date(),customRange);
  const selected = rows => selectedOrders(rows,days,new Date(),customRange);
  const activityFor = rows => dashboardActivity(rows,days,new Date(),customRange);
  const expanded = new Set();
  const root = document.createElement('div');
  root.id = 'app-dashboard'; root.hidden = true;
  root.innerHTML = `<header class="sng-app-header"><div class="sng-app-brand"><img src="/slabsngrabs-aco-logo-transparent.png" alt=""><div><strong>SLABSNGRABSACO</strong><span id="sng-app-title"></span></div></div>
    <div class="sng-app-header-actions"><button type="button" data-app-theme aria-label="Switch to day mode">${icon('sun')}</button><button type="button" data-app-view="settings" aria-label="Settings">${icon('settings')}</button><button type="button" data-app-view="notifications" aria-label="Notifications">${icon('notifications')}<span id="sng-app-unread" hidden></span></button></div></header>
    <div id="sng-app-content"></div><nav class="sng-app-nav" aria-label="App navigation">${navLabels.map(([id, label]) => `<button type="button" data-app-view="${id}" aria-label="${label}">${icon(id)}<span>${label}</span></button>`).join('')}</nav>`;
  document.getElementById('customer-dashboard').before(root);
  document.body.classList.add('app-dashboard');
  document.body.dataset.appView = view;
  const dropEditor = createCustomerDropEditor({escape:e,onUpdate:()=>{ if(view==='drops') render(); }});

  const rangeName = () => days === 'custom' ? calendarLabel(customRange) : days === 'all' ? 'Lifetime' : days === 'ytd' ? 'Year to date' : days === 1 ? 'Last 24 hours' : `Last ${days} days`;
  function cancelledInPeriod() {
    const {start:earliest, end:latest} = dateWindow();
    return cancelledOrders.filter(order => {
      const time = Date.parse(order.checkoutAt || "");
      return visibleLateCancellation(order) &&
        Number.isFinite(time) && time >= earliest && time < latest;
    }).sort((a, b) => Date.parse(b.checkoutAt) - Date.parse(a.checkoutAt));
  }
  function holdsInPeriod() {
    const {start:earliest, end:latest} = dateWindow();
    return reviewHoldOrders.filter(order => {
      const time = Date.parse(order.checkoutAt || "");
      return order.status === 'review_hold' && Number.isFinite(time) && time >= earliest && time < latest;
    }).sort((a, b) => Date.parse(b.checkoutAt) - Date.parse(a.checkoutAt));
  }
  const rangeButtons = () => {
    const today=dayKey(new Date()), draft=calendarDraft.from&&calendarDraft.to?calendarDraft:defaultDraft();
    const presets=[1,7,30,90,'ytd','all'].map(n=>
      '<button type="button" data-app-days="'+n+'" aria-pressed="'+(n===days)+'">'+
      (n==='all'?'ALL':n==='ytd'?'YTD':n===1?'24H':n+'D')+'</button>').join('');
    const calendarButton='<button type="button" class="sng-calendar-button" data-app-calendar aria-controls="sng-custom-calendar" aria-expanded="'+calendarOpen+'" aria-pressed="'+(days==='custom')+'" aria-label="Choose custom date range">'+
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18"/></svg> Custom</button>';
    const form=calendarOpen?'<form id="sng-custom-calendar" class="sng-custom-calendar" data-app-date-form>'+
      '<div class="sng-date-fields"><label>From<input type="date" data-app-date-from name="from" value="'+e(draft.from)+'" max="'+today+'" required></label>'+
      '<label>To<input type="date" data-app-date-to name="to" value="'+e(draft.to)+'" max="'+today+'" required></label></div>'+
      (calendarError?'<p class="sng-calendar-error" role="alert">'+e(calendarError)+'</p>':'')+
      '<div class="sng-date-actions"><button type="submit">Apply range</button><button type="button" data-app-date-cancel>Cancel</button></div></form>':'';
    return '<div class="sng-range" role="group" aria-label="Date range">'+presets+calendarButton+'</div>'+
      form+'<p class="sng-period-label">'+e(rangeName())+'</p>';
  };
  const metric = (label, value, tone = '', symbol = '', delta = null) => `<div class="sng-metric ${tone}"><span>${symbol ? icon(symbol) : ''}${e(label)}</span><strong>${e(value)}</strong>${delta === null ? '' : `<small class="sng-delta" title="Change since the previous refresh of this date range">${delta >= 0 ? '+' : ''}${delta} since last update</small>`}</div>`;
  const hero = (label, value, note, tone = '') => {
    const activity = activityFor(selected(orders));
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
  const productRows = (products, ranked = false) => products.map((product, index) => `<article class="sng-product-row">${ranked ? `<b class="sng-rank">${index + 1}</b>` : ''}<div class="sng-product-image">${image(product)}</div><div class="sng-row-main"><strong>${e(product.name)}</strong><small>${e(product.retailer)} · ${product.quantity} secured · ${product.delivered} delivered</small><div class="sng-progress"><span style="width:${product.quantity ? product.delivered / product.quantity * 100 : 0}%"></span></div></div><div class="sng-row-value"><strong>${money(product.value)}</strong><small>ITEM VALUE (EXCL. FEES)</small></div></article>`).join('') || '<p class="sng-empty">No products in this date range.</p>';
  function orderRows(records, tracking = false) {
    return records.map(order => {
      const stage = shippingStage(order), item = order.items?.[0] || {}, shipping = order.shipping || {};
      const steps = ['ordered', 'shipped', 'in_transit', 'delivered'];
      const step = stage === 'out_for_delivery' ? 2 : steps.indexOf(stage);
      const address = shipping.address || {};
      const trackingUrl = /^https:\/\//i.test(shipping.trackingUrl || '') ? shipping.trackingUrl : '';
      const totalLabel = order.orderTotalKnown === false ? 'Total not provided' : money(order.orderTotal);
      return `<details class="sng-order-card stage-${stage}" data-order-id="${e(order.id || order.orderNumber)}" ${expanded.has(order.id || order.orderNumber) ? 'open' : ''}>
        <summary><div class="sng-product-image">${image(item)}</div><div class="sng-row-main"><strong>${e(item.name || `${order.retailer} order`)}</strong><small>${e(order.retailer)} · ${dateLabel(order.checkoutAt)} · ${Number(order.itemCount) || 0} items</small></div><div class="sng-row-value"><strong>${e(totalLabel)}</strong><small class="sng-stage">● ${stageLabels[stage]}</small></div></summary>
        ${stage === 'review_hold' ? '<p class="sng-delivery">Review hold — the retailer is reviewing this order and may still cancel it. Not yet confirmed.</p>' :
          tracking ? stage === 'cancelled' ? '<p class="sng-delivery">Order cancelled — no shipment expected.</p>' :
          `<div class="sng-shipping-steps">${steps.map((s, i) => `<span class="${i <= step ? 'done' : ''}">${stageLabels[s]}</span>`).join('')}</div><p class="sng-delivery">${stage === 'delivered' ? 'Delivered' : 'Expected delivery'} · ${e(shipping.estimatedDelivery || 'Waiting for carrier update')}</p>` : ''}
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
    const activity = activityFor(records);
    const max = Math.max(1, ...activity.map(day => day.value));
    return `<div class="sng-bar-chart" role="img" aria-label="Order value · ${rangeName()}">${activity.map(day => `<div class="sng-bar-column" title="${e(day.date)}: ${day.count} orders, ${money(day.value)}"><div class="sng-bar" style="height:${Math.max(day.value ? 4 : 0, day.value / max * 100)}%"></div></div>`).join('')}</div><div class="sng-chart-axis"><span>${dateLabel(activity[0]?.date + 'T12:00:00')}</span><span>${dateLabel(activity.at(-1)?.date + 'T12:00:00')}</span></div>`;
  }
  function render() {
    // Keep the native iOS/Android date picker mounted during live refreshes.
    if (calendarOpen && document.activeElement?.matches?.('[data-app-date-from],[data-app-date-to]')) return;
    if (!state.customer) { root.hidden = true; document.body.classList.remove('app-signed-in'); orders = []; cancelledOrders = []; reviewHoldOrders = []; accountId = null; snapshots.clear(); changes.clear(); stream?.close(); stream = null; return; }
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
    const records = selected(orders), totals = dashboardTotals(records), products = dashboardProducts(records);
    const periodKey = days==='custom' ? 'custom:'+customRange?.from+':'+customRange?.to : String(days);
    const previous = snapshots.get(periodKey);
    if (accountId && (!previous || JSON.stringify(previous) !== JSON.stringify(totals))) {
      changes.set(periodKey, metricChanges(previous, totals)); snapshots.set(periodKey, totals);
    }
    const delta = changes.get(periodKey) || { orders: 0, transit: 0, delivered: 0 };
    const content = document.getElementById('sng-app-content');
    const currentFocus = document.activeElement?.id, cursor = document.activeElement?.selectionStart;
    const common = rangeButtons() + (state.customer.demo || ADMIN_PREVIEW_MODE ? '<div class="sng-demo-label">DEMO · Sample account</div>' : '') + (error ? `<p class="sng-error" role="status">${e(error)} <button type="button" data-app-refresh>Retry</button></p>` : '') + (busy && !accountId ? '<p class="sng-demo-label" role="status">Loading your checkout data…</p>' : '');
    let html = '';
    if (view === 'home') html = common + '<button class="sng-drop-shortcut" type="button" data-app-view="drops"><span><b>LIVE DROP SKUs</b><small>Select products for Target, Walmart, PKC, Costco or Sam’s</small></span><strong>Choose SKUs →</strong></button>' + hero('TOTAL CHECKOUT VALUE', money(totals.spend), `${totals.orders} orders · ${totals.items} items secured · ${state.membership?.name || state.membership?.planName || 'Member'}`) +
      `<button class="sng-arrival" type="button" data-app-view="tracking">${icon('tracking')}<span><strong>${records.filter(r => shippingStage(r) === 'out_for_delivery').length} packages out for delivery</strong><small>View your shipping tracker</small></span><b>›</b></button>` +
      `<div class="sng-metrics three">${metric('ORDERED', totals.orders, '', 'box', delta.orders)}${metric('IN TRANSIT', totals.transit, 'cyan', 'tracking', delta.transit)}${metric('DELIVERED', totals.delivered, 'green', 'home', delta.delivered)}</div><div class="sng-section-title"><h2>Top products</h2><button type="button" data-app-view="products">View all</button></div>${productRows(products.slice(0, 3), true)}<div class="sng-section-title"><h2>Recent orders</h2><button type="button" data-app-view="tracking">Track all</button></div>${orderRows(records.slice(0, 5))}` +
        (holdsInPeriod().length ? `<div class="sng-section-title"><h2>Review holds · not confirmed</h2></div>${orderRows(holdsInPeriod().slice(0, 5), true)}` : '');
    if (view === 'tracking') {
      const trackable = [...records, ...holdsInPeriod(), ...cancelledInPeriod()];
      html = common + hero('IN TRANSIT', `${totals.transit} packages`, `${totals.awaiting} awaiting shipment · ${totals.delivered} delivered`, 'orange') +
        `<label class="sng-search">Search retailer, product or tracking number<input id="sng-search" value="${e(query)}" placeholder="Search packages" type="search"></label><div class="sng-status-filters" role="group" aria-label="Shipping status">${['all', 'ordered', 'shipped', 'in_transit', 'out_for_delivery', 'delivered', 'review_hold', 'cancelled'].map(s => `<button type="button" data-app-status="${s}" aria-pressed="${s === status}">${s === 'all' ? 'All' : stageLabels[s]} <span>${s === 'all' ? trackable.length : trackable.filter(r => shippingStage(r) === s).length}</span></button>`).join('')}</div><div class="sng-section-title"><h2>Packages</h2><span>Live updates</span></div><div id="sng-search-results"></div>`;
    }
    if (view === 'products') html = common + `<div class="sng-segment-label">PRODUCTS SECURED</div>` + hero('PRODUCT VALUE', money(totals.spend), `${totals.items} items · ${products.length} products`, 'pink') +
      `<div class="sng-section-title"><h2>Metrics</h2></div><div class="sng-metrics">${metric('TOTAL QUANTITY', totals.items)}${metric('DELIVERED ORDERS', totals.delivered)}${metric('IN TRANSIT', totals.transit)}${metric('AWAITING SHIPMENT', totals.awaiting)}${metric('ORDER VALUE', money(totals.spend))}${metric('PRODUCTS', products.length)}</div><label class="sng-search">Search products<input id="sng-search" value="${e(query)}" placeholder="Search products" type="search"></label><div class="sng-section-title"><h2>Products <span>${products.length}</span></h2></div><div id="sng-search-results"></div>`;
    if (view === 'history') {
      const activity = activityFor(records);
      const biggest = activity.reduce((best, bucket) => bucket.value > best.value ? bucket : best, { value: 0 });
      const retailers = Object.entries(records.reduce((all, order) => { all[order.retailer] = (all[order.retailer] || 0) + 1; return all; }, {})).sort((a,b) => b[1]-a[1]);
      const statuses = Object.entries(records.reduce((all, order) => { const name = stageLabels[shippingStage(order)]; all[name] = (all[name] || 0) + 1; return all; }, {}));
      html = common + `<div class="sng-segment-label">OVERVIEW · YOUR ORDERS</div>` + hero('TOTAL SPENT · ' + rangeName().toUpperCase(), money(totals.spend), `${totals.orders} orders · avg ${money(totals.orders ? totals.spend / totals.orders : 0)}`, 'insights') +
        `<div class="sng-metrics">${metric('AVG ORDER', money(totals.orders ? totals.spend / totals.orders : 0), 'cyan')}${metric('ORDERS', totals.orders, 'violet')}${metric('BIGGEST PERIOD', money(biggest.value))}${metric('RETAILERS', retailers.length)}</div>` +
        breakdown('By retailer', retailers, totals.orders) + breakdown('By status', statuses, totals.orders) +
        `<div class="sng-section-title"><h2>Order history</h2></div>${orderRows(records)}` +
        (holdsInPeriod().length ? `<div class="sng-section-title"><h2>Review holds — retailer may cancel</h2></div>${orderRows(holdsInPeriod(), true)}` : '') +
        (cancelledInPeriod().length ? `<div class="sng-section-title"><h2>Cancelled / refunded orders</h2></div>${orderRows(cancelledInPeriod(), true)}` : '');
    }
    if (view === 'settings') html = `<div class="sng-page-intro"><h1>Settings</h1><p>Manage your app and account preferences.</p></div><div class="sng-settings-list"><button type="button" data-app-theme>${icon('sun')} ${theme === 'night' ? 'Switch to day mode' : 'Switch to night mode'}</button><button type="button" data-app-notification-settings>${icon('notifications')} Notification preferences</button><button type="button" data-setting-profile="edit-profile">${icon('profile')} Saved information</button><button type="button" data-setting-profile="security">${icon('settings')} Account security</button><button type="button" data-setting-profile="orders">${icon('box')} Billing and orders</button></div>`;
    if (view === 'notifications') html = `<div class="sng-page-intro"><h1>Notifications</h1><p>Orders, shipping and messages from SLABSNGRABSACO.</p></div>`;
    if (view === 'profile') {
      // Keep the app's membership card synchronized with the existing customer account page.
      const membership = state.membership || null;
      const planName = String(membership?.planName || membership?.name || (membership ? 'Membership' : 'No active membership'));
      const allowance = Number(membership?.profiles ?? membership?.profileCount ?? membership?.accounts ?? ({5:10,6:20,7:50})[Number(membership?.tier)] ?? 0);
      const tier = [10, 20, 50].includes(allowance) ? String(allowance) : 'other';
      const savedText = (id, fallback = '—') => {
        const value = document.getElementById(id)?.textContent?.trim();
        return value && value !== '—' ? value : fallback;
      };
      const dateValue = membership?.subscriptionEndDate || membership?.currentPeriodEnd || membership?.cancelAt;
      const parsedEnd = dateValue ? Date.parse(dateValue) : NaN;
      const dateFallback = Number.isFinite(parsedEnd) ? new Date(parsedEnd).toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric'}) : '—';
      const daysFallback = Number.isFinite(parsedEnd) ? String(Math.max(0,Math.ceil((parsedEnd-Date.now()) / 86400000))) : '—';
      const priceFallback = membership?.amount != null ? money(membership.amount) + '/month' : '—';
      const membershipStatus = savedText('membership-status',membership?.status || 'No active membership');
      const membershipPrice = savedText('membership-price',priceFallback);
      const renewalDate = savedText('membership-period-end',dateFallback);
      const daysLeft = savedText('membership-days-remaining',daysFallback);
      const upgrade = document.getElementById('upgrade-membership');
      const menuItems = [['membership','Membership'],['availability','Rentals'],['edit-profile','Saved info'],['orders','Billing orders'],['security','Security']].filter(([id]) => id !== 'availability' || !document.querySelector('[data-account-tab="availability"]')?.hidden);
      const tile = (label,value,detail) => `<div class="sng-membership-stat"><small>${e(label)}</small><strong>${e(value)}</strong><span>${e(detail)}</span></div>`;
      html = `<div class="sng-page-intro sng-membership-heading"><span>YOUR ACCOUNT</span><h1>Membership</h1><p>Your plan, profile allowance, billing and saved settings.</p></div>` +
        (profileTab === 'membership' ?
          `<section class="sng-membership-hero sng-tier-${tier}" aria-label="Current membership">` +
            `<div class="sng-membership-hero-copy"><small>CURRENT MEMBERSHIP</small><h2>${e(planName)}</h2><p>${allowance > 0 ? e(allowance + ' ACO profiles') : 'Your account plan'}</p>` +
            `<span class="sng-membership-status">${e(membershipStatus)}</span></div>` +
            `<div class="sng-membership-emblem" aria-hidden="true">${icon('profile')}</div></section>` +
          `<section class="sng-membership-details" aria-label="Membership details"><div class="sng-membership-details-title"><h2>Plan details</h2><span>YOUR SUBSCRIPTION</span></div>` +
            `<div class="sng-membership-stats">` +
              tile('Monthly membership',membershipPrice,'Your current plan') +
              tile('ACO profiles',savedText('membership-profiles',allowance ? String(allowance) : '—'),'Included with your tier') +
              tile('Renewal / end',renewalDate,'Current billing period') +
              tile('Days remaining',daysLeft,'Until the period ends') +
            `</div><div class="sng-membership-action-row">` +
              `<button type="button" data-app-upgrade ${upgrade?.disabled ? 'disabled' : ''}>${e(upgrade?.textContent?.trim() || 'Manage membership')} ↗</button>` +
              `<button type="button" data-profile-tab="edit-profile">Manage saved info →</button>` +
            `</div></section>` : '') +
        `<div class="sng-member-tools-heading"><h2>Account sections</h2><p>Choose what to manage</p></div>` +
        `<div class="sng-profile-menu" role="group" aria-label="Membership sections">${menuItems.map(([id,label]) => `<button type="button" data-profile-tab="${id}" aria-pressed="${profileTab===id}">${e(label)}</button>`).join('')}</div>` +
        (profileTab === 'membership' ? `<button type="button" class="sng-drop-shortcut sng-membership-drop" data-app-view="drops"><span><b>Choose drop SKUs</b><small>Target · Walmart · PKC · Costco · Sam’s Club</small></span><strong>Open →</strong></button>` : '');
    }
    if (view === 'drops') html = dropEditor.render();
    content.innerHTML = html;
    renderSearch();
    if (currentFocus === 'sng-search') { const input = document.getElementById(currentFocus); input?.focus({ preventScroll: true }); if (input && cursor !== null) input.setSelectionRange(cursor, cursor); }
    renderSetupChecklist();
  }
  function renderSearch() {
    const target = document.getElementById('sng-search-results'); if (!target) return;
    const successes = selected(orders);
    const records = view === 'tracking' ? [...successes, ...holdsInPeriod(), ...cancelledInPeriod()] : successes;
    const needle = query.toLowerCase();
    target.innerHTML = view === 'products' ? productRows(dashboardProducts(successes).filter(p => `${p.name} ${p.retailer}`.toLowerCase().includes(needle))) :
      orderRows(records.filter(order => (status === 'all' || shippingStage(order) === status) && `${order.retailer} ${order.orderNumber} ${order.shipping?.trackingNumber || ''} ${(order.items || []).map(p => p.name).join(' ')}`.toLowerCase().includes(needle)), true);
  }
  function setView(next, { preserveProfileTab = false } = {}) {
    if (!labels[next]) return;
    // Tapping the centered Membership tab always opens the plan summary.
    if (next === 'profile' && !preserveProfileTab) profileTab = 'membership';
    view = next; query = ''; calendarOpen=false; document.body.dataset.appView = view;
    if (location.hash !== '#my-profile') go('my-profile');
    if (view === 'notifications') document.querySelector('button[data-account-tab="notifications"]')?.click();
    if (view === 'profile') document.querySelector(`button[data-account-tab="${profileTab}"]`)?.click();
    render();
    if (view === 'drops' && !dropEditor.isDirty()) void dropEditor.load();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
  root.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button) return;
    if (dropEditor.handleClick(button)) return;
    if (button.dataset.appView) setView(button.dataset.appView);
    if (button.dataset.appDays) {
      days = /^(ytd|all)$/.test(button.dataset.appDays) ? button.dataset.appDays : Number(button.dataset.appDays);
      calendarOpen=false; calendarError=''; render(); void refresh();
    }
    if (button.hasAttribute('data-app-calendar')) {
      calendarOpen=!calendarOpen; calendarError='';
      if(calendarOpen)calendarDraft=customRange?{...customRange}:defaultDraft();
      render();
    }
    if (button.hasAttribute('data-app-date-cancel')) {calendarOpen=false;calendarError='';render();}
    if (button.dataset.appStatus) { status = button.dataset.appStatus; render(); }
    if (button.hasAttribute('data-app-upgrade')) { document.getElementById('upgrade-membership')?.click(); return; }
    if (button.dataset.profileTab) { profileTab = button.dataset.profileTab; document.querySelector(`button[data-account-tab="${profileTab}"]`)?.click(); render(); }
    if (button.dataset.settingProfile) { profileTab = button.dataset.settingProfile; setView('profile', { preserveProfileTab: true }); }
    if (button.hasAttribute('data-app-theme')) { theme = theme === 'night' ? 'day' : 'night'; try { localStorage.setItem('sng-app-theme', theme); } catch {} render(); }
    if (button.hasAttribute('data-app-notification-settings')) document.getElementById('account-notification-settings')?.click();
    if (button.hasAttribute('data-app-refresh')) void refresh();
  });
  root.addEventListener('input', event => {
    if (event.target.id === 'sng-search') { query = event.target.value; renderSearch(); }
    if (event.target.hasAttribute('data-app-date-from')) calendarDraft.from=event.target.value;
    if (event.target.hasAttribute('data-app-date-to')) calendarDraft.to=event.target.value;
  });
  root.addEventListener('change', event => { dropEditor.handleChange(event.target); });
  root.addEventListener('submit', event => {
    if(!event.target.matches('[data-app-date-form]'))return;
    event.preventDefault();
    const from=event.target.querySelector('[data-app-date-from]')?.value||'';
    const to=event.target.querySelector('[data-app-date-to]')?.value||'';
    calendarDraft={from,to};
    const bounds=customDateBounds(calendarDraft);
    if(!bounds || to>dayKey(new Date())){
      calendarError='Choose valid dates from oldest to newest, ending no later than today.';render();return;
    }
    customRange={...calendarDraft};days='custom';calendarOpen=false;calendarError='';
    render();void refresh();
  });
  root.addEventListener('toggle', event => {
    dropEditor.handleToggle(event.target);
    if (event.target.matches('details[data-order-id]')) {
      const id = event.target.dataset.orderId;
      event.target.open ? expanded.add(id) : expanded.delete(id);
    }
  }, true);
  async function refresh() {
    if (!state.customer || document.hidden) return render();
    if (busy) { queued = true; return; }
    const id = state.customer.id; busy = true;
    try {
      if (ADMIN_PREVIEW_MODE) {
        orders = adminPreviewSuccessData().recentCheckouts;
        cancelledOrders = [];
        reviewHoldOrders = [];
      } else {
        const end = new Date(), start = new Date(); start.setUTCDate(start.getUTCDate() - 365);
        // Fetch the entire requested custom window, even when it predates
        // the default 365-day app window. The API remains authoritative.
        const queryStart = days==='custom' && customRange ? customRange.from :
          days==='all' ? '1970-01-01' : start.toISOString().slice(0,10);
        const queryEnd = days==='custom' && customRange ? customRange.to : end.toISOString().slice(0,10);
        const response = await fetch(`/api/account/success?appView=1&start=${encodeURIComponent(queryStart)}&end=${encodeURIComponent(queryEnd)}`, { credentials: 'same-origin', cache: 'no-store' });
        const data = await readJson(response);
        if (!response.ok) throw new Error(data.error || 'Unable to refresh order data.');
        if (state.customer?.id !== id) return;
        orders = Array.isArray(data.checkouts) ? data.checkouts : data.recentCheckouts || [];
        cancelledOrders = Array.isArray(data.cancelledCheckouts) ?
          data.cancelledCheckouts.filter(order => visibleLateCancellation(order)) : [];
        reviewHoldOrders = Array.isArray(data.reviewHoldCheckouts) ?
          data.reviewHoldCheckouts.filter(order => order.status === 'review_hold') : [];
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
    stream.addEventListener('data-change', () => void refresh());
    stream.addEventListener('open', () => void refresh());
  }
  document.addEventListener('account-session-changed', () => {
    if (!state.customer || (accountId && state.customer.id !== accountId)) dropEditor.reset();
    render(); connect();
    if (state.customer && state.customer.id !== accountId) {
      snapshots.clear(); changes.clear(); void refresh();
    }
  });
  document.addEventListener('account-data-updated', () => { render(); void refresh(); });
  document.addEventListener('account-notifications-updated', render);
  document.addEventListener('visibilitychange', () => { connect(); if (!document.hidden) void refresh(); });
  window.addEventListener('pageshow', () => { connect(); void refresh(); });
  window.addEventListener('pagehide', () => { stream?.close(); stream = null; });
  document.getElementById('app-demo-tools')?.addEventListener('click', () => setTimeout(() => void refresh(), 800));
  document.addEventListener('click', event => { if (event.target.closest('[data-demo-event]')) setTimeout(() => void refresh(), 800); });
  setInterval(() => { if (!document.hidden && state.customer) void refresh(); }, 15000);
  render(); connect(); void refresh();
}
