import test from "node:test";
import assert from "node:assert/strict";
import {discordVerifiedFullCharge} from "../discord-checkout-tax-inclusive-policy.js";
import {checkoutPaidAmount} from "../checkout-price-policy.js";

function message(fields,description=""){
  return {content:"",embeds:[{title:"Checkout Success",description,
    fields:fields.map(([name,value])=>({name,value}))}]};
}
test("explicit order total includes declared sales tax, shipping and discounts",()=>{
  const result=discordVerifiedFullCharge(message([
    ["Items Subtotal","$100.00"],["Sales Tax","$6.70"],
    ["Shipping","$4.00"],["Discount","$0.00"],["Total Paid","$110.70"]
  ]));
  assert.equal(result.paidCents,11070);
  assert.equal(result.taxCents,670);
  assert.equal(result.basis,"order_total");
});
test("complete explicit breakdown may verify total when final total label omitted",()=>{
  const result=discordVerifiedFullCharge(message([
    ["Subtotal","100.00"],["Tax","7.00"],
    ["Shipping","Free"],["Promo Discount","2.00"]
  ]));
  assert.equal(result.paidCents,10500);
  assert.equal(result.taxCents,700);
  assert.equal(result.shippingCents,0);
  assert.equal(result.discountCents,200);
  assert.equal(result.basis,"discord_verified_breakdown");
  assert.equal(checkoutPaidAmount({
    orderTotal:result.paidCents/100,orderTotalBasis:result.basis
  }),105);
});
test("only item prices without tax are NOT a paid checkout total",()=>{
  const result=discordVerifiedFullCharge(message([
    ["Price","49.98"],["Quantity","2"]
  ]));
  assert.equal(result.paidCents,null);
  assert.equal(result.reason,"incomplete_paid_amount_including_tax");
});
test("missing tax, shipping or explicit discounts keep full charge pending",()=>{
  for(const omitted of ["Tax","Shipping","Discount"]){
    const fields=[
      ["Subtotal","100.00"],["Tax","7.00"],["Shipping","0.00"],["Discount","0.00"]
    ].filter(([k])=>k!==omitted);
    const result=discordVerifiedFullCharge(message(fields));
    assert.equal(result.paidCents,null,omitted);
  }
});
test("a stated final order total is sufficient, even when individual taxes are not displayed",()=>{
  const result=discordVerifiedFullCharge(message([["Order Total","$54.35"]]));
  assert.equal(result.paidCents,5435);
  assert.equal(result.basis,"order_total");
  assert.equal(result.taxCents,null);
});
test("conflict between stated paid amount and tax-inclusive breakdown blocks payment",()=>{
  const result=discordVerifiedFullCharge(message([
    ["Subtotal","100.00"],["Sales Tax","7.00"],["Shipping","0.00"],
    ["Discount","0.00"],["Total Paid","100.00"]
  ]));
  assert.equal(result.paidCents,null);
  assert.equal(result.reason,"stated_total_does_not_match_components");
});
test("conflicting tax fields cannot inflate or understate spending",()=>{
  const result=discordVerifiedFullCharge(message([
    ["Subtotal","100.00"],["Sales Tax","7.00"],["Tax","8.00"],
    ["Shipping","0.00"],["Discount","0.00"]
  ]));
  assert.equal(result.paidCents,null);
  assert.equal(result.reason,"conflicting_or_invalid_breakdown");
});
test("negative discount notation subtracts the positive discount amount",()=>{
  const result=discordVerifiedFullCharge(message([
    ["Subtotal","50.00"],["Sales Tax","3.50"],["Shipping","Free"],
    ["Discount Applied","-$5.00"]
  ]));
  assert.equal(result.paidCents,4850);
  assert.equal(result.discountCents,500);
});
test("tax and shipping text-line fields can be verified without customer data",()=>{
  const result=discordVerifiedFullCharge(message([],
    "**Subtotal**: $200.00\n**Sales Tax**: $13.00\n**Shipping**: $0.00\n**Discount**: $0.00"));
  assert.equal(result.paidCents,21300);
  assert.equal(result.taxCents,1300);
});
test("zero sales tax and free shipping are legitimate only when explicitly shown",()=>{
  const result=discordVerifiedFullCharge(message([
    ["Subtotal","25.00"],["Tax","0.00"],["Shipping","Free"],
    ["Discount","None"]
  ]));
  assert.equal(result.paidCents,2500);
  assert.equal(result.taxCents,0);
});
test("cannot reinterpret a 'Subtotal' as a final paid total",()=>{
  const result=discordVerifiedFullCharge(message([["Subtotal","3044.15"]]));
  assert.equal(result.paidCents,null);
});
