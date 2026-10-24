'use strict';
const Core=require('./app'),Draft=require('./profile-draft-core'),Fields=require('./jig-field-core'),crypto=require('node:crypto');
const clone=structuredClone,clean=v=>String(v??'').trim(),digits=v=>clean(v).replace(/\D/g,''),email=v=>clean(v).toLowerCase();
const retailer=v=>{if(!['target','walmart','pokemoncenter','costco','sams'].includes(v))throw Error('Choose a retailer.');return v;};
const format=r=>retailer(r)==='target'?'shikari':'valor';
function values(data){const v=Draft.toValues(data),s=data.shipping||{},b=data.billing||{},names=(v.first+' '+v.last).trim();
 v.first=v.first||v['shipping.first']||v['billing.first']||'';v.last=v.last||v['shipping.last']||v['billing.last']||'';
 for(const role of ['shipping','billing']){v[role+'.first']||=v.first;v[role+'.last']||=v.last;v[role+'.phone']||=v.phone||data.phone_num||data.phoneNumber||'';}
 v.phone||=v['shipping.phone']||v['billing.phone']||'';v.email=v.email||data.loginEmail||data.accountEmail||s.email||'';
 return v;
}
function payment(data){const sh=Draft.formatOf(data)==='shikari',c=data.card||{},v=values(data),exp=clean(c.expiration).split('/');
 let year=clean(sh?data.cc_exp_year:exp[1]||c.expYear);if(/^\d{2}$/.test(year))year='20'+year;
 return {cvv:clean(sh?(data.cc_cvv||data.cvv||data.cvc):(c.cvv||c.cvc||c.cid||c.cvv2)),number:digits(sh?data.cc_number:c.number||c.cardNumber),cardholder:clean(sh?data.cc_name||data.cc_holder:c.holder||c.cardholder)||(v['billing.first']+' '+v['billing.last']).trim(),month:clean(sh?data.cc_exp_month:exp[0]||c.expMonth).padStart(2,'0'),year,type:clean(sh?data.cc_type:c.type||c.brand),customSecurityCode:clean(data.custom_security_code||c.custom_security_code||'')};
}
function normalized(data,r){const v=values(data),out=Draft.blank(r,format(r),v);const c=payment(data);if(format(r)==='shikari')Object.assign(out,{cc_number:c.number,cc_name:c.cardholder,cc_exp_month:c.month,cc_exp_year:c.year,cc_type:c.type,cc_cvv:c.cvv,custom_security_code:c.customSecurityCode});else Object.assign(out.card,{number:c.number,holder:c.cardholder,cvv:c.cvv,expiration:c.month&&c.year?c.month+'/'+c.year.slice(-2):'',type:c.type,custom_security_code:c.customSecurityCode});if(typeof data.profileSecurityCode==='string')out.profileSecurityCode=data.profileSecurityCode.slice(0,100);
 else if(typeof data.security_code==='string')out.profileSecurityCode=data.security_code.slice(0,100);return syncCardholderToProfile(out);}
const nameKey=data=>{const v=values(data);return (v['shipping.first']+' '+v['shipping.last']).normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();};
function collisions(records,existing,r){const index={email:new Set(),name:new Set(),card:new Set()};for(const row of existing.filter(x=>x.retailer===r)){const v=values(row.data);if(v.email)index.email.add(email(v.email));if(nameKey(row.data))index.name.add(nameKey(row.data));if(payment(row.data).number)index.card.add(payment(row.data).number);}
 return records.map(data=>{const keys={email:email(values(data).email),name:nameKey(data),card:payment(data).number},flags=Object.keys(keys).filter(k=>keys[k]&&index[k].has(keys[k]));for(const k of Object.keys(keys))if(keys[k])index[k].add(keys[k]);return flags;});}
