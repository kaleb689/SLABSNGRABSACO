'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {makeStartupEngine,FEED}=require('../win-full-updates');
function fixture({packaged=true,action='current'}={}){
 const u=new EventEmitter();let installs=0,checks=0,feed=null;
 u.setFeedURL=value=>feed=value;
 u.quitAndInstall=()=>{installs++;};
 u.checkForUpdates=async()=>{
  checks++;
  if(action==='throw')throw Error('Feed unavailable');
  u.emit('checking-for-update');
  if(action==='current')u.emit('update-not-available');
  if(action==='updated'){u.emit('update-available',{version:'4.13.15'});u.emit('download-progress',{percent:100});u.emit('update-downloaded',{version:'4.13.15'});}
 };
 const app={isPackaged:packaged,getVersion:()=> '4.13.14'};
 const engine=makeStartupEngine({app,updater:u,timeoutMs:150});
 return {engine,updater:u,counts:()=>({installs,checks,feed})};
}
test('Startup opens current Windows build when official feed has no upgrade',async()=>{
 const f=fixture(),r=await f.engine.autoStartup();
 assert.deepEqual(r,{started:false,current:true});assert.equal(f.counts().installs,0);
 assert.equal(f.counts().feed.url,FEED);assert.equal(f.updater.autoDownload,true);
});
test('Running Windows app can check for an update without installing it',async()=>{
 const f=fixture({action:'updated'}),r=await f.engine.check();
 assert.equal(r.status,'available');assert.equal(r.latest,'4.13.15');
 assert.equal(f.counts().installs,0);assert.equal(f.counts().checks,1);
 assert.equal(f.updater.autoDownload,true);
});
test('Verified full Windows installer is automatically launched for an upgrade',async()=>{
 const f=fixture({action:'updated'}),r=await f.engine.autoStartup();
 assert.equal(r.started,true);assert.equal(r.relaunching,true);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.counts().installs,1);
 assert.equal(f.engine.progress().phase,'installing');
});
test('If update feed fails the previous desktop remains installed',async()=>{
 const f=fixture({action:'throw'}),r=await f.engine.autoStartup();
 assert.equal(r.started,false);assert.match(r.error,/Feed unavailable/);
 assert.equal(f.counts().installs,0);
});
test('Development and CI smoke runs never launch a Windows update',async()=>{
 const f=fixture({packaged:false,action:'updated'}),r=await f.engine.autoStartup();
 assert.equal(r.skipped,'development');assert.equal(f.counts().checks,0);
});
test('No response does not leave the Windows login screen permanently blocked',async()=>{
 const f=fixture({action:'silent'}),r=await f.engine.autoStartup();
 assert.equal(r.timeout,true);assert.equal(f.counts().installs,0);
});
