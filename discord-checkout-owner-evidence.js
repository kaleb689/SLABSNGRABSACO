/**
 * Trust an Admin-entered managed retailer Account Email only as an exact
 * alternative login for a specific, historically assigned retailer account.
 * Never infer customer ownership from website billing email, a fuzzy profile
 * label, or an ambiguous multi-retailer inventory record.
 */
const sites = {
  target:"Target", targetgo:"Target", walmart:"Walmart", walmartgo:"Walmart",
  pkc:"PKC", pokemoncenter:"PKC", "pokemon center":"PKC",
  samsclub:"Sam's Club", "sam's club":"Sam's Club", costco:"Costco"
};
function retailer(value) {
  return sites[String(value || "").trim().toLowerCase()] || "";
}

// Ownership begins when the exact account is linked, not when its billing
// clock is later activated or restarted. Ended assignments remain bounded.
export function checkoutAssignmentContains(assignment, checkoutAt) {
  const at = Date.parse(checkoutAt || "");
  // Activation is NOT an ownership prerequisite. In older assignments the
  // original link timestamp was saved as activationRequestedAt but createdAt
  // was absent. Accept that dated, customer-bound assignment from its actual
  // request time; never backdate ownership to the eventual activation date.
  const start = Date.parse(assignment?.createdAt || assignment?.activationRequestedAt ||
    assignment?.startsAt || "");
  if (!Number.isFinite(at) || !Number.isFinite(start) || at < start) return false;
  const endValue = assignment.endedAt || assignment.returnedToPoolAt || assignment.expiresAt;
  if (!endValue) return true;
  const end = Date.parse(endValue);
  return Number.isFinite(end) && at <= end;
}

// Expiry cleanup removes the former customer from the reusable assignment.
// A restore hold is explicit internal ownership evidence only when it points
// to that exact assignment AND managed account. Never use the current owner.
export function recoverCheckoutAssignmentOwners(assignments, holds) {
  return assignments.map(assignment => {
    if (assignment.customerAccountId) return assignment;
    const matches = [];
    for (const hold of holds || []) for (const item of hold.items || []) {
      if (!hold.customerAccountId || !assignment.id ||
          String(item.previousAssignmentId || "") !== String(assignment.id) ||
          String(item.managedAccountId || "") !== String(assignment.managedAccountId || "")) continue;
      const endedAt = assignment.endedAt || item.heldAt;
      if (!Number.isFinite(Date.parse(endedAt || ""))) continue;
      matches.push({owner:String(hold.customerAccountId), endedAt, retailer:item.retailer});
    }
    if (!matches.length || new Set(matches.map(item => item.owner)).size !== 1) return assignment;
    const proof = matches.sort((a,b) => Date.parse(a.endedAt)-Date.parse(b.endedAt))[0];
    return {...assignment, customerAccountId:proof.owner, endedAt:proof.endedAt,
      assignmentRetailer:assignment.assignmentRetailer || assignment.rentalRetailer || proof.retailer};
  });
}
export function managedAccountEmailEvidence(account, credentials, assignment) {
  const loginEmails = [...new Set(Object.values(credentials || {}).map(login =>
    String(login?.username || "").trim().toLowerCase()).filter(Boolean))];
  // Old single-login imports kept the one retailer login in a generic slot.
  // Its explicit historical retailer assignment supplies the retailer scope.
  const canonical = account?.accountEmail || account?.displayEmail ||
    (loginEmails.length === 1 ? loginEmails[0] : "");
  const email = String(canonical).trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) return null;
  const saved = Object.entries(credentials || {})
    .filter(([, login]) => Boolean(String(login?.username || "").trim()))
    .map(([key]) => retailer(key)).filter(Boolean);
  const possible = [...new Set(saved)];
  const assignmentSite = retailer(assignment?.rentalRetailer ||
    assignment?.assignmentRetailer || assignment?.retailer || account?.retailer);
  // An explicit assignment cannot contradict the saved inventory retailers.
  const poolSite = retailer(account?.retailer);
  if (assignmentSite && poolSite && assignmentSite !== poolSite) return null;
  // Older retailer-specific pool imports put the login in a legacy credential
  // slot. The explicit pool AND assignment must agree before using its saved
  // canonical Account Email; a different retailer slot cannot override them.
  const singleLoginMatches = loginEmails.length === 1 && loginEmails[0] === email;
  if (assignmentSite && possible.length && !possible.includes(assignmentSite) &&
      poolSite !== assignmentSite && !singleLoginMatches) return null;
  const site = assignmentSite || (possible.length === 1 ? possible[0] : "");
  if (!site) return null;
  // Do not duplicate a candidate already generated from the encrypted login.
  if (Object.entries(credentials || {}).some(([key, login]) =>
    retailer(key) === site && String(login?.username || "").trim().toLowerCase() === email)) return null;
  return { email, retailer: site };
}
