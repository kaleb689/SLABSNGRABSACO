'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {makeProfileVault}=require('../profile-vault');
const {createPersonalImporter,parseFiles,selectedFile}=require('../personal-profile-import');
const Core=require('../app');
const event={sender:{id:7}},other={sender:{id:8}};
const storage={isEncryptionAvailable:()=>true,encryptString:text=>Buffer.from('TEST-ENCRYPTED:'+text),decryptString:buf=>{
 assert.ok(buf.toString().startsWith('TEST-ENCRYPTED:'));return buf.toString().slice(15);
}};
const row=email=>({email,name:'Personal '+email,shipping:{address:'100 Example St',city:'Sample',state:'FL',zip:'00001'},password:'EXAMPLE_ONLY',card:{number:'TEST-CARD',cvv:'DO-NOT-KEEP'}});
async function harness(t,{online=true,rows=[row('personal@example.test')],files}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aco-import-test-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const vault=makeProfileVault({baseDir:dir,safeStorage:storage});let unlocked=true,picks=0,clock=1000;
 let entries=files||[{name:'profiles.json',text:JSON.stringify(rows)}];
 let site={records:[],complete:online,reason:online?'':'Website Admin is not connected.'};
 const requireAccess=e=>{assert.equal(e.sender.id,7);if(!unlocked)throw Error('Personal vault is locked.');};
 const importer=createPersonalImporter({requireAccess,chooseFiles:async()=>{picks++;return {filePaths:['/selected/profiles.json']};},
 readFiles:async()=>entries,vault,webAccounts:async()=>site,now:()=>clock});
 const confirm=preview=>importer.confirm(event,{token:preview.token,confirmPersonalOnly:true,skipDuplicates:true,acknowledgePartialScan:true});
 return {dir,vault,importer,confirm,setRows:x=>entries=[{name:'profiles.json',text:JSON.stringify(x)}],setFiles:x=>entries=x,
 setSite:x=>site=x,setTime:x=>clock=x,lock:()=>{unlocked=false;},picks:()=>picks};
}
test('Personal picker refuses locked access before opening any file',async t=>{
 const h=await harness(t);h.lock();await assert.rejects(h.importer.choose(event,'target'),/locked/);assert.equal(h.picks(),0);
 assert.deepEqual(await fs.readdir(h.dir),[]);
});
test('Preview makes no writes, masks secrets, and fixes destination to Personal',async t=>{
 const h=await harness(t);const p=await h.importer.choose(event,'target');
 assert.equal(p.destination,'Personal only');assert.equal(p.total,1);assert.equal(p.ready,1);
 assert.deepEqual(await fs.readdir(h.dir),[]);const text=JSON.stringify(p);
 for(const secret of ['EXAMPLE_ONLY','TEST-CARD','DO-NOT-KEEP','100 Example St'])assert.ok(!text.includes(secret));
});
test('Confirmed personal import never touches customer, address, or card bank bytes',async t=>{
 const h=await harness(t);
 await h.vault.importRows({scope:'aco',customerId:'customer-1',retailer:'target',rows:[row('customer@example.test')]});
 const preserved=[h.vault.paths.aco,...['personal-jigs.bank.encrypted','jig-studio-personal-cards.encrypted','jig-studio-cards.encrypted'].map(x=>path.join(h.dir,x))];
 for(const file of preserved.slice(1))await fs.writeFile(file,'DO NOT CHANGE '+file);
 const before=await Promise.all(preserved.map(p=>fs.readFile(p)));
 const p=await h.importer.choose(event,'target'),r=await h.confirm(p);
 assert.equal(r.saved,true);assert.equal(r.added,1);assert.equal(r.entries.length,1);
 assert.equal((await h.vault.list('personal',null)).profiles.length,1);
 for(let i=0;i<preserved.length;i++)assert.deepEqual(await fs.readFile(preserved[i]),before[i]);
 const saved=await h.vault.preview('personal',null,(await h.vault.list('personal',null)).profiles[0].id);
 assert.equal(saved.profile.data.card.cvv,'');assert.equal(saved.profile.data.password,'EXAMPLE_ONLY');
 assert.ok((await h.vault.audit('personal',null)).entries.some(x=>x.action==='import'));
});
test('Confirmation cannot supply ACO/customer scope, foreign rows, or file paths',async t=>{
 const h=await harness(t);const p=await h.importer.choose(event,'target');
 for(const forged of [{scope:'aco'},{customerId:'customer-1'},{rows:[row('other@example.test')]},{filePaths:['/etc/passwd']}]){
  await assert.rejects(h.importer.confirm(event,{token:p.token,confirmPersonalOnly:true,...forged}),/destination|replacement rows/);
 }
 assert.equal((await h.vault.list('personal',null)).profiles.length,0);
 assert.equal((await h.confirm(p)).added,1);
});
test('Explicit Personal confirmation is required',async t=>{
 const h=await harness(t);const p=await h.importer.choose(event,'target');
 await assert.rejects(h.importer.confirm(event,{token:p.token}),/Confirm Personal only/);
});
test('Cancel and expiry invalidate preview; repeated confirm is one-use',async t=>{
 const h=await harness(t);let p=await h.importer.choose(event,'target');h.importer.cancel(event);
 await assert.rejects(h.confirm(p),/expired|already used/);
 p=await h.importer.choose(event,'target');h.setTime(700000);await assert.rejects(h.confirm(p),/expired/);
 p=await h.importer.choose(event,'target');await h.confirm(p);await assert.rejects(h.confirm(p),/already used/);
 assert.equal((await h.vault.list('personal',null)).profiles.length,1);
});
test('Locked while previewing prevents confirmation and leaves banks unchanged',async t=>{
 const h=await harness(t);const p=await h.importer.choose(event,'target');h.lock();await assert.rejects(h.confirm(p),/locked/);
 assert.deepEqual(await fs.readdir(h.dir),[]);
});
test('Unrelated existing duplicate groups do not block a clean personal import',async t=>{
 const h=await harness(t);
 for(const id of ['customer-1','customer-2'])await h.vault.importRows({scope:'aco',customerId:id,retailer:'target',rows:[row('unrelated@example.test')]});
 const p=await h.importer.choose(event,'target');assert.equal(p.skipped,0);assert.equal((await h.confirm(p)).added,1);
});
test('The same email may exist in Personal PKC and Personal Target as separate retailer pools',async t=>{
 const h=await harness(t,{rows:[row('same@example.test')]});
 await h.vault.importRows({scope:'personal',customerId:null,retailer:'pokemoncenter',rows:[row('same@example.test')]});
 const p=await h.importer.choose(event,'target');
 assert.equal(p.skipped,0);assert.equal(p.ready,1);
 const r=await h.confirm(p);assert.equal(r.added,1);
 const list=await h.vault.list('personal',null);
 assert.equal(list.profiles.filter(x=>x.email==='same@example.test').length,2);
});
test('Cross-retailer email reuse is allowed, while duplicates inside the selected retailer pool are flagged',async t=>{
 const h=await harness(t,{rows:[row('shared@example.test'),row('taken@example.test'),row('good@example.test'),row('GOOD@example.test')]});
 await h.vault.importRows({scope:'aco',customerId:'customer-1',retailer:'pokemoncenter',rows:[row('shared@example.test')]});
 await h.vault.importRows({scope:'aco',customerId:'customer-2',retailer:'target',rows:[row('taken@example.test')]});
 const before=await fs.readFile(h.vault.paths.aco),p=await h.importer.choose(event,'target');
 assert.equal(p.skipped,2);assert.equal(p.ready,2);
 assert.ok(!p.conflicts.some(x=>x.email==='shared@example.test'));
 assert.ok(p.conflicts.some(x=>x.email==='taken@example.test'));
 await assert.rejects(h.importer.confirm(event,{token:p.token,confirmPersonalOnly:true}),/duplicate warnings/);
 const r=await h.confirm(p);assert.equal(r.added,2);assert.equal(r.skipped,2);
 assert.deepEqual(await fs.readFile(h.vault.paths.aco),before);
 const records=Core.parseFile(r.entries[0].name,r.entries[0].text).records.map(x=>x.email.toLowerCase()).sort();
 assert.deepEqual(records,['good@example.test','shared@example.test']);
});
test('Website duplicate scan is read-only and incomplete coverage requires acknowledgement',async t=>{
 const h=await harness(t,{online:false});let p=await h.importer.choose(event,'target');assert.equal(p.websiteComplete,false);
 await assert.rejects(h.importer.confirm(event,{token:p.token,confirmPersonalOnly:true}),/incomplete/);
 assert.equal((await h.confirm(p)).added,1);
});
test('New conflicts after preview force fresh confirmation rather than writing stale rows',async t=>{
 const h=await harness(t,{rows:[row('first@example.test'),row('second@example.test')]});const p=await h.importer.choose(event,'target');
 await h.vault.importRows({scope:'aco',customerId:'customer-1',retailer:'target',rows:[row('first@example.test')]});
 const r=await h.confirm(p);assert.equal(r.reviewRequired,true);assert.equal(r.preview.ready,1);
 assert.equal((await h.vault.list('personal',null)).profiles.length,0);assert.equal((await h.confirm(r.preview)).added,1);
});
test('Serialized vault guard catches a customer write occurring after the final scan',async t=>{
 const h=await harness(t);let scanCount=0;
 const importer=createPersonalImporter({requireAccess:()=>{},chooseFiles:async()=>({filePaths:['/selected.json']}),
  readFiles:async()=>[{name:'profiles.json',text:JSON.stringify([row('race@example.test')])}],
  webAccounts:async()=>({records:[],complete:true}),vault:{...h.vault,scanRows:async(...args)=>{
   const result=await h.vault.scanRows(...args);if(++scanCount===2)await h.vault.importRows({scope:'aco',customerId:'customer-1',retailer:'target',rows:[row('race@example.test')]});return result;
  }}});
 const p=await importer.choose(event,'target');await assert.rejects(importer.confirm(event,{token:p.token,confirmPersonalOnly:true}),/Banks changed after review/);
 assert.equal((await h.vault.list('personal',null)).profiles.length,0);
});
test('Malformed file and customer-tagged metadata abort whole batch without partial imports',async t=>{
 const h=await harness(t);
 for(const bad of [{name:'bad.json',text:'{'},{name:'customer.json',text:JSON.stringify({scope:'aco',profiles:[row('personal@example.test')]})},
  {name:'rows.json',text:JSON.stringify([{...row('personal@example.test'),customerId:'customer-1'}])},
  {name:'no-email.json',text:JSON.stringify([{name:'missing'}])}]){
  h.setFiles([{name:'good.json',text:JSON.stringify([row('good@example.test')])},bad]);
  await assert.rejects(h.importer.choose(event,'target'));assert.deepEqual(await fs.readdir(h.dir),[]);
 }
});
test('CSV subset keeps column order and selected rows; keyed Valor JSON keeps stable UUIDs',()=>{
 let p=parseFiles([{name:'accounts.csv',text:'email,name,extra\r\na@example.test,A,first\r\nb@example.test,B,second\r\n'}],'target');
 const csv=selectedFile(p.files[0],p.rows,new Set([0]));assert.equal(csv.text,'email,name,extra\r\nb@example.test,B,second\r\n');
 p=parseFiles([{name:'valor.json',text:JSON.stringify({'uuid-a':row('a@example.test'),'uuid-b':row('b@example.test')})}],'walmart');
 const obj=JSON.parse(selectedFile(p.files[0],p.rows,new Set([0])).text);assert.deepEqual(Object.keys(obj),['uuid-b']);assert.equal(obj['uuid-b'].email,'b@example.test');
});
test('JSONL and key/value subsets keep only approved rows',()=>{
 const data=[row('a@example.test'),row('b@example.test')];
 for(const file of [{name:'profiles.jsonl',text:data.map(x=>JSON.stringify(x)).join('\n')},
  {name:'profiles.txt',text:'email=a@example.test\nname=A\n\nemail=b@example.test\nname=B\n'}]){
  const p=parseFiles([file],'target'),out=selectedFile(p.files[0],p.rows,new Set([0]));
  const read=Core.parseFile(out.name,out.text);assert.equal(read.records.length,1);assert.equal(read.records[0].email,'b@example.test');
 }
});
test('Importer enforces 500 profile limit and retailer whitelist',()=>{
 assert.throws(()=>parseFiles([{name:'profiles.json',text:JSON.stringify(Array.from({length:501},(_,i)=>row(i+'@example.test')))}],'target'),/500/);
 assert.throws(()=>parseFiles([{name:'profiles.json',text:'[]'}],'unknown'),/Select Target/);
});
test('UI integration locks scope before rebinding and preserves existing security gates',async()=>{
 const main=await fs.readFile(path.join(__dirname,'../main.js'),'utf8'),app=await fs.readFile(path.join(__dirname,'../app.js'),'utf8');
 assert.match(main,/requireAccess:personalGate/);assert.match(main,/personalImporter.cancel\(event\);return personalAccess.lock/);
 const start=app.indexOf('bindLocalImportToMember(customerId)');const body=app.slice(start,app.indexOf('bankTargets()',start));
 assert.ok(body.indexOf('if(f.personalOnly)throw')<body.indexOf("f.originScope=id?'aco':'personal'"));
 assert.match(app,/savedToProfileBank:personalOnly===true/);
});
