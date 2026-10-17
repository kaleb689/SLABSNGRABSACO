'use strict';
const fs=require('node:fs'),path=require('node:path');const root=path.resolve(process.argv[2]);
const files=['profile-vault.js','profile-library-core.js','profile-library-service.js','profile-library-ui.js','profile-library.css','customer-profile-source.js','profile-completion-core.js'];for(const file of files)fs.copyFileSync(path.join(__dirname,file),path.join(root,file));
for(const file of ['profile-library.test.js'])fs.copyFileSync(path.join(__dirname,file),path.join(root,'tests',file));
function replace(file,anchor,value){const p=path.join(root,file),s=fs.readFileSync(p,'utf8');if(s.split(anchor).length!==2)throw Error(file+': library integration anchor changed');fs.writeFileSync(p,s.replace(anchor,value));}
replace('profile-workshop-service.js','const service=createWorkshop(options);',"const service=createWorkshop(options);require('./profile-library-service').registerLibrary(options);");
replace('main.js','window.JigStudioLocalImport?.workspaceState)', 'window.JigStudioLocalImport?.workspaceState && document.getElementById("profileLibraryPage") && window.desktopAPI?.profileLibrary && document.querySelectorAll(".profileNavChild").length===2)');
replace('main.js','requireOwner:workshopOwner,authorize:',"getCustomerProfileSource:id=>siteBridge.profileSource(id),requireOwner:workshopOwner,authorize:");
replace('preload.js','profileWorkshop:Object.freeze({',"profileLibrary:Object.freeze(Object.fromEntries(['list','detail','importPreview','importCommit','repair','edit','exportFile','syncCustomer','rules','saveRules'].map(method=>[method,payload=>ipcRenderer.invoke('profile:library:'+method,payload)]).concat([['cancel',()=>ipcRenderer.invoke('profile:library:cancel')]]))),\n profileWorkshop:Object.freeze({");
replace('site-bridge.js',"const now=Date.now();if(now-lastEvent<750)return;lastEvent=now;","indexUntil=0;lastRosterAt=0;const now=Date.now();if(now-lastEvent<750)return;lastEvent=now;");
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
 return {open,signIn,hide,reload,bounds,read,adminRead,adminAction,assign,returnToPool,jig,logout,isReady,getLinkedAccountEmails,profileSource};`);
replace('index.html','</body>','<link rel="stylesheet" href="profile-library.css"><script src="profile-library-ui.js"></script>\n</body>');
const p=path.join(root,'package.json'),pkg=JSON.parse(fs.readFileSync(p,'utf8'));for(const file of files)if(!pkg.build.files.includes(file))pkg.build.files.push(file);fs.writeFileSync(p,JSON.stringify(pkg,null,2)+'\n');
console.log('Scoped customer/personal profile library, duplicate repairs and linked-customer preparation integrated.');
