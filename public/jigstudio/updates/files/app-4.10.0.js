/* Local address converter; owner bank is encrypted at rest. Remote lookups only happen after explicit user action. */
const JigCore = (() => {
'use strict';
const NL = '\n';
const OWN = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
const clone = value => JSON.parse(JSON.stringify(value));
 const phoneTools=typeof Verification!=='undefined'?Verification:(typeof require==='function'?require('./verification'):null);
const asText = v => v == null ? '' : String(v);
const norm = s => asText(s).toLowerCase().replace(/[^a-z0-9]+/g,'');
const flatKey = p => p.map(s => norm(s)).join('');
const zip5 = s => (asText(s).match(/\b\d{5}\b/) || [])[0] || '';
const normalizeNL = text => text.includes('\r\n') ? '\r\n' : text.includes('\r') ? '\r' : '\n';

function parseDelimited(text,delimiter=',') {
 const rows=[]; let row=[], cur='', quoted=false, atStart=true;
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(quoted){
   if(c==='"' && text[i+1]==='"'){cur+='"';i++;}
   else if(c==='"') quoted=false;
   else cur+=c;
  } else if(c==='"' && atStart){quoted=true;atStart=false;}
  else if(c===delimiter){row.push(cur);cur='';atStart=true;}
  else if(c==='\r' || c==='\n'){
   if(c==='\r' && text[i+1]==='\n')i++;
   row.push(cur);rows.push(row);row=[];cur='';atStart=true;
  } else {cur+=c;atStart=false;}
 }
 if(quoted) throw new Error('Unclosed quoted field.');
 if(cur!=='' || row.length || (text && !/[\r\n]$/.test(text))){row.push(cur);rows.push(row);}
 return rows;
}
function serialDelimited(rows,delimiter=',',newline='\n',endNewline=false){
 const esc=v=>{const s=asText(v);return s.includes('"')||s.includes(delimiter)||/[\r\n]/.test(s)||/^\s|\s$/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;};
 return rows.map(row=>row.map(esc).join(delimiter)).join(newline)+(endNewline && rows.length?newline:'');
}
function delimiterFor(text,extension){
 if(extension==='tsv'||extension==='tab')return '\t';
 if(extension==='psv')return '|';
 const header=text.split(/\r\n|\n|\r/).find(x=>x.trim())||'';
 let best=',',score=-1;
 for(const d of [',','\t','|',';']){
  const s=(header.match(new RegExp(d==='|'?'\\|':d==='\t'?'\\t':d===';'?';':',','g'))||[]).length;
  if(s>score){score=s;best=d;}
 }
 return best;
}
function guessFormat(name,text){
 const extension=(name.split('.').pop()||'').toLowerCase();
 if(['json','jsonl','ndjson','csv','tsv','tab','psv'].includes(extension))return extension;
 const trimmed=text.trimStart();
 if(trimmed.startsWith('[') || trimmed.startsWith('{')){
  try{JSON.parse(text);return 'json';}catch(e){/* maybe linewise */}
 }
 const lines=text.split(/\r\n|\n|\r/).filter(x=>x.trim());
 if(lines.length>1 && lines.slice(0,Math.min(5,lines.length)).every(x=>{try{return typeof JSON.parse(x)==='object';}catch(e){return false;}}))return 'jsonl';
 const first=lines[0]||'';
 if(/^[^\r\n=:\t,|;]{1,80}\s*[:=]\s*/.test(first))return 'keyvalue';
 if(/[\t,|;]/.test(first))return 'delimited';
 return 'plain';
}
function findArray(parent){
 if(Array.isArray(parent))return parent;
 if(!parent || typeof parent!=='object')return null;
 const priorities=['records','accounts','profiles','customers','users','data','items','rows'];
 const keys=Object.keys(parent).sort((a,b)=>(priorities.indexOf(a)<0?999:priorities.indexOf(a))-(priorities.indexOf(b)<0?999:priorities.indexOf(b)));
 for(const k of keys){
  if(Array.isArray(parent[k]) && parent[k].some(x=>x && typeof x==='object'&&!Array.isArray(x)))return parent[k];
 }
 return null;
}
function parseFile(name,text){
 const encodingBOM=text.charCodeAt(0)===0xFEFF;
 const body=encodingBOM?text.slice(1):text;
 const newline=normalizeNL(body),endNewline=/[\r\n]$/.test(body);
 const type=guessFormat(name,body);
 if(['csv','tsv','tab','psv','delimited'].includes(type)){
  const delimiter=delimiterFor(body,type), matrix=parseDelimited(body,delimiter);
  if(matrix.length<1)throw Error('File has no headers.');
  const header=matrix[0];
  if(header.length===1 && type!=='csv')throw Error('No delimited columns found.');
  const headerSeen=new Set();
  for(const h of header){if(headerSeen.has(h))throw Error('Duplicate header: '+h);headerSeen.add(h);}
  const records=matrix.slice(1).map(cells=>Object.fromEntries(header.map((key,j)=>[key,cells[j]??''])));
  return {name,type,delimiter,header,matrix,records,format:'Delimited table',encodingBOM,newline,endNewline,originalText:body};
 }
 if(type==='json'){
  let root;
  try{root=JSON.parse(body);}catch(e){throw Error('Invalid JSON: '+e.message);}
  const arr=findArray(root);
  // Valor profiles are a JSON object keyed by stable profile UUIDs, not an array.
  // Parse each record separately while preserving every original ID on export.
  const objectKeys=(!arr && root && typeof root==='object' && !Array.isArray(root) &&
   Object.keys(root).length>0 && Object.values(root).every(v=>v&&typeof v==='object'&&!Array.isArray(v)&&
    (Object.hasOwn(v,'shipping')||Object.hasOwn(v,'billing')) &&
    (Object.hasOwn(v,'name')||Object.hasOwn(v,'email'))))?Object.keys(root):null;
  const records=arr || (objectKeys?objectKeys.map(k=>root[k]):(root && typeof root==='object' && !Array.isArray(root)?[root]:[]));
  if(!records.length)throw Error('No account objects found in this JSON file.');
  if(records.some(x=>!x || typeof x!=='object'||Array.isArray(x)))throw Error('JSON records must be objects.');
  const pretty=/\n\s+\"/.test(body),indent=(body.match(/\n([ \t]+)\"/)||[])[1]||'  ';
  return {name,type,records,root,arr,objectKeys,format:objectKeys?'Valor-style keyed JSON':'JSON',pretty,indent,encodingBOM,newline,endNewline,originalText:body};
 }
 if(type==='jsonl'||type==='ndjson'){
  const lines=body.split(/\r\n|\n|\r/);if(endNewline)lines.pop();
  const records=[],lineIDs=[];
  for(let i=0;i<lines.length;i++){
   if(!lines[i].trim())continue;
   let x;try{x=JSON.parse(lines[i]);}catch(e){throw Error('Invalid JSON on line '+(i+1)+': '+e.message);}
   if(!x||typeof x!=='object'||Array.isArray(x))throw Error('Expected an object on line '+(i+1)+'.');
   lineIDs.push(i);records.push(x);
  }
  return {name,type,lines,lineIDs,records,format:'JSON Lines',encodingBOM,newline,endNewline,originalText:body};
 }
 if(type==='keyvalue'){
  const lines=body.split(/\r\n|\n|\r/);if(endNewline)lines.pop();
  const records=[],groups=[],lineKeys=[];
  let r={},g={};
  const finish=()=>{if(Object.keys(r).length){records.push(r);groups.push(g);r={};g={};}};
  for(let i=0;i<lines.length;i++){
   const line=lines[i];
   if(!line.trim() || /^\s*[-=]{3,}\s*$/.test(line) || /^\s*\[.+\]\s*$/.test(line)){finish();continue;}
   const m=line.match(/^(\s*([^=:]+?)\s*([=:])\s*)(.*)$/);
   if(m){const key=m[2].trim();r[key]=m[4];g[key]={line:i,prefix:m[1]};lineKeys.push(key);}
  }
  finish();
  if(!records.length)throw Error('No key=value or key: value records detected.');
  return {name,type,lines,groups,records,format:'Text key/value records',encodingBOM,newline,endNewline,originalText:body};
 }
 if(type==='plain'){
  const lines=body.split(/\r\n|\n|\r/);if(endNewline)lines.pop();
  const lineIDs=[];const records=[];
  lines.forEach((line,i)=>{if(line.trim()){lineIDs.push(i);records.push({'shipping_address1':line});}});
  if(!records.length)throw Error('Text file is empty.');
  return {name,type,records,lines,lineIDs,format:'Text addresses (one per line)',encodingBOM,newline,endNewline,originalText:body};
 }
 throw Error('Unsupported format. Try CSV, TSV, PSV, JSON, JSONL, NDJSON or TXT.');
}
function serialize(parsed,records){
 let out='';
 if(['csv','tsv','tab','psv','delimited'].includes(parsed.type)){
  const matrix=[parsed.header];
  records.forEach((r,i)=>{
   const orig=parsed.matrix[i+1]||[];
   const line=parsed.header.map((key,j)=>asText(r[key]));
   for(let j=parsed.header.length;j<orig.length;j++)line.push(orig[j]);
   matrix.push(line);
  });
  out=serialDelimited(matrix,parsed.delimiter,parsed.newline,parsed.endNewline);
 } else if(parsed.type==='json'){
  let obj=clone(parsed.root);
  if(Array.isArray(obj))obj=records;
  else if(parsed.arr){const arrKey=Object.keys(obj).find(k=>Array.isArray(parsed.root[k])&&parsed.root[k]===parsed.arr);obj[arrKey]=records;}
  else if(parsed.objectKeys){parsed.objectKeys.forEach((key,i)=>{if(!['__proto__','constructor','prototype'].includes(key))obj[key]=records[i];});}
  else obj=records[0];
  out=JSON.stringify(obj,null,parsed.pretty?parsed.indent:undefined);
  if(parsed.endNewline)out+=parsed.newline;
 } else if(parsed.type==='jsonl'||parsed.type==='ndjson'){
  const lines=[...parsed.lines];
  parsed.lineIDs.forEach((n,j)=>{lines[n]=JSON.stringify(records[j]);});
  out=lines.join(parsed.newline)+(parsed.endNewline?parsed.newline:'');
 } else if(parsed.type==='keyvalue'){
  const lines=[...parsed.lines];
  records.forEach((record,i)=>{
   const group=parsed.groups[i];
   for(const key of Object.keys(group)){
    const {line,prefix}=group[key];
    if(asText(record[key])!==asText(parsed.records[i][key]))lines[line]=prefix+asText(record[key]);
   }
  });
  out=lines.join(parsed.newline)+(parsed.endNewline?parsed.newline:'');
 } else if(parsed.type==='plain'){
  const lines=[...parsed.lines];
  parsed.lineIDs.forEach((n,j)=>{lines[n]=asText(records[j].shipping_address1);});
  out=lines.join(parsed.newline)+(parsed.endNewline?parsed.newline:'');
 }
 return (parsed.encodingBOM?'\uFEFF':'')+out;
}
function fieldPaths(records,max=160){
 const seen=new Map();
 const visit=(v,path,depth)=>{
  if(depth>4 || seen.size>=max)return;
  if(v && typeof v==='object' && !Array.isArray(v)){
   for(const [k,value] of Object.entries(v)){if(['__proto__','constructor','prototype'].includes(k))continue;visit(value,[...path,k],depth+1);}
  } else if(path.length){const id=JSON.stringify(path);if(!seen.has(id))seen.set(id,path);}
 };
 records.slice(0,Math.min(records.length,80)).forEach(record=>visit(record,[],0));
 return [...seen.values()];
}
function get(record,id){if(!id)return undefined;let segments;try{segments=JSON.parse(id);}catch(e){return undefined;}
 let cursor=record;for(const k of segments){if(!cursor||typeof cursor!=='object'||!OWN(cursor,k))return undefined;cursor=cursor[k];}return cursor;
}
function has(record,id){if(!id)return false;let path;try{path=JSON.parse(id);}catch(e){return false;}
 let cursor=record;for(const k of path){if(!cursor||typeof cursor!=='object'||!OWN(cursor,k))return false;cursor=cursor[k];}return true;
}
function protectedPath(id){if(!id)return false;let p;try{p=JSON.parse(id);}catch(e){return true;}const leaf=norm(p.at(-1));return /(?:password|passwd|passcode|email|username|userid|login|token|secret|cvv|cvc|cardnumber|creditcard|ccnumber|paymentmethod|expiration|expiry|accountid|accountnumber|orderid|ordernumber|profileid|skuid|sku|stripekey|apikey|authkey)/.test(leaf);}
function put(record,id,value){if(!id||protectedPath(id)||!has(record,id))return false;const path=JSON.parse(id);let cursor=record;for(const k of path.slice(0,-1))cursor=cursor[k];
 const k=path.at(-1);if(cursor[k]===value)return false;cursor[k]=value;return true;
}
const parts=['address1','address2','city','state','zip','first','last','full','phone','country','company'];
const labels={address1:'Address line 1',address2:'Address line 2 / unit',city:'City',state:'State',zip:'ZIP / postal',first:'First name',last:'Last name',full:'Full name',phone:'Phone',country:'Country',company:'Company',zip4source:'Existing ZIP+4 source'};
const fieldSpecs=[...parts.map(p=>({id:'shipping.'+p,group:'Shipping',part:p})),...parts.map(p=>({id:'billing.'+p,group:'Billing',part:p})),...['first','last','full'].map(p=>({id:'account.'+p,group:'Account',part:p})),{id:'shipping.zip4source',group:'Shipping',part:'zip4source'},{id:'billing.zip4source',group:'Billing',part:'zip4source'},{id:'billing.sameflag',group:'Billing',part:'sameflag'}];
const aliases={
 address1:['address1','addressline1','line1','addr1','street1','streetaddress','street','address','primaryaddress','shippingaddress','billingaddress'],
 address2:['address2','addressline2','line2','addr2','street2','secondaryaddress','unit','apartment','suite'],
 city:['city','town'],state:['state','province','region','statecode'],zip:['zip','zipcode','zip5','postal','postalcode','postcode'],
 first:['firstname','first','givenname','recipientfirst','shippingfirst','billingfirst'],last:['lastname','last','surname','familyname','recipientlast','shippinglast','billinglast'],
 full:['fullname','name','recipientname','customername','contactname'],phone:['phone','phonenumber','phonenum','contactphone','telephone','mobile'],country:['country','countrycode'],company:['company','organization'],
 zip4source:['zip4','zipcode4','plus4','zipplusfour','zipplus4','postal4'],sameflag:['billingsameasshipping','sameasshipping','billingisshipping']
};
function autoMap(records){
 const paths=fieldPaths(records),map={};
 const roleWords={shipping:['shipping','ship','delivery','recipient'],billing:['billing','bill','invoice'],account:['account','user','customer','profile','member']};
 for(const spec of fieldSpecs){
  let pick='',best=-100;
  for(const path of paths){
   const tokens=path.map(norm);const joined=tokens.join('');const last=tokens.at(-1);
   if(protectedPath(JSON.stringify(path)))continue;
   const relevant=aliases[spec.part]||[];let score=-50;
   for(const a of relevant){
    if(last===a)score=Math.max(score,50+(a.length>5?4:0));
    if(joined===a)score=Math.max(score,52);
    if(last.endsWith(a) && last.length>a.length && (a.length>=4 || roleWords[spec.group.toLowerCase()].some(w=>joined.startsWith(w))))score=Math.max(score,38);
   }
   if(score<0)continue;
   const group=spec.group.toLowerCase();
   const fullRole=roleWords[group].some(w=>tokens.some(t=>t.includes(w))||joined.startsWith(w));
   const otherRoles=Object.keys(roleWords).filter(r=>r!==group).some(r=>roleWords[r].some(w=>tokens.some(t=>t.includes(w))||joined.startsWith(w)));
   if(fullRole)score+=40;
   else if(otherRoles)score-=100;
   else if(group==='account' && ['first','last','full'].includes(spec.part))score+=15;
   else if(group==='shipping'&&spec.part==='phone')score+=20;
   else if(group==='shipping'&& !['first','last','full','phone','company','country'].includes(spec.part))score+=10;
   else score-=35;
   if(spec.part==='full' && /(first|last|given|family|sur)name/.test(last))score-=99;
   if(['first','last'].includes(spec.part) && /fullname|full_name/.test(last))score-=99;
   if(spec.part==='zip4source' && /zip5/.test(last))score-=99;
   if(spec.part==='address1' && /address2|line2|street2/.test(last))score-=99;
   if(spec.part==='address2' && /address1|line1|street1/.test(last))score-=99;
   if(score>best){best=score;pick=JSON.stringify(path);}
  }
  if(best>=20 || (spec.part==='sameflag' && best>=10))map[spec.id]=pick;
 }
 // Avoid one column being silently mapped to both the shipping and billing destination.
 for(const part of parts){if(map['shipping.'+part]===map['billing.'+part])delete map['billing.'+part];}
 return map;
}
function canonicalPart(s){
 return asText(s).toLowerCase().replace(/\b(northwest|nw)\b/g,'nw').replace(/\b(northeast|ne)\b/g,'ne').replace(/\b(southwest|sw)\b/g,'sw').replace(/\b(southeast|se)\b/g,'se')
 .replace(/\b(drive|dr)\b/g,'dr').replace(/\b(avenue|ave)\b/g,'ave').replace(/\b(street|st)\b/g,'st').replace(/\b(road|rd)\b/g,'rd').replace(/\b(lane|ln)\b/g,'ln').replace(/\b(boulevard|blvd)\b/g,'blvd')
 .replace(/\b(suite|ste|apartment|apt|unit)\b/g,'unit').replace(/#/g,' unit ').replace(/\bsecond\b/g,'2nd').replace(/\btwo\b/g,'2nd').replace(/\b2(?!\w)\b/g,'2nd').replace(/\s+/g,' ').replace(/[^a-z0-9 ]+/g,'').trim();
}
function addrKey(row,mapping,role){
 const getv=p=>asText(get(row,mapping[role+'.'+p]));
 return [canonicalPart(getv('address1')),canonicalPart(getv('address2')),norm(getv('state')),zip5(getv('zip'))].join('|');
}
function addressFingerprint(v){return [v.address1,v.address2,v.city,v.state,v.zip].map(x=>asText(x).trim().replace(/\s+/g,' ').toLowerCase()).join('|');}
function getAddress(row,mapping,role){let x={};for(const p of parts)x[p]=get(row,mapping[role+'.'+p]);return x;}
function setAddress(row,mapping,role,candidate){let changes=0;for(const p of ['address1','address2','city','zip']){if(candidate[p]!==undefined && put(row,mapping[role+'.'+p],candidate[p]))changes++;}return changes;}
function splitStreet(s){
 // Never allow address jig rules to change the leading house number or a unit identifier.
 const text=asText(s);
 const m=text.match(/^(\s*\d+[a-zA-Z]?(?:\s*[-/]\s*\d+)?\s+)([\s\S]*)$/);
 if(!m)return null;
 const unit=m[2].match(/^(.*?)(\s+(?:Suite|Ste\.?|Apt\.?|Apartment|Unit|#)\s*[^,]*?)$/i);
 return {head:m[1],street:unit?unit[1]:m[2],unit:unit?unit[2]:''};
}
function streetChange(s,re,replace){
 const split=splitStreet(s);if(!split)return null;
 const result=split.street.replace(re,replace);if(result===split.street)return null;
 return split.head+result+split.unit;
}
function unitChange(s,from,to){
 const input=asText(s);
 const esc=from==='\u0023'?'#':from;
 const re=from==='#'?/(^|\s)#(?=\s*[a-zA-Z0-9-])/i:new RegExp('(^|\\s)('+esc+')(\\.?)(?=\\s+[a-zA-Z0-9-])','i');
 const out=input.replace(re,(match,space)=>space+to);
 return out!==input?out:null;
}
function makeRules(){
 const rules=[];
 const addStreet=(id,label,re,tgt)=>rules.push({id,label,apply(v){const r=streetChange(v.address1,re,tgt);return r?{...v,address1:r}:null;}});
 const pairs=[['drive','Drive','DR'],['avenue','Avenue','Ave'],['road','Road','Rd'],['street','Street','St'],['lane','Lane','Ln'],['boulevard','Boulevard','Blvd'],['court','Court','Ct'],['circle','Circle','Cir']];
 for(const [key,long,short] of pairs){
  addStreet(key+'_short',long+' → '+short,new RegExp('\\b'+long+'\\b','i'),short);
  addStreet(key+'_long',short+' → '+long,new RegExp('\\b'+short+'\\b','i'),long);
 }
 // This experimental rule is excluded from defaults and from Select All.
 // It appends a fractional house-number suffix to an integer number even when
 // the original does not contain one. A real fractional delivery point must be
 // confirmed before a file generated with this option is used for shipping.
 rules.push({id:'fraction_half',label:'Add 1/2 to an integer house number (manual verification required)',experimental:true,apply(v){
  const before=asText(v.address1),m=before.match(/^(\s*)(\d{1,7})(\s+)(\S[\s\S]*)$/);
  if(!m || /^(?:\d+\s*\/\s*\d+|½)(?:\s|$)/i.test(m[4]))return null;
  if(!/^[a-zA-Z0-9]/.test(m[4]))return null;
  return {...v,address1:m[1]+m[2]+' 1/2'+m[3]+m[4]};
 }});
 const dirs=[['nw','NW','Northwest'],['ne','NE','Northeast'],['sw','SW','Southwest'],['se','SE','Southeast']];
 for(const [key,short,long] of dirs){
  addStreet(key+'_long',short+' → '+long,new RegExp('\\b'+short+'\\b','i'),long);
  addStreet(key+'_short',long+' → '+short,new RegExp('\\b'+long+'\\b','i'),short);
 }
 const ordList=['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen','twenty'];
 const ordName=['zeroth','first','second','third','fourth','fifth','sixth','seventh','eighth','ninth','tenth','eleventh','twelfth','thirteenth','fourteenth','fifteenth','sixteenth','seventeenth','eighteenth','nineteenth','twentieth'];
 const toOrd=n=>n%100>=11&&n%100<=13?'th':n%10===1?'st':n%10===2?'nd':n%10===3?'rd':'th';
 const ordinalRe=/\b([1-9]|1\d|20)(st|nd|rd|th)\b/gi;
 addStreet('ordinal_number','2nd → 2 (street only)',ordinalRe,(m,n)=>String(Number(n)));
 addStreet('ordinal_word','2nd → two (street only)',ordinalRe,(m,n)=>ordList[Number(n)]||m);
 addStreet('ordinal_spelled','2nd → second (street only)',ordinalRe,(m,n)=>ordName[Number(n)]||m);
 addStreet('number_ordinal','2 → 2nd (street only)',/\b([1-9]|1\d|20)\b/g,(m,n)=>n+toOrd(Number(n)));
 addStreet('word_ordinal','two → 2nd (street only)',/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/gi,(m)=>{let n=ordList.indexOf(m.toLowerCase());return n+toOrd(n);});
 addStreet('spelled_ordinal','second → 2nd (street only)',/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/gi,(m)=>{let n=ordName.indexOf(m.toLowerCase());return n+toOrd(n);});
 // High-alert variants. These can invalidate the mailing address and are never selected by default.
 rules.push({id:'typo_double',label:'Repeat one letter in street name (example: Marple → Marrple)',apply(v){
  const t=splitStreet(v.address1);if(!t)return null;
  const m=t.street.match(/\b([A-Za-z]{5,})\b/);if(!m)return null;
  const word=m[1],mid=Math.min(Math.max(1,Math.floor(word.length/2)),word.length-2);
  const next=word.slice(0,mid)+word[mid]+word.slice(mid);
  return {...v,address1:t.head+t.street.replace(word,next)+t.unit};
 }});
 rules.push({id:'typo_swap',label:'Transpose neighboring letters in street name',apply(v){
  const t=splitStreet(v.address1);if(!t)return null;
  const m=t.street.match(/\b([A-Za-z]{5,})\b/);if(!m)return null;
  const w=m[1],i=Math.min(Math.max(1,Math.floor(w.length/2)),w.length-2);
  if(w[i].toLowerCase()===w[i+1].toLowerCase())return null;
  const next=w.slice(0,i)+w[i+1]+w[i]+w.slice(i+2);
  return {...v,address1:t.head+t.street.replace(w,next)+t.unit};
 }});
 addStreet('typo_north','North → Norrth (misspelled direction)',/\bNorth\b/i,'Norrth');
 addStreet('typo_south','South → Soutth (misspelled direction)',/\bSouth\b/i,'Soutth');
 addStreet('typo_east','East → Easst (misspelled direction)',/\bEast\b/i,'Easst');
 addStreet('typo_west','West → Wesst (misspelled direction)',/\bWest\b/i,'Wesst');
 addStreet('typo_nw','NW → NWW (misspelled direction)',/\bNW\b/i,'NWW');
 // Explicitly selected advanced formatting. These work on imported/local draft
 // records only; they do not call or modify any website API.
 const letters=value=>{
  let number=stableHash(value);let out='';
  for(let i=0;i<3;i++){out=String.fromCharCode(65+(number%26))+out;number=Math.floor(number/26);}
  return out;
 };
 for(let variant=1;variant<=4;variant++){
  const offset=variant;
  rules.push({id:'prefix_three_'+variant,label:'Three-letter prefix, variant '+variant,experimental:true,apply(v){
   const original=asText(v.address1).trim();if(!original||/^[A-Z]{3}\s+/.test(original))return null;
   const token=letters(original+'|'+asText(v.zip)+'|'+offset);
   return {...v,address1:token+' '+original};
  }});
 }
 for(const [id,value] of [['invented_apt','APT 999'],['invented_unit','UNIT 998'],['invented_suite','STE X9']]){
  rules.push({id,label:'Set secondary address to '+value,experimental:true,apply(v){
   return asText(v.address2).trim().toUpperCase()===value?null:{...v,address2:value};
  }});
 }
 rules.push({id:'house_letter_a',label:'Add letter A to a whole-number house number',experimental:true,apply(v){
  const before=asText(v.address1),m=before.match(/^(\s*)(\d{1,7})(\s+)(\S[\s\S]*)$/);
  return m?{...v,address1:m[1]+m[2]+'A'+m[3]+m[4]}:null;
 }});
 for(const n of [0,1,2])rules.push({id:'custom_zip4_'+n,label:'Set local draft ZIP+4 suffix to '+String(n).padStart(4,'0'),experimental:true,apply(v){
  const z=asText(v.zip).trim();if(!/^\d{5}(?:-\d{4})?$/.test(z))return null;
  const next=z.slice(0,5)+'-'+String(n).padStart(4,'0');return next===z?null:{...v,zip:next};
 }});
 const prefix=['Suite','Ste','Apt','Unit','Apartment','#'];
 for(const from of prefix){for(const to of prefix){if(from===to)continue;
  const id='unit_'+norm(from)+'_'+norm(to);const label=from+' → '+to+' (keep unit number)';
  rules.push({id,label,apply(v){const a1=unitChange(v.address1,from,to);if(a1)return {...v,address1:a1};const a2=unitChange(v.address2,from,to);return a2?{...v,address2:a2}:null;}});
 }}
 return rules;
}
const RULES=makeRules();
const defaultRuleIDs=['drive_short','drive_long','avenue_short','avenue_long','nw_long','nw_short','ordinal_number','ordinal_word','ordinal_spelled','unit_suite_apt','unit_suite_unit','unit_suite_' ,'unit_ste_apt','unit_ste_unit','unit_apt_unit'];
function stableHash(str){let x=2166136261;for(let i=0;i<str.length;i++){x^=str.charCodeAt(i);x=Math.imul(x,16777619);}return x>>>0;}
function seededShuffle(array,seed){const out=[...array];let state=stableHash(seed)||1;const rnd=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/4294967296;};for(let i=out.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[out[i],out[j]]=[out[j],out[i]];}return out;}
const FIRST=['Avery','Morgan','Jordan','Casey','Riley','Taylor','Cameron','Quinn','Parker','Rowan','Jamie','Harper','Logan','Emerson','Skyler','Alex','Reese','Drew','Hayden','Finley','Ellis','Blake','Dakota','Sydney','Kendall','Arden','Bailey','Sage','Lane','Charlie','Jesse','Marlowe','Robin','Noel','Remy','Sawyer','Tatum','Wren','Frankie','Shiloh','Elliot','Ari','Devon','Lennon','Micah','Toni','Briar','Peyton'];
const LAST=['Bennett','Morgan','Reed','Sullivan','Parker','Hayes','Brooks','Collins','Turner','Cooper','Foster','Gray','Hughes','Walker','Perry','Price','James','Ellis','Quinn','Bailey','Coleman','Stewart','Miller','Warren','Carson','Knight','Howard','Dawson','Stone','Harper','Chandler','Rowe','Hamilton','Palmer','Gibson','Fletcher','Shaw','Burke','Wells','Nolan','Holland','Finch','Lowe','Reeves','Porter','Wood','Bishop','Andrews'];
function makePerson(seed,used){
 let id=stableHash(seed)%(FIRST.length*LAST.length);let n=0;
 while(used.has(id)&&n<FIRST.length*LAST.length){id=(id+1)%(FIRST.length*LAST.length);n++;}
 used.add(id);return {first:FIRST[id%FIRST.length],last:LAST[Math.floor(id/FIRST.length)]};
}
function normalizeLookupRows(input){
 // Imported data is *not* independently verified; user must supply an authoritative source.
 if(!input)return [];
 const compact=o=>{const obj={};for(const [k,v] of Object.entries(o))obj[norm(k)]=asText(v).trim();return obj;};
 return input.map(compact).filter(o=>Object.keys(o).length);
}
function parseLookup(name,text){
 let data;if(/\.json$/i.test(name)){
  const obj=JSON.parse(text.replace(/^\uFEFF/,''));data=Array.isArray(obj)?obj:Array.isArray(obj.records)?obj.records:[];
 }else{
  const p=parseFile(name,text);data=p.records;
 }
 if(!data.length || data.some(row=>!row || typeof row!=='object'))throw Error('Lookup must have CSV/JSON rows.');
 return normalizeLookupRows(data);
}
function lookupCandidates(v,lookups){
 const out={cities:[],zip4:''};const z=zip5(v.zip);
 if(!z || !lookups?.length)return out;
 const sourceCity=norm(v.city), sourceState=norm(v.state)==='florida'?'fl':norm(v.state),baseAddr=canonicalPart(v.address1),baseUnit=canonicalPart(v.address2);
 const hasFloridaReference=sourceState==='fl' && lookups.some(r=>r.source==='florida-zip-reference' && zip5(r.zip)===z);
 const addCity=city=>{if(city && norm(city)!==sourceCity && !out.cities.some(x=>norm(x)===norm(city)))out.cities.push(city);};
 for(const r of lookups){
  const rz=zip5(r.zip5||r.zip||r.zipcode||r.postalcode);
  if(rz!==z)continue;
  const state=norm(r.state||r.statecode);if(state&&sourceState&&state!==sourceState)continue;
  const city=(r.city||r.primarycity||r.preferredcity||'');const alt=(r.alternatecity||r.altcity||r.validcity||r.acceptedcity||r.alias||'');
  const cities=[city,...alt.split(/[|;,]/).map(x=>x.trim())].filter(Boolean);
  // A ZIP locality lookup is not proof of an accepted mailing name. For Florida,
  // favor the preferred/acceptable city reference over generic locality suggestions.
  if((!hasFloridaReference || r.source==='florida-zip-reference') && cities.some(x=>norm(x)===sourceCity))cities.forEach(addCity);
  const refStreet=r.address1||r.street||r.streetaddress||r.addressline1||'';
  const refUnit=r.address2||r.unit||r.addressline2||'';
  const plus4=r.zip4||r.plus4||r.zipplus4||'';
  // Never add ZIP+4 without matching an actual street and house number.
  if(plus4 && /^\d{4}$/.test(plus4)&&refStreet&&canonicalPart(refStreet)===baseAddr && canonicalPart(refUnit)===baseUnit){
   if(!city||norm(city)===sourceCity||cities.some(x=>norm(x)===sourceCity))out.zip4=plus4;
  }
 }
 return out;
}
function proposeVariants(original, options, lookup, rowSeed){
 const applicable=RULES.filter(r=>options.rules.includes(r.id));
 let candidates=[];let queue=[{...original, depth:0}],seen=new Set([addressFingerprint(original)]);
 const zipCurrent=asText(original.zip).trim();
 const derived=lookupCandidates(original,lookup);
 const zip4FromField=asText(original.zip4source).trim();
 const plus4=!/-\d{4}$/.test(zipCurrent) && /^\d{5}$/.test(zipCurrent)
  ? (/^\d{4}$/.test(zip4FromField)?zip4FromField:derived.zip4):'';
 const extras=[];
 if(options.useZip4 && plus4)extras.push({id:'zip4',apply:v=>({...v,zip:zipCurrent+'-'+plus4})});
 if(options.useCityAliases)for(const city of derived.cities)extras.push({id:'city_'+city,apply:v=>({...v,city})});
 const actions=[...applicable,...extras];
 if(options.combineStyles&&options.comboMode==='manual'){
  const requested=(options.comboRuleIds||[]).filter(Boolean);
  if(requested.length<2||new Set(requested).size!==requested.length)return [];
  let result={...original};
  for(const id of requested){
   const rule=applicable.find(r=>r.id===id)||(id==='zip4'?extras.find(r=>r.id==='zip4'):id==='city_alias'?extras.find(r=>r.id.startsWith('city_')):null);
   if(!rule)return [];
   try{result=rule.apply(result);}catch(_){return [];}
   if(!result)return [];
  }
  if(addressFingerprint(result)===addressFingerprint(original))return [];
  return [result];
 }
 // Only use multiple selected transformations when explicitly enabled.
 for(let depth=0;depth<(options.combineStyles?3:1);depth++){
  const current=queue.filter(x=>x.depth===depth);let next=[];
  for(const state of current){for(const action of actions){
   let candidate;
   try{candidate=action.apply(state);}catch(e){continue;}
   if(!candidate)continue;
   candidate={...candidate,depth:depth+1};
   const id=addressFingerprint(candidate);
   if(seen.has(id))continue;
   seen.add(id);candidates.push(candidate);next.push(candidate);
   if(candidates.length>=400)break;
  } if(candidates.length>=400)break;}
  queue=next;
  if(!next.length || candidates.length>=400)break;
 }
 return seededShuffle(candidates,rowSeed);
}
function applyName(row,map,role,person){let n=0;
 for(const [part,val] of [['first',person.first],['last',person.last],['full',person.first+' '+person.last]]){
  if(put(row,map[role+'.'+part],val))n++;
 }return n;
}
function billingMirror(row,map){let changed=0,matched=0,missing=[];
 for(const part of parts){
  const source=map['shipping.'+part],dest=map['billing.'+part];
  if(!source || !dest)continue;
  if(!has(row,source)||!has(row,dest)){missing.push(part);continue;}
  const value=get(row,source);
  if(value===undefined)continue;
  matched++;changed+=put(row,dest,value)?1:0;
 }
 const flag=map['billing.sameflag'];
 if(flag && has(row,flag)){
  const old=get(row,flag);const v=typeof old==='boolean'?true:typeof old==='number'?1:'true';
  changed+=put(row,flag,v)?1:0;
 }
 return {changed,matched,missing};
}
function plan(parsed,mapping,options,lookups=[]){
 const out=clone(parsed.records),stats={rows:out.length,changed:0,jigged:0,named:0,mirrored:0,original:0,noUnique:0,unmapped:0,zip4Missing:0,cityMissing:0};
 const notes=out.map(()=>[]),changedKeys=out.map(()=>[]);
 const original=parsed.records;
 const selectedRows=Array.isArray(options.selectedRows)?new Set(options.selectedRows.filter(i=>Number.isInteger(i)&&i>=0&&i<out.length)):new Set(out.map((_,i)=>i));
 const seed=asText(options.seed||'default');
 const groupAndJig=(role)=>{
  const groups=new Map();
  for(let i=0;i<out.length;i++){
   const row=out[i];const line1=asText(get(row,mapping[role+'.address1']));
   if(!line1.trim())continue;
   const key=addrKey(row,mapping,role);
   if(!groups.has(key))groups.set(key,[]);
   groups.get(key).push(i);
  }
  for(const [key,ids] of groups){
   if(!key.split('|')[0])continue;
   const held=ids.find(i=>!selectedRows.has(i))??ids[0];
   const used=new Set(ids.filter(i=>!selectedRows.has(i)||i===held).map(i=>addressFingerprint(getAddress(out[i],mapping,role))));
   for(const i of ids){
    const row=out[i],v=getAddress(row,mapping,role);
    v.zip4source=get(row,mapping[role+'.zip4source']);
    if(!selectedRows.has(i)){notes[i].push(role+' excluded by selection');continue;}
    if(i===held){stats.original++;notes[i].push(role+' original kept');continue;}
    
    const candidates=proposeVariants(v,options,lookups,seed+'|'+role+'|'+key+'|'+i);
    const selected=candidates.find(candidate=>!used.has(addressFingerprint(candidate)));
    if(!selected){stats.noUnique++;notes[i].push(role+' no selected rule produced a unique jig');continue;}
    const n=setAddress(row,mapping,role,selected);
    if(n){stats.jigged++;notes[i].push(role+' jig applied');used.add(addressFingerprint(selected));}
    else{stats.noUnique++;notes[i].push(role+' jig fields could not be edited');}
   }
  }
  if(!groups.size)stats.unmapped++;
 };
 if(options.jigShipping)groupAndJig('shipping');
 if(options.jigBilling && !options.billingSame)groupAndJig('billing');
 const usedNames=new Set();
 const allPhonePaths=[mapping['shipping.phone'],mapping['billing.phone']].filter(Boolean);
 const usedPhones=new Set();
 if(options.jigPhones===true&&allPhonePaths.length){
  if(!phoneTools?.jigPhone)throw Error('Phone jig helper is unavailable. Update or reinstall Jig Studio.');
  // Reserve original numbers to prevent a new profile alias from matching a different base number.
  for(const row of original){for(const field of allPhonePaths){
   const source=asText(get(row,field)).trim();if(source)usedPhones.add(phoneTools.phoneKey(source));
  }}
 }
 for(let i=0;i<out.length;i++){
  const row=out[i];
  if(!selectedRows.has(i)){notes[i].push('Excluded by account selection');continue;}
  const p=makePerson(seed+'|'+parsed.name+'|'+i,usedNames);
  let didName=0;
  if(options.namesAccount)didName+=applyName(row,mapping,'account',p);
  if(options.namesShipping||(options.namesAccount&&options.syncNames))didName+=applyName(row,mapping,'shipping',p);
  if((options.namesBilling||(options.namesAccount&&options.syncNames))&&!options.billingSame)didName+=applyName(row,mapping,'billing',p);
  if(didName){stats.named++;notes[i].push('randomized name');}
  if(options.billingSame){
   const r=billingMirror(row,mapping);if(r.changed){stats.mirrored++;notes[i].push('billing copied from shipping');}
   if(!r.matched && !mapping['billing.sameflag'])notes[i].push('no matching billing fields mapped');
  }
  if(options.jigPhones===true){
   const shipKey=mapping['shipping.phone'],billKey=mapping['billing.phone'];
   const originalPhone=asText(get(original[i],shipKey)||get(original[i],billKey)).trim();
   if(originalPhone&&(shipKey||billKey)){
    const changed=phoneTools.jigPhone(originalPhone,usedPhones);
    const applied=put(row,shipKey||billKey,changed);
    if(options.billingSame&&billKey&&shipKey)put(row,billKey,changed);
    if(applied){stats.phoneJigged=(stats.phoneJigged||0)+1;notes[i].push('phone: one local digit changed; area code unchanged (not verified)');}
   }else notes[i].push('phone number missing or phone field not mapped');
  }
  const before=fieldPaths([original[i]],180);
  for(const path of before){const encoded=JSON.stringify(path),a=get(original[i],encoded),b=get(row,encoded);
   if(JSON.stringify(a)!==JSON.stringify(b))changedKeys[i].push(path.join('.'));
  }
  if(changedKeys[i].length)stats.changed++;
 }
 if(options.useZip4 && options.jigShipping){
  for(const row of out){
   const zip=asText(get(row,mapping['shipping.zip']));if(!/\d{5}-\d{4}/.test(zip)){const addr=getAddress(row,mapping,'shipping');addr.zip4source=get(row,mapping['shipping.zip4source']);
    if(!/^\d{4}$/.test(asText(addr.zip4source))&&!lookupCandidates(addr,lookups).zip4)stats.zip4Missing++;
   }
  }
 }
 if(options.useCityAliases && !lookups.length)stats.cityMissing=out.length;
 return {records:out,stats,notes,changedKeys};
}
function verifyUntouched(parsed,processed,mapping={},options={}){
 const issues=[];
 const edits=processed.changedKeys;
 if(parsed.records.length!==processed.records.length)return {ok:false,issues:['Record count changed.']};
 const paths=new Set();
 const allowed=new Set();
 const allow=(role,p)=>{if(mapping[role+'.'+p])allowed.add(JSON.parse(mapping[role+'.'+p]).join('.'));};
 if(options.jigShipping){for(const p of ['address1','address2','city','zip'])allow('shipping',p);}
 if(options.jigBilling&&!options.billingSame){for(const p of ['address1','address2','city','zip'])allow('billing',p);}
 if(options.namesAccount)for(const p of ['first','last','full'])allow('account',p);
 if(options.namesShipping||(options.namesAccount&&options.syncNames))for(const p of ['first','last','full'])allow('shipping',p);
 if((options.namesBilling||(options.namesAccount&&options.syncNames))&&!options.billingSame)for(const p of ['first','last','full'])allow('billing',p);
 if(options.jigPhones===true){allow('shipping','phone');if(options.billingSame)allow('billing','phone');else if(!mapping['shipping.phone'])allow('billing','phone');}
 if(options.billingSame){for(const p of parts)allow('billing',p);if(mapping['billing.sameflag'])allowed.add(JSON.parse(mapping['billing.sameflag']).join('.'));}
 const objs=(original,newer,prefix)=>{
  if(original && typeof original==='object' && !Array.isArray(original)){
   const a=Object.keys(original),b=Object.keys(newer||{});if(a.length!==b.length||a.some(x=>!OWN(newer,x)))issues.push('Object keys changed at '+prefix);
   for(const k of a)objs(original[k],newer?.[k],prefix?prefix+'.'+k:k);
  } else if(Array.isArray(original)){
   if(!Array.isArray(newer)||original.length!==newer.length)issues.push('Array shape changed at '+prefix);
   else original.forEach((item,j)=>objs(item,newer[j],prefix+'['+j+']'));
  } else if(JSON.stringify(original)!==JSON.stringify(newer))paths.add(prefix);
 };
 parsed.records.forEach((r,i)=>objs(r,processed.records[i],String(i)));
 const selected=Array.isArray(options.selectedRows)?new Set(options.selectedRows):null;
 for(const p of paths){const m=p.match(/^(\d+)\.(.*)$/);if(m && ((selected&&!selected.has(Number(m[1]))) || !allowed.has(m[2]) || protectedPath(JSON.stringify(m[2].split('.')))))issues.push('Unpermitted field modification: '+p);}
 return {ok:!issues.length,issues};
}
return {parseDelimited,serialDelimited,parseFile,serialize,fieldPaths,autoMap,get,put,has,plan,parseLookup,lookupCandidates,RULES,defaultRuleIDs,fieldSpecs,parts,labels,zip5,canonicalPart,addressFingerprint,verifyUntouched};
})();
if(typeof module!=='undefined' && module.exports)module.exports=JigCore;
/* SLABSNGRABSACO Jig Studio - UI and local downloads */
(() => {
'use strict';
const $=id=>document.getElementById(id);
const htmlEscape=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const app={files:[],selected:0,lookups:[],onlyChanged:false,results:new Map(),rowPage:0};
const optionIDs=['jigShipping','jigPhones','billingSame','jigBilling','namesAccount','namesShipping','namesBilling','syncNames','useZip4','useCityAliases','combineStyles'];
const randomSeed=()=>{
 const v=new Uint32Array(2);
 if(window.crypto?.getRandomValues)window.crypto.getRandomValues(v);else {v[0]=Math.floor(Math.random()*2**32);v[1]=Math.floor(Math.random()*2**32);}
 return [...v].map(x=>x.toString(16).padStart(8,'0')).join('').toUpperCase();
};
$('seed').value=randomSeed();
function options(){return {
 jigShipping:$('jigShipping').checked,jigPhones:$('jigPhones').checked,billingSame:$('billingSame').checked,jigBilling:$('jigBilling').checked,
 namesAccount:$('namesAccount').checked,namesShipping:$('namesShipping').checked,namesBilling:$('namesBilling').checked,syncNames:$('syncNames').checked,
 useZip4:$('useZip4').checked,useCityAliases:$('useCityAliases').checked,
 combineStyles:$('combineStyles').checked,comboMode:$('combineMode').value,comboRuleIds:['comboRule1','comboRule2','comboRule3'].map(id=>$(id).value).filter(Boolean),selectedRows:fileEntry()?.selection?Array.from(fileEntry().selection):null,seed:$('seed').value.trim()||'DEFAULT',rules:selectedRuleIds()
};}
function fileEntry(){return app.files[app.selected]||null;}
function mapLabel(spec){if(spec.part==='sameflag')return 'Existing same-as-shipping flag';return JigCore.labels[spec.part]||spec.part;}
// A single checkbox controls each formatting CATEGORY, not each of the engine's 67 transformations.
// Examples use entirely fictional data and explain the before/after of each category.
const JIG_GROUP_UI=[
 {id:'street',title:'Street suffix formatting',section:'line1',description:'Recognized Ave, Drive, Road, Street and similar abbreviations.',before:'100 Example Avenue',after:'100 Example Ave',match:r=>/^(drive|avenue|road|street|lane|boulevard|court|circle)_/.test(r.id)},
 {id:'direction',title:'Compass directions',section:'line1',description:'Standard Northwest/NW, Southwest/SW and related abbreviations.',before:'100 Northwest Example St',after:'100 NW Example St',match:r=>/^(nw|ne|sw|se)_/.test(r.id)},
 {id:'ordinal',title:'Street ordinals',section:'line1',description:'Formats such as second / 2nd / 2 on a genuinely numbered street.',before:'100 2nd Street',after:'100 Second Street',match:r=>/ordinal/.test(r.id)},
 {id:'unit',title:'Existing suite / apartment labels',section:'line2',description:'Change the unit label, preserving the real unit identifier.',before:'Apartment 4B',after:'Unit 4B',match:r=>r.id.startsWith('unit_')},
 {id:'zip',title:'Verified ZIP+4',section:'postal',description:'Only use confirmed postal ZIP digits from your address lookup.',before:'12345-6789 (verified)',after:'12345',external:'useZip4'},
 {id:'city',title:'Verified alternate city',section:'postal',description:'Only use an address-specific, USPS-verified mailing-city alias.',before:'Example City',after:'USPS-confirmed alternate city',external:'useCityAliases'},
 {id:'typo',title:'Double letters / misspellings',section:'advanced',description:'Alter one street-name character in local files (manual choice).',before:'100 Example Lane',after:'100 Exammple Lane',experimental:true,match:r=>r.id.startsWith('typo_')},
 {id:'prefix',title:'Three-letter address prefixes',section:'advanced',description:'Generate a reproducible three-letter prefix for imported profiles.',before:'100 Example St',after:'ABC 100 Example St',experimental:true,match:r=>r.id.startsWith('prefix_three_')},
 {id:'fraction',title:'Fractional house numbers',section:'advanced',description:'Add 1/2 to an existing whole-number house number.',before:'100 Example St',after:'100 1/2 Example St',experimental:true,match:r=>r.id==='fraction_half'},
 {id:'unitfake',title:'Custom secondary units',section:'advanced',description:'Insert or replace a secondary unit in a local draft.',before:'100 Example St',after:'100 Example St, Apt 999',experimental:true,match:r=>r.id.startsWith('invented_')},
 {id:'alpha',title:'Alphanumeric house number',section:'advanced',description:'Append a letter to a numeric house number.',before:'100 Example St',after:'100A Example St',experimental:true,match:r=>r.id.startsWith('house_letter_')},
 {id:'customzip',title:'Custom ZIP+4 suffix',section:'advanced',description:'Add a chosen four-digit suffix to local draft ZIP data.',before:'12345',after:'12345-0000',experimental:true,match:r=>r.id.startsWith('custom_zip4_')}
];
function selectedRuleIds(){
 const result=new Set();
 for(const box of document.querySelectorAll('#ruleGroups input[data-group]:checked')){
  const group=JIG_GROUP_UI.find(g=>g.id===box.dataset.group);
  if(group&&group.match)for(const rule of JigCore.RULES)if(group.match(rule))result.add(rule.id);
 }
 return [...result];
}
function buildRuleGroups(){
 const sections=[
  {key:'line1',title:'Address Line 1',description:'Street suffixes, directions, ordinals and fractional proposals',icon:'⌁'},
  {key:'line2',title:'Address Line 2',description:'Existing unit and apartment designators',icon:'⌂'},
  {key:'postal',title:'ZIP and city',description:'Only verified location formatting',icon:'▤'},
  {key:'advanced',title:'Advanced formatting tools',description:'Selectable local draft transformations with a before/after example',icon:'✦'}
 ];
 const holder=$('ruleGroups');holder.replaceChildren();
 const exampleFor=group=>{
  const example=document.createElement('span');example.className='ruleExample';
  const eyebrow=document.createElement('em');eyebrow.textContent='EXAMPLE';
  const before=document.createElement('span');before.textContent=group.before;
  const arrow=document.createElement('b');arrow.textContent='→';
  const after=document.createElement('span');after.textContent=group.after;
  example.append(eyebrow,before,arrow,after);return example;
 };
 for(const section of sections){
  const card=document.createElement('div');card.className='ruleCategory';
  const head=document.createElement('div');head.className='ruleCardHeader';
  const symbol=document.createElement('span');symbol.className='ruleIcon';symbol.textContent=section.icon;
  const name=document.createElement('strong');name.textContent=section.title;
  const sub=document.createElement('small');sub.textContent=section.description;head.append(symbol,name,sub);card.append(head);
  for(const group of JIG_GROUP_UI.filter(g=>g.section===section.key)){
   const row=document.createElement('label');row.className='rule ruleExampleRow';
   const check=document.createElement('input');check.type='checkbox';check.dataset.group=group.id;check.value=group.id;
   if(group.external){
    check.checked=$(group.external).checked;
    check.addEventListener('change',()=>{$(group.external).checked=check.checked;updateComboSelectors();invalidate();if(group.external==='useCityAliases' && check.checked && !app.lookups.some(r=>r.source==='florida-zip-reference'))loadFloridaCityReference();});
   }else{
    check.checked=!group.experimental&&JigCore.RULES.some(r=>group.match?.(r)&&JigCore.defaultRuleIDs.includes(r.id));
    check.addEventListener('change',()=>{
     updateComboSelectors();invalidate();
    });
   }
   const body=document.createElement('span');body.className='ruleExampleCopy';
   const title=document.createElement('strong');title.textContent=group.title;
   const help=document.createElement('small');help.textContent=group.description;
   body.append(title,help,exampleFor(group));
   const label=document.createElement('span');label.className='riskTag '+(group.experimental?'high-alert':group.section==='line2'?'risky':'safe');
   label.textContent=group.experimental?'OPTIONAL':group.section==='line2'?'REVIEW':'STANDARD';
   row.append(check,body,label);card.append(row);
  }
  holder.append(card);
 }
 updateComboSelectors();ruleCount();
}
function updateComboSelectors(){
 const opts=selectedRuleIds().map(x=>JigCore.RULES.find(r=>r.id===x)).filter(Boolean);
 for(const id of ['comboRule1','comboRule2','comboRule3']){
  const box=$(id),old=box.value;box.replaceChildren();
  const empty=document.createElement('option');empty.value='';empty.textContent='— Choose rule —';box.append(empty);
  for(const r of opts){const option=document.createElement('option');option.value=r.id;option.textContent=r.label;box.append(option);}
  if($('useZip4').checked){const o=document.createElement('option');o.value='zip4';o.textContent='ZIP+4 from matched data';box.append(o);}
  if($('useCityAliases').checked){const o=document.createElement('option');o.value='city_alias';o.textContent='Verified alternate city';box.append(o);}
  box.value=[...box.options].some(r=>r.value===old)?old:'';
 }
 syncCombine();
}
function syncCombine(){
 const checked=$('combineStyles').checked;
 $('combineMode').disabled=!checked;
 $('manualCombo').hidden=!checked||$('combineMode').value!=='manual';
}
function ruleCount(){const n=document.querySelectorAll('#ruleGroups input[data-group]:checked').length;$('ruleCount').textContent=n+' grouped formatting choices selected · '+selectedRuleIds().length+' supported address transformations available';}
function setRules(mode){for(const c of document.querySelectorAll('#ruleGroups input[data-group]')){const g=JIG_GROUP_UI.find(x=>x.id===c.dataset.group);c.checked=!!g&&(mode==='all'||(mode==='recommended'&&!g.experimental&&JigCore.RULES.some(r=>g.match?.(r)&&JigCore.defaultRuleIDs.includes(r.id))));if(g?.external)$(g.external).checked=c.checked;}updateComboSelectors();invalidate();if($('useCityAliases').checked && !app.lookups.some(r=>r.source==='florida-zip-reference'))loadFloridaCityReference();}
function limitSize(file){if(file.size>26*1024*1024)throw Error('This file exceeds the 26 MB local processing limit.');}
async function ingestFiles(list){
 const items=Array.from(list||[]);if(!items.length)return;
 window.JigStudioCards?.studio?.clear();
 for(const file of items){
  const name=file.name||'unnamed.txt',extension=name.split('.').pop().toLowerCase();
  if(!['csv','tsv','tab','psv','json','jsonl','ndjson','txt'].includes(extension)){
   app.files.push({name,error:'Unsupported file extension; export will be skipped.'});continue;
  }
  try{
   limitSize(file);
   const text=await file.text();const parsed=JigCore.parseFile(name,text);
   const mapping=JigCore.autoMap(parsed.records);
   app.files.push({name,parsed,mapping,selection:new Set(parsed.records.map((_,i)=>i)),error:null});
  }catch(error){app.files.push({name,error:error.message||String(error)});}
 }
 app.selected=Math.max(0,app.files.length-items.length);
 invalidate();
}
function reRenderBar(){
 const wrap=$('fileBar');wrap.replaceChildren();
 app.files.forEach((f,i)=>{
  const b=document.createElement('button');b.type='button';b.className='filechip'+(i===app.selected?' selected':'')+(f.error?' error':'');
  b.title=f.name+(f.error?' • '+f.error:'');b.textContent=(f.error?'⚠ ':'◉ ')+f.name+(f.error?' (error)':'');
  b.addEventListener('click',()=>{app.selected=i;app.onlyChanged=false;app.rowPage=0;window.JigStudioCards?.studio?.resetAssignment();render();});wrap.append(b);
 });
}
function buildMapping(){
 const container=$('mappingBody');container.replaceChildren();const f=fileEntry();
 if(!f||f.error){container.textContent=f?.error||'Load a file first.';return;}
 const paths=JigCore.fieldPaths(f.parsed.records),options=[['','— Do not modify —'],...paths.map(p=>[JSON.stringify(p),p.join(' › ')])];
 const byGroup=new Map();
 for(const s of JigCore.fieldSpecs){if(!byGroup.has(s.group))byGroup.set(s.group,[]);byGroup.get(s.group).push(s);}
 for(const [group,specs] of byGroup){
  const heading=document.createElement('div');heading.className='mapGroupHeading';heading.textContent=group;container.append(heading);
  for(const spec of specs){
   const wrap=document.createElement('div');wrap.className='mapList';
   const label=document.createElement('label');const id='map_'+spec.id.replace(/\./g,'_');label.htmlFor=id;label.textContent=mapLabel(spec);
   const select=document.createElement('select');select.id=id;
   for(const [v,t] of options){const opt=document.createElement('option');opt.value=v;opt.textContent=t;select.append(opt);}
   select.value=f.mapping[spec.id]||'';
   select.addEventListener('change',()=>{if(select.value)f.mapping[spec.id]=select.value;else delete f.mapping[spec.id];app.results.delete(f);processCurrent();});
   wrap.append(label,select);container.append(wrap);
  }
 }
}
function invalidate(){app.results.clear();ruleCount();render();}
function validOptions(){
 $('jigBilling').disabled=$('billingSame').checked;
 $('namesBilling').disabled=$('billingSame').checked;
 $('syncNames').disabled=!$('namesAccount').checked;syncCombine();
}
function process(f){
 if(!f || f.error || !f.parsed)return null;
 if(app.results.has(f))return app.results.get(f);
 const opts=options();
 let data,validation,roundtrip;
 try{
  data=JigCore.plan(f.parsed,f.mapping,opts,app.lookups);
  validation=JigCore.verifyUntouched(f.parsed,data,f.mapping,opts);
  if(!validation.ok)throw Error('Safety check: '+validation.issues.slice(0,3).join('; '));
  if(f.manualPaymentCards?.length){
   const selected=f.selection?[...f.selection].sort((a,b)=>a-b):[];
   if(JSON.stringify(selected)!==JSON.stringify(f.manualPaymentIndices))throw Error('Selected profiles changed after card distribution. Click Distribute evenly again before export.');
   const assigned=window.JigPaymentAllocation.fillRows(data.records,f.manualPaymentCards,f.manualPaymentIndices);
   data.records=assigned.records;
   for(const index of f.manualPaymentIndices){
    if(!data.notes[index])data.notes[index]=[];
    data.notes[index].push('Synthetic test card assigned (session only)');
    data.changedKeys[index].push(assigned.format==='shikari'?'cc_number':'card.number');
   }
   data.stats.paymentAssigned=assigned.assignedCount;
  }
  const output=JigCore.serialize(f.parsed,data.records);
  // Re-import the generated file before offering it for download.
  roundtrip=JigCore.parseFile(f.name,output);
  if(JSON.stringify(roundtrip.records)!==JSON.stringify(data.records))throw Error('Export verification failed: re-import does not match preview.');
  const result={...data,output,valid:true};app.results.set(f,result);return result;
 }catch(error){const fail={valid:false,error:error.message||String(error)};app.results.set(f,fail);return fail;}
}
function processCurrent(){
 validOptions();const f=fileEntry();const result=process(f);updateStats();renderPreview(f,result);
}
function updateStats(){
 const f=fileEntry(),r=process(f);
 $('statFiles').textContent=app.files.filter(f=>!f.error).length;
 $('statAccounts').textContent=f?.parsed?.records?.length||0;
 $('statEdited').textContent=r?.valid?r.stats.changed:0;
 $('statJigs').textContent=r?.valid?r.stats.jigged:0;
 $('exportCurrent').disabled=!r?.valid;
 $('exportAll').disabled=!app.files.some(f=>!f.error);
 $('onlyChanges').disabled=!r?.valid;
 $('onlyChanges').textContent='Show edits only: '+(app.onlyChanged?'On':'Off');
}
function readAddress(row,map,role){
 const r={};for(const p of JigCore.parts)r[p]=JigCore.get(row,map[role+'.'+p]);return r;
}
function formatAddress(v){
 if(!v || !v.address1)return '(not mapped)';
 const parts=[v.address1,v.address2,[v.city,v.state,v.zip].filter(x=>x!==undefined&&x!=='').join(' ')].filter(x=>x!=null && String(x).trim());
 return parts.join('\n');
}
function getPerson(row,map,role){const p=readAddress(row,map,role);if(p.full)return String(p.full);const name=[p.first,p.last].filter(Boolean).join(' ');return name;}
function previewRows(f,result){
 const table=document.createElement('table');table.className='review';
 table.innerHTML='<thead><tr><th style="width:6%">#</th><th style="width:30%">Before</th><th style="width:30%">After</th><th style="width:15%">Changed fields</th><th style="width:19%">Details</th></tr></thead>';
 const body=document.createElement('tbody');const ids=result.records.map((_,i)=>i).filter(i=>!app.onlyChanged||result.changedKeys[i].length);
 for(const i of ids.slice(0,45)){
  const old=f.parsed.records[i],nu=result.records[i],m=f.mapping;
  const oldShip=readAddress(old,m,'shipping'),newShip=readAddress(nu,m,'shipping');
  const oldBilling=readAddress(old,m,'billing'),newBilling=readAddress(nu,m,'billing');
  const showBilling=Boolean(m['billing.address1']||m['billing.city']||m['billing.zip']);
  const beforeName=getPerson(old,m,'account'),afterName=getPerson(nu,m,'account');
  const row=document.createElement('tr');
  const changed=result.changedKeys[i];const notes=result.notes[i];
  row.innerHTML=`<td class="index">${i+1}</td>
  <td><div class="smalllabel">Shipping</div><div class="addr old">${htmlEscape(formatAddress(oldShip))}</div>${showBilling?`<div class="smalllabel">Billing</div><div class="addr old">${htmlEscape(formatAddress(oldBilling))}</div>`:''}${beforeName?`<div class="nameline">Name: ${htmlEscape(beforeName)}</div>`:''}</td>
  <td><div class="smalllabel">Shipping</div><div class="addr new">${htmlEscape(formatAddress(newShip))}</div>${showBilling?`<div class="smalllabel">Billing</div><div class="addr new">${htmlEscape(formatAddress(newBilling))}</div>`:''}${afterName?`<div class="nameline">Name: ${htmlEscape(afterName)}</div>`:''}</td>
  <td>${changed.length?`<span class="changed">${changed.length} field${changed.length===1?'':'s'}</span><div class="meta" style="margin-top:7px;word-break:break-word">${htmlEscape(changed.join(', '))}</div>`:'<span class="unchanged">Original</span>'}</td>
  <td><div class="notes">${htmlEscape(notes.join(' • ')||'Not modified')}</div></td>`;
  body.append(row);
 }
 table.append(body);
 const outer=document.createElement('div');outer.className='reviewWrap';outer.append(table);
 const foot=document.createElement('div');foot.className='tiny';foot.style.marginTop='10px';
 foot.textContent=`Showing ${Math.min(ids.length,45)} of ${ids.length} ${app.onlyChanged?'changed':'total'} rows. All records are processed on export.`;
 return {outer,foot};
}
function notice(text,type=''){const div=document.createElement('div');div.className='notice '+type;div.textContent=text;return div;}
function renderPreview(f,r){
 const area=$('previewArea'),warnings=$('reviewWarnings');area.replaceChildren();warnings.replaceChildren();
 if(!f){area.className='empty';area.innerHTML='<strong>No files yet</strong><span>Drop an account file above to see a side-by-side preview.</span>';$('previewLead').textContent='Select an account file to inspect changes.';return;}
 if(f.error){area.className='empty';area.innerHTML='<strong>Could not open this file</strong><span>'+htmlEscape(f.error)+'</span>';$('previewLead').textContent=f.name;return;}
 if(!r?.valid){area.className='empty';area.innerHTML='<strong>Export blocked by safety check</strong><span>'+htmlEscape(r?.error||'Unknown processing error')+'</span>';$('previewLead').textContent=f.name;return;}
 area.className='';
 $('previewLead').textContent=`${f.name} • ${f.parsed.format} • ${r.stats.rows} record${r.stats.rows===1?'':'s'} • ${r.stats.changed} edited`;
 const rows=previewRows(f,r);area.append(rows.outer,rows.foot);
 if(r.stats.noUnique)warnings.append(notice(`${r.stats.noUnique} record(s) had no available unique variation from the checked options. These addresses were left unchanged.`, 'warning'));
 if(r.stats.unmapped)warnings.append(notice('No address fields were mapped for the requested jig mode. Open field mapping and select the correct columns.', 'warning'));
 if(options().useZip4 && r.stats.zip4Missing)warnings.append(notice(`ZIP+4 was not available for ${r.stats.zip4Missing} record(s). The saved street address can be looked up automatically through an authorized USPS Addresses API connection. Use ZIP+4 online, or import an address-matched ZIP+4 file; no digits were guessed.`, 'warning'));
 if(options().useCityAliases && r.stats.cityMissing)warnings.append(notice('No verified mailing-city reference has been loaded. Use the Florida city reference button, or import your own accepted-city data.', 'warning'));
 if(options().billingSame && !JigCore.parts.some(part=>f.mapping['shipping.'+part] && f.mapping['billing.'+part]))warnings.append(notice('“Billing same as shipping” is on, but corresponding shipping/billing fields were not mapped. Map both sides to copy them.', 'warning'));
 if(options().rules.some(id=>JigCore.RULES.find(r=>r.id===id)?.experimental))warnings.append(notice('Optional advanced transformations are selected. Review the generated addresses before exporting. These local edits do not change customer records on the website.', 'warning'));
 if(!r.stats.changed)warnings.append(notice('Nothing in this file would change with the current settings. For duplicate addresses, the first account remains unchanged; jigging starts with the next matching account.'));
 else warnings.append(notice('Safety check passed: only the selected, mapped field values differ. The export was successfully re-imported for verification.', 'good'));
}
function render(){reRenderBar();buildMapping();renderRowPicker();processCurrent();}
function namedExport(name){const ix=name.lastIndexOf('.');return ix<0?name+'-jigged':name.slice(0,ix)+'-jigged'+name.slice(ix);}
function downloadBlob(data,filename,mime){
 const blob=data instanceof Blob?data:new Blob([data],{type:mime||'application/octet-stream'});
 const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;
 document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
}
function mime(name){const ext=name.split('.').pop().toLowerCase();if(ext==='json'||ext==='jsonl'||ext==='ndjson')return 'application/json;charset=utf-8';if(ext==='csv')return 'text/csv;charset=utf-8';if(ext==='tsv'||ext==='tab')return 'text/tab-separated-values;charset=utf-8';return 'text/plain;charset=utf-8';}
function approveFractionExport(){
 return true;
}
function exportSelected(){const f=fileEntry(),r=process(f);if(!f||!r?.valid||!approveFractionExport())return;
 if(f.manualPaymentCards?.length&&!window.confirm('This download contains FULL SYNTHETIC TEST card values, including any entered test CVVs, in an UNENCRYPTED local file. Confirm these are fictional test values only. Export now?'))return;
 downloadBlob(r.output,namedExport(f.name),mime(f.name));$('exportStatus').textContent='Exported '+namedExport(f.name);
}
function crc32(bytes){
 let crc=-1;for(const byte of bytes){crc^=byte;for(let j=0;j<8;j++)crc=(crc>>>1)^(-(crc&1)&0xedb88320);}return (crc^-1)>>>0;
}
function zipFiles(entries){
 const enc=new TextEncoder(),parts=[],central=[];let offset=0;
 const date=new Date();const time=((date.getHours()&31)<<11)|((date.getMinutes()&63)<<5)|((Math.floor(date.getSeconds()/2))&31);
 const day=(((date.getFullYear()-1980)&127)<<9)|(((date.getMonth()+1)&15)<<5)|(date.getDate()&31);
 const put16=(v,n,o)=>v.setUint16(o,n,true),put32=(v,n,o)=>v.setUint32(o,n>>>0,true);
 for(const {name,content} of entries){
  const n=enc.encode(name),b=enc.encode(content),crc=crc32(b);
  const header=new Uint8Array(30+n.length),dv=new DataView(header.buffer);
  put32(dv,0x04034b50,0);put16(dv,20,4);put16(dv,0x0800,6);put16(dv,0,8);put16(dv,time,10);put16(dv,day,12);
  put32(dv,crc,14);put32(dv,b.length,18);put32(dv,b.length,22);put16(dv,n.length,26);put16(dv,0,28);header.set(n,30);
  parts.push(header,b);
  const c=new Uint8Array(46+n.length),d=new DataView(c.buffer);
  put32(d,0x02014b50,0);put16(d,20,4);put16(d,20,6);put16(d,0x0800,8);put16(d,0,10);put16(d,time,12);put16(d,day,14);
  put32(d,crc,16);put32(d,b.length,20);put32(d,b.length,24);put16(d,n.length,28);put16(d,0,30);put16(d,0,32);
  put16(d,0,34);put16(d,0,36);put32(d,0,38);put32(d,offset,42);c.set(n,46);
  central.push(c);offset+=header.length+b.length;
 }
 const centralLength=central.reduce((s,x)=>s+x.length,0);const end=new Uint8Array(22),d=new DataView(end.buffer);
 put32(d,0x06054b50,0);put16(d,0,4);put16(d,0,6);put16(d,entries.length,8);put16(d,entries.length,10);
 put32(d,centralLength,12);put32(d,offset,16);put16(d,0,20);
 return new Blob([...parts,...central,end],{type:'application/zip'});
}
function exportAll(){
 if(!approveFractionExport())return;
 if(app.files.some(f=>f.manualPaymentCards?.length)&&!window.confirm('This ZIP will include unencrypted synthetic test card values. Confirm there are no live payment-card numbers or CVVs in these manual test assignments. Export now?'))return;
 const entries=[],taken=new Set(),problems=[];
 for(const f of app.files){const r=process(f);if(!r?.valid){problems.push(f.name);continue;}
  let name=namedExport(f.name),ix=2;
  while(taken.has(name.toLowerCase())){const dot=name.lastIndexOf('.');const base=namedExport(f.name);const pos=base.lastIndexOf('.');name=pos<0?base+'-'+ix:base.slice(0,pos)+'-'+ix+base.slice(pos);ix++;}
  taken.add(name.toLowerCase());entries.push({name,content:r.output});
 }
 if(!entries.length){$('exportStatus').textContent='No valid files to export';return;}
 downloadBlob(zipFiles(entries),'SLABSNGRABSACO-jigged-files.zip','application/zip');
 $('exportStatus').textContent=`ZIP exported: ${entries.length} file(s)`+(problems.length?' • '+problems.length+' skipped':'');
}
function sampleTemplate(){
 const rows=[
 ['account_id','first_name','last_name','shipping_address1','shipping_address2','shipping_city','shipping_state','shipping_zip','billing_address1','billing_address2','billing_city','billing_state','billing_zip','password','tag'],
 ['demo-01','Sample','Person','100 Example Avenue','Suite X1','Sampletown','ZZ','00001','100 Example Avenue','Suite X1','Sampletown','ZZ','00001','UNCHANGED_VALUE','test'],
 ['demo-02','Sample','Person','100 Example Avenue','Suite X1','Sampletown','ZZ','00001','100 Example Avenue','Suite X1','Sampletown','ZZ','00001','UNCHANGED_VALUE','test'],
 ['demo-03','Sample','Person','100 Example Avenue','Suite X1','Sampletown','ZZ','00001','100 Example Avenue','Suite X1','Sampletown','ZZ','00001','UNCHANGED_VALUE','test'],
 ['demo-04','Sample','Person','100 Example Avenue','Suite X1','Sampletown','ZZ','00001','100 Example Avenue','Suite X1','Sampletown','ZZ','00001','UNCHANGED_VALUE','test']
 ];downloadBlob(JigCore.serialDelimited(rows,',','\r\n',true),'sample-accounts.csv','text/csv;charset=utf-8');
}
function clearAll(){app.files=[];app.lookups=[];app.results.clear();app.selected=0;app.onlyChanged=false;
 $('fileInput').value='';$('lookupInput').value='';$('lookupStatus').textContent='No lookup table loaded';$('clearLookup').disabled=true;$('exportStatus').textContent='Original format preserved';render();}
async function pickLocalFiles(){
 const status=$('localStatus');
 if(!window.desktopAPI?.chooseLocalFiles){status.textContent='Opening the local file picker. Select CSV, JSON or TXT files from your PC or synced folders.';$('fileInput').click();return;}
 try{
  status.textContent='Opening your Windows/Mac file picker...';
  const entries=await window.desktopAPI.chooseLocalFiles();
  if(!entries.length){status.textContent='No file selected; nothing was imported.';return;}
  const before=app.files.length;
  await ingestFiles(entries.map(({name,text})=>new File([text],name,{type:'text/plain'})));
  const added=app.files.slice(before),good=added.filter(x=>!x.error).length;
  status.textContent=good+' of '+entries.length+' file(s) imported on this device.'+(good!==entries.length?' Review unsupported or invalid files above.':' Contents stay in this app.');
 }catch(err){status.textContent='Could not import local file: '+err.message;}
}
function setup(){
 buildRuleGroups();render();
 $('chooseFiles').addEventListener('click',pickLocalFiles);$('fileInput').addEventListener('change',async event=>{await ingestFiles(event.target.files);event.target.value='';});
 const drop=$('dropzone');
 for(const ev of ['dragenter','dragover'])drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('drag');});
 for(const ev of ['dragleave','dragend'])drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('drag');});
 drop.addEventListener('drop',async e=>{e.preventDefault();drop.classList.remove('drag');await ingestFiles(e.dataTransfer.files);});
 $('chooseLookup').addEventListener('click',()=> $('lookupInput').click());
 $('lookupInput').addEventListener('change',async e=>{
  const f=e.target.files[0];if(!f)return;
  try{limitSize(f);app.lookups=JigCore.parseLookup(f.name,await f.text());$('lookupStatus').textContent=`Loaded ${app.lookups.length} lookup rows · ${f.name}`;$('clearLookup').disabled=false;invalidate();}
  catch(err){$('lookupStatus').textContent='Lookup error: '+err.message;}e.target.value='';
 });
 $('clearLookup').addEventListener('click',()=>{app.lookups=[];$('lookupStatus').textContent='No lookup table loaded';$('clearLookup').disabled=true;invalidate();});
 for(const id of optionIDs)$(id).addEventListener('change',invalidate);
 $('ruleSearch').addEventListener('input',()=>{
  const q=$('ruleSearch').value.trim().toLowerCase();
  for(const card of document.querySelectorAll('#ruleGroups>.ruleCategory')){
   let visible=0;
   for(const item of card.querySelectorAll('.rule, .referenceItem')){
    const matches=!q||item.textContent.toLowerCase().includes(q);
    item.hidden=!matches;if(matches)visible++;
   }
   card.hidden=visible===0;
   if(q){if(card.matches('details'))card.open=visible>0;for(const details of card.querySelectorAll('details'))details.open=true;}
  }
 });
 $('seed').addEventListener('input',invalidate);
 $('combineMode').addEventListener('change',()=>{syncCombine();invalidate();});
 for(const id of ['useZip4','useCityAliases'])$(id).addEventListener('change',()=>{const g=JIG_GROUP_UI.find(x=>x.external===id),box=document.querySelector('#ruleGroups input[data-group=\"'+g.id+'\"]');if(box)box.checked=$(id).checked;updateComboSelectors();});
 for(const id of ['comboRule1','comboRule2','comboRule3'])$(id).addEventListener('change',invalidate);
 $('recommendedRules').addEventListener('click',()=>setRules('recommended'));
 $('selectAllRules').addEventListener('click',()=>setRules('all'));
 $('clearRules').addEventListener('click',()=>setRules('clear'));
 $('regenSeed').addEventListener('click',()=>{$('seed').value=randomSeed();invalidate();});
 $('onlyChanges').addEventListener('click',()=>{app.onlyChanged=!app.onlyChanged;processCurrent();});
 $('exportCurrent').addEventListener('click',exportSelected);$('exportAll').addEventListener('click',exportAll);
 $('downloadTemplate').addEventListener('click',sampleTemplate);$('clearAll').addEventListener('click',clearAll);
}
setup();

