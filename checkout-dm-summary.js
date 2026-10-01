import fs from "node:fs/promises";
import path from "node:path";

const DISCORD_API = "https://discord.com/api/v10";
const TIME_ZONE = "America/New_York";
const RUN_HOURS = new Set([8, 20]);
const MAX_SLOT_HISTORY = 90;

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? `$${number.toFixed(2)}` : "$—";
}

function dateParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const out = {};
  for (const part of parts) if (part.type !== "literal") out[part.type] = Number(part.value);
  return out;
}

function wallClockEpoch(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, 0, 0);
}

function zonedToUtc(parts) {
  let guess = wallClockEpoch(parts);
  for (let i = 0; i < 4; i++) {
    const seen = dateParts(new Date(guess));
    const delta = wallClockEpoch(parts) - wallClockEpoch(seen);
    if (!delta) break;
    guess += delta;
  }
  return new Date(guess);
}

function shiftLocalDay(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function slotForNow(now = new Date()) {
  const local = dateParts(now);
  if (!RUN_HOURS.has(local.hour)) return null;
  const endParts = { year: local.year, month: local.month, day: local.day, hour: local.hour, minute: 0 };
  const startDay = local.hour === 8 ? shiftLocalDay(local, -1) : local;
  const startParts = {
    year: startDay.year,
    month: startDay.month,
    day: startDay.day,
    hour: local.hour === 8 ? 20 : 8,
    minute: 0
  };
  return {
    key: `${endParts.year}-${String(endParts.month).padStart(2, "0")}-${String(endParts.day).padStart(2, "0")}T${String(endParts.hour).padStart(2, "0")}:00`,
    start: zonedToUtc(startParts),
    end: zonedToUtc(endParts),
    localEnd: endParts
  };
}

function displayDate(parts) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric"
  }).format(new Date(Date.UTC(parts.year, parts.month - 1, parts.day)));
}

function displayHour(hour) {
  const suffix = hour >= 12 ? "PM" : "AM";
  const value = hour % 12 || 12;
  return `${value}:00 ${suffix}`;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temp, file);
}

function checkoutTime(record) {
  const value = record?.checkoutAt || record?.createdAt || record?.updatedAt;
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function itemQuantity(item) {
  const qty = Number(item?.quantity ?? item?.qty ?? item?.count ?? 1);
  return Number.isFinite(qty) && qty > 0 ? qty : 1;
}

function itemUnitPrice(item, record) {
  for (const candidate of [
    item?.unitPrice,
    item?.price,
    item?.pricePaid,
    item?.unit_price,
    item?.amount
  ]) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  const total = Number(item?.totalPrice ?? item?.total ?? item?.lineTotal);
  const quantity = itemQuantity(item);
  if (Number.isFinite(total) && total >= 0) return total / quantity;
  const items = Array.isArray(record?.items) ? record.items : [];
  if (items.length === 1) {
    const orderTotal = Number(record?.orderTotal);
    if (Number.isFinite(orderTotal) && orderTotal >= 0) return orderTotal / quantity;
  }
  return null;
}

function aggregateItems(records) {
  const retailers = new Map();
  for (const record of records) {
    const retailer = String(record?.retailer || "Other").trim() || "Other";
    if (!retailers.has(retailer)) retailers.set(retailer, new Map());
    const group = retailers.get(retailer);
    const items = Array.isArray(record?.items) && record.items.length
      ? record.items
      : [{ name: "Checkout", quantity: Number(record?.itemCount || 1) || 1 }];
    for (const item of items) {
      const name = String(item?.name || "Item").trim() || "Item";
      const unitPrice = itemUnitPrice(item, record);
      const priceKey = Number.isFinite(unitPrice) ? Number(unitPrice).toFixed(2) : "unknown";
      const key = `${name.toLowerCase()}|${priceKey}`;
      const existing = group.get(key) || { name, quantity: 0, unitPrice };
      existing.quantity += itemQuantity(item);
      group.set(key, existing);
    }
  }
  return retailers;
}

function trimField(value, max = 1024) {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 18)) + "\n…additional items";
}

function buildPayload(records, slot) {
  const retailers = aggregateItems(records);
  const totalItems = records.reduce((sum, record) => {
    const items = Array.isArray(record?.items) ? record.items : [];
    if (items.length) return sum + items.reduce((itemSum, item) => itemSum + itemQuantity(item), 0);
    const count = Number(record?.itemCount || 1);
    return sum + (Number.isFinite(count) && count > 0 ? count : 1);
  }, 0);
  const totalSpent = records.reduce((sum, record) => {
    const value = Number(record?.orderTotal);
    return sum + (Number.isFinite(value) && value >= 0 ? value : 0);
  }, 0);

  const fields = [];
  for (const [retailer, products] of retailers) {
    const lines = [...products.values()].map(product =>
      `• ${product.name} — **x${product.quantity}** — **${money(product.unitPrice)} each**`
    );
    fields.push({
      name: retailer.toUpperCase().slice(0, 256),
      value: trimField(lines.join("\n") || "No item details available"),
      inline: false
    });
  }
  fields.push({
    name: "SUMMARY",
    value: [
      `📦 **TOTAL ITEMS:** ${totalItems}`,
      `✅ **TOTAL CHECKOUTS:** ${records.length}`,
      `💰 **TOTAL SPENT:** ${money(totalSpent)}`
    ].join("\n"),
    inline: false
  });

  return {
    embeds: [{
      title: `🛒 Total Checkouts From ${displayDate(slot.localEnd)}`,
      description: `${displayHour(slot.localEnd.hour === 8 ? 20 : 8)} – ${displayHour(slot.localEnd.hour)} ET\nOnly purchases associated with your SLABSNGRABSACO paid or linked profiles are included.`,
      color: 0x2ecc71,
      fields: fields.slice(0, 25),
      timestamp: slot.end.toISOString()
    }],
    allowed_mentions: { parse: [] }
  };
}

