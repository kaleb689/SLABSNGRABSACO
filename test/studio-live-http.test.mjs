import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {authenticator} from 'otplib';
test('real authenticated HTTP: customer and Studio edit the same saved address/card, stale writes fail, restart preserves data',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aco-http-sync-')),port=41000+Math.floor(Math.random()*2000),base=`http://127.0.0.1:${port}`,secret=authenticator.generateSecret();
 const env={...process.env,DATA_DIR:dir,PORT:String(port),BASE_URL:base,RESEND_API_KEY:'',STRIPE_SECRET_KEY:'sk_test_missing',CUSTOMER_SESSION_SECRET:'synthetic-only-session-secret-123456789',SUBMISSION_ENCRYPTION_KEY:'synthetic-only-encryption-123456789',ADMIN_PASSWORD:'synthetic-admin-password',ADMIN_2FA_SECRET:secret};
 let server;const start=async()=>{server=spawn(process.execPath,['server.js'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:'ignore'});for(let i=0;i<90;i++){try{await fetch(base);return;}catch{await new Promise(r=>setTimeout(r,100));}}throw Error('Server failed to start');};
 const stop=async()=>{if(server&&server.exitCode===null){server.kill();await new Promise(r=>server.once('exit',r));}};
 t.after(async()=>{await stop();await fs.rm(dir,{recursive:true,force:true});});
 const call=async(route,{method='GET',body,cookie=''}={})=>{const res=await fetch(base+route,{method,headers:{Origin:base,Cookie:cookie,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:res.status,body:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};};
 await start();
 const customer=await call('/api/account/register',{method:'POST',body:{email:'aco-http@example.test',password:'synthetic-password-123',age18Confirmed:true}});assert.equal(customer.status,201);
 const accounts=JSON.parse(await fs.readFile(path.join(dir,'customer-accounts.json'),'utf8')),id=accounts[0].id;
 const admin=await call('/api/admin/login',{method:'POST',body:{password:'synthetic-admin-password',code:authenticator.generate(secret)}});assert.equal(admin.status,200);
 const prefix='/api/admin/aco-studio/customers/'+id;
 assert.equal((await call(prefix+'/saved-data')).status,401);
 const address={label:'Home',firstName:'Alex',lastName:'Example',address:'100 Example Street',address2:'',city:'Davie',state:'FL',zip:'33324',country:'US'};
 const created=await call('/api/account/shipping-addresses',{method:'POST',cookie:customer.cookie,body:address});assert.equal(created.status,200);
 let snapshot=(await call(prefix+'/saved-data',{cookie:admin.cookie})).body;assert.equal(snapshot.addresses[0].address,address.address);const addressId=snapshot.addresses[0].id;
 const stale=snapshot.addresses[0].revision;
 let result=await call(prefix+'/shipping-addresses/'+addressId,{method:'PUT',cookie:admin.cookie,body:{expectedRevision:stale,address:{...address,address:'200 Studio Lane'}}});assert.equal(result.status,200);
 let consumer=(await call('/api/account/saved-details',{cookie:customer.cookie})).body;assert.equal(consumer.addresses[0].address,'200 Studio Lane');
 result=await call(prefix+'/shipping-addresses/'+addressId,{method:'PUT',cookie:admin.cookie,body:{expectedRevision:stale,address:{...address,address:'STALE'}}});assert.equal(result.status,409);
 result=await call('/api/account/shipping-addresses/'+addressId,{method:'PUT',cookie:customer.cookie,body:{...address,address:'300 Website Avenue',expectedRevision:result.status===409?(await call(prefix+'/saved-data',{cookie:admin.cookie})).body.addresses[0].revision:''}});assert.equal(result.status,200);
 snapshot=(await call(prefix+'/saved-data',{cookie:admin.cookie})).body;assert.equal(snapshot.addresses[0].address,'300 Website Avenue');
 const payment=await call('/api/account/payment-methods',{method:'POST',cookie:customer.cookie,body:{cardLabel:'Test Visa',cardholder:'Alex Example',acoCardNumber:'4242424242424242',expMonth:'08',expYear:'2032',authorizeRequestedPurchases:true}});assert.equal(payment.status,200);
 snapshot=(await call(prefix+'/saved-data',{cookie:admin.cookie})).body;const card=snapshot.paymentMethods[0];assert.equal(card.last4,'4242');assert.ok(!JSON.stringify(card).includes('4242424242424242'));
 result=await call(prefix+'/payment-methods/'+card.id,{method:'PUT',cookie:admin.cookie,body:{expectedRevision:card.revision,payment:{cardholder:'Updated Holder',expMonth:'09',expYear:'2033'}}});assert.equal(result.status,200);
 consumer=(await call('/api/account/saved-details',{cookie:customer.cookie})).body;assert.equal(consumer.paymentMethods[0].cardholder,'Updated Holder');assert.equal(consumer.paymentMethods[0].expYear,'2033');
 // Two editors sharing one revision: exactly one commit, one explicit conflict.
 const shared=snapshot.addresses[0];
 const raced=await Promise.all([
  call(prefix+'/shipping-addresses/'+addressId,{method:'PUT',cookie:admin.cookie,body:{expectedRevision:shared.revision,address:{...address,address:'400 First Writer Street'}}}),
  call('/api/account/shipping-addresses/'+addressId,{method:'PUT',cookie:customer.cookie,body:{...address,address:'500 Second Writer Street',expectedRevision:shared.revision}})
 ]);assert.deepEqual(raced.map(x=>x.status).sort(),[200,409]);
 const raceSaved=(await call(prefix+'/saved-data',{cookie:admin.cookie})).body.addresses[0];
 assert.ok(['400 First Writer Street','500 Second Writer Street'].includes(raceSaved.address));
 // Restore through the same revision-checked production route for restart proof.
 assert.equal((await call(prefix+'/shipping-addresses/'+addressId,{method:'PUT',cookie:admin.cookie,body:{expectedRevision:raceSaved.revision,address:{...address,address:'300 Website Avenue'}}})).status,200);
 // The website/mobile and Studio profile editors share one retailer assignment.
 const initialVersion='2026-10-01T00:00:00.000Z',assignmentId='synthetic-assignment',managedId='synthetic-target-account';
 await fs.writeFile(path.join(dir,'managed-accounts.json'),JSON.stringify([{id:managedId,accountEmail:'retailer@example.test',retailer:'target',profileName:'Synthetic retailer account'}]));
 await fs.writeFile(path.join(dir,'free-assignments.json'),JSON.stringify([{id:assignmentId,managedAccountId:managedId,freeMembershipId:managedId,customerAccountId:id,assignmentRetailer:'target',active:true,activationStatus:'activated',durationType:'indefinite',updatedAt:initialVersion,customerProfile:{...address,email:'aco-http@example.test',phone:'9545550123',profileName:'Synthetic profile'}}]));
 const managedRoute='/api/account/managed-memberships/free/'+assignmentId,adminManaged='/api/admin/managed-memberships/free/'+managedId+'/customer-details';
 let managed=await call(managedRoute,{method:'PUT',cookie:customer.cookie,body:{expectedUpdatedAt:initialVersion,customerProfile:{...address,address:'700 Website Profile Street',email:'aco-http@example.test',phone:'9545550123'}}});assert.equal(managed.status,200);
 let storedAssignment=JSON.parse(await fs.readFile(path.join(dir,'free-assignments.json'),'utf8'))[0];assert.equal(storedAssignment.customerProfile.address,'700 Website Profile Street');
 const websiteVersion=managed.body.updatedAt;
 managed=await call(adminManaged,{method:'PUT',cookie:admin.cookie,body:{expectedCustomerAccountId:id,expectedUpdatedAt:websiteVersion,customerProfile:{...address,address:'800 Studio Profile Street',email:'aco-http@example.test',phone:'9545550123'}}});assert.equal(managed.status,200);
 const customerProfiles=await call('/api/account/free-memberships',{cookie:customer.cookie});assert.equal(customerProfiles.status,200);assert.equal(customerProfiles.body.memberships[0].customerProfile.address,'800 Studio Profile Street');assert.equal(customerProfiles.body.memberships[0].updatedAt,managed.body.updatedAt);
 assert.equal((await call(managedRoute,{method:'PUT',cookie:customer.cookie,body:{expectedUpdatedAt:websiteVersion,customerProfile:{address:'STALE PROFILE'}}})).status,409);
 const abort=new AbortController();t.after(()=>abort.abort());
 const stream=await fetch(base+'/api/account/live/events',{headers:{Cookie:customer.cookie},signal:abort.signal});assert.equal(stream.status,200);
 const reader=stream.body.getReader(),decoder=new TextDecoder();await reader.read();
 let live='';const nextEvent=(async()=>{while(!live.includes('event: data-change')){const {done,value}=await reader.read();if(done)break;live+=decoder.decode(value);}})();
 const studioCreated=await call(prefix+'/shipping-addresses',{method:'POST',cookie:admin.cookie,body:{confirmed:true,address:{...address,address:'600 Created In Studio Street'}}});assert.equal(studioCreated.status,200);
 await Promise.race([nextEvent,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('No live customer update arrived')),4000);timer.unref();})]);
 assert.match(live,/event: data-change/);assert.ok(!live.includes('600 Created In Studio Street'));assert.ok(!live.includes('4242424242424242'));abort.abort();
 const temporary=studioCreated.body.address;
 assert.ok((await call('/api/account/saved-details',{cookie:customer.cookie})).body.addresses.some(x=>x.id===temporary.id));
 assert.equal((await call(prefix+'/shipping-addresses/'+temporary.id,{method:'DELETE',cookie:admin.cookie,body:{confirmed:true,expectedRevision:'stale'}})).status,409);
 assert.equal((await call(prefix+'/shipping-addresses/'+temporary.id,{method:'DELETE',cookie:admin.cookie,body:{confirmed:true,expectedRevision:temporary.revision}})).status,200);
 assert.ok(!(await call('/api/account/saved-details',{cookie:customer.cookie})).body.addresses.some(x=>x.id===temporary.id));
 const studioCard=await call(prefix+'/payment-methods',{method:'POST',cookie:admin.cookie,body:{confirmed:true,payment:{cardLabel:'Temporary',cardholder:'Example Holder',acoCardNumber:'4242424242424242',expMonth:'10',expYear:'2034',cvv:'123'}}});assert.equal(studioCard.status,200);
 const temporaryCard=studioCard.body.paymentMethod;assert.ok(!JSON.stringify(temporaryCard).includes('123'));assert.ok((await call('/api/account/saved-details',{cookie:customer.cookie})).body.paymentMethods.some(x=>x.id===temporaryCard.id));
 assert.equal((await call(prefix+'/payment-methods/'+temporaryCard.id,{method:'DELETE',cookie:admin.cookie,body:{confirmed:true,expectedRevision:temporaryCard.revision}})).status,200);
 assert.ok(!(await call('/api/account/saved-details',{cookie:customer.cookie})).body.paymentMethods.some(x=>x.id===temporaryCard.id));
 await stop();await start();const relogin=await call('/api/admin/login',{method:'POST',body:{password:'synthetic-admin-password',code:authenticator.generate(secret)}});assert.equal(relogin.status,200);
 snapshot=(await call(prefix+'/saved-data',{cookie:relogin.cookie})).body;assert.equal(snapshot.addresses[0].address,'300 Website Avenue');assert.equal(snapshot.paymentMethods[0].cardholder,'Updated Holder');
});
