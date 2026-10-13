import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {ADDRESS_JIG_OPTIONS, eligibleJigSelections, rotatedJigSelections} from "../address-jig-choices.js";

const example={address:"123 NORTHWEST 9TH LANE",address2:"APT 2B",city:"EXAMPLE CITY",state:"FL",zip:"33101-1234",country:"US"};
const file=(path)=>fs.readFileSync(new URL(path,import.meta.url),"utf8");
const pick=(items,id)=>items.find(item=>item.id===id);

test("every address variation has its own ID and required experimental types",()=>{
 const ids=ADDRESS_JIG_OPTIONS.map(option=>option.id);
 assert.equal(new Set(ids).size,ids.length);
 for(const prefix of ["house.fraction","unit.building","street.compressed","unit.floor","grid.compressed","house.letter","house.hyphen"]){
   assert.ok(ids.some(id=>id.startsWith(prefix)),prefix);
 }
 assert.ok(ids.every(id=>!id.startsWith("direction.typo.")&&!id.startsWith("street.typo.")&&!id.startsWith("double.")),
   "previously rejected misspellings and double letters are absent");
 assert.equal(eligibleJigSelections(example,["direction.typo.northwast","double.browardd"]).length,0);
});
test("selected address changes are unique and never stacked",()=>{
 const before=JSON.stringify(example);
 const results=eligibleJigSelections(example,ADDRESS_JIG_OPTIONS.map(x=>x.id));
 assert.ok(results.length>8);
 assert.equal(JSON.stringify(example),before);
 assert.equal(new Set(results.map(x=>JSON.stringify(x.address))).size,results.length);
 for(const item of results){
   const different=Object.keys(example).filter(field=>String(example[field]).toUpperCase()!==String(item.address[field]).toUpperCase());
   assert.equal(different.length,1,item.id+" changed "+different.join(", "));
 }
});
test("standard options retain the original house number and unit ID",()=>{
 const items=eligibleJigSelections(example,["direction.short","suffix.ln","unit.unit","city.alternate","zip.five"]);
 assert.equal(pick(items,"direction.short")?.address.address,"123 NW 9TH LANE");
 assert.equal(pick(items,"suffix.ln")?.address.address,"123 NORTHWEST 9TH LN");
 assert.equal(pick(items,"unit.unit")?.address.address2,"UNIT 2B");
 assert.equal(pick(items,"city.alternate"),undefined,"City replacements require server-side postal verification");
 assert.equal(pick(items,"zip.five")?.address.zip,"33101");
});
test("inapplicable floor/grid variants are never forced",()=>{
 assert.equal(eligibleJigSelections(example,["unit.floor","grid.compressed"]).length,0);
});
test("street suffix is not applied to middle street-name tokens",()=>{
 const addr={...example,address:"10700 CITY CENTER BOULEVARD"};
 assert.equal(eligibleJigSelections(addr,["suffix.ctr"]).length,0);
 assert.equal(pick(eligibleJigSelections(addr,["suffix.blvd"]),"suffix.blvd")?.address.address,"10700 CITY CENTER BLVD");
});
test("Admin tabs, modal, and bell are wired to original admin page",()=>{
 const html=file("../public/admin.html");
 assert.match(html,/admin-workspace-tabs\.js/);
 assert.match(html,/admin-jig-picker\.js/);
 assert.match(html,/data-notification-profile-type/);
 const tabs=file("../public/admin-workspace-tabs.js");
 for(const name of ["Home","Customers","Gifted","Rented","Available Memberships"])assert.ok(tabs.includes(name));
 assert.match(tabs,/adminNotifications/);
 const picker=file("../public/admin-jig-picker.js");
 assert.match(picker,/input\.type="checkbox"/);
 assert.match(picker,/jigOptions/);
});
test("server contains jig API, unchanged anchor, pool limit, and metadata",()=>{
 const server=file("../server.js");
 for(const snippet of ['app.get("/api/admin/jig-options"',"originalAnchorIndexes","originalIsPreserved","eligibleJigSelections(sourceAddress","rotatedJigSelections(source, customJigOptions,","Four jigs for this main address are already assigned."])assert.ok(server.includes(snippet),snippet);
 const search=file("../public/admin-pool-search.js");
 assert.match(search,/pool-profile-action-edit/);
 assert.match(search,/pool-profile-action-delete/);
});
test("inline Admin JS remains parseable",()=>{
 for(const match of file("../public/admin.html").matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)){
   if(match[1].trim())assert.doesNotThrow(()=>new vm.Script(match[1]));
 }
});


test("bulk address jig rotation covers more selected categories across separate main addresses",()=>{
 const ids=ADDRESS_JIG_OPTIONS.filter(item=>item.risk==="standard").map(item=>item.id);
 const first=rotatedJigSelections(example,ids,0);
 const second=rotatedJigSelections(example,ids,1);
 const third=rotatedJigSelections(example,ids,2);
 assert.ok(first.length>0&&first.length<=4);
 assert.ok(second.length>0&&second.length<=4);
 assert.ok(third.length>0&&third.length<=4);
 const selected=new Set([...first,...second,...third].map(x=>x.id));
 assert.ok(selected.size>first.length,"rotation should reach checkbox types outside the first four");
 assert.ok(first.every(x=>ids.includes(x.id)));
 assert.ok(second.every(x=>ids.includes(x.id)));
 assert.deepEqual(rotatedJigSelections(example,ids,0),first,"rotation is deterministic");
 assert.deepEqual(rotatedJigSelections(example,ids,0,0),[],"zero jig limit does not generate extra profiles");
});


test("available account search uses only three visible action buttons until assigning",()=>{
 const search=file("../public/admin-pool-search.js");
 assert.match(search,/pool-profile-action-edit/);
 assert.match(search,/pool-profile-action-delete/);
 assert.match(search,/pool-profile-assign-toggle/);
 assert.match(search,/assignmentPanel.hidden = true/);
 assert.match(search,/assignmentPanel.append\(customerLabel, typeLabel, durationLabel, button\)/);
});
