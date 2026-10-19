import test from "node:test";
import assert from "node:assert/strict";
import {createCustomerPaymentActions} from "../customer-payment-records.js";
import {savedDataRevision} from "../saved-data-revisions.js";

process.env.SUBMISSION_ENCRYPTION_KEY="test-only-secret-not-a-real-key";
const clone = value => structuredClone(value);
const card = (number, holder = "Saved Holder", extra = {}) => ({
  id: "card-1", cardLabel: "Personal", cardholder: holder,
  acoCardNumber: number, expMonth: "08", expYear: "2030", ...extra
});
const fingerprint = method => savedDataRevision("payment", method);
const key = item => JSON.stringify({
  number: String(item?.acoCardNumber || item?.cardNumber || "").replace(/\D/g, ""),
  expMonth: String(item?.expMonth || "").slice(0,2),
  expYear: String(item?.expYear || "").slice(0,4),
  cardholder: String(item?.cardholder || "").toUpperCase()
});
function fixture() {
  const vaults = {
    customerA: {paymentMethods:[card("4242424242424242")]},
    customerB: {paymentMethods:[card("5555555555554444","Other Customer")]}
  };
  let profiles = [{
    id:"profile-a",customerAccountId:"customerA",
    selectedPaymentId:"card-1",
    customerProfile:{firstName:"Jigged",lastName:"Person"},
    customerSecrets:card("4242424242424242"),updatedAt:"old"
  },{
    id:"profile-b",customerAccountId:"customerB",selectedPaymentId:"card-1",
    customerProfile:{firstName:"Other",lastName:"Person"},
    customerSecrets:card("5555555555554444"),updatedAt:"old"
  }];
  let free = [{
    id:"free-a", customerAccountId:"customerA",selectedPaymentId:"card-1",
    customerProfile:{firstName:"Gifted",lastName:"Customer"},
    customerSecrets:card("4242424242424242")
  }];
  let rentals = [{
    id:"rental-b",customerAccountId:"customerB",selectedPaymentId:"card-1",
    customerProfile:{firstName:"Other",lastName:"Customer"},
    customerSecrets:card("5555555555554444")
  }];
  const orders=[
    {id:"order-a",customerAccountId:"customerA"},
    {id:"order-b",customerAccountId:"customerB"}
  ];
  const packages={
    "order-a": {...card("4000000000000002"), id:undefined, acoCardNumber:undefined, cardNumber:"4000000000000002"},
    "order-b": card("4000000000000003")
  };
  const sanitize=(body, existing={})=>({
    id:existing.id||"new-card",
    cardLabel:body.cardLabel||existing.cardLabel||"Saved",
    cardholder:body.cardholder||existing.cardholder||"",
    acoCardNumber:String(body.acoCardNumber||existing.acoCardNumber||"").replace(/\D/g,""),
    expMonth:body.expMonth||existing.expMonth||"",
    expYear:body.expYear||existing.expYear||"",
    createdAt:existing.createdAt||"2026-01-01T00:00:00Z",
    updatedAt:"2026-10-19T00:00:00Z"
  });
  const valid=c=>Boolean(c.cardLabel&&c.cardholder&&/^\d{12,19}$/.test(c.acoCardNumber)&&/^(0[1-9]|1[0-2])$/.test(c.expMonth)&&/^\d{4}$/.test(c.expYear));
  const actions=createCustomerPaymentActions({
    getCustomerVault:async id=>clone(vaults[id]||{paymentMethods:[]}),
    saveCustomerVault:async(id,v)=>{vaults[id]=clone(v)},
    getRetailerProfiles:async()=>clone(profiles),
    saveRetailerProfiles:async next=>{profiles=clone(next)},
    getFreeAssignments:async()=>clone(free),
    saveFreeAssignments:async next=>{free=clone(next)},
    getRentalAssignments:async()=>clone(rentals),
    saveRentalAssignments:async next=>{rentals=clone(next)},
    getPaidOrders:async()=>clone(orders),
    loadEncryptedPackage:async id=>clone(packages[id]||null),
    decryptJson:clone, encryptJson:clone,
    sanitizeSavedPaymentMethod:sanitize, validSavedPaymentMethod:valid,
    savedPaymentDedupeKey:key
  });
  return {actions,vaults,profiles:()=>profiles,free:()=>free,rentals:()=>rentals,packages};
}

test("saved card updates the owner's linked paid and gifted profiles, preserving jigged names",async()=>{
  const t=fixture();
  await t.actions.update({accountId:"customerA",id:"card-1",
    expectedRevision:fingerprint(t.vaults.customerA.paymentMethods[0]),
    body:{acoCardNumber:"4111111111111111",expYear:"2032"}});
  assert.equal(t.vaults.customerA.paymentMethods[0].acoCardNumber,"4111111111111111");
  assert.equal(t.profiles()[0].customerSecrets.acoCardNumber,"4111111111111111");
  assert.equal(t.profiles()[0].customerSecrets.cardholder,"Jigged Person");
  assert.equal(t.free()[0].customerSecrets.cardholder,"Gifted Customer");
  assert.equal(t.free()[0].customerSecrets.acoCardNumber,"4111111111111111");
  assert.equal(t.profiles()[1].customerSecrets.acoCardNumber,"5555555555554444");
  assert.equal(t.rentals()[0].customerSecrets.acoCardNumber,"5555555555554444");
  assert.ok(t.vaults.customerA.hiddenPaymentKeys.includes(key(card("4242424242424242"))));
});

