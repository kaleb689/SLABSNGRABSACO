'use strict';
/* Retailer login-only import/export. Contains no card, address or profile data. */
const EMAIL=/^[^\s@,;:]+@[^\s@,;:]+\.[^\s@,;:]+$/;
const NAMES={target:'Target',walmart:'Walmart',pokemoncenter:'Pokemon Center',costco:'Costco',sams:"Sam's Club"};
const retail=v=>{
 const s=String(v||'').trim().toLowerCase().replace(/[^a-z]/g,'');
 return {target:'target',walmart:'walmart',pokemoncenter:'pokemoncenter',
  pokmoncenter:'pokemoncenter',pokemon:'pokemoncenter',costco:'costco',
  sams:'sams',samsclub:'sams'}[s]||null;
};
function validAccount(row){
 const email=String(row?.email??row?.username??'').trim().toLowerCase(),password=String(row?.password??'');
 if(!EMAIL.test(email)||!password||password.length>1024||/[\r\n\x00-\x1f\x7f]/.test(password))
  throw Error('Invalid retailer account email/password; no accounts were imported.');
 return {email,password};
}
function csvRows(input,sep=','){
 const s=String(input||'').replace(/^\uFEFF/,'');let rows=[],row=[],value='',quoted=false,ending=false;
 for(let i=0;i<s.length;i++){
  const c=s[i];
  if(quoted){
   if(c==='"'&&s[i+1]==='"'){value+='"';i++;}
   else if(c==='"')quoted=false;
   else value+=c;
  }else if(c==='"'&&value==='')quoted=true;
  else if(c===sep){row.push(value);value='';ending=false;}
  else if(c==='\n'||c==='\r'){
   if(c==='\r'&&s[i+1]==='\n')i++;
   row.push(value);value='';if(row.some(x=>x!==''))rows.push(row);row=[];ending=true;
  }else{value+=c;ending=false;}
 }
 if(quoted)throw Error('CSV includes an unfinished quoted field.');
 if(!ending||value||row.length){row.push(value);if(row.some(x=>x!==''))rows.push(row);}
 return rows;
}
function parseText(text,{fileName='',retailer=null}={}){
 if(typeof text!=='string'||text.length>5*1024*1024)throw Error('Choose an account file under 5 MB.');
 const name=String(fileName).toLowerCase(),trimmed=text.trim();
 if(!trimmed)throw Error('No retailer account rows provided.');
 let claimedRetailer=null,rows=[];
 if(name.endsWith('.json')||trimmed.startsWith('{')||trimmed.startsWith('[')){
  let data;try{data=JSON.parse(trimmed);}catch{throw Error('Invalid accounts JSON. No records imported.');}
  if(data&&typeof data==='object'&&!Array.isArray(data)&&data.accounts&&typeof data.accounts==='object'){
   if(data.site){claimedRetailer=retail(data.site);if(!claimedRetailer)throw Error('Unknown retailer site in Valor account JSON.');}
   rows=Object.values(data.accounts).map(item=>validAccount(item));
  }else if(Array.isArray(data)){rows=data.map(item=>validAccount(item));}
  else throw Error('Unsupported JSON account format. Choose a Valor account file or a list of account objects.');
 }else{
  const nonblank=trimmed.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const delim=nonblank[0].includes('\t')?'\t':',',table=csvRows(trimmed,delim);
  const header=(table[0]||[]).map(x=>x.trim().toLowerCase().replace(/\s+/g,'_'));
  let u=header.findIndex(x=>['username','email','login','login_email'].includes(x));
  let pw=header.findIndex(x=>['password','pass','pwd'].includes(x));
  if(u>=0&&pw>=0){
   rows=table.slice(1).map(cols=>validAccount({email:cols[u],password:cols[pw]}));
  }else if(nonblank.every(line=>/^[^\s@,;:]+@[^\s@,;:]+\.[^\s@,;:]+(?:\s*:::|\s*;|\s*:|\s*,|\t)/.test(line))){
   rows=nonblank.map(line=>{
    const m=line.match(/^(\S+?@\S+?\.\S+?)\s*(:::|;|:|,|\t)\s*(.*)$/);
    if(!m)throw Error('Cannot parse one or more account lines.');
    return validAccount({email:m[1],password:m[3]});
   });
  }else throw Error('Use a Shikari username,password CSV, Valor accounts JSON, or email:password text.');
 }
 if(!rows.length||rows.length>5000)throw Error('Choose between 1 and 5000 retailer accounts.');
 if(retailer&&!NAMES[retailer])throw Error('Choose a valid retailer.');
 if(claimedRetailer&&retailer&&claimedRetailer!==retailer)
  throw Error('File belongs to '+NAMES[claimedRetailer]+', not '+NAMES[retailer]+'. Select the correct retailer.');
 const seen=new Set(),unique=[];
 for(const a of rows){if(seen.has(a.email))continue;seen.add(a.email);unique.push(a);}
 return {accounts:unique,inputCount:rows.length,duplicateCount:rows.length-unique.length,retailer:claimedRetailer||retailer};
}
function textTemplate(template){
 const value=String(template||'email:password');
 if(value.length>120||/[\r\n\x00-\x1f\x7f]/.test(value))throw Error('Use a single-line export template.');
 const matches=[...value.matchAll(/email|password/gi)];
 if(matches.length!==2||matches.filter(x=>x[0].toLowerCase()==='email').length!==1||
    matches.filter(x=>x[0].toLowerCase()==='password').length!==1)
  throw Error('Template must contain one email and one password token (for example, email:::password).');
 return value;
}
function csvCell(value){const s=String(value??'');return /[",\r\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}
function exportAccounts(accounts,retailer,type,template='email:password',makeId){
 if(!NAMES[retailer])throw Error('Choose a retailer.');
 if(!Array.isArray(accounts)||!accounts.length||accounts.length>20000)throw Error('No saved retailer logins to export.');
 const entries=accounts.map(validAccount);
 const chosen=String(type||'txt').toLowerCase();
 if(chosen==='shikari')return {name:retailer+'-accounts-shikari.csv',
  body:'username,password\r\n'+entries.map(x=>[csvCell(x.email),csvCell(x.password)].join(',')).join('\r\n')+'\r\n'};
 if(chosen==='valor'){
  if(typeof makeId!=='function')throw Error('Account ID generator unavailable.');
  const objects={};for(const item of entries){const id=makeId();if(typeof id!=='string'||!id)throw Error('Invalid Valor account ID.');objects[id]={id,email:item.email,password:item.password,proxy:null,session:false,selected:false};}
  return {name:retailer+'-accounts-valor.json',body:JSON.stringify({version:1,site:NAMES[retailer],accounts:objects,sessions:{}},null,2)};
 }
 if(chosen!=='txt')throw Error('Choose Shikari CSV, Valor JSON, or TXT.');
 const pattern=textTemplate(template);
 return {name:retailer+'-accounts.txt',
  body:entries.map(a=>pattern.replace(/email|password/gi,m=>m.toLowerCase()==='email'?a.email:a.password)).join('\n')+'\n'};
}
module.exports={parseText,exportAccounts,textTemplate,retail,NAMES};
