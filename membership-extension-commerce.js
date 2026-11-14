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
const paidUntil = sub => Number(sub.pause_collection?.resumes_at) || 0;
const isOurPrepaidPause = sub => sub.pause_collection?.behavior === "void" &&
  Boolean(sub.metadata?.sng_last_paid_extension_session) && paidUntil(sub) > 0;
function prepaidWindow(sub, months) {
  const base = Math.max(Math.floor(Date.now()/1000),
    sumEnd(sub), Number(sub.trial_end) || 0, paidUntil(sub));
  const date = new Date(base * 1000);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + Number(months));
  date.setUTCDate(Math.min(day,
    new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate()));
  const end = Math.floor(date.getTime()/1000);
  if (!Number.isSafeInteger(end) || end <= base || date.getUTCFullYear() >= 9999)
    throw fail("Choose fewer extension months; the billing end date is not supported.");
  return {startsAt:new Date(base*1000).toISOString(),expiresAt:date.toISOString(),
    stripeResumesAt:end};
}

function calculateUpgradeAdjustment(subscription,currentTier,targetTier,plans){
  if(targetTier<=currentTier)return {amountCents:0,startsAt:null,endsAt:null};
  const now=Math.floor(Date.now()/1000);
  const prepaid=paidUntil(subscription)>now;
  const end=prepaid?paidUntil(subscription):sumEnd(subscription);
  const start=prepaid?now:Number(subscription.current_period_start ||
    subscription.items?.data?.[0]?.current_period_start || 0);
  if(!(end>now) || !(start>0) || !(end>start))
    throw fail("Stripe did not provide a valid current billing period for the upgrade. No payment was started.",409);
  const diff=amountCents(plans[targetTier])-amountCents(plans[currentTier]);
  if(diff<=0)throw fail("The target membership is not a paid upgrade.",409);
  const monthsEquivalent=prepaid?(end-now)/(365.2425/12*86400):
    Math.min(1,(end-now)/(end-start));
  const amount=Math.max(0,Math.round(diff*monthsEquivalent));
  return {amountCents:amount,startsAt:new Date(now*1000).toISOString(),
    endsAt:new Date(end*1000).toISOString()};
}

