import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// Remotely configurable permissions. No personal, card, address or profile data.
export const JIG_TYPES=Object.freeze({
 suffix:"Street suffix swap",directional:"Directional abbreviations",
 ordinal:"Ordinal street numbers",doubleLetter:"Double-letter street name",
 fraction:"Fractional house number",hyphen:"Hyphen house number",
 randomUnit:"Random unit on unassigned addresses",phone:"Randomize phone digits",
 name:"Randomize first and last name"
});
const keys=Object.keys(JIG_TYPES);
const defaults=()=>Object.fromEntries(keys.map(key=>[key,true]));
const empty=()=>({version:1,updatedAt:null,global:defaults(),customers:{}});
export const validJigs=x=>Boolean(x&&typeof x==="object"&&!Array.isArray(x)&&
 Object.keys(x).length===keys.length&&keys.every(k=>typeof x[k]==="boolean")&&
 Object.keys(x).every(k=>keys.includes(k)));
export const effectiveJigs=(data,id)=>({...defaults(),
 ...(validJigs(data.global)?data.global:{}),
 ...(validJigs(data.customers?.[id])?data.customers[id]:{})});
export function registerPrivateStudioJigPermissions({app,requireAdmin,dataDir,resolveLicenseKey,licenseAccounts}) {
 const file=path.join(dataDir,"private-studio-jig-permissions.json");
 const listeners=new Set();
 let queue=Promise.resolve();
 const locked=fn=>{const task=queue.then(fn,fn);queue=task.catch(()=>{});return task;};
 async function read(){
  try{
   const state=JSON.parse(await fs.readFile(file,"utf8"));
   if(!Number.isSafeInteger(state.version)||!validJigs(state.global)||
    !state.customers||typeof state.customers!=="object"||Array.isArray(state.customers))
    throw Error("Invalid jig permissions data.");
   return state;
  }catch(error){if(error.code==="ENOENT")return empty();throw error;}
 }
 async function save(state){
  await fs.mkdir(dataDir,{recursive:true,mode:0o700});
  const temp=file+"."+crypto.randomUUID()+".tmp";
  await fs.writeFile(temp,JSON.stringify(state),{flag:"wx",mode:0o600});
  await fs.rename(temp,file);
 }
 const snapshot=(state,id)=>({version:state.version,updatedAt:state.updatedAt,allowed:effectiveJigs(state,id)});
 const event=(res,value)=>res.write("event: jig-permissions\ndata: "+JSON.stringify(value)+"\n\n");
 function broadcast(state){for(const item of listeners)try{event(item.res,snapshot(state,item.id));}catch{listeners.delete(item);}}
 async function verify(req,res){
  const key=String(req.body?.licenseKey||"");
  if(!/^ACOP-(?:[A-F0-9]{16}-){3}[A-F0-9]{16}$/.test(key)){
   res.status(401).json({error:"An active ACO STUDIO license is required."});return null;
  }
  try{
   const id=await resolveLicenseKey(key);
   if(id)return id;
   res.status(403).json({error:"Your ACO STUDIO license is inactive."});
  }catch{res.status(503).json({error:"Cannot verify subscription right now."});}
  return null;
 }
 app.get("/api/admin/studio-private/jig-permissions",requireAdmin,async(_req,res)=>{
  try{res.setHeader("Cache-Control","no-store, private");res.json({...await read(),catalog:JIG_TYPES});}
  catch{res.status(503).json({error:"Cannot load jig permissions."});}
 });
 app.put("/api/admin/studio-private/jig-permissions",requireAdmin,async(req,res)=>{
  if(!validJigs(req.body?.allowed))return res.status(400).json({error:"All jig checkboxes must be set."});
  const scope=req.body?.scope,id=String(req.body?.accountId||"");
  if(scope!=="global"&&scope!=="customer")return res.status(400).json({error:"Invalid scope."});
  if(scope==="customer"){
   const available=await licenseAccounts();
   if(!available.includes(id))return res.status(404).json({error:"Select a licensed customer."});
  }
  try{
   const state=await locked(async()=>{
    const next=await read(),allowed=Object.fromEntries(keys.map(k=>[k,req.body.allowed[k]]));
    if(scope==="global")next.global=allowed;else next.customers[id]=allowed;
    next.version++;next.updatedAt=new Date().toISOString();await save(next);return next;
   });
   broadcast(state);res.setHeader("Cache-Control","no-store, private");
   res.json({saved:true,...snapshot(state,scope==="global"?"":id)});
  }catch{res.status(503).json({error:"Could not save jig permissions."});}
 });
 app.delete("/api/admin/studio-private/jig-permissions/:accountId",requireAdmin,async(req,res)=>{
  const id=String(req.params.accountId||"");
  try{
   const state=await locked(async()=>{const next=await read();delete next.customers[id];
    next.version++;next.updatedAt=new Date().toISOString();await save(next);return next;});
   broadcast(state);res.setHeader("Cache-Control","no-store, private");
   res.json({saved:true,...snapshot(state,id)});
  }catch{res.status(503).json({error:"Could not reset customer jig permissions."});}
 });
 app.post("/api/studio-private/jig-permissions",async(req,res)=>{
  const id=await verify(req,res);if(!id)return;
  try{res.setHeader("Cache-Control","no-store, private");res.json(snapshot(await read(),id));}
  catch{res.status(503).json({error:"Jig permissions unavailable."});}
 });
 app.post("/api/studio-private/jig-permissions/events",async(req,res)=>{
  const id=await verify(req,res);if(!id)return;
  if(listeners.size>=400)return res.status(503).json({error:"Live updates busy."});
  let state;try{state=await read();}catch{return res.status(503).json({error:"Jig permissions unavailable."});}
  res.status(200);res.setHeader("Content-Type","text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control","no-cache, no-transform");
  res.setHeader("Connection","keep-alive");res.setHeader("X-Accel-Buffering","no");
  res.flushHeaders?.();
  const item={res,id};listeners.add(item);event(res,snapshot(state,id));
  const heartbeat=setInterval(()=>{try{res.write(": heartbeat\n\n");}catch{}},25000);
  // Reauthenticate licenses on each reconnect. A live connection expires.
  const expires=setTimeout(()=>res.end(),9*60*1000);
  res.on("close",()=>{listeners.delete(item);clearInterval(heartbeat);clearTimeout(expires);});
 });
 return {read,listenerCount:()=>listeners.size};
}
