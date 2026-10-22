import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const VALID_STAGES = new Set(["shipped", "in_transit", "out_for_delivery", "delivered"]);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalize = value => String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * One durable claim for each Discord recipient/customer/retailer/order/stage.
 * The claim is written BEFORE the external Discord API call. This enforces
 * at-most-once sending even if Discord succeeds but the process then crashes.
 * Only shipping notification metadata is persisted. No card, account, address,
 * email, password, or tracking number is written into the ledger.
 */
export function shippingDiscordDmKey({accountId, discordUserId, retailer, orderNumber, status} = {}) {
  const a = normalize(accountId), d = String(discordUserId ?? "").trim();
  const r = normalize(retailer), o = normalize(orderNumber), stage = normalize(status);
  if (!a || !/^\d{17,22}$/.test(d) || !r || !o || !VALID_STAGES.has(stage)) return null;
  return crypto.createHash("sha256").update(JSON.stringify([a,d,r,o,stage])).digest("hex");
}

export function createShippingDiscordDmLedger({dataDir, fsApi = fs, now = () => Date.now()} = {}) {
  if (!dataDir) throw Error("Shipping notification storage is required.");
  const ledgerPath = path.join(dataDir, "shipping-discord-dm-ledger.json");
  const lockPath = ledgerPath + ".lock";
  let pending = Promise.resolve();

  async function exclusive(job) {
    // The application lock handles in-process concurrency. A lock file guards
    // a shared persistent Render disk if another worker runs at the same time.
    const next = pending.catch(() => {}).then(async () => {
      await fsApi.mkdir(dataDir, {recursive:true, mode:0o700});
      let handle = null;
      for (let i = 0; i < 100; i++) {
        try { handle = await fsApi.open(lockPath, "wx", 0o600); break; }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          const stat = await fsApi.stat(lockPath).catch(e => {
            if (e.code === "ENOENT") return null;
            throw e;
          });
          if (stat && now() - stat.mtimeMs > 120000) {
            // Crash recovery: abandon a dead holder only after two minutes.
            await fsApi.rm(lockPath, {force:true});
          }
          await pause(30);
        }
      }
      if (!handle) throw Error("Shipping notification ledger is busy; no Discord DM was sent.");
      try { return await job(); }
      finally { await handle.close(); await fsApi.rm(lockPath, {force:true}); }
    });
    pending = next.catch(() => {});
    return next;
  }

  async function read() {
    try {
      const stored = JSON.parse(await fsApi.readFile(ledgerPath, "utf8"));
      if (stored?.version !== 1 || !stored.claims || typeof stored.claims !== "object" || Array.isArray(stored.claims)) {
        throw Error("Shipping notification history is invalid; no Discord DM was sent.");
      }
      return stored;
    } catch (error) {
      if (error.code === "ENOENT") return {version:1, claims:{}};
      throw error;
    }
  }

  async function claim(details) {
    const key = shippingDiscordDmKey(details);
    if (!key) return {send:false, reason:"missing_verified_order_or_recipient"};
    return exclusive(async () => {
      const state = await read();
      if (Object.hasOwn(state.claims, key)) return {send:false, reason:"already_notified"};
      state.claims[key] = new Date(now()).toISOString();
      const tmp = ledgerPath + "." + crypto.randomUUID() + ".tmp";
      try {
        await fsApi.writeFile(tmp, JSON.stringify(state), {flag:"wx",mode:0o600});
        await fsApi.rename(tmp, ledgerPath);
      } catch (error) {
        await fsApi.rm(tmp, {force:true}).catch(() => {});
        throw error;
      }
      return {send:true};
    });
  }

  return {claim};
}
