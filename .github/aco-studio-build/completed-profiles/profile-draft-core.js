'use strict';
const Core=require('./app');
const emailFrom=v=>typeof v.email==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)?v.email:'';
const retailerId=v=>{if(!['target','walmart','pokemoncenter','costco','sams'].includes(v))throw Error('Choose a retailer.');return v;};
const {randomUUID}=require('node:crypto');
const FIELDS=['label','email','password','first','last','phone',...['shipping','billing'].flatMap(r=>['first','last','address1','address2','city','state','zip','country','phone'].map(k=>r+'.'+k))];
function inputs(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!FIELDS.includes(k)))throw Error('The profile form contains an unknown field.');
 const out={};for(const k of FIELDS){const v=value[k]??'';if(typeof v!=='string'||v.length>(k==='password'?500:200)||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v))throw Error('Invalid '+k+' field.');out[k]=k==='password'?v:v.trim();}
 if(out.email&&!emailFrom({email:out.email}))throw Error('Enter a valid email or leave it blank as a draft.');
 return out;
}
function blank(retailer,format,values={},uuid=randomUUID){
 retailerId(retailer);if(!['shikari','valor'].includes(format))throw Error('Choose Shikari CSV or Valor JSON.');const v=inputs(values),id=uuid();
 if(format==='shikari'){
  const row={profile_name:v.label||'Blank profile',first_name:v.first,last_name:v.last,email:v.email,password:v.password,phone_num:v.phone,
   cc_number:'',cc_exp_month:'',cc_exp_year:'',cc_cvv:'',cc_name:'',cc_type:'',custom_security_code:'',
   shipping_first_name:(v['shipping.first']||v.first),shipping_last_name:(v['shipping.last']||v.last),shipping_street:v['shipping.address1'],shipping_street_2:v['shipping.address2'],shipping_city:v['shipping.city'],shipping_state:v['shipping.state'],shipping_zip_code:v['shipping.zip'],shipping_country:v['shipping.country']||'US',shipping_phone:(v['shipping.phone']||v.phone),
   billing_first_name:(v['billing.first']||v.first),billing_last_name:(v['billing.last']||v.last),billing_street:v['billing.address1'],billing_street_2:v['billing.address2'],billing_city:v['billing.city'],billing_state:v['billing.state'],billing_zip_code:v['billing.zip'],billing_country:v['billing.country']||'US',billing_phone:(v['billing.phone']||v.phone)};
  return row;
 }
 const addr=r=>({firstName:(v[r+'.first']||v.first),lastName:(v[r+'.last']||v.last),addressLine1:v[r+'.address1'],addressLine2:v[r+'.address2'],city:v[r+'.city'],state:v[r+'.state'],zipCode:v[r+'.zip'],countryCode:v[r+'.country']||'US',countryName:(v[r+'.country']||'US')==='US'?'United States':v[r+'.country'],phoneNumber:(v[r+'.phone']||v.phone)});
 return {id,name:v.label||'Blank profile',email:v.email,password:v.password,firstName:v.first,lastName:v.last,phoneNumber:v.phone,billingSameAsShipping:false,oneCheckout:false,quickTask:false,card:{holder:'',number:'',expiration:'',cvv:'',type:'',custom_security_code:''},shipping:addr('shipping'),billing:addr('billing'),totalSpent:0};
}
function formatOf(row){return Object.hasOwn(row,'cc_number')?'shikari':'valor';}
function toValues(row){const format=formatOf(row),v={label:row.profile_name||row.name||'',email:row.email||'',password:row.password||'',first:row.first_name||row.firstName||'',last:row.last_name||row.lastName||'',phone:row.phone_num||row.phoneNumber||''};
 if(format==='shikari')for(const r of ['shipping','billing']){for(const [a,b]of Object.entries({first:'first_name',last:'last_name',address1:'street',address2:'street_2',city:'city',state:'state',zip:'zip_code',country:'country',phone:'phone'}))v[r+'.'+a]=String(row[r+'_'+b]||'');}
 else for(const r of ['shipping','billing'])for(const [a,b]of Object.entries({first:'firstName',last:'lastName',address1:'addressLine1',address2:'addressLine2',city:'city',state:'state',zip:'zipCode',country:'countryCode',phone:'phoneNumber'}))v[r+'.'+a]=String(row[r]?.[b]||'');return v;
}
function manualEdit(row,values){const v=inputs(values),template=blank('target',formatOf(row),v,()=>row.id);const result=structuredClone(row);
 // Keep all actual payment and retailer-specific fields from the existing draft.
 const cardKeys=new Set(['card','cc_number','cc_exp_month','cc_exp_year','cc_cvv','cc_name','cc_type','custom_security_code','id','totalSpent','oneCheckout','quickTask','billingSameAsShipping']);
 for(const key of Object.keys(template))if(!cardKeys.has(key))result[key]=template[key];return result;
}
function serializeProfile(profile){const row=profile.data||profile,format=profile.format||formatOf(row);const safe=(profile.label||row.profile_name||row.name||'profile').replace(/[^A-Za-z0-9_-]/g,'_').slice(0,70);
 if(format==='shikari'){const header=Object.keys(row);return {name:safe+'.csv',text:Core.serialDelimited([header,header.map(k=>row[k])],',','\r\n',true)};}
 return {name:safe+'.json',text:JSON.stringify({[row.id||profile.id]:row},null,2)};
}
function mask(row){const out=structuredClone(row);function visit(x){if(!x||typeof x!=='object')return;for(const k of Object.keys(x)){const n=k.toLowerCase();if(['cc_number','number','pan','cardnumber','card_number'].includes(n)&&typeof x[k]==='string'&&/^\d[\d -]{10,}$/.test(x[k]))x[k]='**** '+x[k].replace(/\D/g,'').slice(-4);else if(['custom_security_code','cvv','cvc','cid','security_code','securitycode'].includes(n))x[k]='';else if(typeof x[k]==='object')visit(x[k]);}}visit(out);return out;}
module.exports={FIELDS,inputs,blank,toValues,manualEdit,formatOf,serializeProfile,mask};
