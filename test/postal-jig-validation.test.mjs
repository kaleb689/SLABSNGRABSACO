import test from "node:test";
import assert from "node:assert/strict";
import {lookupPostalJigOptions, selectedPostalJigs, uspsAddressLookupConfigured} from "../postal-jig-validation.js";

const main = {address:"450 Example Way", address2:"UNIT 4B", city:"Sampleton", state:"FL", zip:"33324", country:"US"};

test("USPS must be configured before offering postal variations", async () => {
  assert.equal(uspsAddressLookupConfigured({}), false);
  await assert.rejects(lookupPostalJigOptions(main,{env:{}}), /not configured/i);
});
test("ZIP+4 and alternate cities require an identical USPS delivery point", async () => {
  const requestedCities = [];
  const fakeFetch = async (url) => {
    const u = new URL(url);
    let payload;
    if (u.pathname.includes("/oauth2/")) payload={access_token:"mock",expires_in:3600};
    else if (u.pathname.includes("/city-state")) payload={city:"Another City",state:"FL"};
    else if (u.hostname==="api.zippopotam.us") payload={places:[
      {"place name":"Another City","state abbreviation":"FL"},
      {"place name":"Wrong City","state abbreviation":"FL"}
    ]};
    else if (u.pathname.endsWith("/address")) {
      const city=u.searchParams.get("city");
      requestedCities.push(city);
      payload={address:{
        streetAddress:city==="WRONG CITY"?"WRONG STREET":"450 EXAMPLE WAY",
        secondaryAddress:"UNIT 4B",city:"ANOTHER CITY",state:"FL",ZIPCode:"33324",ZIPPlus4:"1234"
      },additionalInfo:{DPVConfirmation:"Y"}};
    }
    return {ok:true,json:async()=>payload};
  };
  const settings={env:{USPS_CLIENT_ID:"unit-test",USPS_CLIENT_SECRET:"unit-test"},fetchFn:fakeFetch};
  const first=await lookupPostalJigOptions(main,settings);
  assert.equal(first.verified,true);
  assert.equal(first.options.length,2);
  assert.deepEqual(first.options.map(item=>item.id),["zip.four","city.alternate:ANOTHER CITY"]);
  assert.equal(first.options[0].address.zip,"33324-1234");
  assert.equal(first.options[1].address.city,"ANOTHER CITY");
  assert.equal(first.options[1].address.address,main.address);
  assert.equal(first.options[1].address.address2,main.address2);
  assert.equal((await selectedPostalJigs(main,["city.alternate"],settings)).length,1);
  assert.equal(requestedCities.length,3,"Postal results are cached for repeated picker requests");
});
test("never invent postal variants for non-postal selections or invalid ZIP", async () => {
  assert.deepEqual(await selectedPostalJigs(main,["direction.short"],{env:{}}),[]);
  await assert.rejects(lookupPostalJigOptions({...main,zip:"invalid"},{env:{USPS_CLIENT_ID:"test",USPS_CLIENT_SECRET:"test"}}),/valid ZIP/i);
});
