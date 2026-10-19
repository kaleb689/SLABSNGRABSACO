import { savedDataRevision } from "./saved-data-revisions.js";

/*
 * Customer-owned payment records can originate in the current vault, a paid
 * profile, or an older checkout package. This is one permission-checked write
 * path for the website, app, and authenticated ACO Studio bridge.
 *
 * Historical checkout packages remain immutable: a per-customer encrypted
 * vault override replaces or hides their saved-card projection instead.
 */
export function createCustomerPaymentActions({
  getCustomerVault, saveCustomerVault,
  getRetailerProfiles, saveRetailerProfiles,
  getPaidOrders, loadEncryptedPackage,
  decryptJson, encryptJson,
  sanitizeSavedPaymentMethod, validSavedPaymentMethod
}) {
  const error = (status, message) => Object.assign(new Error(message), {status});
  const eq = (a, b) => String(a ?? "") === String(b ?? "");
  const digits = item => String(item?.acoCardNumber || item?.cardNumber || "").replace(/\D/g, "");
  const own = (record, accountId) => eq(record?.customerAccountId, accountId);
  const fields = card => ({
    cardLabel: card?.cardLabel || "",
    cardholder: card?.cardholder || "",
    acoCardNumber: card?.acoCardNumber || "",
    cardNumber: card?.acoCardNumber || "",
    expMonth: card?.expMonth || "",
    expYear: card?.expYear || ""
  });
  const erased = fields({});
  function checkRevision(actual, supplied) {
    if (typeof supplied !== "string" || !supplied.trim()) {
      throw error(428, "Reopen the latest payment record before editing or deleting it.");
    }
    if (savedDataRevision("payment", actual) !== supplied) {
      throw error(409, "This payment card changed on another device. Reload it before saving; nothing was overwritten.");
    }
  }

  async function select(accountId, requestedId) {
    const id = String(requestedId || "").trim().slice(0, 150);
    if (!id) throw error(404, "Payment card not found.");
    const vault = await getCustomerVault(accountId);
    const index = (vault.paymentMethods || []).findIndex(item => eq(item.id, id));
    if (index >= 0) return {source: "saved", id, accountId, vault, index,
      current: vault.paymentMethods[index]};

    if (id.startsWith("paid-profile-card:")) {
      const profileId = id.slice("paid-profile-card:".length);
      const profiles = await getRetailerProfiles();
      const index = profiles.findIndex(item => eq(item.id, profileId) && own(item, accountId));
      if (index < 0) throw error(404, "This customer's profile card was not found.");
      const current = profiles[index].customerSecrets
        ? decryptJson(profiles[index].customerSecrets) || {} : {};
      if (!digits(current)) throw error(404, "This profile has no saved card.");
      return {source: "paid_profile", id, accountId, vault, profiles, index, current};
    }

    if (id.startsWith("paid-order-card:")) {
      const sourceId = id.slice("paid-order-card:".length);
      const orders = (await getPaidOrders() || []).filter(record => own(record, accountId));
      const order = orders.find((item, index) => eq(item.id || index + 1, sourceId));
      if (!order?.id) throw error(404, "This customer's historical card was not found.");
      const override = vault.paymentOverrides?.[id];
      if (override?.deleted === true) throw error(404, "This card was already deleted.");
      const original = await loadEncryptedPackage(order.id);
      const current = override?.payment || original || {};
      if (!digits(current)) throw error(404, "This checkout has no saved card.");
      return {source: "paid_order", id, accountId, vault, current};
    }

    throw error(404, "Payment card not found in this customer account.");
  }

  async function syncLinkedProfiles(accountId, paymentId, card, removing) {
    const profiles = await getRetailerProfiles();
    let changed = false;
    for (const profile of profiles) {
      if (!own(profile, accountId) || !eq(profile.selectedPaymentId, paymentId)) continue;
      const existing = profile.customerSecrets
        ? decryptJson(profile.customerSecrets) || {} : {};
      const nextCard = removing ? erased : fields(card);
      // A jigged profile keeps its own profile/cardholder identity.
      if (!removing) {
        const jiggedName = [profile.customerProfile?.firstName, profile.customerProfile?.lastName]
          .filter(Boolean).join(" ").trim();
        if (jiggedName) nextCard.cardholder = jiggedName;
      }
      profile.customerSecrets = encryptJson({...existing, ...nextCard});
      if (removing) profile.selectedPaymentId = null;
      profile.updatedAt = new Date().toISOString();
      changed = true;
    }
    if (changed) await saveRetailerProfiles(profiles);
  }

  async function mutate({accountId, id, body = {}, expectedRevision, action}) {
    if (!accountId || !["update", "delete"].includes(action)) {
      throw error(400, "Invalid payment update.");
    }
    const selected = await select(accountId, id);
    checkRevision(selected.current, expectedRevision);
    const removing = action === "delete";
    const next = removing ? null : sanitizeSavedPaymentMethod(body, selected.current);
    if (!removing && !validSavedPaymentMethod(next)) {
      throw error(400, "Enter a cardholder, valid card number, expiration month and expiration year.");
    }

    if (selected.source === "saved") {
      if (removing) selected.vault.paymentMethods.splice(selected.index, 1);
      else selected.vault.paymentMethods[selected.index] = next;
      await saveCustomerVault(accountId, selected.vault);
      await syncLinkedProfiles(accountId, selected.id, next, removing);
    } else if (selected.source === "paid_profile") {
      const profile = selected.profiles[selected.index];
      profile.customerSecrets = encryptJson({
        ...selected.current, ...(removing ? erased : fields(next))
      });
      if (removing && eq(profile.selectedPaymentId, selected.id)) {
        profile.selectedPaymentId = null;
      }
      profile.updatedAt = new Date().toISOString();
      await saveRetailerProfiles(selected.profiles);
    } else {
      const overrides = {...(selected.vault.paymentOverrides || {})};
      overrides[selected.id] = removing
        ? {deleted: true, updatedAt: new Date().toISOString()}
        : {payment: {
          ...fields(next),
          cardLabel: next.cardLabel,
          cardholder: next.cardholder,
          createdAt: next.createdAt,
          updatedAt: next.updatedAt
        }};
      selected.vault.paymentOverrides = overrides;
      await saveCustomerVault(accountId, selected.vault);
    }

    return {ok: true, id: selected.id, source: selected.source,
      message: removing ? "Payment card deleted." : "Payment card updated."};
  }

  return {
    update: args => mutate({...args, action: "update"}),
    remove: args => mutate({...args, action: "delete"})
  };
}
