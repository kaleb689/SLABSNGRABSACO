import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ownerRetailerSkuGroups, ownerRetailerSkuCopyPayload,
  uniqueSkuSelections, skuSelectionChanges
} from "../discord-community.js";

const row=(channel,post,sku,name,retailer="")=>({
  key:channel+":"+post+":"+sku,sku,name,quantity:2,
  ...(retailer?{retailer}:{})
});
const group=x=>({
  target:"Target",walmart:"Walmart",pkc:"PKC"
})[x.key.split(":")[0]]||(x.retailer?x.retailer+" · Dropping Tonight":"Dropping Tonight");

test("retailer copy is exactly comma-separated SKU identifiers without spaces, names, or duplicates",()=>{
  const rows=[
    row("target","drop1","1010892076","Target ETB"),
    row("target","drop2","1010892076","Reposted Target ETB"),
    row("target","drop2","1012422107","Mini Tin"),
    row("tonight","drop3","1012422107","Mini Tin","target"),
    row("walmart","drop4","200111","Walmart Product"),
    row("pkc","drop5","PKC-222","Pokemon Center Product")
  ];
  const groups=ownerRetailerSkuGroups(rows,group);
  assert.deepEqual(groups.target,["1010892076","1012422107"]);
  assert.deepEqual(groups.walmart,["200111"]);
  assert.deepEqual(groups.pokemon,["PKC-222"]);
  const copy=ownerRetailerSkuCopyPayload(rows,group,"target","1551070928039845900");
  assert.match(copy.content,/1010892076,1012422107/);
  assert.doesNotMatch(copy.content,/200111|PKC-222|Target ETB|Mini Tin/);
  assert.doesNotMatch(copy.content,/1010892076,\s+1012422107/);
  assert.equal(copy.flags,64);
  assert.deepEqual(copy.allowed_mentions,{parse:[]});
});

test("empty retailer selection does not show another retailer's SKUs",()=>{
  const result=ownerRetailerSkuCopyPayload([
    row("walmart","post","200222","Walmart Product")
  ],group,"target","1551070928039845900");
  assert.match(result.content,/No Target SKUs/);
  assert.doesNotMatch(result.content,/200222/);
});

test("large retailer lists paginate comma-separated lines without silent truncation",()=>{
  const all=Array.from({length:200},(_,i)=>
    row("target","drop"+i,"TCIN"+String(i).padStart(10,"0"),"Product "+i));
  const parts=[];
  let page=0;
  for(;;){
    const output=ownerRetailerSkuCopyPayload(all,group,"target","1551070928039845900",page);
    const line=/\x60{3}\n([^\n]*)\n\x60{3}/.exec(output.content)?.[1];
    assert.ok(line && line.length<=1550);
    assert.ok(output.content.length<=2000);
    assert.ok(!/\s/.test(line));
    parts.push(line);
    if(!output.components)break;
    const next=output.components[0].components[1];
    if(next.disabled)break;
    assert.equal(next.custom_id,"sku:copy:1551070928039845900:target:"+(page+1));
    page++;
  }
  const allValues=parts.join(",").split(",");
  assert.equal(allValues.length,200);
  assert.equal(new Set(allValues).size,200);
});

test("owner copy controls are added without replacing the owner message or erasing Added/Removed summaries",()=>{
  const source=readFileSync(new URL("../discord-community.js",import.meta.url),"utf8");
  assert.match(source,/async function refreshExistingOwnerCopyButtons\(\)/);
  assert.match(source,/components: payload\.components, allowed_mentions: \{ parse: \[\] \}/);
  assert.match(source,/await refreshExistingOwnerCopyButtons\(\)/);
  assert.match(source,/String\(userId\) !== String\(ownerId\)/);
  assert.match(source,/ownerRetailerSkuCopyPayload\(record\.items, ownerSkuGroup, retailer, customerId, page\)/);
});
