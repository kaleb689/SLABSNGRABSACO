import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { attachAdminDesktopDevices } from "../admin-desktop-devices.js";

function harness(dataDir){
  const routes={post:new Map(),get:new Map(),delete:new Map()};
  const app={
    post(path,...handlers){routes.post.set(path,handlers);},
    get(path,...handlers){routes.get.set(path,handlers);},
    delete(path,...handlers){routes.delete.set(path,handlers);}
  };
  const sessions=new Map();
  const requireAdmin=(req,res,next)=>next();
  attachAdminDesktopDevices(app,{
    dataDir,
    requireAdmin,
    adminSessions:sessions,
    adminSessionKey:token=>crypto.createHash("sha256").update(token).digest("hex"),
    adminUserAgentHash:req=>crypto.createHash("sha256").update(String(req.headers?.["user-agent"]||"")).digest("hex"),
    sessionIdleMs:2*60*60*1000,
    sessionMaxAgeMs:8*60*60*1000,
    secureCookies:true
  });
  return {routes,sessions};
}
function response(){
  return {
    statusCode:200,headers:{},body:null,
    setHeader(k,v){this.headers[k]=v;},
    status(code){this.statusCode=code;return this;},
    json(body){this.body=body;return this;}
  };
}
async function invoke(handlers,req,res){
  let index=-1;
  const next=async()=>{index++;if(index<handlers.length)await handlers[index](req,res,next);};
  await next();return res;
}

test("desktop Touch ID enrollment stores only a token hash and unlock mints an Admin cookie",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"aco-desktop-auth-"));
  try{
    const h=harness(dir),deviceId=crypto.randomUUID();
    const enrollRes=response();
    await invoke(h.routes.post.get("/api/admin/desktop-device/enroll"),{
      body:{deviceId},headers:{"user-agent":"ACO Studio Test"},ip:"127.0.0.1"
    },enrollRes);
    assert.equal(enrollRes.statusCode,201);
    assert.equal(enrollRes.body.ok,true);
    assert.match(enrollRes.body.token,/^[a-f0-9]{64}$/);
    const stored=JSON.parse(await fs.readFile(path.join(dir,"admin-desktop-devices.json"),"utf8"));
    assert.equal(stored.length,1);
    assert.notEqual(stored[0].tokenHash,enrollRes.body.token);
    assert.equal(stored[0].tokenHash,crypto.createHash("sha256").update(enrollRes.body.token).digest("hex"));

    const unlockRes=response();
    await invoke(h.routes.post.get("/api/admin/desktop-device/unlock"),{
      body:{deviceId,token:enrollRes.body.token},headers:{"user-agent":"ACO Studio Test"},ip:"127.0.0.1"
    },unlockRes);
    assert.equal(unlockRes.statusCode,200);
    assert.equal(unlockRes.body.ok,true);
    assert.match(unlockRes.headers["Set-Cookie"],/^sng_admin=/);
    assert.match(unlockRes.headers["Set-Cookie"],/HttpOnly/);
    assert.match(unlockRes.headers["Set-Cookie"],/SameSite=Strict/);
    assert.match(unlockRes.headers["Set-Cookie"],/Secure/);
    assert.equal(h.sessions.size,1);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test("desktop unlock rejects a wrong token and never creates a session",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"aco-desktop-auth-"));
  try{
    const h=harness(dir),deviceId=crypto.randomUUID();
    const enrollRes=response();
    await invoke(h.routes.post.get("/api/admin/desktop-device/enroll"),{
      body:{deviceId},headers:{"user-agent":"ACO Studio Test"},ip:"127.0.0.1"
    },enrollRes);
    const unlockRes=response();
    await invoke(h.routes.post.get("/api/admin/desktop-device/unlock"),{
      body:{deviceId,token:"0".repeat(64)},headers:{"user-agent":"ACO Studio Test"},ip:"127.0.0.1"
    },unlockRes);
    assert.equal(unlockRes.statusCode,401);
    assert.equal(h.sessions.size,0);
    assert.equal(unlockRes.headers["Set-Cookie"],undefined);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
