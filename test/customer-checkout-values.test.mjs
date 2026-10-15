import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {checkoutOrderValue, checkoutPaidAmount} from '../checkout-price-policy.js';
import {checkoutAssignmentContains, recoverCheckoutAssignmentOwners} from '../discord-checkout-owner-evidence.js';
import {checkoutRequestRange, selectedOrders, dashboardTotals, dashboardActivity} from '../public/app-dashboard-data.js';
import {reconcileWebhookCheckout, uniqueCheckoutOwner} from '../webhook-success.js';

const server = fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const now = new Date('2026-10-15T20:00:00.000Z');
const base = {retailer:'Target',status:'confirmed',customerAccountId:'mike',checkoutAt:'2026-10-15T19:00:00Z',itemCount:2,
  items:[{name:'Trading card preorder',quantity:2,price:39.99}],orderTotal:79.98,orderTotalBasis:'item_subtotal'};

test('preorders use confirmed value immediately without claiming a verified charge',()=>{
  assert.equal(checkoutPaidAmount(base),null);
  assert.deepEqual(checkoutOrderValue(base),{amount:79.98,basis:'item_subtotal'});
  assert.deepEqual(checkoutOrderValue({...base,orderTotal:85.58,orderTotalBasis:'retailer_receipt'}),{amount:85.58,basis:'order_total'});
  assert.equal(checkoutOrderValue({...base,orderTotal:0,orderTotalBasis:'unknown'}).amount,79.98);
  assert.equal(checkoutOrderValue({...base,orderTotal:0,orderTotalBasis:'unknown',items:[{price:39.99,quantity:0}]}).amount,null);
});

function customerHandler(records) {
  let handler;
  const context = {console, Date, URLSearchParams,
    app:{get:(_route,_guard,fn)=>{handler=fn;}},requireCustomer:()=>{},
    discordSuccessConfig:()=>({token:''}),discordCheckoutSourceChannels:async()=>({channels:['source']}),
    getSuccessCheckouts:async()=>records,visibleDiscordSuccessRecords:rows=>rows,
    clean:(value,n)=>String(value||'').slice(0,n),
    confirmedDiscordPurchase:r=>r.status==='confirmed'&&!r.cancelledAt,
    customerCheckoutPurchase:r=>!/cancel|refund|failed|declined/i.test(r.status||'')&&!r.cancelledAt,
    reviewHoldDiscordCheckout:r=>r.status==='review_hold'&&!r.cancelledAt,
    safeSuccessCheckout:r=>{const value=checkoutOrderValue(r),paid=checkoutPaidAmount(r);return {...r,checkoutValue:value.amount??0,checkoutValueKnown:value.amount!==null,orderTotal:paid??0,orderTotalKnown:paid!==null};},
    successDateKey:at=>new Date(at).toISOString().slice(0,10),buildSuccessActivity:()=>[]};
  vm.createContext(context);
  const summary=server.indexOf('function buildSuccessSummary(');
  vm.runInContext(server.slice(summary,server.indexOf('/* -------------------------------------------------------',summary)),context);
  const route=server.indexOf('app.get(\n  "/api/account/success",');
  vm.runInContext(server.slice(route,server.indexOf('/* -------------------------------------------------------',route)),context);
  return async(query,account='mike')=>{let code=200,payload;await handler({query,customerAccount:{id:account}},
    {setHeader(){},status(n){code=n;return this;},json(value){payload=value;return value;}});return {code,payload};};
}

test('real customer handler includes preorders, removes cancels, isolates owners and agrees with app totals',async()=>{
  const rows=[{...base,id:'preorder'}, {...base,id:'charged',orderTotal:75.56,orderTotalBasis:'retailer_receipt'},
    {...base,id:'cancelled',status:'cancelled',cancelledAt:'2026-10-15T19:10:00Z'},
    {...base,id:'other-customer',customerAccountId:'other'}, {...base,id:'review',status:'review_hold'}];
  const {code,payload}=await customerHandler(rows)({appView:'1',...checkoutRequestRange(1,now)});
  assert.equal(code,200);assert.equal(payload.totalCheckouts,3);assert.equal(payload.checkoutValue,235.52);
  assert.equal(payload.cancelledCheckouts.length,0);assert.equal(payload.checkouts.find(r=>r.id==='preorder').verifiedPaidTotal,null);
  assert.equal(payload.checkouts.find(r=>r.id==='preorder').orderTotal,79.98); // running older apps also update
  const selected=selectedOrders(payload.checkouts,1,now);
  assert.equal(dashboardTotals(selected).spend,235.52);
  assert.equal(Math.round(dashboardActivity(selected,1,now).reduce((n,b)=>n+b.value,0)*100),23552);
  assert.equal(rows.length,5); // cancellations remain in the private audit
});