function renderRowPicker(){
 const picker=$('rowPicker'),choices=$('rowChoices'),f=fileEntry();if(!picker||!choices)return;
 picker.hidden=!f||!!f.error;if(picker.hidden){choices.replaceChildren();return;}
 if(!f.selection)f.selection=new Set(f.parsed.records.map((_,i)=>i));
 $('rowSelectCount').textContent=f.selection.size+' / '+f.parsed.records.length+' selected';
 const q=($('rowSearch')?.value||'').toLowerCase().trim(),mode=$('rowFilter')?.value||'all';
 const found=[];
 for(let i=0;i<f.parsed.records.length;i++){
  if(mode==='selected'&&!f.selection.has(i)||mode==='unselected'&&f.selection.has(i))continue;
  const row=f.parsed.records[i];
  const name=JigCore.get(row,f.mapping['account.full'])||JigCore.get(row,f.mapping['shipping.full'])||'';
  const addr=JigCore.get(row,f.mapping['shipping.address1'])||'';
  const label=String(name||addr||('Profile '+(i+1)));
  if(q && !(label+' '+String(i+1)).toLowerCase().includes(q))continue;
  found.push({i,label});
 }
 const pageSize=60,totalPages=Math.max(1,Math.ceil(found.length/pageSize));
 app.rowPage=Math.max(0,Math.min(totalPages-1,app.rowPage||0));
 const offset=app.rowPage*pageSize;
 const scroll=choices.scrollTop;choices.replaceChildren();
 for(const {i,label} of found.slice(offset,offset+pageSize)){
  const cell=document.createElement('label');const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=f.selection.has(i);
  const name=document.createElement('span');name.textContent='#'+(i+1)+' · '+label.slice(0,76);
  checkbox.addEventListener('change',()=>{
   if(checkbox.checked)f.selection.add(i);else f.selection.delete(i);
   app.results.clear();$('rowSelectCount').textContent=f.selection.size+' / '+f.parsed.records.length+' selected';
   processCurrent();
   if(mode!=='all')renderRowPicker();
  });cell.append(checkbox,name);choices.append(cell);
 }
 choices.scrollTop=scroll;
 $('rowPageIndicator').textContent=found.length?`${offset+1}–${Math.min(found.length,offset+pageSize)} of ${found.length} accounts`:'No matching accounts';
 $('rowPrev').disabled=app.rowPage===0;$('rowNext').disabled=app.rowPage>=totalPages-1;
}
$('rowSearch').addEventListener('input',()=>{app.rowPage=0;renderRowPicker();});
$('rowFilter').addEventListener('change',()=>{app.rowPage=0;renderRowPicker();});
$('rowPrev').addEventListener('click',()=>{app.rowPage--;renderRowPicker();});
$('rowNext').addEventListener('click',()=>{app.rowPage++;renderRowPicker();});
const emailBank=(()=>{
 'use strict';
 const KEY='sng.sarl.emailgen.bank.v3.encrypted';
 const LEGACY='slabsngrabsaco.emailgen.bank.v2';
 const OWNER_DOMAIN='sng.sarl';
 const FORMAT='sg-emailbank-encrypted-v3';
 const ITERATIONS=220000;
 let records=[],unlocked=false,writable=true,lastCheck=null,bankKey=null,salt=null,writeQueue=Promise.resolve();
 const $e=id=>document.getElementById(id);
 const domain=v=>String(v||'').trim().toLowerCase().replace(/^@/,'');
 const validDomain=v=>/^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(v);
 const validLocal=v=>/^[a-z0-9][a-z0-9._-]{0,63}$/.test(v)&&!v.includes('..');
 const validEmail=v=>{const a=String(v||'').trim().toLowerCase().split('@');return a.length===2&&validLocal(a[0])&&validDomain(a[1]);};
 const api=()=>window.desktopAPI?.cloudflare;
 const alertMessage=(id,msg,good=false)=>{const el=$e(id);el.textContent=msg;el.style.color=good?'#9cf3d2':'#ffca91';};
 const currentDomain=()=>domain($e('emailDomain').value);
 const b64=bytes=>btoa(Array.from(bytes,x=>String.fromCharCode(x)).join(''));
 const unb64=value=>Uint8Array.from(atob(value),x=>x.charCodeAt(0));
 const rng=len=>crypto.getRandomValues(new Uint8Array(len));
 async function derive(password,saltBytes,iterations=ITERATIONS){
  const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt:saltBytes,iterations,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
 }
 async function decodeEncrypted(blob,password){
  if(blob?.format!==FORMAT || blob?.version!==3 || !blob.salt || !blob.iv || !blob.data || blob.iterations!==ITERATIONS)throw Error('Invalid encrypted backup format.');
  try{
   const bytes=unb64(blob.salt),k=await derive(password,bytes,blob.iterations);
   const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(blob.iv)},k,unb64(blob.data));
   const parsed=JSON.parse(new TextDecoder().decode(plain));
   if(!Array.isArray(parsed))throw Error('Not an Email Bank.');
   return {rows:parsed,key:k,salt:bytes};
  }catch(_){throw Error('Incorrect bank passphrase or damaged encrypted backup. Your existing bank was not changed.');}
 }
 function normalize(rows){
  return rows.filter(r=>r&&validEmail(r.alias)&&validEmail(r.target)&&String(r.alias).toLowerCase().endsWith('@'+OWNER_DOMAIN)).slice(0,10000).map((r,i)=>({
   id:typeof r.id==='string'?r.id:'bank-'+i,alias:String(r.alias).toLowerCase(),target:String(r.target).toLowerCase(),
   person:String(r.person||'').slice(0,80),created:!Number.isNaN(Date.parse(r.created))?r.created:new Date().toISOString(),
   status:['draft','pending','live','paused','conflict'].includes(r.status)?r.status:'draft',remoteId:typeof r.remoteId==='string'?r.remoteId:null,
   retailer:{target:['none','started','waiting','confirmed'].includes(r.retailer?.target)?r.retailer.target:'none',walmart:['none','started','waiting','confirmed'].includes(r.retailer?.walmart)?r.retailer.walmart:'none'},
   credentials:Object.fromEntries(['target','walmart'].map(brand=>[brand,Verification.normalizedCredential(r.credentials?.[brand])]))
  }));
 }
 async function encryptSnapshot(snapshot){
  const iv=rng(12);
  const data=await crypto.subtle.encrypt({name:'AES-GCM',iv},bankKey,new TextEncoder().encode(snapshot));
  return JSON.stringify({format:FORMAT,version:3,iterations:ITERATIONS,salt:b64(salt),iv:b64(iv),data:b64(new Uint8Array(data))});
 }
 function store(){
  if(!unlocked)throw Error('Owner must unlock Email Gen first.');
  const snapshot=JSON.stringify(records);render();
  writeQueue=writeQueue.catch(()=>{}).then(async()=>{
   const payload=await encryptSnapshot(snapshot);
   localStorage.setItem(KEY,payload);
   localStorage.removeItem(LEGACY);
   writable=true;render();return true;
  }).catch(err=>{
   writable=false;render();alertMessage('cfStatus','Encrypted save failed: '+err.message);return false;
  });
  return writeQueue;
 }
 async function unlockBank(passphrase){
  if(!crypto?.subtle || !crypto.getRandomValues)throw Error('This device does not provide secure browser encryption. Use the installed owner desktop edition.');
  if(passphrase.length<12)throw Error('Your private bank passphrase must have at least 12 characters.');
  let stored=null;try{stored=localStorage.getItem(KEY);}catch(_){throw Error('Local encrypted storage is unavailable.');}
  if(stored){
   const {rows,key,salt:sourceSalt}=await decodeEncrypted(JSON.parse(stored),passphrase);
   records=normalize(rows);bankKey=key;salt=sourceSalt;
  }else{
   salt=rng(16);bankKey=await derive(passphrase,salt);
   let old=[];
   try{const legacy=JSON.parse(localStorage.getItem(LEGACY)||'[]');old=Array.isArray(legacy)?legacy:[];}catch(_){/* ignore corrupt legacy */}
   records=normalize(old);
  }
  unlocked=true;writable=true;
  if(!stored){const ok=await store();if(!ok)throw Error('Encrypted bank could not be stored on this device.');}
  render();
 }
 async function logout(){
  await writeQueue;
  unlocked=false;records=[];bankKey=null;salt=null;lastCheck=null;
  wizardRecord=null;resetWizardSecret();$e('retailerWizard').hidden=true;
  $e('emailPrivate').hidden=true;$e('emailGate').hidden=false;
  $e('gatePassphrase').value='';$e('gateToken').value='';
  $e('emailDomain').value='';$e('emailDomainPreview').textContent='@your-domain';$e('emailTarget').value='';
  $e('bankSearch').value='';$e('bulkAliases').value='';
  render();await api()?.lock?.();
  alertMessage('gateStatus','Email Gen locked. Cloudflare authorization and the bank encryption key were cleared.',true);
 }
 function requireOwner(){if(!unlocked)throw Error('Verify Cloudflare ownership before using Email Gen.');}
 function suggestName(person,d=currentDomain()){
  const word=String(person||'').trim().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().split(/\s+/)[0]||'';
  const base=word.replace(/[^a-z0-9]/g,'').slice(0,12)||'staff';
  for(let n=1;n<10001;n++){
   const suffix=n===1?'':String(n),candidate=base.slice(0,Math.max(1,16-suffix.length))+suffix;
   if(!records.some(r=>r.alias===candidate+'@'+d))return candidate;
  }
  throw Error('Could not find a unique short email name.');
 }
 function makeAlias(person,local,target,d){
  requireOwner();local=String(local||'').trim().toLowerCase();target=String(target||'').trim().toLowerCase();d=domain(d);
  if(d!==OWNER_DOMAIN)throw Error('Email Gen is restricted to the owner-verified business domain.');
  if(!local)local=suggestName(person,d);
  if(records.length>=10000)throw Error('Email Bank has reached 10,000 entries.');
  if(!validLocal(local))throw Error('The short name must start with a letter or number and may include dots, underscores and hyphens.');
  if(!validEmail(target))throw Error('Enter your verified forwarding inbox.');
  const alias=local+'@'+d;
  if(target===alias || target.endsWith('@'+d))throw Error('Forward to an external inbox to prevent mail loops.');
  if(records.some(r=>r.alias===alias))throw Error(alias+' already exists in the Email Bank.');
  return {id:'email-'+Date.now()+'-'+Math.random().toString(36).slice(2,10),alias,person:String(person||'').slice(0,80),target,created:new Date().toISOString(),status:'draft',remoteId:null,retailer:{target:'none',walmart:'none'},credentials:{target:{password:'',updated:'',consentAt:''},walmart:{password:'',updated:'',consentAt:''}}};
 }
 async function add(person,local,target){const rec=makeAlias(person,local,target,currentDomain());records.push(rec);await store();return rec;}
 // Owner-assisted registration: no automated submissions to third-party sites.
 let wizardRecord=null,wizardBrand='target',secretHideTimer=null;
 function randomStrongPassword(){
  const groups=['ABCDEFGHJKLMNPQRSTUVWXYZ','abcdefghjkmnpqrstuvwxyz','23456789','!@#$_-'];
  const chars=groups.join('');
  const sample=max=>{const edge=Math.floor(256/max)*max;let n;do{n=crypto.getRandomValues(new Uint8Array(1))[0];}while(n>=edge);return n%max;};
  const result=groups.map(g=>g[sample(g.length)]);
  while(result.length<24)result.push(chars[sample(chars.length)]);
  for(let i=result.length-1;i>0;i--){const j=sample(i+1);[result[i],result[j]]=[result[j],result[i]];}
  return result.join('');
 }
 function wizardNotice(text,good=false){const area=$e('wizardMessage');area.textContent=text;area.className='notice'+(good?' good':'');}
 function resetWizardSecret(){clearTimeout(secretHideTimer);$e('wizardPassword').type='password';$e('wizardPassword').value='';$e('wizardPhone').value='';$e('wizardConsent').checked=false;}
 function showRetailerWizard(rec,brand){
  requireOwner();if(rec.status!=='live')throw Error('The email forwarding rule must be live before retailer registration.');
  wizardRecord=rec;wizardBrand=brand;
  const retailer=brand==='target'?'Target':'Walmart';
  $e('retailerWizard').hidden=false;$e('wizardTitle').textContent=retailer+' registration • '+(rec.retailer?.[brand]==='confirmed'?'Verified by owner':'Ready to prepare');
  $e('wizardAddress').textContent='Email forwarding is live • '+rec.alias+' → '+rec.target;
  $e('wizardAlias').value=rec.alias;$e('wizardBrand').value=brand;
  resetWizardSecret();$e('wizardPassword').value=rec.credentials?.[brand]?.password||'';
  const credential=activeCredential();
  $e('wizardPhone').value=credential.phone||'';
  $e('wizardEmailState').value=Verification.state(credential.emailState);
  $e('wizardSmsState').value=Verification.state(credential.smsState);
  wizardNotice("Confirm authorization, then complete the retailer's official email and phone verification steps. A saved phone number does not itself mean it is verified.");
  $e('retailerWizard').scrollIntoView({behavior:'smooth',block:'nearest'});
 }
 function activeCredential(){if(!wizardRecord || !unlocked)throw Error('Select an owner-authorized email and retailer first.');
  wizardRecord.credentials??={};
  wizardRecord.credentials[wizardBrand]=Verification.normalizedCredential(wizardRecord.credentials[wizardBrand]);
  return wizardRecord.credentials[wizardBrand];}
 function consentRequired(){if(!$e('wizardConsent').checked)throw Error('Confirm authorization from the account owner before preparing a registration.');}
 function initWizard(){
  const handle=async task=>{try{await task();}catch(err){wizardNotice(err.message||String(err));}};
  $e('wizardClose').addEventListener('click',()=>{resetWizardSecret();wizardRecord=null;$e('retailerWizard').hidden=true;});
  $e('wizardGenerate').addEventListener('click',()=>handle(async()=>{
   consentRequired();const cred=activeCredential();if(cred.password && !confirm('Replace the stored password? If it is already in use at the retailer, you will need to update it there too.'))return;
   cred.password=randomStrongPassword();cred.updated=new Date().toISOString();cred.consentAt=cred.consentAt||new Date().toISOString();
   const ok=await store();if(!ok)throw Error('Password was generated but secure storage failed. Do not close the app.');
   $e('wizardPassword').value=cred.password;wizardNotice('A unique 24-character password was encrypted in the private Email Bank. Use Open official signup to continue.',true);
  }));
  $e('wizardReveal').addEventListener('click',()=>handle(async()=>{
   const cred=activeCredential();if(!cred.password)throw Error('Generate a password first.');
   $e('wizardPassword').type='text';$e('wizardPassword').value=cred.password;
   clearTimeout(secretHideTimer);secretHideTimer=setTimeout(()=>$e('wizardPassword').type='password',12000);
  }));
  $e('wizardCopy').addEventListener('click',()=>handle(async()=>{
   const cred=activeCredential();if(!cred.password)throw Error('Generate a password first.');
   if(!window.desktopAPI?.copyPassword)throw Error('Copy requires the private desktop app.');
   await window.desktopAPI.copyPassword(cred.password);wizardNotice('Password copied temporarily. The app clears it from the clipboard after 30 seconds if unchanged.',true);
  }));
  $e('wizardOpenInbox').addEventListener('click',()=>handle(async()=>{
   consentRequired();activeCredential();
   if(!window.desktopAPI?.openInbox)throw Error('Open your installed private owner desktop app.');
   await window.desktopAPI.openInbox(wizardBrand,wizardRecord.alias,wizardRecord.target);
   wizardNotice('Gmail search opened for this alias. Check that each message genuinely comes from the retailer. Complete any verification link or code on the official site.',true);
  }));
  $e('wizardSavePhone').addEventListener('click',()=>handle(async()=>{
   consentRequired();const cred=activeCredential();
   const mobile=Verification.phone($e('wizardPhone').value);
   if(!mobile)throw Error('Enter an authorized phone number before saving.');
   cred.phone=mobile;cred.updated=new Date().toISOString();
   const ok=await store();if(!ok)throw Error('Could not encrypt and save the number.');
   $e('wizardPhone').value=mobile;
   wizardNotice('The phone number was stored only in the encrypted owner bank. Enter it into the official retailer signup when requested; no SMS was sent by Jig Studio.',true);
  }));
  for(const [id,field,label] of [['wizardEmailState','emailState','email'],['wizardSmsState','smsState','SMS']]){
   $e(id).addEventListener('change',()=>handle(async()=>{
    consentRequired();const cred=activeCredential(),previous=Verification.state(cred[field]);
    const next=Verification.state($e(id).value);
    if(next==='owner-confirmed'&&!confirm('Did the retailer explicitly accept the '+label+' verification on its official website? This app cannot confirm that for you.')){$e(id).value=previous;return;}
    if(next==='not-required'&&!confirm('Did the retailer NOT require '+label+' verification for this account?')){$e(id).value=previous;return;}
    if(field==='smsState'&&next!=='not-started'&&next!=='not-required'&&!cred.phone){$e(id).value=previous;throw Error('Save the authorized phone number before tracking an SMS challenge.');}
    cred[field]=next;cred.updated=new Date().toISOString();
    const ok=await store();if(!ok)throw Error('Encrypted save failed.');
    wizardNotice(label+' status saved as '+(next==='owner-confirmed'?'accepted (owner-reported)':next.replaceAll('-',' '))+'. This is not independent retailer approval.',true);
   }));
  }
  $e('wizardLaunch').addEventListener('click',()=>handle(async()=>{
   consentRequired();const cred=activeCredential();if(!cred.password)throw Error('Generate and securely save a password before opening registration.');
   if(wizardRecord.status!=='live')throw Error('Forwarding alias is not live.');
   if(!window.desktopAPI?.openRetailer)throw Error('Open the installed owner desktop app.');
   await window.desktopAPI.openRetailer(wizardBrand,wizardRecord.alias);
   wizardRecord.retailer[wizardBrand]='started';cred.consentAt=cred.consentAt||new Date().toISOString();cred.updated=new Date().toISOString();await store();
   wizardNotice("Official signup opened and email copied. Complete the retailer's signup, code, CAPTCHA or other verification in that browser window; Jig Studio does not bypass them.",true);
  }));
  $e('wizardPending').addEventListener('click',()=>handle(async()=>{
   consentRequired();activeCredential();wizardRecord.retailer[wizardBrand]='waiting';await store();
   wizardNotice('Marked verification pending. This is not a confirmed or approved retailer account.',true);
  }));
  $e('wizardComplete').addEventListener('click',()=>handle(async()=>{
   consentRequired();const credential=activeCredential();
   if(!Verification.canRecordComplete(credential))throw Error('Record both verification methods as accepted on the retailer site, or Not required if the retailer did not request them, before marking registration complete.');
   if(!confirm('Did the retailer confirm the completed registration and any required email/SMS verification? This is a manual owner report, NOT retailer API approval.'))return;
   wizardRecord.retailer[wizardBrand]='confirmed';await store();
   wizardNotice('Recorded as verified by the owner. This status is not independently checked with the retailer.',true);
   $e('wizardTitle').textContent=(wizardBrand==='target'?'Target':'Walmart')+' registration • Verified by owner';
  }));
 }
 initWizard();
 function render(){
  const items=unlocked?records:[];
  $e('bankTotal').textContent=items.length;$e('bankLive').textContent=items.filter(r=>r.status==='live').length;
  $e('bankPending').textContent=items.filter(r=>r.status!=='live').length;
  $e('bankUnique').textContent=new Set(items.map(r=>r.target)).size;
  $e('bankStorageWarning').hidden=writable;
  $e('bankStorageWarning').textContent=writable?'':'Unable to save the encrypted bank. Keep the app open and check device storage.';
  const q=$e('bankSearch').value.trim().toLowerCase(),status=$e('bankFilter').value;
  const shown=items.filter(r=>(status==='all'||r.status===status)&&(r.alias+' '+r.target+' '+r.person).toLowerCase().includes(q));
  const body=$e('bankRows');body.replaceChildren();$e('bankEmpty').hidden=shown.length>0;
  for(const rec of shown){
   const tr=document.createElement('tr'),name=document.createElement('td');name.textContent=rec.alias;
   if(rec.person){const p=document.createElement('span');p.className='tiny';p.textContent=rec.person;name.append(p);}
   const dest=document.createElement('td');dest.textContent=rec.target;
   const statusTd=document.createElement('td'),pill=document.createElement('span');pill.className='statusChip '+rec.status;
   pill.textContent={live:'Live (Cloudflare)',pending:'Verify destination',conflict:'Conflict',paused:'Paused in Cloudflare',draft:'Draft'}[rec.status]||'Unknown';statusTd.append(pill);
   const date=document.createElement('td');date.textContent=rec.created?new Date(rec.created).toLocaleDateString():'';
   const retailerTd=document.createElement('td');
   if(!rec.retailer)rec.retailer={target:'none',walmart:'none'};
   for(const brand of ['target','walmart']){
    const line=document.createElement('div');line.className='retailerAction';
    const brandText=brand==='target'?'Target':'Walmart',current=rec.retailer[brand];
    const tag=document.createElement('span');tag.className='tiny'+(current==='confirmed'?' done':'');
    tag.textContent=brandText+': '+({none:'Not started',started:'Signup in progress',waiting:'Awaiting verification',confirmed:'Verified (owner-reported)'}[current]||'Not started');
    const open=document.createElement('button');open.type='button';open.className='btn slim secondary';open.textContent=current==='none'?'Prepare signup':'Manage signup';
    open.disabled=rec.status!=='live';open.title=rec.status!=='live'?'Activate this sng.sarl forwarding address first.':'Open the authorized registration workspace.';
    open.addEventListener('click',()=>showRetailerWizard(rec,brand));
    line.append(tag,open);
    const cred=Verification.normalizedCredential(rec.credentials?.[brand]);
    if(cred.emailState!=='not-started'||cred.smsState!=='not-started'){
     const progress=document.createElement('span');progress.className='tiny';
     const stage=v=>({waiting:'Waiting', 'owner-confirmed':'Accepted (owner-reported)','not-required':'Not requested','not-started':'Not started'}[v]);
     progress.textContent='Email: '+stage(cred.emailState)+' · SMS: '+stage(cred.smsState);
     line.append(progress);
    }
    retailerTd.append(line);
   }
   const actions=document.createElement('td');
   const copy=document.createElement('button');copy.className='btn slim plain';copy.textContent='Copy';copy.addEventListener('click',()=>navigator.clipboard?.writeText(rec.alias).catch(()=>{}));actions.append(copy);
   const edit=document.createElement('button');edit.className='btn slim secondary';edit.textContent='Edit destination';edit.disabled=['live','paused'].includes(rec.status);
   edit.addEventListener('click',async()=>{
    const next=prompt('Forward '+rec.alias+' to which real inbox?',rec.target);if(next===null)return;
    const v=next.trim().toLowerCase();if(!validEmail(v)||v.endsWith('@'+OWNER_DOMAIN)){alert('Provide an external valid email inbox.');return;}
    rec.target=v;rec.status='draft';rec.remoteId=null;await store();
   });actions.append(edit);
   const remove=document.createElement('button');remove.className='btn slim danger';remove.textContent='Remove';remove.addEventListener('click',async()=>{
    if(!confirm(rec.status==='live'?'Remove the local entry? The Cloudflare routing rule stays active until you disable it there.':'Remove this local draft?'))return;
    records=records.filter(r=>r.id!==rec.id);await store();
   });actions.append(remove);
   tr.append(name,dest,statusTd,date,retailerTd,actions);body.append(tr);
  }
 }
 async function exportCsv(){
  requireOwner();if(!confirm('This CSV is NOT encrypted and contains coworker email addresses and forwarding destinations. Export it to a private location?'))return;
  const rows=[['coworker','alias','forward_to','status','created','cloudflare_rule_id','target_signup','walmart_signup'],...records.map(r=>[r.person,r.alias,r.target,r.status,r.created,r.remoteId||'',r.retailer?.target||'none',r.retailer?.walmart||'none'])];
  downloadBlob(JigCore.serialDelimited(rows,',','\r\n',true),'email-bank.csv','text/csv');
 }
 async function exportEncrypted(){
  requireOwner();await writeQueue;
  const blob=localStorage.getItem(KEY);
  if(!blob)throw Error('Encrypted data unavailable.');
  downloadBlob(blob,'email-bank-encrypted-backup.json','application/json');
 }
 async function importBank(file){
  requireOwner();if(!file || file.size>6*1024*1024)throw Error('Choose an Email Bank backup under 6 MB.');
  const obj=JSON.parse(await file.text());let rows;
  if(obj?.format===FORMAT){
   const pass=prompt('Enter the private passphrase used for this encrypted backup.');
   if(pass===null)return 0;
   rows=(await decodeEncrypted(obj,pass)).rows;
  }else{
   if(!confirm('This is an old UNENCRYPTED bank backup. Import and encrypt its entries on this device?'))return 0;
   rows=Array.isArray(obj)?obj:obj.records;
  }
  if(!Array.isArray(rows))throw Error('Invalid Email Bank backup.');
  let added=0;
  for(const entry of normalize(rows)){
   if(records.some(r=>r.alias===entry.alias))continue;
   records.push({...entry,id:'import-'+Date.now()+'-'+added,status:'draft',remoteId:null});added++;
  }
  await store();return added;
 }
 async function syncStatus(){
  requireOwner();
  lastCheck=await api().check();
  for(const rec of records){
   const matches=lastCheck.rules.filter(r=>r.alias===rec.alias);
   const active=matches.find(r=>r.enabled&&r.kind==='forward'&&r.target===rec.target);
   const paused=matches.find(r=>!r.enabled&&r.kind==='forward'&&r.target===rec.target);
   if(active){rec.status='live';rec.remoteId=active.id;}
   else if(paused&&matches.length===1){rec.status='paused';rec.remoteId=paused.id;}
   else if(matches.length){rec.status='conflict';rec.remoteId=null;}
   else if(lastCheck.destinations.some(r=>r.email===rec.target&&!r.verified)){rec.status='pending';rec.remoteId=null;}
   else {rec.status='draft';rec.remoteId=null;}
  }
  await store();return lastCheck;
 }
 async function authorizeOwner(){
  if(!api()?.authorize)throw Error('Owner unlock requires the installed desktop edition and an online Cloudflare check.');
  const accountId=$e('gateAccount').value.trim(),zoneId=$e('gateZone').value.trim(),token=$e('gateToken').value.trim();
  const passphrase=$e('gatePassphrase').value;
  if(!/^[a-f0-9]{32}$/i.test(accountId)||!/^[a-f0-9]{32}$/i.test(zoneId))throw Error('Account and Zone IDs must contain 32 hexadecimal characters.');
  if(token.length<12)throw Error('Enter a valid scoped Cloudflare API token.');
  if(passphrase.length<12)throw Error('Use an Email Bank passphrase of at least 12 characters.');
  const verified=await api().authorize({domain:OWNER_DOMAIN,accountId,zoneId,token});
  try{await unlockBank(passphrase);}catch(err){await api().lock().catch(()=>{});throw err;}
  if(!verified?.authorized||verified.domain!==OWNER_DOMAIN)throw Error('Cloudflare owner verification failed.');
  $e('gatePassphrase').value='';$e('gateToken').value='';
  $e('emailDomain').value=OWNER_DOMAIN;$e('emailDomainPreview').textContent='@'+OWNER_DOMAIN;
  $e('emailTarget').value=records.find(r=>r.target)?.target||'';
  $e('emailGate').hidden=true;$e('emailPrivate').hidden=false;
  alertMessage('cfStatus','Owner verified. Your Email Bank is decrypted only in this session. DNS and forwarding rules have not been changed.',true);
  render();
 }
 function addEvents(){
  $e('ownerUnlock').addEventListener('submit',async e=>{
   e.preventDefault();$e('unlockEmail').disabled=true;
   alertMessage('gateStatus','Checking Cloudflare zone ownership and unlocking your encrypted Email Bank...');
   try{await authorizeOwner();}catch(err){alertMessage('gateStatus',err.message);}
   finally{$e('unlockEmail').disabled=false;}
  });
  $e('lockEmail').addEventListener('click',()=>logout().catch(e=>alertMessage('gateStatus',e.message)));
  $e('suggestAlias').addEventListener('click',()=>{$e('emailLocal').value=suggestName($e('emailPerson').value);$e('emailLocal').focus();});
  $e('aliasForm').addEventListener('submit',async e=>{
   e.preventDefault();try{
    const rec=await add($e('emailPerson').value,$e('emailLocal').value,$e('emailTarget').value);
    $e('emailTarget').value=rec.target;$e('emailLocal').value='';$e('emailPerson').value='';
    alertMessage('emailFormMessage',(writable?'Saved encrypted draft: ':'Created in memory only: ')+rec.alias+'. Not active yet.',writable);
   }catch(err){alertMessage('emailFormMessage',err.message);}
  });
  $e('bulkCreate').addEventListener('click',async()=>{
   if(!unlocked)return;
   const lines=$e('bulkAliases').value.split(/\r?\n/).filter(x=>x.trim());let added=0;const errors=[];
   for(const [i,line] of lines.entries()){
    try{
     const parts=JigCore.parseDelimited(line,',')[0];if(!parts||![1,2,3].includes(parts.length))throw Error('Expected name,alias or name,alias,destination');
     const defaultInbox=$e('emailTarget').value.trim();
     const [person,local,target]=parts.length===1?[parts[0],'',defaultInbox]:parts.length===2?[parts[0],parts[1],defaultInbox]:parts;
     records.push(makeAlias(person,local,target,currentDomain()));added++;
    }catch(err){errors.push('Line '+(i+1)+': '+err.message);}
   }
   if(added)await store();
   alertMessage('bulkMessage',added+' encrypted draft(s) added.'+(errors.length?' '+errors.slice(0,3).join(' / '):''),!errors.length);
  });
  $e('bankSearch').addEventListener('input',render);$e('bankFilter').addEventListener('change',render);
  $e('bankExportCsv').addEventListener('click',()=>exportCsv().catch(e=>alertMessage('cfStatus',e.message)));
  $e('bankExportJson').addEventListener('click',()=>exportEncrypted().catch(e=>alertMessage('cfStatus',e.message)));
  $e('bankImport').addEventListener('click',()=>$e('bankFile').click());
  $e('bankFile').addEventListener('change',async e=>{
   try{const n=await importBank(e.target.files[0]);alertMessage('bulkMessage',n+' entries restored into the encrypted bank. Sync to verify live status.',true);}
   catch(err){alertMessage('bulkMessage',err.message);}e.target.value='';
  });
  $e('cfConnect').addEventListener('click',async()=>{
   if(!unlocked)return;
   try{
    alertMessage('cfStatus','Checking the current Cloudflare routing configuration...');
    const state=await syncStatus();alertMessage('cfStatus',state.domain+' routing is ready; '+state.destinations.length+' verified/pending destinations and '+state.rules.length+' existing rules. Synced local statuses.',true);
   }catch(err){lastCheck=null;alertMessage('cfStatus','Read-only Cloudflare check failed: '+err.message);}
  });
  $e('cfMx').addEventListener('click',async()=>{
   if(!unlocked)return;
   try{const data=await api().mx();alertMessage('cfStatus','Read-only DNS check: '+(data.mx.join(' | ')||'No MX returned')+'. '+data.warning);}
   catch(err){alertMessage('cfStatus','MX check failed: '+err.message);}
  });
  $e('cfImportLive').addEventListener('click',async()=>{
   if(!unlocked)return;
   try{
    const snap=lastCheck||await api().check();lastCheck=snap;
    const found=snap.rules.filter(r=>r.name.startsWith('Jig Studio: ')&&r.kind==='forward'&&r.alias.endsWith('@'+OWNER_DOMAIN)&&validEmail(r.target)&&!records.some(x=>x.alias===r.alias));
    if(!found.length){alertMessage('cfStatus','No missing Jig Studio forwarding rules found on your authorized Cloudflare zone.',true);return;}
    if(!confirm('Import '+found.length+' of your existing Jig Studio Cloudflare rules into this device\'s encrypted Email Bank?'))return;
    for(const r of found)records.push({id:'cloud-'+r.id,person:'',alias:r.alias,target:r.target,created:new Date().toISOString(),status:r.enabled?'live':'paused',remoteId:r.id,retailer:{target:'none',walmart:'none'},credentials:{target:{password:'',updated:'',consentAt:''},walmart:{password:'',updated:'',consentAt:''}}});
    await store();if(!$e('emailTarget').value)$e('emailTarget').value=found[0].target;alertMessage('cfStatus',found.length+' Cloudflare rules were added to this device\'s encrypted Email Bank.',true);
   }catch(err){alertMessage('cfStatus','Could not import Cloudflare rules: '+err.message);}
  });
  $e('cfPublish').addEventListener('click',async()=>{
   if(!unlocked)return;
   try{
    const pending=records.filter(r=>!['live','paused','conflict'].includes(r.status));
    if(!pending.length)throw Error('No unpublished or pending drafts.');
    if(!confirm('Publish '+pending.length+' aliases to your authorized Cloudflare zone? Existing MX/DNS records will not be changed.'))return;
    alertMessage('cfStatus','Publishing up to 100 aliases per batch...');
    let live=0,pendingCount=0,conflict=0;
    for(let start=0;start<pending.length;start+=100){
     const res=await api().publish(pending.slice(start,start+100).map(({alias,target})=>({alias,target})));
     for(const item of res.items){
      const rec=records.find(r=>r.alias===item.alias);if(!rec)continue;
      rec.status=item.status;rec.remoteId=item.remoteId||null;
      if(item.status==='live')live++;else if(item.status==='pending')pendingCount++;else if(item.status==='conflict')conflict++;
     }
     await store();
    }
    alertMessage('cfStatus','Publishing complete: '+live+' live, '+pendingCount+' awaiting destination verification, '+conflict+' conflicts. Cloudflare DNS was unchanged.',!conflict);
   }catch(err){alertMessage('cfStatus','Unable to publish: '+err.message);}
  });
 }
 addEvents();render();
 return {list:()=>unlocked?records.map(r=>({...r})):[],isUnlocked:()=>unlocked,unlock:authorizeOwner,logout,store};
})();

