// Customer app SKU selections use the Discord bot's existing source of truth.
// One Qty 1/Qty 2 choice applies to every SKU in the full submission.
const RETAILERS = [
  ['target', 'Target'], ['walmart', 'Walmart'], ['pokemon', 'Pokémon Center (PKC)'],
  ['costco', 'Costco'], ['sams', "Sam's Club"],
  ['tonight', 'Dropping Tonight'], ['upcoming', 'Upcoming Drops']
];
const keyOf = source => String(source.channelId) + ':' + String(source.sourceId);

export function hydrateDropSkuState(value) {
  const sources = Array.isArray(value?.sources) ? value.sources.filter(s =>
    s && s.channelId && s.sourceId && Array.isArray(s.products)) : [];
  const saved = new Set(Array.isArray(value?.selectedKeys) ? value.selectedKeys : []);
  const optedOut = new Set(Array.isArray(value?.optedOutKeys) ? value.optedOutKeys : []);
  return {
    sources,
    entries: new Map(sources.map(s => [keyOf(s), {
      selected: new Set(s.products.filter(p => saved.has(keyOf(s) + ':' + String(p.sku)))
        .map(p => String(p.sku))),
      skip: optedOut.has(keyOf(s))
    }])),
    quantity: Number(value?.quantity) === 2 ? 2 : 1,
    savedAt: value?.savedAt || null
  };
}

export function buildDropSkuSubmission(state) {
  return {
    quantity: Number(state.quantity) === 2 ? 2 : 1,
    sources: state.sources.map(source => {
      const choice = state.entries.get(keyOf(source));
      return {
        channelId: String(source.channelId),
        sourceId: String(source.sourceId),
        skip: Boolean(choice?.skip),
        skus: choice?.skip ? [] : source.products.filter(p =>
          choice?.selected.has(String(p.sku))).map(p => String(p.sku))
      };
    })
  };
}

