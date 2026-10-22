import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Durable, process/restart-safe at-most-once notification delivery claims.
 * An outbound delivery is claimed BEFORE it is sent so ambiguous provider
 * timeouts or restarts never replay that same notification.
 *
 * Keys are hashed. No recipients, card details, addresses, passwords,
 * message text or tracking numbers are stored in this ledger.
 *
 * If delivery fails after claiming, the app retains the original in-app
 * event but does not automatically retry that external delivery. This
 * deliberately favors avoiding duplicate external messages.
 */
export function notificationClaimKey({channel, recipient, eventKey} = {}) {
  const transport = String(channel || "").trim().toLowerCase();
  const destination = String(recipient || "").trim();
  const event = String(eventKey || "").trim();
  if (!/^[a-z][a-z0-9:-]{1,63}$/.test(transport) ||
      !destination || destination.length > 4096 || !event || event.length > 65536)
    return null;
  return crypto.createHash("sha256").update(JSON.stringify([transport,destination,event])).digest("hex");
}

export function createNotificationDeliveryGuard({
  dataDir, fsApi = fs, now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  if (!dataDir) throw Error("Notification ledger needs persistent storage.");
  const file = path.join(dataDir, "notification-delivery-guard.json");
  const lockFile = file + ".lock";
  let queue = Promise.resolve();

  async function read() {
    try {
      const parsed = JSON.parse(await fsApi.readFile(file, "utf8"));
      if (parsed?.version !== 1 || !parsed.claims || Array.isArray(parsed.claims) ||
          typeof parsed.claims !== "object")
        throw Error("Notification ledger is invalid. Sending is disabled to avoid duplicate alerts.");
      return parsed;
    } catch (error) {
      if (error.code === "ENOENT") return {version:1, claims:{}};
      throw error;
    }
  }

  async function lock(operation) {
    const running = queue.catch(() => {}).then(async () => {
      await fsApi.mkdir(dataDir, {recursive:true, mode:0o700});
      let handle = null;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { handle = await fsApi.open(lockFile, "wx", 0o600); break; }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          const stat = await fsApi.stat(lockFile).catch(err => {
            if (err.code === "ENOENT") return null;
            throw err;
          });
          // Recover a lock held by a process that crashed. The normal write
          // takes milliseconds; never steal a recent or unknown holder's lock.
          if (stat && now() - stat.mtimeMs > 5 * 60_000)
            await fsApi.rm(lockFile, {force:true});
          await sleep(30);
        }
      }
      if (!handle) throw Error("Notification ledger is busy; outbound alert was not sent.");
      try { return await operation(); }
      finally {
        await handle.close();
        await fsApi.rm(lockFile, {force:true});
      }
    });
    queue = running.catch(() => {});
    return running;
  }

  async function claim(details) {
    const key = notificationClaimKey(details);
    if (!key) return {send:false, reason:"invalid_event_identity"};
    const windowMs = details?.windowMs === undefined ? null : Number(details.windowMs);
    if (windowMs !== null && (!Number.isSafeInteger(windowMs) || windowMs < 1000 || windowMs > 365*86400000))
      return {send:false, reason:"invalid_deduplication_window"};
    return lock(async () => {
      const state = await read();
      const previous = state.claims[key];
      if (previous && (!previous.expiresAt || previous.expiresAt > now()))
        return {send:false, reason:"already_notified"};
      const issuedAt = new Date(now()).toISOString();
      state.claims[key] = {at:issuedAt, ...(windowMs !== null ? {expiresAt:now()+windowMs}:{})};
      // Clean up short-lived duplicate filters without deleting the permanent
      // per-order/per-membership history.
      for (const [id, item] of Object.entries(state.claims)) {
        if (item?.expiresAt && item.expiresAt <= now()) delete state.claims[id];
      }
      const tmp = file + "." + crypto.randomUUID() + ".tmp";
      try {
        const body = JSON.stringify(state);
        await fsApi.writeFile(tmp, body, {flag:"wx", mode:0o600});
        await fsApi.rename(tmp, file);
      } catch (error) {
        await fsApi.rm(tmp, {force:true}).catch(() => {});
        throw error;
      }
      return {send:true};
    });
  }

  return {claim, file};
}
