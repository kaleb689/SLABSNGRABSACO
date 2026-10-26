'use strict';
// No profile, card, address, email or security reference is logged or exported
// by this helper. It runs only for owner-authorized local vaults.
const C=require('./profile-library-core');
const pan=value=>String(value||'').replace(/\D/g,'');
const sameCard=(a,b)=>pan(a.number)===pan(b.number)&&a.month===b.month&&a.year===b.year;
const validPan=n=>/^\d{12,19}$/.test(n);
function cardsToPreserve(displaced,incoming){
 if(!Array.isArray(displaced)||!Array.isArray(incoming))throw Error('Invalid Live import card reconciliation.');
 const live=new Map(incoming.map(x=>[x.retailer+'|'+String(x.email||'').toLowerCase(),C.payment(x.data)]));
 const byNumber=new Map();
 for(const profile of displaced){
  const current=live.get(profile.retailer+'|'+String(profile.email||'').toLowerCase());
  if(!current)throw Error('Live card recovery ownership changed. Import was cancelled.');
  const old=C.payment(profile.data),number=pan(old.number);
  if(!number)continue;
  if(!validPan(number)||!/^(0[1-9]|1[0-2])$/.test(old.month)||!/^20\d\d$/.test(old.year))
   throw Error('A matching Ready/Unused profile has incomplete saved card details. Repair its card before Live import so its original card is not lost.');
  if(sameCard(old,current))continue;
  if(!byNumber.has(number)){
   byNumber.set(number,{number,month:old.month,year:old.year,cardholder:old.cardholder||'Unassigned',label:'Preserved from Live import',brand:old.type||'',
    // This is an independent, non-payment security reference only.
    customSecurityCode:old.customSecurityCode||''});
  }
 }
 return [...byNumber.values()];
}
async function preserveRetiredCards({displaced,incoming,vault,key,check}){
 if(!vault||typeof vault.list!=='function'||typeof vault.selectedForJig!=='function'||typeof vault.addWorkshopCard!=='function'||typeof check!=='function')
  throw Error('The encrypted saved Card Bank is unavailable. Live import was cancelled to protect prior cards.');
 const candidates=cardsToPreserve(displaced,incoming);
 if(!candidates.length)return {cardsPreserved:0,cardsAlreadySaved:0};
 check();
 const saved=await vault.list(key);
 check();
 const full=(saved.cards||[]).length?await vault.selectedForJig(key,saved.cards.map(x=>x.id)):[];
 check();
 const existing=new Set(full.map(x=>pan(x.number)).filter(Boolean));
 let cardsPreserved=0,cardsAlreadySaved=0;
 for(const card of candidates){
  if(existing.has(card.number)){cardsAlreadySaved++;continue;}
  check();
  // addWorkshopCard persists OS-encrypted data. If it fails, import cannot
  // retire original profiles; any earlier successful card copies are safe.
  await vault.addWorkshopCard(key,card,check);
  existing.add(card.number);cardsPreserved++;
 }
 return {cardsPreserved,cardsAlreadySaved};
}
module.exports={cardsToPreserve,preserveRetiredCards};
