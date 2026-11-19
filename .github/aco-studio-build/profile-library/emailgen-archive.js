'use strict';
// Owner-only, read-only Cloudflare D1 email archive index for ACO Studio.
// No card information, email bodies, Cloudflare tokens, or mailbox passwords
// are sent to the renderer. Retailer orders must be verified elsewhere.
const {credentialsFor, database, cfRequest}=require('./emailgen-worker-verification');
const ALIAS=/^[^\s@]{1,64}@sng\.sarl$/i;
function normalizeAlias(value){
 const alias=String(value||'').trim().toLowerCase();
 if(alias&&!ALIAS.test(alias))throw Error('Enter a complete @sng.sarl email alias.');
 return alias;
}
async function listArchive(cfg,{alias='',limit=50}={},request=globalThis.fetch){
 const selected=normalizeAlias(alias);
 const max=Number.isSafeInteger(limit)?Math.min(100,Math.max(1,limit)):50;
 const db=await database(cfg,request);
 const sql='SELECT r.id,r.alias,r.received_ms,r.size_bytes,COALESCE(t.kind,\'other\') AS kind,COALESCE(t.expires_ms,r.received_ms+2592000000) AS expires_ms FROM inbound_receipts r LEFT JOIN inbound_retention t ON t.id=r.id '+(selected?'WHERE r.alias=? ':'')+'ORDER BY r.received_ms DESC LIMIT ?';
 const response=await cfRequest(cfg,'/accounts/'+cfg.accountId+'/d1/database/'+db+'/query',
  {method:'POST',body:{sql,params:selected?[selected,max]:[max]}},request);
 const sets=Array.isArray(response)?response:[response];
 const rows=sets.flatMap(x=>Array.isArray(x?.results)?x.results:[]);
 return {provider:'cloudflare-d1',alias:selected,limit:max,messages:rows.map(row=>({
  id:String(row.id||''),alias:String(row.alias||'').toLowerCase(),
  receivedAt:Number(row.received_ms||0),sizeBytes:Number(row.size_bytes||0),
  kind:row.kind==='verification'?'verification':'other',
  expiresAt:Number(row.expires_ms||0)
 })).filter(row=>/^[0-9a-f-]{36}$/i.test(row.id)&&ALIAS.test(row.alias))};
}
function register({ipcMain,requireOwner,requireCloudflareSession,sessions}){
 ipcMain.handle('email:archive:recent',async(event,payload={})=>{
  const cfg=credentialsFor(event,{sessions,requireOwner,requireCloudflareSession});
  return listArchive(cfg,payload);
 });
}
module.exports={register,listArchive,normalizeAlias};
