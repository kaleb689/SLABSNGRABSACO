import test from "node:test";
import assert from "node:assert/strict";
import {
  sourcePriceIsLineTotal, retailerFromTrustedSourceImage,
  SLABSNGRABSTC_SUCCESS_CHANNEL_ID
} from "../discord-source-price-field-policy.js";

test("the original Success channel's unqualified Price is the full line price", () => {
  assert.equal(sourcePriceIsLineTotal({
    channelId:SLABSNGRABSTC_SUCCESS_CHANNEL_ID,
    fieldLabel:"Price",quantity:"2"
  }), true);
});

test("explicit Unit Price must still be multiplied by quantity", () => {
  assert.equal(sourcePriceIsLineTotal({
    channelId:SLABSNGRABSTC_SUCCESS_CHANNEL_ID,
    fieldLabel:"Unit Price",quantity:"2"
  }), false);
});

test("untrusted channels cannot change the meaning of Price", () => {
  assert.equal(sourcePriceIsLineTotal({
    channelId:"1551090141693485156",
    fieldLabel:"Price",quantity:"2"
  }), false);
});

test("missing and unsafe quantities are not reinterpreted", () => {
  for (const quantity of ["",null,"2x","0","1000",Infinity]) {
    assert.equal(sourcePriceIsLineTotal({
      channelId:SLABSNGRABSTC_SUCCESS_CHANNEL_ID,
      fieldLabel:"Price",quantity
    }),false);
  }
});

test("a Target product thumbnail resolves a missing retailer in the trusted Success channel", () => {
  assert.equal(retailerFromTrustedSourceImage({
    channelId:SLABSNGRABSTC_SUCCESS_CHANNEL_ID,
    retailerLabel:"",
    imageUrl:"https://target.scene7.com/is/image/Target/GUEST_example"
  }),"Target");
});

test("an explicitly labelled retailer cannot be overwritten", () => {
  assert.equal(retailerFromTrustedSourceImage({
    channelId:SLABSNGRABSTC_SUCCESS_CHANNEL_ID,
    retailerLabel:"PKC",
    imageUrl:"https://target.scene7.com/is/image/Target/GUEST_example"
  }),"PKC");
});

test("an unrelated thumbnail, HTTP URL, or unrelated channel is not trusted", () => {
  for (const [channelId,imageUrl] of [
    [SLABSNGRABSTC_SUCCESS_CHANNEL_ID,"https://other.com/photo.jpg"],
    [SLABSNGRABSTC_SUCCESS_CHANNEL_ID,"http://target.scene7.com/photo.jpg"],
    ["1551090141693485156","https://target.scene7.com/photo.jpg"]
  ]) {
    assert.equal(retailerFromTrustedSourceImage({channelId,retailerLabel:"",imageUrl}),"");
  }
});
