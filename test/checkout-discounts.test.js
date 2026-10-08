import test from "node:test";
import assert from "node:assert/strict";
import { membershipDiscountOptions, activeSitewideDiscount } from "../checkout-discounts.js";

test("checkout applies an eligible admin code and rejects ineligible codes", () => {
  const codes = [{ code: "SAVE20", active: true, tier: 1, stripePromotionCodeId: "promo_test", expiresAt: "2030-01-01" }];
  assert.deepEqual(membershipDiscountOptions(codes, " save20 ", 1), { discounts: [{ promotion_code: "promo_test" }] });
  assert.deepEqual(membershipDiscountOptions(codes, "", 1), { allow_promotion_codes: true });
  assert.throws(() => membershipDiscountOptions(codes, "SAVE20", 2), /selected membership tier/);
  assert.throws(() => membershipDiscountOptions(codes, "UNKNOWN", 1), /invalid/);
  assert.throws(() => membershipDiscountOptions([{ ...codes[0], active: false }], "SAVE20", 1), /inactive/);
  assert.throws(() => membershipDiscountOptions(codes, "SAVE20", 1, Date.parse("2031-01-01")), /expired/);
  assert.deepEqual(membershipDiscountOptions([{ ...codes[0], tier: "all" }], "SAVE20", 2), { discounts: [{ promotion_code: "promo_test" }] });
});

test("sitewide sale applies automatically and private coupons require the assigned account", () => {
  const sales = [20, 30].map(percent => ({ code: `SALE${percent}`, percent, sitewide: true, active: true, tier: "all", stripePromotionCodeId: `promo_${percent}` }));
  assert.equal(activeSitewideDiscount(sales, 1).percent, 30);
  assert.deepEqual(membershipDiscountOptions(sales, "", 1), { discounts: [{ promotion_code: "promo_30" }] });
  const privateCode = { code: "MIKE20", percent: 20, tier: "all", active: true, recipientEmail: "mike@example.test", stripeCouponId: "coupon_private" };
  assert.equal(activeSitewideDiscount([privateCode], 1), null);
  assert.throws(() => membershipDiscountOptions([privateCode], "MIKE20", 1, Date.now(), "other@example.test"), /different user/);
  assert.deepEqual(membershipDiscountOptions([privateCode], "MIKE20", 1, Date.now(), "MIKE@example.test"), { discounts: [{ coupon: "coupon_private" }] });
});

test("limited codes stop at their redemption limit and public sales disappear when exhausted", () => {
  const sale = {
    code: "LIMITED", sitewide: true, active: true, tier: 1,
    stripeCouponId: "coupon_limited", stripePromotionCodeId: "promo_limited",
    maxUses: 2, redemptions: 2, exhausted: true
  };
  assert.equal(activeSitewideDiscount([sale], 1), null);
  assert.throws(() => membershipDiscountOptions([sale], "LIMITED", 1), /maximum number of uses/);
  const unknown = { ...sale, exhausted: false, usageUnavailable: true };
  assert.equal(activeSitewideDiscount([unknown], 1), null);
  assert.throws(() => membershipDiscountOptions([unknown], "LIMITED", 1), /could not be verified/);
  assert.deepEqual(membershipDiscountOptions([{ ...sale, exhausted: false, redemptions: 1 }], "LIMITED", 1),
    { discounts: [{ promotion_code: "promo_limited" }] });
});
