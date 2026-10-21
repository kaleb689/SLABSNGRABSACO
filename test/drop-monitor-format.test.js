import test from "node:test";
import assert from "node:assert/strict";
import { parseMonitorDropProducts, formattedDropPayloads, formattedDropName, isFormattedDropPost, FORMATTED_DROP_MARKER } from "../drop-monitor-format.js";
import { parseDropSkus } from "../discord-community.js";

const pasted = `Walmart Draws
Pokémon TCG: 30th Celebration Booster Bundle 2-Pack Bundle
Price
$79.94
Type
New Product
PID
21077661804
Time
Oct 21, 2:00pm - 3:00pm PDT
Cart Limit
1
Seller
Walmart.com
Links
Ebay | Ebay Sales | Report Bugs
Image

Monitors v2.0.0 | Poke Signals x Zephyr Monitors [00:22:55]•10/19/26, 8:22 PM

Walmart Draws
Pokemon TCG: 30th Celebration Knock Out Collection 4-Count Bundle
Price
$47.92
Type
New Product
PID
21036052088
Time
Oct 21, 2:00pm - 3:00pm PDT
Cart Limit
1
Seller
Walmart.com
Links
Ebay | Ebay Sales | Report Bugs
Image

Walmart Draws
Pokémon TCG: 30th Celebration Pokémon ex Box Bundle - Sylveon ex and Greninja ex
Price
$69.94
Type
New Product
PID
21009455186
Time
Oct 21, 2:00pm - 3:00pm PDT

Walmart Draws
Pokemon TCG Scarlet & Violet 10.5 Unova Poster Collection Box - 4 Packs
Price
$21.87
Type
New Product
PID
16517213276
Time
Oct 21, 2:00pm - 3:00pm PDT

Walmart Draws
Pokemon Trading Card Game Scarlet & Violet 10 Destined Rivals 3Pk Blister 2-Pack Bundle
Price
$39.97
Type
New Product
PID
21121422876
Time
Oct 21, 2:00pm - 3:00pm PDT

Walmart Draws
Pokemon TCG Scarlet & Violet 10.5 Unova Poster Collection Box - 4 Packs
Price
$21.87
Type
New Product
PID
16517213276
Time
Oct 21, 2:00pm - 3:00pm PDT`;

test("owner can paste raw monitoring paragraph: exact product name, price, PID as SKU, dedupe", () => {
  const items = parseMonitorDropProducts(pasted);
  assert.equal(items.length, 5);
  assert.deepEqual(items.map(x => [x.price, x.sku]), [
    ["79.94", "21077661804"], ["47.92", "21036052088"],
    ["69.94", "21009455186"], ["21.87", "16517213276"],
    ["39.97", "21121422876"]
  ]);
  assert.equal(items[0].name,"Pokémon TCG: 30th Celebration Booster Bundle 2-Pack Bundle");
  const [rendered] = formattedDropPayloads(items, "Walmart Drops");
  assert.match(rendered.content, /Walmart Draw/);
  assert.equal(rendered.embeds.length, 5);
  assert.equal(rendered.allowed_mentions.parse.length, 0);
  for(const embed of rendered.embeds) {
    assert.equal(embed.color, 0x38dce8);
    assert.equal(embed.footer.text, FORMATTED_DROP_MARKER);
    assert.match(embed.description, /^\\*\\*.+\\*\\*\\nPrice \\$\\d+\\.\\d{2}\\nSKU: \\d+/);
  }
  assert.deepEqual(parseDropSkus({content:rendered.content,embeds:rendered.embeds}).map(x => x.sku),items.map(x => x.sku));
});
test("formats monitor pastes for all retailer and shared drop channels", () => {
  const labels = ["Walmart Drops","Target Drops","PKC Drops","Costco Drops","Sam's Drops","Upcoming Drops","Dropping Tonight"];
  for(const label of labels) {
    assert.equal(formattedDropPayloads(parseMonitorDropProducts(pasted), label)[0].embeds.length,5);
    assert.match(formattedDropName(label), /^(?:Walmart Draw|Target Drop|PKC Drop|Costco Drop|Sam's Drop|Upcoming Drop|Dropping Tonight)$/);
  }
});
test("supports inline Price and SKU and ignores unrecognized chatter", () => {
  const items = parseMonitorDropProducts("Magic Booster\\nPrice $114.97\\nSKU: ABC-234\\nHi!\\nPrice?\\n42");
  assert.deepEqual(items,[{name:"Magic Booster",price:"114.97",sku:"ABC-234"}]);
  assert.deepEqual(parseMonitorDropProducts("hi there\\nnot a SKU\\n420"),[]);
});
test("segments more than ten products, leaving all SKUs selectable", () => {
  const items = Array.from({length:21},(_,i)=>({name:"Pokemon Product "+i, price:"29.99",sku:String(21000000000+i)}));
  const blocks = formattedDropPayloads(items,"Walmart Drops");
  assert.deepEqual(blocks.map(b=>b.embeds.length),[10,10,1]);
  assert.deepEqual(blocks.flatMap(b=>parseDropSkus({content:b.content,embeds:b.embeds}).map(x=>x.sku)),items.map(x=>x.sku));
});
test("bot render may be treated as trusted only when author id and marker match", () => {
  const payload = formattedDropPayloads(parseMonitorDropProducts(pasted),"Target Drops")[0];
  const message = {author:{id:"123456789",bot:true},embeds:payload.embeds};
  assert.equal(isFormattedDropPost(message,"123456789"),true);
  assert.equal(isFormattedDropPost(message,"OTHER"),false);
  assert.equal(isFormattedDropPost({...message,author:{id:"123456789",bot:false}},"123456789"),false);
  assert.equal(isFormattedDropPost({...message,embeds:[{title:"Forged"}]},"123456789"),false);
});
