import test from "node:test";
import assert from "node:assert/strict";
import { safeAddressVariants, defaultJigVariants } from "../address-jigs.js";

test("Drive can be abbreviated without changing delivery details", () => {
  const original = { address: "8275 Oceanus drive", address2: "", city: "boca raton", state: "Florida", zip: "33496", country: "US" };
  const variants = safeAddressVariants(original);
  assert.ok(variants.some(item => item.address === "8275 Oceanus DR"));
  for (const item of variants) {
    assert.match(item.address, /^8275 Oceanus /);
    for (const field of ["city", "state", "zip", "country", "address2"]) assert.equal(item[field], original[field]);
  }
  assert.equal(original.address, "8275 Oceanus drive");
});

test("direction, avenue and suite variants form combinations while unit A2 stays fixed", () => {
  const original = { address: "3350 NW 2ND AVE", address2: "Ste A2", city: "Boca raton", state: "FL", zip: "33431", country: "US" };
  const variants = safeAddressVariants(original);
  for (const [street, unit] of [
    ["3350 NW 2ND AVE", "SUITE A2"], ["3350 NORTHWEST 2ND AVE", "SUITE A2"],
    ["3350 NW 2ND AVENUE", "SUITE A2"], ["3350 NORTHWEST 2ND AVENUE", "SUITE A2"],
    ["3350 NORTHWEST 2ND AVE", "Ste A2"]
  ]) assert.ok(variants.some(item => item.address === street && item.address2 === unit), `${street}, ${unit}`);
  for (const item of variants) {
    assert.match(item.address, /^3350 /);
    assert.match(item.address2, /^(?:(?:STE|SUITE|APT|APARTMENT|UNIT) |#)A2$/i);
    for (const field of ["city", "state", "zip", "country"]) assert.equal(item[field], original[field]);
  }
});

test("numbered streets and unit labels vary, but four defaults and the actual unit remain fixed", () => {
  const original = { address: "3350 NW 2ND AVE", address2: "Ste A2", city: "Boca raton", state: "FL", zip: "33431", country: "US" };
  const variants = safeAddressVariants(original);
  for (const street of ["3350 NW 2 AVE", "3350 NW two AVE", "3350 NW second AVE"]) assert.ok(variants.some(item => item.address === street), street);
  for (const unit of ["APT A2", "APARTMENT A2", "UNIT A2", "#A2"]) assert.ok(variants.some(item => item.address2 === unit), unit);
  assert.equal(defaultJigVariants(original).length, 4);
  assert.ok(defaultJigVariants(original).every(item => item.address2.endsWith("A2")));
});

test("an inline suite preserves the unit while allowing the street suffix to vary", () => {
  const variants = safeAddressVariants({ address: "3350 NW 2ND AVE, SUITE A2", city: "Boca raton", state: "FL", zip: "33431", country: "US" });
  assert.ok(variants.some(item => item.address === "3350 NORTHWEST 2ND AVENUE" && item.address2 === "STE A2"));
  assert.ok(variants.every(item => /A2/.test(`${item.address} ${item.address2}`)));
});