test("deleting a saved card clears linked profiles without touching another customer",async()=>{
  const t=fixture();
  await t.actions.remove({accountId:"customerA",id:"card-1",
    expectedRevision:fingerprint(t.vaults.customerA.paymentMethods[0])});
  assert.equal(t.vaults.customerA.paymentMethods.length,0);
  assert.equal(t.profiles()[0].selectedPaymentId,null);
  assert.equal(t.profiles()[0].customerSecrets.acoCardNumber,"");
  assert.equal(t.free()[0].selectedPaymentId,null);
  assert.equal(t.vaults.customerB.paymentMethods.length,1);
  assert.equal(t.profiles()[1].selectedPaymentId,"card-1");
});

test("foreign, stale and missing revisions cannot edit or delete payment methods",async()=>{
  const t=fixture();
  await assert.rejects(t.actions.update({accountId:"customerA",id:"paid-profile-card:profile-b",
    expectedRevision:"irrelevant",body:{cardholder:"Wrong"}}),e=>e.status===404);
  await assert.rejects(t.actions.remove({accountId:"customerA",id:"paid-order-card:order-b",
    expectedRevision:"irrelevant"}),e=>e.status===404);
  await assert.rejects(t.actions.update({accountId:"customerA",id:"card-1",
    expectedRevision:"stale",body:{cardholder:"Changed"}}),e=>e.status===409);
  await assert.rejects(t.actions.remove({accountId:"customerA",id:"card-1"}),e=>e.status===428);
  assert.equal(t.vaults.customerA.paymentMethods[0].cardholder,"Saved Holder");
});

test("profile-sourced cards can be edited and deleted by the owner",async()=>{
  const t=fixture();
  const orig=t.profiles()[0].customerSecrets;
  await t.actions.update({accountId:"customerA",id:"paid-profile-card:profile-a",
    expectedRevision:fingerprint(orig),body:{cardholder:"Changed Cardholder",expYear:"2033"}});
  // JIGGED customer profiles keep their payment holder in sync with profile name.
  assert.equal(t.profiles()[0].customerSecrets.cardholder,"Jigged Person");
  assert.equal(t.profiles()[0].customerSecrets.expYear,"2033");
  const changed=t.profiles()[0].customerSecrets;
  await t.actions.remove({accountId:"customerA",id:"paid-profile-card:profile-a",
    expectedRevision:fingerprint(changed)});
  assert.equal(t.profiles()[0].customerSecrets.acoCardNumber,"");
  assert.equal(t.profiles()[1].customerSecrets.acoCardNumber,"5555555555554444");
});

test("historical checkout card edits preserve original order, support cardNumber-only legacy data",async()=>{
  const t=fixture();
  const original=clone(t.packages["order-a"]);
  const result=await t.actions.update({accountId:"customerA",id:"paid-order-card:order-a",
    expectedRevision:fingerprint(original),body:{expYear:"2035"}});
  assert.equal(result.source,"paid_order");
  assert.equal(t.vaults.customerA.paymentOverrides["paid-order-card:order-a"].payment.acoCardNumber,"4000000000000002");
  assert.equal(t.vaults.customerA.paymentOverrides["paid-order-card:order-a"].payment.expYear,"2035");
  assert.deepEqual(t.packages["order-a"],original);
  const fresh=t.vaults.customerA.paymentOverrides["paid-order-card:order-a"].payment;
  await t.actions.remove({accountId:"customerA",id:"paid-order-card:order-a",
    expectedRevision:fingerprint(fresh)});
  assert.equal(t.vaults.customerA.paymentOverrides["paid-order-card:order-a"].deleted,true);
  assert.deepEqual(t.packages["order-a"],original);
});

test("a previously copied card with no saved-card link also synchronizes within the same customer",async()=>{
  const t=fixture();
  t.profiles().push({
    id:"unlinked-a",customerAccountId:"customerA",
    customerProfile:{firstName:"Another",lastName:"Jig"},
    customerSecrets:card("4242424242424242"),updatedAt:"old"
  });
  await t.actions.update({accountId:"customerA",id:"card-1",
    expectedRevision:fingerprint(t.vaults.customerA.paymentMethods[0]),
    body:{acoCardNumber:"4000000000000010",expMonth:"10"}});
  const updated=t.profiles().find(x=>x.id==="unlinked-a");
  assert.equal(updated.customerSecrets.acoCardNumber,"4000000000000010");
  assert.equal(updated.customerSecrets.expMonth,"10");
  assert.equal(updated.customerSecrets.cardholder,"Another Jig");
  assert.equal(t.profiles().find(x=>x.id==="profile-b").customerSecrets.acoCardNumber,"5555555555554444");
});
