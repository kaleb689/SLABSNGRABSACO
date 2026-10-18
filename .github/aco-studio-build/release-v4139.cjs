'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(process.argv[2]||'build-src/App');
function replace(file,a,b){const p=path.join(root,file),s=fs.readFileSync(p,'utf8');if(s.split(a).length!==2)throw Error(file+': release integration anchor changed');fs.writeFileSync(p,s.replace(a,b));}
// Strictly reject trailing whitespace in numeric versions (JS '$' also matches
// before a final newline). No version string from a remote feed is coerced.
replace('mac-full-updates.js',
 "if(!VERSION.test(a)||!VERSION.test(b))throw Error('Invalid update version.');",
 "if(typeof a!=='string'||typeof b!=='string'||a.trim()!==a||b.trim()!==b||!VERSION.test(a)||!VERSION.test(b))throw Error('Invalid update version.');");
// Direct vault actions select only their own field; preview remains mandatory.
replace('profile-workshop-ui.js',"   $('workshopVaultRows').append(line);",`   if(tab==='cards'||tab==='addresses'){
    const kind=tab,b=d.createElement('button'),c=context();b.type='button';b.className='btn slim secondary';b.textContent=kind==='cards'?'Use card':'Use address';
    b.disabled=busy||!c||!c.indices.length||c.scope!==vaultScope.scope||(c.customerId||null)!==(vaultScope.customerId||null);
    b.addEventListener('click',async()=>{try{
     const selected=context();if(busy||!selected||selected.scope!==vaultScope.scope||(selected.customerId||null)!==(vaultScope.customerId||null))throw Error('Open a profile in this same vault first.');
     await unlock(selected);
     if(kind==='cards'&&!r.unused&&$('workshopUnused').checked)throw Error('This card is already assigned. Turn off Unused only in the Card information controls to select it explicitly.');
     invalidate();importer().beginWorkshop();
     $(kind==='cards'?'workshopCard':'workshopAddress').checked=true;picks[kind]=new Set([r.id]);
     $('workshopAddresses').hidden=!checked().address;$('workshopCards').hidden=!checked().card;
     closeVault();controls();panel.scrollIntoView({block:'center'});
     note((kind==='cards'?'Saved card selected. ':'Saved address selected. ')+'Click Preview selected changes before saving. Other checkboxes were not changed.');
    }catch(error){vnote(error.message,true);}});line.append(b);
   }
   $('workshopVaultRows').append(line);`);
const p=path.join(root,'package.json'),pkg=JSON.parse(fs.readFileSync(p,'utf8'));
if(pkg.version!=='4.13.5')throw Error('Expected the verified original source before release preparation');
const version=process.env.ACO_VERSION;
if(!/^4\.13\.[1-9][0-9]*$/.test(version||''))throw Error('Invalid release version');
pkg.version=version;
pkg.build.productName='ACO Studio';
pkg.build.mac.artifactName='ACO-Studio-${version}-${arch}.${ext}';
// The registry advertised node-abi 4.38.0 but returned HTTP 404 for its tarball
// during the 2026-10-15 build. Pin the published 4.x release for the builder;
// preserve any independent node-abi 3.x dependency and the Electron runtime.
pkg.overrides={...(pkg.overrides||{}),'node-abi@>=4 <5':'4.37.0'};
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
// Update only the old visible-name assertion for the requested label change.
// The existing packaging, branding-file, app identity and data-location tests
// remain enabled; the native-updater suite independently checks the old data name.
const tp=path.join(root,'tests/native-contracts.test.js'),test=fs.readFileSync(tp,'utf8');
const lines=test.split('\n').filter(s=>s.includes('assert.equal')&&s.includes('.productName')&&s.includes('SLABSNGRABSACO ACO Studio'));
if(lines.length!==1)throw Error('Expected one original visible-name assertion');
fs.writeFileSync(tp,test.replace(lines[0],lines[0].replace('SLABSNGRABSACO ACO Studio','ACO Studio')));
console.log('Prepared ACO Studio '+version+'; preserved internal app identity and vault namespace.');