async function sendDm(token, discordUserId, payload) {
  const headers = { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
  const channelResponse = await fetch(`${DISCORD_API}/users/@me/channels`, {
    method: "POST",
    headers,
    body: JSON.stringify({ recipient_id: String(discordUserId) }),
    signal: AbortSignal.timeout(12000)
  });
  if (!channelResponse.ok) throw new Error(`open DM HTTP ${channelResponse.status}`);
  const channel = await channelResponse.json();
  const response = await fetch(`${DISCORD_API}/channels/${channel.id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`send DM HTTP ${response.status}`);
}

export function startCheckoutDmSummaryScheduler({ dataDir, token, getAccounts }) {
  const botToken = String(token || "").trim();
  if (!botToken) {
    console.log("Checkout DM summary scheduler disabled: Discord bot token is not configured.");
    return;
  }
  const successFile = path.join(dataDir, "success-checkouts.json");
  const stateFile = path.join(dataDir, "checkout-dm-summary-state.json");
  let running = false;

  async function tick() {
    if (running) return;
    const slot = slotForNow();
    if (!slot) return;
    running = true;
    try {
      const state = await readJson(stateFile, { slots: {} });
      state.slots ||= {};
      const slotState = state.slots[slot.key] || { attempted: {}, createdAt: new Date().toISOString() };
      slotState.attempted ||= {};

      const successes = await readJson(successFile, []);
      const accounts = await getAccounts();
      const records = (Array.isArray(successes) ? successes : []).filter(record => {
        const time = checkoutTime(record);
        return record?.customerAccountId && time >= slot.start.getTime() && time < slot.end.getTime();
      });

      const byCustomer = new Map();
      for (const record of records) {
        const id = String(record.customerAccountId);
        if (!byCustomer.has(id)) byCustomer.set(id, []);
        byCustomer.get(id).push(record);
      }

      for (const account of Array.isArray(accounts) ? accounts : []) {
        const accountId = String(account?.id || "");
        if (!accountId || slotState.attempted[accountId]) continue;
        const customerRecords = byCustomer.get(accountId) || [];
        if (!customerRecords.length) {
          slotState.attempted[accountId] = { status: "no_checkouts", at: new Date().toISOString() };
          continue;
        }
        const discordId = account?.discordLinkedAt && /^\d{17,22}$/.test(String(account?.discordUserId || ""))
          ? String(account.discordUserId)
          : "";
        if (!discordId) {
          slotState.attempted[accountId] = { status: "discord_not_linked", checkouts: customerRecords.length, at: new Date().toISOString() };
          continue;
        }
        try {
          await sendDm(botToken, discordId, buildPayload(customerRecords, slot));
          slotState.attempted[accountId] = { status: "sent", checkouts: customerRecords.length, at: new Date().toISOString() };
        } catch (error) {
          slotState.attempted[accountId] = {
            status: "failed",
            checkouts: customerRecords.length,
            error: String(error?.message || "Discord DM failed").slice(0, 300),
            at: new Date().toISOString()
          };
          console.error("Checkout summary DM failed:", accountId, error?.message || error);
        }
        state.slots[slot.key] = slotState;
        const keys = Object.keys(state.slots).sort();
        for (const old of keys.slice(0, Math.max(0, keys.length - MAX_SLOT_HISTORY))) delete state.slots[old];
        await writeJson(stateFile, state);
      }

      state.slots[slot.key] = slotState;
      const keys = Object.keys(state.slots).sort();
      for (const old of keys.slice(0, Math.max(0, keys.length - MAX_SLOT_HISTORY))) delete state.slots[old];
      await writeJson(stateFile, state);
      console.log("Checkout DM summary slot processed:", slot.key, JSON.stringify({
        customersWithCheckouts: byCustomer.size,
        checkoutCount: records.length
      }));
    } catch (error) {
      console.error("Checkout DM summary scheduler:", error?.message || error);
    } finally {
      running = false;
    }
  }

  console.log("Checkout DM summary scheduler ready for 8:00 AM and 8:00 PM America/New_York.");
  void tick();
  const timer = setInterval(() => void tick(), 30 * 1000);
  timer.unref?.();
}
