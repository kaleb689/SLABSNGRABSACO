'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {guardOwnerInstance}=require('../mac-launch-guard');
test('second Mac launch focuses the existing window without creating another app instance',()=>{
 let listener,exitCount=0,focus=0,restore=0;
 const win={isDestroyed:()=>false,isVisible:()=>true,isMinimized:()=>true,
  restore:()=>restore++,show:()=>{},focus:()=>focus++};
 const app={requestSingleInstanceLock:()=>true,on:(event,fn)=>{if(event==='second-instance')listener=fn;},
  exit:()=>exitCount++};
 assert.equal(guardOwnerInstance({app,BrowserWindow:{getAllWindows:()=>[win]},platform:'darwin'}),true);
 listener();
 assert.equal(focus,1);assert.equal(restore,1);assert.equal(exitCount,0);
});
test('duplicate Mac process exits without showing an unauthenticated workspace',()=>{
 let exited=0;
 assert.equal(guardOwnerInstance({app:{requestSingleInstanceLock:()=>false,exit:()=>exited++},
  BrowserWindow:{getAllWindows:()=>{throw Error('Must not touch a window');}},platform:'darwin'}),false);
 assert.equal(exited,1);
});
test('no window while app authenticates cannot show hidden owner data',()=>{
 let listener,focus=0;const app={requestSingleInstanceLock:()=>true,
  on:(_,fn)=>listener=fn,focus:()=>focus++};
 const hidden={isDestroyed:()=>false,isVisible:()=>false,show:()=>{throw Error('Hidden vault leaked');}};
 assert.equal(guardOwnerInstance({app,BrowserWindow:{getAllWindows:()=>[hidden]},platform:'darwin'}),true);
 listener();assert.equal(focus,1);
});
