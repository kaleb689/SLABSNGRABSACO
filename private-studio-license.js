import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// Licensing metadata only. Never import customer vaults, admin data, cards or profiles.
export const PRIVATE_STUDIO_PRODUCT = "prod_VUB7U1EyHig2l6";
export const PRIVATE_STUDIO_PRICE = "price_1UTD7yAgnoiOBmXPwB5kR3ek";
const ACTIVE = new Set(["active", "trialing"]);
const publicMessage = "Unable to verify license. Check your key and subscription.";
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const safeId = id => String(id || "").slice(0, 150);

export function licenseKey() {
  return "ACOP-" + Array.from({ length: 4 }, () => crypto.randomBytes(8).toString("hex").toUpperCase()).join("-");
}
export function sealKey(key, secret) {
  if (!secret || secret.length < 20) throw Error("The license encryption secret is not configured.");
  const encryptionKey = crypto.hkdfSync("sha256", Buffer.from(secret), Buffer.from("slabsngrabsaco-private-edition"), Buffer.from("license-v1"), 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(buffer => buffer.toString("base64url")).join(".");
}
export function unsealKey(value, secret) {
  const [a, b, c] = String(value || "").split(".");
  if (!a || !b || !c) throw Error("License record is not readable.");
  const encryptionKey = crypto.hkdfSync("sha256", Buffer.from(secret), Buffer.from("slabsngrabsaco-private-edition"), Buffer.from("license-v1"), 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(a, "base64url"));
  decipher.setAuthTag(Buffer.from(b, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(c, "base64url")), decipher.final()]).toString("utf8");
}
export function subscriptionEntitled(subscription) {
  return Boolean(subscription && ACTIVE.has(subscription.status) &&
    subscription.items?.data?.some(item => String(item.price?.id || item.price || "") === PRIVATE_STUDIO_PRICE));
}
export function registerPrivateStudioLicensing({ app, stripe, requireCustomer, requireAdmin, dataDir, baseUrl, secret }) {
  const destination = path.join(dataDir, "private-studio-licenses.json");
  let chain = Promise.resolve();
  const serialize = callback => {
    const task = chain.then(callback, callback);
    chain = task.catch(() => {});
    return task;
  };
  async function read() {
    try {
      const rows = JSON.parse(await fs.readFile(destination, "utf8"));
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
  async function save(rows) {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const tmp = destination + "." + crypto.randomUUID() + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(rows), { mode: 0o600, flag: "wx" });
    await fs.rename(tmp, destination);
  }
  async function subscription(id) {
    if (!String(id || "").startsWith("sub_")) return null;
    return stripe.subscriptions.retrieve(id, { expand: ["items.data.price"] });
  }
  async function ensureFromSession(session) {
    const meta = session?.metadata || {};
    const accountId = safeId(meta.customer_account_id || session.client_reference_id);
    const subscriptionId = safeId(session.subscription);
    if (meta.purchase_type !== "studio_private" || !accountId || !subscriptionId ||
        session.mode !== "subscription" || !session.id) return null;
    const verified = await subscription(subscriptionId);
    if (!subscriptionEntitled(verified)) return null;
    return serialize(async () => {
      const rows = await read();
      const existing = rows.find(row => row.subscriptionId === subscriptionId);
      if (existing) return existing;
      const key = licenseKey();
      const record = { id: crypto.randomUUID(), accountId, subscriptionId,
        stripeCustomerId: safeId(session.customer), keyHash: sha(key),
        sealedKey: sealKey(key, secret), revokedAt: null,
        createdAt: new Date().toISOString() };
      rows.push(record);
      await save(rows);
      return record;
    });
  }
  async function onStripeEvent(event) {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      if (session?.metadata?.purchase_type !== "studio_private") return false;
      await ensureFromSession(session);
      return true;
    }
    return false;
  }
  app.get("/api/studio-private/offer", async (_req, res) => {
    let available = false;
    try {
      const [product, price] = await Promise.all([
        stripe.products.retrieve(PRIVATE_STUDIO_PRODUCT),
        stripe.prices.retrieve(PRIVATE_STUDIO_PRICE)
      ]);
      available = product.active === true && price.active === true && price.unit_amount === 1500 &&
        price.recurring?.interval === "month" && price.product === PRIVATE_STUDIO_PRODUCT;
    } catch {
      // Fail closed until the approved subscription offer is verifiable.
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ name: "ACO Studio Private Edition", amount: 1500, currency: "usd",
      interval: "month", available, platforms: ["mac", "windows"] });
  });
  app.post("/api/account/studio-private/checkout", requireCustomer, async (req, res) => {
    try {
      const account = req.customerAccount;
      if (!account || account.id === "demo") return res.status(403).json({ error: "A real customer account is required." });
      // Purchases remain disabled until verified Mac/Windows builds and privacy gates are available.
      const product = await stripe.products.retrieve(PRIVATE_STUDIO_PRODUCT);
      const price = await stripe.prices.retrieve(PRIVATE_STUDIO_PRICE);
      if (!product.active || !price.active) return res.status(503).json({ error: "ACO Studio Private Edition is not yet available for purchase." });
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: PRIVATE_STUDIO_PRICE, quantity: 1 }],
        client_reference_id: String(account.id),
        customer_email: account.email || undefined,
        success_url: baseUrl + "/?studio_private=success&session_id={CHECKOUT_SESSION_ID}#my-profile",
        cancel_url: baseUrl + "/?studio_private=cancelled#pricing",
        metadata: { purchase_type: "studio_private", customer_account_id: String(account.id) },
        subscription_data: { metadata: { purchase_type: "studio_private", customer_account_id: String(account.id) } }
      });
      res.json({ url: session.url });
    } catch (error) {
      console.error("Studio Private checkout:", error.type || error.name || "stripe_error");
      res.status(502).json({ error: "Could not prepare the secure Stripe checkout." });
    }
  });
  app.post("/api/account/studio-private/claim", requireCustomer, async (req, res) => {
    try {
      if (req.customerAccount?.id === "demo") return res.status(403).json({ error: "Unavailable for demo accounts." });
      const id = String(req.body?.sessionId || "");
      if (!/^cs_(?:test_)?[a-zA-Z0-9_]{12,150}$/.test(id)) return res.status(400).json({ error: "Invalid checkout session." });
      const checkout = await stripe.checkout.sessions.retrieve(id);
      if (checkout.metadata?.purchase_type !== "studio_private" ||
          String(checkout.client_reference_id || checkout.metadata?.customer_account_id) !== String(req.customerAccount.id))
        return res.status(403).json({ error: "That purchase does not belong to this account." });
      const record = await ensureFromSession(checkout);
      if (!record) return res.status(409).json({ error: "The paid subscription is not active yet." });
      res.json({ active: !record.revokedAt, licenseKey: record.revokedAt ? null : unsealKey(record.sealedKey, secret) });
    } catch (error) {
      console.error("Studio Private claim:", error.type || error.name || "claim_error");
      res.status(502).json({ error: "Unable to confirm subscription activation." });
    }
  });
  app.get("/api/account/studio-private/license", requireCustomer, async (req, res) => {
    try {
      if (req.customerAccount?.id === "demo") return res.json({ license: null });
      const rows = (await read()).filter(row => row.accountId === String(req.customerAccount.id));
      const data = await Promise.all(rows.map(async row => {
        const current = await subscription(row.subscriptionId).catch(() => null);
        return { id: row.id, active: !row.revokedAt && subscriptionEntitled(current),
          revoked: !!row.revokedAt, subscriptionStatus: current?.status || "unverified",
          licenseKey: !row.revokedAt && subscriptionEntitled(current) ? unsealKey(row.sealedKey, secret) : null };
      }));
      res.json({ licenses: data, platforms: ["mac", "windows"] });
    } catch (error) {
      console.error("Studio Private customer license:", error.type || error.name || "read_error");
      res.status(502).json({ error: "Unable to read license status." });
    }
  });
  const attempts = new Map();
  app.post("/api/studio-private/license/verify", async (req, res) => {
    const ip = String(req.ip || req.socket.remoteAddress || "").slice(0, 120);
    const now = Date.now();
    const limit = attempts.get(ip) || { first: now, count: 0 };
    if (now - limit.first > 60_000) { limit.first = now; limit.count = 0; }
    limit.count += 1; attempts.set(ip, limit);
    if (limit.count > 15) return res.status(429).json({ active: false, error: "Too many attempts." });
    if (attempts.size > 1500) for (const [key, value] of attempts) if (now - value.first > 60_000) attempts.delete(key);
    try {
      const key = String(req.body?.licenseKey || "");
      if (!/^ACOP-(?:[A-F0-9]{16}-){3}[A-F0-9]{16}$/.test(key))
        return res.status(401).json({ active: false, error: publicMessage });
      const hash = sha(key);
      const row = (await read()).find(record => record.keyHash === hash && !record.revokedAt);
      if (!row) return res.status(401).json({ active: false, error: publicMessage });
      const active = subscriptionEntitled(await subscription(row.subscriptionId));
      if (!active) return res.status(403).json({ active: false, error: "Subscription inactive or license revoked." });
      res.setHeader("Cache-Control", "no-store");
      res.json({ active: true, expiresInSeconds: 900, edition: "private" });
    } catch {
      res.status(503).json({ active: false, error: "License verification is temporarily unavailable." });
    }
  });
  app.post("/api/admin/studio-private/revoke", requireAdmin, async (req, res) => {
    const id = safeId(req.body?.licenseId);
    if (!id) return res.status(400).json({ error: "Select a license." });
    const revoked = await serialize(async () => {
      const rows = await read();
      const row = rows.find(item => item.id === id);
      if (!row) return false;
      row.revokedAt = row.revokedAt || new Date().toISOString();
      await save(rows);
      return true;
    });
    return res.status(revoked ? 200 : 404).json({ revoked });
  });
  app.get("/api/admin/studio-private/licenses", requireAdmin, async (_req, res) => {
    const rows = await read();
    // Admin receives license state only, never the key or any private workstation data.
    res.json({ licenses: rows.map(row => ({ id: row.id, accountId: row.accountId,
      subscriptionId: row.subscriptionId, revoked: Boolean(row.revokedAt), createdAt: row.createdAt })) });
  });
  return { onStripeEvent };
}
