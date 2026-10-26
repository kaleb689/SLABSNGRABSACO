'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
test('Quantity-only random Email Gen offers all five Personal unused retailer pools after creation',()=>{
 for(const id of ['randomAliasCount','randomAliasCreate','randomAliasPoolChooser','randomAliasPool','randomAliasAssign','randomAliasSync','randomAliasStatus','randomAliasTestAll','randomTestStatus'])
  assert.match(html,new RegExp('id="'+id+'"'));
 for(const retailer of ['target','walmart','pokemoncenter','costco','sams'])
  assert.match(html,new RegExp('<option value="'+retailer+'">'));
 assert.ok(html.indexOf('id="randomAliasCreate"')<html.indexOf('id="randomAliasPoolChooser"'));
 assert.match(html,/verified external IMAP inbox entered above/);
});
test('Random local parts use secure randomness; duplicates are checked without requesting names',()=>{
 const start=app.indexOf(' function randomLocal(){'),end=app.indexOf(' const unassignedRandom=',start);
 assert.ok(start>=0&&end>start);
 const script=app.slice(start,end);
 const crypt={getRandomValues:array=>{for(let i=0;i<array.length;i++)array[i]=i;return array;}};
 const value=vm.runInNewContext(script+'\nrandomLocal()', {crypto:crypt,Uint8Array,Array});
 assert.equal(value,'sng000102030405060708090a0b');
 assert.match(app,/new Set\(records\.map\(r=>r\.alias\)\)/);
 assert.match(app,/if\(\+\+attempts>100\)/);
 assert.match(app,/count<1\|\|count>100/);
 assert.match(app,/makeAlias\('Random '\+local,local,target,currentDomain\(\)\)/);
});
test('Encrypted Email Bank retains pool assignment and delivery test provenance across reload',()=>{
 for(const field of ['randomGenerated:r.randomGenerated===true','poolTarget:','poolImportedAt:','forwardingTestedAt:','forwardingTestTarget:'])assert.ok(app.includes(field),field);
 assert.match(app,/if\(!await store\(\)\)/);
 assert.match(app,/for\(const row of batch\)row\.poolTarget=retailer/);
 assert.match(app,/for\(const row of batch\)row\.poolTarget=null/);
});
test('Cloudflare live AND exact mailbox receipt are mandatory before Personal unused-pool import',()=>{
 assert.match(app,/unsyncedRandom\(\)\.filter\(r=>r\.status==='live'&&r\.forwardingTestedAt&&r\.forwardingTestTarget===r\.target\)/);
 assert.match(app,/profileWorkshop\?\.importEmails/);
 assert.match(app,/scope:'personal',customerId:null,retailer,emails:batch\.map\(r=>r\.alias\)/);
 assert.match(app,/JigPersonalGuard\?\.ensureUnlocked/);
 assert.match(app,/await api\(\)\.publish\(toPublish\.map/);
 assert.match(app,/api\(\)\?\.testForwarding/);
 assert.match(app,/forwardingTestedAt=new Date\(\)\.toISOString\(\)/);
});
test('Mail test credentials are temporary and never written to the encrypted Email Bank',()=>{
 assert.match(html,/id="randomTestPassword" type="password" autocomplete="off"/);
 assert.match(app,/\$e\('randomTestPassword'\)\.value=''/);
 assert.ok(!app.includes('poolTestPassword:'));
 assert.match(app,/No failed test was marked usable/);
});