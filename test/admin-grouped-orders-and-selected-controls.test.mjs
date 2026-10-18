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
  const verifiedAmount=row=>row.orderTotalKnown===true&&Number(row.orderTotal)>0?Number(row.orderTotal):0;
  const amount=row=>row.checkoutValueKnown===true?Number(row.checkoutValue):verifiedAmount(row);
  const hasCheckoutValue=row=>amount(row)>0;
  const markup=vm.runInNewContext(fn+"\nordersMarkup(rows)",{
    rows,esc,dollars:money,safeImage:()=>false,successOpenOrderCards:new Set(),
    amount,verifiedAmount,hasCheckoutValue,
    Math,Number,Date,Intl,String,Array
  },{timeout:1000});
  assert.equal((markup.match(/class="success-order-card"/g)||[]).length,2);
  assert.match(markup,/Booster Bundle/);
  assert.match(markup,/Elite Trainer Box/);
  assert.match(markup,/Tin/);
  assert.match(markup,/62\.51/);
  assert.doesNotMatch(markup,/999\.99/);
  assert.match(markup,/Order value unavailable from checkout source/);
  assert.match(markup,/3 items/);
  assert.match(markup,/Mike paid 1/);
});
test("Full Admin Success groups checkouts per customer and does not invent purchase totals",()=>{
  const source=read("public/admin-success.js");
  const customers=extractFunction(source,"  function renderCustomers(","  function render(");
  const products=extractFunction(source,"  function renderProducts(","  function renderCustomers(");
  const nodes={customers:{innerHTML:""},products:{innerHTML:""}};
  const linked=rows.map(row=>({...row,customerAccountId:"example-member",customerName:"Example Member"}));
  const total=row=>row.orderTotalKnown===true?Number(row.orderTotal)||0:0;
  const quantity=row=>row.items.reduce((sum,item)=>sum+item.quantity,0);
  vm.runInNewContext(customers+"\n"+products+"\nrenderCustomers(rows); renderProducts(rows);",{
    rows:linked,$:id=>nodes[id],esc,money,paid:total,checkoutValue:total,hasValue:row=>total(row)>0,quantity,
    recordDate:row=>Date.parse(row.checkoutAt)||0,
    Map,Math,Number,Date,Intl,String,Array
  },{timeout:1000});
  assert.match(nodes.customers.innerHTML,/Example Member/);
  assert.match(nodes.customers.innerHTML,/2 orders/);
  assert.ok(nodes.customers.innerHTML.includes("62.51"));
  assert.ok(!nodes.customers.innerHTML.includes("999.99"));
  assert.match(nodes.customers.innerHTML,/value unavailable/);
  for(const name of ["Booster Bundle","Elite Trainer Box","Tin"])
    assert.ok(nodes.products.innerHTML.includes(name),name);
});
test("Inactive period and shipping filters are neutral; only the selected option is filled",()=>{
  const css=read("public/sng-premium-controls.css");
  const mobile=read("public/admin-mobile.js");
  const customer=read("public/app-dashboard.js");
  const admin=read("public/admin-success.js");
  assert.match(css,/\.admin-spend-ranges button\[aria-pressed="false"\]/);
  assert.match(css,/\.sng-range button\[aria-pressed="false"\]/);
  assert.match(css,/\.sng-status-filters button\[aria-pressed="false"\]/);
  assert.match(css,/\.sng-status-filters button\[aria-pressed="true"\]/);
  assert.match(css,/\.periods button\[aria-pressed="false"\]/);
  assert.match(mobile,/aria-pressed="'\+\(String\(value\)===String\(days\)\)/);
  assert.match(customer,/s === status/);
  assert.ok(admin.includes('button.dataset.period === String(period)'));
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
  assert.ok(app.includes("/admin-mobile.js?v=20261018-cross-retailer-products-1"));
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
