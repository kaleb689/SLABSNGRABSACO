import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { uniqueCheckoutOwner } from '../webhook-success.js';
const source = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const context = { clean: (v,n) => String(v || "").slice(0,n), normalizeEmail: v => String(v || '').trim().toLowerCase(), publicSuccessImageUrl: () => null, uniqueCheckoutOwner,
 assignmentTimeContainsCheckout: (a,t) => new Date(t) >= new Date(a.startsAt) && (!a.endedAt || new Date(t) <= new Date(a.endedAt)) };
vm.createContext(context);
vm.runInContext(section("function isPublicSuccessProduct", "const verifiedPublicProductImages") +
 section("function normalizeSuccessRetailer", "function safeSuccessImageUrl") +
 section("function discordCheckoutFromMessage", "async function scanDiscordSuccessChannel") +
 section("function preferPreviouslyAssignedManagedAccounts", "/* -------------------------------------------------------"), context);
const message = fields => ({id:"123",timestamp:"2026-09-30T16:00:00Z", embeds:[{title:"Successful Checkout!",fields}]});
const field = (name,value) => ({name,value:String(value)});
test("Stellara numbered products pair quantities and prices without exposing other fields", () => {
 const fields = [field("Site","Pokemon Center US"),field("Email","private@example.test"),field("Proxy","private-proxy")];
 [["Pokemon TCG: Elite Trainer Box",59.99,2],["Pokemon TCG: Booster Bundle (6 Packs)",26.94,1],["Pokemon TCG: Booster Display Box (36 Packs)",161.64,1]].forEach(([name,price,qty],i) => fields.push(field("Product ("+(i+1)+")",name),field("Price ("+(i+1)+")",price),field("Quantity ("+(i+1)+")",qty)));
 const order=context.discordCheckoutFromMessage(message(fields),"456");
 assert.equal(order.items.length,3); assert.equal(order.itemCount,4);
 assert.equal(order.orderTotal,308.56); assert.equal(order.retailer,"PKC"); assert.equal(order.orderTotalBasis,"item_subtotal");
 assert.ok(!JSON.stringify(order).includes("private"));
 fields.push(field("Order Total","$329.50"));
 assert.equal(context.discordCheckoutFromMessage(message(fields),"456").orderTotal,329.50);
});
test("Hayha separate item, price suffix, quantity, and encoded product name", () => {
 const order=context.discordCheckoutFromMessage(message([field("Site","Target"),field("Item","Pok&#233;mon Trading Card Game: 30th Celebration Elite Trainer Box - $139.98"),field("Quantity",2),field("Profile Name","private-profile")]),"456");
 assert.equal(order.items[0].name,"Pokémon Trading Card Game: 30th Celebration Elite Trainer Box");
 assert.equal(order.itemCount,2); assert.equal(order.orderTotal,139.98);
 assert.ok(!JSON.stringify(order).includes("private-profile"));
});
test("single numbered product and invalid quantity handling", () => {
 const fields=[field("Product (1)","Pokemon TCG: Booster Bundle"),field("Price (1)",26.94),field("Quantity (1)",1)];
 assert.equal(context.discordCheckoutFromMessage(message(fields),"456").orderTotal,26.94);
 fields[2].value="0";
 assert.equal(context.discordCheckoutFromMessage(message(fields),"456"),null);
});
test('checkout routing uses exact email and assignment at checkout, refusing ambiguous matches', () => {
 const order={retailer:'PKC',checkoutAt:'2026-09-30T17:00:00Z'};
 const candidates=[{customerAccountId:'previous',retailer:'PKC',email:'pool@example.test',assignment:{startsAt:'2026-09-01',endedAt:'2026-09-29'}},
 {customerAccountId:'correct',retailer:'PKC',email:'pool@example.test',profileName:'Profile One',assignment:{startsAt:'2026-09-30T00:00:00Z'}}];
 const routed=context.discordCheckoutAttribution(order,{email:'pool@example.test',profileName:''},candidates);
 assert.equal(routed.customerAccountId,'correct');assert.ok(!JSON.stringify(routed).includes('pool@example.test'));
 candidates.push({customerAccountId:'other',retailer:'PKC',email:'pool@example.test'});
 assert.equal(context.discordCheckoutAttribution(order,{email:'pool@example.test'},candidates),null);
 assert.equal(context.discordCheckoutAttribution(order,{email:'missing@example.test'},candidates),null);
});
test("longest-linked available accounts first, including gifted history, with stable fallback", () => {
 const available=[{id:"new"},{id:"short"},{id:"long"},{id:"gift"},{id:"new2"}];
 const history=[
  {managedAccountId:"short",customerAccountId:"user",rentalRetailer:"target",createdAt:"2026-09-28",endedAt:"2026-09-30"},
  {managedAccountId:"long",customerAccountId:"user",rentalRetailer:"target",createdAt:"2026-08-01",endedAt:"2026-08-20"},
  {freeMembershipId:"gift",customerAccountId:"user",assignmentRetailer:"target",createdAt:"2026-07-01",endedAt:"2026-08-01"},
  {managedAccountId:"new",customerAccountId:"other",rentalRetailer:"target",createdAt:"2025-01-01",endedAt:"2026-09-30"},
  {managedAccountId:"unavailable",customerAccountId:"user",rentalRetailer:"target",createdAt:"2025-01-01",endedAt:"2026-09-30"}
 ];
 const sorted=context.preferPreviouslyAssignedManagedAccounts(available,history,"user","target");
 assert.equal(sorted.map(x=>x.id).join(","),"gift,long,short,new,new2");
 assert.equal(available[0].id,"new");
});

test("explicit single-item unit price still multiplies quantity, and checkout aliases normalize", () => {
 const fields=[field("Site","targetgo"),field("Item","Pokemon TCG Elite Trainer Box"),field("Unit Price","$69.99"),field("Quantity",2),field("Account","customer@example.test")];
 const result=context.discordCheckoutFromMessage(message(fields),"456");
 assert.equal(result.orderTotal,139.98);assert.equal(result.retailer,"Target");
 assert.equal(context.discordCheckoutIdentity(message(fields)).email,"customer@example.test");
 assert.equal(context.normalizeSuccessRetailer("walmartgo"),"Walmart");
});
