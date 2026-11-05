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
// Require both complete card numbers, compared digit for digit. Never infer
// ownership from email, name, retailer or the last four digits alone.
function exactFullCardMatch(previous,current){
 const oldNumber=payment(previous).number,newNumber=payment(current).number;
 return /^\d{12,19}$/.test(oldNumber)&&/^\d{12,19}$/.test(newNumber)&&oldNumber===newNumber;
}
const nameKey=data=>{const v=values(data);return (v['shipping.first']+' '+v['shipping.last']).normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();};
function collisions(records,existing,r){const index={email:new Set(),name:new Set(),card:new Set()};for(const row of existing.filter(x=>x.retailer===r)){const v=values(row.data);if(v.email)index.email.add(email(v.email));if(nameKey(row.data))index.name.add(nameKey(row.data));if(payment(row.data).number)index.card.add(payment(row.data).number);}
 return records.map(data=>{const keys={email:email(values(data).email),name:nameKey(data),card:payment(data).number},flags=Object.keys(keys).filter(k=>keys[k]&&index[k].has(keys[k]));for(const k of Object.keys(keys))if(keys[k])index[k].add(keys[k]);return flags;});}
function inferredBrand(value){const n=digits(value);if(/^4\d{6,}$/.test(n))return 'Visa';const a=Number(n.slice(0,2)),b=Number(n.slice(0,4));if((a>=51&&a<=55)||(b>=2221&&b<=2720))return 'Mastercard';if(/^3[47]/.test(n))return 'American Express';if(/^6(?:011|5|4[4-9])/.test(n))return 'Discover';if(/^(?:2131|1800|35)/.test(n))return 'JCB';if(/^3(?:0[0-5]|[68])/.test(n))return 'Diners Club';return 'Card';}
function putCard(data,c){const format=Draft.formatOf(data),v=values(data),profileHolder=(v.first+' '+v.last).replace(/\s+/g,' ').trim(),incoming=clean(c.cardholder),existing=clean(format==='shikari'?(data.cc_name||data.cc_holder):(data.card?.holder||data.card?.cardholder)),holder=profileHolder||(/^unassigned$/i.test(incoming)&&existing?existing:incoming),type=inferredBrand(c.number);if(format==='shikari')Object.assign(data,{cc_number:c.number,cc_exp_month:c.month,cc_exp_year:c.year,cc_name:holder,cc_type:type});else Object.assign(data.card,{number:c.number,expiration:c.month+'/'+c.year.slice(-2),holder,cardholder:holder,type});}
function randomName(data,used){for(let n=0;n<1000;n++){const person=Fields.personFor(data,Core.autoMap([data]),new Set());const next=Draft.manualEdit(data,{...values(data),first:person.first,last:person.last,'shipping.first':person.first,'shipping.last':person.last,'billing.first':person.first,'billing.last':person.last});if(!used.has(nameKey(next))){used.add(nameKey(next));return next;}}throw Error('Unable to generate another unused name.');}
// The independent profile reference is the only source for the CVV-named
// export template slot. Never use a payment verifier or the saved card bank.
function profileCode(data){
 const candidates=[data?.profileSecurityCode,data?.security_code,data?.custom_security_code,data?.card?.custom_security_code];
 const value=candidates.find(x=>typeof x==='string'&&x.length>0);
 return value===undefined?'':value;
}

