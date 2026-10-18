import test from 'node:test';
import assert from 'node:assert/strict';
import { registerStudioCustomerRoutes } from '../server-studio-customer-sync.js';

function harness(){
 const routes=new Map(),events=[],writes=[];
 const app={post:(route,auth,...handlers)=>routes.set('POST '+route,{auth,fn:handlers.at(-1)}),delete:(route,auth,...handlers)=>routes.set('DELETE '+route,{auth,fn:handlers.at(-1)}),get:(route,auth,fn)=>routes.set('GET '+route,{auth,fn}),put:(route,auth,...handlers)=>routes.set('PUT '+route,{auth,fn:handlers.at(-1)})};
 const auth=()=>{};
 const account={id:'customer-a',email:'customer@example.test',firstName:'Alex',lastName:'Example',updatedAt:'2026-10-18T00:00:00Z',
  shippingAddresses:[{id:'address-1',label:'Home',firstName:'Alex',lastName:'Example',address:'12 Main St',address2:'',city:'Sample',state:'FL',zip:'33324',country:'US'}]};
 const vault={paymentMethods:[{id:'card-1',cardLabel:'Visa',cardholder:'Alex Example',acoCardNumber:'4242424242424242',expMonth:'08',expYear:'2032',securityCode:'stored-old-secret',createdAt:'2026-01-01'}]};
 registerStudioCustomerRoutes({app,requireAdmin:auth,getCustomerAccounts:async()=>[account],
  saveCustomerAccounts:async()=>writes.push('account'),getCustomerVault:async()=>vault,
  saveCustomerVault:async()=>writes.push('vault'),
  customerSavedAddresses:a=>a.shippingAddresses,
  sanitizeShippingAddress:(x,id)=>({...x,id}),validShippingAddress:x=>['label','firstName','lastName','address','city','state','zip','country'].every(k=>x[k]),
  sanitizeSavedPaymentMethod:(x,prior)=>({...prior,cardLabel:x.cardLabel||prior.cardLabel,cardholder:x.cardholder||prior.cardholder,
    acoCardNumber:x.acoCardNumber||prior.acoCardNumber,expMonth:x.expMonth||prior.expMonth,expYear:x.expYear||prior.expYear}),
  validSavedPaymentMethod:x=>/^\d{12,19}$/.test(x.acoCardNumber)&&!!x.cardholder,
  revisionSecret:'test-key-not-an-actual-secret',
  broadcastLiveDataChange:e=>events.push(e)});
 const invoke=async(method,route,params={},body={})=>{
  const saved=routes.get(method+' '+route);assert.ok(saved);assert.equal(saved.auth,auth);
  const res={statusCode:200,headers:{},set(k,v){this.headers[k]=v;return this;},status(v){this.statusCode=v;return this;},json(v){this.body=v;return this;}};
  await saved.fn({params,body},res);return res;
 };
 const snapshot=id=>invoke('GET','/api/admin/aco-studio/customers/:id/saved-data',{id});
 return {invoke,snapshot,account,vault,events,writes};
}
test('Desktop snapshot matches website vault yet never returns PAN/security code',async()=>{
 const h=harness(),r=await h.snapshot('customer-a');
 assert.equal(r.statusCode,200);assert.equal(r.headers['Cache-Control'],'no-store');
 assert.equal(r.body.addresses[0].address,'12 Main St');
 assert.equal(r.body.paymentMethods[0].last4,'4242');
 assert.ok(r.body.paymentMethods[0].revision);
 const json=JSON.stringify(r.body);
 assert.ok(!json.includes('4242424242424242'));
 assert.ok(!json.includes('stored-old-secret'));
});
test('Website address edit is revision-guarded, preserves identity and sends realtime event',async()=>{
 const h=harness(),current=(await h.snapshot('customer-a')).body.addresses[0];
 const r=await h.invoke('PUT','/api/admin/aco-studio/customers/:id/shipping-addresses/:addressId',{id:'customer-a',addressId:'address-1'},
 {expectedRevision:current.revision,address:{...current,address:'99 New Lane'}});
 assert.equal(r.statusCode,200);assert.equal(h.account.shippingAddresses[0].address,'99 New Lane');
 assert.equal(h.account.shippingAddresses[0].id,'address-1');
 assert.equal(h.events[0],'customer-shipping-updated');
 const stale=await h.invoke('PUT','/api/admin/aco-studio/customers/:id/shipping-addresses/:addressId',{id:'customer-a',addressId:'address-1'},
 {expectedRevision:current.revision,address:{...current,address:'8 Stale Road'}});
 assert.equal(stale.statusCode,409);assert.equal(h.account.shippingAddresses[0].address,'99 New Lane');
});
test('Website payment edit preserves PAN and removes legacy verification codes',async()=>{
 const h=harness(),current=(await h.snapshot('customer-a')).body.paymentMethods[0];
 const r=await h.invoke('PUT','/api/admin/aco-studio/customers/:id/payment-methods/:paymentId',{id:'customer-a',paymentId:'card-1'},
 {expectedRevision:current.revision,payment:{cardLabel:'Main Visa',cardholder:'Alex Updated',expMonth:'09',expYear:'2033',securityCode:'do-not-save'}});
 assert.equal(r.statusCode,200);assert.equal(h.vault.paymentMethods[0].acoCardNumber,'4242424242424242');
 assert.equal(h.vault.paymentMethods[0].securityCode,undefined);
 assert.equal(h.vault.paymentMethods[0].cardholder,'Alex Updated');
 assert.ok(!JSON.stringify(r.body).includes('4242424242424242'));
 assert.equal(h.events[0],'customer-payment-updated');
 const old=await h.invoke('PUT','/api/admin/aco-studio/customers/:id/payment-methods/:paymentId',{id:'customer-a',paymentId:'card-1'},
 {expectedRevision:current.revision,payment:{cardholder:'Old'}});
 assert.equal(old.statusCode,409);
});
test('Missing or mismatched customer record never changes any vault',async()=>{
 const h=harness(),r=await h.snapshot('customer-b');assert.equal(r.statusCode,404);
 const denied=await h.invoke('PUT','/api/admin/aco-studio/customers/:id/shipping-addresses/:addressId',
 {id:'customer-b',addressId:'address-1'},{expectedRevision:'incorrect'});
 assert.equal(denied.statusCode,404);assert.equal(h.writes.length,0);
 const precondition=await h.invoke('PUT','/api/admin/aco-studio/customers/:id/payment-methods/:paymentId',
 {id:'customer-a',paymentId:'card-1'},{payment:{cardholder:'Cannot update'}});
 assert.equal(precondition.statusCode,428);assert.equal(h.writes.length,0);
});
