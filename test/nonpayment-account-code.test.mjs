import test from "node:test";
import assert from "node:assert/strict";
import { stripPaymentVerifiers } from "../payment-verification-policy.js";

test("non-payment ACO account code survives encrypted profile sanitation", () => {
  const profile = {
    accountAccessCode: "ACCESS-73921",
    securityCode: "123",
    card: { cvv: "456", cvc: "789", accountSecurityCode: "000" }
  };
  const stored = stripPaymentVerifiers(profile);
  assert.equal(stored.accountAccessCode, "ACCESS-73921");
  assert.equal(stored.securityCode, "");
  assert.equal(stored.card.cvv, "");
  assert.equal(stored.card.cvc, "");
  assert.equal(stored.card.accountSecurityCode, "");
});
