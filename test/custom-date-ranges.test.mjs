import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {customDateBounds,periodBounds,selectedOrders,dashboardTotals,dashboardActivity} from '../public/app-dashboard-data.js';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const customer=read('public/app-dashboard.js');
const admin=read('public/admin-mobile.js');
const fullAdmin=read('public/admin-success.html');
const fullAdminScript=read('public/admin-success.js');
const customerPage=read('public/index.html');
const adminPage=read('public/admin-app.html');
const css=read('public/custom-date-controls.css');

test('custom date ranges include both local calendar endpoints and exclude adjacent days',()=>{
  const now=new Date(2026,9,11,12);
  const range={from:'2026-10-01',to:'2026-10-05'};
  const bounds=customDateBounds(range);
  assert.equal(bounds.start,new Date(2026,9,1).getTime());
  assert.equal(bounds.end,new Date(2026,9,6).getTime());
  assert.equal(periodBounds('custom',now,range).end,bounds.end);
  const order=(day,amount,status='confirmed')=>({
    checkoutAt:day.toISOString(),status,itemCount:1,orderTotal:amount,orderTotalKnown:true
  });
  const records=[
    order(new Date(2026,8,30,23,59,59),800),
    order(new Date(2026,9,1,0,0,0),15),
    order(new Date(2026,9,5,23,59,59,999),25),
    order(new Date(2026,9,6,0,0,0),120),
    order(new Date(2026,9,3,12),99,'review_hold')
  ];
  const selected=selectedOrders(records,'custom',now,range);
  assert.equal(selected.length,2);
  assert.equal(dashboardTotals(selected).spend,40);
  const bars=dashboardActivity(selected,'custom',now,range);
  assert.equal(bars.reduce((sum,b)=>sum+b.count,0),2);
  assert.equal(Math.round(bars.reduce((sum,b)=>sum+b.value,0)*100),4000);
  assert.ok(bars.length<=24);
});

test('date validation rejects nonexistent, reversed and missing dates',()=>{
  assert.equal(customDateBounds({from:'2026-02-30',to:'2026-03-01'}),null);
  assert.equal(customDateBounds({from:'2026-10-06',to:'2026-10-05'}),null);
  assert.equal(customDateBounds({from:'2026-10-01',to:''}),null);
  assert.notEqual(customDateBounds({from:'2024-02-29',to:'2024-02-29'}),null);
  assert.deepEqual(selectedOrders([], 'custom',new Date(),null),[]);
  assert.deepEqual(dashboardActivity([], 'custom',new Date(),null),[]);
});

test('Admin mobile date window uses local dates and clamps current day to now',()=>{
  const start=admin.indexOf('function mobileDayKey(');
  const end=admin.indexOf('let customerSearchText=',start);
  assert.ok(start>0&&end>start);
  const source=admin.slice(start,end)+
    '\ncomparison = mobileCustomWindow({from:"2026-10-01",to:"2026-10-05"},new Date(2026,9,11,12));'+
    '\ninvalid = mobileCustomWindow({from:"2026-11-01",to:"2026-11-10"},new Date(2026,9,11,12));';
  const sandbox={Date,comparison:null,invalid:null};
  vm.runInNewContext(source,sandbox,{timeout:1500});
  assert.equal(sandbox.comparison.start,new Date(2026,9,1).getTime());
  assert.equal(sandbox.comparison.end,new Date(2026,9,6).getTime());
  assert.equal(sandbox.invalid,null);
});

test('full Admin date picker uses inclusive local dates and its CSP-safe external script parses',()=>{
  assert.doesNotThrow(()=>new vm.Script(fullAdminScript));
  const begin=fullAdminScript.indexOf('  function selectedWindow(');
  const end=fullAdminScript.indexOf('  function visibleRows(',begin);
  assert.ok(begin>=0&&end>begin,'calendar helper remains in external Admin Success script');
  const sandbox={
    Date,period:'custom',comparison:null,
    $:id=>({value:id==='dateFrom'?'2026-10-01':'2026-10-05'})
  };
  vm.runInNewContext(fullAdminScript.slice(begin,end)+
    '\ncomparison=selectedWindow(new Date(2026,9,11,12));',
    sandbox,{timeout:1500});
  assert.equal(sandbox.comparison.start,new Date(2026,9,1).getTime());
  assert.equal(sandbox.comparison.end,new Date(2026,9,5,23,59,59,999).getTime());
});

test('MTD and 6M are removed from visible period presets; custom calendar is available everywhere',()=>{
  assert.match(customer,/const presets=\[1,7,30,90,'ytd','all'\]/);
  assert.doesNotMatch(customer,/n === 180 \? '6M'|data-app-days="180"/);
  assert.match(customer,/data-app-calendar/);
  assert.match(customer,/data-app-date-form/);
  assert.match(customer,/type="date"/);
  assert.match(customer,/days='custom'/);
  assert.match(customer,/checkoutRequestRange\(days, new Date\(\), customRange\)/);
  assert.match(admin,/data-success-calendar/);
  assert.match(admin,/data-success-user-calendar/);
  assert.match(admin,/data-success-date-form/);
  assert.match(admin,/data-success-user-date-form/);
  assert.match(admin,/successDays="custom"/);
  for(const marker of ['id="customDates"','id="dateFrom"','id="dateTo"','id="applyCustom"'])
    assert.ok(fullAdmin.includes(marker),'Admin Success calendar control '+marker);
  assert.ok(fullAdminScript.includes('period === "custom"'));
  assert.doesNotMatch(fullAdmin,/\['mtd','MTD'\]/);
  assert.doesNotMatch(admin,/\["mtd","MTD"\]/);
  assert.match(customerPage,/custom-date-controls\.css\?v=20261010/);
  assert.match(adminPage,/custom-date-controls\.css\?v=20261010/);
  assert.match(fullAdmin,/custom-date-controls\.css\?v=20261010/);
  assert.match(css,/\.sng-date-fields input\[type="date"\]/);
  assert.match(css,/@media\(max-width:370px\)/);
});
