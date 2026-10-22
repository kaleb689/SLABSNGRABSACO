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
