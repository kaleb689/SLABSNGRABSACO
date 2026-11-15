import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {safeSkuAuditItems,buildDiscordSkuAuditBatch} from "../discord-sku-audit.js";

const ctx={
  interactionId:"1611111111111111111",discordUserId:"1222222222222222222",
  guildId:"1333333333333333333",channelId:"1444444444444444444",
  messageId:"1555555555555555555",displayName:"Linked member",
  customId:"sku:confirm:1555555555555555555"
};
const item=(quantity=1)=>({
  key:"1444444444444444444:1555555555555555555:1012345678",
  sku:"1012345678",name:"Pokémon sealed product",retailer:"target",quantity,
  password:"never-log",cardNumber:"4111111111111111",shippingAddress:"private"
});
test("First confirmed selection includes verified interaction ID, safe snapshots and exact SKU",()=>{
  const batch=buildDiscordSkuAuditBatch({items:[]},{items:[item()]},ctx,new Date("2026-11-14T21:00:00Z"));
  assert.equal(batch.batchId,ctx.interactionId);
  assert.equal(batch.events.length,1);
  assert.equal(batch.events[0].action,"select");
  assert.equal(batch.events[0].sku,"1012345678");
  assert.equal(batch.events[0].retailer,"target");
  assert.equal(batch.events[0].sourceMessageId,"1555555555555555555");
  assert.equal(batch.afterState[0].quantity,1);
  assert.equal(batch.createdAt,"2026-11-14T21:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(batch),/never-log|4111111111111111|shippingAddress|private/);
});
test("Quantity changes, removals and batches create individual events",()=>{
  const increased=buildDiscordSkuAuditBatch({items:[item(1)]},{items:[item(2)]},ctx);
  assert.equal(increased.events[0].action,"increase");
  assert.equal(increased.events[0].afterQuantity,2);
  const removed=buildDiscordSkuAuditBatch({items:[item()]},{items:[]},ctx);
  assert.equal(removed.events[0].action,"deselect");
  assert.equal(removed.events[0].afterQuantity,0);
  const unchanged=buildDiscordSkuAuditBatch({items:[item(1)]},{items:[item(1)]},ctx);
  assert.equal(unchanged,null);
  const batch=buildDiscordSkuAuditBatch({items:[]},{items:[item(),{
    ...item(),sku:"99999999",key:"1444444444444444444:1555555555555555555:99999999"}]},ctx);
  assert.equal(batch.events.length,2);
  assert.equal(new Set(batch.events.map(event=>event.eventId)).size,2);
});
test("Opt-out and subsequent Run All are recorded even without an item-count change",()=>{
  const opted=buildDiscordSkuAuditBatch({items:[]},{items:[],skipTonightDate:"2026-11-14"},ctx);
  assert.equal(opted.events[0].action,"opt_out");
  const resume=buildDiscordSkuAuditBatch({items:[],skipTonightDate:"2026-11-14"},{items:[]},ctx);
  assert.equal(resume.events[0].action,"run_all");
});
test("Reject untrusted or missing Discord interaction and user IDs; never backfill",()=>{
  assert.equal(buildDiscordSkuAuditBatch({}, {items:[item()]},{...ctx,interactionId:"client-fake"}),null);
  assert.equal(buildDiscordSkuAuditBatch({}, {items:[item()]},{...ctx,discordUserId:"invalid"}),null);
  assert.equal(safeSkuAuditItems([{...item(),quantity:0}]).length,0);
});
test("Only authoritative Gateway SKU writes call append-only encrypted consent ledger",()=>{
  const discord=readFileSync(new URL("../discord-community.js",import.meta.url),"utf8");
  const server=readFileSync(new URL("../server.js",import.meta.url),"utf8");
  const admin=readFileSync(new URL("../public/admin.html",import.meta.url),"utf8");
  assert.match(discord,/new AsyncLocalStorage\(\)/);
  assert.match(discord,/skuAuditContext\.run\(/);
  assert.match(discord,/if \(file === skuSelectionsFile && typeof onSkuSelectionAudit === "function"\)/);
  assert.match(server,/onSkuSelectionAudit: appendDiscordSkuAuditBatch/);
  assert.match(server,/appendConsentRecord\(\{\s*type:"discord_sku_selection"/);
  assert.match(server,/account\.discordLinkedAt && String\(account\.discordUserId/);
  assert.match(server,/app\.get\("\/api\/admin\/discord-sku-selection-logs", requireAdmin/);
  assert.match(server,/readConsentLedger\(\)/);
  assert.match(admin,/id="discordSkuAuditPanel"/);
});
