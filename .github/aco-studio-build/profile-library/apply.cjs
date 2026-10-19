'use strict';
const fs=require('node:fs'),path=require('node:path');const root=path.resolve(process.argv[2]);
const files=['full-admin-access.js','native-admin-contracts.js','native-admin-ui.js','native-touchid.js','duplicate-notification-state.js','profile-vault.js','profile-library-core.js','profile-library-service.js','profile-library-ui.js','profile-library.css','customer-profile-source.js','profile-completion-core.js'];for(const file of files)fs.copyFileSync(path.join(__dirname,file),path.join(root,file));
for(const file of ['profile-library.test.js','profile-duplicate-scan.test.js','profile-bidirectional-sync.test.js','duplicate-notification-state.test.js','profile-live-ui.test.js','native-contracts.test.js','site-bridge-saved-data.test.js'])fs.copyFileSync(path.join(__dirname,file),path.join(root,'tests',file));
function replace(file,anchor,value){const p=path.join(root,file),s=fs.readFileSync(p,'utf8');if(s.split(anchor).length!==2)throw Error(file+': library integration anchor changed');fs.writeFileSync(p,s.replace(anchor,value));}
replace('profile-workshop-service.js','const service=createWorkshop(options);',"const service=createWorkshop(options);require('./profile-library-service').registerLibrary(options);");
{
 const p=path.join(root,'tests','profile-workshop.test.js'),s=fs.readFileSync(p,'utf8');
 const marker="test('Draft manual editing preserves assigned card values'";
 const start=s.indexOf(marker),end=start<0?-1:s.indexOf("\ntest(",start+marker.length);
 if(start<0)throw Error('profile-workshop.test.js: cardholder regression test not found');
 const stop=end<0?s.length:end,block=s.slice(start,stop),old='Saved Holder';
 if(block.split(old).length!==2)throw Error('profile-workshop.test.js: expected one legacy cardholder value');
 fs.writeFileSync(p,s.slice(0,start)+block.replace(old,'Original Person')+s.slice(stop));
}
replace('main.js','window.JigStudioLocalImport?.workspaceState)', 'window.JigStudioLocalImport?.workspaceState && document.getElementById("profileLibraryPage") && window.desktopAPI?.profileLibrary && document.querySelectorAll(".profileNavChild").length===2)');
replace('main.js',"ipcMain.handle('site:open'",`ipcMain.handle('owner:touch-id',async event=>{ownerSender(event);if(process.platform!=='darwin')return {available:false,verified:false,reason:'unsupported'};const {systemPreferences}=require('electron');if(!systemPreferences.canPromptTouchID())return {available:false,verified:false,reason:'unavailable'};const state=siteBridge.desktopUnlockState();if(!state?.enrolled)return {available:true,verified:false,session:false,needsEnrollment:true,reason:'Sign in once with the Admin password and authenticator to enable Touch ID on this Mac.'};try{await siteBridge.prepareDesktopUnlock();await systemPreferences.promptTouchID('Unlock ACO Studio');const session=await siteBridge.unlockDesktopAdmin();if(session?.ok===true){try{await siteBridge.read('roster',{});}catch{return {available:true,verified:true,session:false,reason:'Touch ID succeeded, but the Admin session could not be verified.'};}}return {available:true,verified:true,session:session?.ok===true,needsEnrollment:session?.needsEnrollment===true,reason:session?.reason||''};}catch(error){return {available:true,verified:false,session:false,reason:String(error?.message||error||'Touch ID was not completed.')};}});\nipcMain.handle('site:open'`);
replace('main.js',` async function signInAndVerifyAdmin(){
  if(process.argv.includes('--aco-studio-ci-smoke'))return;
  // Restore an authenticated existing website session without an extra login.
  if(siteBridge.isReady()){try{await siteBridge.read('roster',{});return;}catch{}}
  siteBridge.signIn();
  // The full-app updater should consider a healthy *secure login screen*
  // a successful relaunch. Waiting for an Admin account to authenticate
  // would incorrectly trigger the native installer's automatic rollback.
  if(process.platform==='darwin')
   void require('./mac-full-updates').markHealthy(app).catch(()=>{});
  for(;;){
   if(!siteBridge.isReady()){await new Promise(r=>setTimeout(r,1200));continue;}
   try{await siteBridge.read('roster',{});return;}
   catch{await new Promise(r=>setTimeout(r,1500));}
  }
 }`,` async function tryStartupTouchId(){
  if(process.platform!=='darwin'||!systemPreferences.canPromptTouchID())return false;
  const state=siteBridge.desktopUnlockState();
  if(!state?.enrolled)return false;
  try{
   await siteBridge.prepareDesktopUnlock();
   void require('./mac-full-updates').markHealthy(app).catch(()=>{});
   await systemPreferences.promptTouchID('Unlock ACO Studio');
   const unlocked=await siteBridge.unlockDesktopAdmin();
   if(unlocked?.ok!==true)return false;
   await siteBridge.read('roster',{});
   return true;
  }catch(error){
   console.error('Native Touch ID startup unlock:',String(error?.message||error));
   return false;
  }
 }
 async function signInAndVerifyAdmin({allowTouchId=true}={}){
  if(process.argv.includes('--aco-studio-ci-smoke'))return;
  if(siteBridge.isReady()){try{await siteBridge.read('roster',{});return;}catch{}}
  if(allowTouchId&&await tryStartupTouchId())return;
  siteBridge.signIn();
  if(process.platform==='darwin')
   void require('./mac-full-updates').markHealthy(app).catch(()=>{});
  for(;;){
   if(!siteBridge.isReady()){await new Promise(r=>setTimeout(r,1200));continue;}
   try{
    await siteBridge.read('roster',{});
    if(process.platform==='darwin'){try{await siteBridge.enrollDesktopDevice();}catch(error){console.error('Desktop Touch ID enrollment:',String(error?.message||error));}}
    return;
   }catch{await new Promise(r=>setTimeout(r,1500));}
  }
 }`);
