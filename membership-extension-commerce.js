// Customer-paid membership extension checkout. Stripe confirms payment before any
// subscription term/tier change. This module never reads or stores ACO card details.
import crypto from "node:crypto";

const asId = x => String(x || "").trim();
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const sumEnd = sub => Math.max(Number(sub.current_period_end) || 0,
  ...(sub.items?.data || []).map(item => Number(item.current_period_end) || 0));
const atTime = value => typeof value === "number" ? value * 1000 : Date.parse(String(value || ""));
const planFromRecord = record => Number(record?.plan?.tier || record?.tier || 0);
const scopeOf = record => record?.discountScope ||
  (record?.appliesToExtensions ? "both" : "signup");
const amountCents = plan => Math.round(Number(plan?.amount || 0) * 100);

export function calculatePaidExtensionOffer({ months, targetTier, currentTier, plans, code = null }) {
  const count = Number(months), desired = Number(targetTier), current = Number(currentTier);
  if (!Number.isSafeInteger(count) || count < 1 || count > 12)
    throw fail("Choose 1–12 months to extend.");
  if (!Number.isInteger(desired) || !plans[desired] || !plans[desired].priceId ||
      !Number.isInteger(current) || !plans[current] || desired < current)
    throw fail("Choose your current tier or a higher membership tier.");
  const monthly = amountCents(plans[desired]);
  if (!Number.isSafeInteger(monthly) || monthly < 50)
    throw fail("The selected membership price is unavailable.", 503);
  if (code && (scopeOf(code) === "signup" || code.discountType === "fixed-price"))
    throw fail("This code is not eligible for membership extensions.");
  const percent = code ? Number(code.percent) : 0;
  if (code && (!Number.isInteger(percent) || percent < 1 || percent > 100))
    throw fail("The extension discount percentage is invalid.");
  const discountedMonths = code ? Math.min(count, Number(code.extensionDiscountMonths || 1)) : 0;
  if (code && (!Number.isSafeInteger(discountedMonths) || discountedMonths < 1))
    throw fail("The extension discount duration is invalid.");
  const regularCents = monthly * count;
  const savedCents = Math.round(monthly * discountedMonths * percent / 100);
  const totalCents = regularCents - savedCents;
  return {
    months: count, currentTier: current, targetTier: desired,
    tierName: plans[desired].name, profiles: plans[desired].profiles,
    monthlyCents: monthly, regularCents, savedCents, totalCents,
    upgrade: desired > current, discountCode: code?.code || null,
    discountLabel: code?.discountLabel || null,
    discountPercent: percent, discountedMonths
  };
}

