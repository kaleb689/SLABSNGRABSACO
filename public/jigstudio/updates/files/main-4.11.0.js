'use strict';
const {app,BrowserWindow,WebContentsView,ipcMain,shell,dialog,clipboard,safeStorage,nativeImage}=require('electron');
const path=require('node:path');
const {readSelectedFiles}=require('./local_files');
const services=require('./services');
const {makeBrowserBridge}=require('./site-bridge');
const siteModel=require('./site-model');
const {makeVault}=require('./local-card-vault');
const {registerWindowChrome}=require('./window-chrome');
const {serialize:serializeLocalCardExport}=require('./local-card-export');
const {makeStore}=require('./aco-private-bank');
const fs=require('node:fs/promises');
const https=require('node:https');
const OWNER_DOMAIN='sng.sarl'; // Public domain, never an API secret or coworker email.
const sessions=new Map(); // Each window must prove control of the domain every run.
const cloudflare=services.cloudflare();
let ownerWindow=null;
let siteBridge=null;
let localCards=null;
let privateBank=null;
const ownerSession=(event)=>{
 const s=sessions.get(event.sender.id);
 if(!s || Date.now()-s.lastUsed>3600000){sessions.delete(event.sender.id);throw Error('Owner session expired. Authorize with Cloudflare again.');}
 s.lastUsed=Date.now();return s.config;
};
// Apply the brand's current public logo to the window/taskbar without exposing
// website logins or requiring a new Windows installer. Keep the previous local
// official logo available when offline. The shortcut icon embedded in the legacy
// JigStudio executable is unchanged until an independently packaged installer.
async function brandWindow(win){
 const iconPath=path.join(app.getPath('userData'),'aco-studio-brand-logo.png');
 const useImage=bytes=>{
  if(!Buffer.isBuffer(bytes)||bytes.length<20||bytes.length>3*1024*1024||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return;
  const logo=nativeImage?.createFromBuffer?.(bytes);if(logo&&!logo.isEmpty()&&win&&!win.isDestroyed()&&typeof win.setIcon==='function')win.setIcon(logo.resize({width:256}));
 };
 try{useImage(await fs.readFile(iconPath));}catch{/* No cached official logo. */}
 if(process.env.ACO_STUDIO_DISABLE_BRAND_NETWORK==='1')return;
 const request=https.get('https://slabsngrabsaco.com/slabsngrabs-aco-logo-transparent.png',{timeout:8000},response=>{
  if(response.statusCode!==200||!String(response.headers['content-type']||'').toLowerCase().includes('image/png')){response.resume();return;}
  const chunks=[];let size=0;
  response.on('data',chunk=>{size+=chunk.length;if(size>3*1024*1024){response.destroy();return;}chunks.push(chunk);});
  response.on('end',async()=>{if(size>3*1024*1024)return;const bytes=Buffer.concat(chunks);if(bytes.length<20||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return;
   useImage(bytes);try{await fs.mkdir(path.dirname(iconPath),{recursive:true});await fs.writeFile(iconPath,bytes,{mode:0o600});}catch{};
  });
 });
 request.on('timeout',()=>request.destroy());request.on('error',()=>{});
}
function launch(){
 const win=new BrowserWindow({
  width:1540,height:960,minWidth:1000,minHeight:700,show:true,frame:false,backgroundColor:'#070d1c',autoHideMenuBar:true,title:'SLABSNGRABSACO ACO Studio',
  icon:path.join(__dirname,process.platform==='darwin'?'JigStudio.png':'JigStudio.ico'),
  webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,devTools:false}
 });
 const localUrl='file://'+path.join(__dirname,'index.html');
 ownerWindow=win;
 win.loadFile(path.join(__dirname,'index.html'));
 void brandWindow(win).catch(()=>{});
 // Show the window immediately so a UI initialization failure cannot make the app invisible.
 win.once('ready-to-show',()=>win.show());
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 win.webContents.on('will-navigate',(event,url)=>{if(url!==localUrl)event.preventDefault();});
 win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
 const contentsId=win.webContents.id;
 win.webContents.once('destroyed',()=>sessions.delete(contentsId));
 win.on('closed',()=>{if(ownerWindow===win)ownerWindow=null;});
}
app.setName('SLABSNGRABSACO ACO Studio - Owner');
app.setAppUserModelId('com.slabsngrabsaco.jigstudio.owner');
app.whenReady().then(()=>{
 localCards=makeVault({baseDir:app.getPath('userData'),safeStorage});
 privateBank=makeStore({baseDir:app.getPath('userData'),safeStorage,lookupSmarty:services.lookupSmarty,lookupUsps:services.lookupUsps});
 registerWindowChrome({ipcMain,BrowserWindow,mainWindow:()=>ownerWindow});
 const ownerSender=e=>{if(!ownerWindow||ownerWindow.isDestroyed()||ownerWindow.webContents?.isDestroyed()||ownerWindow.webContents.id!==e.sender.id)throw Error('Only the local Jig Studio window may manage locally stored cards.');};
 ipcMain.handle('cards:list',async(e,customerId)=>{ownerSender(e);return localCards.list(customerId);});
 ipcMain.handle('cards:add',async(e,customerId,card)=>{ownerSender(e);return localCards.add(customerId,card);});
 ipcMain.handle('cards:remove',async(e,customerId,cardId)=>{ownerSender(e);return localCards.remove(customerId,cardId);});
 ipcMain.handle('cards:distribute',async(e,customerId,cardIds,count)=>{ownerSender(e);return localCards.distribute(customerId,cardIds,count);});
 ipcMain.handle('cards:exportProfiles',async(event,payload)=>{
  ownerSender(event);
  if(payload?.confirmUnencryptedExport!==true)throw Error('Explicit confirmation is required before saving card numbers in an unencrypted Shikari/Valor file.');
  const cards=await localCards.cardForExport(payload.customerId,payload?.records?.length);
  const result=serializeLocalCardExport({records:payload.records,fileName:payload.fileName},cards);
  const save=await dialog.showSaveDialog(ownerWindow,{title:'Export local profiles with saved customer cards',defaultPath:result.name,filters:[{name:result.mime,extensions:[result.name.split('.').pop()]}]});
  if(save.canceled||!save.filePath)return {saved:false};
  if(path.extname(save.filePath).toLowerCase()!==path.extname(result.name).toLowerCase())throw Error('Keep the original retailer file type ('+path.extname(result.name)+'); Excel .xlsx is not supported.');
  await fs.writeFile(save.filePath,result.body,{encoding:'utf8',flag:'w',mode:0o600});
  return {saved:true,name:path.basename(save.filePath),count:result.count,localCardProfiles:result.assigned};
 });
 require('./desktop-updates').register({app,ipcMain,dialog,BrowserWindow});
 siteBridge=makeBrowserBridge({BrowserWindow,WebContentsView,session:require('electron').session,ipcMain,shell,mainWindow:()=>ownerWindow});
 ipcMain.handle('site:open',event=>{ownerSender(event);return siteBridge.open();});
 ipcMain.handle('site:hide',event=>{ownerSender(event);return siteBridge.hide();});
 ipcMain.handle('site:reload',event=>{ownerSender(event);return siteBridge.reload();});
 ipcMain.handle('site:bounds',(event,rectangle)=>{ownerSender(event);return siteBridge.bounds(rectangle);});
 ipcMain.handle('site:read',(_event,kind,options)=>siteBridge.read(kind,options||{}));
 ipcMain.handle('site:assign',(_event,payload)=>siteBridge.assign(payload));
 ipcMain.handle('site:return',(_event,payload)=>siteBridge.returnToPool(payload));
 ipcMain.handle('site:jig',(_event,payload)=>siteBridge.jig(payload));
 ipcMain.handle('site:logout',()=>siteBridge.logout());
 // Notification history is encrypted with the OS user credential store (Windows DPAPI / macOS Keychain).
 // A machine without supported encryption keeps notification history only for this app session.
 const noticesFile=path.join(app.getPath('userData'),'owner-site-activity.bin');
 let historyMemory=[];
 let historyPending=Promise.resolve();
 const cleanNotices=value=>(Array.isArray(value)?value:[]).slice(0,100).filter(v=>v&&typeof v==='object').map(v=>({
  id:String(v.id||'').slice(0,80),title:String(v.title||'').slice(0,100),
  detail:String(v.detail||'').slice(0,180),at:Number.isFinite(Number(v.at))?Number(v.at):Date.now()
 }));
 const noticeAuthorized=async()=>{
  if(!siteBridge?.isReady())throw Error('Admin sign-in is required to access notifications.');
  await siteBridge.read('jigOptions',{}); // Enforces the existing website Admin session.
 };
 ipcMain.handle('site:notifications:load',async()=>{
  await noticeAuthorized();
  if(!safeStorage.isEncryptionAvailable())return historyMemory;
  try{return cleanNotices(JSON.parse(safeStorage.decryptString(await fs.readFile(noticesFile))));}
  catch(e){if(e.code==='ENOENT')return [];throw Error('Saved notification history could not be unlocked on this device.');}
 });
 ipcMain.handle('site:notifications:save',async(_event,value)=>{
  await noticeAuthorized();
  const records=cleanNotices(value);historyMemory=records;
  if(!safeStorage.isEncryptionAvailable())return {saved:false,reason:'OS encryption unavailable; notifications are kept for this session.'};
  historyPending=historyPending.catch(()=>{}).then(async()=>{
   const tmp=noticesFile+'.tmp';
   await fs.mkdir(path.dirname(noticesFile),{recursive:true});
   await fs.writeFile(tmp,safeStorage.encryptString(JSON.stringify(records)),{mode:0o600});
   await fs.rename(tmp,noticesFile);
  });
  await historyPending;
  return {saved:true};
 });
 ipcMain.handle('site:makeTemplate',async(_event,payload)=>{
  if(!siteBridge.isReady())throw Error('Sign in to your website Admin first.');
  if(!payload||!Array.isArray(payload.profiles)||payload.profiles.length<1||payload.profiles.length>100)throw Error('Choose between 1 and 100 profiles.');
  const template=siteModel.exportTemplates(payload.retailer,payload.customerName,payload.profiles,null);
  return {name:template.name,body:template.body,profileCount:payload.profiles.length};
 });
 ipcMain.handle('site:export',async(event,payload)=>{
  if(!siteBridge.isReady())throw Error('Connect to authenticated website Admin first.');
  if(!payload||!Array.isArray(payload.profiles)||payload.profiles.length<1||payload.profiles.length>200)throw Error('Choose 1-200 linked profiles.');
  let localPaymentOptions={};
  if(payload.useLocalSavedCards===true){
   if(payload.confirmUnencryptedExport!==true)throw Error('Confirm explicitly that the file will include full card numbers in plaintext.');
   if(!payload.customerId)throw Error('Select a customer with locally saved cards.');
   const authenticated=await siteBridge.read('roster',{});
   if(!authenticated.customers.some(c=>c.id===payload.customerId))throw Error('Selected customer is not in the authenticated Admin roster.');
   localPaymentOptions={localOwnerCards:await localCards.cardForExport(payload.customerId,payload.profiles.length)};
  }
  const source=siteModel.exportTemplates(payload.retailer,payload.customerName,payload.profiles,null,localPaymentOptions);
  const parent=BrowserWindow.fromWebContents(event.sender);
  const result=await dialog.showSaveDialog(parent,{title:'Save retailer import template',defaultPath:source.name,filters:[{name:source.mime,extensions:[source.name.split('.').pop()]}]});
  if(result.canceled||!result.filePath)return {saved:false};
  if(path.extname(result.filePath).toLowerCase()!==path.extname(source.name).toLowerCase())throw Error('The import file must be '+path.extname(source.name)+' ('+(payload.retailer==='target'?'Shikari CSV':'Valor JSON')+'), not Excel .xlsx.');
  await fs.writeFile(result.filePath,source.body,{encoding:'utf8',flag:'w'});
  return {saved:true,name:require('node:path').basename(result.filePath),profileCount:payload.profiles.length,paymentFieldsPreserved:true,
   syntheticPaymentProfiles:payload.profiles.filter(p=>p.syntheticCard?.synthetic===true).length,localCardProfiles:(localPaymentOptions.localOwnerCards||[]).filter(Boolean).length};
 });
 ipcMain.handle('cf:authorize',async(event,config)=>{
  if(config?.domain!==OWNER_DOMAIN)throw Error('Owner access is only available for the designated business domain.');
  const authorized=await cloudflare.authorize(config);
  sessions.set(event.sender.id,{config:{...config,token:config.token.trim()},lastUsed:Date.now()});
  return authorized;
 });
 ipcMain.handle('cf:check',(event)=>cloudflare.check(ownerSession(event)));
 ipcMain.handle('cf:publish',(event,aliases)=>cloudflare.publish({...ownerSession(event),aliases}));
 ipcMain.handle('cf:lock',(event)=>{sessions.delete(event.sender.id);return true;});
 ipcMain.handle('email:mx',()=>services.dnsMailCheck(OWNER_DOMAIN));
 ipcMain.handle('local:chooseFiles',async(event)=>{
  const parent=BrowserWindow.fromWebContents(event.sender);
  if(!parent)throw Error('This file picker must be opened from Jig Studio.');
  const result=await dialog.showOpenDialog(parent,{
   title:'Import local account files',properties:['openFile','multiSelections'],
   filters:[{name:'Account CSV, TSV, JSON and text',extensions:['csv','tsv','tab','psv','json','jsonl','ndjson','txt']}]
  });
  if(result.canceled)return [];
  return readSelectedFiles(result.filePaths);
 });
 ipcMain.handle('retailer:open',async(event,retailer,alias)=>{
  ownerSession(event);
  if(typeof alias!=='string'||!/^[a-z0-9][a-z0-9._-]{0,63}@sng\.sarl$/.test(alias)||alias.includes('..'))throw Error('A live sng.sarl alias is required.');
  const destinations={target:'https://www.target.com/account',walmart:'https://www.walmart.com/account'};
  if(!Object.hasOwn(destinations,retailer))throw Error('Unsupported retailer.');
  clipboard.writeText(alias);
  await shell.openExternal(destinations[retailer]);
  return {opened:true,retailer,copied:alias};
 });
 // Open an explicit Gmail search in the owner's web browser. No Gmail password,
 // app password, session cookie or message content is read by this app.
 ipcMain.handle('retailer:openInbox',async(event,retailer,alias,inbox)=>{
  ownerSession(event);
  if(!['target','walmart'].includes(retailer))throw Error('Unsupported retailer.');
  if(typeof alias!=='string'||!/^[a-z0-9][a-z0-9._-]{0,63}@sng\.sarl$/.test(alias)||alias.includes('..'))throw Error('A valid sng.sarl alias is required.');
  if(typeof inbox!=='string'||!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(inbox)||inbox.length>254)throw Error('The verified forwarding inbox is required.');
  const query='"'+alias+'" newer_than:30d';
  const url='https://mail.google.com/mail/?authuser='+encodeURIComponent(inbox)+'#search/'+encodeURIComponent(query);
  await shell.openExternal(url);
  return {opened:true};
 });
 // Copy a saved owner-only password only on an explicit click. Never log or persist clipboard values.
 ipcMain.handle('vault:copyPassword',(event,password)=>{
  ownerSession(event);
  if(typeof password!=='string'||password.length<12||password.length>200)throw Error('Invalid password format.');
  clipboard.writeText(password);
  setTimeout(()=>{if(clipboard.readText()===password)clipboard.clear();},30000);
  return {copied:true};
 });
 ipcMain.handle('online:fetch',(_event,url,name)=>services.importRemoteFile(url,name));
 ipcMain.handle('zip:lookup',(_event,zip)=>services.lookupZip(zip));
 ipcMain.handle('zip:floridaCities',()=>services.loadFloridaZipCities());
 ipcMain.handle('zip4:status',event=>{ownerSender(event);return privateBank.bankStatus();});
 ipcMain.handle('zip4:link-variants',(event,records)=>{ownerSender(event);return privateBank.registerAliases(records);});
 ipcMain.handle('smarty:credentials:status',event=>{ownerSender(event);return privateBank.smartyStatus();});
 ipcMain.handle('smarty:credentials:save',(event,credentials)=>{ownerSender(event);return privateBank.saveSmarty(credentials);});
 ipcMain.handle('smarty:credentials:clear',event=>{ownerSender(event);return privateBank.clearSmarty();});
 ipcMain.handle('usps:lookup',(event,input)=>{ownerSender(event);return privateBank.verify({...input,provider:'usps',uspsId:input?.id,uspsSecret:input?.secret});});
 ipcMain.handle('smarty:lookup',(event,input)=>{ownerSender(event);return privateBank.verify({...input,provider:'smarty'});});
 ipcMain.handle('usps:publicLookup',async(_event,address)=>{
  if(!address||typeof address!=='object')throw Error('An address is required.');
  const parts=['address1','address2','city','state','zip'].map(k=>String(address[k]||'').trim());
  if(!parts[0]||parts[0].length>120||!/^[A-Za-z]{2}$/.test(parts[3])||!/^\d{5}(?:-\d{4})?$/.test(parts[4]))throw Error('Provide street, two-letter state and 5-digit ZIP.');
  const line=[parts[0],parts[1],parts[2],parts[3],parts[4]].filter(Boolean).join(', ');
  clipboard.writeText(line);
  await shell.openExternal('https://tools.usps.com/zip-code-lookup.htm?byaddress');
  return {opened:true,copiedAddress:line};
 });
 ipcMain.handle('usps:copyAddressField',(_event,field,value)=>{
  const fields=new Set(['address1','address2','city','state','zip','full']);
  if(!fields.has(field)||typeof value!=='string'||!value.trim()||value.length>280||/[\x00-\x1f]/.test(value))
    throw Error('Only a saved mailing-address field can be copied.');
  clipboard.writeText(value);
  return {copied:true};
 });
 ipcMain.handle('link:provider',(_event,provider)=>{
  const urls={drive:'https://drive.google.com/drive/u/0/my-drive',dropbox:'https://www.dropbox.com/home',onedrive:'https://onedrive.live.com/',cloudflare:'https://dash.cloudflare.com/'};
  if(!Object.hasOwn(urls,provider))throw Error('Unknown provider');
  return shell.openExternal(urls[provider]);
 });
 launch();
 app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)launch();});
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
