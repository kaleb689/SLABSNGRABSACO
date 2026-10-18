import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_DEVICES=5;
const DEVICE_TTL_MS=90*24*60*60*1000;
const TOKEN_BYTES=32;
const DEVICE_ID=/^[a-f0-9-]{36}$/i;

const hash=value=>crypto.createHash("sha256").update(String(value||"")).digest("hex");
const safeEqual=(a,b)=>{
  const A=Buffer.from(String(a||"")),B=Buffer.from(String(b||""));
  return A.length===B.length&&crypto.timingSafeEqual(A,B);
};

export function attachAdminDesktopDevices(app,{
  dataDir,
  requireAdmin,
  adminSessions,
  adminSessionKey,
  adminUserAgentHash,
  sessionIdleMs,
  sessionMaxAgeMs,
  secureCookies=false
}){
  const file=path.join(dataDir,"admin-desktop-devices.json");
  const attempts=new Map();

  async function read(){
    try{
      const data=JSON.parse(await fs.readFile(file,"utf8"));
      return Array.isArray(data)?data:[];
    }catch{return [];}
  }
  async function write(records){
    await fs.mkdir(dataDir,{recursive:true,mode:0o700});
    const tmp=file+"."+crypto.randomBytes(8).toString("hex");
    await fs.writeFile(tmp,JSON.stringify(records,null,2),{mode:0o600});
    await fs.rename(tmp,file);
  }
  function normalize(records){
    const now=Date.now();
    return records.filter(item=>
      item&&DEVICE_ID.test(String(item.deviceId||""))&&
      /^[a-f0-9]{64}$/i.test(String(item.tokenHash||""))&&
      Number(item.expiresAt||0)>now&&
      item.revokedAt==null
    );
  }
  function setAdminSession(req,res){
    const token=crypto.randomBytes(32).toString("hex");
    const createdAt=Date.now(),absoluteExpires=createdAt+sessionMaxAgeMs;
    adminSessions.set(adminSessionKey(token),{
      createdAt,
      absoluteExpires,
      idleExpires:Math.min(createdAt+sessionIdleMs,absoluteExpires),
      userAgentHash:adminUserAgentHash(req)
    });
    res.setHeader("Set-Cookie",
      `sng_admin=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionMaxAgeMs/1000)}; Priority=High${secureCookies?"; Secure":""}`);
  }
  function rateLimit(req,res){
    const key=String(req.ip||"unknown"),now=Date.now(),windowMs=15*60*1000,max=20;
    let row=attempts.get(key);
    if(!row||row.reset<=now)row={count:0,reset:now+windowMs};
    if(row.count>=max){
      res.setHeader("Retry-After",String(Math.max(1,Math.ceil((row.reset-now)/1000))));
      res.status(429).json({error:"Too many desktop unlock attempts. Try again later."});
      return false;
    }
    row.count+=1;attempts.set(key,row);return true;
  }

  app.post("/api/admin/desktop-device/enroll",requireAdmin,async(req,res)=>{
    try{
      const deviceId=String(req.body?.deviceId||"").trim();
      if(!DEVICE_ID.test(deviceId))return res.status(400).json({error:"Invalid desktop device ID."});
      const token=crypto.randomBytes(TOKEN_BYTES).toString("hex"),now=Date.now();
      let records=normalize(await read()).filter(item=>item.deviceId!==deviceId);
      if(records.length>=MAX_DEVICES)records.sort((a,b)=>Number(a.lastUsedAt||a.createdAt||0)-Number(b.lastUsedAt||b.createdAt||0)).shift();
      records.push({
        deviceId,
        tokenHash:hash(token),
        createdAt:now,
        expiresAt:now+DEVICE_TTL_MS,
        lastUsedAt:null,
        userAgentHash:adminUserAgentHash(req)
      });
      await write(records);
      return res.status(201).json({ok:true,deviceId,token,expiresAt:now+DEVICE_TTL_MS});
    }catch(error){
      console.error("Desktop Admin enrollment failed:",error?.message||error);
      return res.status(500).json({error:"Unable to enroll this desktop securely."});
    }
  });

  app.post("/api/admin/desktop-device/unlock",async(req,res)=>{
    if(!rateLimit(req,res))return;
    try{
      const deviceId=String(req.body?.deviceId||"").trim();
      const token=String(req.body?.token||"").trim();
      if(!DEVICE_ID.test(deviceId)||!/^[a-f0-9]{64}$/i.test(token)){
        return res.status(401).json({error:"Desktop authorization is invalid."});
      }
      let records=normalize(await read());
      const record=records.find(item=>item.deviceId===deviceId);
      if(!record||!safeEqual(record.tokenHash,hash(token))){
        return res.status(401).json({error:"This Mac is not enrolled for Touch ID Admin access."});
      }
      record.lastUsedAt=Date.now();
      record.userAgentHash=adminUserAgentHash(req);
      await write(records);
      setAdminSession(req,res);
      attempts.delete(String(req.ip||"unknown"));
      return res.json({ok:true,deviceId,expiresAt:record.expiresAt});
    }catch(error){
      console.error("Desktop Admin unlock failed:",error?.message||error);
      return res.status(500).json({error:"Unable to unlock this Admin session."});
    }
  });

  app.get("/api/admin/desktop-devices",requireAdmin,async(_req,res)=>{
    const records=normalize(await read());
    return res.json({devices:records.map(item=>({
      deviceId:item.deviceId,
      createdAt:new Date(item.createdAt).toISOString(),
      lastUsedAt:item.lastUsedAt?new Date(item.lastUsedAt).toISOString():null,
      expiresAt:new Date(item.expiresAt).toISOString()
    }))});
  });

  app.delete("/api/admin/desktop-devices/:deviceId",requireAdmin,async(req,res)=>{
    const deviceId=String(req.params.deviceId||"").trim();
    if(!DEVICE_ID.test(deviceId))return res.status(400).json({error:"Invalid desktop device ID."});
    const records=await read(),next=records.filter(item=>item.deviceId!==deviceId);
    if(next.length===records.length)return res.status(404).json({error:"Desktop device was not found."});
    await write(next);
    return res.json({ok:true});
  });
}
