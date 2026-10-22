import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {lapseGroupPayload,discordValidationFieldPaths} from "../discord-community.js";

const profile = (i) => ({
  type: i % 2 ? "rented" : "free", managedAccountId: "account-" + i,
  retailer: i % 2 ? "target" : "pokemoncenter",
  retailerAccountEmail: "test" + i + "@example.test", profileLabel: "Test " + i
});
test("lapse embeds stay within Discord 4096 description and five action rows", () => {
  for (const count of [1, 25, 50, 100, 101, 126, 251, 500]) {
    const group={customerName:"Customer ".repeat(40),customerEmail:"a".repeat(200)+"@example.test",items:Array.from({length:count},(_,i)=>profile(i))};
    for(let page=0;page<Math.ceil(count/100);page++){
      const result=lapseGroupPayload(group,page),body=result.payload;
      assert.ok(body.embeds[0].description.length<=4096,"desc "+count+"/"+page);
      assert.ok(body.components.length<=5,"rows "+count+"/"+page);
      for(const row of body.components){
        assert.ok(row.components.length<=5);
        for(const c of row.components){
          assert.ok(c.custom_id.length<=100);
          if(c.type===3){
            assert.ok(c.options.length>=1 && c.options.length<=25);
            assert.ok(c.max_values<=c.options.length && c.min_values===1);
            const values=c.options.map(x=>x.value);
            assert.equal(new Set(values).size,values.length);
            for(const x of c.options){
              assert.ok(x.value.length<=100 && x.label.length<=100 && x.description.length<=100);
              assert.ok(result.optionKeys[x.value]?.includes("account-"));
            }
          }
        }
      }
      assert.equal(result.itemCount,count);
      assert.equal(result.page,page);
    }
  }
});
test("duplicate lapse records do not create duplicate Discord select values",()=>{
 const item=profile(1),r=lapseGroupPayload({items:[item,item,{...item}]});
 assert.equal(r.itemCount,1);
 assert.equal(r.payload.components[0].components[0].options.length,1);
});
test("a stable compact selector handles long account IDs without leaking them into custom IDs",()=>{
 const original="account-".padEnd(240,"A"),r=lapseGroupPayload({items:[{type:"rented",managedAccountId:original,retailer:"target"}]});
 const value=r.payload.components[0].components[0].options[0].value;
 assert.ok(value.length<100);
 assert.equal(r.optionKeys[value],"rented:"+original);
});
test("Discord failure diagnostics expose field paths only, never values or remote messages",()=>{
 const source={code:50035,message:"private secret",errors:{components:{"4":{components:{"0":{options:{_errors:[{message:"private secret"}]}}}}}}};
 assert.deepEqual(discordValidationFieldPaths(source),["components.4.components.0.options"]);
 const printed=discordValidationFieldPaths(source).join(",");
 assert.ok(!printed.includes("private secret"));
 assert.deepEqual(discordValidationFieldPaths({errors:{items:{"john@example.test":{_errors:[{}]}}}}),[]);
});

test("opaque option keys remain available when a later page survives a restart",()=>{
 const group={items:Array.from({length:202},(_,i)=>profile(i))};
 const first=lapseGroupPayload(group,0),last=lapseGroupPayload(group,2);
 const lastValue=last.payload.components[0].components[0].options[0].value;
 assert.equal(first.optionKeys[lastValue],last.optionKeys[lastValue]);
 assert.equal(last.page,2);
 assert.equal(last.totalPages,3);
});
test("unchanged lapse groups rehydrate selection state without re-sending a Discord PATCH",()=>{
 const source=readFileSync(new URL("../membership-lapse-notifications.js",import.meta.url),"utf8");
 const discord=readFileSync(new URL("../discord-community.js",import.meta.url),"utf8");
 assert.match(source,/rememberDiscordLapseChecklistGroup\(\{\.\.\.group, messageId: previous\.messageId\}\)/);
 assert.match(discord,/export function rememberDiscordLapseChecklistGroup\(/);
 assert.match(discord,/if \(lapseChecklistMessages\.has\(id\)\) return true/);
 assert.match(discord,/const displayedPage = pageLabel \? Math\.max\(0, Number\(pageLabel\[1\]\) - 1\) : saved\.page/);
});
