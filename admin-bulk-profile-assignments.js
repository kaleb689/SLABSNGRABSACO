import crypto from 'node:crypto';

const ASSIGNABLE_RETAILERS = ['target', 'pokemoncenter'];
const EMAIL = /^[^\s@:,;]+@[^\s@:,;]+\.[^\s@:,;]+$/;
const MAX_EMAILS = 1000;
const LIMITS = { hours: 87600, days: 3650, weeks: 520, months: 120, years: 10 };
const PRESET_DURATIONS = new Set(['1_drop', '1_week', '1_month', 'indefinite']);

function inputError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function parseBulkProfileEmails(raw) {
  if (typeof raw !== 'string' || raw.length > 100000) {
    throw inputError('Paste a list of profile login emails, up to 1,000 accounts.');
  }
  const parts = raw.split(/[\s,;]+/).filter(Boolean);
  if (!parts.length || parts.length > MAX_EMAILS) {
    throw inputError('Enter between 1 and 1,000 profile login emails.');
  }
  const emails = [];
  const seen = new Set();
  let duplicates = 0;
  for (const part of parts) {
    const email = part.trim().toLowerCase();
    if (email.length > 254 || !EMAIL.test(email)) {
      throw inputError('Invalid profile login email: ' + part.slice(0, 80) + '. Paste emails only, not passwords.');
    }
    if (seen.has(email)) { duplicates++; continue; }
    seen.add(email);
    emails.push(email);
  }
  return { emails, duplicates };
}

export function normalizeBulkProfileDuration(body = {}) {
  const type = String(body.durationType || '').trim().toLowerCase();
  if (PRESET_DURATIONS.has(type)) return { durationType: type };
  if (type !== 'custom') throw inputError('Choose a valid assignment duration.');
  const unit = String(body.customDurationUnit || '').trim().toLowerCase();
  const amount = Number(body.customDurationAmount);
  if (!Object.hasOwn(LIMITS, unit) || !Number.isSafeInteger(amount) ||
      amount < 1 || amount > LIMITS[unit]) {
    throw inputError('Choose a whole-number custom duration within 10 years.');
  }
  return { durationType: 'custom', customDurationAmount: amount, customDurationUnit: unit };
}

// Custom durations start on Admin activation, not on the day they are pasted.
export function customProfileExpiration(startValue, amountValue, unit) {
  const amount = Number(amountValue);
  if (!Object.hasOwn(LIMITS, unit) || !Number.isSafeInteger(amount) ||
      amount < 1 || amount > LIMITS[unit]) return null;
  const date = new Date(startValue);
  if (!Number.isFinite(date.getTime())) return null;
  if (unit === 'hours') date.setUTCHours(date.getUTCHours() + amount);
  if (unit === 'days') date.setUTCDate(date.getUTCDate() + amount);
  if (unit === 'weeks') date.setUTCDate(date.getUTCDate() + 7 * amount);
  if (unit === 'months' || unit === 'years') {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    if (unit === 'months') date.setUTCMonth(date.getUTCMonth() + amount);
    else date.setUTCFullYear(date.getUTCFullYear() + amount);
    const monthLastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, monthLastDay));
  }
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function resolveBulkProfileMatches({ emails, retailer, managed, availableByRetailer, decodeCredentials }) {
  const selected = retailer === 'all' ? ASSIGNABLE_RETAILERS : [retailer];
  if (!selected.length || selected.some(key => !ASSIGNABLE_RETAILERS.includes(key))) {
    throw inputError('Walmart Unused is owner-only. Choose Target, Pokemon Center, or both.');
  }
  const wanted = new Set(emails);
  const matches = new Map(emails.map(email => [email, []]));
  for (const account of managed) {
    // Never silently skip a broken encrypted record: fail safely rather than
    // mistakenly treating its email as missing or assignable.
    const credentials = decodeCredentials(account);
    for (const key of selected) {
      const email = String(credentials?.[key]?.username || '').trim().toLowerCase();
      if (!wanted.has(email)) continue;
      matches.get(email).push({ account, retailer: key });
    }
  }
  const selectedIds = new Set();
  return emails.map(email => {
    const found = matches.get(email);
    if (!found.length) return { email, status: 'not_found' };
    if (found.length > 1) return { email, status: 'ambiguous' };
    const { account, retailer: key } = found[0];
    const id = String(account.id || '');
    if (!id || !availableByRetailer[key]?.has(id)) {
      return { email, retailer: key, status: 'unavailable' };
    }
    if (selectedIds.has(id)) return { email, retailer: key, status: 'shared_record' };
    selectedIds.add(id);
    return { email, retailer: key, managedAccountId: id,
      profileName: String(account.profileName || ''), status: 'ready', account };
  });
}

