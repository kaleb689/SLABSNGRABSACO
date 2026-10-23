'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(process.argv[2]||'build-src/App');
function edit(file,changes){let text=fs.readFileSync(path.join(root,file),'utf8');for(const [a,b]of changes){if(text.split(a).length!==2)throw Error(file+': expected one integration anchor: '+a.slice(0,90));text=text.replace(a,b);}fs.writeFileSync(path.join(root,file),text);}
const files=['mac-full-updates.js','mac-update-archive.js','mac-full-update.sh','mac-updates-ui.js','win-full-updates.js'];
for(const f of files)fs.copyFileSync(path.join(__dirname,f),path.join(root,f));
fs.mkdirSync(path.join(root,'tests'),{recursive:true});for(const f of ['mac-full-updates.test.js','win-full-updates.test.js'])fs.copyFileSync(path.join(__dirname,f),path.join(root,'tests',f));
edit('desktop-updates.js',[["function register({app,ipcMain,dialog,BrowserWindow}) {",`function register(options) {
  if(process.platform==='darwin')return require('./mac-full-updates').register(options);
  if(process.platform==='win32')return require('./win-full-updates').register(options);
  const {app,ipcMain,dialog,BrowserWindow}=options;`]]);
edit('main.js',[
 ["require('./desktop-updates').register({app,ipcMain,dialog,BrowserWindow});","const nativeUpdater=require('./desktop-updates').register({app,ipcMain,dialog,BrowserWindow,requireOwner:ownerSender});"],
 ["app.setName('SLABSNGRABSACO ACO Studio - Owner');",`// Keep the original runtime name and data directory despite the shorter Finder label.
app.setName('SLABSNGRABSACO ACO Studio - Owner');
app.setPath('userData',path.join(app.getPath('appData'),'SLABSNGRABSACO ACO Studio - Owner'));`],
 ["app.whenReady().then(()=>{",`app.whenReady().then(()=>{
 if(process.platform==='darwin')void require('./mac-full-updates').noteLaunch(app).catch(()=>{});`],
 ["win.webContents.once('did-fail-load',showApp);",`win.webContents.once('did-fail-load',showApp);
 let updateHealthy=true;
 win.webContents.once('did-fail-load',()=>{updateHealthy=false;});
 win.webContents.once('render-process-gone',()=>{updateHealthy=false;});
 win.webContents.once('did-finish-load',()=>{
  if(process.platform!=='darwin')return;
  setTimeout(async()=>{
   if(!updateHealthy||win.isDestroyed())return;
   try{
    const ready=await win.webContents.executeJavaScript('Promise.resolve(window.desktopAPI?.updates?.info()).then(i=>Boolean(i?.mode === "full-app" && document.getElementById("jigUpdateButton") && document.getElementById("importPersonalProfiles")))');
    if(ready)await require('./mac-full-updates').markHealthy(app);
   }catch{}
  },3000);
 });`]
]);
// Hold the native workspace behind the normal splash while a verified full
// Mac update is downloaded and installed. A successful update quits/relaunches.
// A network failure must not erase offline/local data or trap the application.
edit('main.js',[
 [" launch();\n app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)launch();});",` let startupFinished=false;
 async function signInAndVerifyAdmin(){
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
 }
 async function openAfterNativeStartup(){
  let splash=null;
  if(['darwin','win32'].includes(process.platform)&&!process.argv.includes('--aco-studio-ci-smoke')&&!process.argv.includes('--aco-ci-self-update')&&!process.argv.some(arg=>arg.startsWith('--aco-update-token='))){
   splash=new BrowserWindow({width:960,height:600,frame:false,resizable:false,skipTaskbar:true,center:true,backgroundColor:'#060918',show:true,
    webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,devTools:false}});
   splash.loadFile(path.join(__dirname,'splash.html')).catch(()=>{});
   try{
    const update=await nativeUpdater.autoStartup();
    if(update?.started)return;
   }catch(error){console.error('Automatic update not installed:',String(error?.message||error));}
   finally{if(splash&&!splash.isDestroyed())splash.close();}
  }
  // The existing website Admin authentication is the program's sign-in.
  // A successful authenticated API read, not merely an open browser window,
  // is required before any protected desktop workspace is created.
  await signInAndVerifyAdmin();
  startupFinished=true;launch();
 }
 void openAfterNativeStartup();
 app.on('activate',()=>{
  if(!startupFinished){siteBridge.signIn();return;}
  if(!ownerWindow||ownerWindow.isDestroyed())void signInAndVerifyAdmin().then(()=>launch()).catch(error=>console.error('Admin sign-in failed:',error.message));
 });`]
]);
edit('main.js',[
 ["ipcMain.handle('site:logout',event=>{ownerSender(event);return siteBridge.logout();});",`ipcMain.handle('site:logout',async event=>{
  ownerSender(event);
  const result=await siteBridge.logout();
  await personalAccess.lock();
  const win=ownerWindow;
  if(win&&!win.isDestroyed())win.hide();
  void signInAndVerifyAdmin().then(async()=>{
   const current=ownerWindow;
   if(!current||current.isDestroyed())return;
   await current.loadFile(path.join(__dirname,'index.html'));
   current.show();current.focus();
  }).catch(error=>console.error('Secure Admin reauthentication error:',String(error?.message||error)));
  return result;
 });`]
]);
edit('preload.js',[["updates:Object.freeze({info:","updates:Object.freeze({nativeMac:process.platform==='darwin',progress:()=>ipcRenderer.invoke('updates:progress'),info:"]]);
edit('site-ui.js',[["renderNotices();renderJigGroups();setConnection(false);","renderNotices();renderJigGroups();setConnection(false);void sync(false);"]]);
edit('updates-ui.js',[["(() => {","(() => {\n if(window.desktopAPI?.updates?.nativeMac)return;"]]);
edit('index.html',[["<script src=\"./updates-ui.js\"></script>","<script src=\"./updates-ui.js\"></script><script src=\"./mac-updates-ui.js\"></script>"]]);
// Website Admin login now runs before the workspace opens. No Connect button is needed.
edit('index.html',[["</head>","<style>#siteConnect{display:none!important}</style></head>"]]);
const pkgPath=path.join(root,'package.json'),pkg=JSON.parse(fs.readFileSync(pkgPath,'utf8'));
for(const f of files)if(!pkg.build.files.includes(f))pkg.build.files.push(f);
// Full NSIS updates require runtime updater dependency in the installed app.
pkg.dependencies={...(pkg.dependencies||{}),'electron-updater':'^6.8.9'};
// One-click per-user installer allows subsequent full updates to run silently.
// The application ID, executable name and existing encrypted userData remain.
pkg.build.win=pkg.build.win||{};
pkg.build.win.artifactName='ACO-Studio-Setup-${version}-${arch}.${ext}';
pkg.build.nsis={...(pkg.build.nsis||{}),oneClick:true,perMachine:false,allowToChangeInstallationDirectory:false};
fs.writeFileSync(pkgPath,JSON.stringify(pkg,null,2)+'\n');
console.log('Mac full-bundle updater integrated; Windows updater and original data directory preserved.');
