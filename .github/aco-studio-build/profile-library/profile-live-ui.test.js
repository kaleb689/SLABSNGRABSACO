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

test('Profiles can jig every selected visible profile as one batch',()=>{
 assert.match(source,/data-jig-selected/);
 assert.match(source,/bulkJigSelected/);
 assert.match(source,/batchJigPreview/);
 assert.match(source,/batchJigCommit/);
 assert.match(source,/Jig selected \('/);
 assert.match(source,/selectedVisible/);
 assert.match(workshopService,/brandFromNumber/);
});

test('Jig page keeps one authoritative retailer preset and supports one, multiple or all saved profiles',()=>{
 assert.match(workshopSource,/Saved profiles/);
 assert.match(workshopSource,/Select all/);
 assert.match(workshopSource,/batchJigPreview/);
 assert.match(workshopSource,/batchJigCommit/);
 assert.match(workshopSource,/chooseRetailerPreset/);
 assert.match(workshopSource,/retailerPresetActive/);
 assert.match(workshopSource,/Fractional house numbers/);
 assert.match(workshopSource,/Alphanumeric house number/);
 assert.match(workshopSource,/setChecked\(\/Fractional house numbers\/i,true\)/);
 assert.match(workshopSource,/setChecked\(\/Alphanumeric house number\/i,true\)/);
 assert.doesNotMatch(workshopSource,/Retailer buttons load that retailer's saved jig settings automatically/);
});

test('Profiles export is not disabled just because the profile is in progress',()=>{
 assert.match(source,/q\('export'\)\.disabled=busy;/);
 assert.doesNotMatch(source,/q\('export'\)\.disabled=busy\|\|stage!=='completed'/);
});

test('Select All on Page never includes any profile from a different pagination page',()=>{
 const helperStart=source.indexOf(' const PAGE_SIZE=200;let pageIndex=0;');
 const helperEnd=source.indexOf('\n const pager=',helperStart);
 assert.ok(helperStart>0&&helperEnd>helperStart,'page-scoped selection helper exists');
 const handlerStart=source.indexOf("q('all').onclick=()=>{selected.clear();");
 const handlerEnd=source.indexOf(";q('clear').onclick",handlerStart);
 assert.ok(handlerStart>0&&handlerEnd>handlerStart,'select all replaces previous selection');
 const entries=Array.from({length:451},(_,i)=>({id:'record-'+i}));
 let drawCount=0;const selectAll={onclick:null},context={visible:()=>entries,selected:new Set(['foreign-vault','record-0']),q:()=>selectAll,draw:()=>{drawCount++;}};
 vm.createContext(context);
 vm.runInContext(source.slice(helperStart,helperEnd)+'\n'+source.slice(handlerStart,handlerEnd+1)+'\nthis.pageRows=pageRows;',context);
 vm.runInContext('pageIndex=1;',context);
 selectAll.onclick();
 assert.deepEqual([...context.selected],entries.slice(200,400).map(x=>x.id));
 assert.equal(context.selected.has('foreign-vault'),false);
 assert.equal(context.selected.has('record-0'),false);
 vm.runInContext('pageIndex=2;',context);
 selectAll.onclick();
 assert.deepEqual([...context.selected],entries.slice(400,451).map(x=>x.id));
 assert.equal(context.selected.size,51);
 assert.equal(drawCount,2);
});

test('Search and duplicates cannot select a different retailer or status tab',()=>{
 const start=source.indexOf(' function visible(){');
 const end=source.indexOf('\n',start);
 assert.ok(start>0&&end>start);
 const items=[
  {id:'target-ready',retailer:'target',bank:'working',stage:'completed',group:'target',email:'shared@example.test'},
  {id:'target-live',retailer:'target',bank:'live',stage:'completed',group:'target',email:'shared@example.test'},
  {id:'pkc-ready',retailer:'pokemoncenter',bank:'working',stage:'completed',group:'pokemoncenter',email:'shared@example.test'},
  {id:'target-unused',retailer:'target',bank:'working',stage:'in-progress',group:'target',email:'shared@example.test'}
 ];
 const fields={search:{value:'shared'},retailer:{value:'target'}};
 const context={rows:items,stage:'completed',group:'all',issueView:'all',q:key=>fields[key],profileIssues:()=>[],searchable:row=>row.email};
 vm.createContext(context);
 vm.runInContext(source.slice(start,end)+'\nthis.results=visible;',context);
 assert.deepEqual(context.results().map(x=>x.id),['target-ready']);
});

test('Bulk jig, move, delete and export never operate on selected profiles outside current page',()=>{
 assert.match(source,/const chosen=pageRows\(\)\.filter\(x=>selected\.has\(x\.id\)\)/);
 assert.match(source,/selectedRows=pageRows\(\)\.filter\(x=>selected\.has\(x\.id\)/);
 assert.match(source,/const selectedVisible=pageItems\.filter\(x=>selected\.has\(x\.id\)\)/);
 assert.equal((source.match(/profileIds:pageRows\(\)\.filter\(x=>selected\.has\(x\.id\)\)/g)||[]).length,2);
 assert.match(source,/selected\.clear\(\);pageIndex=0;if\(q\('search'\)\.value\.trim\(\)\)/);
 assert.match(source,/nextPage\.onclick=\(\)=>\{if\(\(pageIndex\+1\)\*PAGE_SIZE<visible\(\)\.length\)\{pageIndex\+\+;selected\.clear\(\);draw\(\);\}\};/);
});
