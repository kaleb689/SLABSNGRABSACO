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
test('An imported local account and its website link count once',async t=>{
 const h=await harness(t);await h.add('david','pokemoncenter','linked@example.test');
 const records=[h.website('david','pokemoncenter','linked@example.test','assignment-1'),h.website('david','pokemoncenter','linked@example.test','assignment-1')];
 const r=await h.vault.scanRows([],records);
 assert.equal(r.scanned,1);assert.equal(r.duplicates.length,0);
});
test('Real same-retailer reuse in separate customers remains flagged',async t=>{
 const h=await harness(t);await h.add('david','walmart','used@example.test');await h.add('annette','walmart','used@example.test');
 const r=await h.vault.scanRows();
 assert.equal(r.duplicates.length,1);assert.equal(r.duplicates[0].retailer,'walmart');assert.equal(r.duplicates[0].count,2);
});
test('Distinct linked assignments remain flagged while duplicate pages are ignored',async t=>{
 const h=await harness(t);await h.add('david','target','used@example.test');
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
test('Personal profile data stays hidden while the vault is locked',async t=>{
 const h=await harness(t);await h.add(null,'target','secret@example.test','personal');await h.add('david','target','secret@example.test');
 const r=await h.vault.scanRows([],[],false);
 assert.equal(r.duplicates.length,1);assert.notEqual(r.duplicates[0].email,'secret@example.test');
 assert.equal(r.duplicates[0].items.find(i=>i.scope==='personal').id,null);
});
