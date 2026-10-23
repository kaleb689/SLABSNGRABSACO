import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
// The overlay is CommonJS inside the Electron app; the public repository root
// has type: module, so load it with a CommonJS module wrapper for this test.
const source=fileURLToPath(new URL('../.github/aco-studio-build/profile-library/postal-city-crossover.js',import.meta.url));
const local=new Module(source);
local.filename=source;
local.paths=Module._nodeModulePaths(path.dirname(source));
local._compile(fs.readFileSync(source,'utf8'),source);
const {lookupPostalZipCities}=local.exports;
test('Desktop ZIP lookup sends ZIP only, never address or credentials',async()=>{
 let request;
 const result=await lookupPostalZipCities({address1:'PRIVATE STREET',city:'Davie',state:'FL',zip:'33324',email:'private@example.test',cardNumber:'1234567890123456'},
 {fetchFn:async(url,options)=>{request={url,options};return {ok:true,status:200,json:async()=>({places:[
  {'place name':'Davie','state abbreviation':'FL'},
  {'place name':'Plantation','state abbreviation':'FL'},
  {'place name':'Unrelated City','state abbreviation':'CA'}
 ]})};}});
 assert.equal(request.url,'https://api.zippopotam.us/us/33324');
 assert.equal(JSON.stringify(request).includes('PRIVATE STREET'),false);
 assert.equal(JSON.stringify(request).includes('1234567890123456'),false);
 assert.deepEqual(result.cities,['Plantation']);
 assert.equal(result.streetDeliveryVerified,false);
});
test('Crossovers require a valid five-digit ZIP and state',async()=>{
 await assert.rejects(lookupPostalZipCities({zip:'abcde',state:'FL'}),/valid 5-digit ZIP/);
});
test('Jig Profiles invokes online lookup and limits it to preview with explicit scan',()=>{
 const service=fs.readFileSync(new URL('../.github/aco-studio-build/profile-library/profile-library-service.js',import.meta.url),'utf8');
 const ui=fs.readFileSync(new URL('../.github/aco-studio-build/profile-library/profile-library-ui.js',import.meta.url),'utf8');
 const workshop=fs.readFileSync(new URL('../.github/aco-studio-build/completed-profiles/profile-workshop-ui.js',import.meta.url),'utf8');
 const apply=fs.readFileSync(new URL('../.github/aco-studio-build/profile-library/apply.cjs',import.meta.url),'utf8');
 assert.match(service,/p\.postalScan===true/);
 assert.match(service,/await getPostalJigOptions\(address\)/);
 assert.match(service,/postalCityApplied/);
 assert.match(ui,/postalScan:postalScanBox\.checked/);
 assert.match(workshop,/postalScan:bq\('postal-scan'\)\.checked/);
 assert.match(apply,/postal-city-crossover\.js/);
});
