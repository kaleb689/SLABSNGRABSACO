import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { THANKSGIVING_2026, proposedThanksgivingPrice, proposedUpcomingPrice,
  approvedUpcomingSchedule } from "../membership-thanksgiving-2026.js";

const tiers = [
  [1,"Starter",1,15,1125,2000],
  [2,"Intermediate",2,25,1875,3500],
  [3,"Advanced",3,40,3000,5500],
  [4,"Pro",5,70,5250,9500],
  [5,"High Volume",10,120,9000,17000],
  [6,"Power User",20,150,11250,21000],
  [7,"Elite",50,290,21750,41000],
  [8,"Ultimate",100,800,60000,113500]
];
const plans=Object.fromEntries(tiers.map(([tier,name,profiles,amount])=>[tier,{name,profiles,amount}]));

test("all eight Thanksgiving 25% prices and proposed 42% Nov 28 rates use exact cents",()=>{
 assert.equal(THANKSGIVING_2026.discountPercent,25);
 assert.equal(THANKSGIVING_2026.increasePercent,42);
 assert.equal(THANKSGIVING_2026.code,"THANKS25");
 assert.equal(THANKSGIVING_2026.saleEndExclusive,"2026-11-28T05:00:00.000Z");
 for(const [, , , amount, saleCents, upcomingCents] of tiers){
  assert.equal(proposedThanksgivingPrice(amount),saleCents);
  assert.equal(proposedUpcomingPrice(amount),upcomingCents);
 }
});

test("upcoming pricing is absent until owner approval and never silently reprices Stripe",()=>{
 assert.equal(approvedUpcomingSchedule(plans),null);
 assert.equal(approvedUpcomingSchedule(plans,{approved:false,now:Date.parse("2026-11-15T20:00:00Z")}),null);
 const approved=approvedUpcomingSchedule(plans,{approved:true,now:Date.parse("2026-11-15T20:00:00Z")});
 assert.equal(approved.effectiveAt,"2026-11-28T05:00:00.000Z");
 assert.deepEqual(Object.values(approved.prices),tiers.map(row=>row[5]));
 assert.equal(approvedUpcomingSchedule(plans,{approved:true,now:Date.parse("2026-11-28T05:00:00Z")}),null);
});

test("server exposes future-pricing display only behind explicit approval flag",()=>{
 const server=readFileSync(new URL("../server.js",import.meta.url),"utf8");
 const app=readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
 const markup=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
 assert.match(server,/SNG_NOV28_UPCOMING_PRICE_DISPLAY_APPROVED === "true"/);
 assert.match(server,/approvedUpcomingSchedule\(PLANS/);
 assert.match(server,/return res\.json\(\{ discounts,/);
 assert.match(app,/membershipUpcomingHtml/);
 assert.match(app,/membershipUpcoming = data\.upcoming/);
 assert.match(markup,/id="home-upcoming-pricing-banner"/);
 assert.match(markup,/id="membership-upcoming-pricing-banner"/);
 assert.doesNotMatch(server,/STRIPE_TIER1_PRICE_ID\s*=\s*["']price_/);
});
