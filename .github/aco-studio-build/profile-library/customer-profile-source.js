'use strict';
const C=require('./profile-library-core'),D=require('./profile-draft-core');
const clean=v=>String(v??'').trim();
function sourceForCustomer(customer,saved,memberships){if(!customer?.id)throw Error('Authorized customer is missing.');const cards=Array.isArray(saved?.paymentMethods)?saved.paymentMethods:[],addresses=Array.isArray(saved?.addresses)?saved.addresses:[];
 const linked=[];
 for(const m of Array.isArray(memberships?.memberships)?memberships.memberships:[]){if(m.customerAccountId&&String(m.customerAccountId)!==customer.id)throw Error('Linked assignment belongs to another customer.');if(m.active!==true)continue;const retailers=m.retailers||{},r=m.assignmentRetailer==='pkc'?'pokemoncenter':m.assignmentRetailer||Object.keys(retailers).find(x=>['target','walmart','pokemoncenter','pkc'].includes(x));if(!r)continue;const retailer=r==='pkc'?'pokemoncenter':r,credentials=retailers[r]||retailers[retailer]||{},email=clean(credentials.username||credentials.email||m.accountEmail);if(!email)continue;
 const index=linked.length,
  selectedAddress=addresses.find(a=>m.savedAddressId&&String(a.id)===String(m.savedAddressId)),
  selectedCard=cards.find(c=>m.savedPaymentMethodId&&String(c.id)===String(m.savedPaymentMethodId)),
  address=(m.customerProfile?.address||m.customerProfile?.addressLine1)?m.customerProfile:selectedAddress||addresses[index%Math.max(1,addresses.length)]||customer.shipping||{},
  billing=(m.customerBillingProfile?.address||m.customerBillingProfile?.addressLine1)?m.customerBillingProfile:address,
  fallback=customer.shipping||{},
  card=(m.customerCard?.cardNumber||m.customerCard?.acoCardNumber)?m.customerCard:selectedCard||cards[index%Math.max(1,cards.length)]||{},
  first=clean(address.firstName||fallback.firstName),last=clean(address.lastName||fallback.lastName),
  phone=clean(address.phone||address.phoneNumber||fallback.phone||customer.phone),
  v={email,password:clean(credentials.password),label:customer.name+' '+(index+1),first,last,phone};
 for(const role of ['shipping','billing']){
  const source=role==='billing'?billing:address;
  const roleFirst=clean(source.firstName||first),roleLast=clean(source.lastName||last),rolePhone=clean(source.phone||source.phoneNumber||phone);
  for(const [key,value]of Object.entries({
   first:roleFirst,last:roleLast,phone:rolePhone,
   address1:source.address||source.addressLine1||fallback.address||'',
   address2:source.address2||source.addressLine2||'',city:source.city||fallback.city||'',
   state:source.state||fallback.state||'',zip:source.zip||source.zipCode||fallback.zip||'',
   country:source.country||source.countryCode||'US'}))v[role+'.'+key]=clean(value);
 }
 const data=D.blank(retailer,C.format(retailer),v),month=clean(card.expMonth).padStart(2,'0'),year=clean(card.expYear),pan=clean(card.acoCardNumber||card.cardNumber).replace(/\D/g,'');C.putCard(data,{number:pan,cardholder:clean(card.cardholder)||first+' '+last,month,year,type:clean(card.brand),customSecurityCode:''});
 linked.push({customerId:customer.id,assignmentId:String(m.assignmentId||m.id),managedAccountId:String(m.id||''),assignmentType:m.type==='rented'?'rented':m.type==='free'?'free':null,remoteUpdatedAt:String(m.updatedAt||''),retailer,active:true,data});
 }return {customer:{id:customer.id,name:customer.name},linked,
  // Main-process-only source records: caller must authorize this exact customer.
  // The renderer must receive only labels and last four digits, never this object.
  jigResources:{addresses:addresses.map(x=>({...x})),cards:cards.map(x=>({...x}))}};}
module.exports={sourceForCustomer};
