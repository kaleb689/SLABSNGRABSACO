'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../profile-library-ui.js'),'utf8');
const bankSource=fs.readFileSync(require.resolve('../profile-bank-ui.js'),'utf8');
const workshopSource=fs.readFileSync(require.resolve('../profile-workshop-ui.js'),'utf8');
const workshopService=fs.readFileSync(require.resolve('../profile-workshop-service.js'),'utf8');
// Execute the actual refresh function against a minimal DOM adapter. This
// catches epoch invalidation and replacement of active form content.
function harness(){const start=source.indexOf(' let pendingRefresh=false,refreshTicket=0;'),end=source.indexOf('\n function close()',start);let active=false,calls=0,draws=0,scrolls=0,bankDraws=0;const context={epoch:8,scope:'aco',customerId:'a',stage:'completed',unusedAccounts:[],unusedConflicts:[],main:{hidden:false},rows:[],bankAssets:{addresses:[],cards:[]},selected:new Set(),d:{querySelector:()=>active?{}:null,activeElement:null},request:()=>({scope:'aco',customerId:'a'}),api:{list:async()=>{calls++;return {profiles:[{id:'p'}]};}},loadResourceBanks:async()=>{context.bankAssets={addresses:[{id:'a1'}],cards:[{id:'c1',unused:true}]};},drawResourceBanks:()=>bankDraws++,draw:()=>draws++,note:()=>{},customerName:()=>'',visible:()=>[],q:()=>({value:'target'}),retailName:{target:'Target'},window:{scrollX:3,scrollY:222,scrollTo:()=>scrolls++},JSON,Set};vm.createContext(context);vm.runInContext(source.slice(start,end)+'\nthis.run=refresh;',context);return {context,run:()=>context.run(),busy:v=>active=v,counts:()=>({calls,draws,scrolls,bankDraws})};}
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
 assert.match(source,/Re-jig selected \('/);
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

test('Profiles export is disabled in Unused and without selected profiles, but available for selected ready or Live profiles',()=>{
 assert.match(source,/q\('export'\)\.disabled=busy\|\|stage==='unused'\|\|!selectedVisible\.length/);
 assert.doesNotMatch(source,/q\('export'\)\.disabled=busy\|\|stage!=='completed'/);
});

test('Select All on Page never includes any profile from a different pagination page',()=>{
 const helperStart=source.indexOf(' const PAGE_SIZE=200;let pageIndex=0;');
 const helperEnd=source.indexOf('\n let sortMode=',helperStart);
 assert.ok(helperStart>0&&helperEnd>helperStart,'page-scoped selection helper exists');
 const handlerStart=source.indexOf("q('all').onclick=()=>{selected.clear();");
 const handlerEnd=source.indexOf(";q('clear').onclick",handlerStart);
 assert.ok(handlerStart>0&&handlerEnd>handlerStart,'select all replaces previous selection');
 const entries=Array.from({length:451},(_,i)=>({id:'record-'+i}));
 let drawCount=0;const selectAll={onclick:null},context={visible:()=>entries,selected:new Set(['foreign-vault','record-0']),q:()=>selectAll,updateSelection:()=>{drawCount++;}};
 vm.createContext(context);
 const pageStart=source.indexOf(' const pageRows=()=>visible()',helperEnd);const pageEnd=source.indexOf('\n',pageStart);
 assert.ok(pageStart>helperEnd&&pageEnd>pageStart,'page-scoped helper is present after sort controls');
 vm.runInContext(source.slice(helperStart,helperEnd)+'\n'+source.slice(pageStart,pageEnd)+'\n'+source.slice(handlerStart,handlerEnd+1)+'\nthis.pageRows=pageRows;',context);
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
 const end=source.indexOf('\n function text(',start);
 assert.ok(start>0&&end>start);
 const items=[
  {id:'target-ready',retailer:'target',bank:'working',stage:'completed',group:'target',email:'shared@example.test'},
  {id:'target-live',retailer:'target',bank:'live',stage:'completed',group:'target',email:'shared@example.test'},
  {id:'pkc-ready',retailer:'pokemoncenter',bank:'working',stage:'completed',group:'pokemoncenter',email:'shared@example.test'},
  {id:'target-unused',retailer:'target',bank:'working',stage:'in-progress',group:'target',email:'shared@example.test'}
 ];
 const fields={search:{value:'shared'},retailer:{value:'target'}};
 const context={rows:items,unusedAccounts:[],stage:'completed',group:'all',issueView:'all',q:key=>fields[key],profileIssues:()=>[],searchable:row=>row.email,sortedProfiles:profiles=>profiles};
 vm.createContext(context);
 vm.runInContext(source.slice(start,end)+'\nthis.results=visible;',context);
 assert.deepEqual(context.results().map(x=>x.id),['target-ready']);
});

test('Bulk jig, move, delete and export never operate on selected profiles outside current page',()=>{
 assert.match(source,/const chosen=pageRows\(\)\.filter\(x=>selected\.has\(x\.id\)\)/);
 assert.match(source,/selectedRows=pageRows\(\)\.filter\(x=>selected\.has\(x\.id\)/);
 assert.match(source,/const selectedVisible=\(typeof cachedPageRows![^\n]*\)\.filter\(x=>selected\.has\(x\.id\)\)/);
 assert.equal((source.match(/profileIds:pageRows\(\)\.filter\(x=>selected\.has\(x\.id\)\)/g)||[]).length,3,'two actual exports and one read-only export diagnosis must use the current page selection');
 assert.match(source,/selected\.clear\(\);pageIndex=0;if\(q\('search'\)\.value\.trim\(\)\)/);
 assert.match(source,/nextPage\.onclick=\(\)=>\{if\(\(pageIndex\+1\)\*PAGE_SIZE<visible\(\)\.length\)\{pageIndex\+\+;selected\.clear\(\);draw\(\);\}\};/);
});

test('Retailer buttons keep staged inventories separate and Unused accounts are searched by email',()=>{
 assert.match(source,/data-retailer-tabs role="group"/);
 assert.match(source,/data-stage="unused" aria-pressed="true">Unused/);
 assert.match(source,/data-stage="completed">Ready for Export/);
 assert.match(source,/data-stage="live">Live Profiles/);
 assert.match(source,/unusedAccounts=\(accounts\.emails\|\|\[\]\)\.filter\(x=>x\.status==='available'\)/);
 assert.match(source,/q\('retailer'\)\.onchange=[^\n]*selected\.clear\(\)[^\n]*unusedAccounts=\[\]/);
 assert.match(source,/emailIds:emails\.map\(x=>x\.id\)/);
 assert.match(source,/stage==='unused'\?jigUnusedSelected\(\):bulkJigSelected\(\)/);
 const begin=source.indexOf(' function visible(){'),end=source.indexOf('\n function text(',begin);
 const context={rows:[],unusedAccounts:[
  {id:'a',retailer:'target',status:'available',email:'target@example.test'},
  {id:'b',retailer:'pokemoncenter',status:'available',email:'pkc@example.test'},
  {id:'c',retailer:'target',status:'used',email:'spent@example.test'}],
  q:key=>({value:key==='retailer'?'target':'target'}),stage:'unused',group:'all',issueView:'all',profileIssues:()=>[],searchable:r=>r.email};
 vm.createContext(context);
 vm.runInContext(source.slice(begin,end)+'\nthis.view=visible;',context);
 assert.deepEqual([...context.view()].map(x=>x.id),['a']);
});

test('Card Bank shows authorized full-number headings, linked retailer emails, and exact-page bulk Hard Card actions',()=>{
 assert.match(source,/data-card-bank-search/);
 assert.match(source,/title=text\('strong',card\.fullNumber/);
 assert.match(source,/card\.linkedAccounts\?\.length/);
 assert.match(workshopSource,/Search card number, linked email, retailer or label/);
 assert.match(workshopSource,/data-bulk-set-hard/);
 assert.match(workshopSource,/data-bulk-unset-hard/);
 assert.match(workshopSource,/api\.setHardCards\(/);
 assert.match(workshopSource,/selectedCards=new Set\(matching\.slice\(page\*10,page\*10\+10\)/);
 assert.match(workshopService,/async function setHardCards\(/);
 assert.match(workshopService,/profiles\.libraryTransaction\(scope,id,ctx=>\{/);
});

test('Saved unfinished profile drafts remain visible in Unused and never pass to the new-account generator',()=>{
 assert.match(source,/kind:'saved-draft'/);
 assert.match(source,/rows\.filter\(x=>x\.retailer===retailer&&x\.bank!=='live'&&x\.stage==='in-progress'\)/);
 assert.match(source,/if\(drafts\.length\)\{return bulkJigSelected\(\);\}/);
 assert.match(source,/drafts\.length&&emails\.length/);
 assert.match(source,/kind==='unused-account'/);
 assert.match(source,/stage==='unused'\?\(unusedAccounts\.some\(x=>x\.id===id\)\|\|rows\.some/);
});

test('Retailer stage controls sit directly under both resource banks, above the profiles',()=>{
 assert.match(source,/const stageWorkspace=main\.querySelector\('\.profileRetailerWorkspace'\)/);
 assert.match(source,/main\.querySelector\('\.profileResourceBanks'\)\.after\(stageWorkspace\)/);
 assert.match(source,/data-stage="unused" aria-pressed="true">Unused/);
 assert.match(source,/data-stage="completed">Ready for Export/);
 assert.match(source,/data-stage="live">Live Profiles/);
 // The control is moved, not recreated: current stage handlers still reference it.
 assert.match(source,/for\(const b of main\.querySelectorAll\('\[data-stage\]'\)\)b\.onclick=/);
});
test('Selected retailer stays brightly highlighted and readable after switching retailers',()=>{
 const css=fs.readFileSync(require.resolve('../profile-library.css'),'utf8');
 assert.match(source,/b\.setAttribute\('aria-pressed',String\(id===q\('retailer'\)\.value\)\)/);
 assert.match(source,/b\.classList\.toggle\('profileRetailerActive',isActive\)/);
 assert.match(css,/\.profileRetailerSidebar \.profileRetailerButtons button\[aria-pressed="true"\]/);
 assert.match(css,/background:#37e0e4!important/);
 assert.match(css,/color:#061923!important/);
 assert.match(css,/\.profileResourceBanks \+ \.profileRetailerWorkspace/);
});


test('Ready for Export sorts generated Pokémon Center profiles newest-first without reordering saved vault records',()=>{
 const start=source.indexOf(" const timeValue=value=>"),end=source.indexOf("\n const pageRows=",start);
 assert.ok(start>0&&end>start,'sort logic must exist');
 const context={stage:'completed',sortMode:'newest',Date,Number,String};
 vm.createContext(context);
 vm.runInContext(source.slice(start,end)+"\nthis.sort=sortedProfiles;",context);
 const earlier={id:'a',email:'a@example.test',createdAt:'2026-10-10T10:00:00.000Z',completedAt:'2026-10-26T23:00:00.000Z'};
 const newB={id:'b',email:'b@example.test',createdAt:'2026-10-01T10:00:00.000Z',profileGeneratedAt:'2026-10-26T15:12:30.000Z'};
 const newC={id:'c',email:'c@example.test',createdAt:'2026-10-02T10:00:00.000Z',profileGeneratedAt:'2026-10-26T15:12:31.000Z'};
 const originals=[earlier,newB,newC];
 assert.deepEqual(Array.from(context.sort(originals),x=>x.id),['c','b','a']);
 assert.deepEqual(Array.from(originals,x=>x.id),['a','b','c'],'sorting may not mutate stored row order');
 context.sortMode='oldest';assert.deepEqual(Array.from(context.sort(originals),x=>x.id),['a','b','c']);
 context.sortMode='email';assert.deepEqual(Array.from(context.sort([newC,earlier,newB]),x=>x.id),['a','b','c']);
});
test('The owner can select the newest 26 completed Pokémon Center profiles, then export via right-click',()=>{
 assert.match(source,/latestCount\.value='26'/);
 assert.match(source,/selectNewest\.onclick=\(\)=>/);
 assert.match(source,/for\(const row of visible\(\)\.slice\(0,count\)\)selected\.add\(row\.id\)/);
 assert.match(source,/sortMode='newest';sortSelect\.value='newest'/);
 assert.match(source,/const chosen=row&&selected\.has\(row\.id\)\?page\.filter\(x=>selected\.has\(x\.id\)\):row\?\[row\]:page\.filter\(x=>selected\.has\(x\.id\)\)/);
 assert.match(source,/Export '\+\(selected\.has\(row\.id\)\?'Selected \('/);
 assert.match(source,/exportFormat:exportType\.value/);
 assert.match(source,/profileIds:chosen\.map\(x=>x\.id\)/);
 assert.match(source,/if\(stage==='unused'\).*return;/);
});
test('Generated batch metadata is durable and older generation events are read-only inferred',()=>{
 const vault=fs.readFileSync(require.resolve('../profile-vault.js'),'utf8');
 const service=fs.readFileSync(require.resolve('../profile-library-service.js'),'utf8');
 assert.match(vault,/const creationBatchId=uuid\(\),profileGeneratedAt=now\(\)/);
 assert.match(vault,/profileGeneratedAt,creationBatchId,needsFirstExport:true,revision:/);
 assert.match(service,/row\.profileGeneratedAt\|\|null/);
 assert.match(service,/event\.action!=='create-from-pools'/);
 assert.match(service,/profileGeneratedAt:(?:row|r)\.profileGeneratedAt\|\|creationEvents\.get/);
 assert.match(service,/const \[settings,audit(?:,unusedConflicts)?\]=await Promise\.all/);
});


test('Duplicate badge and review are scoped to chosen retailer and include unused-pool conflicts',()=>{
 const start=source.indexOf(' function duplicateReviewEntries(retailer){'),end=source.indexOf('\n function profileIssues(row)',start);
 assert.ok(start>0&&end>start);
 const context={
  rows:[
   {id:'t1',retailer:'target',email:'same@example.test',duplicates:['card'],duplicateDetails:[{kind:'card',value:'5555555555554444',peers:[{id:'t2'}]}]},
   {id:'t2',retailer:'target',email:'other@example.test',duplicates:['card'],duplicateDetails:[{kind:'card',value:'5555555555554444',peers:[{id:'t1'}]}]},
   {id:'p1',retailer:'pokemoncenter',email:'same@example.test',duplicates:['card'],duplicateDetails:[{kind:'card',value:'4242424242424242',peers:[{id:'p2'}]}]},
   {id:'p2',retailer:'pokemoncenter',email:'different@example.test',duplicates:['card'],duplicateDetails:[{kind:'card',value:'4242424242424242',peers:[{id:'p1'}]}]}
  ],
  unusedConflicts:[
   {id:'u-target',retailer:'target',email:'same@example.test',reason:'matches-profile'},
   {id:'u-pkc',retailer:'pokemoncenter',email:'other@example.test',reason:'duplicate-unused-email'}
  ]
 };
 vm.createContext(context);
 vm.runInContext(source.slice(start,end)+'\nthis.duplicatesFor=duplicateReviewEntries;',context);
 assert.deepEqual(Array.from(context.duplicatesFor('target'),x=>x.kind),['group','unused-email']);
 assert.equal(context.duplicatesFor('target')[0].profiles.length,2);
 assert.deepEqual(Array.from(context.duplicatesFor('pokemoncenter'),x=>x.kind),['group','unused-email']);
 assert.match(source,/duplicatesButton\.textContent='Duplicates \('\+duplicateReviewEntries\(q\('retailer'\)\.value\)\.length/);
 assert.match(source,/duplicatesButton\.hidden=false/);
 assert.match(source,/No data is deleted or changed by this review|no data is deleted or changed by this review/i);
});


test('Previously imported Live Target profiles have explicit preview/confirm action; no re-import or silent delete',()=>{
 assert.match(source,/Review existing Live duplicates/);
 assert.match(source,/reconcileExistingLive\.onclick=async/);
 assert.match(source,/api\.reconcileLivePreview/);
 assert.match(source,/api\.reconcileLiveCommit/);
 assert.match(source,/preview\.candidates/);
 assert.match(source,/selectedIds/);
 assert.match(source,/input\.checked=true/);
 assert.match(source,/I reviewed the matching identities/);
 assert.match(source,/unique full-card matches/);
 assert.match(source,/non-Live records can be retired/);
});


test('Live import review makes newest matching retailer email authoritative without opt-out',()=>{
 assert.match(source,/newest imported row automatically REPLACES/);
 assert.match(source,/preview\.supersedeLive/);
 assert.match(source,/preview\.supersedeNonLive/);
 assert.match(source,/result\.supersededLive/);
 assert.match(source,/result\.cardsPreserved/);
 assert.doesNotMatch(source,/updateExisting:replace\.checked/);
 assert.match(source,/collapsedInImport/);
});


test('Duplicate review displays exact matching value, retailer-scoped peer email, bank and profile ID',()=>{
 assert.match(source,/row\.duplicateDetails\|\|\[\]/);
 assert.match(source,/Exact shared card number/);
 assert.match(source,/Exact shared email/);
 assert.match(source,/Unused email-bank entry overlaps/);
 assert.match(source,/entry\.value/);
 assert.match(source,/entry\.profiles/);
 assert.match(source,/row\.email/);
 assert.match(source,/groups\.get\(key\)\.profiles\.set/);
 assert.match(source,/function duplicateReviewEntries\(retailer\)/);
 assert.match(source,/x\.retailer===retailer/);
 assert.match(source,/No changes made|No changes were made|No data is deleted or changed by this review/);
});


test('Grouped retailer duplicate review keeps same-card peers adjacent and offers explicit pool-backed repair',()=>{
 assert.match(source,/const groups=new Map\(\)/);
 assert.match(source,/groups\.get\(key\)\.profiles\.set/);
 assert.match(source,/grid-template-columns:repeat\(auto-fit/);
 assert.match(source,/Fix Duplicate/);
 assert.match(source,/duplicateRepairPreview/);
 assert.match(source,/duplicateRepairCommit/);
 assert.match(source,/Confirm Fix Duplicate/);
 assert.match(source,/duplicatesButton\.click\(\)/);
 assert.match(source,/Original encrypted record archived/);
 assert.doesNotMatch(source,/api\.deleteSelected\(/);
});


const poolSource=fs.readFileSync(require.resolve('../email-vault-ui.js'),'utf8');
function poolQuantityHarness(){
 const nodes={};for(const key of ['count','capacity','selection-review','selected-count','generate'])nodes[key]={value:key==='count'?'3':'',readOnly:true};
 nodes.addresses={querySelectorAll:()=>[{value:'a'}]};nodes.cards={querySelectorAll:()=>Array.from({length:10},(_,i)=>({value:'c'+i}))};
 const context={busy:false,availableAccounts:10,selectedAccountIds:new Set(['e1','e2','e3']),availableEmailRows:[1,2,3].map(i=>({id:'e'+i,email:'email'+i+'@example.test'})),$:key=>nodes[key]};
 vm.createContext(context);const start=poolSource.indexOf(' function capacity()'),end=poolSource.indexOf(' async function unlock',start);vm.runInContext(poolSource.slice(start,end)+';this.run=capacity;',context);return {nodes,context,run:()=>context.run()};
}
test('selected pool quantity stays editable through clearing and typing a smaller batch',()=>{
 const h=poolQuantityHarness();h.run();assert.equal(h.nodes.count.readOnly,false);assert.match(h.nodes['selected-count'].textContent,/3 account.*selected/);
 h.nodes.count.value='';h.run();assert.equal(h.nodes.count.value,'');assert.equal(h.nodes.generate.disabled,true);
 h.nodes.count.value='2';h.run();assert.equal(h.nodes.count.value,'2');assert.equal(h.nodes.generate.disabled,false);
 h.nodes.count.value='4';h.run();assert.equal(h.nodes.generate.disabled,true);assert.equal(h.context.selectedAccountIds.size,3);
 h.context.selectedAccountIds.clear();h.run();assert.equal(h.nodes.generate.disabled,false);
});
test('quantity uses only requested IDs from the explicit selection in displayed order',()=>{
 const start=poolSource.indexOf('const exactIds='),end=poolSource.indexOf(';',start);
 const context={selectedAccountIds:new Set(['e3','e1','e2']),availableEmailRows:[{id:'other'},{id:'e1'},{id:'e2'},{id:'e3'}],count:2};vm.createContext(context);
 vm.runInContext(poolSource.slice(start,end)+';this.ids=exactIds;',context);assert.deepEqual(Array.from(context.ids),['e1','e2']);
});
test('selection highlights and count update without recreating any of 200 rendered cards',()=>{
 const nodes={},cards=Array.from({length:200},(_,i)=>({dataset:{profileId:'p'+i},classList:{toggle(_name,on){this.on=on;}},setAttribute(){},querySelector:()=>null}));
 for(const key of ['export','export-archive','jig-selected','bulk-move','bulk-delete','selected-count'])nodes[key]={};
 nodes.cards={querySelectorAll:()=>cards};const move={};nodes.groups={querySelector:()=>move};
 const context={q:key=>nodes[key],pageRows:()=>cards.map(x=>({id:x.dataset.profileId})),selected:new Set(),stage:'completed',busy:false};vm.createContext(context);
 const start=source.indexOf(' function updateSelection()'),end=source.indexOf("\n d.addEventListener('keydown'",start);vm.runInContext(source.slice(start,end)+';this.run=updateSelection;',context);
 for(let i=0;i<200;i++){context.selected.add('p'+i);context.run();}
 assert.equal(cards.every(x=>x.classList.on),true);assert.match(nodes['selected-count'].textContent,/200 profile/);assert.equal(move.hidden,false);
 context.selected.clear();context.run();assert.equal(cards.some(x=>x.classList.on),false);assert.equal(move.hidden,true);assert.equal(nodes['jig-selected'].disabled,true);
});
test('opening Jig from an already selected unused account preserves the batch',()=>{
 const start=source.indexOf('jig.onclick=()=>'),end=source.indexOf('};',source.indexOf('void jigUnusedSelected()',start))+2;
 const context={jig:{},row:{id:'p2'},selected:new Set(['p1','p2']),updateSelection:()=>{},jigUnusedSelected:()=>{}};vm.createContext(context);vm.runInContext(source.slice(start,end),context);context.jig.onclick();assert.deepEqual(Array.from(context.selected),['p1','p2']);
 context.row.id='p3';context.jig.onclick();assert.deepEqual(Array.from(context.selected),['p3']);
});

test('selection dock is sticky, groups related actions, and keeps existing handlers',()=>{
 assert.match(source,/profileSelectionDock/);
 assert.match(source,/floatingActions\.append\(actionDetails,actionManage\)/);
 assert.match(source,/actionManage\.append\(q\('jig-selected'\),q\('bulk-move'\),q\('bulk-delete'\),q\('export'\)/);
 assert.match(source,/main\.querySelector\('\.profileLibraryLayout'\)\.before\(floatingActions\)/);
 assert.match(source,/Delete selected profiles…/);
 assert.match(source,/Delete this saved draft…/);
 assert.match(source,/Delete this profile…/);
 assert.match(source,/q\('bulk-delete'\)\.click\(\)/);
 assert.match(source,/const hardCardNumbers=new Set\(/);
 assert.match(source,/const cardFragment=d\.createDocumentFragment\(\)/);
 assert.match(source,/cachedPageRows=pageItems/);
 assert.match(source,/matchingCards\.slice\(0,visibleCardLimit\)/);
 assert.match(source,/if\(resourceChanged\)drawResourceBanks\(\)/);
});

test('Jig UI groups related ordinal, compass, unit and Target hard variants',()=>{
 const start=source.indexOf(' function jigFamily(option){'),end=source.indexOf(' function groupedJigChoices(host,settings){',start);
 assert.ok(start>0&&end>start,'Jig grouping helper exists');
 const context={};vm.createContext(context);vm.runInContext(source.slice(start,end)+';this.group=jigFamily;',context);
 const group=context.group;
 assert.equal(group({id:'ordinal.2nd_to_second',label:'2nd → second'})[0],'ordinals');
 assert.equal(group({id:'ordinal.second_to_2nd',label:'Second → 2nd'})[0],'ordinals');
 assert.equal(group({id:'direction_nw_long',label:'NW → Northwest'})[0],'directions');
 assert.equal(group({id:'apartment_to_unit',label:'Apt → Unit'})[0],'units');
 assert.equal(group({id:'suite_to_ste',label:'Suite → Ste'})[0],'units');
 assert.equal(group({id:'target.house.fraction.half',label:'1/2'})[0],'fraction-house');
 assert.equal(group({id:'target.house.fraction.quarter',label:'1/4'})[0],'fraction-house');
 assert.equal(group({id:'target.house.hyphen.a',label:'-A'})[0],'hyphen-house');
 assert.match(source,/Allow duplicate jig addresses only for the conflicts listed below/);
 assert.match(source,/allowDuplicateAddresses:duplicateCount>0&&allowDuplicates.checked/);
});

test('Both Jig entrypoints offer explicit optional unit and do not silently auto-add units',()=>{
 assert.match(source,/Add random Apt \/ Unit \/ Ste \/ # \/ number/);
 assert.match(source,/optionalUnitToggle\.checked=false/);
 assert.match(source,/optionalUnitCount,/);
 assert.match(source,/autoUnitFromAddressBank:optionalUnitToggle\.checked/);
 assert.match(source,/postalScan:postalScanBox\.checked/);
 assert.match(workshopSource,/data-optional-unit type="checkbox"/);
 assert.match(workshopSource,/data-optional-unit-count type="number"/);
 assert.match(workshopSource,/optionalUnitCount,combine:state\.combine/);
 assert.match(workshopSource,/randomUnit:0/);
});


test('PKC Hard Card audit distinguishes saved eligible cards from profile-only cards and requires explicit bank recovery confirmation',()=>{
 assert.match(source,/Audit Hard Cards/);
 assert.match(source,/saved eligible for /);
 assert.match(source,/!card\.fromSavedBank\?'Profile-only card/);
 assert.match(source,/profileOnly=pool\.filter\(x=>!x\.fromSavedBank/);
 assert.match(source,/targetRegular=saved\.filter\(x=>!x\.hardCard/);
 assert.match(source,/Restore selected Hard Card flags/);
 assert.match(source,/Copy selected profile cards to saved bank/);
 assert.match(source,/profileWorkshop\.setHardCards/);
 assert.match(source,/if\(!confirm\('Apply '/);
 assert.match(source,/profileWorkshop\.addProfileCardToBank/);
 assert.doesNotMatch(source,/cardPool\.hard\s*=\s*\[\]/);
});
