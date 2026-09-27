import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const API = "https://discord.com/api/v10";
const LEVELS = [
  { name: "Starter", profiles: 1, color: 0xdce8f0 },
  { name: "Intermediate", profiles: 2, color: 0x1dd6ff },
  { name: "Advanced", profiles: 3, color: 0xffd83d },
  { name: "Pro", profiles: 5, color: 0xbd6cff },
  { name: "High Volume", profiles: 10, color: 0xff943d },
  { name: "Power User", profiles: 20, color: 0x45e68b },
  { name: "Elite", profiles: 50, color: 0xff5aa8 }
];
const codeHash = value => crypto.createHash("sha256").update(value).digest("hex");
const linkFile = dataDir => path.join(dataDir, "discord-link-codes.json");
let codeQueue = Promise.resolve();
function withCodes(task) {
  const next = codeQueue.then(task);
  codeQueue = next.catch(() => {});
  return next;
}
async function readCodes(dataDir) {
  try { return JSON.parse(await fs.readFile(linkFile(dataDir), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
async function writeCodes(dataDir, entries) {
  const file = linkFile(dataDir);
  await fs.mkdir(dataDir, { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(entries), { mode: 0o600 });
  await fs.rename(temp, file);
}
export async function createDiscordLinkCode(dataDir, accountId) {
  return withCodes(async () => {
    const code = crypto.randomBytes(6).toString("hex").toUpperCase();
    const active = (await readCodes(dataDir)).filter(item => item.accountId !== accountId && item.expiresAt > Date.now());
    active.push({ accountId, hash: codeHash(code), expiresAt: Date.now() + 600000 });
    await writeCodes(dataDir, active);
    return code;
  });
}
async function consumeCode(dataDir, code, userId, getAccounts, saveAccounts) {
  return withCodes(async () => {
    const entries = await readCodes(dataDir);
    const index = entries.findIndex(item => item.expiresAt > Date.now() &&
      crypto.timingSafeEqual(Buffer.from(item.hash, "hex"), Buffer.from(codeHash(code), "hex")));
    if (index < 0) return "That code has expired or is invalid. Generate a new code in My Profile.";
    const accounts = await getAccounts();
    const account = accounts.find(item => String(item.id) === String(entries[index].accountId) && !item.disabled);
    if (!account) return "That customer account is unavailable.";
    if (accounts.some(item => item.id !== account.id && String(item.discordUserId || "") === userId)) {
      return "This Discord account is already linked to another customer account. Contact support.";
    }
    account.discordUserId = userId;
    account.discordLinkedAt = new Date().toISOString();
    account.updatedAt = account.discordLinkedAt;
    await saveAccounts(accounts);
    entries.splice(index, 1);
    await writeCodes(dataDir, entries.filter(item => item.expiresAt > Date.now()));
    return null;
  });
}

export function startDiscordCommunity({ token, getChannelId, getAccounts, saveAccounts, getAllowance, dataDir, aiKey }) {
  if (!token) return;
  const headers = { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
  async function api(route, method = "GET", payload) {
    const response = await fetch(`${API}${route}`, {
      method, headers, body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Discord ${method} ${route.split("?")[0]}: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  let guildId, askChannelId, appId, roles = [];
  async function provision() {
    const channelId = await getChannelId();
    if (!/^\d{17,22}$/.test(String(channelId))) throw new Error("Set DISCORD_SUCCESS_CHANNEL_ID to a channel in the desired server.");
    const channel = await api(`/channels/${channelId}`);
    guildId = channel.guild_id;
    if (!guildId) throw new Error("The success channel does not belong to a server.");
    const me = await api("/users/@me");
    appId = me.id;
    const channels = await api(`/guilds/${guildId}/channels`);
    const support = channels.find(item => item.type === 4 && item.name.toLowerCase() === "support");
    if (!support) throw new Error("The Support category was not found in this Discord server.");
    let ask = channels.find(item => item.type === 0 && item.parent_id === support.id && item.name === "ask-ai");
    if (!ask) ask = await api(`/guilds/${guildId}/channels`, "POST", {
      name: "ask-ai", type: 0, parent_id: support.id,
      topic: "Ask /ask about the website, your membership, or general botting questions. Never post passwords or payment details."
    });
    askChannelId = ask.id;
    const existing = await api(`/guilds/${guildId}/roles`);
    roles = [];
    for (const level of LEVELS) {
      let role = existing.find(item => item.name === level.name && !item.managed);
      if (!role) role = await api(`/guilds/${guildId}/roles`, "POST", {
        name: level.name, color: level.color, permissions: "0", mentionable: false, hoist: false
      });
      else if (role.color !== level.color) role = await api(`/guilds/${guildId}/roles/${role.id}`, "PATCH", { color: level.color });
      roles.push({ ...level, id: role.id });
    }
    for (const command of [
      { name: "link", description: "Link your website account to your Discord membership", options: [{ type: 3, name: "code", description: "Your private code from My Profile", required: true }] },
      { name: "ask", description: "Ask the support AI a website or botting question", options: [{ type: 3, name: "question", description: "Your question (no private account details)", required: true }] }
    ]) await api(`/applications/${appId}/guilds/${guildId}/commands`, "POST", command);
    console.log(`Discord membership roles and #ask-ai ready in guild ${guildId}`);
  }
  async function syncMember(userId, allowance) {
    if (!guildId || roles.length !== LEVELS.length) return;
    const wanted = [...roles].reverse().find(level => allowance >= level.profiles);
    let member;
    try { member = await api(`/guilds/${guildId}/members/${userId}`); }
    catch (error) { if (/HTTP 404/.test(error.message)) return; throw error; }
    for (const role of roles) {
      const has = member.roles.includes(role.id);
      if (has && role.id !== wanted?.id) await api(`/guilds/${guildId}/members/${userId}/roles/${role.id}`, "DELETE");
      if (!has && role.id === wanted?.id) await api(`/guilds/${guildId}/members/${userId}/roles/${role.id}`, "PUT");
    }
  }
  let syncing = false;
  async function syncAll() {
    if (syncing || !guildId) return;
    syncing = true;
    try {
      const accounts = await getAccounts();
      for (const account of accounts) {
        if (!account.discordLinkedAt || !/^\d{17,22}$/.test(String(account.discordUserId || ""))) continue;
        try { await syncMember(account.discordUserId, account.disabled ? 0 : await getAllowance(account.id)); }
        catch (error) { console.error("Discord tier sync:", error.message); }
      }
    } finally { syncing = false; }
  }
  const recent = new Map();
  async function aiAnswer(question) {
    if (!aiKey) return "AI support is being configured. For now, please use the support channel for help.";
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST", headers: { Authorization: `Bearer ${aiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.DISCORD_AI_MODEL || "gpt-4.1-mini", store: false, max_output_tokens: 360,
        instructions: `You are the SLABSNGRABSACO Discord support assistant. Website: https://slabsngrabsaco.com. Tiers: Starter 1 managed profile, Intermediate 2, Advanced 3, Pro 5, High Volume 10, Power User 20, Elite 50. Members can use My Profile to see memberships, linked profiles and their own success checkouts; the public home tracker aggregates community checkouts without member identities. Discord role linking: sign in, open My Profile > Discord Notifications, generate a code, then use /link code in Discord. Paid and gifted tiers grant access during their active periods. Answer general botting setup and troubleshooting questions cautiously; checkout success is never guaranteed and retailer terms apply. For account-specific issues, charges, missing orders or personal data, direct users to the human support channel. Never ask for or repeat passwords, 2FA codes, card numbers, mailbox credentials, or account secrets. Do not claim to have looked up orders or accounts. If uncertain say so. Keep replies under 900 characters.`,
        input: question.slice(0, 900)
      }), signal: AbortSignal.timeout(25000)
    });
    if (!response.ok) throw new Error(`AI service HTTP ${response.status}`);
    const body = await response.json();
    return (body.output_text || body.output?.flatMap(item => item.content || []).filter(item => item.type === "output_text").map(item => item.text).join("\n") || "Please ask the support team.").slice(0, 1400);
  }
  async function interaction(payload) {
    if (payload.t !== "INTERACTION_CREATE" || payload.d?.type !== 2 || payload.d.guild_id !== guildId) return;
    const d = payload.d, name = d.data?.name, userId = d.member?.user?.id;
    if (!["link", "ask"].includes(name) || !userId) return;
    const callback = `/interactions/${d.id}/${d.token}/callback`;
    const reply = content => api(callback, "POST", { type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });
    try {
      if (name === "link") {
        const code = String(d.data.options?.find(item => item.name === "code")?.value || "").trim().toUpperCase();
        const message = await consumeCode(dataDir, code, userId, getAccounts, saveAccounts);
        if (message) return await reply(message);
        try { const account = (await getAccounts()).find(item => item.discordUserId === userId); await syncMember(userId, await getAllowance(account.id)); }
        catch (error) { console.error("Discord role after linking:", error.message); }
        return await reply("Your Discord account is linked. Your membership role will update automatically.");
      }
      if (d.channel_id !== askChannelId) return await reply("Please use /ask in #ask-ai.");
      const question = String(d.data.options?.find(item => item.name === "question")?.value || "").trim();
      if (!question || question.length > 900) return await reply("Please enter a question under 900 characters.");
      if (Date.now() - (recent.get(userId) || 0) < 20000) return await reply("Please wait 20 seconds before asking another question.");
      recent.set(userId, Date.now());
      await api(callback, "POST", { type: 5, data: { flags: 64 } });
      let answer;
      try { answer = await aiAnswer(question); }
      catch (error) { console.error("Discord AI answer:", error.message); answer = "Support is temporarily unavailable. Please ask in the support channel."; }
      await api(`/webhooks/${appId}/${d.token}/messages/@original`, "PATCH", { content: answer, allowed_mentions: { parse: [] } });
    } catch (error) { console.error("Discord interaction:", error.message); }
  }
  let socket, sequence = null, heartbeat, reconnectDelay = 1000, closed = false;
  async function connect() {
    if (closed) return;
    try {
      const gateway = await api("/gateway/bot");
      socket = new WebSocket(`${gateway.url}?v=10&encoding=json`);
      socket.addEventListener("message", event => {
        try {
          const packet = JSON.parse(event.data);
          if (packet.s !== null) sequence = packet.s;
          if (packet.op === 10) {
            clearInterval(heartbeat);
            heartbeat = setInterval(() => socket.readyState === 1 && socket.send(JSON.stringify({ op: 1, d: sequence })), packet.d.heartbeat_interval);
            heartbeat.unref?.();
            socket.send(JSON.stringify({ op: 2, d: { token, intents: 1, properties: { os: "linux", browser: "slabsngrabsaco", device: "slabsngrabsaco" } } }));
          }
          if (packet.op === 1 && socket.readyState === 1) socket.send(JSON.stringify({ op: 1, d: sequence }));
          if (packet.op === 7 || packet.op === 9) socket.close();
          if (packet.t === "READY") reconnectDelay = 1000;
          if (packet.t === "INTERACTION_CREATE") void interaction(packet);
        } catch (error) { console.error("Discord gateway packet:", error.message); }
      });
      socket.addEventListener("close", () => {
        clearInterval(heartbeat);
        setTimeout(connect, reconnectDelay).unref?.();
        reconnectDelay = Math.min(reconnectDelay * 2, 60000);
      });
      socket.addEventListener("error", event => console.error("Discord gateway connection error", event.message || "connection failed"));
    } catch (error) {
      console.error("Discord gateway startup:", error.message);
      setTimeout(connect, 30000).unref?.();
    }
  }
  async function setup() {
    try { await provision(); await syncAll(); await connect(); }
    catch (error) { console.error("Discord community setup:", error.message); setTimeout(setup, 60000).unref?.(); }
  }
  setTimeout(setup, 5000).unref?.();
  setInterval(syncAll, 60000).unref?.();
}
