'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(process.argv[2]||'build-src/App');
function replace(file,a,b){const p=path.join(root,file),s=fs.readFileSync(p,'utf8');if(s.split(a).length!==2)throw Error(file+': release integration anchor changed');fs.writeFileSync(p,s.replace(a,b));}
// Strictly reject trailing whitespace in numeric versions (JS '$' also matches
// before a final newline). No version string from a remote feed is coerced.
replace('mac-full-updates.js',
 "if(!VERSION.test(a)||!VERSION.test(b))throw Error('Invalid update version.');",
 "if(typeof a!=='string'||typeof b!=='string'||a.trim()!==a||b.trim()!==b||!VERSION.test(a)||!VERSION.test(b))throw Error('Invalid update version.');");
const p=path.join(root,'package.json'),pkg=JSON.parse(fs.readFileSync(p,'utf8'));
if(pkg.version!=='4.13.5')throw Error('Expected the verified original source before release preparation');
const version=process.env.ACO_VERSION;
if(!/^4\.13\.[1-9][0-9]*$/.test(version||''))throw Error('Invalid release version');
pkg.version=version;
pkg.build.productName='ACO Studio';
pkg.build.mac.artifactName='ACO-Studio-${version}-${arch}.${ext}';
// The visible Finder/icon label is short. Internal appId, app.setName and
// userData namespace are unchanged; the existing encrypted vaults remain in place.
if(pkg.build.appId!=='com.slabsngrabsaco.jigstudio.owner')throw Error('Refusing to change application identity');
if(process.env.ACO_ADHOC_MODE==='true'){
 pkg.build.mac.identity='-';
 const ep=path.join(root,'build/entitlements.mac.plist'),xml=fs.readFileSync(ep,'utf8');
 if(!xml.includes('</dict>'))throw Error('Invalid Mac entitlements');
 const flag='<key>com.apple.security.cs.disable-library-validation</key><true/>';
 if(!xml.includes(flag))fs.writeFileSync(ep,xml.replace('</dict>',flag+'\n</dict>'));
}
fs.writeFileSync(p,JSON.stringify(pkg,null,2)+'\n');
console.log('Prepared ACO Studio '+version+'; preserved internal app identity and vault namespace.');
