"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {encryptBackup,decryptBackup}=require("../portable-backup.cjs");
const {readSource,editFields,exportSource}=require("../formats.cjs");
const root=path.resolve(__dirname,"..");
test("password-encrypted backup preserves full retailer records, passwords, address and card-bank fields",async()=>{
 const data={
  version:1,sources:[
   {id:"one",retailer:"pokemoncenter",bank:"live",
    file:readSource("pkc.json",JSON.stringify([{email:"a@example.test",password:"example-not-real",
      address:"100 Example Avenue",card_number:"4242424242424242",security_code:"noncard-reference"}]))},
   {id:"two",retailer:"target",bank:"working",file:readSource("target.json","[]")}
  ],cards:[{id:"card",number:"4242424242424242",expiry:"12/30",securityCode:"reference-only"}],
  addresses:[{id:"address",address:"100 Example Avenue"}],rules:{},activity:[],licenseKey:"ACOP-EXAMPLE"
 };
 const backup=await encryptBackup(data,"sufficiently-long-passphrase");
 for(const secret of ["a@example.test","4242424242424242","100 Example Avenue","password"])
  assert.ok(!backup.includes(secret),"Encrypted backup should not reveal "+secret);
 assert.deepEqual(await decryptBackup(backup,"sufficiently-long-passphrase"),data);
 await assert.rejects(decryptBackup(backup,"incorrect-long-passphrase"),/incorrect|damaged/i);
 const altered=JSON.parse(backup);altered.tag=Buffer.alloc(16).toString("base64");
 await assert.rejects(decryptBackup(JSON.stringify(altered),"sufficiently-long-passphrase"));
});
test("editing a retailer profile preserves all original columns and unrelated values",()=>{
 const source=readSource("target.csv",
  "email,password,card_number,security_code,address\r\nemail@example.test,pw,4242424242424242,reference,Main Street\r\n");
 assert.equal(editFields(source,0,{address:"Updated Street",password:"updated-secret"}),2);
 assert.match(exportSource(source),/email,password,card_number,security_code,address/);
 assert.match(exportSource(source),/email@example\.test,updated-secret,4242424242424242,reference,Updated Street/);
 assert.throws(()=>editFields(source,0,{made_up_field:"x"}));
 assert.throws(()=>editFields(source,0,{"__proto__":"bad"}));
});
test("customer has five distinct banks, existing data is never cleared by bank changes",()=>{
 const s=fs.readFileSync(path.join(root,"main.cjs"),"utf8");
 const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
 const vault=fs.readFileSync(path.join(root,"vault.cjs"),"utf8");
 assert.match(s,/\["target","walmart","pokemoncenter","costco","sams"\]/);
 assert.match(s,/vault:setBank/);
 assert.match(s,/vault:editRow/);
 assert.match(html,/Retailer profile banks/);
 assert.match(html,/Working Profiles/);
 assert.match(html,/Live Profiles/);
 assert.match(vault,/await preservePrevious\(\)/);
 assert.match(vault,/encrypted recovery snapshots exist/);
 assert.match(vault,/async function restoreSnapshot/);
 assert.match(vault,/async function restorePortable/);
});
