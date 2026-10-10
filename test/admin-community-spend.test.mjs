import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { verifiedRetailerOrderTotal } from "../retailer-order-total.js";

const file = p => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const app = file("public/admin-mobile.js");
const backend = file("server.js");

test("all confirmed community checkouts are exposed to Admin without checkout identifiers or implied ownership", () => {
  const start = backend.indexOf('app.get("/api/admin/success-overview"');
  const end = backend.indexOf('app.get("/api/admin/checkout-paid-verification"', start);
  const route = backend.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(route, /const communityRecords = confirmed\.map\(record =>/);
  assert.match(route, /linked: Boolean\(record\.customerAccountId/);
  assert.match(route, /communityRecords,unmatchedCount/);
  assert.match(route, /sum \+ \(checkoutPaidAmount\(record\) \?\? 0\)/);
  const onlyGlobal = route.slice(route.indexOf("const communityRecords ="), route.indexOf('res.setHeader("Cache-Control"', route.indexOf("const communityRecords =")));
  assert.doesNotMatch(onlyGlobal, /orderNumber:\s*|sourceProfileLabel:\s*|password:\s*|managedAccountId:\s*|customerAccountId:\s*/);
  assert.match(onlyGlobal, /orderTotalKnown: safe\.orderTotalKnown/);
  assert.match(onlyGlobal, /items: safe\.items\.map/);
});

test("hidden product display filters must never subtract item subtotals from verified paid receipts", () => {
  const start=backend.indexOf("function visibleDiscordSuccessRecords(");
  const end=backend.indexOf("async function discordCheckoutOwners(",start);
  const filtered=backend.slice(start,end);
  assert.match(filtered, /A presentation-only product exclusion must NEVER subtract/);
  const part=filtered.slice(filtered.indexOf("const removedItems ="),filtered.indexOf(".filter(Boolean)"));
  assert.doesNotMatch(part, /const removedValue|orderTotal\s*=\s*removedValue|orderTotal\s*:\s*Math\.max/);
  assert.match(part,/return \{\s*\.\.\.record,\s*items,/);
});

test("Admin Success shows all webhook orders, verified paid spending, and keeps customer ownership isolated", async () => {
  const elements=new Map();
  const filters={};
  function el(id){
    if(!elements.has(id)){
      const listeners=new Map();
      elements.set(id,{
        id,hidden:false,innerHTML:"",textContent:"",value:"",listeners,
        classList:{toggle(){}},
        addEventListener(name,cb){listeners.set(name,cb);},
        querySelectorAll(){return [];},
        querySelector(selector){
          if(selector==="#success-customer-filter"||selector==="#success-account-filter"){
            return {addEventListener(name,cb){filters[selector]=cb;}};
          }
          return null;
        }
      });
    }
    return elements.get(id);
  }
  const recent=new Date().toISOString();
  const alice={retailer:"Target",checkoutAt:recent,orderTotal:17.25,orderTotalKnown:true,
    customerAccountId:"alice",customerName:"Alice Example",accountKey:"paid:target:1",
    accountLabel:"Alice Target 1",accountKind:"paid",items:[{name:"Alice product",quantity:1,imageUrl:""}]};
  const ben={retailer:"PKC",checkoutAt:recent,orderTotal:0,orderTotalKnown:false,
    customerAccountId:"ben",customerName:"Ben Example",accountKey:"linked:pkc:1",
    accountLabel:"Linked PKC 1",accountKind:"linked",items:[{name:"Ben product",quantity:1,imageUrl:""}]};
  const unmatched={retailer:"Walmart",checkoutAt:recent,orderTotal:64.12,orderTotalKnown:true,
    linked:false,items:[{name:"Community unmatched-only-product",quantity:2,imageUrl:""}]};
  const api={
    "/api/admin/submissions":{submissions:[]},
    "/api/admin/profile-activation-tracker":{customers:[]},
    "/api/managed-availability":{},
    "/api/admin/app-usage":{},
    "/api/admin/success-overview":{
      records:[alice,ben],
      communityRecords:[{retailer:alice.retailer,checkoutAt:recent,orderTotal:17.25,
        orderTotalKnown:true,linked:true,items:alice.items},
        {retailer:ben.retailer,checkoutAt:recent,orderTotal:0,orderTotalKnown:false,
          linked:true,items:ben.items},unmatched],
      communityTotals:{totalCheckouts:243,totalSpent:15957.48,pricePendingCheckouts:1},
      historicalSummary:{historicalCheckouts:240,historicalSpent:15876.11},
      unmatchedRecent:{total:1,last24h:1,last7d:1,last30d:1,byRetailer:[]},
      sourceCheckedAt:recent
    }
  };
  const document={hidden:false,activeElement:null,getElementById:el,
    querySelectorAll(){return [];},addEventListener(){}};
  const sandbox={document,window:{scrollX:0,scrollY:0,scrollTo(){},addEventListener(){}},
    navigator:{},location:{assign(){}},Date,Intl,Map,Set,Math,Number,String,Array,
    fetch:async path=>({status:200,ok:true,json:async()=>api[path]||{}}),
    EventSource:class{addEventListener(){}close(){}},setTimeout(){return 1;},
    clearTimeout(){},setInterval(){return 2;},requestAnimationFrame(cb){cb();},
    console,alert(){}};
  vm.runInNewContext(app,sandbox,{filename:"admin-mobile.js"});
  for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
  el("tabs").listeners.get("click")({target:{closest:()=>({dataset:{tab:"success"}})}});
  for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
  const html=()=>el("content").innerHTML;
  assert.match(html(),/TOTAL VERIFIED SPENT · LAST 30 DAYS · ALL CONFIRMED ORDERS/);
  assert.match(html(),/\$81\.37/);
  assert.match(html(),/3 confirmed orders/);
  assert.match(html(),/Community unmatched-only-product/);
  assert.match(html(),/All confirmed checkouts · linked & unmatched/);
  assert.match(html(),/All linked customer checkouts/);
  assert.match(html(),/Unmatched confirmed checkouts/);
  assert.match(html(),/Alice Example checkout breakdown/);
  assert.match(html(),/Ben Example checkout breakdown/);
  assert.match(html(),/data-success-panel="customers" ><summary>/);
  assert.doesNotMatch(html(),/password:|orderNumber:|customerAccountId:alice/);
  filters["#success-customer-filter"]({target:{value:"linked"}});
  assert.match(html(),/LINKED CUSTOMER ORDERS/);
  assert.match(html(),/\$17\.25/);
  assert.match(html(),/2 confirmed orders/);
  assert.doesNotMatch(html(),/Community unmatched-only-product/);
  filters["#success-customer-filter"]({target:{value:"unmatched"}});
  assert.match(html(),/UNMATCHED CONFIRMED ORDERS/);
  assert.match(html(),/\$64\.12/);
  assert.match(html(),/1 confirmed order/);
  assert.match(html(),/Community unmatched-only-product/);
  assert.doesNotMatch(html(),/class="panel success-user-panel/);
  filters["#success-customer-filter"]({target:{value:"alice"}});
  assert.match(html(),/SELECTED CUSTOMER/);
  assert.match(html(),/\$17\.25/);
  assert.match(html(),/Alice Example checkout breakdown/);
  assert.doesNotMatch(html(),/Community unmatched-only-product/);
});

test("new full Admin Success page provides all-checkout time filters, safe user breakdowns and auto refresh", () => {
  const page=file("public/admin-success.html");
  assert.match(page,/\/api\/admin\/success-overview/);
  assert.match(page,/All confirmed checkouts · linked &amp; unmatched/);
  assert.match(page,/Unmatched community checkouts/);
  assert.match(page,/Customer Breakdowns/);
  assert.match(page,/Products Purchased/);
  assert.match(page,/Verify prices/);
  assert.match(page,/Historical reported spent/);
  assert.match(page,/credentials:'same-origin'/);
  assert.match(page,/cache:'no-store'/);
  assert.match(page,/setInterval\(\(\)=>\{if\(!document\.hidden\)void refresh\(\);\},15000\)/);
  assert.match(page,/communityRecords/);
  assert.match(page,/totalCents/);
  const script=page.match(/<script>([\s\S]+?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(()=>new vm.Script(script));
  const fullAdmin=file("public/admin.html");
  const mobileHome=file("public/admin-mobile.js");
  assert.match(fullAdmin,/href="\/admin-success\.html"/);
  assert.match(mobileHome,/href="\/admin-success\.html"/);
});

test("trusted retailer receipt total parser supports realistic Target, Walmart and PKC layouts without inventing amounts",()=>{
  assert.equal(verifiedRetailerOrderTotal("Total charged to card: $19.49"),19.49);
  assert.equal(verifiedRetailerOrderTotal("Order Total: US$52.10"),52.1);
  assert.equal(verifiedRetailerOrderTotal("Order Total (USD): USD 83.15"),83.15);
  assert.equal(verifiedRetailerOrderTotal("","<p>Final order total</p><b>&#x24; 62.04</b>"),62.04);
  assert.equal(verifiedRetailerOrderTotal("Subtotal: $36.45\nTax: $1.73"),null);
  assert.equal(verifiedRetailerOrderTotal("Total due: $36.45"),null);
  assert.equal(verifiedRetailerOrderTotal("Paid total: $36.45\nTotal charged: $37.99"),null);
});

test("premium responsive controls load LAST across full Admin, installed Admin, customer desktop and app",()=>{
  const premium=file("public/sng-premium-controls.css");
  assert.match(premium,/body\.admin-page #dashboard button/);
  assert.match(premium,/#workspace \.admin-spend-ranges button/);
  assert.match(premium,/\.app-dashboard \.sng-range button/);
  assert.match(premium,/body\.admin-page #dashboard select/);
  assert.match(premium,/grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(premium,/data-admin-mobile-theme="light"/);
  assert.match(premium,/data-admin-theme="light"/);
  assert.match(premium,/data-app-theme="day"/);
  assert.match(file("public/admin-app.html"),/admin-mobile-controls\.css\?v=1"><link rel="stylesheet" href="\/sng-premium-controls\.css\?v=2"/);
  assert.match(file("public/index.html"),/\/sng-premium-controls\.css\?v=2/);
  assert.match(file("public/admin.html"),/\/sng-premium-controls\.css\?v=2/);
});
