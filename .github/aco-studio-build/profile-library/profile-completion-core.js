'use strict';
const Draft=require('./profile-draft-core');
const validPhone=value=>{const s=String(value||'').replace(/\D/g,'');return s.length>=10&&s.length<=15;};
function inspect(row){const original=row.data||{},data=require('./profile-library-core').normalized(original,row.retailer||(Draft.formatOf(original)==='shikari'?'target':'pokemoncenter')),v=Draft.toValues(data),missing=[];
 if(!row.jiggedAt)missing.push('Saved jig');if(row.source==='website-linked-profile'&&row.sourceLinked===false)missing.push('Active linked account');
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email||''))missing.push('Account email');
 if(!v.first||!v.last)missing.push('First and last name');
 for(const role of ['shipping','billing']){
  const title=role==='shipping'?'Shipping':'Billing';
  if(!v[role+'.first']||!v[role+'.last'])missing.push(title+' name');
  if(['address1','city','state','zip'].some(k=>!v[role+'.'+k]))missing.push(title+' address');
  if(!validPhone(v[role+'.phone']))missing.push(title+' phone number');
 }
 if(v['shipping.first']!==v['billing.first']||v['shipping.last']!==v['billing.last'])missing.push('Matching shipping and billing names');
 const shikari=Draft.formatOf(data)==='shikari',number=String(shikari?data.cc_number:data.card?.number||'').replace(/[ -]/g,''),holder=shikari?data.cc_name:data.card?.holder;
 if(!/^\d{12,19}$/.test(number)||!String(holder||'').trim())missing.push('Card number and cardholder');
 const exp=shikari?[data.cc_exp_month,data.cc_exp_year]:String(data.card?.expiration||'').split('/');
 if(!/^(0?[1-9]|1[0-2])$/.test(String(exp[0]||''))||! /^(20\d\d|\d\d)$/.test(String(exp[1]||'')))missing.push('Card expiration');
 return {ready:missing.length===0,missing};
}
function synchronize(row,audit=[],now=()=>new Date().toISOString()){
 if(!row.jiggedAt){const entry=audit.find(x=>x.email===row.email&&x.retailer===row.retailer&&(['address-jig','address-distribution'].includes(x.action)||x.action==='selected-fields'&&x.fields?.includes('address')));if(entry)row.jiggedAt=entry.at;}
 const result=inspect(row);row.stage=result.ready?'completed':'in-progress';if(result.ready&&!row.completedAt)row.completedAt=now();return result;
}
module.exports={inspect,synchronize,validPhone};
