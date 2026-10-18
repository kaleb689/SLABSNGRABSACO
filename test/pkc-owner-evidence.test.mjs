import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {applyOwnerVerifiedOrderEvidence,ownerVerifiedOrderEvidence} from "../checkout-owner-order-evidence.js";
import {checkoutPaidAmount,checkoutOrderValue} from "../checkout-price-policy.js";

const id="discord:1532179373292257290:1580000000000007777";
const number="SYNTHETIC-PKC-ORDER-2026";
const digest=value=>createHash("sha256").update(value).digest("hex");
const items=["Mew (Day)","Lapras (Day)","Pikachu (Night)","Pikachu (Day)",
  "Espeon (Day)","Greninja (Night)","Moltres (Day)","Zapdos (Night)",
  "Mewtwo (Night)","Umbreon (Night)"].map((name,i)=>({
  name:"Pokémon TCG: 30th Celebration Mini Tin – "+name,
  sku:"10-TEST-"+(100+i),quantity:1
}));
const entries=[{ref:"owner-verified-synthetic-example",orderHash:digest("pkc:"+number.toLowerCase()),
  after:"2026-10-13",before:"2026-10-18",total:106.40,items}];
const make=()=>({id,retailer:"PKC",orderNumber:number,checkoutAt:"2026-10-15T17:30:00Z",
  status:"confirmed",customerAccountId:"member-test",orderTotal:42.56,
  orderTotalBasis:"item_subtotal",items:items.slice(0,4).map(i=>({...i,price:10.64})),itemCount:4});

test("owner screenshot evidence repairs exact 4-of-10 PKC webhook and sets actual $106.40",()=>{
  const rows=[make()];
  const result=applyOwnerVerifiedOrderEvidence(rows,entries);
  assert.equal(result.corrected,1);
  assert.equal(rows[0].items.length,10);
  assert.equal(rows[0].itemCount,10);
  assert.equal(rows[0].customerAccountId,"member-test");
  assert.equal(rows[0].orderTotalBasis,"retailer_receipt");
  assert.equal(checkoutPaidAmount(rows[0]),106.40);
  assert.equal(checkoutOrderValue(rows[0]).amount,106.40);
  assert.equal(rows[0].items[0].price,10.64);
  assert.equal(result.changedCustomerIds[0],"member-test");
  assert.equal(applyOwnerVerifiedOrderEvidence(rows,entries).changed,false);
});

test("evidence cannot create, reassign or alter cancelled, ambiguous or unrelated orders",()=>{
  const cases=[
    {...make(),id:"mailbox-only"},
    {...make(),status:"cancelled",cancelledAt:"2026-10-15T18:00:00Z"},
    {...make(),orderNumber:"OTHER-PKC-ORDER"},
    {...make(),retailer:"Target"},
    {...make(),checkoutAt:"2026-10-21T17:30:00Z"},
    {...make(),items:[{name:"Another trading card item",quantity:1}]},
    {...make(),items:[{name:items[0].name,quantity:20}]}
  ];
  const originals=JSON.stringify(cases);
  assert.equal(applyOwnerVerifiedOrderEvidence(cases,entries).changed,false);
  assert.equal(JSON.stringify(cases),originals);
  assert.equal(ownerVerifiedOrderEvidence(make(),[]),null);
});

test("an already higher verified final total is never lowered",()=>{
  const record={...make(),items:items.map(x=>({...x,price:9.99})),itemCount:10,
    orderTotal:108.00,orderTotalBasis:"retailer_receipt"};
  const rows=[record];
  const result=applyOwnerVerifiedOrderEvidence(rows,entries);
  assert.equal(result.changed,false);
  assert.equal(rows[0].orderTotal,108);
});
