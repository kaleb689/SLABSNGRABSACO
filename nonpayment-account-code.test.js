import test from "node:test";
import assert from "node:assert/strict";
import {stripPaymentVerifiers} from "./payment-verification-policy.js";

test("non-payment ACO account access code survives payment protection", () => {
  const encryptedProfileInput = {
    acoEmail: "example@site.test",
    accountAccessCode: "ACCOUNT-ACCESS-9172",
    securityCode: "999",
    cvv: "123",
    cvc: "456",
    accountSecurityCode: "789"
  };
  const safe = stripPaymentVerifiers(encryptedProfileInput);
  assert.equal(safe.accountAccessCode, "ACCOUNT-ACCESS-9172");
  assert.equal(safe.securityCode, "");
  assert.equal(safe.cvv, "");
  assert.equal(safe.cvc, "");
  assert.equal(safe.accountSecurityCode, "");
});

test("cleanup preserves separately named nonpayment access code", () => {
  const stored = {profiles:[{accountAccessCode:"ACCESS-42",card:{cvv:"777",securityCode:"888"}}]};
  const result = stripPaymentVerifiers(stored);
  assert.equal(result.profiles[0].accountAccessCode,"ACCESS-42");
  assert.equal(result.profiles[0].card.cvv,"");
  assert.equal(result.profiles[0].card.securityCode,"");
});
