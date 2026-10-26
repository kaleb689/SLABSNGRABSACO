import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { communityProductKey, communityProductName, consolidateCommunityProducts } from "../community-product-identity.js";

test("SKU-prefixed Lapras screenshot titles combine with the plain title and display without the code", () => {
  const withCode="(10-10465-169) Pokémon TCG: 30th Celebration Mini Tin – Lapras (Day)";
  const plain="Pokemon TCG: 30th Celebration Mini Tin – Lapras (Day)";
  assert.equal(communityProductKey(withCode),communityProductKey(plain));
  const records=[{items:[{name:withCode,quantity:5}]},{items:[{name:plain,quantity:2}]}];
  const before=structuredClone(records);
  const products=consolidateCommunityProducts(records);
  assert.equal(products.length,1);assert.equal(products[0].quantity,7);
  assert.doesNotMatch(products[0].name,/10-10465-169/);
  assert.deepEqual(records,before,"display grouping leaves saved orders unchanged");
});

test("code-prefix cleanup preserves real editions, pack counts and character designs", () => {
  for(const title of ["(151) Pokemon TCG Collection","(3-Pack) Pokemon TCG Blister","(2026-Edition) Pokemon TCG Box"])
    assert.equal(communityProductName(title),title);
  assert.equal(communityProductName("(SKU: ABC-123) Pokemon TCG Box"),"Pokemon TCG Box");
  assert.equal(communityProductName("(123456789) Pokemon TCG Box"),"Pokemon TCG Box");
  assert.notEqual(communityProductKey("(10-10465-169) Pokemon TCG: 30th Celebration Mini Tin – Lapras (Day)"),
    communityProductKey("Pokemon TCG: 30th Celebration Mini Tin – Pikachu (Night)"));
  assert.equal(communityProductKey("(10-10465-169) Pokemon TCG: 30th Celebration Mini Tin"),
    communityProductKey("Pokemon TCG: 30th Celebration Mini Tin – Lapras (Day)"));
});

test("equivalent titles from different retailers normalize to one identity", () => {
  const names=["Target - Pokémon TCG: Delta Reign Elite Trainer Box",
    "Pokemon Trading Card Game - Delta Reign ETB | Walmart",
    "PKC: Pokemon TCG Delta Reign Elite Trainer Box"];
  assert.equal(new Set(names.map(communityProductKey)).size,1);
  assert.equal(communityProductKey("Pokémon TCG: Mega Evolution Phantasmal Flames UPC"),
    communityProductKey("Pokemon TCG - Mega Evolution Phantasmal Flames Ultra Premium Collection"));
  assert.equal(communityProductKey("Pokemon TCG: Pikachu 3pk"),
    communityProductKey("Pokémon TCG Pikachu 3-Pack"));
});

test("different types, editions, exclusive products, pack counts and tin designs stay separate", () => {
  const names=["Pokemon TCG: Delta Reign Elite Trainer Box",
    "Pokemon TCG: Delta Reign Booster Bundle",
    "Pokemon TCG: Delta Reign Booster Box",
    "Pokemon TCG: Delta Reign Pokemon Center Exclusive Elite Trainer Box",
    "Pokemon Center Exclusive Delta Reign Elite Trainer Box",
    "Pokemon TCG: Delta Reign 6 Pack",
    "Pokemon TCG: Delta Reign 3 Pack"];
  assert.equal(new Set(names.map(communityProductKey)).size,names.length);
  assert.notEqual(communityProductKey("Pokemon TCG: 30th Celebration Mini Tin Mew (Day)"),
    communityProductKey("Pokemon TCG: 30th Celebration Mini Tin Pikachu (Day)"));
  assert.notEqual(communityProductKey("Pokemon TCG: 30th Celebration Mini Tin Pikachu (Day)"),
    communityProductKey("Pokemon TCG: 30th Celebration Mini Tin Pikachu (Night)"));
});

test("only known mini-tin SKUs are allowed to clarify a generic title", () => {
  const generic="Pokemon TCG: 30th Celebration Mini Tin";
  assert.equal(communityProductKey(generic,"10-10465-166"),
    communityProductKey("Pokemon TCG: 30th Celebration Mini Tin Mew (Day)"));
  assert.notEqual(communityProductKey(generic,"10-10465-167"),communityProductKey(generic,"10-10465-172"));
  assert.equal(communityProductKey(generic,"NOT-A-MATCH"),communityProductKey(generic));
  assert.notEqual(communityProductKey("Pokemon TCG: 30th Celebration Mini Tin Mew (Day)","10-10465-167"),
    communityProductKey(generic,"10-10465-167"));
});

test("un-cancelled review holds contribute to one cross-retailer product quantity", () => {
  const records=[
    {retailer:"Target",status:"confirmed",checkoutAt:"2026-10-15T11:00:00Z",items:[
      {name:"Pokémon TCG: Delta Reign ETB",quantity:3,imageUrl:"https://example.test/a.jpg"}]},
    {retailer:"Walmart",status:"review_hold",checkoutAt:"2026-10-15T12:00:00Z",items:[
      {name:"Pokemon Trading Card Game: Delta Reign Elite Trainer Box",quantity:2}]},
    {retailer:"PKC",status:"confirmed",checkoutAt:"2026-10-15T13:00:00Z",items:[
      {name:"Delta Reign Elite Trainer Box",quantity:1}]},
    {retailer:"Walmart",status:"cancelled",checkoutAt:"2026-10-15T14:00:00Z",items:[
      {name:"Delta Reign Elite Trainer Box",quantity:8}]},
    {retailer:"PKC",status:"confirmed",checkoutAt:"2026-10-15T15:00:00Z",items:[
      {name:"Delta Reign Booster Bundle",quantity:4}]}
  ];
  const products=consolidateCommunityProducts(records.filter(order=>order.status!=="cancelled"));
  assert.equal(products.length,2);
  assert.equal(products.find(x=>x.productKey===communityProductKey("Delta Reign ETB")).quantity,6);
  assert.equal(products.find(x=>x.productKey===communityProductKey("Delta Reign Booster Bundle")).quantity,4);
  assert.equal(products.find(x=>x.quantity===6).imageUrl,"https://example.test/a.jpg");
  assert.doesNotMatch(JSON.stringify(products),/account|customer|orderNumber/i);
});

test("public and Admin reports use the shared server-generated product key", () => {
  const server=readFileSync(new URL("../server.js",import.meta.url),"utf8");
  const publicRoute=server.slice(server.indexOf('"/api/public/success"'),server.indexOf("async function saveSuccessCheckouts("));
  const adminRoute=server.slice(server.indexOf('app.get("/api/admin/success-overview"'),server.indexOf('app.get("/api/admin/checkout-paid-verification"'));
  const mobile=readFileSync(new URL("../public/admin-mobile.js",import.meta.url),"utf8");
  const full=readFileSync(new URL("../public/admin-success.js",import.meta.url),"utf8");
  assert.match(publicRoute,/consolidateCommunityProducts\(confirmed/);
  assert.match(publicRoute,/communityEligibleOrders\(records\)/);
  assert.match(adminRoute,/communityEligibleOrders\(allRecords\)/);
  assert.equal((adminRoute.match(/productKey: communityProductKey\(item\.name, item\.sku\)/g)||[]).length,2);
  assert.match(mobile,/const key=String\(item\.productKey\|\|name\.toLowerCase\(\)\)/);
  assert.doesNotMatch(mobile,/retailer\.toLowerCase\(\)\+"\|"\+name\.toLowerCase\(\)/);
  assert.match(full,/item\?\.productKey \|\| name\.toLowerCase\(\)/);
});
