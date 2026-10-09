import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileWebhookCheckout, sameCheckout, reconcileEmailCheckoutIdentity, uniqueCheckoutOwner } from '../webhook-success.js';
const order = {id:'discord:channel:123',retailer:'PKC',orderNumber:'ABC123',checkoutAt:'2026-09-30T17:00:00Z',orderTotal:308.56,orderTotalBasis:'item_subtotal',itemCount:4,items:[{name:'Delta Reign Elite Trainer Box',quantity:2,price:59.99,imageUrl:null}],status:'confirmed'};
test('webhook prices correct email records, retain attribution, and collapse duplicate import', () => {
 const records=[{...order,id:'imap-live-pkc:abc',customerAccountId:'original',orderTotal:333.25,items:[]},{...order,orderTotal:0,customerAccountId:null}];
 const result=reconcileWebhookCheckout(records,order,{customerAccountId:'new-owner'});
 assert.equal(result.changed,true);assert.equal(records.length,1);
 assert.equal(records[0].customerAccountId,'original');assert.equal(records[0].orderTotal,308.56);
 assert.equal(records[0].priceSource,'checkout_webhook');
 assert.equal(sameCheckout(records[0],order),true);
 assert.equal(reconcileWebhookCheckout(records,order).changed,false);
});
test('anonymous imported checkouts acquire a verified customer and incomplete prices preserve prior totals', () => {
 const records=[{...order,orderTotal:0,customerAccountId:null}];
 reconcileWebhookCheckout(records,order,{customerAccountId:'customer',profileSlot:2});
 assert.equal(records[0].customerAccountId,'customer');assert.equal(records[0].profileSlot,2);
 reconcileWebhookCheckout(records,{...order,orderTotal:0,orderTotalBasis:'unknown'});
 assert.equal(records[0].orderTotal,308.56);
});
test('matching is scoped to retailer; conflicting owners are never combined', () => {
 assert.equal(sameCheckout(order,{...order,id:'other',retailer:'Target'}),false);
 const records=[{...order,id:'a',customerAccountId:'a'},{...order,id:'b',customerAccountId:'b'}];
 assert.equal(reconcileWebhookCheckout(records,order).conflict,true);assert.equal(records.length,2);
 assert.equal(uniqueCheckoutOwner([{customerAccountId:'a'},{customerAccountId:'b'}]),null);
});

test('legacy email identity is backfilled using its exact source ID and merges a priced webhook', () => {
 const records=[{id:'community-mailbox:legacy',retailer:'PKC',customerAccountId:null,orderTotal:333.25,items:[]},
 {...order,priceSource:'checkout_webhook',customerAccountId:'customer'}];
 const result=reconcileEmailCheckoutIdentity(records,{id:'community-mailbox:legacy',retailer:'PKC',orderNumber:'ABC123'});
 assert.equal(result.changed,true);assert.equal(records.length,1);
 assert.equal(records[0].orderTotal,308.56);assert.equal(records[0].customerAccountId,'customer');
 assert.ok(records[0].sourceIds.includes('community-mailbox:legacy'));
 assert.equal(reconcileEmailCheckoutIdentity(records,{id:'community-mailbox:legacy',retailer:'PKC',orderNumber:'ABC123'}).changed,false);
});
test('email backfill refuses unrelated source IDs and conflicting order numbers', () => {
 const records=[{...order,id:'legacy',orderNumber:'original'}];
 assert.equal(reconcileEmailCheckoutIdentity(records,{id:'other',retailer:'PKC',orderNumber:'ABC123'}).changed,false);
 assert.equal(reconcileEmailCheckoutIdentity(records,{id:'legacy',retailer:'PKC',orderNumber:'ABC123'}).conflict,true);
 assert.equal(records[0].orderNumber,'original');
});

test('repeated scans never add a second copy of the same source message', () => {
 const records = [];
 const checkout = { ...order, id: 'discord:1532179373292257290:1580000000000000001', orderNumber: '', customerAccountId: null };
 assert.equal(reconcileWebhookCheckout(records, checkout, null).added, true);
 assert.equal(reconcileWebhookCheckout(records, checkout, null).changed, false);
 assert.equal(reconcileWebhookCheckout(records, checkout, null).changed, false);
 assert.equal(records.length, 1);
});

test('an identical product from two unrelated checkout messages is not assumed a duplicate', () => {
 const records = [];
 const a = { ...order, id: 'discord:1532179373292257290:1580000000000000001', orderNumber: '' };
 const b = { ...order, id: 'discord:1532179373292257290:1580000000000000002', orderNumber: '' };
 reconcileWebhookCheckout(records, a);
 reconcileWebhookCheckout(records, b);
 assert.equal(records.length, 2);
 assert.equal(sameCheckout(a, b), false);
 assert.equal(sameCheckout({ retailer: 'Target' }, { retailer: 'Target' }), false);
});

test('same retailer order on two feeds reconciles to one stored checkout', () => {
 const records = [];
 const first = { ...order, id: 'discord:1532179373292257290:1580000000000000001', orderNumber: 'W-123456' };
 const second = { ...order, id: 'discord:1551090141693485156:1580000000000000002', orderNumber: 'W-123456' };
 reconcileWebhookCheckout(records, first, { customerAccountId: 'customer-1' });
 reconcileWebhookCheckout(records, second);
 assert.equal(records.length, 1);
 assert.equal(records[0].customerAccountId, 'customer-1');
 assert.ok(records[0].sourceIds.includes(first.id));
 assert.ok(records[0].sourceIds.includes(second.id));
 assert.equal(reconcileWebhookCheckout(records, second).changed, false);
});

test('generic order statuses are never deduplication identities', () => {
 assert.equal(sameCheckout(
   { id: 'discord:a:1', orderNumber: 'Success', retailer: 'Target' },
   { id: 'discord:b:2', orderNumber: 'Success', retailer: 'Target' }
 ), false);
});
