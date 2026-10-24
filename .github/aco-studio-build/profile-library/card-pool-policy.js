'use strict';
/**
 * Shared owner/customer retailer-card allocation policy.
 * Hard Card: one saved card per retailer, across up to five retailers.
 * Standard Card: one saved card across every retailer in this scoped vault.
 * The unrelated profile Security Code is NEVER used for card identity.
 * Only card number identifies a card. All metadata is stored in the existing
 * encrypted profile vault, not in logs or website/customer cross-vault indexes.
 */
const crypto=require('node:crypto');
const RETAILERS=Object.freeze(['target','walmart','pokemoncenter','costco','sams']);
const number=value=>String(value??'').replace(/\D/g,'');
function fromProfile(row){
 const data=row?.data||row||{},card=data.card||{};
 return number(data.cc_number||data.card_number||data.cardNumber||card.number||card.cardNumber||data.payment?.cardNumber);
}
function expiry(data){
 const d=data?.data||data||{},c=d.card||{};
 let month=String(d.cc_exp_month||c.expMonth||c.month||'').padStart(2,'0');
 let year=String(d.cc_exp_year||c.expYear||c.year||'');
 const compound=String(c.expiration||d.card_expiry||d.expiry||'').trim();
 if((!month||month==='00'||!year)&&compound){
  const match=/^(\d{1,2})\s*[\/-]\s*(\d{2,4})$/.exec(compound);
  if(match){month=match[1].padStart(2,'0');year=match[2];}
 }
 return month&&year?month+'/'+year:'';
}
function normalized(numberValue){const n=number(numberValue);return /^\d{12,19}$/.test(n)?n:'';}
function fingerprint(numberValue,settings){
 const n=normalized(numberValue),salt=settings?.cardPool?.salt;
 return n&&typeof salt==='string'&&/^[a-f0-9]{32,128}$/.test(salt)?
  crypto.createHmac('sha256',Buffer.from(salt,'hex')).update(n).digest('hex'):'';
}
function hardCard(numberValue,settings){
 const token=fingerprint(numberValue,settings);
 return !!token&&Array.isArray(settings?.cardPool?.hard)&&settings.cardPool.hard.includes(token);
}
function profileUses(rows){
 const byNumber=new Map();
 for(const row of rows||[]){
  const n=normalized(fromProfile(row));if(!n||!RETAILERS.includes(row.retailer))continue;
  let list=byNumber.get(n);if(!list){list=[];byNumber.set(n,list);}
  list.push({profileId:row.id,retailer:row.retailer,label:row.label||row.email||'Profile'});
 }
 return byNumber;
}
function violations(rows,settings){
 const bad=[];
 for(const [n,linked] of profileUses(rows)){
  const hard=hardCard(n,settings);
  const byRetailer=Object.fromEntries(RETAILERS.map(r=>[r,linked.filter(x=>x.retailer===r).length]));
  if(hard){for(const retailer of RETAILERS)if(byRetailer[retailer]>1)bad.push({fingerprint:n,retailer,count:byRetailer[retailer],hard:true});}
  else if(linked.length>1)bad.push({fingerprint:n,retailer:'all',count:linked.length,hard:false});
 }
 return bad;
}
function checkAllocation(rows,retailer,cards,settings,{excludeProfileIds=[]}={}){
 if(!RETAILERS.includes(retailer))throw Error('Choose a supported retailer.');
 const exclude=new Set(excludeProfileIds),existing=profileUses((rows||[]).filter(x=>!exclude.has(x.id)));
 const staged=new Map();
 for(const card of cards||[]){
  const n=normalized(typeof card==='string'?card:card?.number);
  if(!n)throw Error('Selected saved card is missing a valid number.');
  const uses=[...(existing.get(n)||[]),...(staged.get(n)||[])];
  if(hardCard(n,settings)){
   if(uses.some(x=>x.retailer===retailer))throw Error('Hard Card ending '+n.slice(-4)+' already has a '+retailer+' profile. one per retailer is the limit.');
  }else if(uses.length){
   throw Error('Regular card ending '+n.slice(-4)+' is already in use and already linked to a retailer profile. Enable Hard Card to allow one profile in a different retailer.');
  }
  staged.set(n,[...(staged.get(n)||[]),{retailer}]);
 }
 return true;
}
function inventory({rows=[],savedCards=[],settings={}}={}){
 const used=profileUses(rows),cards=new Map();
 function add(n,record,source){
  n=normalized(n);if(!n)return;
  let group=cards.get(n);
  if(!group){group={number:n,savedRefs:[],profileRefs:[],expiry:'',name:'',brand:'',sourceRefs:[]};cards.set(n,group);}
  if(source==='saved')group.savedRefs.push(record.id);
  else group.profileRefs.push(record.id);
  const exp=expiry(record);if(exp)group.expiry=group.expiry||exp;
  group.name=group.name||String(record.label||record.cardholder||record.holder||'').slice(0,100);
  group.brand=group.brand||String(record.brand||record.type||'').slice(0,30);
 }
 for(const card of savedCards){add(card.number,card,'saved');}
 for(const row of rows){add(fromProfile(row),row,'profile');}
 const output=[];
 for(const [n,card] of cards){
  const uses=used.get(n)||[],isHard=hardCard(n,settings),usedRetailers=[...new Set(uses.map(x=>x.retailer))];
  const availableRetailers=isHard?RETAILERS.filter(r=>!usedRetailers.includes(r)):uses.length?[]:[...RETAILERS];
  const duplicateRetailers=isHard?RETAILERS.filter(r=>uses.filter(x=>x.retailer===r).length>1):(uses.length>1?['all']:[]);
  output.push({id:card.savedRefs.length?'saved:'+card.savedRefs[0]:'profile:'+card.profileRefs[0],last4:n.slice(-4),
    label:card.name||'Card ending '+n.slice(-4),expiry:card.expiry,brand:card.brand,
    hardCard:isHard,linked:usedRetailers,linkedCount:uses.length,availableRetailers,
    status:uses.length?'Linked '+usedRetailers.map(r=>({pokemoncenter:'PKC',sams:"Sam's"}[r]||r)).join(', '):'Unused',
    hasConflict:duplicateRetailers.length>0,duplicateRetailers,fromSavedBank:card.savedRefs.length>0});
 }
 return output.sort((a,b)=>a.last4.localeCompare(b.last4)||a.label.localeCompare(b.label));
}
function resolveReference(ref,rows,savedCards){
 if(typeof ref!=='string'||! /^(?:saved|profile):[a-z0-9-]{1,150}$/i.test(ref))throw Error('Choose a card listed in this vault.');
 const [type,id]=ref.split(':');
 const selected=type==='saved'?(savedCards||[]).find(c=>c.id===id):(rows||[]).find(row=>row.id===id);
 const n=type==='saved'?selected?.number:fromProfile(selected);
 if(!selected||!normalized(n))throw Error('Selected card is not in this vault. Refresh the inventory.');
 return normalized(n);
}
function toggle(settings,n,hard){
 if(typeof hard!=='boolean'||!normalized(n))throw Error('Choose a valid Hard Card setting.');
 const next=structuredClone(settings||{});
 next.cardPool||={};
 next.cardPool.salt||=crypto.randomBytes(32).toString('hex');
 next.cardPool.hard=Array.isArray(next.cardPool.hard)?next.cardPool.hard:[];
 const token=fingerprint(n,next),set=new Set(next.cardPool.hard);
 if(hard)set.add(token);else set.delete(token);
 next.cardPool.hard=[...set].slice(0,15000);
 return next;
}
module.exports={RETAILERS,number,fromProfile,normalized,fingerprint,hardCard,profileUses,violations,checkAllocation,inventory,resolveReference,toggle};
