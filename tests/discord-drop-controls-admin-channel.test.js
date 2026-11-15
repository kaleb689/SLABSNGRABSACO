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
  assert.match(block,/const adminCategory=sourceChannels\.find\(/);
  assert.match(block,/parent_id:adminCategory\.id/);
  assert.match(block,/mode:"admin_channel"/);
  assert.doesNotMatch(block,/\/users\/@me\/channels/);
  assert.doesNotMatch(block,/mode:"owner_dm"/);
});
test("Discord fails closed when the requested Admin category or channel permissions are unavailable",()=>{
  assert.match(block,/if\(!adminCategory\)\s*throw Error/);
  assert.match(block,/discordCommunityStatus\.dropControls=\{\s*ready:false/);
});
