'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {query,mutation,safeResult,profilePayload,discountPayload}=require('../native-admin-contracts');
const appRoot=path.resolve(__dirname,'..');
const source=name=>fs.readFileSync(path.join(appRoot,name),'utf8');

test('native Admin read contracts allow website-admin routes, not arbitrary destinations',()=>{
 for(const view of ['dashboard','orders','memberships','operations','pool']){
  const routes=query(view,{status:'available',retailer:'target',page:2,query:'member'});
  assert.ok(routes.length);
  for(const route of routes){assert.ok(route.startsWith('/api/admin/')||route==='/api/public/membership-prices');assert.doesNotMatch(route,/\.\.|https?:|#/);}
 }
 assert.throws(()=>query('https://evil.com'),/Unknown/);
 const uri=query('pool',{status:'injected',retailer:'fake',page:-10000,query:'a'.repeat(300)})[0];
 const u=new URL(uri,'https://slabsngrabsaco.com');
 assert.equal(u.searchParams.get('status'),'all');
 assert.equal(u.searchParams.get('retailer'),'all');
 assert.equal(u.searchParams.get('page'),'1');
 assert.equal(u.searchParams.get('q').length,120);
});

test('Admin write actions reject unsupported paths and unsafe identifiers',()=>{
 assert.throws(()=>mutation('GET /api/secret',{}),/Unsupported/);
 assert.throws(()=>mutation('customer-og',{customerId:'../root'}),/Invalid/);
 assert.throws(()=>mutation('customer-missing-info',{orderId:'/' }),/Invalid/);
 assert.deepEqual(mutation('customer-missing-info',{orderId:'order_123'}),{
  path:'/api/admin/submissions/order_123/notify-missing-info',method:'POST',data:{}
 });
 assert.deepEqual(mutation('customer-og',{customerId:'cust_1'}),{
  path:'/api/admin/customers/cust_1/og-status',method:'PUT',data:{}
 });
 assert.deepEqual(mutation('customer-message',{orderId:'order_123',message:'Please update shipping details'}),{
  path:'/api/admin/submissions/order_123/message-customer',method:'POST',data:{message:'Please update shipping details'}
 });
 assert.throws(()=>mutation('customer-message',{orderId:'order_123',message:''}),/Enter/);
});

test('Admin action contracts match website routes for authenticated customer/profile, membership and broadcast mutations',()=>{
 assert.equal(mutation('customer-profile',{orderId:'a',profile:{firstName:'A',zip:'33324'}}).method,'PUT');
 assert.equal(mutation('gift-create',{customerId:'a',tier:6,quantity:1,unit:'weeks'}).data.durationUnit,'weeks');
 assert.match(mutation('gift-create',{customerId:'a',tier:5,quantity:1,unit:'months'}).data.requestId,/^[\da-f-]{36}$/);
 assert.equal(mutation('discount-toggle',{id:'id',active:false}).method,'PATCH');
 assert.equal(mutation('discount-delete',{id:'id'}).method,'DELETE');
 assert.equal(mutation('site-notification',{title:'Heads up',message:'SKU selection'}).path,'/api/admin/site-notification');
 assert.equal(mutation('account-mark-repaired',{id:'m'}).path,'/api/admin/managed-pool/m/mark-repaired');
 assert.throws(()=>profilePayload({zip:'ab123'}),/ZIP5/);
 assert.equal(profilePayload({zip:'33324-1212',state:'fl'}).profile.state,'FL');
 assert.throws(()=>discountPayload({code:'SAVE',tier:'999',discountType:'percent',percent:10}),/Invalid membership tier/);
});

test('server responses never expose payment secrets, nested card numbers, tokens or security codes',()=>{
 const result=safeResult({
  customer:{email:'owner@example.com',paymentMethods:[
   {number:'4111111111111111',maskedNumber:'4111111111111111',cardNumber:'5500000000000004',last4:'0004',cvv:'123',expiry:'10/29',appPassword:'secret1'}],
   nested:{billing:{accountNumber:'1234567890123456',securityCode:'999'},password:'password1',accessToken:'tok'}},
  rows:[{itemSubtotal:45.55,receiptNumber:'receipt-100'}],stripeSecretKey:'sk_secret'
 });
 assert.equal(result.customer.email,'owner@example.com');
 const card=result.customer.paymentMethods[0];
 assert.equal(card.number,'•••• 1111');
 assert.equal(card.maskedNumber,'•••• 1111');
 assert.equal(card.cardNumber,'•••• 0004');
 assert.equal(card.last4,'0004');
 assert.equal(card.cvv,undefined);
 assert.equal(card.appPassword,undefined);
 assert.equal(result.customer.nested.password,undefined);
 assert.equal(result.customer.nested.accessToken,undefined);
 assert.equal(result.customer.nested.billing.accountNumber,'•••• 3456');
 assert.equal(result.stripeSecretKey,undefined);
 assert.equal(result.rows[0].itemSubtotal,45.55);
 assert.equal(result.rows[0].receiptNumber,'receipt-100');
 assert.doesNotMatch(JSON.stringify(result),/4111111111111111|1234567890123456|sk_secret|secret1|password1/);
});

test('Electron IPC protects all Admin and local-owner operations before website bridge',()=>{
 const main=source('main.js');
 for(const handler of ['site:open','site:signIn','site:read','site:admin:read','site:admin:action','site:assign','site:return','site:jig','site:logout','site:notifications:load','site:notifications:save','site:makeTemplate','site:export']){
  const start=main.indexOf(`ipcMain.handle('${handler}'`);
  assert.ok(start>=0,'IPC handler registered: '+handler);
  assert.match(main.slice(start,start+160),/ownerSender\(/,'owner-only IPC: '+handler);
 }
 assert.match(source('site-bridge.js'),/credentials:'same-origin'/);
 assert.match(source('site-bridge.js'),/\/api\/admin\/live\/events/);
 assert.match(source('site-bridge.js'),/contextIsolation:true,nodeIntegration:false,sandbox:true/);
});

test('native UI contains all operational sections, preserves filters and avoids live draft replacement',()=>{
 const code=source('native-admin-ui.js');
 for(const panel of ['home','customers','orders','memberships','accounts','operations'])assert.match(code,new RegExp("\\['"+panel+"'"));
 assert.match(code,/renderedFingerprints\.get\(section\)===fingerprint/);
 assert.match(code,/dirtySections\.has\(section\)\|\|focusedEditor\(section\)/);
 assert.match(code,/id="acoPoolQuery"/);
 assert.match(code,/el\.value=savedFilters\[key\]/);
 assert.match(code,/el\.value=oldFilters\[key\]/);
 assert.match(code,/customer-missing-info/);
 assert.match(code,/customer-og/);
 assert.match(code,/customer-message/);
 assert.match(code,/Confirmed website actions/i);
 assert.match(code,/mergeSnapshot\(/);
 assert.match(code,/freshEmptyOverview/);
 assert.match(code,/centsAmount/);
 assert.doesNotMatch(code,/current_subscription_prices.*<\/b>/);
});

test('complete native app resources, icon and retained Full Website Admin fallback package correctly',()=>{
 const config=require('../package.json');
 const html=source('index.html');
 assert.match(html,/id="sitePage"/);
 assert.match(html,/Full Website Admin/);
 assert.match(html,/native-admin-ui\.js/);
 assert.match(html,/native-admin\.css/);
 assert.match(source('site-bridge.js'),/WebContentsView/);
 assert.match(source('main.js'),/app\.setName\('SLABSNGRABSACO ACO Studio - Owner'\)/);
 assert.equal(config.main,'main.js');
 assert.equal(config.build.appId,'com.slabsngrabsaco.jigstudio.owner');
 assert.equal(config.build.win.executableName,'JigStudio');
 assert.equal(config.build.mac.icon,'JigStudio.icns');
 assert.equal(config.build.nsis.shortcutName,'ACO Studio');
 assert.equal(config.build.productName,'ACO Studio');
 assert.match(source('desktop-native.js'),/ACOStudioIcon\.png/);
 assert.equal(fs.readFileSync(path.join(appRoot,'JigStudio.icns')).toString('ascii',0,4),'icns');
 for(const file of config.build.files){assert.ok(fs.existsSync(path.join(appRoot,file)),'packaged asset missing: '+file);}
 assert.ok(config.build.files.includes('native-touchid.js'));
 const touch=source('native-touchid.js');
 assert.match(touch,/ownerSecurity/);
 assert.match(touch,/touchId\(\)/);
 assert.match(source('preload.js'),/ownerSecurity:Object\.freeze/);
 assert.match(source('main.js'),/owner:touch-id/);
 assert.match(source('main.js'),/systemPreferences\.promptTouchID/);
 assert.match(source('main.js'),/unlockDesktopAdmin/);
 assert.match(source('site-bridge.js'),/desktop-device\/enroll/);
 assert.match(source('site-bridge.js'),/desktop-device\/unlock/);
 assert.match(source('site-bridge.js'),/safeStorage\.encryptString/);
 assert.match(source('site-bridge.js'),/safeStorage\.decryptString/);
 assert.match(source('native-touchid.js'),/aco:admin-session-ready/);
 assert.doesNotMatch(source('site-bridge.js'),/owner\.show\(\);owner\.focus\(\)/);
 assert.match(source('site-bridge.js'),/Replacement is still in the available/);
 assert.match(source('site-bridge.js'),/replacementId!==id\(payload\.replacementId\)/);
 assert.match(source('desktop-native.js'),/JigWebsiteCustomers/);
 assert.match(source('desktop-native.js'),/SITE ONLINE/);
 assert.deepEqual(config.build.extraResources,[{from:'../Branding/JigStudio.icns',to:'JigStudio.icns'}]);
 assert.ok(fs.existsSync(path.join(appRoot,'../Branding/JigStudio.icns')));
});

test('all eight website tier IDs are supported and obsolete profile-count IDs are rejected',()=>{for(let tier=1;tier<=8;tier++){assert.equal(mutation('gift-create',{customerId:'a',tier,quantity:1,unit:'months'}).data.tier,tier);assert.equal(discountPayload({code:'SAVE',tier,percent:10,discountType:'percent'}).tier,tier);}assert.throws(()=>mutation('gift-create',{customerId:'a',tier:50,quantity:1}),/valid tier/);});
