'use strict';
// Authorized site requests execute within the owner's genuine website Admin window.
// No passwords, API secrets, raw card data or credentials are persisted by this bridge.
const site=require('./site-model');
const ORIGIN='https://slabsngrabsaco.com';
const ID=/^[a-zA-Z0-9:_-]{1,150}$/;
const RETAILER=new Set(['target','walmart','pokemoncenter']);
const TYPES=new Set(['free','rented']);
const id=value=>{const s=String(value??'');if(!ID.test(s))throw Error('Invalid profile or customer identifier');return s;};
const retailer=value=>{if(!RETAILER.has(value))throw Error('Choose a supported retailer');return value;};
const type=value=>{if(!TYPES.has(value))throw Error('Choose a supported assignment type');return value;};
const safeQuery=value=>String(value||'').trim().slice(0,120);
const allowed={
 roster:()=>[['/api/admin/submissions'],['/api/admin/free-submissions'],['/api/admin/profile-activation-tracker']],
 pool:({retailer:r='all',status='all',query='',page=1})=>{
  if(r!=='all')retailer(r);
  if(!['all','available','linked','held','needs_repair','duplicate'].includes(status))throw Error('Invalid pool status');
  const params=new URLSearchParams({retailer:r,status,q:safeQuery(query),page:String(Math.max(1,Math.min(5000,Math.floor(Number(page)||1))))});
  return [['/api/admin/managed-pool/search?'+params.toString()]];
 },
 jigOptions:()=>[['/api/admin/jig-options']],
 customer:({orderId})=>[
  ['/api/admin/submissions/'+encodeURIComponent(id(orderId))+'/saved-details'],
  ['/api/admin/submissions/'+encodeURIComponent(id(orderId))+'/linked-memberships']
 ]
};
function makeBrowserBridge({BrowserWindow,WebContentsView,session,ipcMain,shell,mainWindow}){
 let adminWindow=null,adminView=null,embeddedVisible=false,liveStarted=false,lastEvent=0;
 let lastBounds={x:270,y:180,width:850,height:610};
 const canEmbed=()=>typeof WebContentsView==='function'&&Boolean(mainWindow()?.contentView);
 const owner=()=>{const win=mainWindow();return win&&!win.isDestroyed()?win:null;};
 function setViewBounds(bounds){
  const win=owner();if(!win||!adminView||adminView.webContents.isDestroyed())return false;
  const size=win.getContentBounds?.()||win.getBounds();
  // The owner renderer supplies an exact DOMRect of the visible Admin panel.
  // Hard limits avoid drawing into the sidebar/title/controls or off-window.
  const x=Math.max(0,Math.min(Math.floor(Number(bounds?.x)||0),size.width-300));
  const y=Math.max(75,Math.min(Math.floor(Number(bounds?.y)||0),size.height-160));
  const width=Math.max(300,Math.min(Math.floor(Number(bounds?.width)||0),size.width-x));
  const height=Math.max(160,Math.min(Math.floor(Number(bounds?.height)||0),size.height-y));
  lastBounds={x,y,width,height};
  if(embeddedVisible)adminView.setBounds(lastBounds);
  return true;
 }
 function attachView(){
  const win=owner();if(!win||!adminView)return false;
  if(!embeddedVisible){win.contentView.addChildView(adminView);embeddedVisible=true;}
  adminView.setBounds(lastBounds);
  return true;
 }
 function detachView(){
  const win=owner();if(adminView&&embeddedVisible){
   try{win?.contentView.removeChildView(adminView);}catch{/* Window was closed. */}
   embeddedVisible=false;
  }
  return true;
 }
 function closeView(){
  detachView();
  if(adminView){try{if(!adminView.webContents.isDestroyed())adminView.webContents.close();}catch{}adminView=null;}
 }
 function configureContent(contents){
  contents.setWindowOpenHandler(({url})=>{if(url.startsWith(ORIGIN+'/'))shell.openExternal(url).catch(()=>{});return {action:'deny'};});
  contents.on('will-navigate',(event,url)=>{try{if(new URL(url).origin!==ORIGIN)event.preventDefault();}catch{event.preventDefault();}});
  contents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  contents.on('did-finish-load',()=>{liveStarted=false;notifyOwner();});
 }
 const partition='persist:sng-jig-admin';
 const partitionSession=session.fromPartition(partition);
 // Electron retains callback closures after a window closes; never touch webContents of a destroyed window.
 const liveContents=()=>{
  try{
   const contents=adminView&&!adminView.webContents.isDestroyed()?adminView.webContents:adminWindow&&!adminWindow.isDestroyed()?adminWindow.webContents:null;
   return contents&&!contents.isDestroyed()?contents:null;
  }catch{return null;}
 };
 const isReady=()=>Boolean(liveContents());
 function notifyOwner(){
  try{
   const owner=mainWindow();
   if(!owner||owner.isDestroyed())return false;
   const contents=owner.webContents;
   if(!contents||contents.isDestroyed())return false;
   contents.send('site:change');return true;
  }catch{return false;} // a window may have been destroyed during a queued live event
 }
 function open(){
  if(canEmbed()){
   if(adminView&& !adminView.webContents.isDestroyed())return attachView();
   const win=owner();
   adminView=new WebContentsView({webPreferences:{partition,preload:require('node:path').join(__dirname,'site-signal-preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,devTools:false,backgroundThrottling:false}});
   liveStarted=false;
   configureContent(adminView.webContents);
   adminView.webContents.once('destroyed',()=>{adminView=null;embeddedVisible=false;liveStarted=false;});
   attachView();
   adminView.webContents.loadURL(ORIGIN+'/admin.html').catch(()=>notifyOwner());
   win.show();
   return true;
  }
  return signIn();
 }
 // Only authentication opens this isolated browser window. The desktop Admin screen
 // itself remains local Electron-rendered HTML, not a hosted website frame.
 function signIn(){
  if(typeof BrowserWindow!=='function')throw Error('Secure Admin sign-in window is not supported here.');
  if(adminWindow&&!adminWindow.isDestroyed()){
   adminWindow.show();adminWindow.focus();return true;
  }
  adminWindow=new BrowserWindow({width:1180,height:880,minWidth:760,minHeight:580,show:true,title:'SLABSNGRABSACO • Secure Admin Sign-In',
   webPreferences:{partition,preload:require('node:path').join(__dirname,'site-signal-preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,devTools:false,backgroundThrottling:false}});
  liveStarted=false;
  configureContent(adminWindow.webContents);
  adminWindow.on('closed',()=>{adminWindow=null;liveStarted=false;});
  adminWindow.loadURL(ORIGIN+'/admin.html');
  return true;
 }
 function hide(){return detachView();}
 function reload(){const c=liveContents();if(!c)return open();c.reload();return true;}
 function bounds(rectangle){return setViewBounds(rectangle);}

 async function api(path,method='GET',data){
  if(!isReady())throw Error('Connect to SLABSNGRABSACO Admin first.');
  if(!path.startsWith('/api/admin/') || path.includes('..') || path.includes('#'))throw Error('Only authorized Admin API routes are supported.');
  const script=`(async()=>{const r=await fetch(${JSON.stringify(path)},{method:${JSON.stringify(method)},credentials:'same-origin',cache:'no-store',headers:${JSON.stringify(method==='GET'?{}:{'Content-Type':'application/json'})},body:${method==='GET'?'undefined':JSON.stringify(JSON.stringify(data??{}))}});let v;try{v=await r.json()}catch{v={}}return {status:r.status,ok:r.ok,body:v}})()`;
  let result;try{   result=await liveContents().executeJavaScript(script,true);}catch{
   throw Error('Unable to reach Admin. Keep the sign-in window open and try again.');
  }
  if(result.status===401||result.status===403)throw Error('Admin authorization required. Sign in to the website using the Admin window.');
  if(!result.ok)throw Error(String(result.body?.error||'Website rejected this request.').slice(0,220));
  return result.body;
 }
 async function enableLive(){
  if(liveStarted||!isReady())return;
  try{
   await liveContents().executeJavaScript(`(()=>{if(window.__sngJigAdminEventSource)return;const s=new EventSource('/api/admin/live/events');s.addEventListener('data-change',()=>window.jigSignals?.changed());s.addEventListener('checkout',()=>window.jigSignals?.changed());window.__sngJigAdminEventSource=s;})()`);
   liveStarted=true;
  }catch{/* Manual refresh remains available. */}
 }
 ipcMain.on('site:remote-change',event=>{
  const live=liveContents();
  if(!live||event.sender!==live||event.sender.isDestroyed())return;
  const now=Date.now();if(now-lastEvent<750)return;lastEvent=now;
  notifyOwner();
 });
 async function read(kind,opts={}){
  if(!Object.hasOwn(allowed,kind))throw Error('Unsupported Admin data view.');
  const routes=allowed[kind](opts);
  const results=await Promise.all(routes.map(([p])=>api(p)));
  await enableLive();
  if(kind==='roster'){
   const customers=site.roster(results[0],results[1],results[2]);
   // Existing linked pool is authoritative. Do not guess counts from cached desktop data.
   let page=1,complete=true,total=0;
   do{
    const response=site.poolSearch(await api('/api/admin/managed-pool/search?status=linked&retailer=all&page='+page));
    total=response.total;
    for(const profile of response.profiles){
     const c=customers.find(item=>item.id&&item.id===profile.assignedTo?.id);
     if(c&&Object.hasOwn(c.linkedCounts,profile.retailer))c.linkedCounts[profile.retailer]++;
    }
    if(page>=Math.min(response.pageCount,25)){complete=page>=response.pageCount;break;}
    page++;
   }while(page<=25);
   // After successful authentication, close the temporary website view while
   // retaining its authenticated session for the Jig Studio desktop bridge.
   // Reopen it at any time using Secure Admin sign-in.
   if(!adminView&&isReady()&&adminWindow.isVisible()){adminWindow.hide();}
   try{const owner=mainWindow();if(owner&&!owner.isDestroyed()){owner.show();owner.focus();}}catch{/* Ignore a window that closed while syncing. */}
   return {customers,linkedInventoryComplete:complete,at:new Date().toISOString()};
  }
  if(kind==='pool')return site.poolSearch(results[0]);
  if(kind==='jigOptions')return {options:Array.isArray(results[0]?.options)?results[0].options.filter(o=>o&&typeof o.id==='string').map(o=>({id:o.id,group:String(o.group||''),label:String(o.label||''),risk:String(o.risk||'standard')})):[]};
  if(kind==='customer'){
   const links=site.linked(results[1]);
   const linkedPool=[];let page=1;
   do{
    const p=site.poolSearch(await api('/api/admin/managed-pool/search?status=linked&retailer=all&page='+page));
    linkedPool.push(...p.profiles);
    if(page>=Math.min(p.pageCount,25))break;
    page++;
   }while(page<=25);
   for(const x of links){
    const exact=linkedPool.find(p=>p.id===x.id);
    if(exact){x.retailer=exact.retailer;x.loginEmail=exact.loginEmail;}
   }
   // Fetch each existing linked assignment's authorized postal state, but never transfer
   // the saved-details paymentMethods payload or vault contents to the desktop renderer.
   for(let offset=0;offset<Math.min(links.length,60);offset+=5){
    const group=links.slice(offset,offset+5);
    const details=await Promise.allSettled(group.map(x=>api('/api/admin/managed-memberships/'+type(x.type)+'/'+encodeURIComponent(id(x.id))+'/saved-details')));
    details.forEach((res,i)=>{if(res.status!=='fulfilled')return;
      group[i].selectedAddressId=String(res.value?.selectedAddressId||'');
      group[i].jiggedAddress=res.value?.jiggedAddress?site.postal(res.value.jiggedAddress):null;
    });
   }
   return {saved:site.savedDetails(results[0]),linked:links,at:new Date().toISOString()};
  }
 }
 async function assign(payload){
  const customerAccountId=id(payload?.customerAccountId),managedAccountId=id(payload?.managedAccountId),r=retailer(payload?.retailer);
  const assignmentType=type(payload?.assignmentType||'free');
  const durationType=String(payload?.durationType||'indefinite');
  if(!['indefinite','1_drop','1_week','1_month'].includes(durationType))throw Error('Invalid assignment duration.');
  // Re-read the live available pool before the website's own transactional assignment checks.
  const latest=await read('pool',{status:'available',retailer:r,query:managedAccountId,page:1});
  if(!latest.profiles.some(p=>p.id===managedAccountId&&p.status==='available'))throw Error('This exact retailer account is no longer available. Refresh the pool.');
  const result=await api('/api/admin/available-memberships/assign','POST',{customerAccountId,managedAccountId,retailer:r,assignmentType,durationType,quantity:1});
  return {ok:result.ok===true,message:String(result.message||'Assignment requested.'),at:new Date().toISOString()};
 }
 async function returnToPool(payload){
  const membershipId=id(payload?.managedAccountId),assignmentType=type(payload?.assignmentType),customerId=id(payload?.customerAccountId),assignmentId=id(payload?.assignmentId);
  const result=await api('/api/admin/linked-memberships/'+assignmentType+'/'+membershipId+'/return-to-pool','POST',{
   expectedCustomerAccountId:customerId,expectedAssignmentId:assignmentId
  });
  return {ok:result.ok===true,message:String(result.message||'Return requested.')};
 }
 async function jig(payload){
  const assignmentId=id(payload?.managedAccountId),assignmentType=type(payload?.assignmentType),savedAddressId=id(payload?.savedAddressId);
  const options=Array.isArray(payload?.jigOptions)?payload.jigOptions.filter(s=>typeof s==='string'&&s.length<90).slice(0,75):[];
  const result=await api('/api/admin/managed-memberships/'+assignmentType+'/'+assignmentId+'/jig-address','POST',{savedAddressId,jigOptions:options});
  return {ok:result.ok===true,unchanged:result.unchanged===true,message:String(result.message||'Jig request completed.'),variant:result.variant?site.postal(result.variant):null};
 }
 async function logout(){
  closeView();if(adminWindow&&!adminWindow.isDestroyed())adminWindow.close();
  await partitionSession.clearStorageData({storages:['cookies']});
  return true;
 }
 return {open,signIn,hide,reload,bounds,read,assign,returnToPool,jig,logout,isReady};
}
module.exports={ORIGIN,makeBrowserBridge,id,retailer,type};
