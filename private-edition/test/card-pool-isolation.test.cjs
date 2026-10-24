"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const Formats=require("../formats.cjs"),Cards=require("../card-pool.cjs");
const NUM="4242424242424242",OTHER="5555555555554444";
const source=(id,retailer,rows)=>{
 const header="email,card_number,card_expiry,security_code";
 const content=[header,...rows.map((n,i)=>"customer-"+id+"-"+i+"@example.test,"+n+",09/31,KEEP-REFERENCE-"+id+"-"+i)].join("\r\n")+"\r\n";
 return {id,retailer,bank:"working",file:Formats.readSource(id+".csv",content)};
};
function vault(){
 return {version:1,sources:[source("target","target",[NUM])],
  cards:[{id:"saved-card",number:NUM,expiry:"09/31",label:"Saved Card",holder:"Test"}],
  addresses:[],rules:{},activity:[],licenseKey:"ACOP-TEST"};
}
test("private Hard Card reuse is one per retailer, not once per import file",()=>{
 const v=vault();
 const pkc=source("pkc","pokemoncenter",[OTHER,OTHER]);v.sources.push(pkc);
 assert.throws(()=>Cards.allocate(v,pkc,[0]),/Not enough eligible/);
 assert.equal(Cards.toggle(v,"saved:saved-card",true).hardCard,true);
 const allowed=Cards.allocate(v,pkc,[0]);
 assert.equal(allowed[0].card.number,NUM);
 assert.throws(()=>Cards.allocate(v,pkc,[0,1]),/Not enough eligible/);
 const w=source("walmart","walmart",[OTHER]);v.sources.push(w);
 assert.equal(Cards.allocate(v,w,[0])[0].card.number,NUM);
 assert.throws(()=>Cards.allocate(v,v.sources[0],[0,1]),/Selected profile/);
});
test("private imported cards appear in inventory and can be saved without copying Security Code",()=>{
 const v=vault(),imported=source("new","costco",[OTHER]);v.sources.push(imported);
 const inv=Cards.inventory(v);
 assert.equal(inv.length,2);
 const row=inv.find(x=>x.last4==="4444");
 assert.equal(row.fromSavedBank,false);
 assert.deepEqual(row.linked,["costco"]);
 const r=Cards.promote(v,row.ref);
 assert.equal(r.saved,true);
 assert.equal(v.cards.length,2);
 assert.equal(v.cards[1].securityCode,undefined);
 assert.equal(imported.file.rows[0].security_code,"KEEP-REFERENCE-new-0");
});
test("changing card details preserves unrelated profile Security Code on export",()=>{
 const v=vault(),src=v.sources[0];
 const changed=Formats.changeRow(src.file,0,{cardNumber:OTHER,cardExpiry:"10/32"});
 assert.equal(changed,2);
 assert.equal(src.file.rows[0].security_code,"KEEP-REFERENCE-target-0");
 assert.match(Formats.exportSource(src.file),/KEEP-REFERENCE-target-0/);
});
test("private card summary excludes full card number and unrelated profile codes",()=>{
 const v=vault(),inv=Cards.inventory(v);
 assert.equal(JSON.stringify(inv).includes(NUM),false);
 assert.equal(JSON.stringify(inv).includes("KEEP-REFERENCE"),false);
 assert.ok(inv[0].last4);
});
test("the separate private edition requires a fresh login and refuses a different license in the same encrypted vault",()=>{
 const sourceText=fs.readFileSync(path.join(__dirname,"..","main.cjs"),"utf8");
 assert.match(sourceText,/if\(!activeLicense\)return false/);
 assert.match(sourceText,/state\.licenseKey&&state\.licenseKey!==key/);
 assert.match(sourceText,/if\(parsed\.licenseKey&&parsed\.licenseKey!==activeLicense\)/);
 assert.match(sourceText,/await allowed\(\);return Vault\.snapshots\(\)/);
 assert.match(sourceText,/Cards\.allocate\(v,source/);
});

test("customer card inventory links exact retailer emails but default summaries never disclose full numbers",()=>{
 const v=vault();
 const ordinary=Cards.inventory(v);
 assert.equal(Object.hasOwn(ordinary[0],"fullNumber"),false);
 assert.deepEqual(ordinary[0].linkedAccounts,[{retailer:"target",email:"customer-target-0@example.test"}]);
 const authorized=Cards.inventory(v,{showFullNumbers:true});
 assert.equal(authorized[0].fullNumber,NUM);
 assert.equal(JSON.stringify(authorized).includes("KEEP-REFERENCE"),false);
});
test("customer bulk Hard Card action is all-or-nothing and refuses duplicate physical cards",()=>{
 const v=vault(),other="5555555555554444";
 v.cards.push({id:"other",number:other,expiry:"09/31",label:"Other saved"});
 const refs=["saved:saved-card","saved:other"];
 const on=Cards.toggleBulk(v,refs,true);
 assert.equal(on.updated,2);assert.equal(Cards.isHard(v,NUM),true);assert.equal(Cards.isHard(v,other),true);
 v.sources.push(source("pkc","pokemoncenter",[NUM]));
 assert.throws(()=>Cards.toggleBulk(v,refs,false),/linked more than once/);
 assert.equal(Cards.isHard(v,NUM),true);
 assert.equal(Cards.isHard(v,other),true);
 assert.throws(()=>Cards.toggleBulk(v,["saved:other","saved:other"],true),/unique/);
 assert.throws(()=>Cards.toggleBulk(v,["saved:other","saved:foreign"],true),/does not belong/);
 assert.equal(Cards.toggleBulk(v,["saved:other"],false).updated,1);
 assert.equal(Cards.isHard(v,other),false);
 assert.equal(Cards.isHard(v,NUM),true);
});
test("customer Card Bank has page-scoped selection and authenticated atomic IPC",()=>{
 const renderer=fs.readFileSync(path.join(__dirname,"..","renderer.js"),"utf8");
 const preloader=fs.readFileSync(path.join(__dirname,"..","preload.cjs"),"utf8");
 const main=fs.readFileSync(path.join(__dirname,"..","main.cjs"),"utf8");
 assert.match(renderer,/selectedCardRefs=new Set\(matches\.slice\(cardPage\*10,cardPage\*10\+10\)/);
 assert.match(renderer,/vault_setHardCards/);
 assert.match(main,/ipcMain\.handle\("vault:setHardCards",\(_e,p\)=>edit/);
 assert.match(preloader,/"vault:setHardCards"/);
});
