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
export function managedAccountEmailEvidence(account, credentials, assignment) {
  const email = String(account?.accountEmail || "").trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) return null;
  const saved = Object.entries(credentials || {})
    .filter(([, login]) => Boolean(String(login?.username || "").trim()))
    .map(([key]) => retailer(key)).filter(Boolean);
  const possible = [...new Set(saved)];
  const assignmentSite = retailer(assignment?.rentalRetailer ||
    assignment?.assignmentRetailer || assignment?.retailer || account?.retailer);
  // An explicit assignment cannot contradict the saved inventory retailers.
  if (assignmentSite && possible.length && !possible.includes(assignmentSite)) return null;
  const site = assignmentSite || (possible.length === 1 ? possible[0] : "");
  if (!site) return null;
  // Do not duplicate a candidate already generated from the encrypted login.
  if (Object.entries(credentials || {}).some(([key, login]) =>
    retailer(key) === site && String(login?.username || "").trim().toLowerCase() === email)) return null;
  return { email, retailer: site };
}
