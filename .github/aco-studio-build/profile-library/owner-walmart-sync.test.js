'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const service=fs.readFileSync(path.join(__dirname,'../profile-library-service.js'),'utf8');
const ui=fs.readFileSync(path.join(__dirname,'../profile-library-ui.js'),'utf8');
const apply=fs.readFileSync(path.join(__dirname,'../apply.cjs'),'utf8');
test('Walmart transfer is available only to an unlocked Personal vault and requires confirmation',()=>{
 assert.match(service,/p\?\.scope!=='personal'\|\|p\?\.customerId/);
 assert.match(service,/p\.confirmed!==true/);
 assert.match(service,/await access\(e,p\)/);
 assert.match(service,/snapshot\?\.ownerOnly!==true/);
 assert.match(service,/getOwnerWalmartUnused\(\)/);
 assert.match(service,/libraryTransaction\('personal',null/);
});
test('Owner-only Walmart sync is idempotent and preserves existing records',()=>{
 assert.match(service,/ctx\.rows\.filter\(x=>x\.retailer==='walmart'\)/);
 assert.match(service,/ctx\.emails\.filter\(x=>x\.retailer==='walmart'\)/);
 assert.match(service,/if\(existing\.has\(item\.email\)\)\{skipped\+\+;continue;\}/);
 assert.match(service,/profileId:null,source:'owner-managed-walmart-pool'/);
 assert.match(service,/ctx\.audit\('owner-walmart-unused-import'/);
 assert.doesNotMatch(service,/ctx\.rows\.splice\(/);
});
test('Owner UI has an explicit Personal Walmart sync control with source counts',()=>{
 assert.match(ui,/Sync Walmart emails into Personal Unused/);
 assert.match(ui,/scope==='personal'&&q\('retailer'\)\.value==='walmart'/);
 assert.match(ui,/api\.syncOwnerWalmartUnused/);
 assert.match(ui,/result\.counts\?\.assigned/);
});
test('Main IPC and secure Admin site bridge are wired to the local owner-only transfer',()=>{
 assert.match(apply,/getOwnerWalmartUnused:\(\)=>siteBridge\.ownerWalmartUnused\(\)/);
 assert.match(apply,/syncOwnerWalmartUnused/);
 assert.match(apply,/\/api\/admin\/owner-walmart-unused\/export/);
 assert.match(apply,/ipcRenderer\.invoke\('profile:library:'/);
});
