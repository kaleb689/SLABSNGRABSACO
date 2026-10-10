import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const source=readFileSync(new URL("../public/admin-mobile.js",import.meta.url),"utf8");

test("Admin Success renders period-matched unmatched, customer products and hit accounts",async()=>{
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
      ],
      communityRecords:[
        {retailer:"Target",checkoutAt:recent,orderTotal:25,orderTotalKnown:true,linked:true,
          items:[{name:"Ascended Heroes Tin",quantity:2,imageUrl:""}]},
        {retailer:"Walmart",checkoutAt:recent,orderTotal:13.25,orderTotalKnown:true,linked:false,
          items:[{name:"Booster Pack",quantity:1,imageUrl:""}]}
      ],
      unmatchedCount:1,
      communityTotals:{totalCheckouts:242,totalSpent:15914.36},
      historicalSummary:{historicalCheckouts:240,historicalSpent:15876.11}
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
  assert.doesNotMatch(html,/Lifetime community checkouts/);
  assert.match(html,/\$38\.25/); // includes authenticated community and unmatched paid totals
  assert.match(html,/All linked customer checkouts/);
  assert.match(html,/Amy Example checkout breakdown/);
  assert.match(html,/Which accounts checked out/);
  assert.match(html,/Target paid profile 1/);
  assert.match(html,/Ascended Heroes Tin/);
  assert.match(html,/2 confirmed orders/);
  // The new all-orders scope must be discoverable, while unmatched source
  // records are never mixed into individual customer ownership reports.
  assert.match(html,/Unmatched confirmed checkouts/);
  assert.equal(html.includes("Unmatched / unassigned checkouts"), false);
  assert.match(html,/Booster Pack/);
  const person=html.slice(html.indexOf('data-success-customer="user1"'));
  assert.doesNotMatch(person,/Booster Pack|Unmatched checkout/);
  assert.match(person,/Ascended Heroes Tin/);
  assert.match(html,/Orders by retailer/);
  assert.match(html,/24H/);
  assert.match(html,/30D/);
  assert.match(html,/YTD/);
  assert.doesNotMatch(html,/password:|example@gmail\.com/);
});

test("membership revenue counts only actual paid subscription invoices in month", async()=>{
  const {stripeMembershipRevenue}=await import("../stripe-membership-revenue.js");
  const stripe={
    subscriptions:{list:async()=>({data:[{id:"sub_a"},{id:"sub_b"}],has_more:false})},
    invoices:{list:async()=>({data:[
      {id:"in_a",status:"paid",currency:"usd",amount_paid:1500,created:1791653459,status_transitions:{paid_at:1791653463},parent:{subscription_details:{subscription:"sub_a"}}},
      {id:"in_b",status:"paid",currency:"usd",amount_paid:4550,created:1791477392,status_transitions:{paid_at:1791477396},parent:{subscription_details:{subscription:"sub_b"}}},
      {id:"in_wrong",status:"paid",currency:"usd",amount_paid:10000,created:1791477392,status_transitions:{paid_at:1791477396}},
      {id:"in_old",status:"paid",currency:"usd",amount_paid:3000,created:1790014905,status_transitions:{paid_at:1790014908},parent:{subscription_details:{subscription:"sub_a"}}}
    ],has_more:false})}
  };
  const v=await stripeMembershipRevenue(stripe,new Date("2026-10-10T22:00:00Z"));
  assert.equal(v.activePaidMemberships,2);
  assert.equal(v.monthlyPaidCents,6050);
  assert.equal(v.paidInvoiceCount,2);
  assert.equal(v.period,"2026-10");
});
