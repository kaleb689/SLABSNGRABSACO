// Explicit, administrator-reviewed aliases for external Discord checkout profile labels.
// Never infer a customer's identity from a partial or fuzzy profile-name match.
export function normalizeCheckoutProfileLabel(value) {
  return String(value || "").normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase().replace(/\s+/g, " ");
}

export function checkoutAliasKey(retailer, label) {
  const site = String(retailer || "").trim().toLowerCase();
  const name = normalizeCheckoutProfileLabel(label);
  return site && name ? site + "|" + name : "";
}

export function resolveApprovedCheckoutAlias(order, candidates, mappings, isEligible) {
  const key = checkoutAliasKey(order?.retailer, order?.sourceProfileLabel);
  if (!key || !Array.isArray(mappings)) return null;
  const approvedOwners = new Set(mappings
    .filter(mapping => !mapping.disabledAt &&
      checkoutAliasKey(mapping.retailer, mapping.profileLabel) === key)
    .map(mapping => String(mapping.customerAccountId || "")).filter(Boolean));
  if (approvedOwners.size !== 1) return null;
  const selectedId = [...approvedOwners][0];
  const eligible = (Array.isArray(candidates) ? candidates : [])
    .filter(candidate => String(candidate.customerAccountId || "") === selectedId &&
      isEligible(candidate, order));
  if (!eligible.length) return null;
  // Ambiguous profile slots within one customer must not fabricate a managed ID.
  const distinctManaged = [...new Set(eligible.map(item => String(item.managedAccountId || "")))];
  const unique = eligible.length === 1 || distinctManaged.length === 1;
  const profile = unique ? eligible[0] : null;
  return {
    customerAccountId: selectedId,
    ...(profile?.managedAccountId ? { managedAccountId: profile.managedAccountId } : {}),
    ...(profile?.managedAssignmentId ? { managedAssignmentId: profile.managedAssignmentId } : {}),
    ...(profile?.managedAssignmentType ? { managedAssignmentType: profile.managedAssignmentType } : {}),
    ...(profile?.profileName ? { profileName: profile.profileName } : {}),
    ...(profile?.profileSlot != null ? { profileSlot: profile.profileSlot } : {})
  };
}
