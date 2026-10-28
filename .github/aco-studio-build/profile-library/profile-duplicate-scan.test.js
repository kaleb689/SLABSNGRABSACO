'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {makeProfileVault}=require('../profile-vault');
async function harness(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aco-review-test-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const safeStorage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
 const vault=makeProfileVault({baseDir:dir,safeStorage});
 const add=(customerId,retailer,email,scope='aco')=>vault.importRows({scope,customerId,retailer,rows:[{email}],status:'active'});
 const website=(customerId,retailer,email,id)=>({customerId,retailer,email,id});
 return {vault,add,website};
}
test('Different retailer pools may reuse one email without a startup alert',async t=>{
 const h=await harness(t);await h.add('david','target','same@example.test');await h.add('david','pokemoncenter','same@example.test');
 assert.equal((await h.vault.scanRows()).duplicates.length,0);
});
test('An explicitly linked local account and its website mirror count once',async t=>{
 const h=await harness(t);await h.add('david','pokemoncenter','linked@example.test');
 await h.vault.libraryTransaction('aco','david',ctx=>{ctx.rows[0].source='website-linked-profile';ctx.rows[0].remoteKey='pokemoncenter|assignment-1';},()=>{});
 const records=[h.website('david','pokemoncenter','linked@example.test','assignment-1'),h.website('david','pokemoncenter','linked@example.test','assignment-1')];
 const r=await h.vault.scanRows([],records);
 assert.equal(r.scanned,1);assert.equal(r.duplicates.length,0);
});
test('Legacy same-retailer ownership collisions remain flagged without admitting new foreign imports',async t=>{
 const h=await harness(t);await h.add('david','walmart','used@example.test');
 const skipped=await h.add('annette','walmart','used@example.test');
 assert.equal(skipped.skippedForeign,1);
 const prior=(await h.vault.fieldSnapshot('aco','david'))[0];
 await h.vault.libraryTransaction('aco','annette',ctx=>{
  // Simulate an OLD encrypted duplicate from before the import restriction.
  ctx.rows.push({...structuredClone(prior),id:'historical-duplicate-annette'});
 },()=>{});
 const r=await h.vault.scanRows();
 assert.equal(r.duplicates.length,1);assert.equal(r.duplicates[0].retailer,'walmart');assert.equal(r.duplicates[0].count,2);
});
test('Distinct linked assignments remain flagged while duplicate pages are ignored',async t=>{
 const h=await harness(t);await h.add('david','target','used@example.test');
 await h.vault.libraryTransaction('aco','david',ctx=>{ctx.rows[0].source='website-linked-profile';ctx.rows[0].remoteKey='target|a';},()=>{});
 const one=h.website('david','target','used@example.test','a'),two=h.website('david','target','used@example.test','b');
 const r=await h.vault.scanRows([],[one,two,two]);
 assert.equal(r.duplicates.length,1);assert.equal(r.duplicates[0].count,2);
});
test('Same retailer import is blocked, different retailer import is allowed',async t=>{
 const h=await harness(t);await h.add('david','pokemoncenter','import@example.test');
 let result=await h.vault.scanRows([{scope:'aco',customerId:'david',retailer:'target',email:'import@example.test'}]);
 assert.equal(result.duplicates.length,0);
 result=await h.vault.scanRows([{scope:'aco',customerId:'david',retailer:'pokemoncenter',email:'import@example.test'}]);
 assert.equal(result.duplicates.length,1);
});
test('Personal legacy duplicate data stays hidden while the vault is locked',async t=>{
 const h=await harness(t);await h.add(null,'target','secret@example.test','personal');
 const skipped=await h.add('david','target','secret@example.test');
 assert.equal(skipped.skippedForeign,1);
 const prior=(await h.vault.fieldSnapshot('personal',null))[0];
 await h.vault.libraryTransaction('aco','david',ctx=>{
  ctx.rows.push({...structuredClone(prior),id:'historical-personal-customer-collision'});
 },()=>{});
 const r=await h.vault.scanRows([],[],false);
 assert.equal(r.duplicates.length,1);assert.notEqual(r.duplicates[0].email,'secret@example.test');
 assert.equal(r.duplicates[0].items.find(i=>i.scope==='personal').id,null);
});
test('email alone cannot hide a distinct website assignment as a local mirror',async t=>{
 const h=await harness(t);await h.add('david','target','distinct@example.test');
 const r=await h.vault.scanRows([],[h.website('david','target','distinct@example.test','distinct-source')]);
 assert.equal(r.duplicates.length,1);assert.equal(r.duplicates[0].count,2);
 assert.match(r.duplicates[0].conflictId,/^[a-f0-9]{64}$/);
});

test('managed account identity pairs its website mirror even when assignment IDs differ',async t=>{const h=await harness(t);await h.add('david','target','identity@example.test');await h.vault.libraryTransaction('aco','david',ctx=>{Object.assign(ctx.rows[0],{source:'website-linked-profile',remoteKey:'target|assignment-123',remoteManagedId:'pool-456'});},()=>{});const result=await h.vault.scanRows([],[h.website('david','target','identity@example.test','pool-456')]);assert.equal(result.duplicates.length,0);});
