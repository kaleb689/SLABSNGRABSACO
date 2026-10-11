import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const read=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");
const esc=value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
const money=value=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(Number(value)||0);
const rows=[
  {id:"source-order-one",checkoutAt:"2026-10-10T08:00:00.000Z",
    retailer:"Target",accountLabel:"Mike paid 1",accountKey:"paid:1",
    orderTotalKnown:true,orderTotal:62.51,
    items:[{name:"Booster Bundle",quantity:2,price:19.99},
      {name:"Elite Trainer Box",quantity:1,price:49.99}]},
  {id:"source-order-two",checkoutAt:"2026-10-10T08:00:00.000Z",
    retailer:"Target",accountLabel:"Mike paid 1",accountKey:"paid:1",
    orderTotalKnown:false,orderTotal:999.99,
    items:[{name:"Tin",quantity:2,price:9.99}]}
];
function extractFunction(source,begin,end){
  const start=source.indexOf(begin);
  const stop=source.indexOf(end,start);
  assert.ok(start>=0&&stop>start,begin+" function remains available");
  return source.slice(start,stop);
}
test("Mobile Admin keeps bundled items inside one actual checkout, does not price from item subtotals",()=>{
  const source=read("public/admin-mobile.js");
  const fn=extractFunction(source,"  function ordersMarkup(","  function accountsMarkup(");
  const markup=vm.runInNewContext(fn+"\nordersMarkup(rows)",{
    rows,esc,dollars:money,safeImage:()=>false,successOpenOrderCards:new Set(),
    Math,Number,Date,Intl,String,Array
  },{timeout:1000});
  assert.equal((markup.match(/class="success-order-card"/g)||[]).length,2);
  assert.match(markup,/Booster Bundle/);
  assert.match(markup,/Elite Trainer Box/);
  assert.match(markup,/Tin/);
  assert.match(markup,/62\.51/);
  assert.doesNotMatch(markup,/999\.99/);
  assert.match(markup,/Amount awaiting receipt verification/);
  assert.match(markup,/3 items/);
  assert.match(markup,/Mike paid 1/);
});
test("Full Admin groups actual orders and all line items without inventing purchase totals",()=>{
  const source=read("public/admin-success.html");
  const fn=extractFunction(source,"  function orderList(","  function renderCustomers(");
  const markup=vm.runInNewContext(fn+"\norderList(rows)",{
    rows,esc,money,validImage:()=>false,openOrders:new Set(),
    Math,Number,Date,Intl,String,Array
  },{timeout:1000});
  assert.equal((markup.match(/class="receipt-order"/g)||[]).length,2);
  assert.match(markup,/Booster Bundle/);
  assert.match(markup,/Elite Trainer Box/);
  assert.match(markup,/Tin/);
  assert.match(markup,/62\.51/);
  assert.doesNotMatch(markup,/999\.99/);
  assert.match(markup,/Awaiting verified paid total/);
  assert.match(markup,/3 items/);
});
test("Inactive period and shipping filters are neutral; only the selected option is filled",()=>{
  const css=read("public/sng-premium-controls.css");
  const mobile=read("public/admin-mobile.js");
  const customer=read("public/app-dashboard.js");
  const admin=read("public/admin-success.html");
  assert.match(css,/\.admin-spend-ranges button\[aria-pressed="false"\]/);
  assert.match(css,/\.sng-range button\[aria-pressed="false"\]/);
  assert.match(css,/\.sng-status-filters button\[aria-pressed="false"\]/);
  assert.match(css,/\.sng-status-filters button\[aria-pressed="true"\]/);
  assert.match(css,/\.periods button\[aria-pressed="false"\]/);
  assert.match(mobile,/aria-pressed="'\+\(String\(value\)===String\(days\)\)/);
  assert.match(customer,/s === status/);
  assert.match(admin,/value===days/);
});
test("Full-status-color outline wraps all sides of customer recent order and tracking cards",()=>{
  const css=read("public/sng-premium-controls.css");
  for(const stage of ["ordered","shipped","in_transit","out_for_delivery","delivered","review_hold","cancelled"]){
    assert.ok(css.includes(".sng-order-card.stage-"+stage+" {--sng-status-outline:"),
      "status outline "+stage);
  }
  assert.match(css,/\.sng-order-card \{\s*border:2px solid var\(--sng-status-outline/);
  const app=read("public/admin-app.html"),site=read("public/index.html");
  const admin=read("public/admin.html"),secure=read("public/admin-success.html");
  for(const file of [app,site,admin,secure]){
    assert.match(file,/sng-premium-controls\.css\?v=2/);
  }
  assert.match(app,/admin-mobile\.js\?v=38-customer-directory-count-and-load-20261010/);
});

test("Admin overview keeps membership KPIs visible and removes duplicate sections",()=>{
  const mobile=read("public/admin-mobile.js");
  for(const title of ["Latest website signups","Recent confirmed checkouts","Live updates"]){
    assert.ok(!mobile.includes(`collapsiblePanel("${title}"`),title+" is absent from Home");
  }
  assert.ok(mobile.includes(`collapsiblePanel("Quick actions"`));
  assert.match(mobile,/admin-app-users-metric/);
  assert.match(mobile,/ACTIVE PAID MEMBERSHIPS/);
  assert.match(mobile,/MONTHLY MEMBERSHIP PAYMENTS/);
  assert.match(mobile,/function collapsiblePanel\(title,body\)/);
});
