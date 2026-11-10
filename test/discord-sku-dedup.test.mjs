import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  uniqueSkuSelections, changeSkuItems, skuOwnerDetails, skuSelectionChanges,
  setGlobalSkuQuantity, skuSelectionView, skuAdminReviewPayload
} from "../discord-community.js";

const row = (channel, source, sku, retailer = "", name = "Product", quantity = 2) => ({
  key: channel + ":" + source + ":" + sku, sku, name, quantity,
  ...(retailer ? { retailer } : {})
});
const groupOf = item => {
  const channel = item.key.split(":")[0];
  if (channel === "target") return "Target";
  if (channel === "walmart") return "Walmart";
  if (channel === "pkc") return "PKC";
  return item.retailer ? item.retailer + " · Dropping Tonight" : "Dropping Tonight";
};

test("reselecting the same SKU in one retailer cannot add a second row", () => {
  const products = [{ sku: "1010892068", name: "Target Card Box" }];
  let items = changeSkuItems([], products, "post1", "target", 2);
  for (let i = 0; i < 5; i++) items = changeSkuItems(items, products, "post1", "target", 2);
  assert.equal(items.length, 1);
  items = changeSkuItems(items, products, "post2", "target", 2);
  assert.equal(items.length, 1);
  assert.equal(items[0].key, "target:post2:1010892068");
  assert.equal(skuOwnerDetails(items, groupOf).description.match(/1010892068/g)?.length, 1);
  items = changeSkuItems(items, products, "post1", "target", 0);
  assert.deepEqual(items, [], "removing the logical SKU must remove it even if selected in a newer post");
});

test("existing duplicated Target numbers are deduped while unique rows remain intact", () => {
  const old = [
    row("target","post1","1010892068","", "Old Box"),
    row("target","post2","1010892068","", "New Box"),
    row("target","post3","1010892068","", "Latest Box"),
    row("target","post3","1010892076","", "Other Box"),
    row("walmart","post4","1010892068","", "Different Retailer Product")
  ];
  const unique = uniqueSkuSelections(old, groupOf);
  assert.equal(unique.length, 3);
  assert.equal(unique.find(item=>item.key.includes("target") && item.sku==="1010892068").name, "Latest Box");
  assert.equal(unique.filter(item=>item.sku==="1010892068").length, 2, "different retailers may have the same numeric SKU");
  const embed=skuOwnerDetails(old, groupOf);
  assert.match(embed.description, /\*\*Target\*\* \(2\)/);
  assert.match(embed.description, /\*\*Walmart\*\* \(1\)/);
  assert.equal((embed.description.match(/1010892068/g)||[]).length, 2, "one per retailer");
});

test("cross-channel Target duplicate is removed using retailer tag and owner group", () => {
  const old = [
    row("target","post1","1012422107","","Target Box"),
    row("tonight","post2","1012422107","Target","Target Box Tonight"),
    row("tonight","post3","PKC-111","PKC","Pokemon Center Product")
  ];
  const unique = uniqueSkuSelections(old, groupOf);
  assert.equal(unique.length, 2);
  assert.equal(unique.find(x=>x.sku==="1012422107").key, "tonight:post2:1012422107");
  const changes = skuSelectionChanges(old, unique, groupOf);
  assert.deepEqual(changes, {added:[],removed:[]}, "cleanup must not pretend a selection was removed");
  const embed = skuOwnerDetails(old, groupOf);
  assert.equal((embed.description.match(/1012422107/g)||[]).length, 1);
});

test("deduplication is case-insensitive and preserves proper SKU identifiers", () => {
  const all = [
    row("pkc","post1","10-10465-166","","Old ETB"),
    row("pkc","post2","10-10465-166","","New ETB"),
    row("pkc","post3","10-10465-167","","Another ETB")
  ];
  const result=uniqueSkuSelections(all, groupOf);
  assert.deepEqual(result.map(r=>r.sku), ["10-10465-166","10-10465-167"]);
  assert.equal(setGlobalSkuQuantity(result,1).length,2);
});

test("legacy duplicate selections are not shown in customer or admin review", () => {
  const old=[
    row("target","post1","TCIN-1"),
    row("target","post2","TCIN-1"),
    row("target","post3","TCIN-2")
  ];
  assert.match(skuSelectionView(old).content,/Your selected SKUs \(2\)/);
  assert.match(skuAdminReviewPayload(old,"1234567890123456787").content,/2 total/);
});

test("startup repair makes a safety backup and patches existing messages without sending fresh alerts", () => {
  const source=readFileSync(new URL("../discord-community.js",import.meta.url),"utf8");
  assert.match(source,/async function repairExistingSkuDuplicates\(\)/);
  assert.match(source,/fs\.copyFile\(skuSelectionsFile, backup, fs\.constants\.COPYFILE_EXCL\)/);
  assert.match(source,/await writeSkuFile\(skuSelectionsFile, records\)/);
  assert.match(source,/payload\.allowed_mentions = \{ parse: \[\] \}/);
  assert.match(source,/record\.messageId, "PATCH", payload\)/);
  assert.match(source,/await repairExistingSkuDuplicates\(\)/);
});
