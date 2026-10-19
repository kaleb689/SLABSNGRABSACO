'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../profile-library-ui.js'),'utf8');
const bankSource=fs.readFileSync(require.resolve('../profile-bank-ui.js'),'utf8');
const workshopSource=fs.readFileSync(require.resolve('../profile-workshop-ui.js'),'utf8');
const workshopService=fs.readFileSync(require.resolve('../profile-workshop-service.js'),'utf8');
// Execute the actual refresh function against a minimal DOM adapter. This
// catches epoch invalidation and replacement of active form content.
function harness(){const start=source.indexOf(' let pendingRefresh=false,refreshTicket=0;'),end=source.indexOf('\n function close()',start);let active=false,calls=0,draws=0,scrolls=0,bankDraws=0;const context={epoch:8,scope:'aco',customerId:'a',main:{hidden:false},rows:[],bankAssets:{addresses:[],cards:[]},selected:new Set(),d:{querySelector:()=>active?{}:null,activeElement:null},request:()=>({scope:'aco',customerId:'a'}),api:{list:async()=>{calls++;return {profiles:[{id:'p'}]};}},loadResourceBanks:async()=>{context.bankAssets={addresses:[{id:'a1'}],cards:[{id:'c1',unused:true}]};},drawResourceBanks:()=>bankDraws++,draw:()=>draws++,note:()=>{},customerName:()=>'',visible:()=>[],q:()=>({value:'target'}),retailName:{target:'Target'},window:{scrollX:3,scrollY:222,scrollTo:()=>scrolls++},JSON,Set};vm.createContext(context);vm.runInContext(source.slice(start,end)+'\nthis.run=refresh;',context);return {context,run:()=>context.run(),busy:v=>active=v,counts:()=>({calls,draws,scrolls,bankDraws})};}
test('live profile refresh defers while editor is open and never changes ownership epoch',async()=>{const h=harness();h.busy(true);await h.run();assert.equal(h.counts().calls,0);assert.equal(h.context.epoch,8);h.busy(false);await h.run();assert.equal(h.context.epoch,8);assert.equal(h.counts().draws,1);assert.equal(h.counts().scrolls,1);await h.run();assert.equal(h.counts().draws,1);});

test('Profiles page includes scoped card and address banks for Personal and customer vaults',()=>{assert.match(source,/Card Bank/);assert.match(source,/Address Bank/);assert.match(source,/profileWorkshop\.assets/);assert.match(source,/cards\.filter\(x=>x\.unused===true\)/);assert.match(source,/Select a customer to view that customer’s card bank/);});

test('Issues-only view is available and includes conflicts, duplicates, missing fields and repair status',()=>{
 assert.match(source,/data-view/);
 assert.match(source,/Issues only/);
 assert.match(source,/function profileIssues/);
 assert.match(source,/Website conflict/);
 assert.match(source,/Duplicate /);
 assert.match(source,/Missing /);
 assert.match(source,/Needs repair/);
});

test('duplicate review UI never surfaces another customer while Personal or a different customer vault is open',()=>{
 assert.match(bankSource,/function conflictBelongsHere/);
 assert.match(bankSource,/item\.scope==='personal'/);
 assert.match(bankSource,/item\.owner===store\.customerId/);
 assert.match(bankSource,/aco-duplicate-notification-ledger-v2-/);
 assert.doesNotMatch(bankSource,/aco-duplicate-notification-ledger-v1/);
 assert.match(bankSource,/result\.duplicates\|\|\[\]\)\.filter\(conflictBelongsHere\)/);
});

test('Profiles manages cards and addresses in place without routing to Jig',()=>{
 assert.match(source,/ACOProfileWorkshop\?\.openVault\?\.\(request\(\),'cards'\)/);
 assert.match(source,/ACOProfileWorkshop\?\.openVault\?\.\(request\(\),'addresses'\)/);
 assert.doesNotMatch(source,/data-manage-cards[\s\S]{0,600}close\(\);\(scope===/);
});

test('card entry no longer asks for label, holder or brand and management supports edit/remove',()=>{
 assert.match(workshopSource,/function openResourceForm/);
 assert.doesNotMatch(workshopSource,/field\('label','Card label'/);
 assert.doesNotMatch(workshopSource,/field\('cardholder','Cardholder name'/);
 assert.doesNotMatch(workshopSource,/field\('brand','Brand'/);
 assert.match(workshopSource,/api\.manageResource/);
 assert.match(workshopService,/Unlinked card /);
 assert.match(workshopService,/brandFromNumber/);
 assert.match(workshopService,/updateWorkshopCard/);
 assert.match(workshopService,/removePersonal/);
 assert.match(workshopService,/removeAco/);
});

test('background duplicate scan stays quiet until the result changes',()=>{
 assert.match(bankSource,/lastQuietScan/);
 assert.match(bankSource,/scan\(normalizeImports\(\),false,true\)/);
 assert.match(bankSource,/if\(!quiet\).*Scanning accounts/);
 assert.match(bankSource,/changed\|\|!store\.scanned/);
});
