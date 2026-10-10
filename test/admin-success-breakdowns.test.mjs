import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source=readFileSync(new URL("../public/admin-mobile.js",import.meta.url),"utf8");

test("per-customer 24H / 7D / 30D filters work independently of global timeframe",async()=>{
  const hooks=[];
  const elements=new Map();
  function el(id){
    if(!elements.has(id)){
      const listeners=new Map();
      elements.set(id,{
        id,innerHTML:"",textContent:"",hidden:false,value:"",listeners,
        classList:{toggle(){}},
        addEventListener(name,fn){listeners.set(name,fn);},
        querySelectorAll(selector){
          const types={
            "[data-success-user-days]":{pattern:/data-success-user-days="([^"]+)" data-success-user-id="([^"]+)"/g,kind:"user"},
            "[data-success-days]":{pattern:/data-success-days="([^"]+)"/g,kind:"global"}
          };
          const type=types[selector];
          if(!type)return [];
          return [...this.innerHTML.matchAll(type.pattern)].map(match=>({
            dataset:type.kind==="user"?{successUserDays:match[1],successUserId:match[2]}:
              {successDays:match[1]},
            addEventListener(_name,fn){hooks.push({kind:type.kind,days:match[1],userId:match[2],fn});}
          }));
        },
        querySelector(){return null;}
      });
    }
    return elements.get(id);
  }
  const at=delta=>new Date(Date.now()-delta*86400000).toISOString();
  const records=[
    {retailer:"Target",checkoutAt:at(0),customerAccountId:"member-a",customerName:"Amy Example",
      orderTotalKnown:true,orderTotal:25,accountKey:"paid:target:1",accountLabel:"Target profile 1",accountKind:"paid",
      items:[{name:"Today's Target tin",quantity:2}]},
    {retailer:"PKC",checkoutAt:at(3),customerAccountId:"member-a",customerName:"Amy Example",
      orderTotalKnown:false,orderTotal:0,accountKey:"managed:pkc-2",accountLabel:"Linked PKC 2",accountKind:"linked",
      items:[{name:"Pokémon Center booster box",quantity:1}]},
    {retailer:"PKC",checkoutAt:at(10),customerAccountId:"member-a",customerName:"Amy Example",
      orderTotalKnown:true,orderTotal:45,accountKey:"managed:pkc-2",accountLabel:"Linked PKC 2",accountKind:"linked",
      items:[{name:"Pokémon Center ETB",quantity:1}]},
    {retailer:"PKC",checkoutAt:at(0),customerAccountId:null,customerName:"Unmatched checkout",
      orderTotalKnown:false,orderTotal:0,items:[{name:"DO NOT ATTACH UNMATCHED BOOSTER",quantity:5}]},
    {retailer:"Target",checkoutAt:at(2),customerAccountId:"member-b",customerName:"Ben Example",
      orderTotalKnown:false,orderTotal:0,accountKey:"managed:target-3",accountLabel:"Target 3",accountKind:"linked",
      items:[{name:"Unpriced but confirmed Target box",quantity:1}]}
  ];
  const fixtures={
    "/api/admin/submissions":{submissions:[]},
    "/api/admin/profile-activation-tracker":{customers:[]},
    "/api/managed-availability":{},
    "/api/admin/app-usage":{},
    "/api/admin/success-overview":{
      records,communityTotals:{totalCheckouts:244,totalSpent:20000},
      historicalSummary:{historicalCheckouts:240,historicalSpent:15876.11},
      unmatchedRecent:{total:10,last24h:2,last7d:5,last30d:10,
        byRetailer:[{retailer:"PKC",total:9,last24h:1,last7d:4,last30d:9},
          {retailer:"Target",total:1,last24h:1,last7d:1,last30d:1}]},
      sourceCheckedAt:new Date().toISOString()
    }
  };
  const document={hidden:false,activeElement:null,getElementById:el,
    querySelectorAll(){return [];},addEventListener(){}};
  const sandbox={document,window:{scrollX:0,scrollY:0,scrollTo(){},addEventListener(){}},
    navigator:{},location:{assign(){}},Date,Intl,Map,Set,Math,Number,String,Array,
    fetch:async path=>({status:200,ok:true,json:async()=>fixtures[path]||{}}),
    EventSource:class{addEventListener(){}close(){}},
    setTimeout(){return 1;},clearTimeout(){},setInterval(){return 2;},
    requestAnimationFrame(fn){fn();},console,alert(){}};
  vm.runInNewContext(source,sandbox,{filename:"admin-mobile.js"});
  for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
  const tab=el("tabs").listeners.get("click");
  tab({target:{closest:()=>({dataset:{tab:"success"}})}});
  for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
  const html=()=>el("content").innerHTML;
  const userCount=()=>Number(html().match(/class="success-user-stats"><div><small>Confirmed orders<\/small><strong>(\d+)<\/strong>/)?.[1]);
  const mainCount=()=>Number(html().match(/<strong>Confirmed orders<\/small><strong>(\d+)<\/strong>/)?.[1])||null;
  const press=(kind,days)=>{
    const h=hooks.filter(item=>item.kind===kind&&item.days===String(days)&&
      (kind!=="user"||item.userId==="member-a")).at(-1);
    assert.ok(h,"select a real "+kind+" period control "+days);
    h.fn();
  };
  assert.equal(userCount(),3);
  assert.match(html(),/Amy Example checkout breakdown/);
  assert.match(html(),/Ben Example checkout breakdown/);
  assert.match(html(),/Ben Example checkout breakdown[\s\S]*?<small>Verified spent<\/small><strong>\$0\.00<\/strong>/);
  assert.doesNotMatch(html(),/<strong>Pending<\/strong>/);
  assert.match(html(),/Pokémon Center booster box/);
  assert.match(html(),/Pokémon Center ETB/);
  assert.match(html(),/Pokémon Center:<\/strong> 9 unassigned confirmed checkouts/);
  assert.match(html(),/REVIEW POKÉMON CENTER HITS/);
  assert.match(html(),/Target:<\/strong> 1 unassigned confirmed checkout/);
  assert.match(html(),/REVIEW TARGET HITS/);
  assert.match(html(),/REVIEW ALL UNMATCHED HITS/);
  assert.doesNotMatch(html(),/DO NOT ATTACH UNMATCHED BOOSTER/);
  // Changing the top graph does not erase earlier linked Pokémon Center hits
  // from the separately selected customer reporting period.
  press("global",1);
  assert.equal(userCount(),3);
  assert.match(html(),/1 confirmed order/);
  press("user",7);
  assert.equal(userCount(),2);
  assert.match(html(),/Pokémon Center booster box/);
  press("user",1);
  assert.equal(userCount(),1);
  press("user",30);
  assert.equal(userCount(),3);
  assert.match(html(),/data-success-panel="products"/);
  assert.match(html(),/data-success-panel="customers"/);
  assert.match(html(),/success-user-accordion/);
  // MTD affects the selected graph and can be selected separately per user.
  press("global","mtd");
  assert.match(html(),/TOTAL VERIFIED SPENT · MONTH TO DATE/);
  assert.match(html(),/data-success-days="mtd" aria-pressed="true"/);
  press("user","mtd");
  assert.match(html(),/Month to date/);
  assert.match(html(),/data-success-user-days="mtd" data-success-user-id="member-a" aria-pressed="true"/);
});

test("month-to-date begins at local midnight on day one and stops at month/year rollovers",()=>{
  const start=source.indexOf("function successPeriodStart(");
  const end=source.indexOf("\nlet customerSearchText=",start);
  assert.ok(start>0&&end>start);
  const script=source.slice(start,end);
  const context={Date,value:null};
  vm.runInNewContext(script+'\nvalue = successPeriodStart("mtd",new Date(2026,9,12,22,15));',context);
  assert.equal(context.value,new Date(2026,9,1).getTime());
  vm.runInNewContext(script+'\nvalue = successPeriodStart("mtd",new Date(2026,10,1,0,1));',context);
  assert.equal(context.value,new Date(2026,10,1).getTime());
  vm.runInNewContext(script+'\nvalue = successPeriodStart("ytd",new Date(2026,10,1));',context);
  assert.equal(context.value,new Date(2026,0,1).getTime());
});
