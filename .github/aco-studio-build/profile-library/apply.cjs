'use strict';
const fs=require('node:fs'),path=require('node:path');const root=path.resolve(process.argv[2]);
const files=['full-admin-access.js','native-admin-contracts.js','native-admin-ui.js','duplicate-notification-state.js','profile-vault.js','profile-library-core.js','profile-library-service.js','profile-library-ui.js','profile-library.css','customer-profile-source.js','profile-completion-core.js'];for(const file of files)fs.copyFileSync(path.join(__dirname,file),path.join(root,file));
for(const file of ['profile-library.test.js','profile-duplicate-scan.test.js','profile-bidirectional-sync.test.js','duplicate-notification-state.test.js','profile-live-ui.test.js','native-contracts.test.js','site-bridge-saved-data.test.js'])fs.copyFileSync(path.join(__dirname,file),path.join(root,'tests',file));
function replace(file,anchor,value){const p=path.join(root,file),s=fs.readFileSync(p,'utf8');if(s.split(anchor).length!==2)throw Error(file+': library integration anchor changed');fs.writeFileSync(p,s.replace(anchor,value));}
replace('profile-workshop-service.js','const service=createWorkshop(options);',"const service=createWorkshop(options);require('./profile-library-service').registerLibrary(options);");
replace('main.js','window.JigStudioLocalImport?.workspaceState)', 'window.JigStudioLocalImport?.workspaceState && document.getElementById("profileLibraryPage") && window.desktopAPI?.profileLibrary && document.querySelectorAll(".profileNavChild").length===2)');
replace('main.js','requireOwner:workshopOwner,authorize:',"getCustomerProfileSource:id=>siteBridge.profileSource(id),saveCustomerProfile:(id,remote,fields)=>siteBridge.saveCustomerProfile(id,remote,fields),getCustomerSavedData:id=>siteBridge.savedCustomerData(id),updateCustomerSavedData:(id,kind,recordId,payload)=>siteBridge.saveCustomerSavedData(id,kind,recordId,payload),changeCustomerAssignment:(id,remote,operation,payload)=>siteBridge.changeCustomerAssignment(id,remote,operation,payload),requireOwner:workshopOwner,authorize:");
replace('preload.js','profileWorkshop:Object.freeze({',"profileLibrary:Object.freeze(Object.fromEntries(['list','detail','importPreview','importCommit','repair','edit','exportFile','syncCustomer','previewLinkedJig','publishLinkedJig','websiteSnapshot','saveWebsiteAddress','saveWebsitePayment','manageWebsiteRecord','resolveSourceConflict','changeAssignment','linkLocal','removeLocal','rules','saveRules'].map(method=>[method,payload=>ipcRenderer.invoke('profile:library:'+method,payload)]).concat([['cancel',()=>ipcRenderer.invoke('profile:library:cancel')]]))),\n profileWorkshop:Object.freeze({");
replace('site-bridge.js',"const now=Date.now();if(now-lastEvent<750)return;lastEvent=now;","indexUntil=0;lastRosterAt=0;const now=Date.now();if(now-lastEvent<750)return;lastEvent=now;");
replace('site-bridge.js',"s.addEventListener('data-change',","s.addEventListener('open',()=>window.jigSignals?.changed());s.addEventListener('data-change',");
replace('site-bridge.js','async function read(kind,opts={}){','let lastRoster=null,lastRosterAt=0;\n async function read(kind,opts={}){');
replace('site-bridge.js',"return {customers,linkedInventoryComplete:complete,at:new Date().toISOString()};", "lastRoster=customers;lastRosterAt=Date.now();return {customers,linkedInventoryComplete:complete,at:new Date().toISOString()};");
replace('site-bridge.js','return {open,signIn,hide,reload,bounds,read,adminRead,adminAction,assign,returnToPool,jig,logout,isReady,getLinkedAccountEmails};',`async function profileSource(customerId){
  const key=id(customerId);const roster=lastRoster&&Date.now()-lastRosterAt<15000?lastRoster:(await read('roster',{})).customers;
  const member=roster.find(x=>x.id===key&&x.paid&&x.orderId);if(!member)throw Error('Choose a paid customer in the authenticated roster.');
  const [saved,linked]=await Promise.all([api('/api/admin/submissions/'+encodeURIComponent(id(member.orderId))+'/saved-details'),api('/api/admin/submissions/'+encodeURIComponent(id(member.orderId))+'/linked-memberships')]);
  const identities=await getLinkedAccountEmails();if(!identities.complete)throw Error('Linked account inventory is incomplete. Existing profiles were preserved.');
  const resolved={memberships:(Array.isArray(linked?.memberships)?linked.memberships:[]).flatMap(m=>identities.records.filter(x=>x.customerId===key&&x.id===String(m.id)).map(x=>({...m,assignmentRetailer:x.retailer,accountEmail:x.email,retailers:{[x.retailer]:{...(m.retailers?.[x.retailer]||m.retailers?.pkc||{}),username:x.email}}})))};
  return require('./customer-profile-source').sourceForCustomer(member,saved,resolved);
 }
 async function saveCustomerProfile(customerId,remote,change){
  const key=id(customerId),managedId=id(remote?.managedAccountId),kind=remote?.type;
  if(!['free','rented'].includes(kind))throw Error('Unknown customer assignment type.');
  if(!managedId||!key)throw Error('Missing verified customer assignment.');
  const roster=lastRoster&&Date.now()-lastRosterAt<15000?lastRoster:(await read('roster',{})).customers;
  const member=roster.find(x=>x.id===key&&x.paid&&x.orderId);
  if(!member)throw Error('Only an authorized paid customer can be edited.');
  const endpoint='/api/admin/submissions/'+encodeURIComponent(id(member.orderId))+'/linked-memberships';
  const readAssignment=async()=>{
   const result=await api(endpoint);
   const row=(Array.isArray(result.memberships)?result.memberships:[]).find(x=>String(x.id)===managedId&&x.type===kind&&x.active===true);
   if(!row)throw Error('This account is no longer linked to the selected website customer.');
   const profileEmail=String(row.retailers?.[remote.retailer==='pokemoncenter'?'pkc':remote.retailer]?.username||'').trim().toLowerCase();
   if(profileEmail&&String(change?.fields?.email||'').trim().toLowerCase()!==profileEmail)
    throw Error('Retailer login email changes require the managed account editor. No website or local profile was changed.');
   return row;
  };
  const previous=await readAssignment();
  if(remote.updatedAt&&String(previous.updatedAt||'')!==String(remote.updatedAt))
   throw Error('This website account changed since the last sync. Refresh the customer before saving to avoid overwriting another edit.');
  const f=change?.fields||{},str=v=>String(v??'').trim();
  const profile={
   profileName:str(f.label)||String(previous.customerProfile?.profileName||'Managed Profile'),
   firstName:str(f['shipping.first']||f.first),lastName:str(f['shipping.last']||f.last),
   email:String(previous.customerProfile?.email||member.email||''),
   phone:str(f['shipping.phone']||f.phone),address:str(f['shipping.address1']),
   address2:str(f['shipping.address2']),city:str(f['shipping.city']),state:str(f['shipping.state']),
   zip:str(f['shipping.zip']),country:str(f['shipping.country']||'US')
  };
  if(!profile.firstName||!profile.lastName||!profile.address||!profile.city||!profile.state||!profile.zip)
   throw Error('Complete customer shipping information before saving to the website.');
  const billing=f['billing.address1']?{
   profileName:String(previous.customerBillingProfile?.profileName||profile.profileName),
   firstName:str(f['billing.first']||f.first||profile.firstName),
   lastName:str(f['billing.last']||f.last||profile.lastName),
   email:String(previous.customerBillingProfile?.email||profile.email),
   phone:str(f['billing.phone']||f.phone||profile.phone),
   address:str(f['billing.address1']),address2:str(f['billing.address2']),
   city:str(f['billing.city']),state:str(f['billing.state']),
   zip:str(f['billing.zip']),country:str(f['billing.country']||profile.country||'US')
  }:null;
  if(billing&&(!billing.firstName||!billing.lastName||!billing.email||!billing.phone||!billing.city||!billing.state||!billing.zip))
   throw Error('Complete billing information before saving both addresses to the website.');
  const card=change?.card||{},customerCard=String(card.number||'').replace(/\D/g,'')?{
   cardLabel:String(previous.customerCard?.cardLabel||'Saved profile card'),
   cardholder:str(card.cardholder),acoCardNumber:String(card.number||'').replace(/\D/g,''),
   expMonth:str(card.month),expYear:str(card.year)
  }:undefined;
  const saved=await api('/api/admin/managed-memberships/'+kind+'/'+encodeURIComponent(managedId)+'/customer-details','PUT',{expectedUpdatedAt:remote.updatedAt||'',expectedCustomerAccountId:key,customerProfile:profile,...(billing?{customerBillingProfile:billing}:{}),...(customerCard?{customerCard}:{})});
  if(saved?.ok!==true)throw Error('Website did not confirm the profile update.');
  const verified=await readAssignment();
  if(String(verified.customerProfile?.address||'').trim()!==profile.address||
     String(verified.customerProfile?.city||'').trim()!==profile.city)
   throw Error('Website shipping confirmation failed; the local profile was not marked saved.');
  if(billing&&(String(verified.customerBillingProfile?.address||'').trim()!==billing.address||
      String(verified.customerBillingProfile?.city||'').trim()!==billing.city))
   throw Error('Website billing confirmation failed; the local profile was not marked saved.');
  indexUntil=0;lastRosterAt=0;notifyOwner();
  return {saved:true,updatedAt:String(verified.updatedAt||''),verifiedProfile:verified.customerProfile||null};
 }
 async function savedCustomerData(customerId){
  const key=id(customerId);
  const roster=lastRoster&&Date.now()-lastRosterAt<15000?lastRoster:(await read('roster',{})).customers;
  const member=roster.find(x=>x.id===key);
  if(!member)throw Error('Only an authorized customer account can be opened.');
  const result=await api('/api/admin/aco-studio/customers/'+encodeURIComponent(key)+'/saved-data');
  if(result?.customer?.id!==key)throw Error('Website customer ID mismatch. Data was discarded.');
  await enableLive();return result;
 }
 async function saveCustomerSavedData(customerId,kind,recordId,payload){
  const key=id(customerId),operation=payload?.operation||'update';
  const record=operation==='create'?'':id(recordId);
  if(!['create','update','delete'].includes(operation)||(!record&&operation!=='create')||!['address','payment'].includes(kind))throw Error('Choose an exact saved website record.');
  if(operation!=='create'&&(!payload?.expectedRevision||!/^[-a-f0-9]{64}$/i.test(payload.expectedRevision)))throw Error('Reopen the record before making a live change.');
  const roster=lastRoster&&Date.now()-lastRosterAt<15000?lastRoster:(await read('roster',{})).customers;
  const member=roster.find(x=>x.id===key);
  if(!member)throw Error('Customer is not in the authorized website roster.');
  const subpath=kind==='address'?'shipping-addresses':'payment-methods';
  const result=await api('/api/admin/aco-studio/customers/'+encodeURIComponent(key)+'/'+subpath+(operation==='create'?'':'/'+encodeURIComponent(record)),operation==='create'?'POST':operation==='delete'?'DELETE':'PUT',payload);
  if(result?.saved!==true)throw Error('Website refused the update. Nothing is marked synchronized.');
  indexUntil=0;lastRosterAt=0;notifyOwner();return result;
 }
 async function changeCustomerAssignment(customerId,remote,operation,payload={}){
  if(!['unlink','replace','reassign'].includes(operation)||!['free','rented'].includes(remote?.type))throw Error('Unsupported linked profile operation.');
  const key=id(customerId),snapshot=await profileSource(key),row=snapshot.linked.find(x=>x.managedAccountId===id(remote.id)&&x.retailer===remote.retailer&&x.active);
  if(!row||row.remoteUpdatedAt!==remote.updatedAt)throw Error('This customer assignment changed. Reopen it before proceeding.');
  const action=operation==='unlink'?'return-to-pool':'rtp-fill-spot';
  const endpoint=operation==='reassign'?'/api/admin/aco-studio/assignments/'+remote.type+'/'+encodeURIComponent(id(remote.id))+'/reassign':'/api/admin/linked-memberships/'+remote.type+'/'+encodeURIComponent(id(remote.id))+'/'+action;
  const result=await api(endpoint,'POST',{expectedCustomerAccountId:key,expectedUpdatedAt:remote.updatedAt,confirmed:true,...(operation==='replace'?{replacementManagedAccountId:id(payload.replacementId)}:{}),...(operation==='reassign'?{targetCustomerId:id(payload.targetCustomerId),durationType:payload.durationType}:{})});
  if(result?.ok!==true)throw Error('The website did not confirm the assignment change.');
  indexUntil=0;lastRosterAt=0;
  const verified=await profileSource(key);
  if(verified.linked.some(x=>x.managedAccountId===id(remote.id)&&x.active))throw Error('Website readback still shows the original assignment.');
  if(operation==='replace'&&!verified.linked.some(x=>x.managedAccountId===String(result.replacementManagedAccountId)&&x.retailer===remote.retailer&&x.active))throw Error('Replacement account verification failed.');
  if(operation==='reassign'){const receiver=await profileSource(id(payload.targetCustomerId));if(!receiver.linked.some(x=>x.managedAccountId===id(remote.id)&&x.active))throw Error('Receiving customer assignment readback failed.');}
  notifyOwner();return {saved:true,replacementManagedAccountId:result.replacementManagedAccountId||null,customerAccountId:result.customerAccountId||null};
 }
 return {open,signIn,hide,reload,bounds,read,adminRead,adminAction,assign,returnToPool,jig,logout,isReady,getLinkedAccountEmails,profileSource,saveCustomerProfile,savedCustomerData,saveCustomerSavedData,changeCustomerAssignment};`);
