import test from "node:test";
import assert from "node:assert/strict";
import {
  APPROVED_OG_CUSTOMER_IDS, OG_DISCOUNT_COUPON_ID,
  approvedOgAccountIds, ogDiscountAction, reconcileApprovedOgMembers
} from "../og-member-grants.js";

test("approved OG list contains six unique customers and the early-member exception", () => {
  assert.equal(APPROVED_OG_CUSTOMER_IDS.length, 6);
  assert.equal(new Set(APPROVED_OG_CUSTOMER_IDS).size, 6);
  assert.ok(APPROVED_OG_CUSTOMER_IDS.includes("cus_VInR6yyvYtuvuA"));
});

test("accounts match Stripe customer IDs, subscription IDs, or verified subscription metadata", () => {
  const subs = new Map([
    ["cus_VInR6yyvYtuvuA", [{ id: "sub_mike", metadata: {} }]],
    ["cus_VP8a1d0VupEuZ8", [{ id: "sub_david", metadata: { customer_account_id: "david" } }]]
  ]);
  const result = approvedOgAccountIds([
    { customerAccountId: "mike", stripeCustomerId: "cus_VInR6yyvYtuvuA" }
  ], subs);
  assert.deepEqual([...result.accountIds].sort(), ["david", "mike"]);
});

test("never stack discounts, and do not discount canceled subscriptions", () => {
  assert.equal(ogDiscountAction({status:"active", discounts:[]}), "apply_og_10");
  assert.equal(ogDiscountAction({status:"trialing", discounts:[]}), "apply_og_10");
  assert.equal(ogDiscountAction({status:"active", discounts:["di_thanksgiving"]}), "preserve_existing_discount");
  assert.equal(ogDiscountAction({status:"canceled", discounts:[]}), "inactive");
});

test("reconciliation grants six OG flags, forever coupon, and idempotent subscription discounts", async () => {
  const customers = APPROVED_OG_CUSTOMER_IDS.map(id => ({id, metadata:{}}));
  const subscriptions = new Map(customers.map(({id}, index) =>
    [id, [{ id:"sub_" + index, status:index===2?"canceled":"active", customer:id,
      metadata:index===0?{}:{customer_account_id:"account_" + index}, discounts:index===1?["di_existing"]:[] }]]
  ));
  const accounts = customers.map((customer,index)=>({id:"account_" + index, email:"member" + index + "@example.test"}));
  const paid = customers.map((customer,index)=>({customerAccountId:"account_" + index,
    stripeCustomerId:customer.id, stripeSubscriptionId:"sub_" + index, ogMember:false}));
  const subUpdates=[], customerUpdates=[], createdCoupons=[];
  const stripe = {
    subscriptions: {
      list: async ({customer}) => ({has_more:false, data:subscriptions.get(customer)}),
      update: async (id, options) => {subUpdates.push({id,options});
        for (const items of subscriptions.values()) for (const sub of items) if(sub.id===id)sub.discounts=["di_og"]; }
    },
    customers: {
      retrieve: async id=>customers.find(c=>c.id===id),
      update: async (id,opts)=>{customerUpdates.push({id,opts});Object.assign(customers.find(c=>c.id===id).metadata,opts.metadata);}
    },
    coupons: {
      retrieve: async id=>{if(!createdCoupons.length)throw Object.assign(new Error("Missing"),{code:"resource_missing"});
        return createdCoupons[0];},
      create: async x=>{createdCoupons.push(x);return x;}
    }
  };
  const deps={stripe, loadAccounts:async()=>accounts, saveAccounts:async()=>{},
    loadPaid:async()=>paid, savePaid:async()=>{}, log:{error(){}}};
  const first=await reconcileApprovedOgMembers(deps);
  assert.equal(first.approvedCustomers,6);
  assert.equal(first.linkedAccounts,6);
  assert.equal(first.errors.length,0);
  assert.equal(first.discounted,4);
  assert.equal(first.preserved,1);
  assert.equal(first.inactive,1);
  assert.equal(first.accountChanges,6);
  assert.equal(first.recordChanges,6);
  assert.equal(createdCoupons[0].id,OG_DISCOUNT_COUPON_ID);
  assert.equal(createdCoupons[0].duration,"forever");
  for(const account of accounts)assert.ok(account.ogMemberGrantedAt);
  assert.equal(subUpdates.length,4);
  for(const call of subUpdates)assert.equal(call.options.proration_behavior,"none");
  const second=await reconcileApprovedOgMembers(deps);
  assert.equal(second.accountChanges,0);
  assert.equal(second.recordChanges,0);
  assert.equal(second.discounted,0);
  assert.equal(createdCoupons.length,1);
  assert.equal(subUpdates.length,4);
  assert.equal(customerUpdates.length,6);
});
