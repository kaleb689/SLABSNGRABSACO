import test from "node:test";
import assert from "node:assert/strict";
import {evaluateDiscordPaidSkuAccess} from "../discord-community.js";

const id="1551070928039845924",owner="1551070928039845999";
const account=(name,extra={})=>({id:name,discordUserId:id,disabled:false,...extra});

test("new paid website account is not shadowed by old unentitled linked record",async()=>{
 const checked=[];
 const state=await evaluateDiscordPaidSkuAccess({
  discordUserId:id,ownerId:owner,
  accounts:[account("old"),account("new")],
  getPaidAllowance:async name=>{checked.push(name);return name==="new"?20:0;}
 });
 assert.deepEqual(checked,["old","new"]);
 assert.equal(state.allowed,true);
 assert.equal(state.reason,"active_paid");
 assert.equal(state.accountId,"new");
});

test("an admin active flag without paid entitlement cannot bypass SKU payment gate",async()=>{
 const state=await evaluateDiscordPaidSkuAccess({
  discordUserId:id,ownerId:owner,
  accounts:[account("new",{status:"active",activationStatus:"activated",profiles:20})],
  getPaidAllowance:async()=>0
 });
 assert.deepEqual(state,{allowed:false,reason:"no_paid_entitlement"});
});

test("disabled rows are ignored but an enabled paid duplicate is allowed",async()=>{
 const result=await evaluateDiscordPaidSkuAccess({
  discordUserId:id,ownerId:owner,
  accounts:[account("disabled",{disabled:true}),account("enabled")],
  getPaidAllowance:async name=>name==="enabled"?1:0
 });
 assert.equal(result.allowed,true);
 assert.equal(result.accountId,"enabled");
});

test("wrong Discord IDs and unlinked accounts never receive paid access",async()=>{
 const result=await evaluateDiscordPaidSkuAccess({
  discordUserId:id,ownerId:owner,
  accounts:[account("other",{discordUserId:"1551070928039845900"})],
  getPaidAllowance:async()=>100
 });
 assert.equal(result.allowed,false);
 assert.equal(result.reason,"discord_not_linked");
});

test("temporary entitlement lookup failures are not mistaken for unpaid membership",async()=>{
 const result=await evaluateDiscordPaidSkuAccess({
  discordUserId:id,ownerId:owner,
  accounts:[account("enabled")],
  getPaidAllowance:async()=>{throw Object.assign(new Error("connection error"),{code:"ECONNRESET"});}
 });
 assert.equal(result.allowed,false);
 assert.equal(result.reason,"membership_lookup_unavailable");
});

test("only verified Discord owner can use test bypass",async()=>{
 const result=await evaluateDiscordPaidSkuAccess({
  discordUserId:owner,ownerId:owner,
  accounts:[],getPaidAllowance:async()=>0
 });
 assert.equal(result.allowed,true);
 assert.equal(result.reason,"owner_test");
 const invalid=await evaluateDiscordPaidSkuAccess({
  discordUserId:"owner",ownerId:"owner",accounts:[],getPaidAllowance:async()=>100
 });
 assert.equal(invalid.allowed,false);
});
