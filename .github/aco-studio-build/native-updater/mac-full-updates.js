'use strict';
// Mac full-bundle updater. No source-file patching, re-signing, quarantine removal,
// external Node installation, or changes to customer/Personal storage.
const fs=require('node:fs/promises'),fsSync=require('node:fs'),path=require('node:path');
const os=require('node:os'),https=require('node:https'),crypto=require('node:crypto');
const {spawn,execFile}=require('node:child_process');
const run=require('node:util').promisify(execFile);
const {inspectArchive,verifyExtractedLinks,MAX_ARCHIVE}=require('./mac-update-archive');
const APP_ID='com.slabsngrabsaco.jigstudio.owner';
const FEED='https://github.com/kaleb689/SLABSNGRABSACO/releases/download/aco-studio-macos-updates/mac-update.json';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const VERSION=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function compare(a,b){
 if(!VERSION.test(a)||!VERSION.test(b))throw Error('Invalid update version.');
 const aa=a.split('.').map(BigInt),bb=b.split('.').map(BigInt);
 for(let i=0;i<3;i++)if(aa[i]!==bb[i])return aa[i]>bb[i]?1:-1;
 return 0;
}
function validateManifest(j,current,arch=process.arch){
 if(j?.schema!==1||j.channel!=='owner'||j.appId!==APP_ID||!VERSION.test(j.version)||!['arm64','x64'].includes(arch))throw Error('Invalid ACO Studio Mac update manifest.');
 const a=j.platforms?.['darwin-'+arch];
 if(!a||!Number.isSafeInteger(a.size)||a.size<1000000||a.size>MAX_ARCHIVE||!/^[a-f0-9]{64}$/.test(a.sha256||'')||a.bundleName!=='ACO Studio.app'||!['adhoc','developer-id'].includes(a.signing))throw Error('The update has no valid package for this Mac.');
 const mode=a.signing==='adhoc'?'adhoc':'notarized';
 const expected=`https://github.com/kaleb689/SLABSNGRABSACO/releases/download/aco-studio-v${j.version}-macos-${mode}/ACO-Studio-${j.version}-${arch}.zip`;
 if(a.url!==expected)throw Error('Update package is not from the fixed official repository release.');
 return {...a,version:j.version,arch,available:compare(j.version,current)>0,notes:String(j.notes||'').slice(0,800)};
}
function trustedURL(input,{redirect=false}={}){
 let u;try{u=new URL(input);}catch{throw Error('Invalid update URL.');}
 if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443')||u.hash)throw Error('Update downloads require trusted HTTPS.');
 const first=u.hostname==='github.com'&&u.pathname.startsWith('/kaleb689/SLABSNGRABSACO/releases/download/');
 const cdn=redirect&&['release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(u.hostname);
 if(!first&&!cdn)throw Error('Untrusted update download host.');
 return u;
}
function response(url,redirects=0){
 const u=trustedURL(url,{redirect:redirects>0});
 return new Promise((resolve,reject)=>{
  const req=https.get(u,{headers:{'User-Agent':'ACO-Studio-Mac-Updater/1','Accept':'application/octet-stream','Cache-Control':'no-cache'}},res=>{
   if([301,302,303,307,308].includes(res.statusCode)){
    res.resume();if(redirects>=5||!res.headers.location)return reject(Error('Too many update download redirects.'));
    let next;try{next=new URL(res.headers.location,u).href;trustedURL(next,{redirect:true});}catch(e){reject(e);return;}
    response(next,redirects+1).then(resolve,reject);return;
   }
   if(res.statusCode!==200){res.resume();reject(Error('Update server returned HTTP '+res.statusCode+'. Please try again later.'));return;}
   resolve(res);
  });
  req.setTimeout(30000,()=>req.destroy(Error('Update server timed out.')));
  req.on('error',reject);
 });
}
async function transfer(url,{file=null,max=128*1024,size=null,onProgress=()=>{}}={}){
 const res=await response(url);let h=null,total=0;const chunks=[];
 const timer=setTimeout(()=>res.destroy(Error('Update download exceeded ten minutes.')),600000);
 try{
  const advertised=Number(res.headers['content-length']||0);
  if(advertised>max||(size!==null&&advertised&&advertised!==size))throw Error('Update download size differs from its manifest.');
  if(file)h=await fs.open(file,'wx',0o600);
  for await(const chunk of res){
   total+=chunk.length;if(total>max||(size!==null&&total>size))throw Error('Update response is too large.');
   if(h){let at=0;while(at<chunk.length){const w=await h.write(chunk,at,chunk.length-at);at+=w.bytesWritten;}}
   else chunks.push(chunk);
   onProgress(total,size||advertised);
  }
  if(size!==null&&total!==size)throw Error('Update download is incomplete.');
  if(h)await h.sync();
  return file?total:Buffer.concat(chunks);
 } finally {clearTimeout(timer);res.destroy();if(h)await h.close();}
}
async function readFeed(){const b=await transfer(FEED);try{return JSON.parse(b.toString('utf8'));}catch{throw Error('The Mac update feed is not valid JSON.');}}
async function sha256File(file){const h=crypto.createHash('sha256');for await(const b of fsSync.createReadStream(file))h.update(b);return h.digest('hex');}
async function atomicJSON(file,value){await fs.writeFile(file+'.tmp',JSON.stringify(value),{mode:0o600});await fs.rename(file+'.tmp',file);}
function bundleFromExecutable(executable){return path.resolve(path.dirname(executable),'..','..');}
function approvedTarget(target,home=os.homedir()){
 const names=['ACO Studio.app','SLABSNGRABSACO ACO Studio.app'];
 return ['/Applications',path.join(home,'Applications')].some(p=>names.some(n=>target===path.join(p,n)));
}
async function architectures(executable){
 const h=await fs.open(executable,'r');try{
  const b=Buffer.alloc(4096),{bytesRead}=await h.read(b,0,4096,0);if(bytesRead<12)throw Error('App executable is truncated.');
  const ids=[],magic=b.readUInt32BE(0);
  if([0xcafebabe,0xcafebabf].includes(magic)){
   const count=b.readUInt32BE(4),stride=magic===0xcafebabf?32:20;if(!count||count>8||8+count*stride>bytesRead)throw Error('Invalid universal app header.');
   for(let i=0;i<count;i++)ids.push(b.readUInt32BE(8+i*stride));
  }else if(b.readUInt32LE(0)===0xfeedfacf)ids.push(b.readUInt32LE(4));
  else throw Error('Update executable is not a supported Mac application.');
  return ids.map(x=>x===0x0100000c?'arm64':x===0x01000007?'x64':'unknown');
 }finally{await h.close();}
}
async function bundleMetadata(bundle){
 const plist=path.join(bundle,'Contents/Info.plist');
 async function key(k){return (await run('/usr/libexec/PlistBuddy',['-c','Print :'+k,plist])).stdout.trim();}
 const id=await key('CFBundleIdentifier'),version=await key('CFBundleShortVersionString'),exe=await key('CFBundleExecutable');
 if(id!==APP_ID||!VERSION.test(version)||!/^[A-Za-z0-9 ._()-]{1,150}$/.test(exe))throw Error('Update app identity or version is invalid.');
 await run('/usr/bin/codesign',['--verify','--deep','--strict',bundle],{maxBuffer:8*1024*1024});
 const sig=await run('/usr/bin/codesign',['-dv','--verbose=4',bundle]);
 const team=/^TeamIdentifier=(.+)$/m.exec(sig.stderr+'\n'+sig.stdout)?.[1]||'';
 const declared=JSON.parse(await fs.readFile(path.join(bundle,'Contents/Resources/app/package.json'),'utf8'));
 if(declared.version!==version||declared.name!=='slabsngrabsaco-jig-studio'||declared.main!=='main.js')throw Error('App bundle and packaged application do not match.');
 return {id,version,team:team==='not set'?'':team,arch:await architectures(path.join(bundle,'Contents/MacOS',exe))};
}
async function waitReady(file,child,timeout=45000){
 const until=Date.now()+timeout;
 while(Date.now()<until){
  try{if((await fs.readFile(file,'utf8'))==='ready')return;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(child.exitCode!==null||child.signalCode!==null)throw Error('The Mac installer stopped before it was ready; your app was left open.');
  await new Promise(r=>setTimeout(r,200));
 }
 throw Error('Mac installer did not confirm readiness; your app was left open.');
}
function createMacUpdater({app,execPath=process.execPath,arch=process.arch,loadFeed=readFeed,downloadFile=transfer,launch=spawn}={}){
 const data=app.getPath('userData'),statusFile=path.join(data,'aco-native-update-status.json'),pendingFile=path.join(data,'aco-native-update-pending.json');
 let busy=false,progress={phase:'idle',message:''},subscribers=new Set();
 const emit=(phase,message,extra={})=>{progress={phase,message,...extra};for(const cb of subscribers)try{cb(progress);}catch{}};
 async function info(){return {version:app.getVersion(),platform:'darwin',arch,installed:app.isPackaged,mode:'full-app',feed:FEED};}
 async function check(){
  const release=validateManifest(await loadFeed(),app.getVersion(),arch);
  return {...await info(),status:release.available?'available':'current',latest:release.version,
   message:release.available?'ACO Studio '+release.version+' is ready. Download, install and restart from this panel.':'ACO Studio is up to date.',notes:release.notes};
 }
 async function autoStartup(){
  if(!app.isPackaged)return {started:false,skipped:'development'};
  const release=await check();
  if(release.status!=='available')return {started:false,current:true};
  // ACO Studio is owner-operated. This is invoked during native boot,
  // before the workspace or website sign-in is shown. Downloaded packages
  // still pass the same feed, checksum, signature, identity and rollback
  // validations as an interactive update.
  return install();
 }
 async function lastResult(){
  try{const v=JSON.parse(await fs.readFile(statusFile,'utf8'));if(!UUID.test(v.token||''))return null;
   return {phase:String(v.phase||'').slice(0,30),currentVersion:String(v.currentVersion||'').slice(0,32),targetVersion:String(v.targetVersion||'').slice(0,32),message:String(v.message||'').slice(0,400),logFile:path.join(data,'aco-native-updates',v.token,'install.log')};
  }catch{return null;}
 }
 async function acquireLock(token){
  await fs.mkdir(data,{recursive:true});const file=path.join(data,'aco-native-update.lock');
  for(let i=0;i<2;i++)try{await fs.writeFile(file,token+':'+process.pid,{flag:'wx',mode:0o600});return file;}
  catch(e){
   if(e.code!=='EEXIST')throw e;
   const old=await fs.readFile(file,'utf8');const pid=Number(old.split(':')[1]);
   if(!Number.isSafeInteger(pid)||pid<1)throw Error('An update lock needs review before another installation.');
   let alive=true;try{process.kill(pid,0);}catch(err){if(err.code==='ESRCH')alive=false;}
   if(alive)throw Error('Another ACO Studio update is already in progress.');
   await fs.unlink(file);
  }
  throw Error('Unable to obtain the update lock.');
 }
 async function install({localZip=null}={}){
  if(busy)throw Error('An ACO Studio update is already in progress.');
  busy=true;const token=crypto.randomUUID(),work=path.join(data,'aco-native-updates',token);
  const target=bundleFromExecutable(execPath),stage=path.join(path.dirname(target),'.ACO-Studio-incoming-'+token+'.app');
  let lock=null,helper=null,started=false;
  try{
   if(!app.isPackaged)throw Error('Install ACO Studio before using in-app updates.');
   if(!approvedTarget(target)){
    if(typeof app.moveToApplicationsFolder!=='function')throw Error('ACO Studio must be installed in Applications before updating.');
    emit('installing','Moving ACO Studio to Applications so in-app updates can work...');
    let moved=false;
    try{moved=app.moveToApplicationsFolder({conflictHandler:()=>true});}
    catch(error){throw Error('Could not move ACO Studio to Applications: '+String(error?.message||error));}
    if(!moved)throw Error('ACO Studio needs to be in Applications to update. The move was cancelled.');
    return {started:true,relaunching:true,message:'ACO Studio was moved to Applications and is restarting. Open Updates again after restart to finish the update.'};
   }
   if((await fs.lstat(target)).isSymbolicLink())throw Error('Update the installed app, not an application symlink.');
   await fs.access(path.dirname(target),fsSync.constants.W_OK);
   emit('checking','Checking the official Mac update feed...');
   const release=validateManifest(await loadFeed(),app.getVersion(),arch);
   if(!release.available){emit('current','ACO Studio is up to date.');return {started:false,message:'ACO Studio is already up to date.'};}
   lock=await acquireLock(token);await fs.mkdir(work,{recursive:true,mode:0o700});
   const archive=path.join(work,'release.zip');
   emit('downloading','Downloading ACO Studio '+release.version+'...', {percent:0});
   if(localZip)await fs.copyFile(localZip,archive,fsSync.constants.COPYFILE_EXCL);
   else{let last=0;await downloadFile(release.url,{file:archive,max:MAX_ARCHIVE,size:release.size,onProgress:(n,total)=>{
    const now=Date.now();if(now-last<150&&n!==total)return;last=now;emit('downloading','Downloading the complete application...', {percent:total?Math.floor(n*100/total):0});
   }});}
   if((await fs.stat(archive)).size!==release.size||await sha256File(archive)!==release.sha256)throw Error('Downloaded update does not match the published size and SHA-256. Nothing was installed.');
   emit('validating','Verifying the application, architecture and code signature...');
   await inspectArchive(archive);
   const extracted=path.join(work,'extracted');await fs.mkdir(extracted,{mode:0o700});
   await run('/usr/bin/ditto',['-x','-k',archive,extracted],{timeout:180000});
   const source=path.join(extracted,'ACO Studio.app');await verifyExtractedLinks(source);
   const [next,current]=await Promise.all([bundleMetadata(source),bundleMetadata(target)]);
   if(current.version!==app.getVersion())throw Error('The installed app changed during this session. Restart it before updating.');
   if(next.version!==release.version||!next.arch.includes(arch))throw Error('The new app has the wrong version or Mac architecture.');
   if(current.team&&next.team!==current.team)throw Error('Update signing identity changed. A signed app cannot downgrade to an ad-hoc or different publisher.');
   if(release.signing==='developer-id'&&!next.team)throw Error('The update is missing its declared Developer ID.');
   await run('/usr/bin/ditto',[source,stage],{timeout:180000});
   await bundleMetadata(stage);
   const pending={token,target,version:release.version,currentVersion:app.getVersion(),createdAt:Date.now()};
   await atomicJSON(pendingFile,pending);
   await atomicJSON(statusFile,{phase:'ready',currentVersion:app.getVersion(),targetVersion:release.version,message:'Update verified. Waiting for a safe app restart.',token});
   const script=path.join(work,'install.sh');await fs.copyFile(path.join(__dirname,'mac-full-update.sh'),script);await fs.chmod(script,0o700);
   const fd=fsSync.openSync(path.join(work,'install.log'),'a',0o600);
   try{helper=launch('/bin/bash',[script,work,target,String(process.pid),app.getVersion(),release.version,token,statusFile],{detached:true,stdio:['ignore',fd,fd],cwd:work});}
   finally{fsSync.closeSync(fd);}
   await new Promise((resolve,reject)=>{helper.once('spawn',resolve);helper.once('error',reject);});
   await waitReady(path.join(work,'ready'),helper);
   helper.unref();started=true;
   emit('installing','Update verified. Restarting ACO Studio; your saved data will be retained.');
   setTimeout(()=>app.quit(),350);
   return {started:true,message:'Verified update ready. ACO Studio will close, install the complete app and reopen. Personal and customer data stay in their existing separate locations.'};
  }catch(e){
   if(helper&&!started)helper.kill('SIGTERM');
   emit('failed',e.message);
   if(lock)await atomicJSON(statusFile,{phase:'failed',currentVersion:app.getVersion(),targetVersion:'',message:e.message,token}).catch(()=>{});
   throw e;
  }finally{
   if(!started){busy=false;if(lock)await fs.unlink(lock).catch(()=>{});await fs.rm(stage,{recursive:true,force:true}).catch(()=>{});}
  }
 }
 return {info,check,autoStartup,install,lastResult,onProgress:cb=>{subscribers.add(cb);return()=>subscribers.delete(cb);},progress:()=>({...progress,busy})};
}
async function pendingLaunch(app){
 const arg=process.argv.find(x=>x.startsWith('--aco-update-token=')),token=arg?.split('=')[1];
 if(!UUID.test(token||''))return null;
 try{
  const data=app.getPath('userData'),p=JSON.parse(await fs.readFile(path.join(data,'aco-native-update-pending.json'),'utf8'));
  if(p.token!==token||p.version!==app.getVersion()||p.target!==bundleFromExecutable(process.execPath)||!approvedTarget(p.target)||Date.now()-p.createdAt>15*60000)return null;
  return {work:path.join(data,'aco-native-updates',token),version:p.version};
 }catch{return null;}
}
async function noteLaunch(app){const p=await pendingLaunch(app);if(p)await fs.writeFile(path.join(p.work,'started.pid'),String(process.pid),{mode:0o600});}
async function markHealthy(app){const p=await pendingLaunch(app);if(p)await fs.writeFile(path.join(p.work,'healthy'),p.version,{mode:0o600});}
function register({app,ipcMain,dialog,BrowserWindow,requireOwner}){
 if(typeof requireOwner!=='function')throw Error('Mac updater requires the local owner-window gate.');
 const engine=createMacUpdater({app});
 const guard=(event)=>{requireOwner(event);if(event.senderFrame&&event.senderFrame!==event.sender.mainFrame)throw Error('Only the main desktop page may update this app.');};
 const handler=(channel,fn)=>ipcMain.handle(channel,async(event,...args)=>{guard(event);return fn(event,...args);});
 handler('updates:info',()=>engine.info());handler('updates:lastResult',()=>engine.lastResult());
 handler('updates:progress',()=>engine.progress());handler('updates:check',()=>engine.check());
 handler('updates:connection',async()=>{try{await readFeed();return {online:true,serverReachable:true};}catch(e){return {online:false,serverReachable:false,message:e.message};}});
 async function approve(event){const r=await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender),{type:'question',title:'Update ACO Studio',message:'Install the verified update and restart?',detail:'Save or export any unsaved work first. Only the application is replaced. Saved Personal profiles, customer banks and settings stay in place.',buttons:['Cancel','Install & Restart'],defaultId:0,cancelId:0});return r.response===1;}
 handler('updates:installOnline',async event=>{if(!await approve(event))return {started:false,cancelled:true,message:'Update cancelled. Nothing changed.'};return engine.install();});
 handler('updates:installZip',async event=>{
  const choice=await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender),{title:'Choose the current official full-app update ZIP',properties:['openFile'],filters:[{name:'ACO Studio Mac ZIP',extensions:['zip']}]});
  if(choice.canceled||!choice.filePaths?.length)return {started:false,cancelled:true};
  if(!await approve(event))return {started:false,cancelled:true};return engine.install({localZip:choice.filePaths[0]});
 });
 engine.onProgress(state=>{for(const w of BrowserWindow.getAllWindows())if(!w.isDestroyed()&&w.webContents.getURL().startsWith('file:'))w.webContents.send('updates:progress',state);});
 return engine;
}
module.exports={register,createMacUpdater,readFeed,transfer,validateManifest,trustedURL,compare,approvedTarget,bundleFromExecutable,bundleMetadata,architectures,sha256File,noteLaunch,markHealthy,FEED,APP_ID};