replace('tests/personal-profiles-security.test.js',"customerId:'customer1',retailer:'walmart',rows:","customerId:'customer1',retailer:'target',rows:");
replace('tests/personal-profiles-security.test.js',"customerId:'customer2',retailer:'pokemoncenter',data:","customerId:'customer2',retailer:'target',data:");
replace('tests/personal-profiles-security.test.js',"customerId:'u2',retailer:'walmart',email:'shared@sample.test'","customerId:'u2',retailer:'target',email:'shared@sample.test'");
replace('profile-bank-ui.js',"h.textContent=dup.email+' ('+dup.count+' matches)'","h.textContent=(retailerNames[dup.retailer]||dup.retailer)+' · '+dup.email+' ('+dup.count+' distinct accounts)'");
replace('profile-bank-ui.js',"' email(s) appear more than once. '","' retailer email(s) are reused within the same retailer. '");
replace('index.html','<script src="./profile-bank-ui.js"></script>','<script src="duplicate-notification-state.js"></script><script src="./profile-bank-ui.js"></script>');
replace('index.html','</body>','<link rel="stylesheet" href="profile-library.css"><script src="profile-library-ui.js"></script><script src="full-admin-access.js"></script>\n</body>');
const p=path.join(root,'package.json'),pkg=JSON.parse(fs.readFileSync(p,'utf8'));for(const file of files)if(!pkg.build.files.includes(file))pkg.build.files.push(file);fs.writeFileSync(p,JSON.stringify(pkg,null,2)+'\n');
console.log('Scoped customer/personal profile library, duplicate repairs and linked-customer preparation integrated.');
