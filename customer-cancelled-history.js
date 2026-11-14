import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// A dismissal changes only what this customer sees. It never deletes an
// authoritative Discord checkout, its audit trail, or anyone else's records.
const DISCORD_ID = /^discord:\d{17,22}:\d{17,22}$/;
const MAX_HIDDEN = 10000;

export function isCancelledCheckout(record) {
  return Boolean(record && (
    record.cancelledAt || record.canceledAt || record.cancelled === true ||
    record.canceled === true || /cancel|refund|failed|declined/i.test(String(record.status || ""))
  ));
}

export function customerCancelledCheckouts(records, {
  accountId, hiddenIds = [], startDate = null, endDate = null, preciseBounds = null
} = {}) {
  const hidden = new Set(hiddenIds);
  return (Array.isArray(records) ? records : []).filter(record => {
    if (!record || String(record.customerAccountId) !== String(accountId) ||
        !DISCORD_ID.test(String(record.id || "")) || !isCancelledCheckout(record)) return false;
    if ([record.id, ...(Array.isArray(record.sourceIds) ? record.sourceIds : [])]
      .some(id => hidden.has(String(id)))) return false;
    const at = Date.parse(record.checkoutAt || "");
    if (!Number.isFinite(at)) return false;
    if (preciseBounds && !(at >= preciseBounds.start && at < preciseBounds.end)) return false;
    const date = new Date(at).toISOString().slice(0, 10);
    return (!startDate || date >= startDate) && (!endDate || date <= endDate);
  }).sort((a, b) => Date.parse(b.checkoutAt) - Date.parse(a.checkoutAt));
}

function hiddenFile(dataDir, accountId) {
  const digest = crypto.createHash("sha256").update(String(accountId)).digest("hex");
  return path.join(dataDir, "customer-hidden-cancelled-orders", digest + ".json");
}

export async function loadHiddenCancelledIds(dataDir, accountId) {
  let raw;
  try {
    raw = await fs.readFile(hiddenFile(dataDir, accountId), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Invalid saved customer order view.");
  return [...new Set(parsed.filter(id => typeof id === "string" && DISCORD_ID.test(id)))];
}

export async function hideCustomerCancelledOrder(dataDir, accountId, orderId) {
  if (typeof orderId !== "string" || !DISCORD_ID.test(orderId))
    throw new Error("Invalid cancelled order ID.");
  const file = hiddenFile(dataDir, accountId);
  const ids = await loadHiddenCancelledIds(dataDir, accountId);
  if (ids.includes(orderId)) return false;
  if (ids.length >= MAX_HIDDEN) throw new Error("Cancelled-order view limit reached.");
  ids.push(orderId);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + process.pid + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
  try {
    await fs.writeFile(temp, JSON.stringify(ids), { mode: 0o600, encoding: "utf8" });
    await fs.rename(temp, file);
  } finally {
    await fs.unlink(temp).catch(error => { if (error?.code !== "ENOENT") throw error; });
  }
  return true;
}
