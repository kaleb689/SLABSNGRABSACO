import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src=fs.readFileSync(new URL("../discord-community.js",import.meta.url),"utf8");
const report=fs.readFileSync(new URL("../discord-live-drop-recap.js",import.meta.url),"utf8");
const begin=src.indexOf("// Owner buttons and public announcements belong to the paid-member ACO");
const end=src.indexOf("// Reuse the owner's existing Target SKUs channel",begin);
const block=src.slice(begin,end);

test("Owner drop controls go in the ACO member server Admin Only, never a DM or TCG source server",()=>{
  assert.ok(begin>=0&&end>begin);
  assert.match(block,/const controlGuildId=String\(guildId\)/);
  assert.match(block,/normalizeName\(ch.name\)==="adminonly"/);
  assert.match(block,/parent_id:adminCategory\.id/);
  assert.match(block,/controlChannelId:String\(controls.id\)/);
  assert.match(block,/mode:"admin_channel"/);
  assert.doesNotMatch(block,/\/users\/@me\/channels/);
  assert.doesNotMatch(block,/mode:"owner_dm"/);
  assert.doesNotMatch(block,/getSource\(token/);
});
test("Recap calculations still use only the original SLABSNGRABSTC Success source",()=>{
  assert.match(block,/recapSourceChannelId:SLABSNGRABSTC_SUCCESS_CHANNEL_ID/);
  assert.match(report,/SLABSNGRABSTC_SUCCESS_CHANNEL_ID/);
  assert.match(report,/getSource\(token/);
  assert.match(block,/generalChannelId:general.id,controlChannelId:controls.id/);
});
test("Bot fails closed without a private Admin Only category and retries after setup",()=>{
  assert.match(block,/if\(!adminCategory\)/);
  assert.match(block,/ACO Admin Only category is not yet ready/);
  assert.match(block,/discordCommunityStatus\.dropControls=\{\s*ready:false/);
  assert.match(src,/dropProvisionRetryRunning=false/);
  assert.match(src,/discordCommunityStatus\.dropControls\?\.ready\)return/);
  assert.match(src,/void provision\(\)/);
  assert.match(src,/\},3\*60000\)\.unref/);
});
