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
export async function revokeDiscordLinkCodes(dataDir, accountId) {
  return withCodes(async () => {
    const codes = await readCodes(dataDir);
    await writeCodes(dataDir, codes.filter(item => item.accountId !== accountId && item.expiresAt > Date.now()));
  });
}

const removalFile = dataDir => path.join(dataDir, "discord-role-removals.json");
let removalQueue = Promise.resolve();
let flushQueuedRemovals = async () => {};
function withRemovals(task) {
  const next = removalQueue.then(task);
  removalQueue = next.catch(() => {});
  return next;
}
async function readRemovals(dataDir) {
  try {
    const value = JSON.parse(await fs.readFile(removalFile(dataDir), "utf8"));
    return Array.isArray(value) ? value : [];
  } catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
async function writeRemovals(dataDir, entries) {
  const file = removalFile(dataDir);
  await fs.mkdir(dataDir, { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(entries), { mode: 0o600 });
  await fs.rename(temp, file);
}
export async function queueDiscordRoleRemoval(dataDir, userId) {
  if (!/^\d{17,22}$/.test(String(userId || ""))) return;
  await withRemovals(async () => {
    const pending = await readRemovals(dataDir);
    if (!pending.includes(String(userId))) {
      pending.push(String(userId));
      await writeRemovals(dataDir, pending);
    }
  });
  void flushQueuedRemovals().catch(error => console.error("Discord role removal:", error.message));
}
async function consumeCode(dataDir, code, userId, username, getAccounts, saveAccounts) {
  return withCodes(async () => {
    const entries = await readCodes(dataDir);
    const index = entries.findIndex(item => item.expiresAt > Date.now() &&
      crypto.timingSafeEqual(Buffer.from(item.hash, "hex"), Buffer.from(codeHash(code), "hex")));
    if (index < 0) return "That code has expired or is invalid. Generate a new code in My Profile.";
    const accounts = await getAccounts();
    const account = accounts.find(item => String(item.id) === String(entries[index].accountId) && !item.disabled);
    if (!account) return "That customer account is unavailable.";
    if (account.discordLinkedAt) return "Unlink your current Discord account on the website before connecting another one.";
    if (accounts.some(item => item.id !== account.id && String(item.discordUserId || "") === userId)) {
      return "This Discord account is already linked to another customer account. Contact support.";
    }
    account.discordUserId = userId;
    account.discordUsername = username || account.discordUsername || "";
    account.discordLinkedAt = new Date().toISOString();
    account.updatedAt = account.discordLinkedAt;
    await saveAccounts(accounts);
    entries.splice(index, 1);
    await writeCodes(dataDir, entries.filter(item => item.expiresAt > Date.now()));
    return null;
  });
}

export const discordCommunityStatus = { configured: false, rolesReady: false, askChannelReady: false, ticketSupportReady: false, ticketLobbyReady: false, adminChannelsReady: false, oneOnOneReady: false, oneOnOneQueued: 0, oneOnOneActive: false, gatewayReady: false, messageContentReady: false, aiConfigured: false, lastRoleSyncAt: null, lastAnswerAt: null, lastAiError: null, error: null };
export function startDiscordCommunity({ token, getChannelId, getAccounts, saveAccounts, getAllowance, dataDir, aiKey }) {
  discordCommunityStatus.configured = Boolean(token);
  discordCommunityStatus.aiConfigured = Boolean(aiKey);
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
  let guildId, askChannelId, supportCategoryId, alertsChannelId, ticketLobbyId, oneOnOneLobbyId, chatCategoryId, ownerId, staffRoleId, appId, roles = [];
  async function provision() {
    const channelId = await getChannelId();
    if (!/^\d{17,22}$/.test(String(channelId))) throw new Error("Set DISCORD_SUCCESS_CHANNEL_ID to a channel in the desired server.");
    const channel = await api(`/channels/${channelId}`);
    guildId = channel.guild_id;
    if (!guildId) throw new Error("The success channel does not belong to a server.");
    const me = await api("/users/@me");
    appId = me.id;
    const guild = await api(`/guilds/${guildId}`);
    ownerId = guild.owner_id;
    const channels = await api(`/guilds/${guildId}/channels`);
    let support = channels.find(item => item.type === 4 && /\bsupport\b/i.test(item.name));
    const supportText = channels.find(item => item.type === 0 && /\bsupport\b/i.test(item.name));
    if (!support && supportText?.parent_id) support = channels.find(item => item.id === supportText.parent_id && item.type === 4);
    if (!support) {
      support = await api(`/guilds/${guildId}/channels`, "POST", { name: "Support", type: 4 });
      if (supportText && !supportText.parent_id) {
        await api(`/channels/${supportText.id}`, "PATCH", { parent_id: support.id });
      }
    }
    let ask = channels.find(item => item.type === 0 && item.parent_id === support.id && item.name.toLowerCase() === "ask-ai");
    const askTopic = "Type your question here for an AI reply. If it needs a person, open a private ticket from the bot's reply. Do not share passwords or payment information.";
    if (!ask) ask = await api(`/guilds/${guildId}/channels`, "POST", {
      name: "ask-ai", type: 0, parent_id: support.id,
      topic: askTopic
    });
    else if (ask.topic !== askTopic) await api(`/channels/${ask.id}`, "PATCH", { topic: askTopic });
    askChannelId = ask.id;
    supportCategoryId = support.id;
    discordCommunityStatus.askChannelReady = true;
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
    let staff = existing.find(item => item.name.toLowerCase() === "support staff" && !item.managed);
    if (!staff) staff = await api(`/guilds/${guildId}/roles`, "POST", {
      name: "Support Staff", color: 0x41b6e6, permissions: "0", mentionable: false, hoist: false
    });
    staffRoleId = staff.id;
    const ticketOverwrites = [
      { id: guildId, type: 0, deny: "1024" },
      { id: staffRoleId, type: 0, allow: "68608" },
      { id: appId, type: 1, allow: "68624" },
      ...(ownerId ? [{ id: ownerId, type: 1, allow: "68608" }] : [])
    ];
    let alerts = channels.find(item => item.type === 0 && item.parent_id === support.id && item.name === "support-alerts" &&
      item.permission_overwrites?.some(overwrite => overwrite.id === guildId && (BigInt(overwrite.deny || 0) & 1024n)));
    if (!alerts) alerts = await api(`/guilds/${guildId}/channels`, "POST", {
      name: channels.some(item => item.name === "support-alerts") ? "ai-support-alerts" : "support-alerts", type: 0, parent_id: support.id,
      permission_overwrites: ticketOverwrites,
      topic: "Private alerts for questions that need a person. Give trusted helpers the Support Staff role."
    });
    alertsChannelId = alerts.id;
    discordCommunityStatus.ticketSupportReady = true;
    let ticketLobbyError = null;
    try {
      const publicTicketOverwrites = [
        { id: guildId, type: 0, allow: "66560", deny: "2048" },
        { id: appId, type: 1, allow: "68624" }
      ];
      let lobby = channels.find(item => item.type === 0 &&
        ["createaticket", "createticket"].includes(item.name.toLowerCase().replace(/[^a-z0-9]/g, "")));
      if (!lobby) lobby = await api(`/guilds/${guildId}/channels`, "POST", {
        name: "create-a-ticket", type: 0, parent_id: support.id,
        permission_overwrites: publicTicketOverwrites
      });
      else if (lobby.parent_id !== support.id ||
        lobby.permission_overwrites?.length !== publicTicketOverwrites.length ||
        !publicTicketOverwrites.every(expected => lobby.permission_overwrites?.some(actual =>
          actual.id === expected.id && actual.type === expected.type &&
          String(actual.allow || "0") === String(expected.allow || "0") &&
          String(actual.deny || "0") === String(expected.deny || "0")))) {
        lobby = await api(`/channels/${lobby.id}`, "PATCH", {
          parent_id: support.id, permission_overwrites: publicTicketOverwrites
        });
      }
      ticketLobbyId = lobby.id;
      await setupTicketLobby();
      discordCommunityStatus.ticketLobbyReady = true;
    } catch (error) {
      ticketLobbyError = `Create a Ticket setup: ${error.message}`;
      console.error("Discord Create a Ticket setup:", error.message);
    }
    let adminError = null;
    try {
      const adminOverwrites = [
        { id: guildId, type: 0, deny: "1024" },
        { id: staffRoleId, type: 0, allow: "68608" },
        { id: appId, type: 1, allow: "68624" },
        ...(ownerId ? [{ id: ownerId, type: 1, allow: "68608" }] : [])
      ];
      const adminNames = new Set(["admin", "adminprofiles", "actionneeded"]);
      const normalizeName = name => String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const sameOverwrites = overwrites =>
        Array.isArray(overwrites) && overwrites.length === adminOverwrites.length &&
        adminOverwrites.every(expected => overwrites.some(actual =>
          actual.id === expected.id && actual.type === expected.type &&
          String(actual.allow || "0") === String(expected.allow || "0") &&
          String(actual.deny || "0") === String(expected.deny || "0")));
      let adminCategory = channels.find(item => item.type === 4 && normalizeName(item.name) === "adminonly");
      if (!adminCategory) adminCategory = await api(`/guilds/${guildId}/channels`, "POST", {
        name: "Admin Only", type: 4, permission_overwrites: adminOverwrites
      });
      else if (!sameOverwrites(adminCategory.permission_overwrites)) {
        adminCategory = await api(`/channels/${adminCategory.id}`, "PATCH", { permission_overwrites: adminOverwrites });
      }
      const adminChannels = channels.filter(item => item.type === 0 && adminNames.has(normalizeName(item.name)));
      for (const adminChannel of adminChannels) {
        if (adminChannel.parent_id !== adminCategory.id || !sameOverwrites(adminChannel.permission_overwrites)) {
          await api(`/channels/${adminChannel.id}`, "PATCH", {
            parent_id: adminCategory.id, permission_overwrites: adminOverwrites
          });
        }
      }
      discordCommunityStatus.adminChannelsReady = adminChannels.length === adminNames.size;
      if (!discordCommunityStatus.adminChannelsReady) {
        adminError = `Admin Only: found ${adminChannels.length} of 3 expected channels`;
      }
    } catch (error) {
      adminError = `Admin Only setup: ${error.message}`;
      console.error("Discord Admin Only setup:", error.message);
    }
    let oneOnOneError = null;
    try {
    let chat = channels.find(item => item.type === 4 && item.name.replace(/[^a-z]/gi, "").toLowerCase() === "chat") ||
      channels.find(item => item.type === 4 && /\bchat\b/i.test(item.name));
    if (!chat) chat = await api(`/guilds/${guildId}/channels`, "POST", { name: "Chat", type: 4 });
    chatCategoryId = chat.id;
    let lobby = channels.find(item => item.type === 0 && item.parent_id === chat.id && item.name === "1-on-1" &&
      !item.permission_overwrites?.some(overwrite => overwrite.id === guildId && (BigInt(overwrite.deny || 0) & 1024n)));
    if (!lobby) lobby = channels.find(item => item.type === 0 && item.name === "1-on-1" &&
      !item.permission_overwrites?.some(overwrite => overwrite.id === guildId && (BigInt(overwrite.deny || 0) & 1024n)));
    if (lobby && lobby.parent_id !== chat.id) lobby = await api(`/channels/${lobby.id}`, "PATCH", { parent_id: chat.id });
    if (!lobby) lobby = await api(`/guilds/${guildId}/channels`, "POST", {
      name: "1-on-1", type: 0, parent_id: chat.id,
      topic: "Request a private 1-on-1 text and voice session. One session is active at a time; other requests wait in order."
    });
    oneOnOneLobbyId = lobby.id;
    await setupOneOnOneLobby();
    discordCommunityStatus.oneOnOneReady = true;
    await withSessions(async () => { const state = await readSessions(); await reconcileSessions(state); });
    } catch (error) {
      oneOnOneError = `1-on-1 setup: ${error.message}`;
      console.error("Discord 1-on-1 setup:", error.message);
    }
    for (const command of [
      { name: "link", description: "Link your website account to your Discord membership", options: [{ type: 3, name: "code", description: "Your private code from My Profile", required: true }] },
      { name: "ask", description: "Ask the support AI a website or botting question", options: [{ type: 3, name: "question", description: "Your question (no private account details)", required: true }] }
    ]) await api(`/applications/${appId}/guilds/${guildId}/commands`, "POST", command);
    discordCommunityStatus.rolesReady = roles.length === LEVELS.length;
    discordCommunityStatus.error = [ticketLobbyError, adminError, oneOnOneError].filter(Boolean).join("; ") || null;
    console.log(`Discord membership roles, #ask-ai and support tickets ready in guild ${guildId}`);
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
  async function removeOldRoles() {
    if (!guildId || roles.length !== LEVELS.length) return;
    await withRemovals(async () => {
      const pending = await readRemovals(dataDir);
      if (!pending.length) return;
      const accounts = await getAccounts();
      const retry = [];
      for (const userId of pending) {
        // A customer who reconnected this identity keeps the role for their current tier.
        if (accounts.some(account => account.discordLinkedAt && account.discordUserId === userId)) continue;
        try { await syncMember(userId, 0); }
        catch (error) { retry.push(userId); console.error("Discord role removal retry:", error.message); }
      }
      await writeRemovals(dataDir, retry);
    });
  }
  flushQueuedRemovals = removeOldRoles;
  let syncing = false;
  async function syncAll() {
    if (syncing || !guildId) return;
    syncing = true;
    try {
      await removeOldRoles();
      const accounts = await getAccounts();
      for (const account of accounts) {
        if (!account.discordLinkedAt || !/^\d{17,22}$/.test(String(account.discordUserId || ""))) continue;
        try { await syncMember(account.discordUserId, account.disabled ? 0 : await getAllowance(account.id)); }
        catch (error) { console.error("Discord tier sync:", error.message); }
      }
      discordCommunityStatus.lastRoleSyncAt = new Date().toISOString();
    } finally { syncing = false; }
  }
  const ticketFile = path.join(dataDir, "discord-support-tickets.json");
  let ticketQueue = Promise.resolve();
  function withTickets(task) {
    const next = ticketQueue.then(task);
    ticketQueue = next.catch(() => {});
    return next;
  }
  async function readTickets() {
    try {
      const records = JSON.parse(await fs.readFile(ticketFile, "utf8"));
      return Array.isArray(records) ? records : [];
    } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }
  async function writeTickets(records) {
    await fs.mkdir(dataDir, { recursive: true });
    const temp = `${ticketFile}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(records), { mode: 0o600 });
    await fs.rename(temp, ticketFile);
  }
  const mention = id => `<@${id}>`;
  async function sendMessage(channelId, content, extras = {}) {
    const { users = [], ...other } = extras;
    return api(`/channels/${channelId}/messages`, "POST", { content, allowed_mentions: { parse: [], users }, ...other });
  }
  const ticketPanelFile = path.join(dataDir, "discord-ticket-panel.json");
  async function setupTicketLobby() {
    let panel = {};
    try { panel = JSON.parse(await fs.readFile(ticketPanelFile, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (panel.guildId === guildId && panel.channelId === ticketLobbyId && panel.messageId) {
      try { await api(`/channels/${ticketLobbyId}/messages/${panel.messageId}`); return; }
      catch (error) { if (!/HTTP 404/.test(error.message)) throw error; }
    }
    const message = await sendMessage(ticketLobbyId,
      "Need assistance? Click **Create a Ticket** and describe your issue in the private form. A private ticket will be opened for you, the owner and Support Staff will be notified, and you can talk there until you or staff close it. Please do not post account details in this public channel.",
      { components: [{ type: 1, components: [{ type: 2, style: 1, label: "Create a Ticket", custom_id: "ticket:lobby:create" }] }] });
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(ticketPanelFile, JSON.stringify({ guildId, channelId: ticketLobbyId, messageId: message.id }), { mode: 0o600 });
    await api(`/channels/${ticketLobbyId}/pins/${message.id}`, "PUT").catch(error => console.error("Discord ticket pin:", error.message));
  }
  async function alertStaff(userId, messageId) {
    if (!alertsChannelId) throw new Error("Private support alerts are not configured.");
    const ping = ownerId ? mention(ownerId) : "Support staff";
    await sendMessage(alertsChannelId,
      `${ping} — ${mention(userId)} needs help beyond the AI assistant. They were offered a private ticket. https://discord.com/channels/${guildId}/${askChannelId}/${messageId}`,
      { users: [ownerId, userId].filter(Boolean) });
  }
  async function openTicket(userId, issue = "") {
    return withTickets(async () => {
      const records = await readTickets();
      const existing = records.find(item => item.userId === userId && item.guildId === guildId);
      if (existing) {
        try {
          await api(`/channels/${existing.channelId}`);
          if (issue) await sendMessage(existing.channelId, `${mention(userId)} added an issue:\n${issue}`, { users: [userId] });
          return existing.channelId;
        }
        catch (error) { if (!/HTTP 404/.test(error.message)) throw error; }
      }
      const channel = await api(`/guilds/${guildId}/channels`, "POST", {
        name: `ticket-${userId.slice(-8)}`, type: 0, parent_id: supportCategoryId,
        topic: `Private support ticket for Discord member ${userId}`,
        permission_overwrites: [
          { id: guildId, type: 0, deny: "1024" },
          { id: userId, type: 1, allow: "68608" },
          { id: staffRoleId, type: 0, allow: "68608" },
          { id: appId, type: 1, allow: "68624" },
          ...(ownerId && ownerId !== userId ? [{ id: ownerId, type: 1, allow: "68608" }] : [])
        ]
      });
      try {
        await sendMessage(channel.id,
          `${mention(userId)}, your private ticket is open. ${issue ? `Issue:\n${issue}\n\n` : "Describe the issue here. "}Please do not share passwords, payment details, or verification codes. The owner or Support Staff can help.`,
          { users: [userId], components: [{ type: 1, components: [{ type: 2, style: 4, label: "Close ticket", custom_id: `ticket:close:${channel.id}` }] }] });
        await writeTickets([...records.filter(item => item.userId !== userId || item.guildId !== guildId), { guildId, userId, channelId: channel.id }]);
      } catch (error) {
        await api(`/channels/${channel.id}`, "DELETE").catch(() => {});
        throw error;
      }
      if (alertsChannelId) await sendMessage(alertsChannelId,
        `${ownerId ? mention(ownerId) : "Support Staff"} — ${mention(userId)} opened a private support ticket: <#${channel.id}>.`,
        { users: [ownerId].filter(Boolean) }).catch(error => {
          discordCommunityStatus.error = `Ticket alert: ${error.message}`;
          console.error("Discord ticket alert:", error.message);
        });
      return channel.id;
    });
  }
  async function closeTicket(channelId, userId, member) {
    return withTickets(async () => {
      const records = await readTickets();
      const ticket = records.find(item => item.channelId === channelId && item.guildId === guildId);
      if (!ticket) throw new Error("This support ticket is already closed.");
      const staff = member?.roles?.includes(staffRoleId) || userId === ownerId || (BigInt(member?.permissions || "0") & 8n) === 8n;
      if (ticket.userId !== userId && !staff) throw new Error("Only this ticket's customer or support staff can close it.");
      await api(`/channels/${channelId}`, "DELETE");
      await writeTickets(records.filter(item => item !== ticket));
    });
  }
  const sessionFile = path.join(dataDir, "discord-one-on-one-queue.json");
  let sessionQueue = Promise.resolve();
  function withSessions(task) {
    const next = sessionQueue.then(task);
    sessionQueue = next.catch(() => {});
    return next;
  }
  async function readSessions() {
    try {
      const data = JSON.parse(await fs.readFile(sessionFile, "utf8"));
      return { lobbyMessageId: data.lobbyMessageId || null, active: data.active || null,
        waiting: Array.isArray(data.waiting) ? [...new Set(data.waiting.filter(id => /^\d{17,22}$/.test(id)))] : [] };
    } catch (error) { if (error.code === "ENOENT") return { lobbyMessageId: null, active: null, waiting: [] }; throw error; }
  }
  async function writeSessions(state) {
    await fs.mkdir(dataDir, { recursive: true });
    const temp = `${sessionFile}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(temp, sessionFile);
    discordCommunityStatus.oneOnOneQueued = state.waiting.length;
    discordCommunityStatus.oneOnOneActive = Boolean(state.active);
  }
  async function setupOneOnOneLobby() {
    const state = await readSessions();
    if (state.lobbyMessageId) {
      try { await api(`/channels/${oneOnOneLobbyId}/messages/${state.lobbyMessageId}`); return; }
      catch (error) { if (!/HTTP 404/.test(error.message)) throw error; }
    }
    const message = await sendMessage(oneOnOneLobbyId,
      "Need to speak with the owner or Support Staff? Request a private 1-on-1 below. You will get a private text room and voice room when it is your turn. Only one conversation is active at a time; everyone else waits in order. Please do not post account details here.",
      { components: [{ type: 1, components: [
        { type: 2, style: 1, label: "Request 1-on-1", custom_id: "oneonone:request" },
        { type: 2, style: 2, label: "Check my place", custom_id: "oneonone:status" },
        { type: 2, style: 2, label: "Leave queue", custom_id: "oneonone:leave" }
      ] }] });
    state.lobbyMessageId = message.id;
    await writeSessions(state);
    await api(`/channels/${oneOnOneLobbyId}/pins/${message.id}`, "PUT").catch(error => console.error("Discord 1-on-1 pin:", error.message));
  }
  function supportStaff(member, userId) {
    return userId === ownerId || member?.roles?.includes(staffRoleId) || (BigInt(member?.permissions || "0") & 8n) === 8n;
  }
  async function startNextSession(state) {
    if (state.active || !state.waiting.length) return;
    const userId = state.waiting[0];
    try { await api(`/guilds/${guildId}/members/${userId}`); }
    catch (error) {
      if (!/HTTP 404/.test(error.message)) throw error;
      state.waiting.shift();
      await writeSessions(state);
      return startNextSession(state);
    }
    const suffix = userId.slice(-8);
    const textOverwrites = [
      { id: guildId, type: 0, deny: "1024" },
      { id: userId, type: 1, allow: "68608" },
      { id: staffRoleId, type: 0, allow: "68608" },
      { id: appId, type: 1, allow: "68624" },
      ...(ownerId && ownerId !== userId ? [{ id: ownerId, type: 1, allow: "68608" }] : [])
    ];
    const voiceOverwrites = [
      { id: guildId, type: 0, deny: "1024" },
      { id: userId, type: 1, allow: "3146752" },
      { id: staffRoleId, type: 0, allow: "3146752" },
      { id: appId, type: 1, allow: "3146768" },
      ...(ownerId && ownerId !== userId ? [{ id: ownerId, type: 1, allow: "3146752" }] : [])
    ];
    let textChannel, voiceChannel;
    try {
      textChannel = await api(`/guilds/${guildId}/channels`, "POST", {
        name: `one-on-one-${suffix}`, type: 0, parent_id: chatCategoryId,
        topic: `Private 1-on-1 support session for Discord member ${userId}`,
        permission_overwrites: textOverwrites
      });
      voiceChannel = await api(`/guilds/${guildId}/channels`, "POST", {
        name: `1-on-1 voice ${suffix}`, type: 2, parent_id: chatCategoryId,
        user_limit: 3, permission_overwrites: voiceOverwrites
      });
      await sendMessage(textChannel.id,
        `${mention(userId)}, it is your turn. Chat here with the owner or Support Staff, or join <#${voiceChannel.id}> for voice. This room is private. Please avoid sending passwords, verification codes, or card information. Use a button below when the conversation is done.`,
        { users: [userId], components: [{ type: 1, components: [
          { type: 2, style: 2, label: "I'm done", custom_id: `oneonone:done:user:${textChannel.id}` },
          { type: 2, style: 4, label: "We're done (staff)", custom_id: `oneonone:done:staff:${textChannel.id}` }
        ] }] });
      const next = { ...state, active: { userId, textId: textChannel.id, voiceId: voiceChannel.id }, waiting: state.waiting.slice(1) };
      await writeSessions(next);
      Object.assign(state, next);
    } catch (error) {
      if (voiceChannel) await api(`/channels/${voiceChannel.id}`, "DELETE").catch(() => {});
      if (textChannel) await api(`/channels/${textChannel.id}`, "DELETE").catch(() => {});
      discordCommunityStatus.error = `1-on-1 setup: ${error.message}`;
      throw error;
    }
    if (alertsChannelId) await sendMessage(alertsChannelId,
      `${ownerId ? mention(ownerId) : "Support Staff"} — a private 1-on-1 session is ready for ${mention(userId)}: <#${textChannel.id}> (voice: <#${voiceChannel.id}>).`,
      { users: [ownerId].filter(Boolean) }).catch(error => console.error("Discord 1-on-1 alert:", error.message));
  }
  async function reconcileSessions(state) {
    if (state.active) {
      const { textId, voiceId } = state.active;
      let missing = false;
      for (const id of [textId, voiceId]) {
        try {
          const channel = await api(`/channels/${id}`);
          if (channel.parent_id !== chatCategoryId && channel.permission_overwrites?.some(overwrite =>
            overwrite.id === guildId && (BigInt(overwrite.deny || 0) & 1024n))) {
            await api(`/channels/${id}`, "PATCH", { parent_id: chatCategoryId, permission_overwrites: channel.permission_overwrites });
          }
        }
        catch (error) { if (!/HTTP 404/.test(error.message)) throw error; missing = true; }
      }
      if (missing) {
        for (const id of [textId, voiceId]) await api(`/channels/${id}`, "DELETE").catch(() => {});
        state.active = null;
        await writeSessions(state);
      }
    }
    discordCommunityStatus.oneOnOneQueued = state.waiting.length;
    discordCommunityStatus.oneOnOneActive = Boolean(state.active);
    if (!state.active) await startNextSession(state);
  }
  async function requestOneOnOne(userId) {
    return withSessions(async () => {
      const state = await readSessions();
      if (state.active?.userId === userId) return { active: state.active };
      if (!state.waiting.includes(userId)) {
        state.waiting.push(userId);
        await writeSessions(state);
      }
      if (!state.active) await startNextSession(state);
      return state.active?.userId === userId ? { active: state.active } : { position: state.waiting.indexOf(userId) + 1 };
    });
  }
  async function finishOneOnOne(textId, userId, member, staffButton) {
    return withSessions(async () => {
      const state = await readSessions();
      if (!state.active || state.active.textId !== textId) throw new Error("That 1-on-1 session is already closed.");
      const staff = supportStaff(member, userId);
      if (staffButton ? !staff : state.active.userId !== userId) throw new Error("Only the customer or support staff can end this session.");
      const finished = state.active;
      for (const id of [finished.voiceId, finished.textId]) {
        try { await api(`/channels/${id}`, "DELETE"); }
        catch (error) { if (!/HTTP 404/.test(error.message)) throw error; }
      }
      state.active = null;
      await writeSessions(state);
      await startNextSession(state);
    });
  }
  const recent = new Map();
  const privateReply = "I can't share or review customer information in this public channel. Please create a private ticket to follow up with your question.";
  function sensitiveQuestion(value) {
    return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value) ||
      /\b(?:password|passcode|one.time code|two.factor|2fa|otp|cvv|credit card|card number|billing|charged|charge|refund|invoice|tracking number|shipping address|home address|phone number|my account|my order|my checkout|my payment|my subscription|my email|my profile|my name|my address|my phone|my card|my discord)\b/i.test(value) ||
      /\b(?:order|account|invoice|tracking|confirmation)\s*(?:#|number|id|:)\s*[A-Z0-9-]{4,}/i.test(value) ||
      /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/.test(value) ||
      /(?:\b\d[ -]*?){13,19}\b/.test(value);
  }
  function sensitiveOutput(value) {
    return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value) ||
      /\b(?:your|their|this customer's)\s+(?:order|account|billing|payment|card|email|address|phone|profile)\b/i.test(value) ||
      /\b(?:order|account|invoice|tracking|confirmation)\s*(?:#|number|id|:)\s*[A-Z0-9-]{4,}/i.test(value) ||
      /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/.test(value) ||
      /(?:\b\d[ -]*?){13,19}\b/.test(value);
  }
  async function aiAnswer(question) {
    if (!aiKey) throw new Error("OPENAI_API_KEY is missing");
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST", headers: { Authorization: `Bearer ${aiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.DISCORD_AI_MODEL || "gpt-4.1-mini", store: false, max_output_tokens: 360,
        instructions: `You are the SLABSNGRABSACO Discord support assistant answering in a PUBLIC channel. Website: https://slabsngrabsaco.com. Tiers: Starter 1 managed profile, Intermediate 2, Advanced 3, Pro 5, High Volume 10, Power User 20, Elite 50. Members can use My Profile to see memberships, linked profiles and their own success checkouts; the public home tracker aggregates community checkouts without member identities. Discord linking is in My Profile: connect via Discord authorization or generate a code and use /link code in Discord. Paid and gifted tiers grant access during their active periods. Answer general website and botting setup questions cautiously; retailer checkouts are not guaranteed. NEVER disclose, reproduce, infer, or request customer information: names, usernames, email addresses, addresses, phone numbers, orders, payments, linked accounts, profiles, credentials, verification codes. Never claim to have inspected an account, order, or bot run. If an answer needs account access, a billing or order investigation, private details, or information you lack, set needsHuman to true. Otherwise answer helpfully and set needsHuman to false. Return ONLY a JSON object with keys "answer" (under 800 characters) and "needsHuman" (boolean).`,
        input: question.slice(0, 900)
      }), signal: AbortSignal.timeout(25000)
    });
    if (!response.ok) throw new Error(`AI service HTTP ${response.status}`);
    const body = await response.json();
    const output = body.output_text || body.output?.flatMap(item => item.content || []).filter(item => item.type === "output_text").map(item => item.text).join("\n") || "";
    const result = JSON.parse(output.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    if (typeof result.answer !== "string" || typeof result.needsHuman !== "boolean") throw new Error("AI service returned an invalid support decision");
    discordCommunityStatus.lastAnswerAt = new Date().toISOString();
    discordCommunityStatus.lastAiError = null;
    return result.needsHuman || sensitiveOutput(result.answer)
      ? { answer: privateReply, needsHuman: true }
      : { answer: result.answer.slice(0, 800), needsHuman: false };
  }
  async function answerInChannel(userId, question, messageId) {
    let answer;
    const privateQuestion = sensitiveQuestion(question);
    if (privateQuestion) {
      // Remove exposed customer information when the bot has Manage Messages.
      if (messageId) await api(`/channels/${askChannelId}/messages/${messageId}`, "DELETE").catch(error => console.error("Discord private question removal:", error.message));
      answer = { answer: privateReply, needsHuman: true };
    } else try { answer = await aiAnswer(question); }
    catch (error) {
      discordCommunityStatus.lastAiError = error.message;
      console.error("Discord AI answer:", error.message);
      answer = { answer: privateReply, needsHuman: true };
    }
    const reply = await sendMessage(askChannelId, `${mention(userId)} ${answer.answer}`, {
      users: [userId],
      ...(messageId && !privateQuestion ? { message_reference: { message_id: messageId, fail_if_not_exists: false } } : {}),
      ...(answer.needsHuman ? { components: [{ type: 1, components: [{ type: 2, style: 1, label: "Create private ticket", custom_id: `ticket:create:${userId}` }] }] } : {})
    });
    if (answer.needsHuman) {
      try { await alertStaff(userId, reply.id); }
      catch (error) { discordCommunityStatus.error = `Support alert: ${error.message}`; console.error("Discord support alert:", error.message); }
    }
    return reply;
  }
  async function onQuestionMessage(d) {
    if (d.channel_id !== askChannelId || d.guild_id !== guildId || d.author?.bot || d.webhook_id) return;
    const userId = d.author?.id;
    const question = String(d.content || "").replace(new RegExp(`<@!?${appId}>`, "g"), "").trim();
    if (!/^\d{17,22}$/.test(String(userId)) || !question) return;
    try { await answerInChannel(userId, question.slice(0, 900), d.id); }
    catch (error) { discordCommunityStatus.lastAiError = error.message; console.error("Discord question:", error.message); }
  }
  async function interaction(payload) {
    if (payload.t !== "INTERACTION_CREATE" || payload.d?.guild_id !== guildId) return;
    const d = payload.d, name = d.data?.name, userId = d.member?.user?.id;
    if (!userId) return;
    const callback = `/interactions/${d.id}/${d.token}/callback`;
    const reply = content => api(callback, "POST", { type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });
    try {
      if (d.type === 3 && ["oneonone:request", "oneonone:status", "oneonone:leave"].includes(d.data?.custom_id)) {
        if (d.channel_id !== oneOnOneLobbyId) return await reply("Use the 1-on-1 channel under Chat.");
        if (d.data.custom_id === "oneonone:status") {
          const state = await readSessions();
          const position = state.waiting.indexOf(userId);
          return await reply(state.active?.userId === userId
            ? `Your private session is active: https://discord.com/channels/${guildId}/${state.active.textId}`
            : position < 0 ? "You are not in the 1-on-1 queue. Click Request 1-on-1 to join."
              : `You are #${position + 1} in the queue. The bot will mention you in a private text channel when it is your turn.`);
        }
        if (d.data.custom_id === "oneonone:leave") {
          const removed = await withSessions(async () => {
            const state = await readSessions();
            if (state.active?.userId === userId) return false;
            const before = state.waiting.length;
            state.waiting = state.waiting.filter(id => id !== userId);
            if (before !== state.waiting.length) await writeSessions(state);
            return before !== state.waiting.length;
          });
          return await reply(removed ? "You have left the 1-on-1 queue." : "You are not waiting in the queue. If your session is active, use I'm done inside your private text room.");
        }
        await api(callback, "POST", { type: 5, data: { flags: 64 } });
        try {
          const result = await requestOneOnOne(userId);
          return await api(`/webhooks/${appId}/${d.token}/messages/@original`, "PATCH", {
            content: result.active
              ? `Your private 1-on-1 is ready: https://discord.com/channels/${guildId}/${result.active.textId} · Voice: https://discord.com/channels/${guildId}/${result.active.voiceId}`
              : `You are #${result.position} in the 1-on-1 queue. When it is your turn, the bot will mention you in your private text room. Use Check my place here any time.`
          });
        } catch (error) {
          console.error("Discord 1-on-1 request:", error.message);
          if (alertsChannelId) await sendMessage(alertsChannelId, `${ownerId ? mention(ownerId) : "Support Staff"} — a 1-on-1 request could not start. Please check bot channel permissions.`, { users: [ownerId].filter(Boolean) }).catch(() => {});
          return await api(`/webhooks/${appId}/${d.token}/messages/@original`, "PATCH", { content: "Unable to open a 1-on-1 room right now. Your request was saved; please check back shortly." });
        }
      }
      if (d.type === 3 && /^oneonone:done:(user|staff):\d{17,22}$/.test(d.data?.custom_id || "")) {
        const [, , who, textId] = d.data.custom_id.split(":");
        if (d.channel_id !== textId) return await reply("This button belongs to a different 1-on-1 room.");
        const state = await readSessions();
        if (!state.active || state.active.textId !== textId) return await reply("This session has already ended.");
        if (who === "staff" && !supportStaff(d.member, userId)) return await reply("Only the owner or Support Staff can use We're done.");
        if (who === "user" && state.active.userId !== userId) return await reply("Only this session's customer can use I'm done.");
        await reply("Ending this 1-on-1 and inviting the next person in line.");
        return await finishOneOnOne(textId, userId, d.member, who === "staff");
      }
      if (d.type === 3 && d.data?.custom_id === "ticket:lobby:create") {
        if (d.channel_id !== ticketLobbyId) return await reply("Use Create a Ticket under Support.");
        return await api(callback, "POST", { type: 9, data: {
          custom_id: "ticket:lobby:submit", title: "Create a support ticket",
          components: [{ type: 1, components: [{
            type: 4, custom_id: "issue", label: "What do you need help with?",
            style: 2, min_length: 10, max_length: 1000, required: true
          }] }]
        } });
      }
      if (d.type === 5 && d.data?.custom_id === "ticket:lobby:submit") {
        const issue = String(d.data.components?.[0]?.components?.find(item => item.custom_id === "issue")?.value || "").trim();
        if (d.channel_id !== ticketLobbyId || issue.length < 10 || issue.length > 1000) {
          return await reply("Please describe your issue in the Create a Ticket form under Support.");
        }
        await api(callback, "POST", { type: 5, data: { flags: 64 } });
        try {
          const channelId = await openTicket(userId, issue);
          return await api(`/webhooks/${appId}/${d.token}/messages/@original`, "PATCH", {
            content: `Your private ticket is ready: https://discord.com/channels/${guildId}/${channelId}`
          });
        } catch (error) {
          console.error("Discord ticket form:", error.message);
          return await api(`/webhooks/${appId}/${d.token}/messages/@original`, "PATCH", {
            content: "Your ticket could not be opened. Please contact Support Staff." });
        }
      }
      if (d.type === 3 && /^ticket:create:\d{17,22}$/.test(d.data?.custom_id || "")) {
        if (d.channel_id !== askChannelId || d.data.custom_id.split(":")[2] !== userId) return await reply("Only the person who asked can open this private ticket.");
        await api(callback, "POST", { type: 5, data: { flags: 64 } });
        try {
          const channelId = await openTicket(userId);
          return await api(`/webhooks/${appId}/${d.token}/messages/@original`, "PATCH", { content: `Your private ticket is ready: https://discord.com/channels/${guildId}/${channelId}` });
        } catch (error) {
          console.error("Discord ticket create:", error.message);
          return await api(`/webhooks/${appId}/${d.token}/messages/@original`, "PATCH", { content: "Unable to open a private ticket. Please ask in the support channel." });
        }
      }
      if (d.type === 3 && /^ticket:close:\d{17,22}$/.test(d.data?.custom_id || "")) {
        if (d.channel_id !== d.data.custom_id.split(":")[2]) return await reply("This ticket button is not in the right channel.");
        const ticket = (await readTickets()).find(item => item.channelId === d.channel_id);
        const staff = d.member?.roles?.includes(staffRoleId) || userId === ownerId || (BigInt(d.member?.permissions || "0") & 8n) === 8n;
        if (!ticket || (ticket.userId !== userId && !staff)) return await reply("Only the customer or support staff can close this ticket.");
        await reply("Closing this support ticket.");
        return await closeTicket(d.channel_id, userId, d.member);
      }
      if (d.type !== 2 || !["link", "ask"].includes(name)) return;
      if (name === "link") {
        const code = String(d.data.options?.find(item => item.name === "code")?.value || "").trim().toUpperCase();
        const message = await consumeCode(dataDir, code, userId, d.member?.user?.username, getAccounts, saveAccounts);
        if (message) return await reply(message);
        try { const account = (await getAccounts()).find(item => item.discordUserId === userId); await syncMember(userId, await getAllowance(account.id)); }
        catch (error) { console.error("Discord role after linking:", error.message); }
        return await reply("Your Discord account is linked. Your membership role will update automatically.");
      }
      if (d.channel_id !== askChannelId) return await reply("Please use /ask in #ask-ai.");
      const question = String(d.data.options?.find(item => item.name === "question")?.value || "").trim();
      if (!question || question.length > 900) return await reply("Please enter a question under 900 characters.");
      if (Date.now() - (recent.get(userId) || 0) < 4000) return await reply("Please wait a few seconds before asking another question.");
      recent.set(userId, Date.now());
      await api(callback, "POST", { type: 5, data: { flags: 64 } });
      const posted = await answerInChannel(userId, question);
      await api(`/webhooks/${appId}/${d.token}/messages/@original`, "PATCH", { content: `I replied to you in <#${askChannelId}>: https://discord.com/channels/${guildId}/${askChannelId}/${posted.id}` });
    } catch (error) { console.error("Discord interaction:", error.message); }
  }
  let socket, sequence = null, heartbeat, reconnectDelay = 1000, closed = false, contentIntentEnabled = true;
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
            socket.send(JSON.stringify({ op: 2, d: { token, intents: 1 | 512 | (contentIntentEnabled ? 32768 : 0), properties: { os: "linux", browser: "slabsngrabsaco", device: "slabsngrabsaco" } } }));
          }
          if (packet.op === 1 && socket.readyState === 1) socket.send(JSON.stringify({ op: 1, d: sequence }));
          if (packet.op === 7 || packet.op === 9) socket.close();
          if (packet.t === "READY") {
            reconnectDelay = 1000;
            discordCommunityStatus.gatewayReady = true;
            discordCommunityStatus.messageContentReady = contentIntentEnabled;
          }
          if (packet.t === "INTERACTION_CREATE") void interaction(packet);
          if (packet.t === "MESSAGE_CREATE") void onQuestionMessage(packet.d);
        } catch (error) { console.error("Discord gateway packet:", error.message); }
      });
      socket.addEventListener("close", event => {
        discordCommunityStatus.gatewayReady = false;
        discordCommunityStatus.messageContentReady = false;
        if (event.code === 4014 && contentIntentEnabled) {
          contentIntentEnabled = false;
          discordCommunityStatus.error = "Enable Message Content Intent in the Discord Developer Portal → Bot → Privileged Gateway Intents, then redeploy the service. /ask still works until then.";
        } else if (event.code === 4013) {
          discordCommunityStatus.error = "Discord rejected gateway intents (4013). Check the bot application settings.";
        }
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
    catch (error) { discordCommunityStatus.error = error.message; console.error("Discord community setup:", error.message); setTimeout(setup, 60000).unref?.(); }
  }
  setTimeout(setup, 5000).unref?.();
  setInterval(syncAll, 60000).unref?.();
  setInterval(() => {
    if (!discordCommunityStatus.oneOnOneReady) return;
    void withSessions(async () => reconcileSessions(await readSessions())).catch(error => {
      discordCommunityStatus.error = `1-on-1 queue: ${error.message}`;
      console.error("Discord 1-on-1 queue:", error.message);
    });
  }, 60000).unref?.();
}
