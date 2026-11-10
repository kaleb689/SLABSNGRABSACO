import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initialTargetMaster, targetMasterRemove } from "../target-sku-master.js";
import {
  newTargetPickDraft, toggleTargetPick, setTargetPickQuantity,
  searchTargetPicks, pasteTargetPicks, targetPickDiff,
  targetMasterPicker, targetMasterPickReview
} from "../target-master-picker.js";

const master = initialTargetMaster("2026-11-10T05:15:00.000Z");
const sample = ["1010892076","1012422107","1012644665"];

test("Target picker opens with all 46 items and 5 tap-to-select buttons, not an unwieldy dropdown", () => {
  const draft = newTargetPickDraft(master,[],1);
  const view=targetMasterPicker(master,draft,0);
  assert.equal(view.flags,64);
  assert.equal(view.embeds[0].title,"Choose Target SKUs");
  assert.match(view.embeds[0].description,/46 catalog products/);
  assert.equal(view.components.length,3);
  assert.equal(view.components[0].components.length,5);
  assert.ok(view.components[0].components.every(x=>x.type===2));
  assert.equal(view.components.flatMap(row=>row.components).filter(x=>x.type===3).length,0);
  assert.ok(view.components[1].components.some(x=>x.label==="Search"));
  assert.ok(view.components[1].components.some(x=>x.label==="Paste SKUs"));
  assert.ok(view.components[2].components.some(x=>x.label==="Confirm Selections"));
  assert.ok(view.embeds[0].description.length<4096);
});

test("search filters by case-insensitive product names or SKU and resets pagination", () => {
  const original={...newTargetPickDraft(master,[],1),page:8};
  const searched=searchTargetPicks(original,"MEGANIUM");
  assert.equal(searched.page,0);
  const view=targetMasterPicker(master,searched,0);
  assert.match(view.embeds[0].description,/Mega Meganium ex/i);
  assert.doesNotMatch(view.embeds[0].description,/Mega Feraligatr ex/i);
  const bySku=targetMasterPicker(master,searchTargetPicks(original,"1012422107"),0);
  assert.match(bySku.embeds[0].description,/Mini Tin/);
  const noMatch=targetMasterPicker(master,searchTargetPicks(original,"unmatched wibbly"),0);
  assert.match(noMatch.embeds[0].description,/No matching products/);
  assert.equal(noMatch.components[0].components.every(x=>x.type===2),true);
});

test("tap-to-select is reversible and repeat picks cannot create duplicate SKU numbers", () => {
  const initial=newTargetPickDraft(master,[],2);
  const next=toggleTargetPick(master,initial,sample[0]);
  assert.deepEqual(next.selected,[sample[0]]);
  assert.deepEqual(toggleTargetPick(master,next,sample[0]).selected,[]);
  assert.deepEqual(targetPickDiff(next),{added:[sample[0]],removed:[]});
  const view=targetMasterPicker(master,next,1);
  assert.match(view.embeds[0].description,/Selected in this draft/);
  assert.deepEqual(new Set(next.selected).size,next.selected.length);
});

test("already-saved Target SKUs appear selected and can be explicitly removed", () => {
  const original=newTargetPickDraft(master,[sample[0],sample[0],sample[1],"NOT-IN-MASTER"],1);
  assert.deepEqual(original.selected,sample.slice(0,2));
  const after=toggleTargetPick(master,original,sample[1]);
  assert.deepEqual(targetPickDiff(after),{added:[],removed:[sample[1]]});
  assert.deepEqual(original.selected,sample.slice(0,2),"draft transformation must not alter original");
});

test("pasting comma-separated SKUs adds only valid unique products and is atomic on bad entries", () => {
  let draft=newTargetPickDraft(master,[sample[0]],1);
  let pasted=pasteTargetPicks(master,draft,sample.join(","));
  assert.equal(pasted.added,2);
  assert.deepEqual(pasted.draft.selected,sample);
  pasted=pasteTargetPicks(master,pasted.draft,sample[0]+","+sample[1]+","+sample[1]);
  assert.equal(pasted.added,0);
  assert.deepEqual(pasted.draft.selected,sample);
  assert.deepEqual(targetPickDiff(pasted.draft),{added:sample.slice(1),removed:[]});
  assert.throws(()=>pasteTargetPicks(master,draft,sample[2]+",NOTREAL123"),/Not in the Target master/);
  assert.deepEqual(draft.selected,[sample[0]],"invalid paste cannot partially mutate a draft");
});

test("removed master items cannot be selected, searched or pasted again", () => {
  const reduced=targetMasterRemove(master,sample[2],"owner").master;
  const original=newTargetPickDraft(reduced,[],1);
  assert.throws(()=>toggleTargetPick(reduced,original,sample[2]),/no longer in the master/);
  assert.throws(()=>pasteTargetPicks(reduced,original,sample[2]),/Not in the Target master/);
  assert.doesNotMatch(targetMasterPicker(reduced,searchTargetPicks(original,sample[2]),0).embeds[0].description,/Mega Meganium ex/);
});

test("review makes all selections readable without scrolling through large dropdowns", () => {
  const initial=newTargetPickDraft(master,[],1);
  const selected={...initial,selected:Object.keys(master.entries).slice(0,35),quantity:2};
  for(let page=0;page<3;page++){
    const review=targetMasterPickReview(master,selected,page);
    assert.equal(review.flags,64);
    assert.match(review.embeds[0].description,/Qty 2 for ALL SKUs/);
    assert.ok(review.embeds[0].description.length<4096);
    assert.ok(review.components[0].components.some(x=>x.label==="Back to Picker"));
    assert.ok(review.components[0].components.some(x=>x.label==="Confirm Selections"));
  }
  const last=targetMasterPickReview(master,selected,2);
  assert.match(last.embeds[0].footer.text,/Page 3\/3/);
});

test("existing selections keep quantities until an explicit global quantity change", () => {
  const original=newTargetPickDraft(master,sample,2);
  assert.equal(original.quantity,2);
  assert.equal(setTargetPickQuantity(original,1).quantity,1);
  assert.throws(()=>setTargetPickQuantity(original,3),/Qty 1 or Qty 2/);
});

test("picker controls require paid access, preserve private draft, and confirm through existing owner SKU pipeline", () => {
  const source=readFileSync(new URL("../discord-community.js",import.meta.url),"utf8");
  const start=source.indexOf('if (d.type === 3 && d.data?.custom_id === "targetpick:open")');
  const end=source.indexOf('// Comma-separated owner-only SKU exports',start);
  assert.ok(start>0 && end>start);
  const handlers=source.slice(start,end);
  assert.match(handlers,/await hasPaidSkuAccess\(userId\)/);
  assert.match(handlers,/flags: 64/);
  assert.match(handlers,/targetpick:toggle:/);
  assert.match(handlers,/targetpick:search:submit/);
  assert.match(handlers,/targetPickerDraft\(userId, master/);
  assert.match(handlers,/confirmTargetPicker\(userId/);
  assert.match(source,/const targetPickerDraftsFile = path\.join\(dataDir, "discord-target-picker-drafts\.json"\)/);
  assert.match(source,/const \{ added, removed \} = targetPickDiff\(draft\)/);
  assert.match(source,/const posted = await publishOwnerSkuRecord\(record, payload\)/);
  const masterSrc=readFileSync(new URL("../target-sku-master.js",import.meta.url),"utf8");
  assert.match(masterSrc,/button\("Select Target SKUs","targetpick:open"/);
});
