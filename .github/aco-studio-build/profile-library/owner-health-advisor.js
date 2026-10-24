'use strict';
// Owner-only, read-only service-health advisory. This module deliberately has
// no filesystem writes, code execution, GitHub mutations, or deploy functions.
// The optional model runs on 127.0.0.1; never send customer data to the model.
const https=require('node:https');
const http=require('node:http');
const crypto=require('node:crypto');
const REPO='kaleb689/SLABSNGRABSACO';
const WEBSITE='https://slabsngrabsaco.com/';
const GITHUB='https://api.github.com';
const LIMIT=196608;
const TIMEOUT=6500;
const AGENT='SLABSNGRABSACO-Owner-Health-Advisor';
function transport(url,{method='GET',body=null,timeout=TIMEOUT,maxBytes=LIMIT}={}){
 const parsed=new URL(url);
 const local=parsed.hostname==='127.0.0.1' && parsed.port==='11434' && parsed.protocol==='http:';
 const remote=parsed.protocol==='https:' && ((parsed.hostname==='api.github.com') || parsed.hostname==='slabsngrabsaco.com');
 if(!local&&!remote)throw Error('Health monitor rejected an unauthorized destination.');
 const lib=local?http:https;
 return new Promise(resolve=>{
  const headers={'User-Agent':AGENT,'Accept':'application/json'};
  if(body!=null){headers['Content-Type']='application/json';headers['Content-Length']=Buffer.byteLength(body);}
  const req=lib.request(parsed,{method,headers,timeout},res=>{
   let data='',tooLarge=false;
   res.on('data',part=>{if(tooLarge)return;data+=part.toString('utf8');if(Buffer.byteLength(data)>maxBytes){tooLarge=true;req.destroy();}});
   res.on('end',()=>resolve({status:res.statusCode||0,body:tooLarge?'':data,error:tooLarge?'Response exceeded size limit':null}));
   res.on('error',e=>resolve({status:res.statusCode||0,body:'',error:String(e.message||e)}));
  });
  req.on('timeout',()=>req.destroy(new Error('Request timed out')));
  req.on('error',e=>resolve({status:0,body:'',error:String(e.message||e)}));
  if(body!=null)req.write(body);
  req.end();
 });
}
function parseResponse(value){try{return JSON.parse(value.body||'null');}catch{return null;}}
function compactRun(run){return {name:String(run.name||'Workflow').slice(0,100),status:run.status==='completed'?'completed':'pending',result:run.conclusion||'pending',url:typeof run.html_url==='string'&&run.html_url.startsWith('https://github.com/'+REPO+'/actions/')?run.html_url:null};}
function assess({site,ci,localAI}){
 const findings=[];
 if(!site.reachable)findings.push({id:'site-unreachable',level:'urgent',title:'Website may be unavailable',evidence:'Public homepage check returned '+(site.status||site.error||'no response'),recommendation:'Verify Render service health and deploy logs before any restart; preserve data and require owner approval for changes.'});
 else if(site.status>=400)findings.push({id:'site-http-response',level:'attention',title:'Website returned HTTP '+site.status,evidence:'A public GET request did not return a normal success response.',recommendation:'Review access rules, redirects, and current deployment logs; do not automatically redeploy.'});
 if(!ci.available) findings.push({id:'ci-unavailable',level:'attention',title:'Build verification not available',evidence:ci.error||'Could not verify current GitHub Actions results.',recommendation:'Open GitHub Actions for the current commit and check the native installer workflows.'});
 else if(ci.failed.length) findings.push({id:'ci-failed',level:'urgent',title:'Current build checks failed',evidence:ci.failed.map(x=>x.name).join(' | ').slice(0,400),recommendation:'Inspect failed test logs, fix on a review branch, rerun checks and request approval before merging or publishing installers.'});
 else if(!ci.total) findings.push({id:'ci-missing',level:'attention',title:'No checks found for current revision',evidence:'No completed workflow runs were found for the current HEAD.',recommendation:'Run the required Mac, Windows, and integration tests before marking the release ready.'});
 if(!localAI.available)findings.push({id:'ai-not-installed',level:'info',title:'Optional local AI is not running',evidence:localAI.reason||'Ollama not detected.',recommendation:'Install Ollama and download a compatible local model if you want no-per-call-fee natural-language analysis. Health checks still work without it.'});
 return findings;
}
let cached=null,pending=null;
async function scan({fresh=false}={}){
 if(!fresh&&cached&&Date.now()-cached.time<10*60*1000)return cached.value;
 if(pending)return pending;
 pending=(async()=>{
  const [siteResult,headResult,aiResult]=await Promise.all([
   transport(WEBSITE,{maxBytes:2048}),
   transport(GITHUB+'/repos/'+REPO+'/commits/main',{maxBytes:16000}),
   transport('http://127.0.0.1:11434/api/tags',{maxBytes:18000,timeout:2200})
  ]);
  const site={reachable:siteResult.status>=200&&siteResult.status<500,status:siteResult.status,error:siteResult.error};
  const head=Number(headResult.status)===200?parseResponse(headResult):null;
  const sha=typeof head?.sha==='string'&&/^[a-f0-9]{40}$/.test(head.sha)?head.sha:null;
  const ciResult=sha?await transport(GITHUB+'/repos/'+REPO+'/actions/runs?branch=main&per_page=50',{maxBytes:102400}):null;
  const runs=ciResult?.status===200?parseResponse(ciResult)?.workflow_runs:null;
  const matching=Array.isArray(runs)?runs.filter(x=>x.head_sha===sha).map(compactRun):[];
  const ci={available:Boolean(sha&&Array.isArray(runs)),head:sha,total:matching.length,failed:matching.filter(x=>x.result==='failure'||x.result==='timed_out'),pending:matching.filter(x=>x.status==='pending'),successful:matching.filter(x=>x.result==='success').length,error:sha?ciResult?.error||('GitHub status '+(ciResult?.status||0)):'Cannot read the current GitHub revision'};
  const aiData=aiResult.status===200?parseResponse(aiResult):null;
  const models=Array.isArray(aiData?.models)?aiData.models.filter(x=>typeof x?.name==='string').map(x=>x.name.slice(0,100)).slice(0,12):[];
  const localAI={available:models.length>0,models,reason:models.length?'':aiResult.status===200?'Ollama is running but has no downloaded models.':'Ollama not running on this Mac.'};
  const report={checkedAt:new Date().toISOString(),site,ci,localAI};
  report.findings=assess(report);
  cached={time:Date.now(),value:report};
  return report;
 })();
 try{return await pending;}finally{pending=null;}
}
async function explain(){
 const report=await scan();
 if(!report.localAI.available)return {available:false,text:'No local model available. Findings above were generated by read-only checks; nothing was modified.'};
 const model=report.localAI.models[0];
 const payload={model,stream:false,options:{temperature:0.1,num_predict:450},
 prompt:'You are the owner-only maintenance advisor for ACO Studio. Analyze only the following sanitized website and CI status; you have no customer records or access to modify systems. Produce a concise prioritized plan with evidence, possible root causes and checks. State uncertainty. NEVER claim a fix is deployed and NEVER recommend changes without explicit owner approval. Status: '+JSON.stringify({site:report.site,ci:report.ci,findings:report.findings.map(x=>({level:x.level,title:x.title,evidence:x.evidence,recommendation:x.recommendation}))})};
 const response=await transport('http://127.0.0.1:11434/api/generate',{method:'POST',body:JSON.stringify(payload),timeout:45000,maxBytes:64000});
 const result=response.status===200?parseResponse(response):null;
 return {available:response.status===200&&typeof result?.response==='string',text:result?.response?.slice(0,5000)||'Local analysis unavailable: '+(response.error||'HTTP '+response.status),model};
}
module.exports={scan,explain,assess};
