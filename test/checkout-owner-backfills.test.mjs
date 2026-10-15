import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveOwnerVerifiedBackfill} from '../checkout-owner-backfills.js';
import {reconcileWebhookCheckout} from '../webhook-success.js';
import {checkoutAssignmentContains} from '../discord-checkout-owner-evidence.js';
const identity={email:'nicholas_dixon663@web.de'};
const order={id:'discord:source:original',retailer:'PKC',orderNumber:'real-confirmation-12345',checkoutAt:'2026-10-15T18:00:38.685Z',status:'confirmed',items:[]};
const candidate={customerAccountId:'8d71e1b6-bca9-4a66-9f2c-f47e8f59a51c',email:identity.email,retailer:'PKC',managedAccountId:'pool-pkc',managedAssignmentId:'linked-after-checkout',assignment:{active:true,createdAt:'2026-10-15T19:00:00Z'}};
test('owner-confirmed backfill repairs the exact login/date/retailer while retaining assignment boundaries',()=>{
  assert.equal(checkoutAssignmentContains(candidate.assignment,order.checkoutAt),false);
  const attribution=resolveOwnerVerifiedBackfill(order,identity,[candidate]);
  assert.equal(attribution.customerAccountId,candidate.customerAccountId);
  assert.match(attribution.ownerBackfillApproval,/owner-confirmed/);
  const records=[{...order,customerAccountId:null}];
  reconcileWebhookCheckout(records,order,attribution);
  assert.equal(records.length,1);assert.equal(records[0].customerAccountId,candidate.customerAccountId);
  reconcileWebhookCheckout(records,{...order,status:'cancelled',statusUpdatedAt:'2026-10-15T20:00:00Z'});
  assert.equal(records[0].status,'cancelled');
});
test('owner correction never broadens to another date, login, retailer, owner, or an unlinked account',()=>{
  for(const changed of [{...order,retailer:'Walmart'},{...order,checkoutAt:'2026-10-14T18:00:00Z'},{...order,orderNumber:''}])
    assert.equal(resolveOwnerVerifiedBackfill(changed,identity,[candidate]),null);
  assert.equal(resolveOwnerVerifiedBackfill(order,{email:'other@example.com'},[candidate]),null);
  assert.equal(resolveOwnerVerifiedBackfill(order,identity,[]),null);
  assert.equal(resolveOwnerVerifiedBackfill(order,identity,[candidate,{...candidate,customerAccountId:'other'}]),null);
  assert.equal(resolveOwnerVerifiedBackfill(order,identity,[{...candidate,assignment:{active:false,endedAt:'2026-10-15T19:00:00Z'}}]),null);
});
