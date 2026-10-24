"use strict";
// Per-file export contract: untouched files export byte-for-byte; edited files
// retain their source extension, field names, order, delimiter, and JSON envelope.
const ext = name => String(name || "").toLowerCase().split(".").pop();
const classify = name => ({ csv:"csv", tsv:"tsv", json:"json", txt:"txt" })[ext(name)] || "opaque";
function csvRows(raw, sep) {
  const rows=[];let cells=[],word="",quoted=false;
  for(let i=0;i<raw.length;i++){const c=raw[i];
    if(c==='"'){if(quoted&&raw[i+1]==='"'){word+='"';i++;}else quoted=!quoted;continue;}
    if(c===sep&&!quoted){cells.push(word);word="";continue;}
    if((c==="\r"||c==="\n")&&!quoted){if(c==="\r"&&raw[i+1]==="\n")i++;
      cells.push(word);if(cells.some(x=>x.length))rows.push(cells);word="";cells=[];continue;}
    word+=c;
  }
  cells.push(word);if(cells.some(x=>x.length))rows.push(cells);
  return rows;
}
function recordsFromJson(value) {
  if(Array.isArray(value))return { rows:value, listPath:"root" };
  if(!value||typeof value!=="object")return { rows:[], listPath:null };
  for(const field of ["profiles","accounts","data","items","records"])if(Array.isArray(value[field]))
    return { rows:value[field],listPath:field };
  return { rows:[value],listPath:"single" };
}
function readSource(name, content) {
  if(typeof content!=="string"||content.length>24*1024*1024)throw Error("Choose a file under 24 MB.");
  const kind=classify(name);const lineEnding=content.includes("\r\n")?"\r\n":"\n";
  let rows=[],doc=null,delimiter=",",headers=[],path=null;
  if(kind==="json"){doc=JSON.parse(content);const result=recordsFromJson(doc);rows=result.rows;path=result.listPath;}
  if(kind==="csv"||kind==="tsv"){
    delimiter=kind==="tsv"?"\t":(content.split(/\r?\n/,1)[0]||"").includes(";")?";":",";
    const parsed=csvRows(content.replace(/^\uFEFF/,""),delimiter);
    headers=parsed.shift()||[];
    rows=parsed.map(cells=>Object.fromEntries(headers.map((h,i)=>[h,cells[i]??""])));
  }
  if(kind==="txt"){
    // Native TXT records stay exact unless the file is a regular key:value list.
    const blocks=content.split(/\r?\n\r?\n/).filter(Boolean);
    rows=blocks.map(block=>Object.fromEntries(block.split(/\r?\n/).map(line=>{
      const m=/^([^:\n=]+)\s*[:=]\s*(.*)$/.exec(line);
      return m?[m[1].trim(),m[2]]:["Raw Text",line];
    })));
    path="blocks";
  }
  return { filename:String(name).replace(/[\\/:*?"<>|]/g,"_"),kind,original:content,lineEnding,
    delimiter,headers,rows:rows.map(x=>({...x})),doc,path,changed:false };
}
function findField(row,aliases) {
  const keys=Object.keys(row||{});
  return keys.find(k=>aliases.includes(k.toLowerCase().replace(/[^a-z0-9]/g,"")));
}
const aliases={
  email:["email","accountemail","loginemail"], name:["name","profilename","fullname","first_name","firstname"],
  last:["lastname","last_name","surname"], phone:["phone","phonenumber","shippingphone"],
  address:["address","address1","street","street1","streetaddress","shippingaddress","shippingaddress1","shippingline1"],
  city:["city","shippingcity"], state:["state","shippingstate"],zip:["zip","zipcode","postalcode","shippingzip"],
  unit:["address2","street2","unit","apt","apartment","shippingaddress2"],
  cardNumber:["cardnumber","ccnumber","creditcardnumber","paymentnumber","cardnum","number"],
  cardExpiry:["expiry","expiration","expirationdate","expmmyy","ccexp","cardexpiration","cardexpiry"],
  cardholder:["cardholder","cardholdername","billingname","nameoncard"],
  cardSecurityCode:["securitycode","cardsecuritycode","cardverificationcode","cvv","cvc","cvv2","cvc2","ccv","ccv2","verificationcode"],
  billingAddress:["billingaddress","billingaddress1","billingstreet","billingstreet1"],
  billingCity:["billingcity"],billingState:["billingstate"],billingZip:["billingzip","billingpostalcode"]
};
function changeRow(source,rowIndex,changes) {
  if(!["csv","tsv","json","txt"].includes(source.kind))throw Error("This file can be exported unchanged, but its structure is not editable.");
  if(!Number.isInteger(rowIndex)||rowIndex<0||rowIndex>=source.rows.length)throw Error("Choose an imported profile.");
  const row=source.rows[rowIndex];
  if(!row||typeof row!=="object")throw Error("This profile is not an editable record.");
  let updated=0;
  for(const [name,value]of Object.entries(changes||{})){
    if(typeof value!=="string"||value.length>600)throw Error("Field value too long.");
    const key=findField(row,aliases[name]||[name.toLowerCase()]);
    if(key){row[key]=value;updated++;}
  }
  if(updated)source.changed=true;
  return updated;
}
// Manual editing changes only fields already present in the imported source.
// This preserves every retailer's original column names, JSON envelope,
// record ordering and original-format export contract.
function editFields(source,rowIndex,updates){
  if(!["csv","tsv","json","txt"].includes(source?.kind))
    throw Error("This import format is not editable.");
  if(!Number.isInteger(rowIndex)||rowIndex<0||rowIndex>=source.rows.length)
    throw Error("Choose a valid saved profile.");
  if(!updates||typeof updates!=="object"||Array.isArray(updates))
    throw Error("Choose profile fields to edit.");
  const row=source.rows[rowIndex];
  if(!row||typeof row!=="object"||Array.isArray(row))
    throw Error("Profile record cannot be edited.");
  let changed=0;
  for(const [field,value] of Object.entries(updates)){
    if(field==="__proto__"||field==="constructor"||field==="prototype"||
       !Object.hasOwn(row,field)||typeof value!=="string"||value.length>5000)
      throw Error("The field cannot be edited in this retailer format.");
    if(typeof row[field]==="object"&&row[field]!==null)
      throw Error("Use import/export for nested retailer data.");
    if(String(row[field]??"")!==value){row[field]=value;changed++;}
  }
  if(changed)source.changed=true;
  return changed;
}
function quote(value,sep){const x=String(value??"");return /["\r\n]/.test(x)||x.includes(sep)?'"'+x.replace(/"/g,'""')+'"':x;}
function exportSource(source) {
  if(!source.changed)return source.original;
  if(source.kind==="json") {
    const copy=structuredClone(source.doc);
    if(source.path==="root")source.rows.forEach((row,i)=>copy[i]=row);
    else if(source.path==="single")Object.assign(copy,source.rows[0]);
    else if(source.path)source.rows.forEach((row,i)=>copy[source.path][i]=row);
    const indent=/\n([ \t]+)"/.exec(source.original)?.[1]||"  ";
    return JSON.stringify(copy,null,indent)+ (source.original.endsWith("\n")?source.lineEnding:"");
  }
  if(source.kind==="csv"||source.kind==="tsv"){
    const data=[source.headers,...source.rows.map(row=>source.headers.map(h=>row[h]??""))];
    return data.map(row=>row.map(value=>quote(value,source.delimiter)).join(source.delimiter)).join(source.lineEnding)+
      (/\r?\n$/.test(source.original)?source.lineEnding:"");
  }
  if(source.kind==="txt"){
    const blocks=source.rows.map(row=>Object.entries(row).map(([key,value])=>key==="Raw Text"?value:key+": "+value).join(source.lineEnding));
    return blocks.join(source.lineEnding+source.lineEnding);
  }
  return source.original;
}
function exportAs(source,choice='original'){
 const format=String(choice||'original').toLowerCase();
 if(format==='original')return {filename:source.filename,content:exportSource(source)};
 if(!['csv','tsv','json','txt'].includes(format))throw Error('Choose original, CSV, TSV, JSON or TXT.');
 const filename=source.filename.replace(/\.[^.]*$/, '')+'.'+format;
 const rows=source.rows.map(row=>structuredClone(row));
 if(format==='json')return {filename,content:JSON.stringify(rows,null,2)+'\n'};
 if(format==='txt'){
  return {filename,content:rows.map((row,i)=>{
   const lines=['Profile '+(i+1)];
   for(const [key,value]of Object.entries(row||{}))lines.push(key+': '+(typeof value==='object'&&value!==null?JSON.stringify(value):String(value??'')));
   return lines.join('\n');
  }).join('\n\n')+'\n'};
 }
 const separator=format==='tsv'?'\t':',';
 const headers=[...new Set(rows.flatMap(row=>Object.keys(row||{})))];
 const values=[headers,...rows.map(row=>headers.map(key=>typeof row[key]==='object'&&row[key]!==null?JSON.stringify(row[key]):String(row[key]??'')))];
 return {filename,content:values.map(columns=>columns.map(value=>quote(value,separator)).join(separator)).join('\r\n')+'\r\n'};
}
function profileSummary(source){
  return { filename:source.filename,kind:source.kind,count:source.rows.length,
    editable:["csv","tsv","json","txt"].includes(source.kind),
    changed:source.changed,rows:source.rows.slice(0,1000).map((row,i)=>({id:i,
      name:String(row?.[findField(row,aliases.name)]??"Profile "+(i+1)),
      email:String(row?.[findField(row,aliases.email)]??""),retailer:""})) };
}
module.exports={readSource,exportSource,exportAs,changeRow,editFields,profileSummary,findField,aliases,csvRows};
