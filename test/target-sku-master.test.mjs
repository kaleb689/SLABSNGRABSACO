import test from "node:test";
import assert from "node:assert/strict";
import {
  INITIAL_TARGET_SKUS, TARGET_MASTER_MARKER, findTargetMasterChannel, initialTargetMaster,
  targetMasterItems, targetSkuCandidates, targetMasterAdd, targetMasterRemove,
  targetMasterRestore, targetMasterDashboard, targetMasterView, targetMasterManage,
  targetMessageTime
} from "../target-sku-master.js";

const post = (content, embeds = []) => ({ content, embeds, timestamp: new Date().toISOString() });
const products = (...rows) => rows.map(([sku, name]) => ({sku, name}));

test("46 owner-confirmed named SKUs seed a master without duplicates", () => {
  const master = initialTargetMaster("2026-11-10T05:15:00.000Z");
  assert.equal(INITIAL_TARGET_SKUS.length, 46);
  assert.equal(targetMasterItems(master).length, 46);
  assert.equal(new Set(INITIAL_TARGET_SKUS.map(item => item.sku)).size, 46);
  assert.equal(Object.keys(master.removed).length, 0);
  assert.equal(master.entries["1009154741"].name.startsWith("One Piece"), true);
  for (const [sku, name] of [
    ["1012644665","Meganium ex"],
    ["1012644666","Feraligatr ex"],
    ["1012644667","Emboar ex"],
    ["1012422107","Mini Tin"]
  ]) assert.match(master.entries[sku].name, new RegExp(name));
});

test("Target channel adds; Target-only Upcoming/Tonight adds; ambiguous cross-retailer posts do not", () => {
  const rows=products(["ABC12345","Target New Box"],["ABC12345","Duplicate"]);
  assert.deepEqual(targetSkuCandidates(post("New drop"),rows,{directTarget:true}).map(x=>x.sku),["ABC12345"]);
  assert.deepEqual(targetSkuCandidates(post("Upcoming Target drops"),rows,{generalDrop:true}).map(x=>x.sku),["ABC12345"]);
  assert.equal(targetSkuCandidates(post("Target and Walmart upcoming"),rows,{generalDrop:true}).length,0);
  assert.equal(targetSkuCandidates(post("Pokemon Center upcoming"),rows,{generalDrop:true}).length,0);
  assert.equal(targetSkuCandidates(post("Nothing about retailers"),rows,{generalDrop:true}).length,0);
  assert.equal(targetSkuCandidates(post("Target"),rows,{}).length,0);
  assert.equal(targetSkuCandidates(post("",[{title:"Target Booster Drop"}]),rows,{generalDrop:true}).length,1);
});

test("Unique new SKU is added once without overwriting existing product names", () => {
  const master=initialTargetMaster();
  const result=targetMasterAdd(master,
    products(["NEWSKU01","New Target Product"],["1010892076","Changed title"],["NEWSKU01","Same again"]),
    {channelId:"111",messageId:"222"});
  assert.deepEqual(result.added,["NEWSKU01"]);
  assert.equal(targetMasterItems(result.master).length,47);
  assert.equal(result.master.entries.NEWSKU01.sourceMessageId,"222");
  assert.notEqual(master.entries.NEWSKU01,result.master.entries.NEWSKU01);
  assert.match(result.master.entries["1010892076"].name,/30th Celebration Elite Trainer Box/);
  const repeated=targetMasterAdd(result.master,products(["NEWSKU01","Repeated"]),{});
  assert.deepEqual(repeated.added,[]);
  assert.equal(targetMasterItems(repeated.master).length,47);
});

test("Owner removal is durable: repost never readds until owner intentionally restores", () => {
  const seeded=initialTargetMaster();
  const removal=targetMasterRemove(seeded,"1012644665","owner123");
  assert.equal(removal.removed,true);
  assert.equal(targetMasterItems(removal.master).length,45);
  assert.equal(removal.master.entries["1012644665"],undefined);
  assert.equal(removal.master.removed["1012644665"].removedBy,"owner123");
  const result=targetMasterAdd(removal.master,products(["1012644665","Reposted Tin"]),{});
  assert.deepEqual(result.added,[]);
  assert.equal(result.master.entries["1012644665"],undefined);
  const restored=targetMasterRestore(result.master,"1012644665","Mega Meganium ex Tin","owner123");
  assert.equal(restored.created,true);
  assert.equal(restored.master.removed["1012644665"],undefined);
  assert.equal(restored.master.entries["1012644665"].name,"Mega Meganium ex Tin");
  const encore=targetMasterAdd(restored.master,products(["1012644665","New post"]),{});
  assert.deepEqual(encore.added,[]);
  assert.equal(targetMasterItems(encore.master).length,46);
});

test("Dashboard remains a single summarized message; full list and management paginate within Discord limits", () => {
  const master=initialTargetMaster();
  const card=targetMasterDashboard(master);
  assert.equal(card.embeds[0].footer.text,TARGET_MASTER_MARKER);
  assert.ok(card.embeds[0].description.length<4096);
  assert.ok(card.components[0].components.some(x=>x.custom_id==="targetmaster:manage:0"));
  assert.ok(card.components[0].components.some(x=>x.custom_id==="targetmaster:view:0"));
  const view=targetMasterView(master,1);
  assert.equal(view.flags,64);
  assert.ok(view.embeds[0].description.length<4096);
  assert.equal((view.embeds[0].description.match(/\n/g)||[]).length,14);
  const manage=targetMasterManage(master,1);
  const selector=manage.components[0].components[0];
  assert.equal(selector.type,3);
  assert.equal(selector.options.length,21);
  assert.ok(selector.options.every(x=>x.label.length<=100 && x.value.length<=80));
  assert.ok(manage.content.includes("Removed SKUs stay excluded"));
});

test("Source timestamps are used for ingestion cutoff, including edited messages", () => {
  assert.equal(targetMessageTime({timestamp:"2026-11-10T05:00:00Z"}),Date.parse("2026-11-10T05:00:00Z"));
  assert.equal(targetMessageTime({timestamp:"2026-11-01T05:00:00Z",edited_timestamp:"2026-11-10T06:00:00Z"}),
    Date.parse("2026-11-10T06:00:00Z"));
  assert.ok(Number.isNaN(targetMessageTime({id:"not-a-snowflake"})));
});


test("reuse the existing Target SKUs channel, regardless of separators, capitalization or naming variant", () => {
  const normalizeName = name => String(name || "").split(/[|│┃┊｜]/).pop().toLowerCase().replace(/[^a-z0-9]/g, "");
  const examples=[
    "target-skus", "Target SKUs", "target_sku", "🎯│target-skus",
    "target-sku-list", "target-sku-master", "target-sku-master-list",
    "target-sku-inventory", "target-sku-catalog"
  ];
  for(const [i, name] of examples.entries()) {
    const expected={id:String(i+200),type:0,name};
    const channels=[{id:"123",type:0,name:"target-drops"},expected];
    assert.equal(findTargetMasterChannel(channels,normalizeName)?.id,expected.id,name);
  }
  assert.equal(findTargetMasterChannel([{id:"category",type:4,name:"target-skus"}],normalizeName),null);
  assert.equal(findTargetMasterChannel([{id:"drops",type:0,name:"target-drops"}],normalizeName),null);
});
