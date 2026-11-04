'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseText,exportAccounts,textTemplate}=require('./retailer-login-formats');
const accounts=[
 {email:'First@Example.com',password:'secret,with,comma'},
 {email:'second@example.com',password:'word:semi;colon'}
];
let seq=0;const uuid=()=>String(++seq).padStart(8,'0')+'-0000-4000-8000-000000000000';
test('Shikari account CSV uses exact username,password reference columns and correct RFC quoting',()=>{
 const out=exportAccounts(accounts,'target','shikari');
 assert.equal(out.name,'target-accounts-shikari.csv');
 assert.equal(out.body.split('\r\n')[0],'username,password');
 const round= parseText(out.body,{fileName:out.name,retailer:'target'});
 assert.equal(round.accounts.length,2);
 assert.equal(round.accounts[0].password,'secret,with,comma');
 assert.equal(round.accounts[1].password,'word:semi;colon');
});
test('Valor account JSON matches supplied version/site/accounts/sessions structure and round trips',()=>{
 const out=exportAccounts(accounts,'target','valor',null,uuid),value=JSON.parse(out.body);
 assert.deepEqual(Object.keys(value),['version','site','accounts','sessions']);
 assert.equal(value.version,1);assert.equal(value.site,'Target');assert.deepEqual(value.sessions,{});
 assert.equal(Object.keys(value.accounts).length,2);
 for(const [key,item] of Object.entries(value.accounts)){
  assert.equal(key,item.id);assert.deepEqual(Object.keys(item),['id','email','password','proxy','session','selected']);
  assert.equal(item.proxy,null);assert.equal(item.session,false);assert.equal(item.selected,false);
 }
 const round=parseText(out.body,{fileName:out.name,retailer:'target'});
 assert.equal(round.accounts[0].email,'first@example.com');assert.equal(round.accounts[0].password,'secret,with,comma');
 assert.equal(round.accounts[1].password,'word:semi;colon');
});
test('mismatched explicit retailer in Valor JSON is rejected before import',()=>{
 const src=exportAccounts(accounts,'target','valor',null,uuid);
 assert.throws(()=>parseText(src.body,{fileName:'wrong.json',retailer:'walmart'}),/belongs to Target/);
});
test('custom TXT separator patterns reproduce owner requested text layouts',()=>{
 for(const pattern of ['email:password','email:::password','email; password']){
  const output=exportAccounts([{email:'first@example.com',password:'secret'}],'target','txt',pattern);
  assert.equal(output.body,'first@example.com'+pattern.slice(5,-8)+'secret\n');
  assert.equal(parseText(output.body,{fileName:output.name,retailer:'target'}).accounts[0].password,'secret');
 }
});
test('file-supplied duplicate emails do not create a second retailer account',()=>{
 const parsed=parseText('username,password\nDUP@example.com,a\ndup@example.com,b\n',{fileName:'accounts.csv',retailer:'target'});
 assert.equal(parsed.inputCount,2);assert.equal(parsed.duplicateCount,1);
 assert.deepEqual(parsed.accounts,[{email:'dup@example.com',password:'a'}]);
});
test('invalid account rows, password control characters, malicious templates and malformed JSON reject',()=>{
 assert.throws(()=>parseText('username,password\nbad@example.com,\n',{fileName:'accounts.csv',retailer:'target'}),/Invalid/);
 assert.throws(()=>parseText('username,password\nbad@example.com,\"unterminated',{fileName:'accounts.csv',retailer:'target'}),/unfinished/);
 assert.throws(()=>parseText('{bad',{fileName:'account.json',retailer:'target'}),/Invalid accounts JSON/);
 assert.throws(()=>textTemplate('email; email'),/one email and one password/);
 assert.throws(()=>textTemplate('email\npassword'),/single-line/);
 assert.throws(()=>exportAccounts(accounts,'target','txt','email,password,password'),/one email and one password/);
});
test('each supported retailer appears in Valor site metadata',()=>{
 for(const r of ['target','walmart','pokemoncenter','costco','sams']){
  const result=exportAccounts([{email:'x@example.com',password:'p'}],r,'valor',null,uuid);
  assert.equal(parseText(result.body,{fileName:result.name,retailer:r}).accounts.length,1);
 }
});