replace('main.js',"void signInAndVerifyAdmin().then(async()=>{\n   const current=ownerWindow;","void signInAndVerifyAdmin({allowTouchId:false}).then(async()=>{\n   const current=ownerWindow;");
replace('main.js','requireOwner:workshopOwner,authorize:',"getCustomerProfileSource:id=>siteBridge.profileSource(id),saveCustomerProfile:(id,remote,fields)=>siteBridge.saveCustomerProfile(id,remote,fields),getCustomerSavedData:id=>siteBridge.savedCustomerData(id),updateCustomerSavedData:(id,kind,recordId,payload)=>siteBridge.saveCustomerSavedData(id,kind,recordId,payload),changeCustomerAssignment:(id,remote,operation,payload)=>siteBridge.changeCustomerAssignment(id,remote,operation,payload),requireOwner:workshopOwner,authorize:");
replace('preload.js','site:Object.freeze({',"ownerSecurity:Object.freeze({touchId:()=>ipcRenderer.invoke('owner:touch-id')}),\n site:Object.freeze({");
replace('preload.js','profileWorkshop:Object.freeze({',"profileLibrary:Object.freeze(Object.fromEntries(['list','detail','importPreview','importCommit','repair','edit','exportFile','syncCustomer','previewLinkedJig','publishLinkedJig','batchJigPreview','batchJigCommit','websiteSnapshot','saveWebsiteAddress','saveWebsitePayment','manageWebsiteRecord','resolveSourceConflict','changeAssignment','linkLocal','removeLocal','rules','saveRules'].map(method=>[method,payload=>ipcRenderer.invoke('profile:library:'+method,payload)]).concat([['cancel',()=>ipcRenderer.invoke('profile:library:cancel')]]))),\n profileWorkshop:Object.freeze({manageResource:payload=>ipcRenderer.invoke('profile:workshop:manageResource',payload),");

