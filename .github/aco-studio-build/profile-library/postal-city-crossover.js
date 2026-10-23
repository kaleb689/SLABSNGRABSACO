'use strict';
// Owner Studio internet ZIP/city crossover lookup. Sends only the 5-digit ZIP.
// Directory matches are not USPS street-level delivery confirmations.
const CACHE=new Map();
function zipInput(value){
 const z=String(value?.zip||'').trim().slice(0,5);
 const state=String(value?.state||'').trim().toUpperCase();
 if(!/^\d{5}$/.test(z)||!/^[A-Z]{2}$/.test(state))throw Error('A valid 5-digit ZIP and 2-letter state are required for city crossover lookup.');
 return {zip:z,state,city:String(value?.city||'').trim().toUpperCase().replace(/\s+/g,' ')};
}
async function lookupPostalZipCities(address,{fetchFn=fetch}={}){
 const input=zipInput(address),key=input.zip+'|'+input.state;
 let cities=CACHE.get(key);
 if(!cities||cities.until<Date.now()){
  let response;
  try{response=await fetchFn('https://api.zippopotam.us/us/'+encodeURIComponent(input.zip),
    {headers:{Accept:'application/json'},signal:AbortSignal.timeout(7500)});}
  catch{throw Error('Online ZIP/city lookup unavailable. Existing profiles were not modified; retry or disable online scan.');}
  if(response.status===404)throw Error('No online postal-city listing exists for this ZIP. Check the ZIP or disable online scan.');
  if(!response.ok)throw Error('Online ZIP/city lookup failed. No city change was saved.');
  const info=await response.json();
  cities=[...new Set((Array.isArray(info.places)?info.places:[])
    .filter(p=>String(p['state abbreviation']||'').trim().toUpperCase()===input.state)
    .map(p=>String(p['place name']||'').trim().replace(/\s+/g,' '))
    .filter(Boolean))].slice(0,24);
  CACHE.set(key,{cities,until:Date.now()+20*60*1000});
 }else cities=cities.cities;
 return {source:'Zippopotam ZIP/place directory',zip:input.zip,state:input.state,
  streetDeliveryVerified:false,cities:cities.filter(name=>name.toUpperCase()!==input.city)};
}
module.exports={lookupPostalZipCities};