export function registerMembershipExtensionCommerce(app, d) {
  const {
    stripe, plans, baseUrl, requireCustomer, requireAdmin,
    readPurchases, writePurchases, getPaid, savePaid, getCustomers, saveCustomers,
    getDiscounts, getDiscountsWithUsage, saveDiscounts, applySubscriptionInfo,
    subscriptionAllowsProfiles, planForStripePriceId, requestedMembershipDuration,
    notifyMember, notifyAdminMobile, sendDiscordPayment, notifyScheduledCancel,
    provisionPaidPool, broadcast
  } = d;
  let tail = Promise.resolve();
  const serialized = work => {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  };
  const priceId = sub => {
    const item = sub.items?.data?.[0];
    return typeof item?.price === "string" ? item.price : item?.price?.id;
  };
  async function subscriptionFor(accountId) {
    const paid = await getPaid();
    const active = (Array.isArray(paid) ? paid : []).filter(x =>
      String(x.customerAccountId) === String(accountId) &&
      x.stripeSubscriptionId && subscriptionAllowsProfiles(x));
    const ids = [...new Set(active.map(x => String(x.stripeSubscriptionId)))];
    if (ids.length !== 1)
      throw fail("A single active paid Stripe membership is required. Contact support if the membership needs linking.", 409);
    const subscription = await stripe.subscriptions.retrieve(ids[0]);
    if (!["active", "trialing"].includes(subscription.status) ||
        subscription.cancel_at_period_end || subscription.cancel_at || subscription.pause_collection)
      throw fail("This membership is cancelled, paused or inactive. Contact support before extending.", 409);
    if (subscription.items?.data?.length !== 1 || !sumEnd(subscription))
      throw fail("Stripe returned an unexpected billing configuration. No changes were made.", 409);
    const matched = planForStripePriceId(priceId(subscription));
    const tier = Number(matched?.tier || active[0]?.plan?.tier || 0);
    if (!plans[tier]) throw fail("Your current tier could not be verified.", 409);
    return { paid, active, subscription, tier };
  }
  async function getEligibleCode(input, tier, account, pending = false) {
    const typed = String(input || "").trim().toUpperCase();
    if (!typed) return null;
    const all = await getDiscountsWithUsage();
    const found = all.find(record => String(record.code || "").toUpperCase() === typed);
    if (!found || !found.active || scopeOf(found) === "signup" || found.discountType === "fixed-price" ||
        (found.expiresAt && Date.parse(found.expiresAt) <= Date.now()))
      throw fail("This code is not available for paid membership extensions.");
    if (found.tier !== "all" && Number(found.tier) !== Number(tier))
      throw fail("This extension code does not apply to the selected tier.");
    if (found.recipientEmail && String(found.recipientEmail).toLowerCase() !== String(account.email).toLowerCase())
      throw fail("This code belongs to another customer.");
    if (found.ogOnly && !account.ogMemberGrantedAt) throw fail("This code is limited to OG members.");
    if (found.exhausted || found.usageUnavailable)
      throw fail("This discount has reached its use limit or its availability cannot be verified.");
    if (pending && found.maxUses !== null && found.maxUses !== undefined) {
      const purchases = await readPurchases();
      const held = (Array.isArray(purchases) ? purchases : []).filter(p =>
        p.discountId === found.id && p.status === "pending" &&
        Date.parse(p.checkoutExpiresAt || "") > Date.now()).length;
      if (Number(found.redemptions || 0) + held >= Number(found.maxUses))
        throw fail("This promotion has no remaining redemptions.");
    }
    return found;
  }
  async function build(account, body, pending = false) {
    const selection = await subscriptionFor(account.id);
    const targetTier = Number(body.tier || selection.tier);
    const code = await getEligibleCode(body.discountCode, targetTier, account, pending);
    const quote = calculatePaidExtensionOffer({
      months: body.months, targetTier, currentTier: selection.tier, plans, code
    });
    let term;
    try {
      term = requestedMembershipDuration({
        durationUnit: "month", durationQuantity: quote.months,
        periodEnd: sumEnd(selection.subscription), trialEnd: selection.subscription.trial_end,
        billingCycleAnchor: selection.subscription.billing_cycle_anchor
      });
    } catch (err) { throw fail(err.message || "The extension exceeds Stripe's supported renewal date."); }
    return { selection, code, quote, term };
  }
  function jsonError(res, error, label) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error(label, error?.type || error?.code || error?.message || "unexpected");
    return res.status(502).json({error:"Stripe could not complete this request. No membership change has been confirmed."});
  }

  app.get("/api/account/membership/extension-quote", requireCustomer, async (req, res) => {
    try {
      const account = req.customerAccount;
      const offer = await build(account, req.query);
      res.set("Cache-Control", "no-store");
      res.json({ ok:true, quote: offer.quote,
        nextRenewalAt: offer.term.expiresAt, currentRenewalAt: offer.term.startsAt });
    } catch (error) { jsonError(res, error, "Extension quote"); }
  });

  app.post("/api/account/membership/extension-checkout", requireCustomer, async (req, res) => {
    try {
      if (req.body?.confirm !== true) throw fail("Confirm the full extension amount before checkout.");
      const requestId = asId(req.body?.requestId);
      if (!/^[a-zA-Z0-9-]{12,80}$/.test(requestId))
        throw fail("The checkout request is invalid.");
      const response = await serialized(async () => {
        const prior = await readPurchases();
        const purchases = Array.isArray(prior) ? prior : [];
        const existing = purchases.find(p => p.requestId === requestId);
        if (existing) {
          if (existing.customerAccountId !== req.customerAccount.id)
            throw fail("This checkout request was used by another account.", 409);
          if (existing.sessionUrl && existing.status === "pending") return {url:existing.sessionUrl,quote:existing.quote,replayed:true};
          throw fail("This checkout request has already been processed.", 409);
        }
        if (purchases.some(p => p.customerAccountId === req.customerAccount.id &&
             p.status === "pending" && Date.parse(p.checkoutExpiresAt || "") > Date.now()))
          throw fail("You already have an extension checkout in progress. Finish it or try again after it expires.", 409);
        const { selection, code, quote, term } = await build(req.customerAccount, req.body, true);
        const expiresAt = Math.floor(Date.now() / 1000) + 30 * 60;
        const session = await stripe.checkout.sessions.create({
          mode: "payment",
          customer: typeof selection.subscription.customer === "string"
            ? selection.subscription.customer : selection.subscription.customer?.id,
          line_items: [{
            price_data: {
              currency: "usd", unit_amount: quote.totalCents,
              product_data: { name: quote.tierName + " membership extension",
                description: quote.months + " month(s); " + quote.profiles +
                  " ACO profiles" + (quote.discountCode ? "; " + quote.discountCode +
                  " (" + quote.discountedMonths + " month(s) discounted)" : "") }
            }, quantity: 1
          }],
          metadata: {purchase_type:"membership_extension", extension_request_id:requestId},
          success_url: baseUrl + "/?extension=success#my-profile",
          cancel_url: baseUrl + "/?extension=cancelled#my-profile",
          expires_at: expiresAt
        }, {idempotencyKey:"sng-extension-checkout-" + requestId});
        if (!session?.id || !session?.url) throw fail("Stripe did not return a checkout link.", 502);
        purchases.push({
          requestId, sessionId:session.id, sessionUrl:session.url,
          status:"pending", customerAccountId:req.customerAccount.id,
          subscriptionId:selection.subscription.id, currentTier:selection.tier,
          targetTier:quote.targetTier, months:quote.months,
          amountCents:quote.totalCents, discountId:code?.id || null,
          quote, createdAt:new Date().toISOString(),
          checkoutExpiresAt:new Date(expiresAt * 1000).toISOString(),
          expectedRenewalAt:term.expiresAt
        });
        await writePurchases(purchases);
        return {url:session.url,quote};
      });
      return res.json(response);
    } catch (error) { jsonError(res, error, "Extension checkout"); }
  });

  async function fulfill(session) {
    if (session?.metadata?.purchase_type !== "membership_extension") return false;
    if (!["paid", "no_payment_required"].includes(String(session.payment_status || ""))) return false;
    return serialized(async () => {
      const records = await readPurchases();
      const purchases = Array.isArray(records) ? records : [];
      const purchase = purchases.find(p => p.sessionId === session.id &&
        p.requestId === session.metadata.extension_request_id);
      if (!purchase) throw fail("Paid extension has no matching checkout record. Manual billing review required.", 409);
      if (purchase.status === "completed") return true;
      if (Number(session.amount_total || 0) !== purchase.amountCents)
        throw fail("Stripe payment total does not match the saved extension quote.", 409);
      const customer = (await getCustomers()).find(x => String(x.id) === String(purchase.customerAccountId));
      if (!customer || customer.disabled) throw fail("The paid extension account is no longer active.", 409);
      const sub = await stripe.subscriptions.retrieve(purchase.subscriptionId);
      if (!["active", "trialing"].includes(sub.status) || sub.cancel_at_period_end ||
          sub.cancel_at || sub.pause_collection || sub.items?.data?.length !== 1)
        throw fail("The Stripe subscription changed before extension fulfillment.", 409);
      const current = planForStripePriceId(priceId(sub));
      if (!current || Number(current.tier) > purchase.targetTier)
        throw fail("The membership was upgraded elsewhere; manual review is required to avoid an unintended downgrade.", 409);
      const already = sub.metadata?.sng_last_paid_extension_session === session.id;
      const window = already ? {
        expiresAt:sub.metadata.sng_last_paid_extension_until,
        stripeTrialEnd:Number(sub.trial_end)
      } : requestedMembershipDuration({
        durationUnit:"month", durationQuantity:purchase.months,
        periodEnd:sumEnd(sub), trialEnd:sub.trial_end,
        billingCycleAnchor:sub.billing_cycle_anchor
      });
      const expectedPrice = plans[purchase.targetTier]?.priceId;
      if (!expectedPrice) throw fail("The selected tier price is not configured.", 409);
      const verified = already ? sub : await stripe.subscriptions.update(sub.id, {
        items:[{id:sub.items.data[0].id,price:expectedPrice,quantity:1}],
        proration_behavior:"none",
        trial_end:window.stripeTrialEnd,
        metadata:{...sub.metadata,
          membership_tier:String(purchase.targetTier),
          sng_last_paid_extension_session:session.id,
          sng_last_paid_extension_until:window.expiresAt,
          sng_last_paid_extension_request:purchase.requestId}
      }, {idempotencyKey:"sng-paid-extension-fulfill-" + session.id});
      if (Number(verified.trial_end) !== Number(window.stripeTrialEnd) ||
          priceId(verified) !== expectedPrice)
        throw fail("Stripe did not verify the new paid membership price and renewal date.", 502);
      // Re-read after Stripe to avoid losing newer subscription webhook updates.
      const latest = await getPaid();
      let count = 0;
      for (const item of (Array.isArray(latest) ? latest : [])) {
        if (String(item.customerAccountId) !== String(purchase.customerAccountId) ||
            String(item.stripeSubscriptionId) !== String(sub.id)) continue;
        await applySubscriptionInfo(item, verified);
        item.plan = {tier:purchase.targetTier, name:plans[purchase.targetTier].name,
          profiles:plans[purchase.targetTier].profiles, amount:plans[purchase.targetTier].amount};
        item.currentPeriodEnd = window.expiresAt;
        item.subscriptionEndDate = window.expiresAt;
        item.billingDeferredUntil = window.expiresAt;
        item.lastPaidExtensionSessionId = session.id;
        item.lastPaidExtensionAmountCents = purchase.amountCents;
        item.autoPoolProvisioningRequestedAt ||= new Date().toISOString();
        count++;
      }
      if (!count) throw fail("The paid Stripe subscription has no matching local membership.", 409);
      await savePaid(latest);
      purchase.status = "completed";
      purchase.completedAt = new Date().toISOString();
      purchase.renewalAt = window.expiresAt;
      purchase.stripePaymentIntentId = typeof session.payment_intent === "string"
        ? session.payment_intent : session.payment_intent?.id || null;
      await writePurchases(purchases);
      try {
        const fresh = await getCustomers();
        const account = fresh.find(x => String(x.id) === String(purchase.customerAccountId));
        if (account) {
          notifyMember(account, {kind:"membership_extended",extensionRequestId:purchase.requestId,
            title:purchase.targetTier > purchase.currentTier ? "Membership extended and upgraded" : "Membership extended",
            message:"Your paid " + purchase.months + "-month extension is confirmed through " +
              new Date(window.expiresAt).toLocaleDateString("en-US") +
              ". The next recurring Stripe payment uses your " + plans[purchase.targetTier].name +
              " tier price. Extension promo discounts do not change that recurring price.",
            createdAt:new Date().toISOString()});
          await saveCustomers(fresh);
        }
        await Promise.resolve(provisionPaidPool(latest.find(x =>
          String(x.customerAccountId) === String(purchase.customerAccountId) &&
          String(x.stripeSubscriptionId) === String(sub.id))));
        await notifyAdminMobile("newOrders", "Paid membership extension",
          (customer.email || "Member") + " paid for " + purchase.months +
          " extension month(s), " + plans[purchase.targetTier].name + ".",
          "/admin-app.html", "paid-extension:" + session.id);
        await sendDiscordPayment({paymentType:"Paid membership extension",
          headline:"Customer purchased a membership extension.",
          amount:purchase.amountCents / 100, customerEmail:customer.email || "",
          purchaseSummary:plans[purchase.targetTier].name + " — " + purchase.months +
            " extension month(s)" + (purchase.quote.discountCode ?
              " — " + purchase.quote.discountCode : ""),
          profiles:plans[purchase.targetTier].profiles,paidAt:purchase.completedAt,
          orderId:purchase.requestId});
      } catch (error) { console.error("Paid extension follow-up notification:",error?.message); }
      broadcast("paid-membership-extension");
      return true;
    });
  }

  async function cancel(accountId, mode) {
    const selection = await subscriptionForCancellation(accountId);
    const sub = selection.subscription;
    if (mode === "period_end") {
      if (sub.cancel_at_period_end) return {already:true, subscription:sub};
      const updated = await stripe.subscriptions.update(sub.id, {cancel_at_period_end:true},
        {idempotencyKey:"sng-cancel-end-" + sub.id + "-" + (sub.current_period_end || sub.trial_end || "active")});
      await recordCancellation(accountId, updated, false);
      return {subscription:updated};
    }
    if (mode !== "now") throw fail("Choose cancellation at renewal or immediately.");
    if (sub.status === "canceled") return {already:true,subscription:sub};
    const cancelled = await stripe.subscriptions.cancel(sub.id);
    await recordCancellation(accountId, cancelled, true);
    return {subscription:cancelled};
  }
  async function subscriptionForCancellation(accountId) {
    const paid = await getPaid();
    const active = (Array.isArray(paid) ? paid : []).filter(x =>
      String(x.customerAccountId) === String(accountId) &&
      x.stripeSubscriptionId && subscriptionAllowsProfiles(x));
    const ids = [...new Set(active.map(x => String(x.stripeSubscriptionId)))];
    if (ids.length !== 1) throw fail("Exactly one active paid subscription is required.", 409);
    return {subscription:await stripe.subscriptions.retrieve(ids[0])};
  }
  async function recordCancellation(accountId, subscription, immediate) {
    const paid = await getPaid();
    for (const record of (Array.isArray(paid) ? paid : [])) {
      if (String(record.customerAccountId) !== String(accountId) ||
          String(record.stripeSubscriptionId) !== String(subscription.id)) continue;
      const previouslyScheduled = record.cancelAtPeriodEnd === true;
      await applySubscriptionInfo(record, subscription);
      if (!immediate && !previouslyScheduled) {
        try { await notifyScheduledCancel(record, subscription); }
        catch (error) { console.error("Cancellation notification:", error.message); }
      }
    }
    await savePaid(paid);
    broadcast("membership-cancellation");
  }
  app.post("/api/account/membership/cancel", requireCustomer, async (req,res) => {
    try {
      if (req.body?.confirm !== true) throw fail("Confirm that you want to stop automatic membership renewal.");
      const result = await serialized(() => cancel(req.customerAccount.id, "period_end"));
      res.json({ok:true, cancelAtPeriodEnd:true, endAt:result.subscription.cancel_at ||
        result.subscription.trial_end || result.subscription.current_period_end});
    } catch(error) { jsonError(res,error,"Customer cancellation"); }
  });
  app.post("/api/admin/customers/:id/membership/cancel", requireAdmin, async(req,res) => {
    try {
      if (req.body?.confirmed !== true) throw fail("Confirm this membership cancellation.");
      const mode = req.body?.mode === "now" ? "now" : "period_end";
      const account = (await getCustomers()).find(x => String(x.id) === String(req.params.id));
      if (!account) throw fail("Customer account not found.",404);
      const result = await serialized(() => cancel(account.id,mode));
      res.json({ok:true, mode,already:result.already === true,
        status:result.subscription.status,cancelAtPeriodEnd:result.subscription.cancel_at_period_end === true});
    } catch(error) { jsonError(res,error,"Admin cancellation"); }
  });

  return {fulfill};
}
