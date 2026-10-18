'use strict';
// The desktop Admin is an authenticated client of the existing website API.
// There is deliberately no user-defined path/method API exposed by the preload.
const {randomUUID}=require('node:crypto');
const clean=(v,max=150)=>String(v??'').trim().slice(0,max);
const ID=/^[A-Za-z0-9:_-]{1,150}$/;
const ident=v=>{const s=clean(v);if(!ID.test(s))throw Error('Invalid customer or record ID.');return encodeURIComponent(s);};
const alist=x=>Array.isArray(x)?x:[];
const money=v=>Number.isFinite(Number(v))?Number(v):0;
const digits=v=>String(v??'').replace(/\D/g,'');
const statuses=new Set(['all','available','linked','held','needs_repair','duplicate']);
const methods=new Set(['GET','POST','PUT','PATCH','DELETE']);
const PAYMENT_SECRET=/(?:password|passphrase|privatekey|secret|auth.?token|access.?token|refresh.?token|cvv|cvc|csc|security.?code|verification.?code|api.?key|cc_number)/i;
const CARD_CONTEXT=/(?:card|payment|credit|debit|vault|billing)/i;
function safeResult(value,depth=0,parent=''){
 if(depth>14)return null;
 if(Array.isArray(value))return value.slice(0,1200).map(x=>safeResult(x,depth+1,parent));
 if(!value||typeof value!=='object')return typeof value==='string'?value.slice(0,1600):value;
 const out={};for(const [k,v] of Object.entries(value)){
  if(PAYMENT_SECRET.test(k)||/^__/.test(k))continue;
  if(/^(?:maskedNumber|last4|lastFour)$/i.test(k)){
   const four=digits(v).slice(-4);out[k]=/^maskedNumber$/i.test(k)?(four?'•••• '+four:''):four;continue;
  }
  // Some existing endpoints return a full PAN under a generic 'number' nested
  // inside payment methods. Mask it before crossing the process boundary.
  const paymentNumber=/(?:card.*number|account.*number|primaryAccountNumber|^(?:pan|cc_number)$)/i.test(k) ||
   (/^number$/i.test(k)&&CARD_CONTEXT.test(parent));
  if(paymentNumber&&typeof v==='string'&&digits(v).length>6){out[k]='•••• '+digits(v).slice(-4);continue;}
  out[k]=safeResult(v,depth+1,parent?parent+'.'+k:k);
 }return out;
}
function query(kind,opts={}){
 switch(kind){
 case 'dashboard':return ['/api/admin/membership-revenue','/api/admin/success-overview','/api/admin/app-usage','/api/admin/site-notification'];
 case 'orders':return ['/api/admin/success-overview','/api/admin/checkout-paid-verification'];
 case 'memberships':return ['/api/admin/discount-codes','/api/admin/gifted-memberships','/api/admin/giftable-customers','/api/admin/membership-revenue','/api/public/membership-prices'];
 case 'operations':return ['/api/admin/site-notification','/api/admin/discord-success-status','/api/admin/managed-success-mailbox-status','/api/admin/signup-consent-log?limit=50&offset=0'];
 case 'pool':{
  const status=statuses.has(opts.status)?opts.status:'all';
  const retailer=['all','target','walmart','pokemoncenter'].includes(opts.retailer)?opts.retailer:'all';
  const page=Math.max(1,Math.min(5000,Math.floor(Number(opts.page)||1)));
  const q=new URLSearchParams({status,retailer,page:String(page),q:clean(opts.query,120)});
  return ['/api/admin/managed-pool/search?'+q.toString()];
 }
 default:throw Error('Unknown Admin view.');
 }
}
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function discountPayload(input){
 const code=clean(input.code,40).toUpperCase();if(!/^[A-Z0-9]{3,40}$/.test(code))throw Error('Code must contain 3–40 letters or numbers.');
 const discountType=input.discountType==='fixed-price'?'fixed-price':'percent',tier=input.tier==='all'?'all':Number(input.tier);
 if(!['all',1,2,3,4,5,6,7,8].includes(tier))throw Error('Invalid membership tier.');
 const percent=Number(input.percent),fixedPrice=Number(input.fixedPrice);
 if(discountType==='percent'&&(!Number.isInteger(percent)||percent<1||percent>100))throw Error('Enter a percentage of 1–100.');
 if(discountType==='fixed-price'&&(tier==='all'||!Number.isFinite(fixedPrice)||fixedPrice<.01))throw Error('Fixed prices require a specific membership tier.');
 const duration=['once','forever','repeating'].includes(input.duration)?input.duration:'once';
 const durationMonths=duration==='repeating'?Number(input.durationMonths):null;
 if(duration==='repeating'&&(!Number.isSafeInteger(durationMonths)||durationMonths<1||durationMonths>36))throw Error('Repeat duration must be 1–36 months.');
 const sitewide=input.audience==='sitewide',ogOnly=input.audience==='og',recipientEmail=input.audience==='private'?clean(input.recipientEmail,150).toLowerCase():null;
 if(input.audience==='private'&&!EMAIL.test(recipientEmail))throw Error('Enter a valid customer email.');
 const maxUses=input.maxUses==null||input.maxUses===''?null:Number(input.maxUses);
 if(maxUses!==null&&(!Number.isSafeInteger(maxUses)||maxUses<1||maxUses>100000))throw Error('Maximum uses must be 1–100,000.');
 return {code,discountType,percent:discountType==='percent'?percent:0,fixedPrice:discountType==='fixed-price'?fixedPrice:null,tier,
  maxUses,sitewide,ogOnly,recipientEmail,expiresAt:clean(input.expiresAt,32)||null,duration,durationMonths,appliesToRentals:input.appliesToRentals===true};
}
const addressFields=['firstName','lastName','phone','address','address2','city','state','zip','country'];
function profilePayload(input){
 const profile={};for(const field of addressFields)if(Object.hasOwn(input,field))profile[field]=clean(input[field],field==='zip'?12:field==='phone'?35:180);
 if(Object.hasOwn(profile,'state'))profile.state=profile.state.toUpperCase();
 if(Object.hasOwn(profile,'zip')&&!/^\d{5}(?:-\d{4})?$/.test(profile.zip))throw Error('Enter a valid ZIP5 or ZIP+4.');
 return {profile};
}
function mutation(action,raw={}){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid Admin action.');
 let path,method='POST',data={};
 switch(action){
 case 'customer-profile':path='/api/admin/submissions/'+ident(raw.orderId);method='PUT';data=profilePayload(raw.profile||{});break;
 case 'customer-og':path='/api/admin/customers/'+ident(raw.customerId)+'/og-status';method='PUT';break;
 case 'customer-missing-info':path='/api/admin/submissions/'+ident(raw.orderId)+'/notify-missing-info';break;
 case 'customer-message':{
  const message=clean(raw.message,1200);if(!message)throw Error('Enter the customer notification.');
  path='/api/admin/submissions/'+ident(raw.orderId)+'/message-customer';data={message};break;
 }
 case 'customer-reset-password':path='/api/admin/customers/'+ident(raw.customerId)+'/reset-password';break;
 case 'gift-create':{
  const tier=Number(raw.tier),durationUnit=raw.unit==='weeks'?'weeks':'months',durationQuantity=Number(raw.quantity);
  if(![1,2,3,4,5,6,7,8].includes(tier)||!Number.isSafeInteger(durationQuantity)||durationQuantity<1||durationQuantity>12)throw Error('Choose a valid tier and 1–12 weeks or months.');
  path='/api/admin/gifted-memberships';data={customerAccountId:clean(raw.customerId),tier,durationUnit,durationQuantity,requestId:raw.requestId&&/^[A-Za-z0-9-]{12,80}$/.test(raw.requestId)?raw.requestId:randomUUID()};
  ident(data.customerAccountId);break;
 }
 case 'gift-remove':path='/api/admin/gifted-memberships/'+ident(raw.id);method='DELETE';break;
 case 'discount-save':data=discountPayload(raw);path='/api/admin/discount-codes'+(raw.id?'/'+ident(raw.id):'');method=raw.id?'PUT':'POST';break;
 case 'discount-toggle':path='/api/admin/discount-codes/'+ident(raw.id);method='PATCH';data={active:raw.active===true};break;
 case 'discount-delete':path='/api/admin/discount-codes/'+ident(raw.id);method='DELETE';break;
 case 'site-notification':{
  const title=clean(raw.title,80),message=clean(raw.message,400);
  if(!title||!message)throw Error('Enter a title and message.');
  path='/api/admin/site-notification';data={title,message};break;
 }
 case 'site-notification-retract':path='/api/admin/site-notification/'+ident(raw.id)+'/retract';break;
 case 'discord-success-scan':path='/api/admin/discord-success-scan';break;
 case 'account-mark-repaired':path='/api/admin/managed-pool/'+ident(raw.id)+'/mark-repaired';data={};break;
 case 'account-override-hold':path='/api/admin/managed-pool/'+ident(raw.id)+'/override-hold';data={};break;
 default:throw Error('Unsupported native Admin action.');
 }
 if(!methods.has(method))throw Error('Invalid method.');
 return {path,method,data};
}
module.exports={query,mutation,safeResult,profilePayload,discountPayload};