// Make the runtime capabilities visible instead of implying all online buttons are connected accounts.
const runtimeNotice=document.getElementById('runtimeNotice');
if(runtimeNotice){
 const desktop=!!window.desktopAPI?.chooseLocalFiles;
 runtimeNotice.textContent=desktop?'Desktop connection ready: local file picker, authorized online link imports and provider shortcuts are available.':'Browser preview only: local file import works; owner Email Gen requires the desktop app and Cloudflare authorization.';
}
if(!window.desktopAPI?.cloudflare?.authorize){
 const ownerNotice=document.getElementById('gateStatus');
 if(ownerNotice)ownerNotice.textContent='Cloudflare authorization is unavailable in a browser preview. Run the extracted app with start-windows.bat (Windows) or start-mac.command (Mac).';
}
// Navigation keeps file imports and bank data loaded when switching tabs.
for(const t of document.querySelectorAll('.tabButton')){
 t.addEventListener('click',()=>{
  const mode=t.dataset.tab;for(const b of document.querySelectorAll('.tabButton'))b.classList.toggle('on',b===t);
  $('jigPage').hidden=mode!=='jig';$('emailPage').hidden=mode!=='email';$('sitePage').hidden=mode!=='site';
 });
}
// Optional public HTTPS file import. No background discovery, account scanning,
// cloud synchronization or upload of imported account data.
const onlineHosts=['raw.githubusercontent.com','gist.githubusercontent.com','github.com','storage.googleapis.com','drive.google.com','docs.google.com','dl.dropboxusercontent.com','1drv.ms'];
function onlineAllowed(url){
 try{
  const u=new URL(url);
  const suffix=['.googleusercontent.com','.dropbox.com','.dropboxusercontent.com','.onedrive.live.com','.sharepoint.com','.box.com','.boxcloud.com'];
  return u.protocol==='https:' && !u.username && !u.password && !u.port &&
   (onlineHosts.includes(u.hostname.toLowerCase())||suffix.some(x=>u.hostname.toLowerCase().endsWith(x)));
 }catch(_){return false;}
}
$('importRemote').addEventListener('click',async()=>{
 const url=$('remoteUrl').value.trim(),filename=$('remoteName').value.trim();
 if(!onlineAllowed(url)){$('remoteStatus').textContent='Only direct HTTPS file links from the listed providers are supported. No file was requested.';return;}
 $('importRemote').disabled=true;$('remoteStatus').textContent='Downloading the selected file only; no central upload or file discovery...';
 try{
  let item;
  if(window.desktopAPI?.onlineFile){item=await window.desktopAPI.onlineFile(url,filename);}
  else{
   if(!/\.(csv|tsv|tab|psv|json|jsonl|ndjson|txt)$/i.test(filename))throw Error('In browser mode, enter a valid filename ending in CSV, TXT or JSON.');
   const r=await fetch(url,{credentials:'omit',referrerPolicy:'no-referrer'});
   if(!r.ok)throw Error('Public file unavailable (HTTP '+r.status+').');
   if(/html|javascript|xml/i.test(r.headers.get('content-type')||''))throw Error('The link returned a webpage rather than a file.');
   if(Number(r.headers.get('content-length'))>26*1024*1024)throw Error('File is too large.');
   const reader=r.body.getReader(),parts=[];let length=0;
   for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>26*1024*1024)throw Error('File is over 26 MB.');parts.push(value);}
   const out=new Uint8Array(length);let offset=0;for(const part of parts){out.set(part,offset);offset+=part.length;}
   item={name:filename,text:new TextDecoder('utf-8',{fatal:true}).decode(out)};
  }
  await ingestFiles([new File([item.text],item.name,{type:'text/plain'})]);
  const last=app.files[app.files.length-1];
  if(last?.error)throw Error(last.error);
  $('remoteUrl').value='';$('remoteStatus').textContent='Imported '+item.name+' from the link you supplied. Data is held locally in memory only.';
 }catch(err){$('remoteStatus').textContent='Online import failed: '+err.message+' For a private cloud file, sign in to your own provider, download it, then use Choose files.';}
 finally{$('importRemote').disabled=false;}
});
$('importDownloaded').addEventListener('click',pickLocalFiles);
for(const b of document.querySelectorAll('[data-provider]')){
 b.addEventListener('click',async()=>{
  const provider=b.dataset.provider;
  const titles={drive:'Google Drive',dropbox:'Dropbox',onedrive:'OneDrive',cloudflare:'Cloudflare'};
  const urls={drive:'https://drive.google.com/drive/u/0/my-drive',dropbox:'https://www.dropbox.com/home',onedrive:'https://onedrive.live.com/',cloudflare:'https://dash.cloudflare.com/'};
  $('remoteStatus').textContent='Opening '+titles[provider]+' in your browser. Choose and download a file there, then use “Import downloaded or synced file” here. Private cloud browsing requires provider authorization and is not built into this app.';
  try{
   if(window.desktopAPI?.openProvider)await window.desktopAPI.openProvider(provider);
   else {
    window.open(urls[provider],'_blank','noopener,noreferrer');
    // Browsers may return null even on success with the noopener flag.
   }
  }catch(err){$('remoteStatus').textContent='Could not open '+titles[provider]+': '+err.message+' You can open '+urls[provider]+' manually.';}
 });
}

