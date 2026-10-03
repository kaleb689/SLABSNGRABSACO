import fs from "node:fs/promises";
import path from "node:path";
import { sendDiscordLapseChecklistAlert } from "./discord-community.js";

const API = "https://discord.com/api/v10";
const DAY = 86400000;

async function read(file, fallback = []) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (e) { if (e?.code === "ENOENT") return fallback; throw e; }
}
async function save(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}
function list(value) { return Array.isArray(value) ? value : []; }
function date(value) {
  const d = value ? new Date(value) : null;
  return d && Number.isFinite(d.getTime()) ? d : null;
}
function fmt(value) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", month: "long", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short"
  }).format(value);
}
function discordId(account) {
  return String(account?.discordUserId || account?.discordId || "").trim();
}
async function dm(token, userId, embed) {
  if (!token || !/^\d{17,22}$/.test(userId)) return false;
  const headers = { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
  const opened = await fetch(`${API}/users/@me/channels`, {
    method: "POST", headers, body: JSON.stringify({ recipient_id: userId }),
    signal: AbortSignal.timeout(10000)
  });
  if (!opened.ok) throw new Error(`DM open HTTP ${opened.status}`);
  const channel = await opened.json();
  const sent = await fetch(`${API}/channels/${channel.id}/messages`, {
    method: "POST", headers,
    body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(10000)
  });
  if (!sent.ok) throw new Error(`DM send HTTP ${sent.status}`);
  return true;
}
async function admin() { return false; }
function label(record, kind) {
  const retailer = String(record?.retailerLabel || record?.retailer || "").trim();
  const profile = String(record?.profileName || record?.customerProfile?.profileName || record?.managedAccountName || "").trim();
  return [retailer, profile].filter(Boolean).join(" — ") || (kind === "rented" ? "Rented account" : "Gifted account");
}
function key(record, kind) {
  const id = record?.assignmentId || record?.id || record?.rentedMembershipId || record?.freeMembershipId || record?.managedAccountId;
  return id ? `${kind}:${id}` : "";
}
function reminder(kind, item, end, stage) {
  const membership = kind === "membership";
  return {
    title: `${stage === "1d" ? "⚠️" : "⏰"} ${membership ? "Membership" : kind === "rented" ? "Rental" : "Gifted account"} ending soon`,
    description: `**${item}**\n\nEnds: **${fmt(end)}**\n\n${membership
      ? "Your membership is scheduled to stop renewing. Renew/reactivate it before this date if you want to continue."
      : "Renew this access before the expiration date if you want to continue using it."}`,
    color: stage === "1d" ? 0xe67e22 : 0xf1c40f,
    footer: { text: "SLABSNGRABSACO renewal reminder" },
    timestamp: new Date().toISOString()
  };
}

export function startMembershipLapseNotificationScheduler({ dataDir, token, adminWebhookUrl = "" }) {
  token = String(token || "").trim();
  adminWebhookUrl = String(adminWebhookUrl || "").trim();
  if (!token && !adminWebhookUrl) return;

  const paths = {
    accounts: path.join(dataDir, "customer-accounts.json"),
    paid: path.join(dataDir, "paid-submissions.json"),
    rented: path.join(dataDir, "rental-assignments.json"),
    gifted: path.join(dataDir, "free-assignments.json"),
    state: path.join(dataDir, "membership-lapse-discord-state.json")
  };
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const [accountsRaw, paidRaw, rentedRaw, giftedRaw, stateRaw] = await Promise.all([
        read(paths.accounts), read(paths.paid), read(paths.rented), read(paths.gifted), read(paths.state, {})
      ]);
      const accounts = new Map(list(accountsRaw).map(a => [String(a?.id || ""), a]));
      const state = stateRaw && typeof stateRaw === "object" ? stateRaw : {};
      let changed = false;
      const now = Date.now();

      for (const record of list(paidRaw)) {
        if (record?.cancelAtPeriodEnd !== true) continue;
        const end = date(record?.subscriptionEndDate || record?.currentPeriodEnd || record?.cancelAt);
        const account = accounts.get(String(record?.customerAccountId || ""));
        if (!end || !account || end.getTime() <= now || end.getTime() - now > 3 * DAY) continue;
        const stage = end.getTime() - now <= DAY ? "1d" : "3d";
        const notice = `membership:${record?.stripeSubscriptionId || record?.id || account.id}:${end.toISOString()}:${stage}`;
        if (state[notice]) continue;
        try {
          if (await dm(token, discordId(account), reminder("membership", record?.plan?.name || "Membership", end, stage))) {
            state[notice] = new Date().toISOString(); changed = true;
          }
        } catch (e) { console.error("Membership lapse DM:", e.message); }
      }

      for (const [kind, records] of [["rented", list(rentedRaw)], ["gifted", list(giftedRaw)]]) {
        for (const record of records) {
          const base = key(record, kind), end = date(record?.expiresAt);
          if (!base || !end) continue;
          const snapshotKey = `${base}:snapshot`;
          const account = accounts.get(String(record?.customerAccountId || state[snapshotKey]?.customerAccountId || ""));
          if (record?.active === true && record?.customerAccountId) {
            state[snapshotKey] = {
              customerAccountId: String(record.customerAccountId),
              name: String(account?.displayName || account?.name || account?.email || "Member"),
              email: String(account?.email || ""),
              item: label(record, kind),
              retailerAccountEmail: String(record?.customerProfile?.email || ""),
              expiresAt: end.toISOString()
            };
            changed = true;
          }
          const remaining = end.getTime() - now;
          if (remaining > 0 && remaining <= 3 * DAY && record?.active === true && account) {
            const stage = remaining <= DAY ? "1d" : "3d";
            const notice = `${base}:${end.toISOString()}:${stage}`;
            if (!state[notice]) {
              try {
                if (await dm(token, discordId(account), reminder(kind, label(record, kind), end, stage))) {
                  state[notice] = new Date().toISOString(); changed = true;
                }
              } catch (e) { console.error(`${kind} lapse DM:`, e.message); }
            }
          }
          const manuallyReturned = ["returned_to_pool", "returned", "released", "admin_returned"].includes(String(record?.endReason || "").toLowerCase());
          if (remaining <= 0 && !manuallyReturned) {
            const notice = `${base}:${end.toISOString()}:admin`, snap = state[snapshotKey] || {};
            // Never backfill historical assignments that no longer have a known owner.
            // A snapshot is created while the assignment is active, before it expires.
            if (!state[notice] && snap.customerAccountId && snap.email) {
              try {
                const retailer = String(record?.rentalRetailer || record?.assignmentRetailer || record?.referralRetailer || record?.retailer || "Unknown");
                const retailerAccountEmail = String(record?.customerProfile?.email || snap.retailerAccountEmail || "Not available");
                if (await sendDiscordLapseChecklistAlert({
                  customerName: snap.name,
                  customerEmail: snap.email,
                  retailer,
                  retailerAccountEmail,
                  profileType: kind === "rented" ? "Rented account" : "Gifted account",
                  expiresAt: snap.expiresAt || end.toISOString(),
                  trackingId: base
                })) { state[notice] = new Date().toISOString(); changed = true; }
              } catch (e) { console.error(`${kind} lapse admin alert:`, e.message); }
            }
          }
        }
      }
      if (changed) await save(paths.state, state);
    } catch (e) { console.error("Membership lapse notification scheduler:", e.message); }
    finally { running = false; }
  };
  void run();
  const timer = setInterval(() => void run(), 15 * 60 * 1000);
  timer.unref?.();
  console.log("Membership lapse Discord notifications enabled.");
}