export function createCustomerDropEditor({ escape, onUpdate }) {
  let state = hydrateDropSkuState({});
  let loaded = false, loading = false, saving = false, dirty = false;
  let error = '', notice = '';
  const opened = new Set();
  const update = () => { if (typeof onUpdate === 'function') onUpdate(); };

  function reset() {
    state = hydrateDropSkuState({});
    loaded = loading = saving = dirty = false;
    error = notice = '';
    opened.clear();
    update();
  }

  async function load() {
    if (loading || saving || dirty) return;
    loading = true; error = ''; update();
    try {
      const response = await fetch('/api/account/drop-skus', {
        credentials: 'same-origin', cache: 'no-store'
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Unable to load live drop SKUs.');
      state = hydrateDropSkuState(data);
      loaded = true;
    } catch (failure) {
      error = failure.message || 'Unable to load drop SKUs.';
    } finally { loading = false; update(); }
  }

  async function save() {
    if (!loaded || loading || saving) return;
    const payload = buildDropSkuSubmission(state);
    if (payload.sources.reduce((total, row) => total + row.skus.length, 0) > 200) {
      error = 'You can select up to 200 SKUs across all drops.';
      update(); return;
    }
    saving = true; error = notice = ''; update();
    try {
      const response = await fetch('/api/account/drop-skus', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Unable to save drop selections.');
      dirty = false;
      notice = data.unchanged ? 'Your selections are already up to date.' :
        'Saved. Admin received your selected SKUs and shared quantity in Discord.';
      const fresh = await fetch('/api/account/drop-skus', {
        credentials: 'same-origin', cache: 'no-store'
      });
      if (fresh.ok) state = hydrateDropSkuState(await fresh.json());
    } catch (failure) {
      error = failure.message || 'Unable to save drop selections.';
    } finally { saving = false; update(); }
  }

  function render() {
    const e = escape;
    let html = '<section class="sng-drop-intro"><small>LIVE DISCORD DROPS</small><h1>Choose your drop SKUs</h1>' +
      '<p>Select Target, Walmart, Pokémon Center (PKC), Costco or Sam’s Club products. Expand any drop, ' +
      'choose products, close the dropdown and submit changes when ready.</p></section>';
    if (error) html += '<p class="sng-drop-error" role="alert">' + e(error) + '</p>';
    if (loading && !loaded) return html + '<p class="sng-drop-notice" role="status">Loading current drops…</p>';
    if (!loaded) return html + '<button type="button" class="sng-drop-retry" data-drop-retry>Retry loading drops</button>';
    if (notice) html += '<p class="sng-drop-notice" role="status">' + e(notice) + '</p>';
    const count = [...state.entries.values()].reduce((n, v) => n + (v.skip ? 0 : v.selected.size), 0);
    const allSkipped = state.sources.length > 0 && [...state.entries.values()].every(v => v.skip);
    html += '<section class="sng-drop-quantity"><div><small>ONE QUANTITY FOR ALL SKUs</small>' +
      '<strong>Qty ' + state.quantity + ' for every selected product</strong>' +
      '<p>Mixing quantities between products is not allowed.</p></div>' +
      '<div class="sng-drop-qty-options">' + [1,2].map(q =>
        '<button type="button" data-drop-qty="' + q + '" aria-pressed="' + (state.quantity === q) +
        '"' + (saving ? ' disabled' : '') + '>Qty ' + q + '</button>').join('') + '</div></section>';
    html += '<div class="sng-drop-master-actions">' +
      '<button type="button" data-drop-all' + (saving || !state.sources.length ? ' disabled' : '') +
      '>Select all SKUs</button>' +
      '<button type="button" data-drop-skip-all aria-pressed="' + allSkipped + '"' +
      (saving || !state.sources.length ? ' disabled' : '') + '>Don’t run my account</button></div>';
    for (const [retailer, label] of RETAILERS) {
      const sources = state.sources.filter(s => String(s.retailer || '') === retailer);
      if (!sources.length && (retailer === 'tonight' || retailer === 'upcoming')) continue;
      html += '<section class="sng-drop-retailer" data-retailer="' + retailer + '">' +
        '<header><h2>' + e(label) + '</h2><small>' + sources.length + ' active drop' +
        (sources.length === 1 ? '' : 's') + '</small></header>';
      if (!sources.length) html += '<p class="sng-drop-empty">No SKUs posted yet.</p>';
      for (const source of sources) {
        const key = keyOf(source), choice = state.entries.get(key);
        const selected = choice?.skip ? 0 : choice?.selected.size || 0;
        html += '<details class="sng-drop-source" data-drop-source="' + e(key) + '"' +
          (opened.has(key) ? ' open' : '') + '><summary><span><strong>' + e(source.label || label) +
          '</strong><small>' + (choice?.skip ? 'Not running' : selected + ' of ' +
          source.products.length + ' SKUs selected') + '</small></span><b aria-hidden="true">⌄</b></summary>' +
          '<div class="sng-drop-source-body"><div class="sng-drop-actions">' +
          '<button type="button" data-drop-source-all="' + e(key) + '"' +
          (saving || !source.products.length ? ' disabled' : '') + '>Run all SKUs</button>' +
          '<button type="button" data-drop-source-skip="' + e(key) + '" aria-pressed="' +
          Boolean(choice?.skip) + '"' + (saving ? ' disabled' : '') +
          '>Don’t run this drop</button></div><div class="sng-drop-products">' +
          source.products.map(p => '<label class="sng-drop-product"><input type="checkbox"' +
            ' data-drop-source-key="' + e(key) + '" data-drop-product-sku="' + e(p.sku) +
            '"' + (choice?.selected.has(String(p.sku)) && !choice.skip ? ' checked' : '') +
            (saving ? ' disabled' : '') + '><span><b>' + e(p.sku) + '</b><small>' +
            e(p.name || 'Product') + '</small></span></label>').join('') +
          (source.products.length ? '' : '<p class="sng-drop-empty">No products in this drop.</p>') +
          '</div></div></details>';
      }
      html += '</section>';
    }
    if (!state.sources.length) html += '<p class="sng-drop-empty">No active Discord drop posts available.</p>';
    html += '<div class="sng-drop-submit"><span><strong>' + count + ' SKUs selected</strong>' +
      '<small>Qty ' + state.quantity + ' applies to all · Submit to save</small></span>' +
      '<button type="button" data-drop-submit' +
      (saving || loading || !state.sources.length ? ' disabled' : '') + '>' +
      (saving ? 'Saving…' : 'Submit changes') + '</button></div>';
    return html;
  }

  function handleClick(button) {
    if (button.hasAttribute('data-drop-retry')) { void load(); return true; }
    if (!loaded || loading || saving) return false;
    if (button.hasAttribute('data-drop-submit')) { void save(); return true; }
    if (button.hasAttribute('data-drop-qty')) {
      state.quantity = Number(button.dataset.dropQty) === 2 ? 2 : 1;
    } else if (button.hasAttribute('data-drop-all')) {
      for (const source of state.sources) {
        const choice = state.entries.get(keyOf(source));
        choice.skip = false;
        choice.selected = new Set(source.products.map(p => String(p.sku)));
      }
    } else if (button.hasAttribute('data-drop-skip-all')) {
      for (const choice of state.entries.values()) { choice.skip = true; choice.selected.clear(); }
    } else if (button.hasAttribute('data-drop-source-all')) {
      const source = state.sources.find(s => keyOf(s) === button.dataset.dropSourceAll);
      const choice = state.entries.get(button.dataset.dropSourceAll);
      if (!source || !choice) return false;
      choice.skip = false;
      choice.selected = new Set(source.products.map(p => String(p.sku)));
    } else if (button.hasAttribute('data-drop-source-skip')) {
      const choice = state.entries.get(button.dataset.dropSourceSkip);
      if (!choice) return false;
      choice.skip = !choice.skip;
      if (choice.skip) choice.selected.clear();
    } else return false;
    dirty = true; notice = error = ''; update();
    return true;
  }

  function handleChange(input) {
    if (!input.hasAttribute('data-drop-product-sku') || !loaded || saving) return false;
    const choice = state.entries.get(input.dataset.dropSourceKey);
    if (!choice) return false;
    if (input.checked) { choice.skip = false; choice.selected.add(input.dataset.dropProductSku); }
    else choice.selected.delete(input.dataset.dropProductSku);
    dirty = true; notice = error = ''; update();
    return true;
  }

  function handleToggle(element) {
    if (!element.matches?.('details[data-drop-source]')) return;
    if (element.open) opened.add(element.dataset.dropSource);
    else opened.delete(element.dataset.dropSource);
  }

  return { render, load, save, reset, handleClick, handleChange, handleToggle,
    isDirty: () => dirty, isLoaded: () => loaded };
}
