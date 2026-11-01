import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = file => readFileSync(new URL("../" + file, import.meta.url), "utf8");
const slice = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start);
  assert.ok(start > -1 && end > start, startMarker);
  return source.slice(start, end);
};

test("giveaway entry count reports the saved entrants for the matching post", async () => {
  const bot = read("discord-community.js");
  const code = slice(bot, "function openGiveawayComponents(id)", "// Posts made before the count button");
  const records = [
    { id: "a1b2c3d4e5f60718", guildId: "g", channelId: "c", messageId: "m1", title: "Booster Box",
      entrants: ["1", "2", "3"], status: "open", endAt: Date.now() + 60000 },
    { id: "ffffffffffffffff", guildId: "g", channelId: "c", messageId: "m2", title: "Single Pack",
      entrants: ["1"], status: "ended", endAt: Date.now() - 60000 }
  ];
  const context = { guildId: "g", giveawayChannelId: "c", readGiveaways: async () => records, out: {} };
  vm.runInNewContext(code + "\nout.count = giveawayEntryCount; out.components = openGiveawayComponents;", context);
  const open = await context.out.count("a1b2c3d4e5f60718", "m1");
  assert.match(open, /Booster Box\*\*: 3 people have entered so far/);
  const closed = await context.out.count("ffffffffffffffff", "m2");
  assert.match(closed, /1 person has entered\. This giveaway has closed/);
  assert.equal(await context.out.count("a1b2c3d4e5f60718", "wrong-message"), "This giveaway is unavailable.");
  const buttons = [...context.out.components("a1b2c3d4e5f60718")[0].components].map(b => b.custom_id);
  assert.deepEqual(buttons, ["giveaway:enter:a1b2c3d4e5f60718", "giveaway:count:a1b2c3d4e5f60718"]);
});

test("only the server owner can open the entry count, and the reply is private", () => {
  const bot = read("discord-community.js");
  const handler = slice(bot, "/^giveaway:count:[0-9a-f]{16}$/", "/^giveaway:enter:[0-9a-f]{16}$/");
  assert.match(handler, /if \(!ownerId \|\| userId !== ownerId\) return await reply\("Only the server owner/);
  // reply() is the shared ephemeral (flags: 64) interaction response.
  assert.match(bot, /const reply = content => api\(callback, "POST", \{ type: 4, data: \{ content, flags: 64/);
  // Closed giveaways keep the count button so the final total stays viewable.
  assert.match(slice(bot, "async function finishDueGiveaways()", "const sessionFile"),
    /label: "Giveaway closed",[\s\S]*custom_id: `giveaway:count:\$\{item\.id\}`/);
});

test("admin lists include the Discord name saved on the linked website account", () => {
  const server = read("server.js");
  assert.match(slice(server, '"/api/admin/submissions",', '"/api/admin/free-submissions"'),
    /discordUsername:\s*String\(customerAccountMap\.get\(String\(record\.customerAccountId\)\)\?\.discordUsername \|\| ""\)\.trim\(\)/);
  assert.match(slice(server, '"/api/admin/free-submissions"', "subscriptionStatus:"),
    /discordUsername:\s*String\(account\.discordUsername \|\| ""\)\.trim\(\)/);
});

test("admin app shows an escaped Discord line under the customer's real name", () => {
  const mobile = read("public/admin-mobile.js");
  const escStart = mobile.indexOf("esc=v=>") + 4, escEnd = mobile.indexOf("}[c]));", escStart) + 6;
  assert.ok(escStart > 3 && escEnd > escStart);
  const esc = mobile.slice(escStart, escEnd);
  const code = slice(mobile, "function customerDiscordLine(x)", "\nfunction customerMoney");
  const context = { out: {} };
  vm.runInNewContext("const esc=" + esc + ";" + code + "\nout.line = customerDiscordLine;", context);
  assert.equal(context.out.line({ discordUsername: "@kaleb" }),
    '<small class="admin-customer-discord">Discord: @kaleb</small>');
  assert.equal(context.out.line({ discordUsername: "<b>x</b>" }),
    '<small class="admin-customer-discord">Discord: @&lt;b&gt;x&lt;/b&gt;</small>');
  assert.equal(context.out.line({}), "");
  assert.match(mobile, /'<strong>'\+esc\(customerName\(x\)\)\+'<\/strong>'\+customerDiscordLine\(x\)\+/);
});

test("admin website shows the Discord name under the customer's name and heading", () => {
  const admin = read("public/admin.html");
  const render = slice(admin, "function renderOrder(x)", "<div class=\"order-top-actions\">");
  assert.match(render, /Discord: @\$\{escapeHtml\(discordName\)\}/);
  assert.match(render, /<\/div>\s*\$\{discordLine\}\s*<small>/);
  assert.match(render, /<\/h2>\s*\$\{discordLine\}/);
});
