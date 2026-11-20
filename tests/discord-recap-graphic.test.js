import test from "node:test";
import assert from "node:assert/strict";
import {
  APPROVED_NAME,APPROVED_SHA256,approvedTemplate,renderRecapGraphic
} from "../discord-recap-graphic.js";

test("graphic always requires exact locked approved source",async()=>{
  assert.equal(APPROVED_NAME,"SLABSNGRABSACO_Target_Drop_Recap_Final.png");
  assert.match(APPROVED_SHA256,/^[a-f0-9]{64}$/);
  await assert.rejects(approvedTemplate({}),/approved recap|Exact owner-approved/i);
  await assert.rejects(renderRecapGraphic({
    template:Buffer.alloc(12000),retailer:"target",
    report:{readyToPublish:true,totalSpentCents:1234,totalUnits:1,periodStart:"2026-11-19T08:00:00Z"}
  }),/did not match locked image hash/);
});
test("the original graphic's filename alone cannot bypass SHA-256",async()=>{
  const api=async()=>[{id:"111111111111111111",attachments:[{
    filename:APPROVED_NAME,size:20000,url:"https://cdn.discordapp.com/attachments/one/two.png"
  }]}];
  const request=async()=>({ok:true,arrayBuffer:async()=>Buffer.alloc(20000)});
  await assert.rejects(approvedTemplate({
    api,channelIds:["111111111111111111"],request
  }),/Exact owner-approved/);
});
test("untrusted template hosts are never downloaded",async()=>{
  let fetched=false;
  const api=async()=>[{attachments:[{
    filename:APPROVED_NAME,size:20000,url:"https://example.net/file.png"
  }]}];
  await assert.rejects(approvedTemplate({
    api,channelIds:["111111111111111111"],
    request:async()=>{fetched=true;throw Error("not allowed");}
  }),/Exact owner-approved/);
  assert.equal(fetched,false);
});
test("renamed Discord PNG gets checksum checked, never trusted by its filename",async()=>{
  let downloads=0;
  const api=async()=>[{attachments:[{
    filename:"image.png",size:2352049,
    url:"https://cdn.discordapp.com/attachments/1234/5678/image.png"
  }]}];
  await assert.rejects(approvedTemplate({
    api,channelIds:["111111111111111111"],
    request:async()=>{downloads++;return {ok:true,arrayBuffer:async()=>Buffer.alloc(2352049)};}
  }),/Exact owner-approved/);
  assert.equal(downloads,1);
});

test("recap graphic replaces dynamic surfaces without blur or empty hidden-stat tiles",async()=>{
  const {readFileSync}=await import("node:fs");
  const code=readFileSync(new URL("../discord-recap-graphic.js",import.meta.url),"utf8");
  assert.doesNotMatch(code,/\.blur\(/);
  assert.doesNotMatch(code,/Array\.from\(\{length:4\}.*extract/);
  assert.match(code,/if\(metrics\.length\)/);
  assert.doesNotMatch(code,/LEGACY_SHA256|graphic-only cyan\/navy/);
  assert.match(code,/existing top-products panel/);
  assert.match(code,/layers=\[\{input:overlay\(report,retailer,visibility\),left:0,top:0\}\]/);
});
