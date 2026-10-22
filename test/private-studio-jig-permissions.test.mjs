import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import {registerPrivateStudioJigPermissions,validJigs,JIG_TYPES} from "../private-studio-jig-permissions.js";

function harness(dir) {
  const routes=new Map();
  const app={
    get:(route,...handlers)=>routes.set("GET "+route,handlers.at(-1)),
    put:(route,...handlers)=>routes.set("PUT "+route,handlers.at(-1)),
    post:(route,...handlers)=>routes.set("POST "+route,handlers.at(-1)),
    delete:(route,...handlers)=>routes.set("DELETE "+route,handlers.at(-1))
  };
  const owner="ACOP-"+["A".repeat(16),"B".repeat(16),"C".repeat(16),"D".repeat(16)].join("-");
  registerPrivateStudioJigPermissions({
    app,requireAdmin:()=>{},dataDir:dir,
    resolveLicenseKey:async key=>key===owner?"customer-a":null,
    licenseAccounts:async()=>["customer-a","customer-b"]
  });
  const invoke=async(method,route,body={},params={})=>{
    const response=new EventEmitter();
    response.code=200;response.headers={};response.events=[];
    response.status=function(code){this.code=code;return this;};
    response.setHeader=function(key,value){this.headers[key]=value;return this;};
    response.json=function(data){this.body=data;return this;};
    response.write=function(chunk){this.events.push(chunk);return true;};
    response.end=function(){this.emit("close");return this;};
    response.flushHeaders=function(){};
    const handler=routes.get(method+" "+route);
    assert.ok(handler,"Expected route "+method+" "+route);
    await handler({body,params},response);
    return response;
  };
  return {invoke,owner};
}

test("global and customer-specific jig checkboxes persist and remain isolated",async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"studio-jig-access-"));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const {invoke,owner}=harness(dir);
  let snapshot=await invoke("POST","/api/studio-private/jig-permissions",{licenseKey:owner});
  assert.equal(snapshot.code,200);
  assert.deepEqual(Object.keys(snapshot.body.allowed),Object.keys(JIG_TYPES));
  assert.ok(Object.values(snapshot.body.allowed).every(Boolean));
  const toggles={...snapshot.body.allowed,fraction:false,hyphen:false};
  assert.equal(validJigs(toggles),true);
  const saved=await invoke("PUT","/api/admin/studio-private/jig-permissions",{scope:"global",allowed:toggles});
  assert.equal(saved.body.saved,true);
  snapshot=await invoke("POST","/api/studio-private/jig-permissions",{licenseKey:owner});
  assert.equal(snapshot.body.allowed.fraction,false);
  const byUser={...toggles,fraction:true};
  const overridden=await invoke("PUT","/api/admin/studio-private/jig-permissions",
    {scope:"customer",accountId:"customer-a",allowed:byUser});
  assert.equal(overridden.body.saved,true);
  const after=await invoke("POST","/api/studio-private/jig-permissions",{licenseKey:owner});
  assert.equal(after.body.allowed.fraction,true);
  const other=await invoke("GET","/api/admin/studio-private/jig-permissions");
  assert.equal(other.body.global.fraction,false);
  assert.equal(other.body.customers["customer-a"].fraction,true);
  const restarted=harness(dir);
  const disk=await restarted.invoke("GET","/api/admin/studio-private/jig-permissions");
  assert.equal(disk.body.customers["customer-a"].fraction,true);
  const reset=await invoke("DELETE","/api/admin/studio-private/jig-permissions/:accountId",{}, {accountId:"customer-a"});
  assert.equal(reset.body.allowed.fraction,false);
});

test("live connected customer receives toggle updates without a software update",async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"studio-jig-events-"));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const {invoke,owner}=harness(dir);
  const connection=await invoke("POST","/api/studio-private/jig-permissions/events",{licenseKey:owner});
  assert.equal(connection.headers["Content-Type"],"text/event-stream; charset=utf-8");
  assert.match(connection.events.join(""),/event: jig-permissions/);
  const changed=Object.fromEntries(Object.keys(JIG_TYPES).map(k=>[k,k!=="ordinal"]));
  await invoke("PUT","/api/admin/studio-private/jig-permissions",{scope:"global",allowed:changed});
  assert.match(connection.events.at(-1),/"ordinal":false/);
  assert.ok(!connection.events.join("").includes("cardNumber"));
  connection.end();
});

test("unknown jig types and unlicensed users are rejected",async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"studio-jig-denial-"));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const {invoke}=harness(dir);
  let response=await invoke("POST","/api/studio-private/jig-permissions",{licenseKey:"bad"});
  assert.equal(response.code,401);
  response=await invoke("PUT","/api/admin/studio-private/jig-permissions",
    {scope:"global",allowed:{suffix:true}});
  assert.equal(response.code,400);
  response=await invoke("PUT","/api/admin/studio-private/jig-permissions",
    {scope:"customer",accountId:"other-customer",allowed:Object.fromEntries(Object.keys(JIG_TYPES).map(k=>[k,true]))});
  assert.equal(response.code,404);
});
