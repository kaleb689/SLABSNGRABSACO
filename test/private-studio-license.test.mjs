import test from "node:test";
import assert from "node:assert/strict";
import {licenseKey, sealKey, unsealKey, subscriptionEntitled, PRIVATE_STUDIO_PRICE} from "../private-studio-license.js";
const secret="test-secret-for-private-edition-must-never-be-live";
test("128-bit+ random keys and encrypted storage never expose plaintext in the record",()=>{
 const first=licenseKey(),second=licenseKey();
 assert.match(first,/^ACOP-(?:[A-F0-9]{16}-){3}[A-F0-9]{16}$/);
 assert.notEqual(first,second);
 const encrypted=sealKey(first,secret);assert.ok(!encrypted.includes(first));
 assert.equal(unsealKey(encrypted,secret),first);
 assert.throws(()=>unsealKey(encrypted,"wrong-secret-but-sufficient-length"),/authenticate/i);
});
test("license entitlement is tied to the exact private monthly price and active status",()=>{
 const subscription=(status,price)=>({status,items:{data:[{price:{id:price}}]}});
 assert.equal(subscriptionEntitled(subscription("active",PRIVATE_STUDIO_PRICE)),true);
 assert.equal(subscriptionEntitled(subscription("trialing",PRIVATE_STUDIO_PRICE)),true);
 for(const s of ["canceled","unpaid","past_due","incomplete","incomplete_expired"])
   assert.equal(subscriptionEntitled(subscription(s,PRIVATE_STUDIO_PRICE)),false,s);
 assert.equal(subscriptionEntitled(subscription("active","price_member_20")),false);
 assert.equal(subscriptionEntitled(null),false);
});
test("customer edition desktop exposes no owner app sync, email gen, or website admin contract",async()=>{
 const fs=await import("node:fs/promises");
 const source=(await Promise.all(["main.cjs","preload.cjs","renderer.js","vault.cjs","formats.cjs","jigs.cjs"].map(n=>fs.readFile(new URL("../private-edition/"+n,import.meta.url),"utf8")))).join("\n");
 for(const term of ["getCustomerAccounts","site-bridge","admin-api","Email Gen","emailGen","discordUserId","/api/admin/", "server-studio-customer-sync"])
   assert.equal(source.includes(term),false,"Customer bundle contains prohibited integration "+term);
 const main=await fs.readFile(new URL("../private-edition/main.cjs",import.meta.url),"utf8");
 assert.equal(main.includes('https://slabsngrabsaco.com/api/studio-private/license/verify'),true);
 assert.equal(main.includes("/api/account/"),false);
});

test("checkout provisions only a license; only its purchaser can see the key; owner revoke blocks verification",async()=>{
 const { registerPrivateStudioLicensing }=await import("../private-studio-license.js");
 const fs=await import("node:fs/promises"),os=await import("node:os"),path=await import("node:path");
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"studio-private-test-"));
 try{
  const routes={};
  const app={get:(name,...handlers)=>{routes["GET "+name]=handlers.at(-1);},
    post:(name,...handlers)=>{routes["POST "+name]=handlers.at(-1);}};
  const subscription={id:"sub_test_abc",status:"active",items:{data:[{price:{id:PRIVATE_STUDIO_PRICE}}]}};
  const stripe={subscriptions:{retrieve:async()=>subscription},products:{retrieve:async()=>({active:false})},prices:{retrieve:async()=>({active:false})},
    checkout:{sessions:{retrieve:async()=>({id:"cs_live_TEST1234567890",mode:"subscription",metadata:{purchase_type:"studio_private",customer_account_id:"account-a"},
      client_reference_id:"account-a",subscription:"sub_test_abc",customer:"cus_test"})}}};
  const engine=registerPrivateStudioLicensing({app,stripe,requireCustomer:()=>{},requireAdmin:()=>{},dataDir:dir,baseUrl:"https://example.test",secret});
  const event={type:"checkout.session.completed",data:{object:{id:"cs_live_TEST1234567890",mode:"subscription",
    metadata:{purchase_type:"studio_private",customer_account_id:"account-a"},subscription:"sub_test_abc",customer:"cus_test"}}};
  await engine.onStripeEvent(event);await engine.onStripeEvent(event);
  const records=JSON.parse(await fs.readFile(path.join(dir,"private-studio-licenses.json"),"utf8"));
  assert.equal(records.length,1);
  const invoke=async(method,url,req={})=>{
    const res={code:200,headers:{},status(v){this.code=v;return this;},setHeader(k,v){this.headers[k]=v;return this;},
      json(v){this.body=v;return this;}};
    await routes[method+" "+url]({ip:"127.0.0.1",body:{},...req},res);
    return res;
  };
  const owner=await invoke("GET","/api/account/studio-private/license",{customerAccount:{id:"account-a"}});
  const other=await invoke("GET","/api/account/studio-private/license",{customerAccount:{id:"account-b"}});
  assert.equal(owner.body.licenses.length,1);assert.equal(other.body.licenses.length,0);
  const key=owner.body.licenses[0].licenseKey;
  assert.match(key,/^ACOP-/);
  assert.ok(!(await fs.readFile(path.join(dir,"private-studio-licenses.json"),"utf8")).includes(key));
  const success=await invoke("POST","/api/studio-private/license/verify",{body:{licenseKey:key}});
  assert.equal(success.body.active,true);
  await invoke("POST","/api/admin/studio-private/revoke",{body:{licenseId:records[0].id}});
  const denied=await invoke("POST","/api/studio-private/license/verify",{body:{licenseKey:key}});
  assert.equal(denied.body.active,false);
  assert.equal(denied.code,401);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
