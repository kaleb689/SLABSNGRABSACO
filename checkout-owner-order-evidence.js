import {createHash} from "node:crypto";
import {isVerifiedDiscordCheckout} from "./success-source-policy.js";
import {isModuleLifecycleCheckout} from "./discord-checkout-event-policy.js";
import {cancelledOrder} from "./order-notifications.js";
import {checkoutPaidAmount} from "./checkout-price-policy.js";
import {mergeRetailerFulfillmentItems} from "./retailer-order-enrichment.js";

/**
 * Time-bounded, administrator-attested order screenshots and the corresponding
 * PKC email. This is NOT a public order import or a new checkout source.
 * Only an exact already-confirmed Discord checkout with the expected retailer,
 * exact order number, date window, and mini-tin product family is eligible.
 *
 * Store hashes, not raw retailer order numbers or account identifiers, in Git.
 * No owner attribution, profile assignment, or payment-card data is changed.
 */
const approved = Object.freeze([{
  ref: "20261018-pkc-10-tin-owner-verified",
  orderHash: "979d1293cac1f01a77b47fe19c1d28d68f0000e134ce2608f225d9c317996d90",
  after: "2026-10-13", before: "2026-10-18",
  total: 106.40,
  subtotal: 99.90,
  unitPrice: 9.99,
  items: [
    ["Mew", "Day", "166"], ["Lapras", "Day", "169"],
    ["Pikachu", "Night", "172"], ["Pikachu", "Day", "167"],
    ["Espeon", "Day", "168"], ["Greninja", "Night", "174"],
    ["Moltres", "Day", "170"], ["Zapdos", "Night", "175"],
    ["Mewtwo", "Night", "171"], ["Umbreon", "Night", "173"]
  ].map(([name,time,suffix]) => ({
    name:"Pokémon TCG: 30th Celebration Mini Tin – " + name + " (" + time + ")",
    sku:"10-10465-" + suffix,quantity:1
  }))
}]);

const digest = value => createHash("sha256").update(String(value)).digest("hex");
const normalizeNumber = value => String(value || "").trim().replace(/^#/, "").toLowerCase();
const itemIsExpected = item => /30th\s+Celebration\s+Mini\s+Tin/i.test(String(item?.name || ""));

export function ownerVerifiedOrderEvidence(record, entries=approved) {
  if (!record || isModuleLifecycleCheckout(record) || cancelledOrder(record) ||
      !isVerifiedDiscordCheckout(record) ||
      !/^(confirmed|success|successful|placed|paid|completed|shipped|delivered)$/i
        .test(String(record.status || "")) ||
      String(record.retailer || "").toLowerCase() !== "pkc") return null;
  const date=String(record.checkoutAt || "").slice(0,10);
  const number=normalizeNumber(record.orderNumber);
  if (!number || !date) return null;
  const orderHash=digest("pkc:"+number);
  const evidence=entries.find(item => item.orderHash===orderHash &&
    date>=item.after && date<item.before);
  if (!evidence) return null;
  const prior=Array.isArray(record.items) ? record.items : [];
  if (!prior.length || prior.some(item=>!itemIsExpected(item)) ||
      prior.reduce((sum,item)=>sum+Math.max(0,Number(item.quantity)||0),0)>10) return null;
  const enriched=mergeRetailerFulfillmentItems(prior,evidence.items);
  // Source screenshot and shipment email independently show ten individual
  // variants. Never add a quantity beyond those ten.
  if (enriched.items.length!==10 || enriched.itemCount!==10 ||
      enriched.items.some(item=>Number(item.quantity)!==1)) return null;
  // For this specifically attested ten-variant PKC order, the screenshot
  // confirms one $9.99 tin and the receipt confirms ten tins totalling
  // exactly $99.90 before tax. Do not infer prices for unrelated orders.
  const consistentUnitPrice = Number(evidence.unitPrice) > 0 &&
    Math.round(Number(evidence.unitPrice) * 10 * 100) ===
      Math.round(Number(evidence.subtotal) * 100);
  const items = consistentUnitPrice
    ? enriched.items.map(item => ({...item, price:Number(evidence.unitPrice)}))
    : enriched.items;
  return { evidence, items, total:evidence.total };
}

export function applyOwnerVerifiedOrderEvidence(records, entries=approved) {
  const changedCustomerIds=new Set();
  let corrected=0;
  if (!Array.isArray(records)) return {changed:false,corrected,changedCustomerIds:[]};
  for (const record of records) {
    const attested=ownerVerifiedOrderEvidence(record,entries);
    if (!attested) continue;
    const paid=checkoutPaidAmount(record);
    const desired=paid!==null && paid>attested.total ? paid : attested.total;
    const needsItems=JSON.stringify(record.items)!==JSON.stringify(attested.items) ||
      Number(record.itemCount)!==10;
    const needsTotal=paid===null || paid<attested.total;
    if (!needsItems && !needsTotal) continue;
    record.items=attested.items;
    record.itemCount=10;
    if (needsTotal) {
      record.orderTotal=desired;
      record.orderTotalBasis="retailer_receipt";
      record.priceSource="owner_verified_tax_inclusive_screenshot";
      record.verifiedPaidAt=new Date().toISOString();
      record.ownerTotalEvidenceRef=attested.evidence.ref;
    }
    corrected++;
    if (record.customerAccountId) changedCustomerIds.add(String(record.customerAccountId));
  }
  return {changed:corrected>0,corrected,changedCustomerIds:[...changedCustomerIds]};
}

/**
 * Aggregate production reconciliation diagnostics. Never log the order number,
 * customer name, account email, source message ID or checkout contents.
 * A zero in sourceMatches means the exact screenshot order is absent from the
 * stored Discord checkout ledger; it is not proof that a customer has zero hits.
 */
export function ownerOrderEvidenceAudit(records, entries=approved) {
  const safe = Array.isArray(records) ? records : [];
  const evidenceByHash = new Map(entries.map(item => [String(item.orderHash),item]));
  const result = { sourceMatches:0, eligible:0, linked:0,
    tenItems:0, verifiedFullTotals:0 };
  for (const record of safe) {
    if (!record || !isVerifiedDiscordCheckout(record) ||
        String(record.retailer || "").toLowerCase() !== "pkc" ||
        !record.orderNumber) continue;
    const evidence=evidenceByHash.get(digest("pkc:" + normalizeNumber(record.orderNumber)));
    if (!evidence) continue;
    result.sourceMatches++;
    if (record.customerAccountId) result.linked++;
    if (ownerVerifiedOrderEvidence(record,entries)) result.eligible++;
    const quantity = (Array.isArray(record.items) ? record.items : [])
      .reduce((sum,item) => sum + Math.max(0,Math.floor(Number(item.quantity)||0)),0);
    if (quantity===10 && Array.isArray(record.items) && record.items.length===10) result.tenItems++;
    if ((checkoutPaidAmount(record) ?? 0) >= evidence.total) result.verifiedFullTotals++;
  }
  return result;
}
