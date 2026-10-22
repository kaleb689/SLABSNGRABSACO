import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {registerPrivateStudioLicensing} from "../private-studio-license.js";

test("a time-limited owner evaluation key activates independently of Stripe and can be revoked",async()=>{
  const key="ACOP-"+Array.from({length:4},()=>crypto.randomBytes(8).toString("hex").toUpperCase()).join("-");
  const savedHash=process.env.PRIVATE_STUDIO_OWNER_TEST_KEY_SHA256;
  const savedExpiry=process.env.PRIVATE_STUDIO_OWNER_TEST_KEY_EXPIRES_AT;
  process.env.PRIVATE_STUDIO_OWNER_TEST_KEY_SHA256=crypto.createHash("sha256").update(key).digest("hex");
  process.env.PRIVATE_STUDIO_OWNER_TEST_KEY_EXPIRES_AT=new Date(Date.now()+3*86400000).toISOString();
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"studio-owner-test-"));
  try{
    const routes={},app={
      get:(name,...handlers)=>{routes["GET "+name]=handlers.at(-1);},
      post:(name,...handlers)=>{routes["POST "+name]=handlers.at(-1);},
      put:(name,...handlers)=>{routes["PUT "+name]=handlers.at(-1);},
      delete:(name,...handlers)=>{routes["DELETE "+name]=handlers.at(-1);}
    };
    registerPrivateStudioLicensing({app,stripe:{products:{retrieve:async()=>({active:false})},
      prices:{retrieve:async()=>({active:false})},subscriptions:{retrieve:async()=>{throw Error("No Stripe subscription should be retrieved for owner preview");}}},
      requireCustomer:(_req,_res,next)=>next(),requireAdmin:(_req,_res,next)=>next(),
      dataDir:dir,secret:"secure-test-secret-not-prod",baseUrl:"https://example.test",ownerEmail:"owner@example.test"});
    async function call(method,route,body={},params={}){
      const res={code:200,headers:{},setHeader(k,v){this.headers[k]=v;return this;},status(code){this.code=code;return this;},
        json(obj){this.body=obj;return this;}};
      await routes[method+" "+route]({ip:"127.0.0.1",body,params},res);
      return res;
    }
    const denied=await call("POST","/api/studio-private/license/verify",{licenseKey:key.slice(0,-1)+"F"});
    assert.equal(denied.code,401);
    const success=await call("POST","/api/studio-private/license/verify",{licenseKey:key});
    assert.equal(success.code,200);
    assert.deepEqual({active:success.body.active,edition:success.body.edition,evaluation:success.body.evaluation},
      {active:true,edition:"private",evaluation:true});
    const admin=await call("GET","/api/admin/studio-private/licenses");
    const demo=admin.body.licenses.find(x=>x.id==="owner-preview-license");
    assert.equal(demo.evaluation,true);
    assert.equal(demo.revoked,false);
    const revoked=await call("POST","/api/admin/studio-private/revoke",{licenseId:"owner-preview-license"});
    assert.equal(revoked.body.revoked,true);
    const after=await call("POST","/api/studio-private/license/verify",{licenseKey:key});
    assert.equal(after.code,403);
    const list=await call("GET","/api/admin/studio-private/licenses");
    assert.equal(list.body.licenses.find(x=>x.id==="owner-preview-license").revoked,true);
  }finally{
    await fs.rm(dir,{recursive:true,force:true});
    if(savedHash===undefined)delete process.env.PRIVATE_STUDIO_OWNER_TEST_KEY_SHA256;
    else process.env.PRIVATE_STUDIO_OWNER_TEST_KEY_SHA256=savedHash;
    if(savedExpiry===undefined)delete process.env.PRIVATE_STUDIO_OWNER_TEST_KEY_EXPIRES_AT;
    else process.env.PRIVATE_STUDIO_OWNER_TEST_KEY_EXPIRES_AT=savedExpiry;
  }
});
