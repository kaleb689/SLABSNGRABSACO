import {createHash} from "node:crypto";

// Time-bounded, owner-confirmed recovery of two screenshots provided by the
// account administrator on Oct 15, 2026. Both the checkout login and the
// external bot's exact Profile label must agree. Neither a generic profile
// name nor a member billing email is authority for other customer orders.
// Hashes keep original customer login email and profile labels out of Git.
const screenshots = Object.freeze([
  { ref: "20261015-pkc-verified-1", day: "2026-10-15", retailer: "PKC",
    loginHash: "79117d5deb5b6c3e6e8f08ba7129648ba40599cb307eb998cce0dd1b35fa7dae",
    profileHash: "3338bd7e162c67720bf72708dae53619427c299f0d4c1f39837d3fceed066303",
    firstNameHash: "07d046d5fac12b3f82daf5035b9aae86db5adc8275ebfbf05ec83005a4a8ba3e" },
  { ref: "20261015-pkc-verified-2", day: "2026-10-15", retailer: "PKC",
    loginHash: "fa9f4877444e23222f46c2df25692b80bc145db87a0cda198c4c144bb58476d9",
    profileHash: "e90ec00186b4a69454dcac9edf16a22e4d1172a52ba77e95ff841ecc168a4905",
    firstNameHash: "8a81e9a2dbdc9ccf4ac5091a8a3458b529de766c3320138cf1f9708e537afb01" }
]);

const hash = value => createHash("sha256").update(String(value)).digest("hex");
const normalize = value => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
const localDay = timestamp => {
  const time = new Date(timestamp || "");
  if (!Number.isFinite(time.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"
  }).formatToParts(time);
  const part = key => parts.find(item => item.type === key)?.value || "";
  return [part("year"),part("month"),part("day")].join("-");
};

export function ownerVerifiedScreenshotRef(order, identity, approvedScreenshots = screenshots) {
  if (!/^discord:\d{17,22}:\d{17,22}$/.test(String(order?.id || "")) ||
      order?.retailer !== "PKC" || !order?.orderNumber ||
      order?.status !== "confirmed" || !Array.isArray(order?.items) ||
      !order.items.length) return null;

  // These verified screenshots each contain the same four 30th Celebration
  // mini-tins. Never backfill a different purchase from the same bot profile.
  const products = order.items.map(item => normalize(item.name)
    .replace(/[–—−]/g, "-"));
  const expected = ["mew", "pikachu", "espeon", "lapras"];
  if (products.length !== expected.length || !expected.every(name =>
    products.some(product =>
      product.includes("30th celebration") && /mini[ -]?tin/.test(product) &&
      new RegExp("\\b" + name + "\\b").test(product)
    ))) return null;
  const day = localDay(order.checkoutAt);
  const login = normalize(identity?.email);
  const label = normalize(identity?.profileName);
  if (!login || !label) return null;
  return approvedScreenshots.find(item => item.day === day && item.retailer === order.retailer &&
    item.loginHash === hash(login) && item.profileHash === hash(label))?.ref || null;
}

// Only the EXACT, administrator-verified source checkout can be restored.
// Fail closed if the customer first name is not unique or if retailer login
// history supplies ANY different member owner. Never move an owned order.
export function resolveOwnerVerifiedScreenshots(order, identity, customers = [], candidates = [], approvedScreenshots = screenshots) {
  const ref = ownerVerifiedScreenshotRef(order, identity, approvedScreenshots);
  if (!ref) return null;
  const evidence = approvedScreenshots.find(item => item.ref === ref);
  const eligibleCustomers = customers.filter(account => {
    const firstName = normalize(account?.firstName || account?.profile?.firstName ||
      String(account?.name || account?.displayName || "").split(/\s+/)[0]);
    return Boolean(account?.id) && !account.disabled && hash(firstName) === evidence.firstNameHash;
  });
  if (eligibleCustomers.length !== 1) return null;
  const account = eligibleCustomers[0];
  const conflictingOwner = candidates.some(candidate =>
    candidate.retailer === order.retailer &&
    normalize(candidate.email) === normalize(identity.email) &&
    candidate.customerAccountId &&
    String(candidate.customerAccountId) !== String(account.id));
  if (conflictingOwner) return null;
  const sameOwner = candidates.find(candidate =>
    candidate.retailer === order.retailer &&
    normalize(candidate.email) === normalize(identity.email) &&
    String(candidate.customerAccountId || "") === String(account.id));
  const attribution = {
    customerAccountId: String(account.id),
    attributionSource: "admin-confirmed-2026-10-15-checkout-evidence",
    ownerBackfillApproval: evidence.ref
  };
  if (sameOwner) for (const key of [
    "profileName","profileSlot","managedAccountId","managedAssignmentId","managedAssignmentType"
  ]) if (sameOwner[key] != null) attribution[key] = sameOwner[key];
  return attribution;
}
