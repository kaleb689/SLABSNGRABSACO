'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','emailgen-safe-new-bank.js'),'utf8');
function run({denyArchive=false,confirm=true,typed='START NEW BANK',old='{"format":"encrypted-v3","data":"ciphertext-not-plaintext"}'}={}){
 const KEY='sng.sarl.emailgen.bank.v3.encrypted',DB=new Map([[KEY,old],['unrelated','keep']]);
 const storage={getItem:k=>DB.has(k)?DB.get(k):null,setItem:(k,v)=>{if(denyArchive&&k.includes('.archive.'))throw Error('quota exceeded');DB.set(k,v);},removeItem:k=>DB.delete(k)};
 const nodes={},gate={append(...xs){xs.forEach(x=>{nodes[x.id]=x;});}};
 const document={createElement:tag=>({tag,id:'',textContent:'',disabled:false,className:'',style:{},setAttribute(){}})};
 const ctx={localStorage:storage,KEY,crypto:{getRandomValues:arr=>{arr.fill(23);return arr;}},Date,
  document,$e:id=>id==='emailGate'?gate:nodes[id],unlocked:false,
  window:{confirm:()=>confirm,prompt:()=>typed},Error,Array,Uint8Array,String};
 vm.createContext(ctx);vm.runInContext(source+'\nsetupNewEmailBankReset()',ctx);
 return {DB,nodes,ctx};
}
test('Start New Bank button archives encrypted ciphertext exactly before clearing active pointer',()=>{
 const {DB,nodes}=run();
 assert.equal(nodes.startNewEmailBank.disabled,false);
 nodes.startNewEmailBank.onclick();
 const archives=[...DB.keys()].filter(k=>k.includes('.archive.'));
 assert.equal(archives.length,1);
 assert.equal(DB.get(archives[0]),'{"format":"encrypted-v3","data":"ciphertext-not-plaintext"}');
 assert.equal(DB.has('sng.sarl.emailgen.bank.v3.encrypted'),false);
 assert.equal(DB.get('sng.sarl.emailgen.bank.new-setup-pending.v1'),archives[0]);
 assert.equal(DB.get('unrelated'),'keep');
 assert.match(nodes.startNewEmailBankStatus.textContent,/safely archived/);
});
test('Canceling confirmation keeps original encrypted bank completely unchanged',()=>{
 for(const options of [{confirm:false},{typed:'NO'}]){
  const {DB,nodes}=run(options);nodes.startNewEmailBank.onclick();
  assert.equal(DB.has('sng.sarl.emailgen.bank.v3.encrypted'),true);
  assert.equal([...DB.keys()].filter(k=>k.includes('.archive.')).length,0);
  assert.equal(DB.has('sng.sarl.emailgen.bank.new-setup-pending.v1'),false);
 }
});
test('If archive creation fails, the original bank must not be removed',()=>{
 const {DB,nodes}=run({denyArchive:true});nodes.startNewEmailBank.onclick();
 assert.ok(DB.has('sng.sarl.emailgen.bank.v3.encrypted'));
 assert.ok(!DB.has('sng.sarl.emailgen.bank.new-setup-pending.v1'));
 assert.match(nodes.startNewEmailBankStatus.textContent,/was not completed/);
});
test('Pending reset stops old Keychain passphrase from auto-initializing the new bank',()=>{
 const s=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
 assert.match(s,/localStorage\.getItem\(NEW_SETUP_PENDING\)\)return/);
 assert.match(s,/setupNewEmailBankReset\(\);render\(\);void restoreRememberedOwner\(\)/);
 assert.match(s,/if\(localStorage\.getItem\(NEW_SETUP_PENDING\)\)localStorage\.removeItem\(NEW_SETUP_PENDING\)/);
 assert.match(s,/api\(\)\.saveRemembered\(passphrase\)/);
});
test('New bank setup never touches separate profiles, cards, retailer banks, IMAP, or live Cloudflare rules',()=>{
 assert.doesNotMatch(source,/profileWorkshop|profile-vault|cloudflare\.(?:delete|update)|fetch\(|sendMail\(/);
 assert.match(source,/localStorage\.setItem\(archive,current\)/);
 assert.match(source,/localStorage\.getItem\(archive\)!==current/);
 assert.match(source,/localStorage\.removeItem\(KEY\)/);
 assert.match(source,/START NEW BANK/);
});
