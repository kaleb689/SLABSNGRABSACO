'use strict';
// The owner app installs only official, versioned Windows NSIS releases.
// electron-updater verifies SHA-512 against the HTTPS release feed and uses
// the NSIS full-bundle replacement. No patching of installed JS or userData.
const FEED='https://github.com/kaleb689/SLABSNGRABSACO/releases/download/aco-studio-windows-updates';
const MODES=new Set(['checking','downloading','installing','current','failed','idle']);
function makeStartupEngine({app,updater,timeoutMs=600000}={}){
 if(!app||!updater||typeof updater.checkForUpdates!=='function')throw Error('Windows auto-updater requires a packaged app and update provider.');
 let state={phase:'idle',message:''},inFlight=null;
 const emit=(phase,message,extra={})=>{if(!MODES.has(phase))throw Error('Unknown update phase');state={phase,message,...extra};};
 updater.autoDownload=true;updater.autoInstallOnAppQuit=false;updater.allowDowngrade=false;updater.allowPrerelease=false;
 updater.setFeedURL({provider:'generic',url:FEED});
 async function check(){
  if(!app.isPackaged)return {...info(),status:'current',latest:app.getVersion(),message:'Installed development build.'};
  if(inFlight)return {...info(),status:state.phase==='downloading'||state.phase==='installing'?'available':'current',latest:state.version||app.getVersion(),message:state.message||'An update operation is already running.'};
  const previousAutoDownload=updater.autoDownload;
  updater.autoDownload=false;
  emit('checking','Checking the official ACO Studio Windows update feed...');
  return new Promise((resolve,reject)=>{
   let done=false,timeout;const listeners=[];
   const on=(event,handler)=>{updater.on(event,handler);listeners.push([event,handler]);};
   const cleanup=()=>{clearTimeout(timeout);for(const [event,handler] of listeners)updater.removeListener(event,handler);updater.autoDownload=previousAutoDownload;};
   const finish=value=>{if(done)return;done=true;cleanup();resolve(value);};
   on('update-available',details=>{const latest=String(details?.version||'').slice(0,32);emit('current','ACO Studio '+latest+' is available.',{version:latest});finish({...info(),status:'available',latest,message:'ACO Studio '+latest+' is available. Click Download & install to update now.'});});
   on('update-not-available',details=>{const latest=String(details?.version||app.getVersion()).slice(0,32);emit('current','ACO Studio is up to date.',{version:latest});finish({...info(),status:'current',latest,message:'ACO Studio is up to date.'});});
   on('error',error=>{const message=String(error?.message||error);emit('failed',message);if(!done){done=true;cleanup();reject(Error(message));}});
   timeout=setTimeout(()=>{const message='Update check timed out; the current app was retained.';emit('failed',message);if(!done){done=true;cleanup();reject(Error(message));}},45000);
   Promise.resolve().then(()=>updater.checkForUpdates()).catch(error=>{const message=String(error?.message||error);emit('failed',message);if(!done){done=true;cleanup();reject(Error(message));}});
  });
 }
 async function autoStartup(){
  if(!app.isPackaged)return {started:false,skipped:'development'};
  updater.autoDownload=true;
  if(inFlight)return inFlight;
  inFlight=new Promise(resolve=>{
   let done=false,downloadStarted=false,timeout;
   const listeners=[];
   const on=(event,handler)=>{updater.on(event,handler);listeners.push([event,handler]);};
   const clear=()=>{clearTimeout(timeout);for(const [event,handler] of listeners)updater.removeListener(event,handler);};
   const finish=result=>{if(done)return;done=true;clear();resolve(result);};
   on('checking-for-update',()=>emit('checking','Checking the official ACO Studio Windows update feed...'));
   on('update-available',details=>{downloadStarted=true;emit('downloading','Downloading the verified ACO Studio update...', {version:String(details?.version||'').slice(0,32)});});
   on('download-progress',details=>emit('downloading','Downloading verified ACO Studio...', {percent:Math.round(Number(details?.percent)||0)}));
   on('update-not-available',()=>{emit('current','ACO Studio is current.');finish({started:false,current:true});});
   on('update-downloaded',details=>{
    emit('installing','Verified Windows installer downloaded. Restarting ACO Studio...', {version:String(details?.version||'').slice(0,32)});
    finish({started:true,relaunching:true});
    // Quit immediately after the installer is verified and staged, before
    // protected customer data or the desktop workspace are opened.
    setImmediate(()=>{try{updater.quitAndInstall(true,true);}catch(error){emit('failed','Unable to start the Windows installer: '+error.message);}});
   });
   on('error',error=>{emit('failed',String(error?.message||error));finish({started:false,error:String(error?.message||error)});});
   timeout=setTimeout(()=>{
    emit('failed',downloadStarted?'Update download timed out; the current app was retained.':'Update check timed out; the current app was retained.');
    finish({started:false,timeout:true});
   },timeoutMs);
   emit('checking','Checking the official ACO Studio Windows update feed...');
   Promise.resolve().then(()=>updater.checkForUpdates()).catch(error=>{
    emit('failed',String(error?.message||error));finish({started:false,error:String(error?.message||error)});
   });
  });
  try{return await inFlight;}finally{inFlight=null;}
 }
 const info=()=>({version:app.getVersion(),platform:'win32',installed:app.isPackaged,mode:'full-app',feed:FEED});
 return {check,autoStartup,progress:()=>({...state}),info};
}
function register({app,ipcMain,requireOwner}){
 if(process.platform!=='win32')throw Error('Windows updater is Windows-only.');
 if(typeof requireOwner!=='function')throw Error('Updater requires protected owner window.');
 const {autoUpdater}=require('electron-updater');
 const engine=makeStartupEngine({app,updater:autoUpdater});
 const owner=event=>{requireOwner(event);if(event.senderFrame&&event.senderFrame!==event.sender.mainFrame)throw Error('Only the main desktop window may inspect updater state.');};
 ipcMain.handle('updates:info',event=>{owner(event);return engine.info();});
 ipcMain.handle('updates:progress',event=>{owner(event);return engine.progress();});
 ipcMain.handle('updates:lastResult',event=>{owner(event);return engine.progress();});
 ipcMain.handle('updates:check',event=>{owner(event);return engine.check();});
 ipcMain.handle('updates:connection',event=>{owner(event);return {online:true,serverReachable:true,checkedAt:null};});
 ipcMain.handle('updates:installOnline',event=>{owner(event);return engine.autoStartup();});
 return engine;
}
module.exports={makeStartupEngine,register,FEED};
