'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const CardPolicy=require('../card-pool-policy');
const N='4242424242424242',M='5555555555554444';
const profile=(id,retailer,n,code)=>({id,retailer,label:'Example '+id,data:{cc_number:n,cc_exp_month:'09',cc_exp_year:'2031',profileSecurityCode:code}});
const saved=[{id:'card-1',number:N,month:'09',year:'2031',label:'Saved card'},{id:'card-2',number:M,month:'09',year:'2031',label:'Unused card'}];

test('Standard cards move from Unused to their linked retailer and cannot be allocated again',()=>{
 const rows=[profile('a','target',N,'PICKUP-REFERENCE-17')];
 const inv=CardPolicy.inventory({rows,savedCards:saved,settings:{}});
 const assigned=inv.find(c=>c.last4==='4242'),free=inv.find(c=>c.last4==='4444');
 assert.deepEqual(assigned.linked,['target']);
 assert.deepEqual(assigned.availableRetailers,[]);
 assert.equal(assigned.hardCard,false);
 assert.equal(free.status,'Unused');
 assert.equal(free.availableRetailers.length,5);
 assert.throws(()=>CardPolicy.checkAllocation(rows,'walmart',[N],{}),/already linked/);
 assert.equal(rows[0].data.profileSecurityCode,'PICKUP-REFERENCE-17');
});

test('Hard Card permits one Target, one Walmart and one PKC assignment but never duplicates within a retailer',()=>{
 const settings=CardPolicy.toggle({},N,true);
 const rows=[profile('a','target',N,'UNRELATED-REFERENCE-1')];
 CardPolicy.checkAllocation(rows,'pokemoncenter',[N],settings);
 CardPolicy.checkAllocation([...rows,profile('b','pokemoncenter',N,'UNRELATED-REFERENCE-2')],'walmart',[N],settings);
 assert.throws(()=>CardPolicy.checkAllocation(rows,'target',[N],settings),/one per retailer/i);
 assert.throws(()=>CardPolicy.checkAllocation(rows,'walmart',[N,N],settings),/one per retailer/i);
 const links=CardPolicy.inventory({rows:[...rows,profile('b','pokemoncenter',N,'UNRELATED-REFERENCE-2')],savedCards:saved,settings});
 const card=links.find(x=>x.last4==='4242');
 assert.equal(card.hardCard,true);
 assert.deepEqual(card.linked,['target','pokemoncenter']);
 assert.deepEqual(card.availableRetailers,['walmart','costco','sams']);
 assert.equal(card.hasConflict,false);
 assert.equal(links.find(x=>x.last4==='4444').hardCard,false);
});

test('Hard Card settings never cross Personal, Mike or Derick vaults, even with the same card number',()=>{
 const personal=CardPolicy.toggle({},N,true);
 const mike=CardPolicy.toggle({},M,true);
 const derick={};
 const samePhysicalCard=N;
 assert.equal(CardPolicy.hardCard(samePhysicalCard,personal),true);
 assert.equal(CardPolicy.hardCard(samePhysicalCard,mike),false);
 assert.equal(CardPolicy.hardCard(samePhysicalCard,derick),false);
 const rows=[profile('owner','target',N,'MY-REFERENCE')];
 const owner=CardPolicy.inventory({rows,settings:personal});
 const customer=CardPolicy.inventory({rows:[profile('mike','target',N,'MIKE-REFERENCE')],settings:mike});
 assert.equal(owner[0].hardCard,true);
 assert.equal(customer[0].hardCard,false);
 assert.equal(customer[0].label.includes('MY-REFERENCE'),false);
 assert.equal(CardPolicy.inventory({rows:[],savedCards:[],settings:derick}).length,0);
});

test('Only card IDs owned by the exact vault resolve; no security code is copied or used',()=>{
 const ownerRows=[profile('owner-1','target',N,'OWNER-SECURITY-REFERENCE')];
 const customerRows=[profile('mike-1','target',M,'CUSTOMER-SECURITY-REFERENCE')];
 assert.throws(()=>CardPolicy.resolveReference('profile:owner-1',customerRows,[]),/not in this vault/);
 assert.throws(()=>CardPolicy.resolveReference('saved:owner-card',customerRows,saved),/not in this vault/);
 assert.equal(CardPolicy.resolveReference('profile:owner-1',ownerRows,[]),N);
 const inventory=CardPolicy.inventory({rows:customerRows,savedCards:[],settings:{}});
 assert.equal(JSON.stringify(inventory).includes('OWNER-SECURITY'),false);
 assert.equal(JSON.stringify(inventory).includes('CUSTOMER-SECURITY'),false);
});

test('Existing multiple uses are flagged for review instead of silently deleted',()=>{
 const settings=CardPolicy.toggle({},N,true);
 const rows=[profile('one','target',N),profile('two','target',N)];
 const items=CardPolicy.inventory({rows,savedCards:[],settings});
 assert.equal(items[0].hasConflict,true);
 assert.deepEqual(items[0].duplicateRetailers,['target']);
 assert.throws(()=>CardPolicy.checkAllocation(rows,'target',[N],settings),/one per retailer/);
});
