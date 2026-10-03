import crypto from "node:crypto";
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
async function dm(token, userId, embed, components = []) {
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
    body: JSON.stringify({ embeds: [embed], components, allowed_mentions: { parse: [] } }),
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

export function startMembershipLapseNotificationScheduler({ dataDir, token, adminWebhookUrl = "", getRentalExtensionPrices = null, onRtpFinalReminderExpired = null }) {
  token = String(token || "").trim();
  adminWebhookUrl = String(adminWebhookUrl || "").trim();
  if (!token && !adminWebhookUrl) return;

  const paths = {
    accounts: path.join(dataDir, "customer-accounts.json"),
    paid: path.join(dataDir, "paid-submissions.json"),
    rented: path.join(dataDir, "rental-assignments.json"),
    gifted: path.join(dataDir, "free-assignments.json"),
    state: path.join(dataDir, "membership-lapse-discord-state.json"),
    batches: path.join(dataDir, "discord-renewal-batches.json"),
    rtpFinal: path.join(dataDir, "rtp-final-reminders.json")
  };
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const [accountsRaw, paidRaw, rentedRaw, giftedRaw, stateRaw, rtpFinalRaw] = await Promise.all([
        read(paths.accounts), read(paths.paid), read(paths.rented), read(paths.gifted), read(paths.state, {}), read(paths.rtpFinal, [])
      ]);
      const accounts = new Map(list(accountsRaw).map(a => [String(a?.id || ""), a]));
      const state = stateRaw && typeof stateRaw === "object" ? stateRaw : {};
      let changed = false;
      const now = Date.now();
      const renewalGroups = new Map();
      const renewalBatches = {};
      const rtpFinal = list(rtpFinalRaw);
      let rtpFinalChanged = false;

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
            const hourBucket = end.toISOString().slice(0, 13);
            const groupKey = `${account.id}:${kind}:${stage}:${hourBucket}`;
            if (!renewalGroups.has(groupKey)) {
              renewalGroups.set(groupKey, { account, kind, stage, end, records: [] });
            }
            renewalGroups.get(groupKey).records.push(record);
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

      // Admin-triggered RTP FINAL REMINDER queue. A single combined DM is sent
      // per customer for all profiles currently queued for the one-hour return.
      const rtpGroups = new Map();
      for (const item of rtpFinal) {
        if (!item || item.status !== "pending") continue;
        const customerAccountId = String(item.customerAccountId || "");
        const account = accounts.get(customerAccountId);
        const type = item.type === "free" ? "free" : "rented";
        const records = type === "free" ? list(giftedRaw) : list(rentedRaw);
        const record = records.find(record => {
          const managedId = String(record?.managedAccountId || record?.rentedMembershipId || record?.freeMembershipId || "");
          return managedId === String(item.managedAccountId || "") &&
            String(record?.customerAccountId || "") === customerAccountId &&
            record?.active === true;
        });

        if (!record) {
          item.status = "cancelled";
          item.cancelledAt = new Date().toISOString();
          item.cancelReason = "no_longer_linked";
          rtpFinalChanged = true;
          continue;
        }

        const originalExpiresAt = String(item.originalExpiresAt || "");
        const currentExpiresAt = String(record?.expiresAt || "");
        const renewedAfterReminder =
          Date.parse(record?.updatedAt || "") > Date.parse(item.triggeredAt || "") &&
          currentExpiresAt &&
          currentExpiresAt !== originalExpiresAt &&
          Date.parse(currentExpiresAt) > Date.parse(item.returnAt || "");

        if (renewedAfterReminder) {
          item.status = "reactivated";
          item.reactivatedAt = new Date().toISOString();
          rtpFinalChanged = true;
          continue;
        }

        const dueAt = date(item.returnAt);
        if (!dueAt) {
          item.status = "cancelled";
          item.cancelledAt = new Date().toISOString();
          item.cancelReason = "invalid_deadline";
          rtpFinalChanged = true;
          continue;
        }

        if (dueAt.getTime() <= now) {
          try {
            if (typeof onRtpFinalReminderExpired === "function") {
              const released = await onRtpFinalReminderExpired({
                type,
                managedAccountId: String(item.managedAccountId || ""),
                customerAccountId
              });
              if (released !== false) {
                item.status = "returned";
                item.returnedAt = new Date().toISOString();
                rtpFinalChanged = true;
              }
            }
          } catch (e) {
            console.error("RTP final reminder return:", e.message);
          }
          continue;
        }

        if (!account || item.sentAt) continue;
        const groupKey = String(account.id);
        if (!rtpGroups.has(groupKey)) rtpGroups.set(groupKey, { account, items: [] });
        rtpGroups.get(groupKey).items.push({ item, record, type, dueAt });
      }

      for (const group of rtpGroups.values()) {
        const sorted = group.items.sort((a, b) => a.dueAt - b.dueAt);
        const rentedItems = sorted.filter(entry => entry.type === "rented");
        const retailerCounts = {};
        const retailerManagedAccountIds = {};
        const lines = sorted.map(entry => {
          const retailerRaw = String(entry.record?.rentalRetailer || entry.record?.assignmentRetailer || entry.record?.referralRetailer || entry.record?.retailer || "Other");
          const retailerKey = retailerRaw.toLowerCase();
          const retailerLabel = retailerKey.includes("pokemon") ? "Pokémon Center" :
            retailerKey.includes("walmart") ? "Walmart" :
            retailerKey.includes("target") ? "Target" : retailerRaw;
          const profile = String(entry.record?.customerProfile?.profileName || entry.record?.profileName || entry.record?.customerProfile?.email || "Linked profile");
          if (entry.type === "rented") {
            retailerCounts[retailerKey] = (retailerCounts[retailerKey] || 0) + 1;
            if (!retailerManagedAccountIds[retailerKey]) retailerManagedAccountIds[retailerKey] = [];
            retailerManagedAccountIds[retailerKey].push(String(entry.item.managedAccountId || ""));
          }
          return `• **${retailerLabel}** — ${profile}`;
        }).join("\n");

        let components = [];
        if (rentedItems.length) {
          const tokenValue = crypto.createHash("sha256")
            .update(`rtp-final|${group.account.id}|${sorted.map(entry => entry.item.managedAccountId).join(",")}|${sorted[0].item.triggeredAt}`)
            .digest("hex").slice(0, 16);
          const prices = typeof getRentalExtensionPrices === "function" ? await getRentalExtensionPrices() : null;
          renewalBatches[tokenValue] = {
            token: tokenValue,
            customerAccountId: String(group.account.id),
            discordUserId: discordId(group.account),
            kind: "rented",
            stage: "rtp_final",
            expiresAt: sorted[0].item.returnAt,
            managedAccountIds: rentedItems.map(entry => String(entry.item.managedAccountId || "")).filter(Boolean),
            retailerCounts,
            retailerManagedAccountIds,
            prices,
            createdAt: new Date().toISOString()
          };
          components = [{ type: 1, components: [
            { type: 2, style: 1, label: `Reactivate All ${rentedItems.length}`, custom_id: `renewbatch:all:${tokenValue}` },
            { type: 2, style: 2, label: "Choose by Retailer", custom_id: `renewbatch:retailers:${tokenValue}` }
          ] }];
        }

        const embed = {
          title: "🚨 RTP FINAL REMINDER — 1 HOUR",
          description:
            `The linked profile${sorted.length === 1 ? "" : "s"} below ${sorted.length === 1 ? "is" : "are"} scheduled to go inactive and return to the retailer pool in about **1 hour** unless reactivated.\n\n${lines}\n\nScheduled return: **${fmt(sorted[0].dueAt)}**\n\n${rentedItems.length ? "Use the buttons below to reactivate rented profiles. Completing the renewal before the deadline cancels their automatic return." : "These profiles will be unlinked automatically at the deadline unless they are reactivated before then."}`,
          color: 0xe74c3c,
          footer: { text: "SLABSNGRABSACO final return-to-pool reminder" },
          timestamp: new Date().toISOString()
        };

        try {
          if (await dm(token, discordId(group.account), embed, components)) {
            for (const entry of sorted) {
              entry.item.sentAt = new Date().toISOString();
              rtpFinalChanged = true;
            }
          }
        } catch (e) {
          console.error("RTP final reminder DM:", e.message);
        }
      }

      for (const group of renewalGroups.values()) {
        const sorted = [...group.records].sort((a, b) => {
          const aStart = Date.parse(a?.startsAt || a?.createdAt || "") || 0;
          const bStart = Date.parse(b?.startsAt || b?.createdAt || "") || 0;
          if (aStart !== bStart) return aStart - bStart;
          return (Date.parse(b?.updatedAt || "") || 0) - (Date.parse(a?.updatedAt || "") || 0);
        });
        const ids = sorted.map(record => String(record?.managedAccountId || record?.rentedMembershipId || record?.freeMembershipId || "")).filter(Boolean);
        if (!ids.length) continue;
        const tokenValue = crypto.createHash("sha256")
          .update(`${group.account.id}|${group.kind}|${group.stage}|${group.end.toISOString().slice(0,13)}`)
          .digest("hex").slice(0, 16);
        const notice = `batch:${tokenValue}:${group.stage}`;
        const retailerCounts = {};
        const retailerManagedAccountIds = {};
        for (const record of sorted) {
          const retailer = String(record?.rentalRetailer || record?.assignmentRetailer || record?.referralRetailer || record?.retailer || "other").toLowerCase();
          const managedId = String(record?.managedAccountId || record?.rentedMembershipId || record?.freeMembershipId || "");
          retailerCounts[retailer] = (retailerCounts[retailer] || 0) + 1;
          if (!retailerManagedAccountIds[retailer]) retailerManagedAccountIds[retailer] = [];
          if (managedId) retailerManagedAccountIds[retailer].push(managedId);
        }
        let prices = null;
        if (group.kind === "rented" && typeof getRentalExtensionPrices === "function") {
          prices = await getRentalExtensionPrices();
        }
        renewalBatches[tokenValue] = {
          token: tokenValue,
          customerAccountId: String(group.account.id),
          discordUserId: discordId(group.account),
          kind: group.kind,
          stage: group.stage,
          expiresAt: group.end.toISOString(),
          managedAccountIds: ids,
          retailerCounts,
          retailerManagedAccountIds,
          prices,
          createdAt: new Date().toISOString()
        };
        if (state[notice]) continue;
        const breakdown = Object.entries(retailerCounts)
          .map(([retailer, count]) => `• ${retailer === "pokemoncenter" ? "Pokémon Center" : retailer.charAt(0).toUpperCase() + retailer.slice(1)}: **${count}**`)
          .join("\n");
        const count = ids.length;
        const embed = {
          title: `${group.stage === "1d" ? "⚠️" : "⏰"} ${count} ${group.kind === "rented" ? "rental" : "gifted"} profile${count === 1 ? "" : "s"} expiring soon`,
          description: `You have **${count}** ${group.kind === "rented" ? "rental" : "gifted"} profile${count === 1 ? "" : "s"} expiring **${fmt(group.end)}**.\n\n${breakdown}\n\n${group.kind === "rented" ? "Choose how many profiles you want to keep. You will see the total price before any payment step." : "This is one combined reminder so you are not sent a separate message for every profile."}`,
          color: group.stage === "1d" ? 0xe67e22 : 0xf1c40f,
          footer: { text: "SLABSNGRABSACO renewal reminder" },
          timestamp: new Date().toISOString()
        };
        let components = [];
        if (group.kind === "rented") {
          components = [
            { type: 1, components: [
              { type: 2, style: 1, label: `Renew All ${count}`, custom_id: `renewbatch:all:${tokenValue}` },
              { type: 2, style: 2, label: "Choose by Retailer", custom_id: `renewbatch:retailers:${tokenValue}` }
            ] }
          ];
        }
        try {
          if (await dm(token, discordId(group.account), embed, components)) {
            state[notice] = new Date().toISOString();
            changed = true;
          }
        } catch (e) {
          console.error(`${group.kind} grouped lapse DM:`, e.message);
        }
      }
      await save(paths.batches, renewalBatches);
      if (rtpFinalChanged) await save(paths.rtpFinal, rtpFinal);
      if (changed) await save(paths.state, state);
    } catch (e) { console.error("Membership lapse notification scheduler:", e.message); }
    finally { running = false; }
  };
  void run();
  const timer = setInterval(() => void run(), 15 * 60 * 1000);
  timer.unref?.();
  console.log("Membership lapse Discord notifications enabled.");
}