import test from "node:test";
import assert from "node:assert/strict";
import {collectDiscordRoleEntitlements} from "../discord-community.js";

const user="1551070928039845924";
const acct=(id,more={})=>({id,discordUserId:user,discordLinkedAt:"2026-11-19T20:00:00Z",disabled:false,...more});
test("duplicate linked website rows sync a member once at their maximum active allowance",async()=>{
 const records=[acct("active"),acct("old"),acct("disabled",{disabled:true})];
 const hits=[];
 const result=await collectDiscordRoleEntitlements(records,{
  getAllowance:async id=>{hits.push(id);return id==="active"?20:0;},
  getOgStatus:async id=>id==="active"
 });
 assert.deepEqual(hits,["active","old"]);
 assert.deepEqual(result,[{discordUserId:user,allowance:20,ogMember:true}]);
});
test("unlinked and malformed Discord IDs never trigger role changes",async()=>{
 const output=await collectDiscordRoleEntitlements([
  acct("x",{discordLinkedAt:""}),acct("y",{discordUserId:"not a snowflake"})
 ],{getAllowance:async()=>20});
 assert.deepEqual(output,[]);
});
test("full entitlement lookup outage does not remove a paid tier role",async()=>{
 const result=await collectDiscordRoleEntitlements([acct("active")],{
  getAllowance:async()=>{throw Error("temporary outage");}
 });
 assert.deepEqual(result,[]);
});
test("disabled account with no active linked records has zero entitlement",async()=>{
 const result=await collectDiscordRoleEntitlements([acct("disabled",{disabled:true})],{
  getAllowance:async()=>100
 });
 assert.deepEqual(result,[{discordUserId:user,allowance:0,ogMember:false}]);
});
