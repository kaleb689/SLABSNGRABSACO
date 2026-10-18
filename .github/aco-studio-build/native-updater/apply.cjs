'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(process.argv[2]||'build-src/App');
function edit(file,changes){let text=fs.readFileSync(path.join(root,file),'utf8');for(const [a,b]of changes){if(text.split(a).length!==2)throw Error(file+': expected one integration anchor: '+a.slice(0,90));text=text.replace(a,b);}fs.writeFileSync(path.join(root,file),text);}
const files=['mac-full-updates.js','mac-update-archive.js','mac-full-update.sh','mac-updates-ui.js'];
for(const f of files)fs.copyFileSync(path.join(__dirname,f),path.join(root,f));
fs.mkdirSync(path.join(root,'tests'),{recursive:true});fs.copyFileSync(path.join(__dirname,'mac-full-updates.test.js'),path.join(root,'tests/mac-full-updates.test.js'));
edit('desktop-updates.js',[["function register({app,ipcMain,dialog,BrowserWindow}) {",`function register(options) {
  if(process.platform==='darwin')return require('./mac-full-updates').register(options);
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
 async function openAfterNativeStartup(){
  let splash=null;
  if(process.platform==='darwin'&&!process.argv.includes('--aco-studio-ci-smoke')){
   splash=new BrowserWindow({width:960,height:600,frame:false,resizable:false,skipTaskbar:true,center:true,backgroundColor:'#060918',show:true,
    webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,devTools:false}});
   splash.loadFile(path.join(__dirname,'splash.html')).catch(()=>{});
   try{
    const update=await nativeUpdater.autoStartup();
    if(update?.started)return;
   }catch(error){console.error('Automatic update not installed:',String(error?.message||error));}
   finally{if(splash&&!splash.isDestroyed())splash.close();}
  }
  startupFinished=true;launch();
 }
 void openAfterNativeStartup();
 app.on('activate',()=>{if(startupFinished&&BrowserWindow.getAllWindows().length===0)launch();});`]
]);
edit('preload.js',[["updates:Object.freeze({info:","updates:Object.freeze({nativeMac:process.platform==='darwin',progress:()=>ipcRenderer.invoke('updates:progress'),info:"]]);
edit('updates-ui.js',[["(() => {","(() => {\n if(window.desktopAPI?.updates?.nativeMac)return;"]]);
edit('index.html',[["<script src=\"./updates-ui.js\"></script>","<script src=\"./updates-ui.js\"></script><script src=\"./mac-updates-ui.js\"></script>"]]);
const pkgPath=path.join(root,'package.json'),pkg=JSON.parse(fs.readFileSync(pkgPath,'utf8'));
for(const f of files)if(!pkg.build.files.includes(f))pkg.build.files.push(f);
fs.writeFileSync(pkgPath,JSON.stringify(pkg,null,2)+'\n');
console.log('Mac full-bundle updater integrated; Windows updater and original data directory preserved.');
