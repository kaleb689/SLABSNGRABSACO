import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import webpush from "web-push";
import {validPushSubscription} from "./order-notifications.js";

const categories=["newOrders","activations","expirations","actionNeeded","support","checkouts","deployments"];
const defaults=Object.fromEntries(categories.map(x=>[x,true]));
export function attachAdminPush(app,{dataDir,requireAdmin,baseUrl}){
 const file=path.join(dataDir,"admin-push-settings.json"),keyFile=path.join(dataDir,"app-push-vapid.json");
 const read=async()=>{try{return JSON.parse(await fs.readFile(file,"utf8"))}catch{return {subscriptions:[],preferences:defaults}}};
 const write=async x=>{await fs.mkdir(dataDir,{recursive:true,mode:0o700});const tmp=file+"."+crypto.randomBytes(6).toString("hex");await fs.writeFile(tmp,JSON.stringify(x,null,2),{mode:0o600});await fs.rename(tmp,file)};
 const publicKey=async()=>{try{const x=JSON.parse(await fs.readFile(keyFile,"utf8"));return x.publicKey||x.public||null}catch{return null}};
 app.get("/api/admin/push/settings",requireAdmin,async(_req,res)=>{const x=await read();res.set("Cache-Control","no-store");res.json({preferences:{...defaults,...x.preferences},subscribedDevices:x.subscriptions.length,publicKey:await publicKey()})});
 app.put("/api/admin/push/settings",requireAdmin,async(req,res)=>{const x=await read();x.preferences={...defaults,...x.preferences};for(const k of categories)if(typeof req.body?.[k]==="boolean")x.preferences[k]=req.body[k];await write(x);res.json({preferences:x.preferences})});
 app.post("/api/admin/push/subscribe",requireAdmin,async(req,res)=>{if(!validPushSubscription(req.body))return res.status(400).json({error:"Invalid push subscription"});const x=await read();x.subscriptions=x.subscriptions.filter(s=>s.endpoint!==req.body.endpoint);x.subscriptions.push({endpoint:req.body.endpoint,keys:req.body.keys});x.subscriptions=x.subscriptions.slice(-10);await write(x);res.json({ok:true})});
 app.post("/api/admin/push/unsubscribe",requireAdmin,async(req,res)=>{const x=await read();x.subscriptions=x.subscriptions.filter(s=>s.endpoint!==req.body?.endpoint);await write(x);res.json({ok:true})});
 return async function notifyAdmin(category,title,body,url="/admin-app.html"){
  if(!categories.includes(category))return;
  const x=await read();if(x.preferences?.[category]===false)return;
  const keys=await fs.readFile(keyFile,"utf8").then(JSON.parse).catch(()=>null);
  if(!keys?.publicKey||!keys?.privateKey)return;
  webpush.setVapidDetails("mailto:admin@slabsngrabs.com",keys.publicKey,keys.privateKey);
  const payload=JSON.stringify({title:String(title).slice(0,120),body:String(body).slice(0,180),url});
  for(const sub of x.subscriptions){try{await webpush.sendNotification(sub,payload)}catch(e){if([404,410].includes(e.statusCode)){x.subscriptions=x.subscriptions.filter(s=>s.endpoint!==sub.endpoint)}}}
  await write(x);
 };
}