function exportProfileName(row,index,owner='Personal',scope='personal'){
 if(scope==='personal'){
  const address=clean(values(row.data).email||row.email);
  if(!address||!address.includes('@'))throw Error('A Personal profile cannot export without its saved login email.');
  return address;
 }
 const actualName=clean(owner).replace(/\s+/g,' ');
 if(!actualName||actualName==='Customer'||actualName==='Personal'||/^[a-f0-9-]{30,}$/i.test(actualName))
  throw Error('Customer signup name is unavailable. Load the customer record before exporting.');
 return actualName+' '+(index+1);
}
// Replaces only the first field of each CSV record, preserving every other
// byte (particularly independent security references and leading zeroes).
function rewriteShikariNames(body,names){
 if(typeof body!=='string')throw Error('Invalid Target export content.');
 const records=[];let start=0,inQuotes=false;
 for(let i=0;i<body.length;i++){
  if(body[i]==='"'){
   if(inQuotes&&body[i+1]==='"'){i++;continue;}
   inQuotes=!inQuotes;
  }
  if(body[i]==='\n'&&!inQuotes){records.push(body.slice(start,i+1));start=i+1;}
 }
 if(inQuotes)throw Error('Malformed Target CSV quoted field.');
 if(start<body.length)records.push(body.slice(start));
 if(!records.length)throw Error('Empty Target CSV.');
 function firstFieldEnd(row){
  let inQuote=false;
  for(let i=0;i<row.length;i++){
   if(row[i]==='"'){if(inQuote&&row[i+1]==='"'){i++;continue;}inQuote=!inQuote;}
   else if(row[i]===','&&!inQuote)return i;
  }
  throw Error('Target CSV must include a profile_name column.');
 }
 const headerEnd=firstFieldEnd(records[0]);
 if(records[0].slice(0,headerEnd).replace(/^\uFEFF/,'').replace(/^"|"$/g,'')!=='profile_name')
  throw Error('Unexpected Target CSV profile-name header.');
 let index=0;
 const result=records.map((raw,i)=>{
  if(i===0||!raw.trim())return raw;
  if(index>=names.length)throw Error('Target CSV contains more records than selected profiles.');
  const end=firstFieldEnd(raw),name='"'+String(names[index++]).replace(/"/g,'""')+'"';
  return name+raw.slice(end);
 });
 if(index!==names.length)throw Error('Target CSV profile-name count mismatch.');
 return result.join('');
}
function rewriteValorNames(body,names){
 const data=JSON.parse(body);
 if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Unexpected Valor export structure.');
 const profiles=Object.values(data);
 if(profiles.length!==names.length||profiles.some(x=>!x||typeof x!=='object'||Array.isArray(x)))
  throw Error('Valor export profile-name count mismatch.');
 for(let i=0;i<profiles.length;i++){
    profiles[i].name=names[i];
    if(typeof profiles[i].card?.type==='string')
      profiles[i].card.type=profiles[i].card.type.toLowerCase();
  }
 return JSON.stringify(data,null,2);
}
function exportRows(rows,r,customerName='Personal',scope='personal',forcedFormat=null){
 if(!rows.length)throw Error('Choose completed profiles to export.');
 const exportNames=rows.map((row,i)=>exportProfileName(row,i,customerName,scope));
 const outputFormat=forcedFormat||format(r);
 if(!['shikari','valor'].includes(outputFormat))throw Error('Choose Shikari CSV or Valor JSON for a retailer template.');
 const outputRetailer=outputFormat==='shikari'?'target':(r==='target'||r==='costco'||r==='sams'?'walmart':r);
 const model=require('./site-model'),profiles=rows.map(x=>{const v=values(x.data),c=payment(x.data),address=role=>({firstName:v[role+'.first'],lastName:v[role+'.last'],phone:v[role+'.phone'],address:v[role+'.address1'],address2:v[role+'.address2'],city:v[role+'.city'],state:v[role+'.state'],zip:v[role+'.zip'],country:v[role+'.country']||'US'});return {email:v.email,phone:v.phone,shipping:address('shipping'),billing:address('billing'),card:{...c,type:c.type.toLowerCase()},profileSecurityCode:profileCode(x.data)};});
 const out=model.exportTemplates(outputRetailer,customerName,profiles,null,{localOwnerCards:profiles.map(x=>({...x.card,expiration:x.card.month+'/'+x.card.year.slice(-2),cvv:x.profileSecurityCode||''}))});
 out.body=outputFormat==='shikari'?rewriteShikariNames(out.body,exportNames):rewriteValorNames(out.body,exportNames);
 out.name=clean(customerName).replace(/[<>:"/\\|?*\x00-\x1f]/g,'').slice(0,70)+' profiles'+(outputFormat==='shikari'?'.csv':'.json');
 if(outputFormat==='shikari'){
  const parsed=Core.parseFile(out.name,out.body),records=parsed?.records||[];
  if(records.length!==rows.length)throw Error('Export blocked: generated Target CSV row count is incomplete.');
  const blank=records.filter(record=>typeof record.cc_cvv!=='string'||record.cc_cvv.length===0).length;
  if(blank)throw Error('Export blocked: '+blank+' Target profiles have an empty required reference field in the generated CSV. Original saved data was not changed.');
 }
 return out;
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
function exportArchiveRows(rows,r,owner='Personal',scope='personal'){
 retailer(r);
 if(!rows.length)throw Error('Select profiles to export.');
 const records=rows.map((row,index)=>{
  const name=exportProfileName(row,index,owner,scope);
  const copy=archiveSafe(row.data);
  // Normalize only export copies; leave encrypted master profiles untouched.
  if(typeof copy.cc_type==='string')copy.cc_type=copy.cc_type.toLowerCase();
  if(copy.card&&typeof copy.card.type==='string')
   copy.card.type=copy.card.type.toLowerCase();
  // Export-only name aliases for Shikari / Valor. Stored profiles retain
  // their original labels, names, emails and card/security references.
  if(format(r)==='shikari')copy.profile_name=name;
  else copy.name=name;
  // Independent reference in CVV-named retailer slot (unchanged).
  if(row.retailer==='target')copy.cc_cvv=profileCode(row.data);
  else {copy.card||={};copy.card.cvv=profileCode(row.data);}
  return {retailer:row.retailer,profileId:row.id,label:name,email:row.email,
   profileSecurityCode:profileCode(row.data),data:copy};
 });
 const name=clean(owner).replace(/[<>:"/\\|?*\x00-\x1f]/g,'').slice(0,70)+' full profiles.json';
 return {name,body:JSON.stringify({version:1,retailer:r,profiles:records},null,2)};
}
// Explicit export choices never rewrite the underlying profile's original
// retailer structure. Text/tabular exports flatten a temporary copy only.
function exportSelectedRows(rows,r,owner='Personal',choice='retailer',scope='personal'){
 const type=String(choice||'retailer').toLowerCase();
 if(type==='retailer')return exportRows(rows,r,owner,scope);
 if(type==='shikari'||type==='valor')return exportRows(rows,r,owner,scope,type);
 if(!['json','csv','tsv','txt'].includes(type))throw Error('Choose retailer format, JSON, CSV, TSV, or TXT.');
 const archive=exportArchiveRows(rows,r,owner,scope);
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
  // The value is already in data.cc_cvv or data.card.cvv. Do not create
  // another unrelated column instead of populating the required CVV slot.
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
// Rejig and generated profiles fill missing contact fields automatically.
// Reserved 555-01xx numbers are SAMPLE placeholders, not reachable phones.
function ensureMissingPhone(data,seed,index=0,occupied=null){
 const raw=Draft.toValues(data),fields=['phone','shipping.phone','billing.phone'];
 const current=fields.map(field=>clean(raw[field]));
 const existing=current.find(Boolean)||'',used=occupied instanceof Set?occupied:null;
 let phone=existing;
 if(!phone){
  const total=FL_AREA_CODES.length*100;
  for(let step=0;step<total;step++){
   const candidate=floridaPhone(seed,index+step);
   if(!used||!used.has(digits(candidate))){phone=candidate;break;}
  }
  if(!phone)throw Error('Reserved sample phone numbers are exhausted. Add verified phone numbers before generating more profiles.');
 }
 if(used)used.add(digits(phone));
 const missing=fields.filter(field=>!clean(raw[field]));
 if(!missing.length)return {data,phone,generated:false,changed:false};
 const values={...raw};
 for(const field of missing)values[field]=phone;
 return {data:Draft.manualEdit(data,values),phone,generated:!existing,changed:true};
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
 ...Array.from({length:9},(_,index)=>{const number=String(index+1);return {id:'target.house.integer.'+number,label:'Target house number + integer '+number,risk:'higher',family:'target-primary',apply:address=>{const next={...address},street=clean(next.address1||next.address||'');if(!/^\d+\s/.test(street))return null;const changed=street.replace(/^(\d+)(?=\s)/,'$1 '+number);if(changed===street)return null;if(Object.hasOwn(next,'address1'))next.address1=changed;else next.address=changed;return next;}};}),
 ...[['target.house.fraction.half','1/2'],['target.house.fraction.third','1/3'],['target.house.fraction.quarter','1/4']].map(([id,value])=>({id,label:'Target house number + '+value,risk:'higher',family:'target-primary',apply:address=>{const next={...address},street=clean(next.address1||next.address||'');if(!/^\d+\s/.test(street))return null;const changed=street.replace(/^(\d+)(?=\s)/,'$1 '+value);if(changed===street)return null;if(Object.hasOwn(next,'address1'))next.address1=changed;else next.address=changed;return next;}})),
 ...'ABCDEFGH'.split('').map(letter=>({id:'target.house.hyphen.'+letter.toLowerCase(),label:'Target house number -'+letter,risk:'higher',family:'target-primary',apply:address=>{const next={...address},street=clean(next.address1||next.address||'');if(!/^\d+\s/.test(street))return null;const changed=street.replace(/^(\d+)(?=\s)/,'$1-'+letter);if(changed===street)return null;if(Object.hasOwn(next,'address1'))next.address1=changed;else next.address=changed;return next;}}))
]);
// Target-only direction formats: never invent a direction that is absent
// from the real street address. Non-USPS shorthands remain separate opt-ins.
const TARGET_DIRECTION_FORMS=Object.freeze([
 {short:'N',long:'North',alternate:'No'},
 {short:'S',long:'South',alternate:'So'},
 {short:'E',long:'East',alternate:'Ea'},
 {short:'W',long:'West',alternate:'We'},
 {short:'NE',long:'Northeast',alternate:'N.E.',spaced:'North East'},
 {short:'NW',long:'Northwest',alternate:'N.W.',spaced:'North West'},
 {short:'SE',long:'Southeast',alternate:'S.E.',spaced:'South East'},
 {short:'SW',long:'Southwest',alternate:'S.W.',spaced:'South West'}
]);
function applyTargetDirection(address,variant){
 const street=clean(address?.address1||address?.address||'');
 const parts=street.split(/\s+/);
 if(parts.length<4||!/^\d+[A-Z0-9/-]*$/i.test(parts[0]))return null;
 const matching=(start,count)=>{
  const token=parts.slice(start,start+count).join(' ').toLowerCase();
  return TARGET_DIRECTION_FORMS.find(form=>
   [form.short,form.long,form.alternate,form.spaced].filter(Boolean).some(s=>s.toLowerCase()===token));
 };
 let match=null,start=-1,count=0;
 // Pre-directional must leave an actual street name plus suffix after it.
 for(const width of [2,1]){
  if(parts.length-(1+width)<2)continue;
  const found=matching(1,width);
  if(found){match=found;start=1;count=width;break;}
 }
 // Post-directional must follow a recognized street suffix, not a street name.
 if(!match)for(const width of [2,1]){
  const at=parts.length-width;
  if(at<3)continue;
  const prior=parts[at-1].replace(/\.$/,'').toLowerCase();
  if(!suffixEquivalents.some(pair=>pair.some(x=>x.toLowerCase()===prior)))continue;
  const found=matching(at,width);
  if(found){match=found;start=at;count=width;break;}
 }
 if(!match||!match[variant])return null;
 const changed=[...parts.slice(0,start),match[variant],...parts.slice(start+count)].join(' ');
 if(changed.toLowerCase()===street.toLowerCase())return null;
 const next={...address};
 if(Object.hasOwn(next,'address1'))next.address1=changed;else next.address=changed;
 return next;
}
const TARGET_DIRECTION_RULES=Object.freeze([
 {id:'target.direction.short',label:'Directional abbreviations (North→N; South→S; East→E; West→W; Northeast→NE)',risk:'standard',family:'target-direction',apply:address=>applyTargetDirection(address,'short')},
 {id:'target.direction.long',label:'Directional full forms (N→North; S→South; E→East; W→West; NE→Northeast)',risk:'standard',family:'target-direction',apply:address=>applyTargetDirection(address,'long')},
 {id:'target.direction.alternate',label:'Alternate directional abbreviations (North→No; South→So; East→Ea; West→We; NE→N.E.)',risk:'higher',family:'target-direction',apply:address=>applyTargetDirection(address,'alternate')},
 {id:'target.direction.spaced',label:'Spaced diagonal directions (NE→North East; NW→North West; SE→South East; SW→South West)',risk:'higher',family:'target-direction',apply:address=>applyTargetDirection(address,'spaced')}
]);
const suffixEquivalents=[['Street','St'],['Road','Rd'],['Avenue','Ave'],['Drive','Dr'],['Lane','Ln'],['Boulevard','Blvd'],['Court','Ct'],['Terrace','Ter'],['Circle','Cir'],['Parkway','Pkwy'],['Trail','Trl'],['Highway','Hwy'],['Place','Pl'],['Way','Wy'],['Alley','Aly'],['Square','Sq']];

// Target address-specific suffix exceptions. These apply ONLY to these four
// base streets, and a full/short spelling of a chosen suffix remains valid.
const TARGET_PRIORITY_SUFFIXES=Object.freeze([
 {key:'bayberry',house:'980',base:'Bayberry Point',city:'PLANTATION',zip:'33324',original:'Drive',allowed:['Drive','Road','Trail','Way','Lane','Court']},
 {key:'sabal',house:'1811',base:'Sabal Palm',city:'FORT LAUDERDALE',zip:'33324',original:'Drive',allowed:['Drive','Road','Lane','Way','Court','Circle']},
 {key:'turtle',house:'3775',base:'Turtle Run',city:'CORAL SPRINGS',zip:'33067',original:'Boulevard',allowed:['Boulevard','Road','Drive','Lane','Way','Court']},
 {key:'bristol',house:'5871',base:'Bristol',city:'DAVIE',zip:'33331',original:'Lane',allowed:['Lane','Road','Drive','Way','Court','Place']}
]);
const TARGET_451_LIMITS=Object.freeze({letters:Object.freeze(['A','B','C','D']),numbers:Object.freeze([1,2,3,4,5,6,7,8,9])});
const TARGET_451_DESIGNATORS=Object.freeze(['Apt','Unit','Ste','Room','Rm','#','Lot','Fl','Bldg']);
const targetSuffixPair=word=>suffixEquivalents.find(([full,short])=>
 String(word||'').replace(/\.$/,'').toLowerCase()===full.toLowerCase()||
 String(word||'').replace(/\.$/,'').toLowerCase()===short.toLowerCase());
function targetPriorityBase(address,entry){
 const raw=clean(address?.address1||address?.address||'');
 const parts=raw.split(/\s+/);
 if(String(address?.state||'FL').toUpperCase()!=='FL'||
    String(address?.zip||'').slice(0,5)!==entry.zip||
    String(address?.city||'').toUpperCase()!==entry.city)return null;
 if(parts.length!==entry.base.split(' ').length+2||parts[0]!==entry.house)return null;
 const name=parts.slice(1,-1).join(' ');
 if(name.toLowerCase()!==entry.base.toLowerCase())return null;
 const pair=targetSuffixPair(parts.at(-1));
 if(!pair||!entry.allowed.includes(pair[0]))return null;
 return {parts,pair,raw};
}
const TARGET_PRIORITY_SUFFIX_RULES=Object.freeze(TARGET_PRIORITY_SUFFIXES.flatMap(entry=>
 entry.allowed.flatMap(suffix=>[suffix,...(targetSuffixPair(suffix)?[targetSuffixPair(suffix)[1]]:[])]
 .map(spelling=>({
  id:'target.special-suffix.'+entry.key+'.'+spelling.toLowerCase(),
  label:entry.house+' '+entry.base+': '+spelling+' (only this address)',
  risk:spelling===entry.original?'standard':'higher',
  family:'target-special-suffix',
  apply:address=>{
   const found=targetPriorityBase(address,entry);if(!found)return null;
   if(found.parts.at(-1).toLowerCase()===spelling.toLowerCase())return null;
   const next={...address},street=[...found.parts.slice(0,-1),spelling].join(' ');
   if(Object.hasOwn(next,'address1'))next.address1=street;else next.address=street;
   return next;
  }
 })))));
function target451UnitInfo(address){
 const street=clean(address?.address1||address?.address||''),second=clean(address?.address2||'');
 if(String(address?.state||'FL').toUpperCase()!=='FL'||String(address?.zip||'').slice(0,5)!=='33324')return null;
 if(String(address?.city||'').toUpperCase()!=='PLANTATION')return null;
 const front=/^451\s+(?:NW|NORTHWEST|NORTH\s+WEST)\s+87TH?\s+(?:LANE|LN|AVENUE\s+LANE)\b/i;
 const matched=front.exec(street);
 if(!matched)return null;
 const tail=street.slice(matched[0].length).replace(/^[,\s]+/,'').trim();
 const unitSource=second||tail;
 const unit=/^(?:APT|APARTMENT|UNIT|STE|SUITE|ROOM|RM|LOT|BLDG|BUILDING|FL|#)\s*#?\s*(102|103)(?=$|[A-Z]|\-|[\s,])/i.exec(unitSource);
 if(!unit)return null;
 return {street:matched[0],unit:unit[1],currentUnit:unitSource,hadSecond:!!second,tail};
}
function target451Variant(address,mode,detail){
 const info=target451UnitInfo(address);if(!info)return null;
 const number=info.unit;
 let unit='Apt '+number;
 if(mode==='label'){
  unit=detail==='#'?'#'+number:detail+' '+number;
 }else if(mode==='letter'){
  if(!TARGET_451_LIMITS.letters.includes(detail))return null;
  unit='Apt '+number+detail;
 }else if(mode==='hyphen'){
  if(!TARGET_451_LIMITS.numbers.includes(detail))return null;
  unit='Apt '+number+'-'+detail;
 }else if(mode==='floor'){
  if(!TARGET_451_LIMITS.numbers.includes(detail))return null;
  unit='Apt '+number+', Fl '+detail;
 }else if(mode==='box'){
  if(!TARGET_451_LIMITS.letters.includes(detail))return null;
  unit='Apt '+number+', Box '+detail;
 }else if(mode==='two-label'||mode==='two-label-line2'){
  if(!TARGET_451_LIMITS.letters.includes(detail))return null;
  unit='Unit '+number+' Ste '+detail;
 }else if(mode==='avenue-lane'){
  const street=info.street.replace(/\b(?:LANE|LN)$/i,'Avenue Lane');
  const next={...address};
  if(Object.hasOwn(next,'address1'))next.address1=street+(info.hadSecond?'':', '+info.currentUnit);
  else next.address=street+(info.hadSecond?'':', '+info.currentUnit);
  return next.address1===address.address1?null:next;
 }
 const next={...address},street=info.street.trim();
 if(mode==='line2'||mode==='two-label-line2'){
  next.address1=street;next.address2=unit;
 }else{
  next.address1=street+', '+unit;next.address2='';
 }
 if(!Object.hasOwn(address,'address1')){next.address=next.address1;delete next.address1;}
 return next.address1===address.address1&&next.address2===address.address2?null:next;
}
const TARGET_451_RULES=Object.freeze([
 ...TARGET_451_DESIGNATORS.map(label=>({
  id:'target.451.unit-label.'+(label==='#'?'hash':label.toLowerCase()),
  label:'451 NW 87th Lane, Apt 102/103 → '+(label==='#'?'#':label+' ')+ '102/103 (unit label)',
  risk:'higher',family:'target-451-label',apply:address=>target451Variant(address,'label',label)
 })),
 ...TARGET_451_LIMITS.letters.map(letter=>({
  id:'target.451.letter.'+letter.toLowerCase(),
  label:'451 Apt 102/103 → 102'+letter+'/103'+letter,
  risk:'higher',family:'target-451-unit-letter',apply:address=>target451Variant(address,'letter',letter)
 })),
 ...TARGET_451_LIMITS.numbers.map(number=>({
  id:'target.451.hyphen.'+number,
  label:'451 Apt 102/103 → 102-'+number+'/103-'+number,
  risk:'higher',family:'target-451-unit-hyphen',apply:address=>target451Variant(address,'hyphen',number)
 })),
 ...TARGET_451_LIMITS.numbers.map(number=>({
  id:'target.451.floor.'+number,
  label:'451 Apt 102/103 → Apt 102/103, Fl '+number,
  risk:'higher',family:'target-451-unit-floor',apply:address=>target451Variant(address,'floor',number)
 })),
 ...TARGET_451_LIMITS.letters.map(letter=>({
  id:'target.451.box.'+letter.toLowerCase(),
  label:'451 Apt 102/103 → Apt 102/103, Box '+letter,
  risk:'higher',family:'target-451-unit-box',apply:address=>target451Variant(address,'box',letter)
 })),
 ...TARGET_451_LIMITS.letters.flatMap(letter=>[
  {id:'target.451.unit-ste.'+letter.toLowerCase(),label:'451 Apt 102/103 → Unit 102/103 Ste '+letter+' (Line 1)',risk:'higher',family:'target-451-unit-ste',apply:address=>target451Variant(address,'two-label',letter)},
  {id:'target.451.unit-ste-line2.'+letter.toLowerCase(),label:'451 Apt 102/103 → Unit 102/103 Ste '+letter+' (Line 2)',risk:'higher',family:'target-451-unit-ste',apply:address=>target451Variant(address,'two-label-line2',letter)}
 ]),
 {id:'target.451.line2',label:'451 NW 87th Lane, Apt 102/103 on Line 2 (original placement)',risk:'standard',family:'target-451-placement',apply:address=>target451Variant(address,'line2')},
 {id:'target.451.avenue-lane',label:'451 NW 87th Lane → 451 NW 87th Avenue Lane (451 only)',risk:'higher',family:'target-451-street',apply:address=>target451Variant(address,'avenue-lane')}
]);

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
// Stable family IDs are shared with the batch UI and allocation engine.
function jigStyle(id){
 if(id.startsWith('target.special-suffix.'))return 'special-suffix';
 if(id.startsWith('target.451.'))return '451-special';
 if(id==='target.direction.alternate')return 'direction-alternate';
 if(id==='target.direction.spaced')return 'direction-spaced';
 if(/^target\.direction\./.test(id))return 'directions';
 if(/^target\.house\.integer\./.test(id))return 'integer-house';
 if(/^target\.house\.fraction\./.test(id))return 'fraction-house';
 if(/^target\.house\.hyphen\./.test(id))return 'hyphen-house';
 if(id===FL_PHONE_RULE)return 'phone';
 const label=String(ruleById(id)?.label||id),value=id+' '+label;
 if(/ordinal|\b(?:2nd|3rd|4th|second|third|fourth)\b/i.test(value))return 'ordinals';
 if(/compass|direction|north|south|east|west|\bnw\b|\bne\b|\bsw\b|\bse\b/i.test(value))return 'directions';
 if(/apt|apartment|suite|\bste\b|\bunit\b|\broom\b|\bfloor\b|\bcondo\b/i.test(value))return 'units';
 if(/suffix|street type|road|avenue|lane|boulevard|drive|terrace/i.test(value))return 'suffix';
 return id;
}
const coreRule=id=>id===SUFFIX_MATCH_RULE.id?SUFFIX_MATCH_RULE:Core.RULES.find(x=>x.id===id);
const targetRule=id=>[...TARGET_PRIORITY_SUFFIX_RULES,...TARGET_451_RULES,...TARGET_PRIMARY_RULES,...TARGET_DIRECTION_RULES].find(x=>x.id===id),ruleById=id=>coreRule(id)||targetRule(id);
function ruleOptions(r){
 retailer(r);
 const standard=Core.RULES.filter(x=>!/^prefix_three/.test(x.id)&&!oldSuffixRule(x.id)).map(x=>({id:x.id,label:x.label,risk:'standard',family:'standard'}));
 const {id,label,risk,family}=SUFFIX_MATCH_RULE;const matching={id,label,risk,family};
 return r==='target'?[...standard,matching,...TARGET_PRIORITY_SUFFIX_RULES,...TARGET_451_RULES,...TARGET_DIRECTION_RULES,...TARGET_PRIMARY_RULES].map(({id,label,risk,family})=>({id,label,risk,family})):[...standard,matching];
}
const defaultRules=r=>{
 const safe=[...new Set(Core.defaultRuleIDs.filter(id=>!/(prefix|fraction|fictitious|fabricated|phone)/i.test(id))
  .map(id=>oldSuffixRule(id)?SUFFIX_MATCH_RULE.id:id))];
 if(!safe.includes(SUFFIX_MATCH_RULE.id))safe.push(SUFFIX_MATCH_RULE.id);
 return retailer(r)==='target'?[...new Set([...safe,...TARGET_PRIORITY_SUFFIX_RULES.map(x=>x.id),...TARGET_451_RULES.map(x=>x.id),...TARGET_DIRECTION_RULES.filter(x=>x.risk==='standard').map(x=>x.id),...TARGET_PRIMARY_RULES.map(x=>x.id)])]:safe;
};
function jig(data,r,index,rules=defaultRules(r)){
 retailer(r);
 if(!Array.isArray(rules)||rules.some(id=>!ruleById(id)))throw Error('Unknown retailer jig rule.');
 if(r!=='target'&&rules.some(id=>id.startsWith('target.')))throw Error('Target-only jig rules cannot be applied to another retailer.');
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

// Read-only, owner-scoped plan for reconciling PREVIOUSLY imported Live profiles.
// A card-only match is a conflict requiring explicit owner review. No payment
// verifier or unrelated security reference is used as an identity key.
function existingLiveReconciliation(rows,retailer){
 if(!['target','walmart','pokemoncenter','costco','sams'].includes(retailer))throw Error('Choose one retailer for Live reconciliation.');
 if(!Array.isArray(rows))throw Error('The profile vault snapshot is unavailable.');
 const live=rows.filter(row=>row.retailer===retailer&&row.bank==='live');
 const working=rows.filter(row=>row.retailer===retailer&&row.bank!=='live');
 const completePan=row=>{const number=payment(row.data||{}).number;return /^\d{12,19}$/.test(number)?number:'';};
 const byEmail=new Map(),byCard=new Map();
 for(const row of live){
  const emailValue=email(row.email||values(row.data||{}).email),cardNumber=completePan(row);
  if(emailValue){const matches=byEmail.get(emailValue)||[];matches.push(row);byEmail.set(emailValue,matches);}
  if(cardNumber){const matches=byCard.get(cardNumber)||[];matches.push(row);byCard.set(cardNumber,matches);}
 }
 const candidates=[],blocked=[],unmatched=[];
 for(const row of working){
  const emailValue=email(row.email||values(row.data||{}).email),number=completePan(row);
  const emailMatches=emailValue?byEmail.get(emailValue)||[]:[],cardMatches=number?byCard.get(number)||[]:[];
  const possible=new Map([...emailMatches,...cardMatches].map(item=>[item.id,item]));
  if(!possible.size){unmatched.push(row.id);continue;}
  if(row.sourceLinked||row.websiteAuthoritative||row.source==='website-linked-profile'){
   blocked.push({id:row.id,reason:'website-linked'});continue;
  }
  if(possible.size!==1||emailMatches.length>1||cardMatches.length>1){
   blocked.push({id:row.id,reason:'ambiguous-live-match'});continue;
  }
  const target=[...possible.values()][0];
  const reason=emailMatches.length===1?'email':'full-card';
  candidates.push({id:row.id,revision:row.revision||0,email:row.email,liveId:target.id,
   liveEmail:target.email,reason,oldCardLast4:number.slice(-4),
   cardsDiffer:number!==completePan(target)});
 }
 // Hash source identity and full serialized data only in the main process.
 // This digest never contains raw email, PAN, or reference values.
 const crypto=require('node:crypto');
 const signature=crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
 return {retailer,liveCount:live.length,workingCount:working.length,candidates,
  emailMatches:candidates.filter(x=>x.reason==='email').length,
  cardOnlyMatches:candidates.filter(x=>x.reason==='full-card').length,
  blockedCount:blocked.length,blocked,unmatchedCount:unmatched.length,signature};
}
module.exports={existingLiveReconciliation,exactFullCardMatch,profileCode,exportSelectedRows,exportArchiveRows,values,payment,normalized,nameKey,collisions,putCard,randomName,exportRows,format,email,retailer,jig,defaultRules,ruleOptions,ruleById,jigStyle,TARGET_PRIMARY_RULES,TARGET_DIRECTION_RULES,TARGET_PRIORITY_SUFFIXES,TARGET_PRIORITY_SUFFIX_RULES,TARGET_451_RULES,TARGET_451_LIMITS,target451UnitInfo,FL_PHONE_RULE,FL_AREA_CODES,floridaPhone,applyFloridaPhone,ensureMissingPhone,syncCardholderToProfile};