export function registerAdminBulkProfileAssignments({
  app, requireAdmin, serialize, getManagedAccounts, getAvailableManagedAccountsForRetailer,
  getRestoreHolds, heldManagedAccountIdsFromHolds,
  getCustomerAccounts, activeMembershipForCustomer,
  getFreeAssignments, saveFreeAssignments, getRentalAssignments, saveRentalAssignments,
  normalizeRetailerCredentials, decryptJson, sanitizeProfile, membershipEncryptedPackage,
  encryptJson, prepareNewManagedAssignment, ensureManagedProfileDiscordMessage,
  broadcastLiveDataChange = () => {}
}) {
  const json = (res, code, body) => { res.set('Cache-Control', 'no-store'); return res.status(code).json(body); };
  const preview = async body => {
    const { emails, duplicates } = parseBulkProfileEmails(body?.emailsText);
    const retailer = String(body?.retailer || 'all').toLowerCase();
    if (!['all', ...ASSIGNABLE_RETAILERS].includes(retailer)) {
      throw inputError('Walmart Unused is owner-only and is not customer-assignable.');
    }
    const selected = retailer === 'all' ? ASSIGNABLE_RETAILERS : [retailer];
    const [managed, ...available] = await Promise.all([
      getManagedAccounts(), ...selected.map(key => getAvailableManagedAccountsForRetailer(key))
    ]);
    // This existing pool helper prioritizes held stock LAST but still returns it.
    // Bulk assignment is specifically Unused-only: exclude every Restore Hold.
    const held = heldManagedAccountIdsFromHolds(await getRestoreHolds());
    const availableByRetailer = Object.fromEntries(selected.map((key, i) =>
      [key, new Set(available[i].filter(account => !held.has(String(account.id)))
        .map(account => String(account.id)))]));
    const rows = resolveBulkProfileMatches({ emails, retailer, managed, availableByRetailer,
      decodeCredentials: account => account.credentials
        ? normalizeRetailerCredentials(decryptJson(account.credentials)) : {} });
    const ready = rows.filter(row => row.status === 'ready');
    return { rows, ready, duplicates, total: emails.length, blocked: rows.length - ready.length };
  };
  const publicPreview = result => ({
    ok: true, total: result.total, ready: result.ready.length,
    blocked: result.blocked, duplicates: result.duplicates,
    rows: result.rows.map(({ account, ...display }) => display)
  });

  app.post('/api/admin/managed-pool/bulk-assign/preview', requireAdmin, async (req, res) => {
    try { return json(res, 200, publicPreview(await preview(req.body))); }
    catch (error) {
      if (!error.status) console.error('Bulk assignment preview:', error?.message);
      return json(res, error.status || 503, { error: error.status ? error.message : 'Could not verify Unused profiles.' });
    }
  });

  app.post('/api/admin/managed-pool/bulk-assign', requireAdmin, serialize, async (req, res) => {
    try {
      if (req.body?.confirmed !== true) throw inputError('Confirm this bulk customer assignment.');
      const accountId = String(req.body?.customerAccountId || '').trim().slice(0, 150);
      const type = String(req.body?.assignmentType || 'free').trim().toLowerCase();
      if (!['free', 'rented'].includes(type)) throw inputError('Choose Gifted or Rented.');
      const duration = normalizeBulkProfileDuration(req.body);
      const accounts = await getCustomerAccounts();
      const customer = accounts.find(account => String(account.id) === accountId && account.disabled !== true);
      if (!customer) throw inputError('Choose an existing enabled customer account.');
      const paid = await activeMembershipForCustomer(accountId);
      if (!paid) throw inputError('The selected customer needs an active paid or gifted membership.', 403);
      const selection = await preview(req.body);
      if (selection.blocked || !selection.ready.length) {
        return json(res, 409, { ...publicPreview(selection), ok: false,
          error: 'Some pasted emails are no longer available or uniquely matched. No profiles were assigned.' });
      }
      const existing = type === 'free' ? await getFreeAssignments() : await getRentalAssignments();
      const now = new Date().toISOString();
      const customerProfile = sanitizeProfile(paid.profile || {});
      const secretPackage = await membershipEncryptedPackage(paid);
      const encryptedSecrets = secretPackage ? encryptJson(secretPackage) : null;
      const reservedJigs = new Set();
      const created = [];
      for (const row of selection.ready) {
        const assignment = {
          id: crypto.randomUUID(), managedAccountId: row.managedAccountId,
          customerAccountId: accountId, paidSubmissionId: paid.id, active: true,
          ...duration, activationStatus: 'awaiting_activation',
          activationRequestedAt: now, startsAt: null, expiresAt: null,
          customerProfile, customerSecrets: encryptedSecrets,
          createdAt: now, updatedAt: now, endedAt: null, endReason: null,
          bulkAdminAssignment: true
        };
        if (type === 'free') {
          assignment.freeMembershipId = row.managedAccountId;
          assignment.assignmentRetailer = row.retailer;
        } else {
          assignment.rentedMembershipId = row.managedAccountId;
          assignment.rentalRetailer = row.retailer;
          assignment.stripeSubscriptionId = null;
          assignment.stripeCustomerId = paid.stripeCustomerId || null;
        }
        await prepareNewManagedAssignment(assignment, row.account, customer, paid, reservedJigs);
        existing.push(assignment);
        created.push(assignment);
      }
      // One ledger write for the entire batch. No partial assignment response.
      if (type === 'free') await saveFreeAssignments(existing);
      else await saveRentalAssignments(existing);
      try { broadcastLiveDataChange('admin-bulk-profile-assigned'); }
      catch (error) { console.error('Bulk assignment live broadcast:', error?.message); }
      let notificationFailures = 0;
      for (const record of created) {
        try { await ensureManagedProfileDiscordMessage(record, type); }
        catch (error) { notificationFailures++; console.error('Bulk assignment notification:', error?.message); }
      }
      try {
        if (type === 'free') await saveFreeAssignments(existing);
        else await saveRentalAssignments(existing);
      } catch (error) {
        // Assignments already committed. Do not return a retryable failure.
        console.error('Bulk assignment Discord ID persistence:', error?.message);
        notificationFailures++;
      }
      return json(res, 200, { ok: true, assigned: created.length, customerAccountId: accountId,
        assignmentType: type, durationType: duration.durationType,
        awaitingActivation: created.length, notificationFailures,
        message: 'Profiles linked to the selected customer. Their timer begins on Admin activation.' });
    } catch (error) {
      if (!error.status) console.error('Admin bulk profile assignment:', error?.message);
      return json(res, error.status || 503, { error: error.status ? error.message : 'Bulk assignment could not be completed. Reload the profile list before retrying.' });
    }
  });
}
