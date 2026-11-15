import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src=fs.readFileSync(new URL("../discord-community.js",import.meta.url),"utf8");
const begin=src.indexOf("// Serve the ORIGINAL SLABSNGRABSTC guild");
const end=src.indexOf("// Reuse the owner's existing Target SKUs channel",begin);
const block=src.slice(begin,end);
test("Owner drop controls are created in original TCG Admin category, never a DM",()=>{
  assert.ok(begin>=0 && end>begin);
  assert.match(block,/SLABSNGRABSTC_SUCCESS_CHANNEL_ID/);
  assert.match(block,/let adminCategory=sourceChannels\.find\(/);
  assert.match(block,/parent_id:adminCategory\.id/);
  assert.match(block,/mode:"admin_channel"/);
  assert.doesNotMatch(block,/\/users\/@me\/channels/);
  assert.doesNotMatch(block,/mode:"owner_dm"/);
});
test("Creates the missing private Admin category, but fails closed when Discord rejects permissions",()=>{
  assert.match(block,/if\(!adminCategory\)/);
  assert.match(block,/name:"Admin",type:4/);
  assert.match(block,/permission_overwrites:readOwnerOnly/);
  assert.match(block,/const whole=String\(ch\.name\|\|""\)/);
  assert.match(block,/discordCommunityStatus\.dropControls=\{\s*ready:false/);
});

test("Bot retries owner drop-controls after permissions are granted, without creating duplicates",()=>{
  assert.match(src,/dropProvisionRetryRunning=false/);
  assert.match(src,/discordCommunityStatus\.dropControls\?\.ready\)return/);
  assert.match(src,/void provision\(\)/);
  assert.match(src,/\},3\*60000\)\.unref/);
});