// Extend the existing OS-encrypted card/address vaults with in-place edits that
// preserve resource IDs already referenced by saved profiles.
replace('local-card-vault.js',"  async addWorkshopCard(rawKey,data,beforeWrite){const k=customerKey(rawKey),fields=validateCard(data);return schedule(async()=>{",`  async updateWorkshopCard(rawKey,cardId,data,beforeWrite){const k=customerKey(rawKey),id=text(cardId),fields=validateCard(data);return schedule(async()=>{
   const d=await read(),e=entry(d,k),card=e.cards.find(x=>x.id===id);if(!card)throw Error('Saved card is no longer in this vault.');
   if(e.cards.some(x=>x.id!==id&&x.number===fields.number))throw Error('This card is already saved in this vault.');
   Object.assign(card,fields,{id:card.id,createdAt:card.createdAt,updatedAt:now()});e.updatedAt=now();d.customers[k]=e;beforeWrite();await write(d);return summary(card);
  });},
  async addWorkshopCard(rawKey,data,beforeWrite){const k=customerKey(rawKey),fields=validateCard(data);return schedule(async()=>{`);
replace('jig-address-banks.js',"  async addWorkshopAddress(scope,customerId,input,beforeWrite){",`  async updateWorkshopAddress(scope,customerId,addressId,input,beforeWrite){
   if(scope!=='personal'&&scope!=='aco'||scope==='personal'&&customerId)throw Error('Invalid address vault.');
   const id=scope==='aco'?memberKey(customerId):null,normalized=normalizeAddress(input),key=asString(addressId);
   return exclusive(async()=>{
    const file=scope==='personal'?personalFile:acoFile,d=await read(file,scope==='personal'?{addresses:[],updatedAt:null}:{customers:{}});
    const e=scope==='personal'?d:(d.customers[id]||{addresses:[],updatedAt:null}),index=e.addresses.findIndex(x=>x.id===key);
    if(index<0)throw Error('Saved address is no longer in this vault.');
    const current=e.addresses[index];if(current.source==='website')throw Error('This address comes from the customer website. Edit that saved website address from the customer profile instead.');
    if(e.addresses.some((x,i)=>i!==index&&addressKey(x)===addressKey(normalized)))throw Error('This address already exists in this vault.');
    e.addresses[index]={...current,...normalized,id:current.id,source:current.source,createdAt:current.createdAt,uses:current.uses||0};e.updatedAt=now();if(scope==='aco')d.customers[id]=e;
    beforeWrite();await write(file,d);return structuredClone(e.addresses[index]);
   });
  },
  async addWorkshopAddress(scope,customerId,input,beforeWrite){`);

