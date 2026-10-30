import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {reconcileRetailerEmailTotal, reconcileDiscordPaidTotal, checkoutPriceEvidence} from "../checkout-price-reconciliation.js";
import {reconcileWebhookCheckout} from "../webhook-success.js";
import {dashboardProducts, displayProductName} from "../public/app-dashboard-data.js";

const at = "2026-10-30T13:00:00.000Z";
const discordId = "discord:1532179373292257290:1580000000000000001";
const raw = (total = 0, basis = "unknown") => ({
  id:discordId, source:"discord_success", retailer:"PKC", orderNumber:"EXACT-ORDER-12345",
  customerAccountId:"customer-1", checkoutAt:at, status:"confirmed",
  orderTotal:total, orderTotalBasis:basis,
  items:[{name:"(10-10467-100) Pokémon TCG: Trading Card Game Box",quantity:1,price:0}]
});

test("owner-only exact-order email receipt fills missing Discord paid total without making another order", () => {
  const record=raw();
  const result=reconcileRetailerEmailTotal(record,64.46,at);
  assert.equal(result.changed,true);
  assert.equal(record.orderTotal,64.46);
  assert.equal(record.orderTotalBasis,"retailer_receipt");
  assert.equal(record.priceSource,"verified_retailer_receipt");
  assert.equal(record.emailReceiptTotal,64.46);
  assert.equal(record.priceVerification,"email_verified");
  assert.deepEqual(checkoutPriceEvidence(record),{
    priceVerification:"email_verified",priceSource:"retailer_receipt"
  });
  assert.equal(reconcileRetailerEmailTotal(record,64.46,at).changed,false);
  assert.equal(record.customerAccountId,"customer-1");
});

test("email and Discord identical totals become matched and do not lose their evidence", () => {
  const record=raw(64.46,"order_total");
  assert.equal(reconcileDiscordPaidTotal(record,64.46).conflict,false);
  assert.equal(reconcileRetailerEmailTotal(record,64.46).conflict,false);
  assert.equal(record.orderTotal,64.46);
  assert.equal(record.orderTotalBasis,"retailer_receipt");
  assert.equal(record.discordReportedTotal,64.46);
  assert.equal(record.emailReceiptTotal,64.46);
  assert.equal(record.priceVerification,"matched");
});

test("full retailer receipt outranks different webhook amount, retaining mismatch for review", () => {
  const record=raw(59.99,"order_total");
  reconcileRetailerEmailTotal(record,64.46);
  assert.equal(record.orderTotal,64.46);
  assert.equal(record.discordReportedTotal,59.99);
  assert.equal(record.emailReceiptTotal,64.46);
  assert.equal(record.priceVerification,"conflict");
  assert.equal(reconcileRetailerEmailTotal(record,64.46).changed,false);
  assert.equal(reconcileDiscordPaidTotal(record,64.46).conflict,false);
  assert.equal(record.priceVerification,"matched");
});

test("later webhook cannot downgrade an exact-order verified email or lose charged amount", () => {
  const stored=[raw()];
  reconcileRetailerEmailTotal(stored[0],64.46);
  const later={...raw(59.99,"order_total"),id:"discord:1532179373292257290:1580000000000000002",
    checkoutAt:"2026-10-30T13:30:00Z"};
  reconcileWebhookCheckout(stored,later);
  assert.equal(stored.length,1);
  assert.equal(stored[0].orderTotal,64.46);
  assert.equal(stored[0].orderTotalBasis,"retailer_receipt");
  assert.equal(stored[0].discordReportedTotal,59.99);
  assert.equal(stored[0].priceVerification,"conflict");
  const same={...later,orderTotal:64.46,
    id:"discord:1532179373292257290:1580000000000000003"};
  reconcileWebhookCheckout(stored,same);
  assert.equal(stored[0].priceVerification,"matched");
  assert.equal(stored[0].orderTotal,64.46);
});

