'use strict';
// Installed owner-app update handler for Windows and macOS. Updates replace
// app code only; the Electron userData directory and encrypted bank remain separate.
const fs = require('node:fs/promises');
const https = require('node:https');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const APPROVED_HOSTS = new Set(['slabsngrabsaco.onrender.com','slabsngrabsaco.com']);
const PUBLISHED_FEED = 'https://slabsngrabsaco.onrender.com/jigstudio/updates/';
const MAX_MANIFEST = 128 * 1024;
const MAX_DOWNLOAD = 25 * 1024 * 1024;
const MAX_PATCH_FILE = 3 * 1024 * 1024;
const MAX_PATCH_FILES = 45;
const sourcePatcher = require('./owner-patch');
const expectedAppId = 'com.slabsngrabsaco.jigstudio.owner';
let onlineInstallationRunning = false;
const parseVersion = value => {
  const m = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(String(value || ''));
  return m ? m.slice(1).map(Number) : null;
};
const compareVersions = (a,b) => {
  const aa=parseVersion(a),bb=parseVersion(b);
  if(!aa||!bb)throw Error('Update version must contain three numeric parts.');
  for(let i=0;i<3;i++)if(aa[i]!==bb[i])return aa[i]>bb[i]?1:-1;
  return 0;
};
function verifiedUrl(input) {
  let url;
  try { url=new URL(input); } catch { throw Error('Invalid update URL.'); }
  if(url.protocol!=='https:'||!APPROVED_HOSTS.has(url.hostname)||url.username||url.password||url.port&&url.port!=='443')
    throw Error('Update source must use the official SLABSNGRABSACO HTTPS host.');
  return url;
}
function getHttpsBuffer(url,limit) {
  return new Promise((resolve,reject)=>{
    const req=https.get(verifiedUrl(url),{headers:{'Accept':'*/*','User-Agent':'JigStudio-Owner-Updates/4.1'}},res=>{
      if(res.statusCode!==200){res.resume();reject(Error('Update server returned '+res.statusCode+'.'));return;}
      let total=0,chunks=[];
      res.on('data',part=>{total+=part.length;if(total>limit){req.destroy(Error('Update response exceeds maximum size.'));return;}chunks.push(part);});
      res.on('end',()=>resolve(Buffer.concat(chunks)));
      res.on('error',reject);
    });
    req.setTimeout(15000,()=>req.destroy(Error('Update check timed out.')));
    req.on('error',reject);
  });
}
async function readOwnerFeed(app) {
  const configFile=path.join(app.getPath('userData'),'owner-update-source.json');
  let config;
  try { config=JSON.parse(await fs.readFile(configFile,'utf8')); }
  catch(e) { if(e.code==='ENOENT')return PUBLISHED_FEED+(process.platform==='darwin'?'mac':'windows')+'.json';throw Error('Your owner update source file is invalid.'); }
  if(!config || typeof config.manifestUrl!=='string')throw Error('The owner update source has no manifest URL.');
  return verifiedUrl(config.manifestUrl).toString();
}
function validateManifest(json,currentVersion) {
  if(json?.channel!=='owner'||json.appId!==expectedAppId||!parseVersion(json.version))
    throw Error('Update manifest is incomplete or invalid.');
  if(Array.isArray(json.files)){
    if(!json.files.length||json.files.length>MAX_PATCH_FILES)throw Error('Invalid update file count.');
    const seen=new Set();
    const files=json.files.map(f=>{
      const name=String(f?.path||'');
      if(!/^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,149}$/.test(name)||name.includes('..')||name.includes('\\')||name.startsWith('/')||seen.has(name))
        throw Error('Update contains an invalid or duplicate file name.');
      seen.add(name);
      if(typeof f.url!=='string'||!/^[a-f0-9]{64}$/i.test(f.sha256||''))throw Error('Update file checksum is invalid.');
      verifiedUrl(f.url);
      return {path:name,url:f.url,sha256:f.sha256.toLowerCase()};
    });
    if(!seen.has('package.json'))throw Error('Update must include a versioned package.json.');
    return {type:'files',version:json.version,files,available:compareVersions(json.version,currentVersion)>0};
  }
  if(typeof json.url!=='string'||!/^[a-f0-9]{64}$/i.test(json.sha256||''))
    throw Error('Update archive checksum is invalid.');
  verifiedUrl(json.url);
  return {type:'zip',version:json.version,downloadUrl:json.url,sha256:json.sha256.toLowerCase(),
    available:compareVersions(json.version,currentVersion)>0};
}
function connectionStatus(){
 return new Promise(resolve=>{
  const request=https.get(PUBLISHED_FEED,{headers:{'User-Agent':'JigStudio-Owner-Connectivity/4.6'}},res=>{
    const code=res.statusCode;res.resume();
    // An HTTP response proves HTTPS connectivity even if a static route is unavailable.
    resolve({online:true,serverReachable:code>=200&&code<500,httpStatus:code});
  });
  request.setTimeout(9000,()=>request.destroy(Error('Website connection timed out.')));
  request.on('error',error=>resolve({online:false,serverReachable:false,message:error.code==='ENOTFOUND'?'Cannot resolve the website address.':'Unable to reach the website over HTTPS.'}));
 });
}
async function makePatchedZip(manifest){
 return sourcePatcher.prepare({baseDirectory:__dirname,manifest,fetchFile:async url=>getHttpsBuffer(url,MAX_PATCH_FILE),version:manifest.version});
}
async function spawnUpdater(app,script,zipPath) {
  if(!['win32','darwin'].includes(process.platform)||!app.isPackaged)
    throw Error('Install the Jig Studio desktop application before updating in place.');
  await fs.access(script);
  let executable,args;
  if(process.platform==='win32') {
    executable='powershell.exe';
    args=['-NoProfile','-ExecutionPolicy','Bypass','-File',script,
      '-ZipPath',zipPath,'-InstallRoot',path.dirname(process.execPath),
      '-CurrentVersion',app.getVersion(),'-AppProcessId',String(process.pid)];
  } else {
    const bundle=path.resolve(path.dirname(process.execPath),'..','..');
    const expected=path.join(os.homedir(),'Applications','SLABSNGRABSACO Jig Studio.app');
    if(bundle!==expected)throw Error('Mac updates are supported only after installing Jig Studio into your Applications folder.');
    const externalScript=path.join(os.tmpdir(),'jigstudio-mac-update-'+crypto.randomUUID()+'.sh');
    await fs.copyFile(script,externalScript);
    await fs.chmod(externalScript,0o700);
    executable='/bin/bash';
    args=[externalScript,zipPath,expected,app.getVersion(),String(process.pid)];
  }
  const child=spawn(executable,args,{detached:true,windowsHide:true,stdio:'ignore'});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  child.unref();
  setTimeout(()=>app.quit(),300);
  return {started:true,message:'Jig Studio will close, install the update and reopen. Your local bank is not deleted.'};
}
async function checkPublishedUpdate(app) {
  // Do not rely on a shared in-memory manifest: simultaneous checks could clear it
  // after the user saw the Download & install button.
  const url=await readOwnerFeed(app);
  const raw=await getHttpsBuffer(url,MAX_MANIFEST);
  let json;
  try { json=JSON.parse(raw.toString('utf8')); }
  catch { throw Error('Update server returned invalid JSON.'); }
  return validateManifest(json,app.getVersion());
}
function register({app,ipcMain,dialog,BrowserWindow}) {
  const info=()=>({version:app.getVersion(),platform:process.platform,installed:app.isPackaged});
  const updaterScript=path.join(__dirname,process.platform==='darwin'?'mac-update.sh':'windows-update.ps1');
  ipcMain.handle('updates:info',info);
  ipcMain.handle('updates:connection',connectionStatus);
  ipcMain.handle('updates:check',async()=>{
    const manifest=await checkPublishedUpdate(app);
    return {...info(),status:manifest.available?'available':'current',latest:manifest.version,
      message:manifest.available?'New version '+manifest.version+' is ready to download.':'Jig Studio is up to date.'};
  });
  ipcMain.handle('updates:installZip',async event=>{
    if(!['win32','darwin'].includes(process.platform)||!app.isPackaged)throw Error('Install the Jig Studio desktop edition first.');
    const parent=BrowserWindow.fromWebContents(event.sender);
    const choice=await dialog.showOpenDialog(parent,{title:'Choose an official Jig Studio owner update ZIP',properties:['openFile'],filters:[{name:'Jig Studio ZIP update',extensions:['zip']}]});
    if(choice.canceled||!choice.filePaths?.length)return {started:false,cancelled:true};
    return spawnUpdater(app,updaterScript,choice.filePaths[0]);
  });
  ipcMain.handle('updates:installOnline',async()=>{
    if(onlineInstallationRunning)throw Error('A Jig Studio update is already in progress.');
    onlineInstallationRunning=true;
    let prepared=null;
    try {
      // An install always fetches and validates the latest manifest independently.
      // This also handles an expired, overlapping, or missed Check online request.
      const release=await checkPublishedUpdate(app);
      if(!release.available)return {started:false,message:'Jig Studio is already up to date (v'+app.getVersion()+').'};
      if(release.type==='files')prepared=await makePatchedZip(release);
      else{
        const downloaded=await getHttpsBuffer(release.downloadUrl,MAX_DOWNLOAD);
        const hash=crypto.createHash('sha256').update(downloaded).digest('hex');
        if(hash!==release.sha256)throw Error('Update verification failed: the downloaded archive hash does not match the publisher.');
        prepared=path.join(os.tmpdir(),'jigstudio-owner-update-'+crypto.randomUUID()+'.zip');
        await fs.writeFile(prepared,downloaded,{mode:0o600});
      }
      return await spawnUpdater(app,updaterScript,prepared);
    }catch(error){
      if(prepared)await fs.rm(prepared,{force:true});
      throw error;
    }finally{onlineInstallationRunning=false;}
  });
}
module.exports={register,compareVersions,validateManifest};
