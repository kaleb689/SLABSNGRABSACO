/**
 * Server-side filtering/pagination for the admin managed-pool browser.
 * Only pass sanitized display metadata, not decrypted credentials.
 */
const RETAILERS = new Set(["target", "walmart", "pokemoncenter"]);
const STATUSES = new Set(["available", "linked", "held", "needs_repair", "duplicate"]);

export function searchManagedPoolProfiles(records, options = {}) {
  const query = String(options.query ?? "").trim().toLowerCase().slice(0, 150);
  const retailer = String(options.retailer ?? "all").trim().toLowerCase();
  const status = String(options.status ?? "all").trim().toLowerCase();
  const rawPage = Number(options.page);
  const page = Number.isSafeInteger(rawPage) && rawPage > 0
    ? Math.min(rawPage, 100000) : 1;
  const pageSize = 30;
  const filtered = (Array.isArray(records) ? records : []).filter(profile => {
    if (RETAILERS.has(retailer) && profile.retailer !== retailer) return false;
    if (STATUSES.has(status) && profile.status !== status) return false;
    if (!query) return true;
    return [
      profile.id, profile.retailer, profile.loginEmail, profile.profileName,
      profile.accountEmail, profile.status, profile.assignedTo?.name,
      profile.assignedTo?.email, profile.assignmentType
    ].some(value => String(value ?? "").toLowerCase().includes(query));
  });
  filtered.sort((a, b) =>
    a.retailer.localeCompare(b.retailer) ||
    a.loginEmail.localeCompare(b.loginEmail) ||
    a.id.localeCompare(b.id));
  return {
    profiles: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(filtered.length / pageSize))
  };
}
