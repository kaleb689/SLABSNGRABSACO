'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','emailgen-safe-new-bank.js'),'utf8');
const KEY='sng.sarl.emailgen.bank.v3.encrypted';
const PENDING='sng.sarl.emailgen.bank.new-setup-pending.v1';
const ORIGINAL='{"format":"encrypted-v3","data":"ciphertext-not-plaintext"}';

function run({denyArchive=false,denyMarker=false,denyRemove=false,old=ORIGINAL,pending=null}={}){
 const DB=new Map([['unrelated','keep']]);
 if(old!==null)DB.set(KEY,old);
 if(pending)DB.set(PENDING,pending);
 const storage={
  getItem:k=>DB.has(k)?DB.get(k):null,
  setItem:(k,v)=>{
   if(denyArchive&&k.includes('.archive.'))throw Error('quota exceeded');
   if(denyMarker&&k===PENDING)throw Error('marker write denied');
   DB.set(k,v);
  },
  removeItem:k=>{if(denyRemove&&k===KEY)throw Error('deletion denied');DB.delete(k);}
 };
 const elements=[],createElement=tag=>{
  const node={tag,id:'',type:'',textContent:'',className:'',hidden:false,disabled:false,
   checked:false,value:'',style:{},children:[],placeholder:'',
   append(...xs){this.children.push(...xs);},setAttribute(){}};
  elements.push(node);return node;
 };
 const gate=createElement('section'),passphrase=createElement('input');
 passphrase.id='gatePassphrase';passphrase.value='old-hidden-bank-passphrase';
 const document={createElement};
 const $e=id=>id==='emailGate'?gate:elements.find(x=>x.id===id);
 // Intentionally no window.confirm or window.prompt in test environment.
 const ctx={localStorage:storage,KEY,crypto:{getRandomValues:arr=>{arr.fill(23);return arr;}},Date,document,$e,
  unlocked:false,Error,Array,Uint8Array,String};
 vm.createContext(ctx);
 vm.runInContext(source+'\nsetupNewEmailBankReset()',ctx);
 const controls=Object.fromEntries(elements.filter(x=>x.id).map(x=>[x.id,x]));
 return {DB,controls,ctx,passphrase};
}
function openAndConfirm(runState,{typed='START NEW BANK',checked=true}={}){
 const n=runState.controls;
 n.startNewEmailBank.onclick();
 n.confirmStartNewBankPhrase.value=typed;
 n.confirmStartNewBankArchive.checked=checked;
 n.confirmStartNewEmailBank.onclick();
 return runState;
}
test('Email Gen never invokes unsupported prompt or native confirmation functions',()=>{
 assert.doesNotMatch(source,/window\.(?:prompt|confirm)\s*\(/);
 const {controls}=run();
 controls.startNewEmailBank.onclick();
 assert.equal(controls.newEmailBankConfirmPanel.hidden,false);
 assert.match(controls.newEmailBankConfirmPanel.children[1].textContent,/does NOT recover/);
 assert.equal(controls.startNewEmailBank.disabled,false);
});
test('Explicit typed confirmation archives encrypted ciphertext exactly BEFORE old pointer is retired',()=>{
 const state=openAndConfirm(run());
 const {DB,controls,passphrase}=state;
 const archives=[...DB.keys()].filter(k=>k.includes('.archive.'));
 assert.equal(archives.length,1);
 assert.equal(DB.get(archives[0]),ORIGINAL);
 assert.equal(DB.get(KEY),undefined);
 assert.equal(DB.get(PENDING),archives[0]);
 assert.equal(DB.get('unrelated'),'keep');
 assert.equal(passphrase.value,'','old passphrase must not be reused for the new bank');
 assert.equal(controls.startNewEmailBank.disabled,true);
 assert.match(controls.startNewEmailBankStatus.textContent,/archived and VERIFIED/);
});
test('Wrong confirmation phrase or missing checkbox cannot change any bank data',()=>{
 for(const opts of [{typed:'NO'},{typed:''},{checked:false}]){
  const {DB,controls}=openAndConfirm(run(),opts);
  assert.equal(DB.get(KEY),ORIGINAL);
  assert.equal([...DB.keys()].filter(k=>k.includes('.archive.')).length,0);
  assert.equal(DB.has(PENDING),false);
  assert.match(controls.startNewEmailBankStatus.textContent,/No changes made/);
 }
});
test('Cancel never modifies ciphertext, and does not leave a confirmation panel visible',()=>{
 const {DB,controls}=run();
 controls.startNewEmailBank.onclick();controls.confirmStartNewBankPhrase.value='START NEW BANK';
 controls.cancelStartNewEmailBank.onclick();
 assert.equal(DB.get(KEY),ORIGINAL);
 assert.equal(DB.has(PENDING),false);
 assert.equal(controls.newEmailBankConfirmPanel.hidden,true);
});
test('Quota or local-storage archive failure keeps active encrypted bank and no setup marker',()=>{
 const {DB,controls}=openAndConfirm(run({denyArchive:true}));
 assert.equal(DB.get(KEY),ORIGINAL);
 assert.equal([...DB.keys()].filter(k=>k.includes('.archive.')).length,0);
 assert.equal(DB.has(PENDING),false);
 assert.match(controls.startNewEmailBankStatus.textContent,/NOT completed/);
});
test('Setup marker write failure keeps active encrypted bank and retains harmless archived copy',()=>{
 const {DB}=openAndConfirm(run({denyMarker:true}));
 assert.equal(DB.get(KEY),ORIGINAL);
 assert.equal(DB.has(PENDING),false);
 const archives=[...DB.keys()].filter(k=>k.includes('.archive.'));
 assert.equal(archives.length,1);assert.equal(DB.get(archives[0]),ORIGINAL);
});
test('Deactivation failure keeps active bank and rolls back a stale setup marker',()=>{
 const {DB}=openAndConfirm(run({denyRemove:true}));
 assert.equal(DB.get(KEY),ORIGINAL);
 assert.equal(DB.has(PENDING),false);
 const archives=[...DB.keys()].filter(k=>k.includes('.archive.'));
 assert.equal(archives.length,1);assert.equal(DB.get(archives[0]),ORIGINAL);
});
test('A pending bank setup cannot be started twice and never overwrites its archive',()=>{
 const archive=KEY+'.archive.existing';
 const {DB,controls}=run({old:null,pending:archive});
 DB.set(archive,ORIGINAL);
 assert.equal(controls.startNewEmailBank.disabled,true);
 controls.startNewEmailBank.onclick();
 assert.equal(controls.newEmailBankConfirmPanel.hidden,true);
 assert.equal(DB.get(archive),ORIGINAL);
 assert.equal(DB.get(PENDING),archive);
});
test('Encrypted bank still exists if owner has an incorrect passphrase; flow never decrypts it',()=>{
 const {DB,controls}=run();
 controls.startNewEmailBank.onclick();
 assert.equal(DB.get(KEY),ORIGINAL);
 assert.equal(controls.confirmStartNewBankArchive.checked,false);
 assert.equal(controls.confirmStartNewBankPhrase.value,'');
 assert.match(controls.startNewEmailBankStatus.textContent,/NOT changed/);
});
test('Successful new bank setup never touches retailer profiles, cards, domain, IMAP or Cloudflare rules',()=>{
 assert.doesNotMatch(source,/profileWorkshop|profile-vault|cloudflare\.(?:delete|update)|fetch\(|sendMail\(/);
 assert.match(source,/localStorage\.setItem\(archive,current\)/);
 assert.match(source,/localStorage\.getItem\(archive\)!==current/);
 assert.match(source,/localStorage\.removeItem\(KEY\)/);
 assert.match(source,/START NEW BANK/);
});
test('Pending setup still disables automatic old Keychain passphrase restoration',()=>{
 const s=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
 assert.match(s,/if\(localStorage\.getItem\(NEW_SETUP_PENDING\)\)\{/);
 assert.match(s,/setupNewEmailBankReset\(\);render\(\);void restoreRememberedOwner\(\)/);
 assert.match(s,/if\(localStorage\.getItem\(NEW_SETUP_PENDING\)\)localStorage\.removeItem\(NEW_SETUP_PENDING\)/);
 assert.match(s,/api\(\)\.saveRemembered\(passphrase\)/);
});
