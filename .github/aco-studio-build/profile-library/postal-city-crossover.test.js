'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {lookupPostalZipCities}=require('../postal-city-crossover');
test('ZIP online lookup matches state and does not upload street, email or cards',async()=>{
 let url='',options;
 const data={places:[
  {'place name':'Davie','state abbreviation':'FL'},
  {'place name':'Plantation','state abbreviation':'FL'},
  {'place name':'Another state','state abbreviation':'CA'}
 ]};
 const fetchFn=async(u,o)=>{url=u;options=o;return {ok:true,status:200,json:async()=>data};};
 const result=await lookupPostalZipCities({address1:'SECRET ADDRESS',city:'Davie',state:'FL',zip:'33324',email:'private@example.com',cardNumber:'1111222233334444'},{fetchFn});
 assert.equal(url,'https://api.zippopotam.us/us/33324');
 assert.deepEqual(result.cities,['Plantation']);
 assert.equal(result.streetDeliveryVerified,false);
 assert.equal(JSON.stringify(options).includes('SECRET'),false);
 assert.equal(JSON.stringify(options).includes('1111'),false);
});
test('ZIP scan fails rather than inventing a city or changing state',async()=>{
 const fetchFn=async()=>({ok:true,status:200,json:async()=>({places:[{'place name':'Wrong','state abbreviation':'CA'}]})});
 const result=await lookupPostalZipCities({city:'Davie',state:'FL',zip:'33322'},{fetchFn});
 assert.deepEqual(result.cities,[]);
 await assert.rejects(lookupPostalZipCities({city:'Davie',state:'FL',zip:'ABC'},{fetchFn}),/valid 5-digit ZIP/);
});