replace('site-bridge.js',"adminView.webContents.loadURL(ORIGIN+'/admin.html').catch(()=>notifyOwner());","adminView.webContents.loadURL(ORIGIN+'/admin.html?acoDesktop=1').catch(()=>notifyOwner());");
replace('site-bridge.js',"adminWindow.loadURL(ORIGIN+'/admin.html');","adminWindow.loadURL(ORIGIN+'/admin.html?acoDesktop=1');");
replace('site-bridge.js'," function signIn(){",` async function prepareDesktopUnlock(){
  if(typeof BrowserWindow!=='function')throw Error('Secure Admin sign-in window is not supported here.');
  if(adminWindow&&!adminWindow.isDestroyed()){
   if(adminWindow.webContents.isLoadingMainFrame())await new Promise(resolve=>adminWindow.webContents.once('did-finish-load',resolve));
   return true;
  }
  adminWindow=new BrowserWindow({width:1180,height:880,minWidth:760,minHeight:580,show:false,title:'SLABSNGRABSACO • Secure Admin Sign-In',
   webPreferences:{partition,preload:require('node:path').join(__dirname,'site-signal-preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,devTools:false,backgroundThrottling:false}});
  liveStarted=false;
  configureContent(adminWindow.webContents);
  adminWindow.on('closed',()=>{adminWindow=null;liveStarted=false;});
  await adminWindow.loadURL(ORIGIN+'/admin.html?acoDesktop=1');
  return true;
 }
 function signIn(){`);
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
  if(operation==='replace'){
   const replacementId=String(result.replacementManagedAccountId||'');
   if(!replacementId||replacementId!==id(payload.replacementId))throw Error('Website replaced a different account than the one selected. Refresh before trying again.');
   if(!verified.linked.some(x=>x.managedAccountId===replacementId&&x.retailer===remote.retailer&&x.active))throw Error('Replacement account verification failed.');
   const pool=await read('pool',{status:'available',retailer:remote.retailer,query:replacementId,page:1});
   if(pool.profiles.some(x=>String(x.id)===replacementId&&x.status==='available'))throw Error('Replacement is still in the available '+remote.retailer+' pool. The swap was not accepted as complete.');
  }
  if(operation==='reassign'){const receiver=await profileSource(id(payload.targetCustomerId));if(!receiver.linked.some(x=>x.managedAccountId===id(remote.id)&&x.active))throw Error('Receiving customer assignment readback failed.');}
  notifyOwner();return {saved:true,replacementManagedAccountId:result.replacementManagedAccountId||null,customerAccountId:result.customerAccountId||null};
 }
 const {safeStorage,app}=require('electron'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
 const desktopAuthFile=path.join(app.getPath('userData'),'aco-desktop-admin-auth.json');
 function readDesktopAuth(){try{const value=JSON.parse(fs.readFileSync(desktopAuthFile,'utf8'));return value&&typeof value==='object'?value:null;}catch{return null;}}
 function writeDesktopAuth(value){fs.mkdirSync(path.dirname(desktopAuthFile),{recursive:true});fs.writeFileSync(desktopAuthFile,JSON.stringify(value),{mode:0o600});}
 function desktopDevice(){const current=readDesktopAuth();if(current?.deviceId)return current;const next={deviceId:crypto.randomUUID()};writeDesktopAuth(next);return next;}
 function desktopUnlockState(){const current=readDesktopAuth(),expiresAt=Number(current?.expiresAt||0);return {enrolled:Boolean(current?.deviceId&&current?.token&&safeStorage.isEncryptionAvailable()&&(!expiresAt||expiresAt>Date.now())),expiresAt:expiresAt||null};}
 async function enrollDesktopDevice(){
  if(!safeStorage.isEncryptionAvailable())throw Error('macOS secure storage is unavailable. Touch ID enrollment was not saved.');
  const current=desktopDevice(),result=await api('/api/admin/desktop-device/enroll','POST',{deviceId:current.deviceId});
  if(result?.ok!==true||!result.token)throw Error('Website did not confirm Touch ID enrollment.');
  writeDesktopAuth({deviceId:current.deviceId,token:safeStorage.encryptString(String(result.token)).toString('base64'),expiresAt:result.expiresAt||null});
  return {ok:true};
 }
 async function unlockDesktopAdmin(){
  const current=readDesktopAuth();
  if(!current?.deviceId||!current?.token)return {ok:false,needsEnrollment:true,reason:'Sign in once with the Admin password and authenticator to enable Touch ID on this Mac.'};
  if(!safeStorage.isEncryptionAvailable())return {ok:false,needsEnrollment:true,reason:'macOS secure storage is unavailable.'};
  if(current.expiresAt&&Number(current.expiresAt)<=Date.now())return {ok:false,needsEnrollment:true,reason:'This Mac’s Touch ID authorization expired. Sign in once with the Admin password and authenticator to renew it.'};
  try{
   await prepareDesktopUnlock();
   const token=safeStorage.decryptString(Buffer.from(current.token,'base64'));
   const result=await api('/api/admin/desktop-device/unlock','POST',{deviceId:current.deviceId,token});
   return result?.ok===true?{ok:true}:{ok:false,needsEnrollment:true,reason:'This Mac must be enrolled again.'};
  }catch(error){
   if(/not enrolled|authorization|unauthorized|401/i.test(String(error?.message||error)))return {ok:false,needsEnrollment:true,reason:'Sign in once with the Admin password and authenticator to re-enable Touch ID on this Mac.'};
   throw error;
  }
 }
 return {open,signIn,prepareDesktopUnlock,desktopUnlockState,hide,reload,bounds,read,adminRead,adminAction,assign,returnToPool,jig,logout,isReady,getLinkedAccountEmails,profileSource,saveCustomerProfile,savedCustomerData,saveCustomerSavedData,changeCustomerAssignment,enrollDesktopDevice,unlockDesktopAdmin};`);
replace('tests/personal-profiles-security.test.js',"customerId:'customer1',retailer:'walmart',rows:","customerId:'customer1',retailer:'target',rows:");
replace('tests/personal-profiles-security.test.js',"customerId:'customer2',retailer:'pokemoncenter',data:","customerId:'customer2',retailer:'target',data:");
replace('tests/personal-profiles-security.test.js',"customerId:'u2',retailer:'walmart',email:'shared@sample.test'","customerId:'u2',retailer:'target',email:'shared@sample.test'");
replace('profile-bank-ui.js',"h.textContent=dup.email+' ('+dup.count+' matches)'","h.textContent=(retailerNames[dup.retailer]||dup.retailer)+' · '+dup.email+' ('+dup.count+' distinct accounts)'");
replace('profile-bank-ui.js',"' email(s) appear more than once. '","' retailer email(s) are reused within the same retailer. '");
replace('index.html','<script src="./profile-bank-ui.js"></script>','<script src="duplicate-notification-state.js"></script><script src="./profile-bank-ui.js"></script>');
replace('index.html','</body>','<link rel="stylesheet" href="profile-library.css"><script src="profile-library-ui.js"></script><script src="native-touchid.js"></script><script src="full-admin-access.js"></script>\n</body>');
const p=path.join(root,'package.json'),pkg=JSON.parse(fs.readFileSync(p,'utf8'));for(const file of files)if(!pkg.build.files.includes(file))pkg.build.files.push(file);fs.writeFileSync(p,JSON.stringify(pkg,null,2)+'\n');
console.log('Scoped customer/personal profile library, duplicate repairs and linked-customer preparation integrated.');

replace('site-bridge.js',"   try{const owner=mainWindow();if(owner&&!owner.isDestroyed()){owner.show();owner.focus();}}catch{/* Ignore a window that closed while syncing. */}","   // Background roster refresh must never steal macOS/Windows focus from the user's current app.\n   // The main window is only focused in response to an explicit user action.");

replace('desktop-native.js'," const updateConn=()=>{\n  const live=Boolean(conn?.classList.contains('ready'));\n  nativeStatus.classList.toggle('connected',live);\n  const line=$('nativeSiteStatus');if(line)line.textContent=live?'Website connected':'Website disconnected';\n };"," const updateConn=()=>{\n  const source=window.JigWebsiteCustomers;\n  const live=Boolean(conn?.classList.contains('ready')||source?.connected?.());\n  nativeStatus.classList.toggle('connected',live);\n  const line=$('nativeSiteStatus');if(line)line.textContent=live?'Website connected':'Website disconnected';\n  for(const badge of document.querySelectorAll('.lozenge,[class*=site-status],[class*=siteStatus]')){\n   const label=String(badge.textContent||'').trim();\n   if(/^(site|website)\\s+(offline|online|disconnected|connected)$/i.test(label)){badge.textContent=live?'SITE ONLINE':'SITE OFFLINE';badge.classList.toggle('connected',live);badge.classList.toggle('offline',!live);}\n  }\n };");
replace('desktop-native.js'," d.addEventListener('jigstudio:customers-updated',refreshCustomerList);"," d.addEventListener('jigstudio:customers-updated',()=>{updateConn();refreshCustomerList();});");