test("different retailer email amounts are flagged, not assumed to be separate purchases", () => {
  const record=raw();
  reconcileRetailerEmailTotal(record,64.46);
  const changed=reconcileRetailerEmailTotal(record,32.23);
  assert.equal(changed.conflict,true);
  assert.equal(record.orderTotal,64.46);
  assert.equal(record.conflictingEmailTotal,32.23);
  assert.equal(record.priceVerification,"conflict");
});

test("admin-corrected verified charge is never overwritten by automatic email parsing", () => {
  const record={...raw(70,"retailer_receipt"),
    priceSource:"admin_verified_retailer_receipt"};
  reconcileRetailerEmailTotal(record,64.46);
  assert.equal(record.orderTotal,70);
  assert.equal(record.priceSource,"admin_verified_retailer_receipt");
  assert.equal(record.priceVerification,"conflict");
});

test("SKU prefixes disappear from user-visible product names but real variants remain", () => {
  assert.equal(displayProductName("(10-10467-100) Pokémon TCG: Test Box"),"Pokémon TCG: Test Box");
  assert.equal(displayProductName("(SKU: ABC-123) Pokémon TCG: Test Box"),"Pokémon TCG: Test Box");
  assert.equal(displayProductName("(3-Pack) Pokémon TCG: Test Box"),"(3-Pack) Pokémon TCG: Test Box");
  assert.equal(displayProductName("(151) Pokémon TCG Collection"),"(151) Pokémon TCG Collection");
});

test("a one-product order displays its full verified paid value, not a bogus unit price", () => {
  const orders=[{retailer:"PKC",checkoutAt:at,
    orderTotalKnown:true,verifiedPaidTotal:64.46,orderTotal:64.46,
    checkoutValueKnown:true,checkoutValue:64.46,priceSource:"retailer_receipt",
    items:[{name:"(10-10467-100) Pokémon TCG: Trading Card Game Box",
      productKey:"pokemon trading card game box",quantity:1,price:0}]}];
  const [product]=dashboardProducts(orders);
  assert.equal(product.name,"Pokémon TCG: Trading Card Game Box");
  assert.equal(product.orderValue,64.46);
  assert.equal(product.verifiedOrderValues,true);
  assert.equal(product.singleProductOrders,true);
  assert.equal(product.unpricedQuantity,1);
});

test("multi-product orders must not allocate the entire order total to every product", () => {
  const order={retailer:"PKC",checkoutValue:64.46,checkoutValueKnown:true,
    verifiedPaidTotal:64.46,orderTotal:64.46,orderTotalKnown:true,
    priceSource:"retailer_receipt",items:[
      {name:"Pokémon TCG: Booster",quantity:1,price:0},
      {name:"Pokémon TCG: Tin",quantity:2,price:0}
    ]};
  const products=dashboardProducts([order]);
  assert.equal(products.length,2);
  for(const product of products) {
    assert.equal(product.singleProductOrders,false);
    assert.equal(product.orderValue,0);
  }
});

test("customer and admin checkout price propagation remains owner-only and read-only for customer mailboxes",()=>{
  const source=readFileSync(new URL("../server.js",import.meta.url),"utf8");
  const scan=source.slice(source.indexOf("async function scanMailboxForShipping("),
    source.indexOf("function startShippingTrackerScheduler()"));
  assert.match(scan,/approvedOperatorImapInboxes\(\)/);
  assert.match(scan,/matchVerifiedWebhookEmail\(records, matchEvidence\)/);
  assert.match(scan,/reconcileRetailerEmailTotal\(record, receiptTotal, messageAt\)/);
  assert.match(scan,/reconcileRetailerEmailTotal\(record,/);
  assert.doesNotMatch(scan,/getCustomerSuccessMailboxes\(/);
  const checkout=source.slice(source.indexOf("function safeSuccessCheckout("),
    source.indexOf("async function sendDiscordSuccessNotification("));
  assert.match(checkout,/\.\.\.checkoutPriceEvidence\(record\)/);
  assert.match(checkout,/communityProductName\(publicSuccessProductName\(item\?\.name/);
});
