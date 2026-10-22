"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const Batch=require("../import-batches.cjs");
const source=(id,retailer="target",bank="working")=>({id,retailer,bank,file:{filename:id+".csv",rows:[{email:id+"@example.test",password:"pw!:@#"}]}});
test("separate import sessions stay distinct; deleting one cannot delete another or manual records",()=>{
 const state={sources:[source("manual")],importHistory:[],cards:[{id:"card"}],addresses:[{id:"addr"}]};
 Batch.appendImport(state,[source("one"),source("two")],{retailer:"target",bank:"working",uuid:()=>"batch-a",now:()=>"2026-10-22T10:00:00Z"});
 Batch.appendImport(state,[source("three")],{retailer:"target",bank:"working",uuid:()=>"batch-b",now:()=>"2026-10-22T11:00:00Z"});
 const list=Batch.history(state);assert.deepEqual(list.map(x=>x.id),["batch-b","batch-a"]);
 const removed=Batch.deleteImport(state,{batchId:"batch-a",confirmed:true});
 assert.equal(removed.removed,2);
 assert.deepEqual(state.sources.map(x=>x.id),["manual","three"]);
 assert.equal(state.importHistory[0].removedAt!==null,true);
 assert.equal(state.cards.length,1);assert.equal(state.addresses.length,1);
 assert.throws(()=>Batch.deleteImport(state,{batchId:"batch-a",confirmed:true}),/already removed/);
});
test("bulk move targets only currently selected retailer/bank and preserves file contents",()=>{
 const state={sources:[source("one"),source("other","pokemoncenter"),source("two")],importHistory:[]};
 const prior=structuredClone(state.sources[0].file);
 assert.equal(Batch.moveSelected(state,{retailer:"target",fromBank:"working",toBank:"live",fileIds:["one","two"],confirmed:true}).moved,2);
 assert.equal(state.sources[1].bank,"working");assert.deepEqual(state.sources[0].file,prior);
 assert.throws(()=>Batch.deleteSelected(state,{retailer:"target",fromBank:"working",fileIds:["one"],confirmed:true}),/changed banks/);
 assert.throws(()=>Batch.moveSelected(state,{retailer:"target",fromBank:"working",toBank:"live",fileIds:["other"],confirmed:true}),/another|belong|changed banks/);
});
test("bulk delete is atomic on invalid mixed selection and never touches retailer resources",()=>{
 const state={sources:[source("one"),source("two"),source("pkc","pokemoncenter")],cards:[{id:"card"}],addresses:[{id:"address"}]};
 assert.throws(()=>Batch.deleteSelected(state,{retailer:"target",fromBank:"working",fileIds:["one","pkc"],confirmed:true}),/changed banks|belong/);
 assert.equal(state.sources.length,3);
 const x=Batch.deleteSelected(state,{retailer:"target",fromBank:"working",fileIds:["one","two"],confirmed:true});
 assert.equal(x.deleted,2);assert.deepEqual(state.sources.map(x=>x.id),["pkc"]);
 assert.equal(state.cards.length,1);assert.equal(state.addresses.length,1);
});
test("private UI and IPC expose history plus bulk controls, including confirmation",()=>{
 const fs=require("node:fs"),path=require("node:path"),root=path.resolve(__dirname,"..");
 const main=fs.readFileSync(path.join(root,"main.cjs"),"utf8"),ui=fs.readFileSync(path.join(root,"renderer.js"),"utf8"),preload=fs.readFileSync(path.join(root,"preload.cjs"),"utf8");
 for(const action of ["bulkMove","bulkDelete","removeImportBatch"])assert.ok(main.includes("vault:"+action));
 for(const label of ["Move All Selected","Delete All Selected","Import History","Remove this import"])assert.ok(ui.includes(label));
 for(const action of ["vault:bulkMove","vault:bulkDelete","vault:removeImportBatch"])assert.ok(preload.includes(action));
 assert.match(main,/await Vault\.save\(v\)/);
});

test("Electron distribution explicitly packages the customer import batch module",()=>{
 const p=require("../package.json");
 assert.ok(p.build.files.includes("import-batches.cjs"),"Electron ASAR must include import-batches.cjs");
});