async function fetchOnlineZipCities(){
 const f=fileEntry();if(!f||f.error){alert('Import a file first.');return;}
 const selected=f.selection||new Set(f.parsed.records.map((_,i)=>i));const seen=new Set(),rows=[];
 for(const i of selected){const r=f.parsed.records[i],zip=JigCore.zip5(JigCore.get(r,f.mapping['shipping.zip']));if(zip)seen.add(zip);}
 if(!seen.size){alert('Map the shipping ZIP field first.');return;}
 if(seen.size>80){alert('Select up to 80 distinct ZIPs per lookup.');return;}
 if(!confirm('Look up '+seen.size+' ZIP(s) online using Zippopotam.us? ZIP codes will be transmitted; street addresses will NOT be sent. City suggestions are not USPS address verification.'))return;
 $('lookupStatus').textContent='Retrieving online ZIP city suggestions...';let ok=0;
 for(const zip of seen){try{
  const json=window.desktopAPI?.lookupZip?await window.desktopAPI.lookupZip(zip):await (async()=>{const r=await fetch('https://api.zippopotam.us/us/'+zip);if(!r.ok)throw Error('ZIP not found');return r.json();})();
  const places=(json.places||[]).filter(p=>p['place name']&&p['state abbreviation']);
  // Only valid same-state cities; no fabricated USPS deliverability promise.
  for(const place of places){rows.push({zip,city:place['place name'],state:place['state abbreviation'],alternatecity:places.filter(x=>x['state abbreviation']===place['state abbreviation']).map(x=>x['place name']).join('|')});}
  ok++;
 }catch(e){/* unreliable external API results are intentionally ignored */}}
 app.lookups.push(...JigCore.parseLookup('online.csv',JigCore.serialDelimited([['zip','city','state','alternatecity'],...rows.map(r=>[r.zip,r.city,r.state,r.alternatecity])])));
 $('lookupStatus').textContent='Online: '+ok+'/'+seen.size+' ZIPs found; '+rows.length+' locality suggestions (not address-verified).';$('clearLookup').disabled=false;invalidate();
}
async function fetchUspsZip4(){
 const f=fileEntry();if(!f||f.error){alert('Import and map account addresses first.');return;}
 if(!window.desktopAPI?.uspsLookup){alert('ZIP+4 lookup requires the installed desktop app.');return;}
 const id=$('uspsId').value.trim(),secret=$('uspsSecret').value.trim();
 const smartyId=$('smartyId').value.trim(),smartyToken=$('smartyToken').value.trim();
 const choices=[];const visited=new Set();for(const i of f.selection||[]){
  const r=f.parsed.records[i],m=f.mapping;
  const obj={address1:JigCore.get(r,m['shipping.address1']),address2:JigCore.get(r,m['shipping.address2']),city:JigCore.get(r,m['shipping.city']),state:JigCore.get(r,m['shipping.state']),zip:JigCore.get(r,m['shipping.zip'])};
  if(!obj.address1||!obj.state||!obj.zip)continue;
  const key=JSON.stringify(obj);if(!visited.has(key)){visited.add(key);choices.push(obj);}
 }
 if(!choices.length){alert('Map street, state, ZIP and select accounts first.');return;}
 if(choices.length>50){alert('Select at most 50 distinct addresses for ZIP+4 lookup.');return;}
 if((smartyId && !smartyToken)||(!smartyId && smartyToken)){
  alert('Enter both Smarty Auth ID and Auth Token, or clear both to use USPS.');return;
 }
 if(smartyId&&smartyToken){
  if(!window.desktopAPI?.smartyLookup){alert('Update Jig Studio to a version that supports Smarty.');return;}
  if(!confirm('Send '+choices.length+' selected saved street/unit address(es) to Smarty US Street Address API for ZIP+4 verification? Lookup quota may apply.'))return;
  $('lookupStatus').textContent='Verifying '+choices.length+' saved address(es) through Smarty...';
  try{
   const data=await window.desktopAPI.smartyLookup({authId:smartyId,authToken:smartyToken,addresses:choices});
   const rows=data.results.filter(r=>r.ok).map(x=>({address1:x.input.address1,address2:x.input.address2,city:x.input.city,state:x.input.state,zip:x.input.zip,zip4:x.zip4,source:'smarty-address-verified'}));
   if(rows.length){
    app.lookups.push(...JigCore.parseLookup('smarty-verified.json',JSON.stringify(rows)));
    $('clearLookup').disabled=false;
    $('useZip4').checked=true;
    const grp=document.querySelector('#ruleGroups input[data-group="zip"]');if(grp)grp.checked=true;
    updateComboSelectors();
   }
   $('lookupStatus').textContent='Smarty verified '+rows.length+' of '+choices.length+' saved address(es); '+(choices.length-rows.length)+' need review. Only full delivery-point matches are used; no ZIP+4 guessed.';
   invalidate();
  }catch(e){$('lookupStatus').textContent='Smarty verification unavailable: '+e.message;}
  return;
 }
 if(!id||!secret){
  if(id||secret){alert('Enter both USPS Client ID and Secret for automatic API lookup, or clear both to use the public lookup website.');return;}
  if(!window.JigUSPSPublicAssistant){alert('The built-in USPS lookup assistant is unavailable in this build.');return;}
  try{
   const result=await window.JigUSPSPublicAssistant.start({addresses:choices,desktopAPI:window.desktopAPI});
   const verified=result.rows;
   if(verified.length){
    app.lookups.push(...JigCore.parseLookup('usps-public-owner-entered.json',JSON.stringify(verified)));
    $('clearLookup').disabled=false;
    $('useZip4').checked=true;
    const grp=document.querySelector('#ruleGroups input[data-group="zip"]');if(grp)grp.checked=true;
    updateComboSelectors();
   }
   $('lookupStatus').textContent='USPS By Address: '+verified.length+' manually confirmed ZIP+4 values for '+result.total+' selected address(es). No webpage scraping or guessing. '+(result.skipped?'Skipped '+result.skipped+'.':'');
   invalidate();
  }catch(error){$('lookupStatus').textContent='USPS lookup assistant: '+error.message;}
  return;
 }

 if(!confirm('Send '+choices.length+' selected street address(es) to the official USPS Addresses API? This requires your USPS developer account and may be rate limited.'))return;
 $('lookupStatus').textContent='Checking USPS...';try{
  const data=await window.desktopAPI.uspsLookup({id,secret,addresses:choices});
  const rows=data.results.filter(r=>r.ok).map(x=>({address1:x.input.address1,address2:x.input.address2,city:x.input.city,state:x.input.state,zip:x.input.zip,zip4:x.zip4}));
  if(rows.length){app.lookups.push(...JigCore.parseLookup('usps.json',JSON.stringify(rows)));$('clearLookup').disabled=false;$('useZip4').checked=true;const grp=document.querySelector('#ruleGroups input[data-group="zip"]');if(grp)grp.checked=true;updateComboSelectors();}
  $('lookupStatus').textContent='USPS verified '+rows.length+' addresses of '+choices.length+'; '+data.results.filter(r=>!r.ok).length+' unavailable. No ZIP+4 guessed.';invalidate();
 }catch(e){$('lookupStatus').textContent='USPS error: '+e.message;}
}
$('selectEveryRow').addEventListener('click',()=>{const f=fileEntry();if(f){f.selection=new Set(f.parsed.records.map((_,i)=>i));invalidate();}});
$('selectNoRows').addEventListener('click',()=>{const f=fileEntry();if(f){f.selection=new Set();invalidate();}});
async function loadFloridaCityReference() {
 const btn=$('loadFloridaCities');
 if(!window.desktopAPI?.floridaZipCities){$('lookupStatus').textContent='Florida ZIP reference requires the installed Jig Studio app.';return;}
 if(btn?.disabled)return;
 if(btn)btn.disabled=true;
 $('lookupStatus').textContent='Loading Florida preferred and acceptable mailing cities over HTTPS...';
 try {
  const result=await window.desktopAPI.floridaZipCities();
  if(!Array.isArray(result.rows)||!result.rows.length)throw Error('No ZIP-city rows were found.');
  const converted=JigCore.parseLookup('florida-accepted-cities.json',JSON.stringify(result.rows));
  // Preserve address-specific ZIP+4 lookup records already imported by the owner.
  app.lookups=app.lookups.filter(r=>r.source!=='florida-zip-reference').concat(converted);
  $('lookupStatus').textContent='Florida ZIP reference: '+converted.length+' ZIPs loaded, preferred/acceptable cities only. No ZIP+4 values are included.';
  $('clearLookup').disabled=false;invalidate();
 } catch(e){$('lookupStatus').textContent='Florida cities unavailable: '+e.message+' Use Import lookup for your own accepted-city file.';}
 finally{if(btn)btn.disabled=false;}
}

