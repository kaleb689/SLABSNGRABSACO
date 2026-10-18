'use strict';
// Hosted-Mac integration test. No live customer data; not shipped in the app.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawn,execFile}=require('node:child_process');
const run=require('node:util').promisify(execFile);
const root=path.resolve(process.argv[2]||'build-src/App');
const U=require(path.join(root,'mac-full-updates'));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,ms=120000){const end=Date.now()+ms;while(Date.now()<end){const r=await check();if(r)return r;await pause(500);}throw Error('Timed out waiting for update result.');}
async function main(){
 const version=process.env.ACO_VERSION||'4.13.9',arch=process.arch,previous='4.13.7';
 const dist=path.join(root,'dist'),packageFile=path.join(root,'package.json'),mainFile=path.join(root,'main.js');
 const finalApp=path.join(dist,arch==='arm64'?'mac-arm64':'mac','ACO Studio.app');
 const metadata=await U.bundleMetadata(finalApp);if(metadata.version!==version)throw Error('Real app version mismatch.');
 const archive=path.join(dist,`ACO-Studio-${version}-${arch}.zip`),size=(await fs.stat(archive)).size,sha256=await U.sha256File(archive);
 const signing=metadata.team?'developer-id':'adhoc',mode=metadata.team?'notarized':'adhoc';
 const manifest={schema:1,channel:'owner',appId:U.APP_ID,version,platforms:{['darwin-'+arch]:{url:`https://github.com/kaleb689/SLABSNGRABSACO/releases/download/aco-studio-v${version}-macos-${mode}/ACO-Studio-${version}-${arch}.zip`,size,sha256,bundleName:'ACO Studio.app',signing}}};
 const originalMain=await fs.readFile(mainFile),originalPackage=await fs.readFile(packageFile);
 const fixtureMain=`'use strict';
const {app}=require('electron'),fs=require('node:fs/promises'),path=require('node:path');
app.setName('SLABSNGRABSACO ACO Studio - Owner');
app.setPath('userData',path.join(app.getPath('appData'),'SLABSNGRABSACO ACO Studio - Owner'));
app.whenReady().then(async()=>{
 const arg=process.argv.find(x=>x.startsWith('--aco-test-config='));
 if(!arg)throw Error('Test configuration missing');
 const c=JSON.parse(await fs.readFile(arg.slice('--aco-test-config='.length),'utf8'));
 const U=require(c.module);
 const updater=U.createMacUpdater({app,loadFeed:async()=>c.manifest,downloadFile:async(_u,o)=>{await fs.copyFile(c.archive,o.file);o.onProgress(c.manifest.platforms['darwin-'+process.arch].size,c.manifest.platforms['darwin-'+process.arch].size);}});
 updater.onProgress(x=>console.log('TEST_UPDATE_PROGRESS '+x.phase+' '+x.message));
 if((await updater.check()).status!=='available')throw Error('Update not offered');
 await updater.install();
}).catch(e=>{console.error(e.stack);app.exit(1);});`;
 const cwd=process.cwd();
 try{
  const pkg=JSON.parse(originalPackage);pkg.version=previous;
  await fs.writeFile(packageFile,JSON.stringify(pkg,null,2));await fs.writeFile(mainFile,fixtureMain);
  // electron-builder resolves relative hook imports from cwd, not projectDir.
  process.chdir(root);
  const {build,Platform}=require(path.join(root,'node_modules/electron-builder'));
  await build({projectDir:root,targets:Platform.MAC.createTarget(['dir']),publish:'never',config:{directories:{output:'fixture-dist'}}});
 }finally{process.chdir(cwd);await fs.writeFile(mainFile,originalMain);await fs.writeFile(packageFile,originalPackage);}
 const fixture=path.join(root,'fixture-dist',arch==='arm64'?'mac-arm64':'mac','ACO Studio.app');
 const target=path.join(os.homedir(),'Applications','ACO Studio.app');
 await fs.mkdir(path.dirname(target),{recursive:true});
 try{await fs.access(target);throw Error('Refusing to overwrite an existing runner installation.');}catch(e){if(e.code!=='ENOENT')throw e;}
 await run('/usr/bin/ditto',[fixture,target]);
 if((await U.bundleMetadata(target)).version!==previous)throw Error('Previous-version fixture is invalid.');
 const data=path.join(os.homedir(),'Library/Application Support/SLABSNGRABSACO ACO Studio - Owner');await fs.mkdir(data,{recursive:true});
 const sentinels=path.join(data,'update-preservation-fixtures');await fs.mkdir(sentinels,{recursive:true});
 const before={};for(const n of ['personal-profiles.bin','customer-profiles.bin','personal-cards.bin','settings.json']){const b=crypto.randomBytes(256);await fs.writeFile(path.join(sentinels,n),b);before[n]=b;}
 await fs.writeFile(path.join(data,'owner-update-source.json'),'legacy broken feed is intentionally ignored by the new Mac updater');
 const config=path.join(root,'ci-update-test-config.json');await fs.writeFile(config,JSON.stringify({module:path.join(finalApp,'Contents/Resources/app/mac-full-updates.js'),manifest,archive}),{mode:0o600});
 const child=spawn(path.join(target,'Contents/MacOS/ACO Studio'),['--aco-test-config='+config],{stdio:'inherit'});
 const statusFile=path.join(data,'aco-native-update-status.json');
 const result=await until(async()=>{try{const s=JSON.parse(await fs.readFile(statusFile,'utf8'));if(['failed','rolledback'].includes(s.phase))throw Error('Self-update failed: '+s.message);return s.phase==='installed'?s:false;}catch(e){if(e.code==='ENOENT'){if(child.exitCode!==null)throw Error('Update fixture exited before writing a result: '+child.exitCode);return false;}throw e;}},180000);
 if((await U.bundleMetadata(target)).version!==version)throw Error('Installed version incorrect.');
 for(const [n,b]of Object.entries(before))if(!(await fs.readFile(path.join(sentinels,n))).equals(b))throw Error('Saved data changed: '+n);
 const pid=Number(await fs.readFile(path.join(data,'aco-native-updates',result.token,'started.pid'),'utf8'));
 await pause(20000);process.kill(pid,0);
 console.log('PASS: full-app update '+previous+' -> '+version+', actual restart, 20-second survival, signature and Personal/customer/card/settings preservation.');
 process.kill(pid,'SIGTERM');await pause(2500);
 if(child.exitCode===null)await new Promise(r=>child.once('exit',r));
 // A validly signed but immediately exiting app exercises the real rollback path.
 const token=crypto.randomUUID(),work=path.join(data,'aco-native-updates',token),stage=path.join(path.dirname(target),'.ACO-Studio-incoming-'+token+'.app');
 const parts=version.split('.').map(Number);parts[2]++;
 const next=parts.join('.');await fs.mkdir(path.join(stage,'Contents/MacOS'),{recursive:true});await fs.mkdir(work,{recursive:true,mode:0o700});
 await fs.copyFile('/usr/bin/false',path.join(stage,'Contents/MacOS/ExitImmediately'));await fs.chmod(path.join(stage,'Contents/MacOS/ExitImmediately'),0o755);
 const plist=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${U.APP_ID}</string><key>CFBundleName</key><string>ACO Studio</string><key>CFBundleExecutable</key><string>ExitImmediately</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${next}</string><key>CFBundleVersion</key><string>${next}</string></dict></plist>`;
 await fs.writeFile(path.join(stage,'Contents/Info.plist'),plist);await run('/usr/bin/codesign',['--force','--sign','-',stage]);
 await fs.writeFile(statusFile,JSON.stringify({phase:'ready',currentVersion:version,targetVersion:next,token}));
 let exitCode=0;try{await run('/bin/bash',[path.join(root,'mac-full-update.sh'),work,target,String(pid),version,next,token,statusFile,'8'],{timeout:45000});}catch(e){exitCode=e.code;}
 const rolled=JSON.parse(await fs.readFile(statusFile,'utf8'));
 if(!exitCode||rolled.phase!=='rolledback')throw Error('Broken startup did not roll back: '+JSON.stringify(rolled));
 if((await U.bundleMetadata(target)).version!==version)throw Error('Rollback did not restore the prior version.');
 for(const [n,b]of Object.entries(before))if(!(await fs.readFile(path.join(sentinels,n))).equals(b))throw Error('Rollback changed data: '+n);
 console.log('PASS: failed launch automatically restores the prior signed application without changing saved data.');
 await fs.writeFile(path.join(dist,'update-test-'+arch+'.json'),JSON.stringify({version,architecture:arch,previous,update:true,restart:true,rollback:true,dataPreserved:true,testsPassedAt:new Date().toISOString()}));
}
main().catch(e=>{console.error(e.stack);process.exit(1);});