export function calculatePaidExtensionOffer({ months, targetTier, currentTier, plans, code = null,
  upgradeAdjustmentCents=0 }) {
  const count = Number(months), desired = Number(targetTier), current = Number(currentTier);
  if (!Number.isSafeInteger(count) || count < 1 || count > 1200)
    throw fail("Choose 1–1200 prepaid months for this purchase.");
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
  const discountedMonths = code ? (
    code.extensionDiscountMonths === "all" || code.extensionDiscountMonths == null
      ? count : Math.min(count, Number(code.extensionDiscountMonths))
  ) : 0;
  if (code && (!Number.isSafeInteger(discountedMonths) || discountedMonths < 1))
    throw fail("The extension discount duration is invalid.");
  const regularCents = monthly * count;
  const savedCents = Math.round(monthly * discountedMonths * percent / 100);
  const prepaidCents = regularCents - savedCents;
  if(!Number.isSafeInteger(upgradeAdjustmentCents)||upgradeAdjustmentCents<0)
    throw fail("The upgrade amount could not be verified.");
  const totalCents = prepaidCents + upgradeAdjustmentCents;
  if(!Number.isSafeInteger(totalCents)||totalCents<0||totalCents>99999999)
    throw fail("That prepaid purchase exceeds the maximum supported charge. Choose fewer months.");
  return {
    months: count, currentTier: current, targetTier: desired,
    tierName: plans[desired].name, profiles: plans[desired].profiles,
    monthlyCents: monthly, regularCents, savedCents, prepaidCents,
    upgradeAdjustmentCents,totalCents,
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
        subscription.cancel_at_period_end || subscription.cancel_at || (subscription.pause_collection && !isOurPrepaidPause(subscription)))
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
        (found.startsAt && Date.parse(found.startsAt) > Date.now()) ||
        (found.expiresAt && Date.parse(found.expiresAt) <= Date.now()))
      throw fail("This code is not available for paid membership extensions.");
    if (found.tier !== "all" && Number(found.tier) !== Number(tier))
      throw fail("This extension code does not apply to the selected tier.");
    if (found.recipientEmail && String(found.recipientEmail).toLowerCase() !== String(account.email).toLowerCase())
      throw fail("This code belongs to another customer.");
    if (found.ogOnly && !account.ogMemberGrantedAt) throw fail("This code is limited to OG members.");
    if (found.exhausted || found.usageUnavailable)
      throw fail("This discount has reached its use limit or its availability cannot be verified.");
    if (found.maxUses !== null && found.maxUses !== undefined) {
      const purchases = await readPurchases();
      const extensionUses = (Array.isArray(purchases) ? purchases : []).filter(p =>
        p.discountId === found.id && ["completed","refunding","refunded"].includes(p.status)).length;
      const held = (Array.isArray(purchases) ? purchases : []).filter(p =>
        p.discountId === found.id && p.status === "pending" &&
        Date.parse(p.checkoutExpiresAt || "") > Date.now()).length;
      if (Number(found.redemptions || 0) + extensionUses + held >= Number(found.maxUses))
        throw fail("This promotion has no remaining redemptions.");
    }
    return found;
  }
  async function build(account, body, pending = false) {
    const selection = await subscriptionFor(account.id);
    const targetTier = Number(body.tier || selection.tier);
    const code = await getEligibleCode(body.discountCode, targetTier, account, pending);
    const upgradeAdjustment=calculateUpgradeAdjustment(
      selection.subscription,selection.tier,targetTier,plans);
    const quote = calculatePaidExtensionOffer({
      months: body.months, targetTier, currentTier: selection.tier, plans, code,
      upgradeAdjustmentCents:upgradeAdjustment.amountCents
    });
    quote.upgradeAdjustmentStartsAt=upgradeAdjustment.startsAt;
    quote.upgradeAdjustmentEndsAt=upgradeAdjustment.endsAt;
    let term;
    try {
      term = prepaidWindow(selection.subscription,quote.months);
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
        if (req.body?.expectedTotalCents !== quote.totalCents)
          throw fail("The extension price has changed. Preview the total again before payment.",409);
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
          customerEmail:req.customerAccount.email||"",
          subscriptionId:selection.subscription.id, currentTier:selection.tier,
          targetTier:quote.targetTier, months:quote.months,
          amountCents:quote.totalCents, discountId:code?.id || null,
          quote, createdAt:new Date().toISOString(),
          checkoutExpiresAt:new Date(expiresAt * 1000).toISOString(),
          quotedStartAt:term.startsAt,expectedRenewalAt:term.expiresAt,
          previousPauseUntil:paidUntil(selection.subscription),
          previousExtensionSessionId:selection.subscription.metadata?.sng_last_paid_extension_session || "",
          previousExtensionStartAt:selection.subscription.metadata?.sng_last_paid_extension_start || "",
          previousExtensionEndAt:selection.subscription.metadata?.sng_last_paid_extension_until || ""
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
      if (["completed","refunded","refunding"].includes(purchase.status)) return true;
      if (Number(session.amount_total || 0) !== purchase.amountCents)
        throw fail("Stripe payment total does not match the saved extension quote.", 409);
      const customer = (await getCustomers()).find(x => String(x.id) === String(purchase.customerAccountId));
      if (!customer || customer.disabled) throw fail("The paid extension account is no longer active.", 409);
      const sub = await stripe.subscriptions.retrieve(purchase.subscriptionId);
      if (!["active", "trialing"].includes(sub.status) || sub.cancel_at_period_end ||
          sub.cancel_at || (sub.pause_collection && !isOurPrepaidPause(sub)) || sub.items?.data?.length !== 1)
        throw fail("The Stripe subscription changed before extension fulfillment.", 409);
      const current = planForStripePriceId(priceId(sub));
      if (!current || Number(current.tier) > purchase.targetTier)
        throw fail("The membership was upgraded elsewhere; manual review is required to avoid an unintended downgrade.", 409);
      const already = sub.metadata?.sng_last_paid_extension_session === session.id;
      const window = already ? {
        startsAt:sub.metadata.sng_last_paid_extension_start,
        expiresAt:sub.metadata.sng_last_paid_extension_until,
        stripeResumesAt:Number(sub.pause_collection?.resumes_at)
      } : prepaidWindow(sub,purchase.months);
      const expectedPrice = plans[purchase.targetTier]?.priceId;
      if (!expectedPrice) throw fail("The selected tier price is not configured.", 409);
      const verified = already ? sub : await stripe.subscriptions.update(sub.id, {
        items:[{id:sub.items.data[0].id,price:expectedPrice,quantity:1}],
        proration_behavior:"none",
        pause_collection:{behavior:"void",resumes_at:window.stripeResumesAt},
        metadata:{...sub.metadata,
          membership_tier:String(purchase.targetTier),
          sng_last_paid_extension_session:session.id,
          sng_last_paid_extension_until:window.expiresAt,
          sng_last_paid_extension_start:window.startsAt,
          sng_last_paid_extension_request:purchase.requestId}
      }, {idempotencyKey:"sng-paid-extension-fulfill-" + session.id});
      if (Number(verified.pause_collection?.resumes_at) !== Number(window.stripeResumesAt) ||
          verified.pause_collection?.behavior !== "void" ||
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
        item.prepaidThrough = window.expiresAt;
        item.lastPaidExtensionSessionId = session.id;
        item.lastPaidExtensionAmountCents = purchase.amountCents;
        item.autoPoolProvisioningRequestedAt ||= new Date().toISOString();
        count++;
      }
      if (!count) throw fail("The paid Stripe subscription has no matching local membership.", 409);
      await savePaid(latest);
      purchase.status = "completed";
      purchase.serviceStartsAt = window.startsAt;
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
              ". Automatic collection is deferred through that date. When billing resumes, your " +
              plans[purchase.targetTier].name + " tier's regular monthly price applies.",
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

  // Only the latest still-active prepaid purchase can be refunded automatically.
  // Older or overlapping purchases require Stripe reconciliation before mutation.
  function refundQuote(purchase, at = Date.now()) {
    const end = Date.parse(purchase.renewalAt || "");
    const start = Date.parse(purchase.serviceStartsAt || "");
    const total = Number(purchase.amountCents);
    if (!Number.isFinite(end) || !Number.isFinite(start) || end <= start ||
        !Number.isSafeInteger(total) || total < 0)
      throw fail("The prepaid purchase dates or amount could not be verified.",409);
    const unusedFraction = Math.max(0,Math.min(1,(end-Math.max(start,at))/(end-start)));
    const prepaidCents=Number(purchase.quote?.prepaidCents ?? total);
    const upgradeCents=Number(purchase.quote?.upgradeAdjustmentCents || 0);
    const upgradeStart=Date.parse(purchase.quote?.upgradeAdjustmentStartsAt || "");
    const upgradeEnd=Date.parse(purchase.quote?.upgradeAdjustmentEndsAt || "");
    const upgradeFraction=Number.isFinite(upgradeStart)&&Number.isFinite(upgradeEnd)&&upgradeEnd>upgradeStart?
      Math.max(0,Math.min(1,(upgradeEnd-Math.max(at,upgradeStart))/(upgradeEnd-upgradeStart))):0;
    const unusedCents=Math.max(0,Math.min(total,
      Math.round(prepaidCents*unusedFraction)+Math.round(upgradeCents*upgradeFraction)));
    return {totalCents:total, unusedCents,
      usedCents:total-unusedCents,
      serviceStartsAt:purchase.serviceStartsAt,prepaidUntil:purchase.renewalAt,
      unusedFraction,hasStarted:at>=start,now:new Date(at).toISOString()};
  }
  async function refundReview(purchaseId, mode) {
    if (!["full","unused"].includes(mode))throw fail("Choose a full refund or unused-time refund.");
    const records=await readPurchases();
    const purchases=Array.isArray(records)?records:[];
    const purchase=purchases.find(p=>p.requestId===purchaseId);
    if(!purchase || !["completed","refunding"].includes(purchase.status))
      throw fail("Completed paid extension not found or already refunded.",404);
    const subsequent=purchases.some(p=>p.subscriptionId===purchase.subscriptionId &&
      p.status==="completed" &&
      Date.parse(p.completedAt || "")>Date.parse(purchase.completedAt || ""));
    if(subsequent)throw fail("A newer extension exists. Reconcile newer purchased terms before refunding this one.",409);
    const quote=refundQuote(purchase);
    const amountCents=purchase.status==="refunding" ? Number(purchase.refundCents) :
      mode==="full"?quote.totalCents:quote.unusedCents;
    if(purchase.status==="refunding" && mode!==purchase.refundMode)
      throw fail("Finish the original pending refund before changing its refund method.",409);
    if(amountCents<1)throw fail("This prepaid term has no unused balance to refund.",409);
    const subscription=await stripe.subscriptions.retrieve(purchase.subscriptionId);
    if(!isOurPrepaidPause(subscription) ||
      subscription.metadata?.sng_last_paid_extension_session!==purchase.sessionId ||
      Number(subscription.pause_collection.resumes_at)*1000 !== Date.parse(purchase.renewalAt))
      throw fail("The live Stripe prepaid schedule no longer matches this purchase. Review it manually.",409);
    if(!purchase.stripePaymentIntentId)
      throw fail("The Stripe payment reference is unavailable. Review this payment manually.",409);
    return {purchases,purchase,quote,subscription,amountCents,mode,
      endsImmediately:quote.hasStarted,
      remainingPriorPaidTermUntil:quote.hasStarted?null:quote.serviceStartsAt};
  }
  app.get("/api/admin/membership-extensions/refunds/:id/quote",requireAdmin,async(req,res)=>{
    try {
      const mode=req.query.mode==="unused"?"unused":"full";
      const review=await refundReview(req.params.id,mode);
      res.set("Cache-Control","no-store").json({ok:true,mode,
        customerAccountId:review.purchase.customerAccountId,
        quote:review.quote,refundCents:review.amountCents,
        endsImmediately:review.endsImmediately,
        priorPaidTermUntil:review.remainingPriorPaidTermUntil});
    }catch(error){jsonError(res,error,"Extension refund preview");}
  });
  app.get("/api/admin/membership-extensions/purchases",requireAdmin,async(_req,res)=>{
    try{
      const rows=await readPurchases();
      res.set("Cache-Control","no-store").json({ok:true,
        purchases:(Array.isArray(rows)?rows:[]).filter(p=>["completed","refunded","refunding"].includes(p.status))
          .map(p=>({id:p.requestId,customerAccountId:p.customerAccountId,
            customerEmail:p.customerEmail||"",
            status:p.status,months:p.months,amountCents:p.amountCents,
            paidAt:p.completedAt,serviceStartsAt:p.serviceStartsAt,renewalAt:p.renewalAt,
            discountCode:p.quote?.discountCode||null,refundCents:p.refundCents||0}))
      });
    }catch(error){jsonError(res,error,"Extension purchases");}
  });
  app.post("/api/admin/membership-extensions/refunds/:id",requireAdmin,async(req,res)=>{
    try{
      if(req.body?.confirmed!==true)throw fail("Confirm the amount and subscription change before refunding.");
      const mode=req.body?.mode==="unused"?"unused":"full";
      const result=await serialized(async()=>{
        const review=await refundReview(req.params.id,mode);
        const {purchases,purchase,subscription,amountCents}=review;
        if (req.body?.expectedAmountCents !== amountCents)
          throw fail("The refund amount has changed. Refresh the quote before approving.",409);
        const refund=purchase.refundId ? await stripe.refunds.retrieve(purchase.refundId)
          : await stripe.refunds.create({
            payment_intent:purchase.stripePaymentIntentId,amount:amountCents,
            reason:"requested_by_customer",
            metadata:{sng_extension_request:purchase.requestId,
              sng_refund_mode:mode}
          },{idempotencyKey:"sng-ext-refund-"+mode+"-"+purchase.sessionId});
        if (!["succeeded","pending"].includes(refund.status))
          throw fail("Stripe did not accept the refund. Review payment status before updating access.",502);
        purchase.status="refunding";
        purchase.refundId=refund.id;purchase.refundCents=amountCents;
        purchase.refundMode=mode;purchase.refundStartedAt=new Date().toISOString();
        await writePurchases(purchases);
        let updated;
        if(review.endsImmediately) {
          updated=await stripe.subscriptions.cancel(subscription.id,
            {invoice_now:false,prorate:false},
            {idempotencyKey:"sng-ext-refund-cancel-"+purchase.sessionId});
        }else{
          updated=await stripe.subscriptions.update(subscription.id,{
            pause_collection:purchase.previousPauseUntil ?
              {behavior:"void",resumes_at:purchase.previousPauseUntil} : "",
            proration_behavior:"none",
            items:[{id:subscription.items.data[0].id,
              price:plans[purchase.currentTier].priceId,quantity:1}],
            metadata:{...subscription.metadata,
              sng_last_paid_extension_session:purchase.previousExtensionSessionId || "",
              sng_last_paid_extension_until:purchase.previousExtensionEndAt || "",
              sng_last_paid_extension_start:purchase.previousExtensionStartAt || ""}
          },{idempotencyKey:"sng-ext-refund-restore-"+purchase.sessionId});
        }
        const paid=await getPaid();
        for(const rec of (Array.isArray(paid)?paid:[])){
          if(String(rec.customerAccountId)!==String(purchase.customerAccountId) ||
             String(rec.stripeSubscriptionId)!==String(subscription.id))continue;
          await applySubscriptionInfo(rec,updated);
          if(!review.endsImmediately){
            rec.plan={tier:purchase.currentTier,name:plans[purchase.currentTier].name,
              profiles:plans[purchase.currentTier].profiles,amount:plans[purchase.currentTier].amount};
          }
          if (purchase.previousPauseUntil && !review.endsImmediately) {
            rec.prepaidThrough=new Date(purchase.previousPauseUntil*1000).toISOString();
            rec.billingDeferredUntil=rec.prepaidThrough;
            rec.currentPeriodEnd=rec.prepaidThrough;
            rec.subscriptionEndDate=rec.prepaidThrough;
          } else {delete rec.prepaidThrough;delete rec.billingDeferredUntil;}
        }
        await savePaid(paid);
        purchase.status="refunded";purchase.refundedAt=new Date().toISOString();
        await writePurchases(purchases);
        broadcast("membership-extension-refund");
        try {await notifyAdminMobile("actionNeeded","Membership extension refunded",
          (review.purchase.customerAccountId)+" — "+(amountCents/100).toFixed(2)+
            " USD ("+mode+")","/admin-app.html","ext-refunded:"+refund.id);}
        catch(error){console.error("Refund notice:",error?.message);}
        return {ok:true,refundId:refund.id,refundCents:amountCents,
          refundStatus:refund.status,mode,subscriptionStatus:updated.status,
          cancelled:review.endsImmediately};
      });
      res.json(result);
    }catch(error){jsonError(res,error,"Extension refund");}
  });
  async function cancel(accountId, mode) {
    const selection = await subscriptionForCancellation(accountId);
    const sub = selection.subscription;
    if (mode === "period_end") {
      if (sub.cancel_at_period_end || sub.cancel_at) return {already:true, subscription:sub};
      // A prepaid term can continue past Stripe's normal monthly invoice cycle.
      // Cancel exactly at the prepaid end, not at an earlier unbilled month.
      const prepaidEnd=isOurPrepaidPause(sub)?paidUntil(sub):0;
      const params=prepaidEnd ? {cancel_at:prepaidEnd,proration_behavior:"none"} :
        {cancel_at_period_end:true};
      const updated = await stripe.subscriptions.update(sub.id, params,
        {idempotencyKey:"sng-cancel-end-" + sub.id + "-" + (prepaidEnd || sub.current_period_end || sub.trial_end || "active")});
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
      res.json({ok:true, cancelAtPeriodEnd:result.subscription.cancel_at_period_end===true ||
        Boolean(result.subscription.cancel_at), endAt:result.subscription.cancel_at ||
        result.subscription.pause_collection?.resumes_at ||
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
        status:result.subscription.status,
        cancelAt:result.subscription.cancel_at || null,
        cancelAtPeriodEnd:result.subscription.cancel_at_period_end === true});
    } catch(error) { jsonError(res,error,"Admin cancellation"); }
  });

  return {fulfill};
}