test('API and app share exact rolling boundaries, inclusive custom dates and lifetime history',async()=>{
  const rows=[{...base,id:'inside',checkoutAt:'2026-10-14T20:00:00Z'},
    {...base,id:'too-old',checkoutAt:'2026-10-14T19:59:59.999Z'},
    {...base,id:'historic',checkoutAt:'2024-01-01T12:00:00Z'},
    {...base,id:'future',checkoutAt:'2026-10-16T00:00:00Z'}];
  const run=customerHandler(rows);
  const rolling=await run({appView:'1',...checkoutRequestRange(1,now)});
  assert.deepEqual(Array.from(rolling.payload.checkouts,r=>r.id),['inside']);
  const lifetime=await run({appView:'1',...checkoutRequestRange('all',now)});
  assert.equal(lifetime.code,200);assert.equal(lifetime.payload.checkouts.length,3);
  const range={from:'2026-10-14',to:'2026-10-14'};
  const custom=await run({appView:'1',...checkoutRequestRange('custom',now,range)});
  assert.equal(custom.code,200);assert.equal(custom.payload.checkouts.length,2);
  assert.equal((await run({appView:'1',start:'2026-10-14',end:'2026-10-15',startAt:'invalid',endAt:now.toISOString()})).code,400);
});

test('link ownership starts before later activation and does not cross account reassignment',()=>{
  const first={id:'old',managedAccountId:'pool-1',customerAccountId:'mike',createdAt:'2026-10-14T12:00:00Z',startsAt:'2026-10-15T19:30:00Z',endedAt:'2026-10-15T19:45:00Z'};
  assert.equal(checkoutAssignmentContains(first,base.checkoutAt),true);
  assert.equal(checkoutAssignmentContains(first,'2026-10-14T11:59:59Z'),false);
  assert.equal(checkoutAssignmentContains(first,'2026-10-15T19:46:00Z'),false);
  const cleared={...first,customerAccountId:null};
  const holds=[{customerAccountId:'mike',items:[{previousAssignmentId:'old',managedAccountId:'pool-1',retailer:'target',heldAt:first.endedAt}]}];
  const restored=recoverCheckoutAssignmentOwners([cleared],holds)[0];
  assert.equal(restored.customerAccountId,'mike');assert.equal(cleared.customerAccountId,null);
  assert.equal(recoverCheckoutAssignmentOwners([cleared],[{...holds[0],items:[{...holds[0].items[0],managedAccountId:'wrong-pool'}]}])[0].customerAccountId,null);
  assert.equal(uniqueCheckoutOwner([{customerAccountId:'mike'},{customerAccountId:'other'}]),null);
  const stored=[{...base,id:'discord:1532179373292257290:1580000000000002001'}];
  reconcileWebhookCheckout(stored,stored[0],{customerAccountId:'other'});
  assert.equal(stored[0].customerAccountId,'mike');
});

test('a checkout event during an in-flight Success fetch queues a fresh read instead of losing the update',async()=>{
  const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const start=source.indexOf('async function loadSuccessDashboard('),end=source.indexOf('/* =====================================================',start);
  let resolveFirst, requests=0;
  const pending=new Promise(resolve=>{resolveFirst=resolve;});
  const context={SUCCESS_DEMO_MODE:false,ADMIN_PREVIEW_MODE:false,successState:{},
    URLSearchParams,window:{location:{search:''}},
    getSuccessRange:()=>({start:'2026-10-14',end:'2026-10-15'}),
    fetch:async()=>{requests++;if(requests===1)await pending;return {ok:true,status:200};},
    readJson:async()=>({range:{start:'2026-10-14',end:'2026-10-15'}}),
    renderSuccessLoading(){},renderSuccessDashboard(){},renderSuccessError:message=>assert.fail(message),queueMicrotask,console};
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  const first=context.loadSuccessDashboard(true);
  await context.loadSuccessDashboard(true);
  assert.equal(requests,1);resolveFirst();await first;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests,2);assert.equal(context.successState.loading,false);
});
