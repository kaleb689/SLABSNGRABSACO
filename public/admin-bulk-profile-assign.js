(() => {
  'use strict';
  const STORE = {
    emailsText: '', retailer: 'all', customerAccountId: '', assignmentType: 'free',
    durationType: '1_week', customDurationAmount: '10', customDurationUnit: 'days'
  };
  const REASONS = {
    ready:'Ready to link',
    not_found:'Email not found in the selected retailer pool',
    unavailable:'Assigned, held, needing repair, or otherwise unavailable',
    ambiguous:'More than one matching account: choose a specific retailer',
    shared_record:'Another email in this paste belongs to the same account record'
  };
  const make = (tag, text, className = '') => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = String(text || '');
    return node;
  };
  const api = async (url, body) => {
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET', credentials:'same-origin', cache:'no-store',
      ...(body ? { headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) } : {})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(response.status === 401
      ? 'Admin session expired. Sign in again.'
      : data.error || 'Unable to access the profile pool.');
    return data;
  };
  const getDuration = () => STORE.durationType === 'custom'
    ? STORE.customDurationAmount + ' ' + STORE.customDurationUnit
    : ({ '1_drop':'1 drop (24 hours)', '1_week':'1 week', '1_month':'1 month',
        indefinite:'no expiration' }[STORE.durationType]);

  function mount(root) {
    if (!root || root.dataset.bulkMounted) return;
    root.dataset.bulkMounted = 'true';
    root.classList.add('admin-bulk-profile-assign');
    root.innerHTML = `
      <header><small>ADMIN · UNUSED PROFILE ASSIGNMENTS</small>
        <h2>Bulk assign profiles by email</h2>
        <p>Paste existing retailer login emails, select one member, and choose how
          long their assignments last. Preview all matches before assigning.</p>
      </header>
      <form>
        <label>Retailer profile emails
          <textarea name="emailsText" rows="5" spellcheck="false" autocapitalize="off"
            placeholder="account1@example.com&#10;account2@example.com&#10;account3@example.com"></textarea>
          <small>One per line or comma-separated. Up to 1,000 emails; no passwords.</small>
        </label>
        <div class="admin-bulk-profile-grid">
          <label>Retailer pool<select name="retailer">
            <option value="all">Target + Pokémon Center</option>
            <option value="target">Target only</option>
            <option value="pokemoncenter">Pokémon Center only</option>
          </select></label>
          <label>Member<select name="customerAccountId"><option value="">Loading active members...</option></select></label>
          <label>Assignment type<select name="assignmentType">
            <option value="free">Gifted (manual)</option>
            <option value="rented">Rented (manual; no automatic charge)</option>
          </select></label>
          <label>How long?<select name="durationType">
            <option value="1_drop">1 drop (24 hours)</option>
            <option value="1_week">1 week</option><option value="1_month">1 month</option>
            <option value="custom">Custom duration</option>
            <option value="indefinite">Indefinite</option>
          </select></label>
          <div class="admin-bulk-profile-custom" hidden>
            <label>Amount<input name="customDurationAmount" type="number" min="1" step="1" inputmode="numeric"></label>
            <label>Unit<select name="customDurationUnit">
              <option value="hours">Hours</option><option value="days">Days</option>
              <option value="weeks">Weeks</option><option value="months">Months</option>
              <option value="years">Years</option>
            </select></label>
          </div>
        </div>
        <p class="admin-bulk-profile-note">Only live, unassigned Target/PKC inventory is eligible;
          Walmart Unused remains owner-only. The timer starts when Admin activates
          each assigned profile. Existing expiration and Restore Hold policies apply.</p>
        <div class="admin-bulk-profile-actions">
          <button type="button" data-preview>Preview exact matches</button>
          <button type="submit" data-assign disabled>Assign verified profiles</button>
        </div>
        <p class="admin-bulk-profile-status" role="status" aria-live="polite"></p>
        <div class="admin-bulk-profile-results"></div>
      </form>
    `;
    const form = root.querySelector('form');
    const status = root.querySelector('.admin-bulk-profile-status');
    const results = root.querySelector('.admin-bulk-profile-results');
    const previewButton = root.querySelector('[data-preview]');
    const assignButton = root.querySelector('[data-assign]');
    const customFields = root.querySelector('.admin-bulk-profile-custom');
    let preview = null, busy = false;
    const setStatus = message => { status.textContent = message; };
    const setCustom = () => { customFields.hidden = STORE.durationType !== 'custom'; };
    const resetPreview = () => {
      preview = null; assignButton.disabled = true; results.replaceChildren();
      setStatus('Preview the updated emails to verify availability.');
    };
    for (const name of Object.keys(STORE)) {
      const input = form.elements.namedItem(name);
      input.value = STORE[name];
      const onValue = () => {
        STORE[name] = input.value;
        if (name === 'durationType') setCustom();
        if (name === 'customerAccountId') {
          assignButton.disabled = busy || !preview || preview.blocked > 0 ||
            !preview.ready || !STORE.customerAccountId;
        } else resetPreview();
      };
      input.addEventListener('change', onValue);
      input.addEventListener('input', onValue);
    }
    setCustom();

    async function loadCustomers() {
      const select = form.elements.namedItem('customerAccountId');
      try {
        const data = await api('/api/admin/managed-pool/search?retailer=target&status=available&page=1');
        if (!root.isConnected) return;
        select.replaceChildren(new Option('Choose active member', ''));
        for (const person of data.customers || []) {
          select.add(new Option(person.name + ' — ' + person.email, String(person.id)));
        }
        if ([...select.options].some(opt => opt.value === STORE.customerAccountId)) {
          select.value = STORE.customerAccountId;
        } else { select.value = ''; STORE.customerAccountId = ''; }
        if (!data.customers?.length) setStatus('No eligible members found. Check membership status.');
      } catch (error) {
        select.replaceChildren(new Option('Member list unavailable', ''));
        setStatus(error.message);
      }
    }
    function showPreview(data) {
      results.replaceChildren();
      results.append(make('p',
        data.ready + ' ready · ' + data.blocked + ' blocked · ' + data.total +
        ' unique email(s)' + (data.duplicates ? ' · ' + data.duplicates + ' duplicate paste entries ignored' : ''),
        'admin-bulk-profile-summary'));
      if (data.blocked) results.append(make('p',
        'No changes will be made until blocked emails are removed or resolved.',
        'admin-bulk-profile-warning'));
      const list = make('div', '', 'admin-bulk-profile-result-list');
      const ordered = [...data.rows.filter(row => row.status !== 'ready'),
        ...data.rows.filter(row => row.status === 'ready')];
      for (const row of ordered.slice(0, 200)) {
        const item = make('div', '', 'admin-bulk-profile-result');
        item.dataset.status = row.status;
        item.append(make('strong', row.email));
        item.append(make('span',
          (row.retailer ? (row.retailer === 'target' ? 'Target' : 'Pokémon Center') + ' · ' : '') +
          (REASONS[row.status] || row.status)));
        list.append(item);
      }
      results.append(list);
      if (ordered.length > 200) results.append(make('small', 'Showing first 200 of ' + data.total + ' checked emails.'));
    }
    previewButton.addEventListener('click', async () => {
      if (busy) return;
      busy = true; previewButton.disabled = true; assignButton.disabled = true;
      setStatus('Matching emails to the current Unused pools...');
      try {
        preview = await api('/api/admin/managed-pool/bulk-assign/preview',
          { emailsText:STORE.emailsText, retailer:STORE.retailer });
        showPreview(preview);
        setStatus(preview.blocked ? 'Resolve or remove blocked emails before assigning.' :
          preview.ready + ' exact profile matches verified.');
        assignButton.disabled = !preview.ready || !!preview.blocked || !STORE.customerAccountId;
      } catch (error) { preview = null; results.replaceChildren(); setStatus(error.message); }
      finally { busy = false; previewButton.disabled = false; }
    });

    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy || !preview || preview.blocked || !preview.ready) return;
      const member = form.elements.namedItem('customerAccountId').selectedOptions[0]?.textContent || '';
      if (!STORE.customerAccountId) { setStatus('Select a member first.'); return; }
      const type = STORE.assignmentType === 'free' ? 'Gifted' : 'Rented, without automatic charge';
      if (!confirm('Assign ' + preview.ready + ' profile(s) to ' + member +
          '?\nType: ' + type + '\nDuration: ' + getDuration() +
          '\nTime begins upon Admin activation.\n\nThis updates real customer assignments.')) return;
      busy = true; assignButton.disabled = previewButton.disabled = true;
      setStatus('Assigning ' + preview.ready + ' selected profiles...');
      try {
        const data = await api('/api/admin/managed-pool/bulk-assign',
          {...STORE, confirmed:true});
        preview = null; STORE.emailsText = '';
        form.elements.namedItem('emailsText').value = ''; results.replaceChildren();
        setStatus(data.assigned + ' profiles linked to ' + member +
          '. Awaiting Admin activation.' +
          (data.notificationFailures ? ' Check Admin for failed Discord notifications.' : ''));
        if (typeof window.refreshAdminPoolSearch === 'function') void window.refreshAdminPoolSearch();
      } catch (error) { preview = null; setStatus(error.message + ' Preview again to retry safely.'); }
      finally { busy = false; previewButton.disabled = false; assignButton.disabled = true; }
    });
    void loadCustomers();
  }

  function mountDesktop() {
    const parent = document.getElementById('adminAvailablePage');
    const browser = document.getElementById('adminPoolBrowser');
    if (!parent || !browser || !parent.contains(browser) ||
        parent.querySelector('#adminBulkProfileDesktop')) return;
    const root = document.createElement('section');
    root.id = 'adminBulkProfileDesktop'; parent.insertBefore(root, browser); mount(root);
  }
  function mountMobile() {
    const content = document.getElementById('content');
    const workspace = document.getElementById('workspace');
    if (!content || !workspace || workspace.hidden ||
        document.getElementById('heading')?.textContent !== 'Profiles' ||
        content.querySelector('#adminBulkProfileMobile')) return;
    const root = document.createElement('section'); root.id = 'adminBulkProfileMobile';
    content.prepend(root); mount(root);
  }
  function init() {
    mountDesktop(); mountMobile();
    const content = document.getElementById('content');
    if (content) new MutationObserver(mountMobile).observe(content, {childList:true});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true});
  else init();
})();
