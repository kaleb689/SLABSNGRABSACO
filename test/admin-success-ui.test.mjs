import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const source=readFileSync(new URL("../public/admin-mobile.js",import.meta.url),"utf8");

test("Admin Success renders lifetime, unmatched, customer products and hit accounts",async()=>{
  const elements=new Map();
  function el(id){
    if(!elements.has(id)){
      const listeners=new Map();
      elements.set(id,{
        id,hidden:false,innerHTML:"",textContent:"",value:"",listeners,
        classList:{toggle(){}},
        addEventListener(name,cb){listeners.set(name,cb);},
        querySelectorAll(){return [];},
        querySelector(){return null;}
      });
    }
    return elements.get(id);
  }
  const recent=new Date().toISOString();
  const fixtures={
    "/api/admin/submissions":{submissions:[]},
    "/api/admin/profile-activation-tracker":{customers:[]},
    "/api/managed-availability":{},
    "/api/admin/app-usage":{},
    "/api/admin/success-overview":{
      records:[
        {retailer:"Target",checkoutAt:recent,orderTotal:25,orderTotalKnown:true,
          customerAccountId:"user1",customerName:"Amy Example",
          accountKey:"paid:target:1",accountLabel:"Target paid profile 1",accountKind:"paid",
          items:[{name:"Ascended Heroes Tin",quantity:2,imageUrl:""}]},
        {retailer:"Walmart",checkoutAt:recent,orderTotal:13.25,orderTotalKnown:true,
          customerAccountId:null,customerName:"Unmatched checkout",
          accountKey:"unassigned",accountLabel:"Unmatched",accountKind:"unclassified",
          items:[{name:"Booster Pack",quantity:1,imageUrl:""}]}
      ],
      unmatchedCount:1,
      communityTotals:{totalCheckouts:242,totalSpent:15914.40},
      historicalSummary:{historicalCheckouts:240,historicalSpent:15876.11,reportedReconciliation:.04}
    }
  };
  const document={
    hidden:false,activeElement:null,getElementById:el,
    querySelectorAll(){return [];},addEventListener(){}
  };
  const sandbox={
    document,window:{scrollX:0,scrollY:0,scrollTo(){},addEventListener(){}},
    navigator:{},location:{assign(){}},Date,Intl,Map,Set,Math,Number,String,Array,
    fetch:async path=>({status:200,ok:true,json:async()=>fixtures[path]||{}}),
    EventSource:class {addEventListener(){}close(){}},
    setTimeout(){return 1;},clearTimeout(){},setInterval(){return 2;},
    requestAnimationFrame(cb){cb();},console,alert(){}
  };
  vm.runInNewContext(source,sandbox,{filename:"admin-mobile.js"});
  for(let i=0;i<7;i++)await new Promise(resolve=>setImmediate(resolve));
  const tab=el("tabs").listeners.get("click");
  assert.equal(typeof tab,"function");
  tab({target:{closest:()=>({dataset:{tab:"success"}})}});
  for(let i=0;i<7;i++)await new Promise(resolve=>setImmediate(resolve));
  const html=el("content").innerHTML;
  assert.match(html,/Lifetime community checkouts/);
  assert.match(html,/\$15,914\.40/);
  assert.match(html,/Unmatched confirmed checkouts/);
  assert.match(html,/All community checkouts/);
  assert.match(html,/Amy Example/);
  assert.match(html,/Which accounts checked out/);
  assert.match(html,/Target paid profile 1/);
  assert.match(html,/Ascended Heroes Tin/);
  assert.match(html,/Booster Pack/);
  assert.match(html,/Orders by retailer/);
  assert.match(html,/24H/);
  assert.match(html,/30D/);
  assert.match(html,/YTD/);
  assert.doesNotMatch(html,/password:|example@gmail\.com/);
});
