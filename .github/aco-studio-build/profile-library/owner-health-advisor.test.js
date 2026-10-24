'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {assess}=require('../owner-health-advisor');

test('Health advisor warns on a failed public website probe and CI failure',()=>{
 const findings=assess({
  site:{reachable:false,status:0,error:'Request timed out'},
  ci:{available:true,total:2,failed:[{name:'Native Mac installer tests'}],successful:1,pending:[]},
  localAI:{available:false,reason:'Optional local model unavailable'}
 });
 assert.ok(findings.some(x=>x.id==='site-unreachable'&&x.level==='urgent'));
 assert.ok(findings.some(x=>x.id==='ci-failed'&&x.level==='urgent'));
 assert.ok(findings.some(x=>x.id==='ai-not-installed'&&x.level==='info'));
 assert.equal(findings.some(x=>Object.prototype.hasOwnProperty.call(x,'applied')),false);
});

test('Health advisor generates no urgent warnings when public checks are healthy',()=>{
 const findings=assess({
  site:{reachable:true,status:200},
  ci:{available:true,total:4,failed:[],pending:[],successful:4},
  localAI:{available:true,models:['local-model']}
 });
 assert.deepEqual(findings,[]);
});

test('Missing CI verification is not mislabeled as a passing build',()=>{
 const findings=assess({
  site:{reachable:true,status:200},
  ci:{available:true,total:0,failed:[],pending:[],successful:0},
  localAI:{available:true,models:['local-model']}
 });
 assert.ok(findings.some(x=>x.id==='ci-missing'));
});
