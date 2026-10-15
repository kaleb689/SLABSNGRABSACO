'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises');
const path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const U=require('../mac-full-updates'),Z=require('../mac-update-archive');
function manifest(version='4.13.8',arch='arm64') {return {schema:1,channel:'owner',appId:U.APP_ID,version,platforms:{['darwin-'+arch]:{url:`https://github.com/kaleb689/SLABSNGRABSACO/releases/download/aco-studio-v${version}-macos-adhoc/ACO-Studio-${version}-${arch}.zip`,size:123456789,sha256:'a'.repeat(64),bundleName:'ACO Studio.app',signing:'adhoc'}}};}
test('Mac manifest selects native architecture and never considers an older version available',()=>{
 assert.equal(U.validateManifest(manifest(),'4.13.7','arm64').available,true);
 assert.equal(U.validateManifest(manifest(),'4.13.8','arm64').available,false);
 assert.equal(U.validateManifest(manifest(),'4.13.9','arm64').available,false);
 assert.equal(U.validateManifest(manifest('4.13.8','x64'),'4.13.7','x64').arch,'x64');
 assert.throws(()=>U.validateManifest(manifest(),'4.13.7','x64'));
});
test('Reject wrong app/channel/schema, unsigned size/digest metadata and substituted download destinations',()=>{
 for(const [key,value]of Object.entries({appId:'other.app',channel:'public',schema:2,version:'4.13.08'}))assert.throws(()=>U.validateManifest({...manifest(),[key]:value},'4.13.7','arm64'));
 for(const [key,value]of Object.entries({url:'https://github.com/attacker/repo/update.zip',sha256:'no',size:0,bundleName:'Other.app',signing:'unsigned'})){
  const m=manifest();m.platforms['darwin-arm64'][key]=value;assert.throws(()=>U.validateManifest(m,'4.13.7','arm64'));
 }
 assert.throws(()=>U.validateManifest({channel:'owner',appId:U.APP_ID,version:'4.13.8',files:[{path:'main.js'}]},'4.13.7','arm64'));
});
test('Version compare is numeric, strict and does not overflow',()=>{
 assert.equal(U.compare('4.13.10','4.13.9'),1);assert.equal(U.compare('4.13.8','4.13.8'),0);
 assert.equal(U.compare('100000000000000000000.1.0','99999999999999999999.2.0'),1);
 for(const bad of ['4.1','4.1.2-beta','04.1.2','4.1.2\n','../4.1.2'])assert.throws(()=>U.compare(bad,'4.1.2'));
});
test('HTTPS download host and redirects stay within the official GitHub publication path',()=>{
 assert.equal(U.trustedURL(U.FEED).hostname,'github.com');
 assert.equal(U.trustedURL('https://release-assets.githubusercontent.com/a/b?signature=x',{redirect:true}).hostname,'release-assets.githubusercontent.com');
 for(const url of ['http://github.com/kaleb689/SLABSNGRABSACO/releases/download/file','https://evil.test/a','https://github.com/other/repo/releases/download/a','https://user@github.com/kaleb689/SLABSNGRABSACO/releases/download/a','https://github.com:444/kaleb689/SLABSNGRABSACO/releases/download/a'])assert.throws(()=>U.trustedURL(url,{redirect:true}));
 assert.throws(()=>U.trustedURL('https://release-assets.githubusercontent.com/a/b'));
});
test('Full-bundle targets allow Applications installations without accepting unrelated apps',()=>{
 assert.equal(U.approvedTarget('/Applications/ACO Studio.app'),true);
 assert.equal(U.approvedTarget('/Users/example/Applications/ACO Studio.app','/Users/example'),true);
 assert.equal(U.approvedTarget('/Applications/SLABSNGRABSACO ACO Studio.app'),true);
 for(const p of ['/Applications/Other.app','/Volumes/Install/ACO Studio.app','/tmp/ACO Studio.app','/Applications/ACO Studio.app/../Other.app'])assert.equal(U.approvedTarget(p),false);
 assert.equal(U.bundleFromExecutable('/Applications/ACO Studio.app/Contents/MacOS/ACO Studio'),'/Applications/ACO Studio.app');
});
const root='ACO Studio.app/';
// Tiny stored-entry ZIP writer, used only for archive policy tests.
function zip(entries){const local=[],central=[];let offset=0;
 for(const e of entries){const name=Buffer.from(e.name),data=Buffer.from(e.data||''),header=Buffer.alloc(30),c=Buffer.alloc(46);
  header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(name.length,26);
  c.writeUInt32LE(0x02014b50);c.writeUInt16LE(0x314,4);c.writeUInt16LE(20,6);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(((e.mode||0x81a4)<<16)>>>0,38);c.writeUInt32LE(offset,42);
  local.push(header,name,data);central.push(c,name);offset+=header.length+name.length+data.length;
 }
 const dir=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...local,dir,end]);
}
const required=[{name:root+'Contents/Info.plist',data:'plist'},{name:root+'Contents/Resources/app/package.json',data:'{}'},{name:root+'Contents/_CodeSignature/CodeResources',data:'seal'}];
async function inspect(t,extra){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aco-archive-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'test.zip');await fs.writeFile(file,zip([...required,...extra]));return Z.inspectArchive(file);}
test('Archive preflight permits required signed-bundle paths and internal framework symlinks',async t=>{
 const r=await inspect(t,[{name:root+'Contents/Frameworks/F.framework/Versions/Current',data:'A',mode:0xa1ff},{name:root+'Contents/Frameworks/F.framework/Versions/A/F',data:'binary'}]);assert.equal(r.bundleName,'ACO Studio.app');assert.equal(r.entries,5);
});
test('Archive preflight rejects traversal, unrelated roots, duplicated paths and absolute symlinks',async t=>{
 for(const extra of [[{name:'../../evil',data:'x'}],[{name:'Other.app/x'}],[{name:required[0].name}],[{name:root+'contents/info.plist'}],[{name:root+'Contents/bad',mode:0xa1ff,data:'/etc/passwd'}],[{name:root+'Contents/bad',mode:0xa1ff,data:'../../../../etc/passwd'}]])await assert.rejects(inspect(t,extra));
});
test('Archive preflight refuses writes through symlinks and special device files',async t=>{
 await assert.rejects(inspect(t,[{name:root+'Contents/alias',mode:0xa1ff,data:'Resources'},{name:root+'Contents/alias/app/new.js'}]));
 await assert.rejects(inspect(t,[{name:root+'Contents/device',mode:0x21a4}]));
});
test('Real extracted link checks reject filesystem escapes',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aco-links-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const app=path.join(dir,'ACO Studio.app');await fs.mkdir(app);await fs.writeFile(path.join(app,'file'),'x');await fs.symlink('file',path.join(app,'okay'));await Z.verifyExtractedLinks(app);
 await fs.symlink('/etc/passwd',path.join(app,'bad'));await assert.rejects(Z.verifyExtractedLinks(app),/escapes/);
});
test('Mach-O CPU validation distinguishes ARM64 from Intel without developer command-line tools',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aco-cpu-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 for(const [name,cpu]of [['arm64',0x0100000c],['x64',0x01000007]]){const b=Buffer.alloc(32);b.writeUInt32LE(0xfeedfacf);b.writeUInt32LE(cpu,4);const p=path.join(dir,name);await fs.writeFile(p,b);assert.deepEqual(await U.architectures(p),[name]);}
});
test('Update ZIP SHA-256 validation uses full on-disk bytes',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aco-sha-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const p=path.join(dir,'f');await fs.writeFile(p,'original');const before=await U.sha256File(p);assert.equal(before,crypto.createHash('sha256').update('original').digest('hex'));await fs.appendFile(p,'changed');assert.notEqual(await U.sha256File(p),before);
});
test('Read-only update checks do not touch any saved data or need old Render update configuration',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aco-check-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.writeFile(path.join(dir,'personal-vault.keep'),'personal');await fs.writeFile(path.join(dir,'customer-vault.keep'),'customer');await fs.writeFile(path.join(dir,'owner-update-source.json'),'invalid legacy config');
 const before=await fs.readdir(dir);const app={getPath:()=>dir,getVersion:()=>'4.13.7',isPackaged:true};
 const engine=U.createMacUpdater({app,arch:'arm64',loadFeed:async()=>manifest()});const r=await engine.check();assert.equal(r.status,'available');assert.deepEqual(await fs.readdir(dir),before);assert.equal(await fs.readFile(path.join(dir,'personal-vault.keep'),'utf8'),'personal');
});
test('No installed target means no quit or attempted application writes',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aco-not-installed-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));let quit=false;
 const e=U.createMacUpdater({app:{getPath:()=>dir,getVersion:()=>'4.13.7',isPackaged:false,quit:()=>quit=true},loadFeed:async()=>manifest()});await assert.rejects(e.install(),/Applications/);assert.equal(quit,false);assert.deepEqual(await fs.readdir(dir),[]);
});
test('Mac integration keeps the Windows updater and original app data namespace',async()=>{
 const main=await fs.readFile(path.join(__dirname,'../main.js'),'utf8'),preload=await fs.readFile(path.join(__dirname,'../preload.js'),'utf8'),desktop=await fs.readFile(path.join(__dirname,'../desktop-updates.js'),'utf8');
 assert.match(main,/requireOwner:ownerSender/);assert.match(main,/app.setName\('SLABSNGRABSACO ACO Studio - Owner'\)/);assert.match(main,/app.setPath\('userData',path.join\(app.getPath\('appData'\),'SLABSNGRABSACO ACO Studio - Owner'\)\)/);
 assert.match(desktop,/process.platform==='darwin'.*mac-full-updates/);assert.match(desktop,/windows-update.js/);assert.match(preload,/nativeMac:process.platform==='darwin'/);
});
test('Updater never patches or re-signs the live application and never disables Gatekeeper',async()=>{
 const sh=await fs.readFile(path.join(__dirname,'../mac-full-update.sh'),'utf8'),js=await fs.readFile(path.join(__dirname,'../mac-full-updates.js'),'utf8');
 assert.doesNotMatch(sh,/codesign --force|xattr|spctl --master-disable|rm -rf.*Application Support/);assert.doesNotMatch(js,/codesign.*--force|com.apple.quarantine/);
 assert.match(sh,/\/bin\/mv "\$TARGET" "\$BACKUP"/);assert.match(sh,/rolledback/);assert.match(sh,/healthy/);assert.match(js,/waitReady/);
});