function inferredBrand(value){const n=digits(value);if(/^4\d{6,}$/.test(n))return 'Visa';const a=Number(n.slice(0,2)),b=Number(n.slice(0,4));if((a>=51&&a<=55)||(b>=2221&&b<=2720))return 'Mastercard';if(/^3[47]/.test(n))return 'American Express';if(/^6(?:011|5|4[4-9])/.test(n))return 'Discover';if(/^(?:2131|1800|35)/.test(n))return 'JCB';if(/^3(?:0[0-5]|[68])/.test(n))return 'Diners Club';return 'Card';}
function putCard(data,c){const format=Draft.formatOf(data),v=values(data),profileHolder=(v.first+' '+v.last).replace(/\s+/g,' ').trim(),incoming=clean(c.cardholder),existing=clean(format==='shikari'?(data.cc_name||data.cc_holder):(data.card?.holder||data.card?.cardholder)),holder=profileHolder||(/^unassigned$/i.test(incoming)&&existing?existing:incoming),type=inferredBrand(c.number);if(format==='shikari')Object.assign(data,{cc_number:c.number,cc_exp_month:c.month,cc_exp_year:c.year,cc_name:holder,cc_type:type});else Object.assign(data.card,{number:c.number,expiration:c.month+'/'+c.year.slice(-2),holder,cardholder:holder,type});}
function randomName(data,used){for(let n=0;n<1000;n++){const person=Fields.personFor(data,Core.autoMap([data]),new Set());const next=Draft.manualEdit(data,{...values(data),first:person.first,last:person.last,'shipping.first':person.first,'shipping.last':person.last,'billing.first':person.first,'billing.last':person.last});if(!used.has(nameKey(next))){used.add(nameKey(next));return next;}}throw Error('Unable to generate another unused name.');}
function exportRows(rows,r,customerName='Personal'){if(!rows.length)throw Error('Choose completed profiles to export.');const model=require('./site-model'),profiles=rows.map(x=>{const v=values(x.data),c=payment(x.data),address=role=>({firstName:v[role+'.first'],lastName:v[role+'.last'],phone:v[role+'.phone'],address:v[role+'.address1'],address2:v[role+'.address2'],city:v[role+'.city'],state:v[role+'.state'],zip:v[role+'.zip'],country:v[role+'.country']||'US'});return {email:v.email,phone:v.phone,shipping:address('shipping'),billing:address('billing'),card:c,profileSecurityCode:clean(x.data.profileSecurityCode||x.data.security_code||x.data.custom_security_code||x.data.card?.custom_security_code||'')};});
 const out=model.exportTemplates(r==='costco'||r==='sams'?'walmart':r,customerName,profiles,null,{localOwnerCards:profiles.map(x=>({...x.card,expiration:x.card.month+'/'+x.card.year.slice(-2),cvv:x.profileSecurityCode||''}))});
 out.name=clean(customerName).replace(/[<>:"/\\|?*\x00-\x1f]/g,'').slice(0,70)+' profiles'+(format(r)==='shikari'?'.csv':'.json');return out;
}
// Independent profile access codes are kept apart from all card verification fields.
// Export is explicitly initiated from the authenticated desktop owner/customer profile vault.
// The original retailer export templates remain untouched.
const VERIFIER_KEYS=new Set(['cvv','cvv2','cvc','cvc2','cid','csc','cc_cvv','cardverificationvalue']);
function archiveSafe(value){
 if(Array.isArray(value))return value.map(archiveSafe);
 if(!value||typeof value!=='object')return value;
 const out={};
 for(const [key,entry] of Object.entries(value)){
  if(['__proto__','constructor','prototype'].includes(key))continue;
  if(VERIFIER_KEYS.has(key.toLowerCase()))continue;
  // Keep independent profile Security Code fields unchanged.
  out[key]=archiveSafe(entry);
 }
 return out;
}
function exportArchiveRows(rows,r,owner='Personal'){
 retailer(r);
 if(!rows.length)throw Error('Select profiles to export.');
 const records=rows.map(row=>({
  retailer:row.retailer,profileId:row.id,label:row.label,email:row.email,
  profileSecurityCode:clean(row.data?.profileSecurityCode||row.data?.security_code||row.data?.custom_security_code||row.data?.card?.custom_security_code||''),
  data:archiveSafe(row.data)
 }));
 const name=clean(owner).replace(/[<>:"/\\|?*\x00-\x1f]/g,'').slice(0,70)+' full profiles.json';
 return {name,body:JSON.stringify({version:1,retailer:r,profiles:records},null,2)};
}
// Explicit export choices never rewrite the underlying profile's original
// retailer structure. Text/tabular exports flatten a temporary copy only.
function exportSelectedRows(rows,r,owner='Personal',choice='retailer'){
 const type=String(choice||'retailer').toLowerCase();
 if(type==='retailer')return exportRows(rows,r,owner);
 if(!['json','csv','tsv','txt'].includes(type))throw Error('Choose retailer format, JSON, CSV, TSV, or TXT.');
 const archive=exportArchiveRows(rows,r,owner);
 if(type==='json')return archive;
 const records=JSON.parse(archive.body).profiles;
 const flat=records.map(record=>{
  const data={retailer:record.retailer,profileId:record.profileId,label:record.label,email:record.email};
  const visit=(value,prefix)=>{
   if(Array.isArray(value)){data[prefix]=JSON.stringify(value);return;}
   if(value&&typeof value==='object'){
    for(const [key,entry] of Object.entries(value))visit(entry,prefix?prefix+'.'+key:key);
    return;
   }
   data[prefix]=value===null||value===undefined?'':String(value);
  };
  visit(record.data,'');
  data['Security Code']=record.profileSecurityCode||'';
  return data;
 });
 const safeOwner=clean(owner).replace(/[^a-z0-9 _-]/gi,'').slice(0,65)||'Profiles';
 if(type==='txt'){
  const body=records.map((record,i)=>{
   const fields=flat[i];
   return Object.entries(fields).map(([key,value])=>key+': '+String(value)).join('\\n');
  }).join('\\n\\n');
  return {name:safeOwner+' profiles.txt',body};
 }
 const delimiter=type==='tsv'?'\\t':',';
 const headers=[...new Set(flat.flatMap(row=>Object.keys(row)))];
 const quote=value=>{
  const str=String(value??'');
  return /["\\r\\n]/.test(str)||str.includes(delimiter)?'"'+str.replace(/"/g,'""')+'"':str;
 };
 const body=[headers,...flat.map(row=>headers.map(key=>row[key]??''))]
  .map(row=>row.map(quote).join(delimiter)).join('\\r\\n')+'\\r\\n';
 return {name:safeOwner+' profiles.'+type,body};
}
const FL_PHONE_RULE='phone_florida_random';
const FL_AREA_CODES=['239','305','321','324','352','386','407','448','561','645','656','689','727','728','754','772','786','813','850','863','904','941','954'];
function floridaPhone(seed,index=0){
 const digest=crypto.createHash('sha256').update(String(seed||'')+'|'+String(index)).digest();
 const total=FL_AREA_CODES.length*100;
 const base=digest.readUInt32BE(0)%total;
 const slot=(base+(Math.max(0,index)*37))%total;
 const area=FL_AREA_CODES[Math.floor(slot/100)],line=String(100+(slot%100)).padStart(4,'0');
 return area+'555'+line;
}
function applyFloridaPhone(data,seed,index=0){
 const phone=floridaPhone(seed,index),v=values(data);
 return Draft.manualEdit(data,{...v,phone,'shipping.phone':phone,'billing.phone':phone});
}
function syncCardholderToProfile(data){
 let out=clone(data),v=values(out);
 const first=clean(v.first||v['shipping.first']||v['billing.first']),last=clean(v.last||v['shipping.last']||v['billing.last']);
 if(!first&&!last)return out;
 // One profile identity is authoritative everywhere. The owner/user chooses or
 // generates the person's name once; shipping, billing and cardholder follow it.
 out=Draft.manualEdit(out,{...v,first,last,'shipping.first':first,'shipping.last':last,'billing.first':first,'billing.last':last});
 v=values(out);const holder=(v.first+' '+v.last).replace(/\s+/g,' ').trim();
 if(Draft.formatOf(out)==='shikari'){
  if(digits(out.cc_number))out.cc_name=holder;
 }else if(digits(out.card?.number||out.card?.cardNumber)){
  out.card={...(out.card||{}),holder,cardholder:holder};
 }
 return out;
}
const TARGET_PRIMARY_RULES=Object.freeze([
 ...[['target.house.fraction.half','1/2'],['target.house.fraction.third','1/3'],['target.house.fraction.quarter','1/4']].map(([id,value])=>({id,label:'Target house number + '+value,risk:'higher',family:'target-primary',apply:address=>{const next={...address},street=clean(next.address1||next.address||'');if(!/^\d+\s/.test(street))return null;const changed=street.replace(/^(\d+)(?=\s)/,'$1 '+value);if(changed===street)return null;if(Object.hasOwn(next,'address1'))next.address1=changed;else next.address=changed;return next;}})),
 ...'ABCDEFGH'.split('').map(letter=>({id:'target.house.hyphen.'+letter.toLowerCase(),label:'Target house number -'+letter,risk:'higher',family:'target-primary',apply:address=>{const next={...address},street=clean(next.address1||next.address||'');if(!/^\d+\s/.test(street))return null;const changed=street.replace(/^(\d+)(?=\s)/,'$1-'+letter);if(changed===street)return null;if(Object.hasOwn(next,'address1'))next.address1=changed;else next.address=changed;return next;}}))
]);
const suffixEquivalents=[['Street','St'],['Road','Rd'],['Avenue','Ave'],['Drive','Dr'],['Lane','Ln'],['Boulevard','Blvd'],['Court','Ct'],['Terrace','Ter'],['Circle','Cir'],['Parkway','Pkwy'],['Trail','Trl'],['Highway','Hwy'],['Place','Pl'],['Way','Wy'],['Alley','Aly'],['Square','Sq']];
const oldSuffixRule=id=>/^(?:street|road|avenue|drive|lane|boulevard|court|terrace|circle|parkway|trail|highway|place|way|alley|square)_(?:short|long|abbr|full)$/i.test(id)
 ||/^suffix[._-](?:street|road|avenue|drive|lane|boulevard|court|terrace|circle|parkway|trail|highway|place|way|alley|square)(?:[._-](?:short|long|abbr|full))?$/i.test(id);
const SUFFIX_MATCH_RULE={id:'suffix.matching',label:'Matching street type (St/Street, Rd/Road, etc.)',risk:'standard',family:'standard',
 apply:address=>{
  const raw=String(address.address1||address.address||'').trim(),words=raw.split(/\s+/),last=words.length-1;
  const post=/^(?:N|S|E|W|NW|NE|SW|SE|NORTH|SOUTH|EAST|WEST|NORTHWEST|NORTHEAST|SOUTHWEST|SOUTHEAST)$/i;
  const position=post.test(words[last])?last-1:last;
  const suffix=String(words[position]||'').replace(/\.$/,'').toLowerCase();
  const pair=suffixEquivalents.find(([full,short])=>suffix===full.toLowerCase()||suffix===short.toLowerCase());
  if(!pair)return null;
  words[position]=suffix===pair[0].toLowerCase()?pair[1]:pair[0];
  const next={...address};if(Object.hasOwn(next,'address1'))next.address1=words.join(' ');else next.address=words.join(' ');
  return next;
 }};
const coreRule=id=>id===SUFFIX_MATCH_RULE.id?SUFFIX_MATCH_RULE:Core.RULES.find(x=>x.id===id);
const targetRule=id=>TARGET_PRIMARY_RULES.find(x=>x.id===id),ruleById=id=>coreRule(id)||targetRule(id);
function ruleOptions(r){
 retailer(r);
 const standard=Core.RULES.filter(x=>!/^prefix_three/.test(x.id)&&!oldSuffixRule(x.id)).map(x=>({id:x.id,label:x.label,risk:'standard',family:'standard'}));
 const {id,label,risk,family}=SUFFIX_MATCH_RULE;const matching={id,label,risk,family};
 return r==='target'?[...standard,matching,...TARGET_PRIMARY_RULES.map(({id,label,risk,family})=>({id,label,risk,family}))]:[...standard,matching];
}
const defaultRules=r=>{
 const safe=[...new Set(Core.defaultRuleIDs.filter(id=>!/(prefix|fraction|fictitious|fabricated|phone)/i.test(id))
  .map(id=>oldSuffixRule(id)?SUFFIX_MATCH_RULE.id:id))];
 if(!safe.includes(SUFFIX_MATCH_RULE.id))safe.push(SUFFIX_MATCH_RULE.id);
 return retailer(r)==='target'?[...safe,...TARGET_PRIMARY_RULES.map(x=>x.id)]:safe;
};
function jig(data,r,index,rules=defaultRules(r)){
 retailer(r);
 if(!Array.isArray(rules)||rules.some(id=>!ruleById(id)))throw Error('Unknown retailer jig rule.');
 const out=clone(data);if(index===0)return out;const map=Core.autoMap([out]);
 for(const role of ['shipping','billing']){
  const addr={};for(const k of ['address1','address2','city','state','zip'])addr[k]=Core.get(out,map[role+'.'+k])||'';
  let primaryApplied=false;
  for(const id of rules.map((_,k)=>rules[(Math.max(0,index-1)+k)%rules.length])){
   const rule=ruleById(id);if(!rule)continue;
   if(rule.family==='target-primary'&&primaryApplied)continue;
   let variant;try{variant=rule.apply(addr);}catch{continue;}if(!variant)continue;
   if(rule.family==='target-primary')primaryApplied=true;
   for(const k of Object.keys(addr))if(map[role+'.'+k]&&variant[k]!=null){const path=JSON.parse(map[role+'.'+k]);let target=out;for(const part of path.slice(0,-1))target=target[part];target[path.at(-1)]=variant[k];}
   break;
  }
 }
 return out;
}
module.exports={exportSelectedRows,exportArchiveRows,values,payment,normalized,nameKey,collisions,putCard,randomName,exportRows,format,email,retailer,jig,defaultRules,ruleOptions,ruleById,TARGET_PRIMARY_RULES,FL_PHONE_RULE,FL_AREA_CODES,floridaPhone,applyFloridaPhone,syncCardholderToProfile};