$('checkZipOnline').addEventListener('click',fetchOnlineZipCities);
$('loadFloridaCities').addEventListener('click',loadFloridaCityReference);
$('useCityAliases').addEventListener('change',()=>{if($('useCityAliases').checked && !app.lookups.some(r=>r.source==='florida-zip-reference'))loadFloridaCityReference();});
$('openSmartySettings').addEventListener('click',()=>{
 const settings=$('zip4ProviderSettings');settings.open=true;
 settings.scrollIntoView({behavior:'smooth',block:'center'});
 $('smartyId').focus({preventScroll:true});
});
$('fetchUsps').addEventListener('click',fetchUspsZip4);

// Private in-memory handoff from authenticated website roster into Profile Studio.
window.JigStudioLocalImport=Object.freeze({
 async importWebsiteTemplate(name,text){
  window.JigStudioCards?.studio?.clear();
  if(typeof name!=='string'||!/\.(csv|json)$/i.test(name)||typeof text!=='string'||text.length>26*1024*1024)throw Error('The selected website profile template is invalid.');
  const oldCount=app.files.length;
  await ingestFiles([new File([text],name,{type:'text/plain'})]);
  const entry=app.files[oldCount];
  if(!entry||entry.error){app.files.splice(oldCount,1);render();throw Error(entry?.error||'Unable to read profile template.');}
  entry.websiteImport=true;
  return {name,profiles:entry.parsed.records.length};
 },
 exportCurrent:()=>exportSelected(),
 currentProcessed(){
  const file=fileEntry(),result=process(file);
  if(!file?.websiteImport||!result?.valid)throw Error('Load and prepare a website customer file before exporting with saved local cards.');
  return {fileName:file.name,records:structuredClone(result.records)};
 },
 paymentTargets(){
  const f=fileEntry();const records=f?.parsed?.records||[];
  return {count:records.length,indices:f?.selection?[...f.selection].sort((a,b)=>a-b):[],records,
   format:window.JigPaymentAllocation?.detect(records)||null};
 },
 usePaymentAssignment(assignment){
  const f=fileEntry();if(!f)return false;
  if(!assignment){delete f.manualPaymentCards;delete f.manualPaymentIndices;}
  else {f.manualPaymentCards=[...assignment.cards];f.manualPaymentIndices=[...assignment.indices];}
  app.results.clear();processCurrent();return true;
 },
 isCurrentWebsiteImport:(name)=>Boolean(fileEntry()?.websiteImport&&fileEntry()?.name===name),
 clearWebsiteImports(){
  window.JigStudioCards?.studio?.clear();
  app.files=app.files.filter(f=>!f.websiteImport);app.selected=Math.max(0,Math.min(app.selected,app.files.length-1));app.results.clear();render();
 }
});

// For development verification only; imported account files are not persisted or automatically transmitted.
if(location.search.includes('test=1'))window.__jigTest={app,ingestFiles,options,process,fileEntry,zipFiles,emailBank,renderRowPicker};
})();
