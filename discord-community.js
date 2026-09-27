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

export const discordCommunityStatus = { configured: false, rolesReady: false, askChannelReady: false, ticketSupportReady: false, ticketLobbyReady: false, adminChannelsReady: false, importantReady: false, introReady: false, rulesReady: false, giveawayReady: false, suggestionsReady: false, oneOnOneReady: false, oneOnOneQueued: 0, oneOnOneActive: false, gatewayReady: false, messageContentReady: false, aiConfigured: false, lastRoleSyncAt: null, lastAnswerAt: null, lastAiError: null, error: null };
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
  let guildId, askChannelId, supportCategoryId, alertsChannelId, ticketLobbyId, oneOnOneLobbyId, chatCategoryId, introChannelId, rulesChannelId, giveawayChannelId, suggestionChannelId, ownerId, staffRoleId, appId, roles = [];
  const normalizeName = name => String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  function sameOverwrites(actual, expected) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every(wanted =>
      actual.some(item => item.id === wanted.id && Number(item.type) === wanted.type &&
        String(item.allow || "0") === String(wanted.allow || "0") &&
        String(item.deny || "0") === String(wanted.deny || "0")));
  }
  function readOnlyOverwrites() {
    const noPosting = (2048n | 64n | (1n << 35n) | (1n << 36n) | (1n << 38n)).toString();
    return [
      { id: guildId, type: 0, allow: "66560", deny: noPosting },
      { id: appId, type: 1, allow: "68624" },
      ...(staffRoleId ? [{ id: staffRoleId, type: 0, allow: "68608" }] : []),
      ...(ownerId ? [{ id: ownerId, type: 1, allow: "68608" }] : [])
    ];
  }
  async function ensureReadOnly(channel, parentId) {
    const expected = readOnlyOverwrites();
    if (!sameOverwrites(channel.permission_overwrites, expected) ||
      (parentId !== undefined && channel.parent_id !== parentId)) {
      channel = await api(`/channels/${channel.id}`, "PATCH", {
        ...(parentId !== undefined ? { parent_id: parentId } : {}),
        permission_overwrites: expected
      });
    }
    return channel;
  }
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
      const publicTicketOverwrites = readOnlyOverwrites();
      let lobby = channels.find(item => item.type === 0 &&
        ["createaticket", "createticket"].includes(item.name.toLowerCase().replace(/[^a-z0-9]/g, "")));
      if (!lobby) lobby = await api(`/guilds/${guildId}/channels`, "POST", {
        name: "create-a-ticket", type: 0, parent_id: support.id,
        permission_overwrites: publicTicketOverwrites
      });
      else lobby = await ensureReadOnly(lobby, support.id);
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
      let adminCategory = channels.find(item => item.type === 4 && normalizeName(item.name) === "adminonly");
      if (!adminCategory) adminCategory = await api(`/guilds/${guildId}/channels`, "POST", {
        name: "Admin Only", type: 4, permission_overwrites: adminOverwrites
      });
      else if (!sameOverwrites(adminCategory.permission_overwrites, adminOverwrites)) {
        adminCategory = await api(`/channels/${adminCategory.id}`, "PATCH", { permission_overwrites: adminOverwrites });
      }
      const oldCategories = channels.filter(item => item.type === 4 && adminNames.has(normalizeName(item.name)));
      // Hide old category drop-downs before moving their children.
      for (const category of oldCategories) {
        if (!sameOverwrites(category.permission_overwrites, adminOverwrites)) {
          await api(`/channels/${category.id}`, "PATCH", { permission_overwrites: adminOverwrites });
        }
      }
      const oldIds = new Set(oldCategories.map(item => item.id));
      const adminChannels = channels.filter(item => item.type !== 4 &&
        (adminNames.has(normalizeName(item.name)) || oldIds.has(item.parent_id) || item.parent_id === adminCategory.id));
      for (const adminChannel of adminChannels) {
        const expected = [2, 13].includes(adminChannel.type) ? [
          { id: guildId, type: 0, deny: "1024" },
          { id: staffRoleId, type: 0, allow: "3146752" },
          { id: appId, type: 1, allow: "3146768" },
          ...(ownerId ? [{ id: ownerId, type: 1, allow: "3146752" }] : [])
        ] : adminOverwrites;
        if (adminChannel.parent_id !== adminCategory.id || !sameOverwrites(adminChannel.permission_overwrites, expected)) {
          await api(`/channels/${adminChannel.id}`, "PATCH", {
            parent_id: adminCategory.id, permission_overwrites: expected
          });
        }
      }
      for (const category of oldCategories) await api(`/channels/${category.id}`, "DELETE");
      const foundNames = new Set(channels.filter(item => adminNames.has(normalizeName(item.name))).map(item => normalizeName(item.name)));
      discordCommunityStatus.adminChannelsReady = [...adminNames].every(name => foundNames.has(name));
      if (!discordCommunityStatus.adminChannelsReady) {
        adminError = `Admin Only: missing ${[...adminNames].filter(name => !foundNames.has(name)).join(", ")}`;
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
    let lobby = channels.find(item => item.type === 0 && item.parent_id === chat.id && item.name === "1-on-1");
    if (!lobby) lobby = channels.find(item => item.type === 0 && item.name === "1-on-1");
    if (lobby) lobby = await ensureReadOnly(lobby, chat.id);
    if (!lobby) lobby = await api(`/guilds/${guildId}/channels`, "POST", {
      name: "1-on-1", type: 0, parent_id: chat.id,
      permission_overwrites: readOnlyOverwrites(),
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
    let importantError = null;
    try {
      const names = ["upcomingdrops", "droppingtonight", "announcements"];
      const found = names.map(name => channels.find(item => [0, 5].includes(item.type) && normalizeName(item.name) === name));
      let important = channels.find(item => item.type === 4 && normalizeName(item.name) === "important");
      if (!important) important = await api(`/guilds/${guildId}/channels`, "POST", { name: "Important", type: 4 });
      const chat = channels.find(item => item.id === chatCategoryId);
      if (chat && important.position >= chat.position) {
        await api(`/guilds/${guildId}/channels`, "PATCH", [
          { id: important.id, position: chat.position }, { id: chat.id, position: chat.position + 1 }
        ]);
      }
      for (const [index, channel] of found.entries()) {
        if (!channel) continue;
        if (channel.parent_id !== important.id || channel.position !== index) {
          await api(`/channels/${channel.id}`, "PATCH", {
            parent_id: important.id, position: index,
            permission_overwrites: channel.permission_overwrites || []
          });
        }
      }
      const pinned = channels.find(item => item.type === 4 && normalizeName(item.name) === "pinnedchannels");
      if (pinned && !channels.some(item => item.parent_id === pinned.id && !found.some(target => target?.id === item.id))) {
        await api(`/channels/${pinned.id}`, "DELETE");
      }
      discordCommunityStatus.importantReady = found.every(Boolean);
      if (!discordCommunityStatus.importantReady) {
        importantError = `Important: missing ${names.filter((name, index) => !found[index]).join(", ")}`;
      }
    } catch (error) {
      importantError = `Important category: ${error.message}`;
      console.error("Discord Important category:", error.message);
    }
    let communityError = null;
    try {
      // Leave other system-message settings intact while suppressing join posts.
      if (!(Number(guild.system_channel_flags || 0) & 1)) {
        await api(`/guilds/${guildId}`, "PATCH", { system_channel_flags: Number(guild.system_channel_flags || 0) | 1 })
          .catch(error => console.error("Discord join announcement setting:", error.message));
      }
      const successChannel = channels.find(item => item.id === channelId);
      await ensureReadOnly(successChannel);
      let intro = channels.find(item => item.type === 0 && ["introserver", "serverintro", "intro"].includes(normalizeName(item.name)));
      if (!intro) intro = await api(`/guilds/${guildId}/channels`, "POST", {
        name: "intro-server", type: 0, position: 0,
        topic: "Start here for a guide to the server and its channels.",
        permission_overwrites: readOnlyOverwrites()
      });
      else intro = await ensureReadOnly(intro, null);
      introChannelId = intro.id;
      if (intro.position !== 0 || intro.parent_id) await api(`/channels/${intro.id}`, "PATCH", { position: 0, parent_id: null });
      let rules = channels.find(item => item.type === 0 && ["rules", "serverrules"].includes(normalizeName(item.name)));
      if (!rules) rules = await api(`/guilds/${guildId}/channels`, "POST", {
        name: "rules", type: 0, position: 1,
        topic: "Read the SLABSNGRABSACO community rules before joining the conversation.",
        permission_overwrites: readOnlyOverwrites()
      });
      else rules = await ensureReadOnly(rules, null);
      rulesChannelId = rules.id;
      if (rules.position !== 1 || rules.parent_id) await api(`/channels/${rules.id}`, "PATCH", { position: 1, parent_id: null });
      let giveaway = channels.find(item => item.type === 0 && ["giveaway", "giveaways"].includes(normalizeName(item.name)));
      if (!giveaway) giveaway = await api(`/guilds/${guildId}/channels`, "POST", {
        name: "giveaways", type: 0, topic: "Enter active giveaways with the button. Winners are selected when each giveaway ends.",
        permission_overwrites: readOnlyOverwrites()
      });
      else giveaway = await ensureReadOnly(giveaway);
      giveawayChannelId = giveaway.id;
      let suggestions = channels.find(item => item.type === 0 && ["suggestion", "suggestions"].includes(normalizeName(item.name)));
      const suggestionOverwrites = [
        { id: guildId, type: 0, allow: "68608" },
        { id: appId, type: 1, allow: "68624" }
      ];
      if (!suggestions) suggestions = await api(`/guilds/${guildId}/channels`, "POST", {
        name: "suggestions", type: 0,
        topic: "Share suggestions for this Discord server or the website. Do not post private account information.",
        permission_overwrites: suggestionOverwrites
      });
      else if (suggestions.topic !== "Share suggestions for this Discord server or the website. Do not post private account information." ||
        suggestions.parent_id || !sameOverwrites(suggestions.permission_overwrites, suggestionOverwrites)) {
        suggestions = await api(`/channels/${suggestions.id}`, "PATCH", {
          topic: "Share suggestions for this Discord server or the website. Do not post private account information.",
          parent_id: null, permission_overwrites: suggestionOverwrites
        });
      }
      suggestionChannelId = suggestions.id;
      await ensurePanel(suggestionChannelId, "suggestions",
        "Have a suggestion for our Discord server or website? Post it here. Ideas for channels, features, and improvements are welcome. Keep customer and payment details out of public chat.");
      const general = channels.find(item => item.type === 0 && normalizeName(item.name) === "general");
      if (general) await ensurePanel(general.id, "general",
        "Welcome to #general. This is the place for everyday conversation: say hello, share what is on your mind, and talk with the community. Please keep private account and payment details out of public chat.");
      const questions = channels.find(item => item.type === 0 && normalizeName(item.name) === "questions");
      if (questions) {
        const questionText = "Ask any question here: drops, TCG items, the website, Discord, or anything else on your mind. For private account help, open a ticket under Support.";
        if (questions.topic !== questionText) await api(`/channels/${questions.id}`, "PATCH", { topic: questionText });
        await ensurePanel(questions.id, "questions", questionText);
      }
      await ensurePanel(giveawayChannelId, "giveaways",
        "Giveaways appear here. Click **Enter Giveaway** on an active post to join; members cannot type in this channel. The bot draws the configured number of winners when the timer ends and mentions them in a result post. The owner or Support Staff can use Create Giveaway below.",
        { components: [{ type: 1, components: [{ type: 2, style: 2,
          label: "Create Giveaway (staff)", custom_id: "giveaway:create" }] }] });
      await ensurePanel(rulesChannelId, "rules", "Please read these rules before joining the conversation.", {
        embeds: [{
          title: "SLABSNGRABSACO Rules",
          description: "**Welcome to the SLABSNGRABSACO server!**\n\n**Please follow these rules:**\n\n" +
            "• Respect everyone. Hate speech, harassment, discrimination, threats, and targeted abuse are not allowed.\n\n" +
            "• Do not advertise other servers, products, or services without permission. No spam or self-promotion.\n\n" +
            "• Keep passwords, verification codes, payment details, addresses, and other private information out of public channels. Use a private support ticket when account help is needed.\n\n" +
            "• Follow the policies on [our website](https://slabsngrabsaco.com) and the rules for any retailer or platform you use.\n\n" +
            "• Keep conversations helpful and on topic. Use #questions for drops, TCG items, site, or Discord questions; share suggestions in #suggestions.\n\n" +
            "**Moderation:** Rule violations may lead to a warning, removal of content, a kick, or a ban.",
          color: 0xf258b5,
          thumbnail: { url: "https://slabsngrabsaco.com/slabsngrabs-aco-logo.png" }
        }]
      });
      await refreshIntro();
      await cleanupClosedTickets();
      await finishDueGiveaways();
      discordCommunityStatus.introReady = true;
      discordCommunityStatus.rulesReady = true;
      discordCommunityStatus.giveawayReady = true;
      discordCommunityStatus.suggestionsReady = true;
      try {
        const onboarding = await api(`/guilds/${guildId}/onboarding`);
        if (onboarding.enabled && [introChannelId, rulesChannelId].some(id => !onboarding.default_channel_ids.includes(id))) {
          await api(`/guilds/${guildId}/onboarding`, "PUT", {
            prompts: onboarding.prompts,
            default_channel_ids: [...new Set([introChannelId, rulesChannelId, ...onboarding.default_channel_ids])],
            enabled: onboarding.enabled, mode: onboarding.mode
          });
        }
      } catch (error) { console.error("Discord intro onboarding:", error.message); }
    } catch (error) {
      communityError = `Community channels: ${error.message}`;
      console.error("Discord community channels:", error.message);
    }
    for (const command of [
      { name: "link", description: "Link your website account to your Discord membership", options: [{ type: 3, name: "code", description: "Your private code from My Profile", required: true }] },
      { name: "ask", description: "Ask the support AI a website or botting question", options: [{ type: 3, name: "question", description: "Your question (no private account details)", required: true }] },
      { name: "giveaway", description: "Start a giveaway in #giveaways (owner or Support Staff)", options: [
        { type: 3, name: "title", description: "Prize or giveaway title", required: true, max_length: 100 },
        { type: 4, name: "minutes", description: "How long entries stay open (1–525600 minutes)", required: true, min_value: 1, max_value: 525600 },
        { type: 4, name: "winners", description: "How many winners to draw (1–20)", required: true, min_value: 1, max_value: 20 }
      ] }
    ]) await api(`/applications/${appId}/guilds/${guildId}/commands`, "POST", command);
    discordCommunityStatus.rolesReady = roles.length === LEVELS.length;
    discordCommunityStatus.error = [ticketLobbyError, adminError, oneOnOneError, importantError, communityError].filter(Boolean).join("; ") || null;
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
  const pendingAlertsFile = path.join(dataDir, "discord-pending-support-alerts.json");
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
  async function readPendingAlerts() {
    try {
      const value = JSON.parse(await fs.readFile(pendingAlertsFile, "utf8"));
      return Array.isArray(value) ? value : [];
    } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }
  async function writePendingAlerts(records) {
    await fs.mkdir(dataDir, { recursive: true });
    const temp = `${pendingAlertsFile}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(records), { mode: 0o600 });
    await fs.rename(temp, pendingAlertsFile);
  }
  const mention = id => `<@${id}>`;
  async function sendMessage(channelId, content, extras = {}) {
    const { users = [], ...other } = extras;
    return api(`/channels/${channelId}/messages`, "POST", { content, allowed_mentions: { parse: [], users }, ...other });
  }
  const panelFile = path.join(dataDir, "discord-channel-panels.json");
  let panelQueue = Promise.resolve();
  function withPanels(task) {
    const next = panelQueue.then(task);
    panelQueue = next.catch(() => {});
    return next;
  }
  async function ensurePanel(channelId, key, content, extras = {}) {
    return withPanels(async () => {
      let panels = {};
      try { panels = JSON.parse(await fs.readFile(panelFile, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const previous = panels[key];
      const payload = { content, ...extras, allowed_mentions: { parse: [] } };
      if (previous?.channelId === channelId && previous.messageId) {
        try {
          const old = await api(`/channels/${channelId}/messages/${previous.messageId}`);
          if (old.content !== content ||
            (old.embeds?.[0]?.description || "") !== (extras.embeds?.[0]?.description || "")) {
            await api(`/channels/${channelId}/messages/${previous.messageId}`, "PATCH", payload);
          }
          return previous.messageId;
        } catch (error) { if (!/HTTP 404/.test(error.message)) throw error; }
      }
      const message = await sendMessage(channelId, content, extras);
      panels[key] = { channelId, messageId: message.id };
      await fs.mkdir(dataDir, { recursive: true });
      const temp = `${panelFile}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temp, JSON.stringify(panels), { mode: 0o600 });
      await fs.rename(temp, panelFile);
      await api(`/channels/${channelId}/pins/${message.id}`, "PUT").catch(error => console.error("Discord panel pin:", error.message));
      return message.id;
    });
  }
  let introRefreshTimer;
  async function refreshIntro() {
    if (!introChannelId || !guildId) return;
    const channels = await api(`/guilds/${guildId}/channels`);
    const categories = new Map(channels.filter(item => item.type === 4).map(item => [item.id, item]));
    const hidden = channel => {
      const parent = categories.get(channel.parent_id);
      const deniesView = item => item?.permission_overwrites?.some(overwrite =>
        overwrite.id === guildId && (BigInt(overwrite.deny || "0") & 1024n) !== 0n);
      return deniesView(channel) || deniesView(parent) ||
        ["admin", "adminonly", "adminprofiles", "actionneeded"].includes(normalizeName(parent?.name)) ||
        /^(ticket-|one-on-one-|1-on-1 voice)/i.test(channel.name) ||
        ["supportalerts", "aisupportalerts"].includes(normalizeName(channel.name));
    };
    const descriptions = {
      introserver: "Start here: this guide updates when channels change.",
      rules: "Read the server rules before participating.",
      general: "Open conversation with the community.",
      questions: "Ask about drops, TCG items, the site, Discord, or anything else.",
      askai: "Ask the support bot; open a private ticket for account-specific help.",
      createaticket: "Use the button and private form for help from the owner or Support Staff.",
      "1on1": "Request private text and voice help; requests wait in a queue.",
      success: "View community success updates.",
      upcomingdrops: "See upcoming drops and release information.",
      droppingtonight: "See what is dropping tonight.",
      announcements: "Read important server announcements.",
      giveaways: "Enter active giveaways with their buttons and see winners.",
      suggestions: "Share ideas for the Discord server or website."
    };
    const visible = channels.filter(item => [0, 5].includes(item.type) && !hidden(item));
    visible.sort((a, b) => {
      const aParent = categories.get(a.parent_id), bParent = categories.get(b.parent_id);
      return (aParent?.position ?? -1) - (bParent?.position ?? -1) ||
        (a.parent_id || "").localeCompare(b.parent_id || "") || a.position - b.position;
    });
    const lines = ["Welcome to the server. Choose a channel below to get started:"];
    let lastCategory = "";
    for (const channel of visible) {
      const category = categories.get(channel.parent_id)?.name || "Main";
      if (category !== lastCategory) { lines.push(`\n**${category}**`); lastCategory = category; }
      const name = normalizeName(channel.name);
      const description = descriptions[name] || (channel.id === introChannelId ? descriptions.introserver :
        String(channel.topic || "Community channel.").replace(/\s+/g, " ").slice(0, 110));
      lines.push(`<#${channel.id}> — ${description}`);
    }
    const description = lines.join("\n").slice(0, 4000);
    await ensurePanel(introChannelId, "intro", "Server channel guide", {
      embeds: [{ title: "Welcome to SLABSNGRABSACO", description, color: 0x41b6e6 }]
    });
  }
  function scheduleIntroRefresh() {
    clearTimeout(introRefreshTimer);
    introRefreshTimer = setTimeout(() => void refreshIntro().catch(error =>
      console.error("Discord intro refresh:", error.message)), 2000);
    introRefreshTimer.unref?.();
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
    const alert = await sendMessage(alertsChannelId,
      `${ping} — ${mention(userId)} needs help beyond the AI assistant. They were offered a private ticket. https://discord.com/channels/${guildId}/${askChannelId}/${messageId}`,
      { users: [ownerId, userId].filter(Boolean) });
    await withTickets(async () => {
      const records = await readTickets();
      const open = records.find(item => item.userId === userId && item.guildId === guildId && !item.closed);
      if (open) {
        open.alertMessageIds = [...new Set([...(open.alertMessageIds || []), alert.id])];
        await writeTickets(records);
      } else {
        const pending = await readPendingAlerts();
        pending.push({ guildId, userId, messageId: alert.id });
        await writePendingAlerts(pending);
      }
    });
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
        const pending = await readPendingAlerts();
        const linked = pending.filter(item => item.userId === userId && item.guildId === guildId);
        await writeTickets([...records.filter(item => item.userId !== userId || item.guildId !== guildId), {
          guildId, userId, channelId: channel.id, alertMessageIds: linked.map(item => item.messageId)
        }]);
        if (linked.length) await writePendingAlerts(pending.filter(item => !linked.includes(item)));
      } catch (error) {
        await api(`/channels/${channel.id}`, "DELETE").catch(() => {});
        throw error;
      }
      if (alertsChannelId) await sendMessage(alertsChannelId,
        `${ownerId ? mention(ownerId) : "Support Staff"} — ${mention(userId)} opened a private support ticket: <#${channel.id}>.`,
        { users: [ownerId].filter(Boolean) }).then(async alert => {
          const saved = await readTickets();
          const record = saved.find(item => item.channelId === channel.id);
          if (record) { record.alertMessageId = alert.id; await writeTickets(saved); }
        }).catch(error => {
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
      ticket.closed = true;
      await writeTickets(records);
      for (const id of [ticket.alertMessageId, ...(ticket.alertMessageIds || [])].filter(Boolean)) {
        try { await api(`/channels/${alertsChannelId}/messages/${id}`, "DELETE"); }
        catch (error) { if (!/HTTP 404/.test(error.message)) throw error; }
      }
      await writeTickets(records.filter(item => item !== ticket));
    });
  }
  async function cleanupClosedTickets() {
    if (!alertsChannelId) return;
    await withTickets(async () => {
      const records = await readTickets();
      const keep = [];
      for (const ticket of records) {
        if (!ticket.closed || ticket.guildId !== guildId) { keep.push(ticket); continue; }
        let failure = false;
        for (const id of [ticket.alertMessageId, ...(ticket.alertMessageIds || [])].filter(Boolean)) {
          try { await api(`/channels/${alertsChannelId}/messages/${id}`, "DELETE"); }
          catch (error) { if (!/HTTP 404/.test(error.message)) failure = true; }
        }
        if (failure) keep.push(ticket);
      }
      if (keep.length !== records.length) await writeTickets(keep);
    });
  }
  const giveawayFile = path.join(dataDir, "discord-giveaways.json");
  let giveawayQueue = Promise.resolve();
  function withGiveaways(task) {
    const next = giveawayQueue.then(task);
    giveawayQueue = next.catch(() => {});
    return next;
  }
  async function readGiveaways() {
    try {
      const value = JSON.parse(await fs.readFile(giveawayFile, "utf8"));
      return Array.isArray(value) ? value : [];
    } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }
  async function writeGiveaways(records) {
    await fs.mkdir(dataDir, { recursive: true });
    const temp = `${giveawayFile}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(records), { mode: 0o600 });
    await fs.rename(temp, giveawayFile);
  }
  async function createGiveaway(title, minutes, winnerCount, creatorId) {
    return withGiveaways(async () => {
      const id = crypto.randomBytes(8).toString("hex");
      const endAt = Date.now() + minutes * 60000;
      const content = `🎁 **${title}**\nEnter with the button below. Closes <t:${Math.floor(endAt / 1000)}:R>. ${winnerCount} winner${winnerCount === 1 ? "" : "s"} will be drawn at random.`;
      const message = await sendMessage(giveawayChannelId, content, { components: [{ type: 1, components: [
        { type: 2, style: 1, label: "Enter Giveaway", custom_id: `giveaway:enter:${id}` }
      ] }] });
      try {
        const records = await readGiveaways();
        records.push({ id, guildId, channelId: giveawayChannelId, messageId: message.id, title,
          creatorId, endAt, winnerCount, entrants: [], status: "open" });
        await writeGiveaways(records);
      } catch (error) {
        await api(`/channels/${giveawayChannelId}/messages/${message.id}`, "DELETE").catch(() => {});
        throw error;
      }
      return message;
    });
  }
  async function enterGiveaway(id, userId, messageId) {
    return withGiveaways(async () => {
      const records = await readGiveaways();
      const item = records.find(record => record.id === id && record.guildId === guildId &&
        record.channelId === giveawayChannelId && record.messageId === messageId);
      if (!item) return "This giveaway is unavailable.";
      if (item.status !== "open" || Date.now() >= item.endAt) return "This giveaway has closed.";
      if (item.entrants.includes(userId)) return "You are already entered.";
      item.entrants.push(userId);
      await writeGiveaways(records);
      return "You are entered! Winners will be mentioned here after the giveaway closes.";
    });
  }
  async function finishDueGiveaways() {
    if (!giveawayChannelId || !guildId) return;
    await withGiveaways(async () => {
      const records = await readGiveaways();
      for (const item of records.filter(record => record.guildId === guildId &&
        record.status !== "ended" && record.endAt <= Date.now())) {
        if (item.status === "open") {
          const eligible = [];
          for (const userId of item.entrants) {
            try { await api(`/guilds/${guildId}/members/${userId}`); eligible.push(userId); }
            catch (error) { if (!/HTTP 404/.test(error.message)) throw error; }
          }
          const winners = [];
          while (eligible.length && winners.length < item.winnerCount) {
            winners.push(eligible.splice(crypto.randomInt(eligible.length), 1)[0]);
          }
          item.winners = winners;
          item.status = "drawn";
          await writeGiveaways(records);
        }
        try {
          await api(`/channels/${item.channelId}/messages/${item.messageId}`, "PATCH", {
            components: [{ type: 1, components: [{ type: 2, style: 2, label: "Giveaway closed",
              custom_id: `giveaway:enter:${item.id}`, disabled: true }] }]
          });
        } catch (error) { if (!/HTTP 404/.test(error.message)) throw error; }
        const result = item.winners.length
          ? `🎉 **${item.title}** has ended! Congratulations ${item.winners.map(mention).join(", ")}!`
          : `**${item.title}** has ended. There were no eligible entries.`;
        if (!item.announcementId) {
          // A saved draw is reused after a restart, so the winners never change.
          const announcement = await sendMessage(item.channelId, result,
            { users: item.winners, message_reference: { message_id: item.messageId, fail_if_not_exists: false } });
          item.announcementId = announcement.id;
        }
        item.status = "ended";
        await writeGiveaways(records);
      }
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
      if (d.type === 3 && d.data?.custom_id === "giveaway:create") {
        if (d.channel_id !== giveawayChannelId || !supportStaff(d.member, userId)) {
          return await reply("Only the owner or Support Staff can create a giveaway in #giveaways.");
        }
        return await api(callback, "POST", { type: 9, data: {
          custom_id: "giveaway:submit", title: "Create a giveaway",
          components: [
            { type: 1, components: [{ type: 4, custom_id: "title", label: "Prize or title", style: 1, min_length: 2, max_length: 100, required: true }] },
            { type: 1, components: [{ type: 4, custom_id: "minutes", label: "Duration in minutes (1 to 525600)", style: 1, required: true }] },
            { type: 1, components: [{ type: 4, custom_id: "winners", label: "Number of winners (1 to 20)", style: 1, required: true }] }
          ]
        } });
      }
      if (d.type === 5 && d.data?.custom_id === "giveaway:submit") {
        if (d.channel_id !== giveawayChannelId || !supportStaff(d.member, userId)) {
          return await reply("Only the owner or Support Staff can create a giveaway.");
        }
        const value = key => String(d.data.components?.flatMap(row => row.components || [])
          .find(item => item.custom_id === key)?.value || "").trim();
        const title = value("title"), minutes = Number(value("minutes")), winners = Number(value("winners"));
        if (title.length < 2 || title.length > 100 || !Number.isInteger(minutes) || minutes < 1 || minutes > 525600 ||
          !Number.isInteger(winners) || winners < 1 || winners > 20) {
          return await reply("Enter a title, duration from 1 to 525600 minutes, and 1 to 20 winners.");
        }
        await api(callback, "POST", { type: 5, data: { flags: 64 } });
        const created = await createGiveaway(title, minutes, winners, userId);
        return await api(`/webhooks/${appId}/${d.token}/messages/@original`, "PATCH", {
          content: `Giveaway posted: https://discord.com/channels/${guildId}/${giveawayChannelId}/${created.id}`
        });
      }
      if (d.type === 3 && /^giveaway:enter:[0-9a-f]{16}$/.test(d.data?.custom_id || "")) {
        if (d.channel_id !== giveawayChannelId) return await reply("Use the Enter Giveaway button in #giveaways.");
        const result = await enterGiveaway(d.data.custom_id.split(":")[2], userId, d.message?.id);
        await reply(result);
        if (result === "This giveaway has closed.") void finishDueGiveaways().catch(error =>
          console.error("Discord giveaway draw:", error.message));
        return;
      }
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
          await openTicket(userId, issue);
          // The member is mentioned inside the new private room. Remove the
          // private acknowledgement from the public button channel.
          return await api(`/webhooks/${appId}/${d.token}/messages/@original`, "DELETE")
            .catch(error => console.error("Discord ticket acknowledgement cleanup:", error.message));
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
      if (d.type === 2 && name === "giveaway") {
        if (!supportStaff(d.member, userId)) return await reply("Only the owner or Support Staff can start a giveaway.");
        if (d.channel_id !== giveawayChannelId) return await reply("Run /giveaway in #giveaways.");
        const option = key => d.data.options?.find(item => item.name === key)?.value;
        const title = String(option("title") || "").trim();
        const minutes = Number(option("minutes")), winners = Number(option("winners"));
        if (!title || title.length > 100 || !Number.isInteger(minutes) || minutes < 1 || minutes > 525600 ||
          !Number.isInteger(winners) || winners < 1 || winners > 20) return await reply("Enter a title, 1–525600 minutes, and 1–20 winners.");
        await api(callback, "POST", { type: 5, data: { flags: 64 } });
        const created = await createGiveaway(title, minutes, winners, userId);
        return await api(`/webhooks/${appId}/${d.token}/messages/@original`, "PATCH", {
          content: `Giveaway posted: https://discord.com/channels/${guildId}/${giveawayChannelId}/${created.id}`
        });
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
          if (["CHANNEL_CREATE", "CHANNEL_UPDATE", "CHANNEL_DELETE"].includes(packet.t) &&
            packet.d?.guild_id === guildId) scheduleIntroRefresh();
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
  setInterval(() => {
    void finishDueGiveaways().catch(error => console.error("Discord giveaway draw:", error.message));
    void cleanupClosedTickets().catch(error => console.error("Discord ticket alert cleanup:", error.message));
  }, 15000).unref?.();
  setInterval(() => void refreshIntro().catch(error =>
    console.error("Discord intro refresh:", error.message)), 10 * 60000).unref?.();
}
