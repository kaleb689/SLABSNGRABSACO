import test from "node:test";
import assert from "node:assert/strict";
import {discordApiRequestPolicy} from "../discord-community.js";

test("Discord callback must be acknowledged within 3 seconds, never wait on retries",()=>{
  const p=discordApiRequestPolicy("/interactions/1573192040425201756/sensitive-interaction-token/callback","POST");
  assert.deepEqual(p,{interactionCallback:true,attempts:1,timeoutMs:2200});
});
test("non-callback Discord API requests preserve normal retry limits",()=>{
  for(const route of [
    "/channels/1573192040425201756/messages",
    "/webhooks/1573192040425201756/opaque-token/messages/@original",
    "/interactions/1573192040425201756/sensitive-interaction-token/callback?ignored"
  ]){
    const p=discordApiRequestPolicy(route,route.startsWith("/interactions")?"GET":"PATCH");
    assert.equal(p.interactionCallback,false);
    assert.equal(p.attempts,6);
    assert.equal(p.timeoutMs,15000);
  }
});
test("callback route must have an actual Discord snowflake",()=>{
  const p=discordApiRequestPolicy("/interactions/not-an-id/token/callback","POST");
  assert.equal(p.interactionCallback,false);
});
