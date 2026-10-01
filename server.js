import express from "express";
import { sameCheckout, reconcileWebhookCheckout, reconcileEmailCheckoutIdentity, uniqueCheckoutOwner } from "./webhook-success.js";
import { updateMatchingImap, effectiveAdminImap } from "./imap-credential-sync.js";
import { correctedMembershipPrice } from "./membership-prices.js";
import { mailboxFailureReason, normalizeImapPassword, protectImapClient, savedSuccessMailboxes } from "./mailbox-sync.js";
import Stripe from "stripe";
import { authenticator } from "otplib";
import {
  ImapFlow,
  AuthenticationFailure
} from "imapflow";
import {
  simpleParser
} from "mailparser";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDiscordCommunity, discordCommunityStatus, createDiscordLinkCode, revokeDiscordLinkCodes, queueDiscordRoleRemoval } from "./discord-community.js";
import { getCommunityInvite } from "./discord-invite.js";
import { membershipDiscountOptions, activeSitewideDiscount } from "./checkout-discounts.js";
import { safeAddressVariants, safeAddressVariantKey, defaultJigVariants } from "./address-jigs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const adminLiveDataListeners = new Set();
const customerLiveDataListeners = new Set();

function sendLiveDataEvent(listeners, detail = "data") {
  const payload = JSON.stringify({
    detail,
    at: new Date().toISOString()
  });

  for (const response of listeners) {
    try {
      response.write(`event: data-change\ndata: ${payload}\n\n`);
    } catch {
      listeners.delete(response);
    }
  }
}

function broadcastLiveDataChange(detail = "data") {
  sendLiveDataEvent(adminLiveDataListeners, detail);
  sendLiveDataEvent(customerLiveDataListeners, detail);
}

/*
  Any successful customer/admin mutation should become visible in other
  open sessions without a full page reload. Read requests never emit an
  update, which prevents dashboard refresh loops.
*/
app.use((req, res, next) => {
  const method = String(req.method || "").toUpperCase();
  const mutation =
    !["GET", "HEAD", "OPTIONS"].includes(method) &&
    (
      req.path.startsWith("/api/admin/") ||
      req.path.startsWith("/api/account/") ||
      req.path === "/webhook" ||
      req.path.startsWith("/api/webhook") ||
      req.path.startsWith("/stripe")
    );

  if (mutation) {
    res.once("finish", () => {
      if (res.statusCode >= 200 && res.statusCode < 400) {
        broadcastLiveDataChange(`${method} ${req.path}`);
      }
    });
  }

  next();
});

/*
  Render sits behind a trusted reverse proxy.
  This makes req.ip and req.protocol use the first trusted proxy hop
  instead of user-controlled forwarded values.
*/
app.set("trust proxy", 1);
app.set("query parser", "simple");
app.disable("x-powered-by");

const PORT = process.env.PORT || 4242;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const DATA_DIR = process.env.DATA_DIR || "/var/data/slabsngrabsaco";

const PENDING_FILE = path.join(DATA_DIR, "pending-submissions.json");
const PAID_FILE = path.join(DATA_DIR, "paid-submissions.json");
const SECRET_DIR = path.join(DATA_DIR, "secure-packages");
// Separate from customer records so routine account cleanup cannot erase
// signup and checkout consent evidence. Each line is encrypted and chained.
const CONSENT_LEDGER_FILE = path.join(SECRET_DIR, "signup-consent-ledger.jsonl");
const CONSENT_EMAIL_QUEUE_FILE = path.join(SECRET_DIR, "consent-email-queue.json");
const CONSENT_RECEIPT_EMAIL = "Kaleb@slabsngrabs.com";
// Customer-owned address variants remain here when a rented or gifted
// managed account expires and its customer details are cleared.
const CUSTOMER_JIG_POOL_DIR = path.join(SECRET_DIR, "jig-pools");
const CUSTOMER_ACCOUNTS_FILE =
  path.join(
    DATA_DIR,
    "customer-accounts.json"
  );

const PASSWORD_RESET_FILE =
  path.join(
    DATA_DIR,
    "password-reset-tokens.json"
  );

const EMAIL_VERIFY_FILE =
  path.join(
    DATA_DIR,
    "email-verification-tokens.json"
  );

const ORDER_CLAIM_FILE =
  path.join(
    DATA_DIR,
    "order-claim-tokens.json"
  );

const RETAILER_PROFILES_FILE =
  path.join(
    DATA_DIR,
    "retailer-profiles.json"
  );

const SPECIAL_PROFILES_FILE =
  path.join(
    DATA_DIR,
    "special-profiles.json"
  );

const MANAGED_ACCOUNTS_FILE =
  path.join(
    DATA_DIR,
    "managed-accounts.json"
  );

const RENTED_MEMBERSHIPS_FILE =
  path.join(
    DATA_DIR,
    "rented-memberships.json"
  );

const RENTAL_ASSIGNMENTS_FILE =
  path.join(
    DATA_DIR,
    "rental-assignments.json"
  );

const FREE_MEMBERSHIPS_FILE =
  path.join(
    DATA_DIR,
    "free-memberships.json"
  );

const FREE_ASSIGNMENTS_FILE =
  path.join(
    DATA_DIR,
    "free-assignments.json"
  );

// Admin-issued membership grants and checkout discounts are kept separate
// from Stripe records so a grant never mutates a customer's paid history.
const GIFTED_MEMBERSHIPS_FILE =
  path.join(DATA_DIR, "gifted-memberships.json");

const DISCOUNT_CODES_FILE =
  path.join(DATA_DIR, "discount-codes.json");

const SITE_NOTIFICATION_FILE =
  path.join(DATA_DIR, "site-notification.json");

const RESTORE_HOLDS_FILE =
  path.join(
    DATA_DIR,
    "managed-restore-holds.json"
  );

const DELETED_MANAGED_LOGINS_FILE = path.join(DATA_DIR, "managed-deleted-logins.json");

const SUCCESS_CHECKOUTS_FILE =
  path.join(
    DATA_DIR,
    "success-checkouts.json"
  );

const SUCCESS_CHECKOUTS_TEST_FILE =
  path.join(
    DATA_DIR,
    "success-checkouts-test.json"
  );

const SECURITY_AUDIT_FILE =
  path.join(
    DATA_DIR,
    "security-audit.jsonl"
  );

const CUSTOMER_SESSION_COOKIE =
  "sng_customer";

const CUSTOMER_SESSION_MAX_AGE =
  30 * 24 * 60 * 60;

const ADMIN_SESSION_MAX_AGE_MS =
  8 * 60 * 60 * 1000;

const ADMIN_SESSION_IDLE_MS =
  2 * 60 * 60 * 1000;

const SECURE_COOKIES =
  String(BASE_URL)
    .toLowerCase()
    .startsWith("https://");

const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY || "sk_test_missing"
);

/* -------------------------------------------------------
   MEMBERSHIP PLANS
------------------------------------------------------- */

const PLANS = {
  1: {
    name: "Starter",
    profiles: 1,
    amount: 10,
    priceId: process.env.STRIPE_TIER1_PRICE_ID
  },

  2: {
    name: "Intermediate",
    profiles: 2,
    amount: 15,
    priceId: process.env.STRIPE_TIER2_PRICE_ID
  },

  3: {
    name: "Advanced",
    profiles: 3,
    amount: 25,
    priceId: process.env.STRIPE_TIER3_PRICE_ID
  },

  4: {
    name: "Pro",
    profiles: 5,
    amount: 45,
    priceId: process.env.STRIPE_TIER4_PRICE_ID
  },

  5: {
    name: "High Volume",
    profiles: 10,
    amount: 80,
    priceId: process.env.STRIPE_TIER5_PRICE_ID
  },

  6: {
    name: "Power User",
    profiles: 20,
    amount: 150,
    priceId: process.env.STRIPE_TIER6_PRICE_ID
  },

  7: {
    name: "Elite",
    profiles: 50,
    amount: 290,
    priceId: process.env.STRIPE_TIER7_PRICE_ID
  }
};

const RENTAL_PACKAGES = {
  1: {
    "1_drop": {
      amount: null,
      priceId: "price_1UKg5ZAgnoiOBmXPp9n8sw3B"
    },
    "1_week": {
      amount: null,
      priceId: "price_1UKg3sAgnoiOBmXPXhO2BFWZ"
    },
    "1_month": {
      amount: null,
      priceId: "price_1UKg80AgnoiOBmXPLWkkSYkm"
    }
  },
  5: {
    "1_drop": {
      amount: 10,
      priceId:
        process.env.FIVE_ACCOUNTS_1_DROP
    },
    "1_week": {
      amount: 25,
      priceId:
        process.env.FIVE_ACCOUNTS_1_WEEK
    },
    "1_month": {
      amount: 60,
      priceId:
        process.env.FIVE_ACCOUNTS_1_MONTH
    }
  },

  10: {
    "1_drop": {
      amount: 20,
      priceId:
        process.env.TEN_ACCOUNTS_1_DROP
    },
    "1_week": {
      amount: 50,
      priceId:
        process.env.TEN_ACCOUNTS_1_WEEK
    },
    "1_month": {
      amount: 120,
      priceId:
        process.env.TEN_ACCOUNTS_1_MONTH
    }
  },

  15: {
    "1_drop": {
      amount: 30,
      priceId:
        process.env.FIFTEEN_ACCOUNTS_1_DROP
    },
    "1_week": {
      amount: 75,
      priceId:
        process.env.FIFTEEN_ACCOUNTS_1_WEEK
    },
    "1_month": {
      amount: 180,
      priceId:
        process.env.FIFTEEN_ACCOUNTS_1_MONTH
    }
  }
};

function rentalPackageFor(
  quantity,
  durationType
) {
  return (
    RENTAL_PACKAGES?.[quantity]
      ?.[durationType] ?? null
  );
}

function rentalPriceFor(
  quantity,
  durationType
) {
  return (
    rentalPackageFor(
      quantity,
      durationType
    )?.amount ?? null
  );
}

async function synchronizeMembershipPrices() {
  const file = path.join(SECRET_DIR, "membership-stripe-prices.json");
  const cached = await readJson(file, {});
  for (const tier of [5, 6, 7]) {
    const plan = PLANS[tier];
    if (!plan.priceId) continue;
    const originalId = plan.priceId;
    try {
      const result = await correctedMembershipPrice(stripe, tier, plan, cached[tier]);
      plan.legacyPrices = { [originalId]: result.original.unit_amount / 100 };
      plan.priceId = result.price.id;
      cached[tier] = result.price.id;
      console.log("Membership Stripe price verified:", JSON.stringify({ tier, profiles: plan.profiles, amount: result.price.unit_amount / 100 }));
    } catch (error) {
      plan.legacyPrices = { [originalId]: { 5: 70, 6: 100, 7: 215 }[tier] };
      plan.priceId = null;
      console.error("Membership price verification failed:", JSON.stringify({ tier, reason: error?.code || "price_configuration_error" }));
    }
  }
  await writeJson(file, cached);
}

app.get("/api/public/membership-prices", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ tiers: Object.entries(PLANS).map(([tier, plan]) => ({ tier: Number(tier), profiles: plan.profiles, amount: plan.amount, checkoutReady: Boolean(plan.priceId) })) });
});

function rentalPriceIdFor(
  quantity,
  durationType
) {
  return (
    rentalPackageFor(
      quantity,
      durationType
    )?.priceId || null
  );
}

async function rentalAmountFor(quantity, durationType) {
  const rentalPackage = rentalPackageFor(quantity, durationType);
  if (!rentalPackage?.priceId) return null;
  if (rentalPackage.amount != null) return rentalPackage.amount;

  const price = await stripe.prices.retrieve(rentalPackage.priceId);
  if (!price.active || price.currency !== "usd" || price.type !== "one_time" ||
      !Number.isInteger(price.unit_amount) || price.unit_amount <= 0) {
    throw new Error(`Rental Stripe price is invalid: ${rentalPackage.priceId}`);
  }
  return price.unit_amount / 100;
}

function normalizeRentalRetailer(
  value
) {
  const retailer =
    String(value || "")
      .trim()
      .toLowerCase();

  return [
    "target",
    "walmart",
    "pokemoncenter"
  ].includes(retailer)
    ? retailer
    : null;
}

/* -------------------------------------------------------
   SECURITY HEADERS / REQUEST IDENTIFIERS
------------------------------------------------------- */

function requestIsHttps(req) {
  return (
    req.secure === true ||
    String(
      req.headers[
        "x-forwarded-proto"
      ] || ""
    )
      .split(",")[0]
      .trim()
      .toLowerCase() ===
      "https"
  );
}


let adminInlineScriptHashesCache =
  null;


function adminInlineScriptHashes() {
  if (
    adminInlineScriptHashesCache
  ) {
    return adminInlineScriptHashesCache;
  }

  try {
    const html =
      fsSync.readFileSync(
        path.join(
          __dirname,
          "public",
          "admin.html"
        ),
        "utf8"
      );

    const hashes = [];

    const pattern =
      /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;

    let match;

    while (
      (
        match =
          pattern.exec(
            html
          )
      )
    ) {
      const content =
        match[1];

      const hash =
        crypto
          .createHash(
            "sha256"
          )
          .update(
            content,
            "utf8"
          )
          .digest(
            "base64"
          );

      hashes.push(
        `'sha256-${hash}'`
      );
    }

    adminInlineScriptHashesCache =
      hashes;

    return hashes;

  } catch (error) {
    console.error(
      "Unable to calculate Admin CSP script hash:",
      error?.message ||
      "csp_hash_error"
    );

    return [];
  }
}


function contentSecurityPolicyFor(
  req
) {
  const successDemoDocument = req.path === "/" && req.query.successDemo === "1";
  const adminDocument =
    req.path === "/admin" ||
    req.path === "/admin.html";

  const adminHashes =
    adminDocument
      ? adminInlineScriptHashes()
      : [];

  const scriptPolicy =
    adminDocument
      ? `script-src 'self' ${adminHashes.join(
          " "
        )}`
      : "script-src 'self'";

  const directives = [
    "default-src 'self'",
    scriptPolicy,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    successDemoDocument ? "frame-ancestors 'self'" : "frame-ancestors 'none'",
    "form-action 'self'"
  ];

  if (requestIsHttps(req)) {
    directives.push(
      "upgrade-insecure-requests"
    );
  }

  return directives.join("; ");
}


app.use((req, res, next) => {
  const requestId =
    crypto
      .randomBytes(12)
      .toString("hex");

  req.securityRequestId =
    requestId;

  res.setHeader(
    "X-Request-ID",
    requestId
  );

  res.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );

  res.setHeader(
    "X-Frame-Options",
    req.path === "/" && req.query.successDemo === "1" ? "SAMEORIGIN" : "DENY"
  );

  res.setHeader(
    "Referrer-Policy",
    "no-referrer"
  );

  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()"
  );

  res.setHeader(
    "Cross-Origin-Opener-Policy",
    "same-origin"
  );

  res.setHeader(
    "Cross-Origin-Resource-Policy",
    "same-origin"
  );

  res.setHeader(
    "X-Permitted-Cross-Domain-Policies",
    "none"
  );

  res.setHeader(
    "Content-Security-Policy",
    contentSecurityPolicyFor(
      req
    )
  );

  if (requestIsHttps(req)) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000"
    );
  }

  const sensitivePath =
    req.path === "/admin" ||
    req.path === "/admin.html" ||
    req.path.startsWith(
      "/api/admin/"
    ) ||
    req.path.startsWith(
      "/api/account/"
    ) ||
    req.path === "/api/my-profile";

  if (sensitivePath) {
    res.setHeader(
      "Cache-Control",
      "no-store, private, max-age=0"
    );

    res.setHeader(
      "Pragma",
      "no-cache"
    );

    res.setHeader(
      "X-Robots-Tag",
      "noindex, nofollow, noarchive"
    );
  }

  next();
});


/* -------------------------------------------------------
   FILE HELPERS
------------------------------------------------------- */

async function readJson(file, fallback) {
  try {
    return JSON.parse(
      await fs.readFile(file, "utf8")
    );
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  const directory =
    path.dirname(file);

  await fs.mkdir(
    directory,
    {
      recursive: true,
      mode: 0o700
    }
  );

  const temporaryFile =
    `${file}.${process.pid}.${crypto
      .randomBytes(6)
      .toString("hex")}.tmp`;

  await fs.writeFile(
    temporaryFile,
    JSON.stringify(
      value,
      null,
      2
    ),
    {
      encoding: "utf8",
      mode: 0o600
    }
  );

  await fs.rename(
    temporaryFile,
    file
  );

  try {
    await fs.chmod(
      file,
      0o600
    );
  } catch {
    // Some mounted filesystems may not support chmod.
  }
}


function auditHash(value) {
  return crypto
    .createHash("sha256")
    .update(
      String(
        value ||
        ""
      )
    )
    .digest("hex")
    .slice(0, 20);
}


async function appendSecurityAudit(
  event = {}
) {
  try {
    await fs.mkdir(
      DATA_DIR,
      {
        recursive: true,
        mode: 0o700
      }
    );

    const entry = {
      at:
        new Date()
          .toISOString(),

      event:
        String(
          event.event ||
          "security_event"
        )
          .slice(0, 100),

      requestId:
        String(
          event.requestId ||
          ""
        )
          .slice(0, 64),

      method:
        String(
          event.method ||
          ""
        )
          .slice(0, 12),

      path:
        String(
          event.path ||
          ""
        )
          .slice(0, 300),

      status:
        Number(
          event.status ||
          0
        ) || undefined,

      ipHash:
        event.ip
          ? auditHash(
              event.ip
            )
          : "",

      userAgentHash:
        event.userAgent
          ? auditHash(
              event.userAgent
            )
          : "",

      subjectHash:
        event.subject
          ? auditHash(
              event.subject
            )
          : "",

      detail:
        event.detail
          ? String(
              event.detail
            )
              .slice(
                0,
                300
              )
          : ""
    };

    await fs.appendFile(
      SECURITY_AUDIT_FILE,
      `${JSON.stringify(
        entry
      )}\n`,
      {
        encoding: "utf8",
        mode: 0o600
      }
    );

    try {
      await fs.chmod(
        SECURITY_AUDIT_FILE,
        0o600
      );
    } catch {
      // Ignore chmod limitations on mounted filesystems.
    }

  } catch (error) {
    console.error(
      "Security audit write failed:",
      error?.message ||
      "audit_write_error"
    );
  }
}


function redactLogValue(
  value,
  depth = 0
) {
  if (
    value == null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "string") {
    return value
      .replace(
        /\b(?:\d[ -]*?){12,19}\b/g,
        "[REDACTED_CARD]"
      )
      .replace(
        /(password|security\s*code|authorization|cookie|token|secret)\s*[:=]\s*[^\s,;]+/gi,
        "$1=[REDACTED]"
      );
  }

  if (value instanceof Error) {
    return {
      name:
        value.name,

      message:
        redactLogValue(
          value.message,
          depth + 1
        )
    };
  }

  if (
    depth > 3 ||
    typeof value !== "object"
  ) {
    return "[REDACTED_OBJECT]";
  }

  const output =
    Array.isArray(value)
      ? []
      : {};

  const sensitiveKeys =
    new Set([
      "password",
      "pass",
      "acopassword",
      "cardnumber",
      "acocardnumber",
      "securitycode",
      "cvv",
      "cvc",
      "authorization",
      "cookie",
      "token",
      "rawtoken",
      "secret",
      "webhook",
      "credentials"
    ]);

  for (
    const [
      key,
      item
    ] of Object.entries(value)
  ) {
    const normalized =
      String(key)
        .toLowerCase()
        .replace(
          /[^a-z0-9]/g,
          ""
        );

    output[key] =
      sensitiveKeys.has(
        normalized
      )
        ? "[REDACTED]"
        : redactLogValue(
            item,
            depth + 1
          );
  }

  return output;
}


/*
  Existing code has many defensive error logs. Sanitize those logs
  centrally so a thrown provider/Stripe/mail error cannot accidentally
  place credentials, cookies or full payment values into Render logs.
*/
const originalConsoleError =
  console.error.bind(
    console
  );

console.error = (
  ...args
) => {
  originalConsoleError(
    ...args.map(
      value =>
        redactLogValue(
          value
        )
    )
  );
};


function normalizeAddressTokenText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function customerJigPoolPath(accountId) {
  return path.join(CUSTOMER_JIG_POOL_DIR, `customer-${String(accountId)}.encrypted.json`);
}

async function getCustomerJigPool(accountId) {
  const encrypted = await readJson(customerJigPoolPath(accountId), null);
  if (!encrypted) return { sources: [] };
  const pool = decryptJson(encrypted);
  return { ...pool, sources: Array.isArray(pool?.sources) ? pool.sources : [] };
}

async function saveCustomerJigPool(accountId, pool) {
  await writeJson(customerJigPoolPath(accountId), encryptJson(pool));
}

function jigSourceAddress(item = {}) {
  return {
    firstName: clean(item.firstName, 100), lastName: clean(item.lastName, 100),
    phone: clean(item.phone, 50), address: normalizeAddressTokenText(item.address),
    address2: normalizeAddressTokenText(item.address2), city: normalizeAddressTokenText(item.city),
    state: normalizeAddressTokenText(item.state), zip: normalizeAddressTokenText(item.zip),
    country: normalizeAddressTokenText(item.country || "US")
  };
}

async function customerJigPoolWithSources(account, order, paidProfiles) {
  const pool = await getCustomerJigPool(account.id);
  const sourceInputs = [
    { label: "Main address", address: order?.profile },
    { label: "Account address", address: account.adminProfile },
    ...(Array.isArray(account.shippingAddresses) ? account.shippingAddresses : []).map((address, index) => ({
      label: address.label || `Saved address ${index + 1}`, address
    })),
    ...paidProfiles.map((record, index) => ({
      label: `Paid profile ${index + 1}`, address: record.jigSourceAddress || record.customerProfile
    }))
  ];
  let changed = false;
  for (const input of sourceInputs) {
    const original = jigSourceAddress(input.address);
    if (!original.address || !original.city || !original.state || !original.zip) continue;
    const key = safeAddressVariantKey(original);
    if (pool.sources.some(source => safeAddressVariantKey(source.original) === key)) continue;
    pool.sources.push({ id: crypto.randomUUID(), label: input.label, original, variants: [] });
    changed = true;
  }
  // Save available variants for every source, even before a profile uses it.
  // Generate once so a manually edited variant is not regenerated afterward.
  for (const source of pool.sources) {
    if (source.generatedSafeVariantsAt) continue;
    source.variants ||= [];
    const existingKeys = new Set(source.variants.map(item => safeAddressVariantKey(item.address)));
    const originalKey = safeAddressVariantKey(source.original);
    for (const address of defaultJigVariants(source.original, 4, new Set(source.excludedVariantKeys || []))) {
      if (source.variants.length >= 4) break;
      const key = safeAddressVariantKey(address);
      if (key === originalKey || existingKeys.has(key)) continue;
      source.variants.push({ id: crypto.randomUUID(), address });
      existingKeys.add(key);
    }
    source.generatedSafeVariantsAt = new Date().toISOString();
    changed = true;
  }
  if (changed) await saveCustomerJigPool(account.id, pool);
  return pool;
}

function jigVariantAllowed(original, candidate) {
  const key = safeAddressVariantKey(candidate);
  return safeAddressVariants(original).some(variant => safeAddressVariantKey(variant) === key);
}

async function prepareNewManagedAssignment(assignment, membership, account, order, reserved = new Set()) {
  if (!account || !assignment) return;
  const paidProfiles = (await getRetailerProfiles()).filter(item =>
    String(item.customerAccountId || "") === String(account.id)
  );
  const pool = await customerJigPoolWithSources(account, order, paidProfiles);
  const [free, rented, details] = await Promise.all([
    getFreeAssignments(), getRentalAssignments(), adminCustomerSavedDetailsPayload(account)
  ]);
  for (const record of [...paidProfiles, ...free, ...rented]) {
    if (record === assignment || String(record.customerAccountId || "") !== String(account.id)) continue;
    if (record.customerProfile?.address) reserved.add(safeAddressVariantKey(record.customerProfile));
    for (const key of record.jigHistoryKeys || []) reserved.add(key);
  }
  const sources = pool.sources;
  let selected = null;
  for (const source of sources) {
    const variants = [
      ...(source.variants || []).map(item => ({ ...item.address, jigPoolVariantId: item.id }))
    ];
    selected = variants.find(item => !reserved.has(safeAddressVariantKey(item)))
      ? { source, variant: variants.find(item => !reserved.has(safeAddressVariantKey(item))) } : null;
    if (selected) break;
  }
  const email = String(membership?.accountEmail || managedAccountCanonicalEmail(membership) || "").trim();
  assignment.customerProfile = {
    ...(assignment.customerProfile || {}),
    email,
    ...(selected ? { ...selected.source.original, ...selected.variant, email } : {
      address: "", address2: "", city: "", state: "", zip: ""
    })
  };
  assignment.jigNeeded = !selected;
  if (selected) {
    const key = safeAddressVariantKey(selected.variant);
    reserved.add(key);
    let savedVariant = (selected.source.variants || []).find(item => safeAddressVariantKey(item.address) === key);
    if (!savedVariant) {
      savedVariant = { id: crypto.randomUUID(), address: {
        address: selected.variant.address, address2: selected.variant.address2,
        city: selected.variant.city, state: selected.variant.state,
        zip: selected.variant.zip, country: selected.variant.country
      } };
      selected.source.variants.push(savedVariant);
      await saveCustomerJigPool(account.id, pool);
    }
    assignment.jigSourceKey = selected.source.id;
    assignment.jigSourceAddress = { ...selected.source.original };
    assignment.jiggedAddress = { ...savedVariant.address };
    assignment.jigPoolVariantId = savedVariant.id;
    assignment.jigHistoryKeys = [...new Set([...(assignment.jigHistoryKeys || []), key])];
  }
  const cards = details.paymentMethods || [];
  const card = cards[reserved.size % (cards.length || 1)];
  if (card?.acoCardNumber) {
    assignment.customerSecrets = encryptJson({
      cardLabel: card.cardLabel || "", cardholder: card.cardholder || "",
      acoCardNumber: card.acoCardNumber, expMonth: card.expMonth || "",
      expYear: card.expYear || "", securityCode: card.securityCode || ""
    });
    assignment.savedPaymentMethodId = card.id || null;
  } else {
    assignment.customerSecrets = null;
  }
}


const clean = (value, max = 300) =>
  String(value ?? "")
    .trim()
    .slice(0, max);

/* -------------------------------------------------------
   STRIPE SUBSCRIPTION HELPERS
------------------------------------------------------- */

function stripeTimestampToIso(value) {
  const timestamp = Number(value);

  if (
    !Number.isFinite(timestamp) ||
    timestamp <= 0
  ) {
    return null;
  }

  return new Date(
    timestamp * 1000
  ).toISOString();
}

async function getSubscriptionPeriodEnd(subscription) {
  if (subscription?.current_period_end) {
    return stripeTimestampToIso(
      subscription.current_period_end
    );
  }

  let items =
    subscription?.items?.data || [];

  /*
    If Stripe's subscription response doesn't
    contain the billing-period fields, retrieve
    the subscription items directly.
  */

  if (
    subscription?.id &&
    !items.some(
      item => item?.current_period_end
    )
  ) {
    const itemList =
      await stripe.subscriptionItems.list({
        subscription: subscription.id,
        limit: 100
      });

    items =
      itemList?.data || [];
  }

  const periodEnds =
    items
      .map(item =>
        Number(
          item?.current_period_end
        )
      )
      .filter(value =>
        Number.isFinite(value) &&
        value > 0
      );

  if (!periodEnds.length) {
    return null;
  }

  return stripeTimestampToIso(
    Math.max(...periodEnds)
  );
}

async function getSubscriptionPeriodStart(subscription) {
  if (subscription?.current_period_start) {
    return stripeTimestampToIso(
      subscription.current_period_start
    );
  }

  let items =
    subscription?.items?.data || [];

  if (
    subscription?.id &&
    !items.some(
      item => item?.current_period_start
    )
  ) {
    const itemList =
      await stripe.subscriptionItems.list({
        subscription: subscription.id,
        limit: 100
      });

    items =
      itemList?.data || [];
  }

  const periodStarts =
    items
      .map(item =>
        Number(
          item?.current_period_start
        )
      )
      .filter(value =>
        Number.isFinite(value) &&
        value > 0
      );

  if (!periodStarts.length) {
    return null;
  }

  return stripeTimestampToIso(
    Math.min(...periodStarts)
  );
}

function stripePriceIdFromSubscription(
  subscription
) {
  const items =
    subscription
      ?.items
      ?.data || [];

  const item =
    items.find(
      entry =>
        entry?.price
    );

  if (!item) {
    return "";
  }

  if (
    typeof item.price ===
    "string"
  ) {
    return item.price;
  }

  return String(
    item.price?.id ||
    ""
  );
}


function planForStripePriceId(
  priceId
) {
  const normalizedPriceId =
    String(
      priceId || ""
    );

  if (!normalizedPriceId) {
    return null;
  }

  for (
    const [
      tierValue,
      plan
    ] of Object.entries(
      PLANS
    )
  ) {
    if (
      (String(plan.priceId || "") === normalizedPriceId ||
        Object.hasOwn(plan.legacyPrices || {}, normalizedPriceId))
    ) {
      return {
        tier:
          Number(
            tierValue
          ),

        name:
          plan.name,

        profiles:
          plan.profiles,

        amount:
          String(plan.priceId || "") === normalizedPriceId ? plan.amount : plan.legacyPrices[normalizedPriceId],

        priceId:
          plan.priceId
      };
    }
  }

  return null;
}


function syncRecordPlanFromSubscription(
  record,
  subscription
) {
  if (
    !record ||
    !subscription
  ) {
    return null;
  }

  const priceId =
    stripePriceIdFromSubscription(
      subscription
    );

  const matchedPlan =
    planForStripePriceId(
      priceId
    );

  if (!matchedPlan) {
    return null;
  }

  record.plan = {
    tier:
      matchedPlan.tier,

    name:
      matchedPlan.name,

    profiles:
      matchedPlan.profiles,

    amount:
      matchedPlan.amount
  };

  return matchedPlan;
}


async function applySubscriptionInfo(
  record,
  subscription
) {
  if (
    !record ||
    !subscription
  ) {
    return record;
  }

  /*
    Synchronize the local membership tier
    from the actual Stripe subscription price.

    This allows upgrades made through this site
    or directly in Stripe to update the customer's
    local membership record correctly.
  */

  syncRecordPlanFromSubscription(
    record,
    subscription
  );

  record.subscriptionStatus =
    subscription.status ||
    record.subscriptionStatus ||
    "unknown";

  record.currentPeriodStart =
    await getSubscriptionPeriodStart(
      subscription
    );

  record.currentPeriodEnd =
    await getSubscriptionPeriodEnd(
      subscription
    );

  record.cancelAtPeriodEnd =
    subscription
      .cancel_at_period_end ===
    true;

  record.cancelAt =
    stripeTimestampToIso(
      subscription.cancel_at
    );

  record.canceledAt =
    stripeTimestampToIso(
      subscription.canceled_at
    );

  record.endedAt =
    stripeTimestampToIso(
      subscription.ended_at
    );

  record.subscriptionEndDate =
    record.cancelAt ||
    record.currentPeriodEnd ||
    record.endedAt ||
    null;

  return record;
}


/* -------------------------------------------------------
   PROFILE VALIDATION
------------------------------------------------------- */

function sanitizeProfile(body) {
  return {
    profileName: clean(body.profileName),
    firstName: clean(body.firstName, 100),
    lastName: clean(body.lastName, 100),
    email: clean(body.email, 200),
    phone: clean(body.phone, 50),
    address: clean(body.address),
    address2: clean(body.address2),
    country: clean(body.country, 100),
    state: clean(body.state, 100),
    city: clean(body.city, 100),
    zip: clean(body.zip, 30)
  };
}

function sanitizeSecrets(body) {
  return {
    acoEmail: clean(body.acoEmail, 200),
    acoPassword: clean(body.acoPassword, 300),
    cardLabel: clean(body.cardLabel, 100),
    cardholder: clean(body.cardholder, 150),

    acoCardNumber: clean(
      body.acoCardNumber,
      30
    ).replace(/[^\d]/g, ""),

    expMonth: clean(body.expMonth, 2),
    expYear: clean(body.expYear, 4),

    securityCode: clean(
      body.securityCode,
      300
    )
  };
}

function validProfile(profile) {
  const required = [
    "profileName",
    "firstName",
    "lastName",
    "email",
    "phone",
    "address",
    "country",
    "state",
    "city",
    "zip"
  ];

  return (
    required.every(key => profile[key]) &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
      profile.email
    )
  );
}

function validSecrets(secrets) {
  return (
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
      secrets.acoEmail
    ) &&
    secrets.acoPassword.length >= 6 &&
    /^\d{12,19}$/.test(
      secrets.acoCardNumber
    ) &&
    secrets.cardholder &&
    secrets.cardLabel &&
    secrets.expMonth &&
    secrets.expYear &&
    secrets.securityCode
  );
}

/* -------------------------------------------------------
   ENCRYPTION
------------------------------------------------------- */

function encryptionKey() {
  const raw =
    process.env.SUBMISSION_ENCRYPTION_KEY || "";

  if (!raw) {
    throw new Error(
      "SUBMISSION_ENCRYPTION_KEY is not configured"
    );
  }

  return crypto
    .createHash("sha256")
    .update(raw)
    .digest();
}

function encryptJson(object) {
  const iv = crypto.randomBytes(12);
  const key = encryptionKey();

  const cipher =
    crypto.createCipheriv(
      "aes-256-gcm",
      key,
      iv
    );

  const plaintext =
    Buffer.from(
      JSON.stringify(object),
      "utf8"
    );

  const ciphertext =
    Buffer.concat([
      cipher.update(plaintext),
      cipher.final()
    ]);

  return {
    version: 1,
    alg: "AES-256-GCM",
    iv: iv.toString("base64"),
    tag: cipher
      .getAuthTag()
      .toString("base64"),
    data: ciphertext.toString("base64")
  };
}

function decryptJson(payload) {
  const key = encryptionKey();

  const iv =
    Buffer.from(
      payload.iv,
      "base64"
    );

  const tag =
    Buffer.from(
      payload.tag,
      "base64"
    );

  const decipher =
    crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      iv
    );

  decipher.setAuthTag(tag);

  return JSON.parse(
    Buffer.concat([
      decipher.update(
        Buffer.from(
          payload.data,
          "base64"
        )
      ),
      decipher.final()
    ]).toString("utf8")
  );
}

const PURCHASE_CONSENT_VERSION = "membership-checkout-2026-09-29";
const PURCHASE_CONSENT_TEXT = Object.freeze({
  confirm: "I confirm that the information above is accurate.",
  acknowledgeAcoOutcome: "I ACKNOWLEDGE THAT USING ACO DOES NOT GUARANTEE A CHECKOUT, HOWEVER IT DOES INCREASE MY CHANCES EXPONENTIALLY",
  authorizeRequestedPurchases: "I AGREE TO ALLOW SLABSNGRABSACO TO MAKE PURCHASES ON MY BEHALF FOR ITEMS I HAVE AGREED UPON BEFORE A DROP. SLABSNGRABSACO IS NOT ACCOUNTABLE FOR THE MONEY SPENT ON THE ITEMS I HAVE REQUESTED BEFOREHAND."
});
const PURCHASE_CONSENT_KEYS = Object.keys(PURCHASE_CONSENT_TEXT);
let consentLedgerQueue = Promise.resolve();
let consentLedgerTail = null;
let consentReceiptQueue = Promise.resolve();

function consentDigest(previousHash, payload) {
  return crypto.createHmac("sha256", encryptionKey())
    .update(previousHash).update("\n").update(JSON.stringify(payload)).digest("hex");
}
async function readConsentLedger() {
  let raw;
  try { raw = await fs.readFile(CONSENT_LEDGER_FILE, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return { entries: [], tail: "" }; throw error; }
  const entries = [];
  let previous = "";
  for (const line of raw.split("\n").filter(Boolean)) {
    const item = JSON.parse(line);
    if (item.previousHash !== previous || item.hash !== consentDigest(previous, item.payload)) {
      throw new Error("Consent ledger integrity check failed.");
    }
    entries.push(decryptJson(item.payload));
    previous = item.hash;
  }
  return { entries, tail: previous };
}
function appendConsentRecord(record) {
  const next = consentLedgerQueue.then(async () => {
    if (consentLedgerTail === null) consentLedgerTail = (await readConsentLedger()).tail;
    await fs.mkdir(SECRET_DIR, { recursive: true, mode: 0o700 });
    const payload = encryptJson({ id: crypto.randomUUID(), recordedAt: new Date().toISOString(), ...record });
    const hash = consentDigest(consentLedgerTail, payload);
    const line = JSON.stringify({ previousHash: consentLedgerTail, hash, payload }) + "\n";
    const file = await fs.open(CONSENT_LEDGER_FILE, "a", 0o600);
    try { await file.writeFile(line); await file.sync(); }
    finally { await file.close(); }
    consentLedgerTail = hash;
    return decryptJson(payload);
  });
  consentLedgerQueue = next.catch(() => {});
  return next;
}
function withConsentReceipts(task) {
  const next = consentReceiptQueue.then(task);
  consentReceiptQueue = next.catch(() => {});
  return next;
}
async function readConsentEmailQueue() {
  const stored = await readJson(CONSENT_EMAIL_QUEUE_FILE, null);
  if (!stored) return [];
  // Accept the initial array format if one was written during an upgrade.
  return Array.isArray(stored) ? stored : decryptJson(stored);
}
async function writeConsentEmailQueue(pending) {
  await writeJson(CONSENT_EMAIL_QUEUE_FILE, encryptJson(pending));
}
async function flushConsentReceipts() {
  return withConsentReceipts(async () => {
    if (!process.env.RESEND_API_KEY) return;
    const pending = await readConsentEmailQueue();
    while (pending.length) {
      const item = pending[0];
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: process.env.FROM_EMAIL || "SLABSNGRABSACO <onboarding@resend.dev>",
            to: [CONSENT_RECEIPT_EMAIL], subject: item.subject, text: item.text
          }),
          signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (error) {
        console.error("Owner consent receipt email pending:", error?.code || error?.message || "email_error");
        break;
      }
      pending.shift();
      await writeConsentEmailQueue(pending);
    }
  });
}
async function queueConsentReceipt(subject, text) {
  await withConsentReceipts(async () => {
    const pending = await readConsentEmailQueue();
    pending.push({ subject, text });
    await writeConsentEmailQueue(pending);
  });
  void flushConsentReceipts().catch(error => console.error("Owner consent receipt queue:", error.message));
}
setInterval(() => void flushConsentReceipts().catch(error =>
  console.error("Owner consent receipt retry:", error.message)), 5 * 60 * 1000).unref?.();
setTimeout(() => void flushConsentReceipts().catch(error =>
  console.error("Owner consent receipt startup retry:", error.message)), 2000).unref?.();

function consentRequestMetadata(req) {
  return {
    ip: String(req.ip || "").slice(0, 80),
    userAgent: String(req.get("user-agent") || "").slice(0, 300)
  };
}

async function saveEncryptedPackage(
  id,
  object
) {
  await fs.mkdir(
    SECRET_DIR,
    { recursive: true }
  );

  await writeJson(
    path.join(
      SECRET_DIR,
      `${id}.encrypted.json`
    ),
    encryptJson(object)
  );
}

async function loadEncryptedPackage(
  id
) {
  if (!id) {
    return null;
  }

  try {
    const payload =
      await readJson(
        path.join(
          SECRET_DIR,
          `${id}.encrypted.json`
        ),
        null
      );

    if (!payload) {
      return null;
    }

    return decryptJson(
      payload
    );

  } catch {
    return null;
  }
}

/* -------------------------------------------------------
   EMAIL NOTIFICATION
------------------------------------------------------- */

async function sendNotification(record) {
  if (
    !process.env.RESEND_API_KEY ||
    !process.env.BUSINESS_EMAIL
  ) {
    return false;
  }

  const response = await fetch(
    "https://api.resend.com/emails",
    {
      method: "POST",

      headers: {
        Authorization:
          `Bearer ${process.env.RESEND_API_KEY}`,

        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        from:
          process.env.FROM_EMAIL ||
          "SLABSNGRABSACO <onboarding@resend.dev>",

        to: [
          process.env.BUSINESS_EMAIL
        ],

        subject:
          `Secure paid profile ready — ${record.plan.name}`,

        text:
`A paid SLABSNGRABSACO profile is ready.

Submission ID: ${record.id}
Customer: ${record.profile.firstName} ${record.profile.lastName}
Contact email: ${record.profile.email}
Plan: ${record.plan.name} — $${record.plan.amount}/month

Sensitive ACO credentials and card details are NOT included in this email.

Retrieve the encrypted package through the secured admin portal.`
      })
    }
  );

  return response.ok;
}


/* -------------------------------------------------------
   ADMIN-ONLY DISCORD PAYMENT NOTIFICATIONS

   Separate from the customer Success webhook.
   This webhook is intended only for the private
   admin Discord channel and reports payments
   received plus what was purchased.

   Environment variable:
   DISCORD_ADMIN_PAYMENT_WEBHOOK_URL
------------------------------------------------------- */

function moneyFromStripeCents(
  value
) {
  const cents =
    Number(value || 0);

  return (
    Number.isFinite(cents)
      ? cents / 100
      : 0
  );
}


function adminPaymentCustomerLabel(
  profile,
  fallbackEmail = ""
) {
  const name =
    [
      profile?.firstName,
      profile?.lastName
    ]
      .filter(Boolean)
      .join(" ")
      .trim();

  const email =
    normalizeEmail(
      profile?.email ||
      fallbackEmail
    );

  return {
    name:
      clean(
        name,
        150
      ) ||
      "Customer",

    email:
      email ||
      "Not available"
  };
}


async function sendDiscordAdminPaymentNotification(
  payment
) {
  const webhookUrl =
    String(
      process.env
        .DISCORD_ADMIN_PAYMENT_WEBHOOK_URL ||
      ""
    ).trim();

  if (!webhookUrl) {
    return false;
  }

  const amount =
    Number(
      payment?.amount ||
      0
    );

  const customer =
    adminPaymentCustomerLabel(
      payment?.profile ||
      {},
      payment?.customerEmail ||
      ""
    );

  const fields = [
    {
      name:
        "Payment",
      value:
        `$${Math.max(
          0,
          amount
        ).toFixed(2)}`,
      inline:
        true
    },

    {
      name:
        "Type",
      value:
        clean(
          payment?.paymentType ||
          "Payment",
          100
        ),
      inline:
        true
    },

    {
      name:
        "Customer",
      value:
        clean(
          customer.name,
          150
        ),
      inline:
        false
    },

    {
      name:
        "Customer Email",
      value:
        clean(
          customer.email,
          200
        ),
      inline:
        false
    },

    {
      name:
        "Purchased",
      value:
        clean(
          payment?.purchaseSummary ||
          "Purchase details unavailable",
          1000
        ),
      inline:
        false
    }
  ];

  if (
    payment?.orderId
  ) {
    fields.push({
      name:
        "Order / Submission",
      value:
        clean(
          payment.orderId,
          150
        ),
      inline:
        true
    });
  }

  if (
    payment?.profiles != null
  ) {
    fields.push({
      name:
        "Profiles",
      value:
        String(
          payment.profiles
        ),
      inline:
        true
    });
  }

  if (
    payment?.retailer
  ) {
    fields.push({
      name:
        "Retailer",
      value:
        clean(
          payment.retailer,
          80
        ),
      inline:
        true
    });
  }

  if (
    payment?.quantity
  ) {
    fields.push({
      name:
        "Quantity",
      value:
        String(
          payment.quantity
        ),
      inline:
        true
    });
  }

  if (
    payment?.duration
  ) {
    fields.push({
      name:
        "Duration",
      value:
        clean(
          payment.duration,
          80
        ),
      inline:
        true
    });
  }

  const separator =
    webhookUrl.includes("?")
      ? "&"
      : "?";

  const response =
    await fetch(
      `${webhookUrl}${separator}wait=true`,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            username:
              "SLABS N GRABS ACO Payments",

            allowed_mentions: {
              parse: []
            },

            embeds: [
              {
                title:
                  "💰 PAYMENT RECEIVED",

                description:
                  clean(
                    payment?.headline ||
                    "A payment was received.",
                    500
                  ),

                fields,

                timestamp:
                  new Date(
                    payment?.paidAt ||
                    Date.now()
                  ).toISOString(),

                footer: {
                  text:
                    "Private admin payment notification • No card data included"
                }
              }
            ]
          })
      }
    );

  if (!response.ok) {
    const error =
      new Error(
        `Admin Discord payment webhook returned ${response.status}.`
      );

    error.status =
      response.status;

    throw error;
  }

  const data =
    await response
      .json()
      .catch(
        () => ({})
      );

  return (
    data?.id
      ? String(
          data.id
        )
      : true
  );
}




function adminPaymentWebhookUrl() {
  return String(
    process.env
      .DISCORD_ADMIN_PAYMENT_WEBHOOK_URL ||
    ""
  ).trim();
}


async function deleteDiscordAdminPaymentNotification(
  messageId
) {
  const webhookUrl =
    adminPaymentWebhookUrl();

  const id =
    String(
      messageId ||
      ""
    ).trim();

  if (
    !webhookUrl ||
    !id
  ) {
    return false;
  }

  const cleanWebhookUrl =
    webhookUrl.split("?")[0];

  const response =
    await fetch(
      `${cleanWebhookUrl}/messages/${encodeURIComponent(
        id
      )}`,
      {
        method:
          "DELETE"
      }
    );

  if (
    !response.ok &&
    response.status !== 404
  ) {
    throw new Error(
      `Unable to delete admin payment Discord message (${response.status}).`
    );
  }

  return true;
}


async function maybeClearPaidPurchaseDiscord(
  customerAccountId
) {
  const customerId =
    String(
      customerAccountId ||
      ""
    );

  if (!customerId) {
    return false;
  }

  const paid =
    await readJson(
      PAID_FILE,
      []
    );

  const paidRecords =
    Array.isArray(paid)
      ? paid
      : [];

  const profiles =
    await getRetailerProfiles();

  const activatedCount =
    profiles.filter(
      profile =>
        String(
          profile.customerAccountId ||
          ""
        ) ===
          customerId &&
        String(
          profile.activationStatus ||
          ""
        ) ===
          "activated"
    ).length;

  let changed =
    false;

  for (
    const record of paidRecords
  ) {
    if (
      String(
        record.customerAccountId ||
        ""
      ) !== customerId ||
      !record.adminPaymentDiscordMessageId
    ) {
      continue;
    }

    const required =
      Math.max(
        1,
        Number(
          record?.plan?.profiles ||
          1
        )
      );

    if (
      activatedCount <
      required
    ) {
      continue;
    }

    try {
      await deleteDiscordAdminPaymentNotification(
        record.adminPaymentDiscordMessageId
      );
    } catch (error) {
      console.error(
        "Paid purchase Discord cleanup failed:",
        error.message
      );
      continue;
    }

    record.adminPaymentDiscordMessageId =
      null;

    record.adminPaymentDiscordCompletedAt =
      new Date()
        .toISOString();

    changed =
      true;
  }

  if (changed) {
    await writeJson(
      PAID_FILE,
      paidRecords
    );
  }

  return changed;
}


async function maybeClearRentalPurchaseDiscord(
  assignments,
  assignment
) {
  const sessionId =
    String(
      assignment?.stripeSessionId ||
      ""
    );

  const messageId =
    String(
      assignment
        ?.adminPaymentDiscordMessageId ||
      ""
    );

  if (
    !sessionId ||
    !messageId
  ) {
    return false;
  }

  const group =
    assignments.filter(
      item =>
        String(
          item.stripeSessionId ||
          ""
        ) ===
        sessionId
    );

  if (!group.length) {
    return false;
  }

  const handled =
    group.every(
      item =>
        [
          "activated",
          "deactivated"
        ].includes(
          String(
            item.activationStatus ||
            ""
          )
        )
    );

  if (!handled) {
    return false;
  }

  try {
    await deleteDiscordAdminPaymentNotification(
      messageId
    );
  } catch (error) {
    console.error(
      "Rental purchase Discord cleanup failed:",
      error.message
    );
    return false;
  }

  const now =
    new Date()
      .toISOString();

  for (
    const item of group
  ) {
    item.adminPaymentDiscordMessageId =
      null;

    item.adminPaymentDiscordCompletedAt =
      now;
  }

  return true;
}


/* -------------------------------------------------------
   ADMIN PROFILE WORKFLOW DISCORD NOTIFICATIONS

   Environment variable:
   DISCORD_ADMIN_PROFILE_WEBHOOK_URL

   These messages intentionally contain NO retailer
   passwords, full card numbers, or Security Code values.

   A message is created when:
   - a paid profile is awaiting activation
   - a gifted/rented profile is awaiting activation
   - a gifted/rented profile expires

   The Discord message ID is stored on the profile or
   assignment so it can be deleted after the admin
   activates/deactivates the profile.
------------------------------------------------------- */

function adminProfileWebhookUrl() {
  return String(
    process.env
      .DISCORD_ADMIN_PROFILE_WEBHOOK_URL ||
    ""
  ).trim();
}


async function sendDiscordAdminProfileWorkflowNotification(
  {
    title,
    description,
    customerName,
    customerEmail,
    profileLabel,
    profileType,
    expiresAt = null
  } = {}
) {
  const webhookUrl =
    adminProfileWebhookUrl();

  if (!webhookUrl) {
    return null;
  }

  const fields = [
    {
      name: "Customer",
      value:
        clean(
          customerName ||
          "Customer",
          150
        ),
      inline: false
    },
    {
      name: "Customer Email",
      value:
        clean(
          customerEmail ||
          "Not available",
          200
        ),
      inline: false
    },
    {
      name: "Profile",
      value:
        clean(
          profileLabel ||
          "Profile",
          150
        ),
      inline: true
    },
    {
      name: "Type",
      value:
        clean(
          profileType ||
          "Profile",
          100
        ),
      inline: true
    }
  ];

  if (expiresAt) {
    fields.push({
      name: "Expiration",
      value:
        clean(
          String(
            expiresAt
          ),
          100
        ),
      inline: false
    });
  }

  const separator =
    webhookUrl.includes("?")
      ? "&"
      : "?";

  const response =
    await fetch(
      `${webhookUrl}${separator}wait=true`,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body:
          JSON.stringify({
            username:
              "SLABS N GRABS ACO Profiles",

            allowed_mentions: {
              parse: []
            },

            embeds: [
              {
                title:
                  clean(
                    title ||
                    "PROFILE ACTION REQUIRED",
                    250
                  ),

                description:
                  clean(
                    description ||
                    "A customer profile needs admin attention.",
                    700
                  ),

                fields,

                timestamp:
                  new Date()
                    .toISOString(),

                footer: {
                  text:
                    "Admin profile workflow • No sensitive credentials included"
                }
              }
            ]
          })
      }
    );

  if (!response.ok) {
    const detail =
      await response
        .text()
        .catch(
          () => ""
        );

    throw new Error(
      `Admin profile Discord webhook returned ${response.status}: ${detail.slice(0, 180)}`
    );
  }

  const data =
    await response
      .json()
      .catch(
        () => ({})
      );

  return (
    data?.id
      ? String(data.id)
      : null
  );
}


async function deleteDiscordAdminProfileWorkflowNotification(
  messageId
) {
  const webhookUrl =
    adminProfileWebhookUrl();

  const id =
    String(
      messageId ||
      ""
    ).trim();

  if (!id) return false;

  if (webhookUrl) {
    try {
      const response = await fetch(`${webhookUrl.split("?")[0]}/messages/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (response.ok || response.status === 404) return true;
    } catch (error) {
      console.error("Admin profile webhook cleanup:", error.message);
    }
  }

  const token = String(process.env.DISCORD_BOT_TOKEN || "").trim();
  if (token) {
    const channels = await referralDiscordChannels();
    const channel = channels.find(item => item.type === 0 && discordChannelLabel(item.name) === "adminprofiles");
    if (channel) {
      const response = await fetch(`https://discord.com/api/v10/channels/${channel.id}/messages/${encodeURIComponent(id)}`, {
        method: "DELETE", headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(12000)
      });
      if (response.ok || response.status === 404) return true;
      throw new Error(`Discord bot could not remove admin profile alert (HTTP ${response.status}).`);
    }
  }
  throw new Error("Admin profile alert cleanup is not configured.");
}


async function customerLabelForProfileWorkflow(
  customerAccountId,
  fallbackProfile = {}
) {
  const accounts =
    await getCustomerAccounts();

  const account =
    accounts.find(
      item =>
        String(
          item.id
        ) ===
        String(
          customerAccountId ||
          ""
        )
    ) || null;

  const name =
    [
      fallbackProfile?.firstName,
      fallbackProfile?.lastName
    ]
      .filter(Boolean)
      .join(" ")
      .trim() ||
    fallbackProfile?.profileName ||
    "Customer";

  return {
    name:
      clean(
        name,
        150
      ) ||
      "Customer",

    email:
      normalizeEmail(
        account?.email ||
        fallbackProfile?.email ||
        ""
      ) ||
      "Not available"
  };
}


async function ensurePaidProfileDiscordAwaitingMessage(
  record
) {
  if (
    !record ||
    record.activationStatus !==
      "awaiting_activation" ||
    record.discordProfileMessageId
  ) {
    return false;
  }

  try {
    const customer =
      await customerLabelForProfileWorkflow(
        record.customerAccountId,
        record.customerProfile ||
        {}
      );

    const messageId =
      await sendDiscordAdminProfileWorkflowNotification({
        title:
          "🟡 PAID PROFILE ACTIVATING",
        description:
          "A customer submitted a paid ACO profile. Check any missing information in Admin and activate it when external setup is complete.",
        customerName:
          customer.name,
        customerEmail:
          customer.email,
        profileLabel:
          record.profileName ||
          `Profile ${record.slot}`,
        profileType:
          "Paid Profile"
      });

    if (messageId) {
      record.discordProfileMessageId =
        messageId;

      record.discordProfileMessageType =
        "awaiting_activation";

      return true;
    }
  } catch (error) {
    console.error(
      "Paid profile Discord notification failed:",
      error.message
    );
  }

  return false;
}


async function ensureManagedProfileDiscordMessage(
  assignment,
  type
) {
  if (!assignment) {
    return false;
  }

  const activationStatus =
    String(
      assignment.activationStatus ||
      ""
    );

  if (
    ![
      "awaiting_activation",
      "expired"
    ].includes(
      activationStatus
    ) ||
    assignment.discordProfileMessageId
  ) {
    return false;
  }

  try {
    const customer =
      await customerLabelForProfileWorkflow(
        assignment.customerAccountId,
        assignment.customerProfile ||
        {}
      );

    const gifted =
      type === "free";

    const profileType =
      gifted
        ? "Gifted Profile"
        : "Rented Profile";

    const expired =
      activationStatus ===
      "expired";

    const messageId =
      await sendDiscordAdminProfileWorkflowNotification({
        title:
          expired
            ? `🔴 ${profileType.toUpperCase()} EXPIRED`
            : `🟡 ${profileType.toUpperCase()} ACTIVATING`,

        description:
          expired
            ? (
                gifted
                  ? "A gifted profile has expired. Review it in Admin and deactivate it when the managed account should be released."
                  : "A rented profile has expired. Review it in Admin. Extend the rental if confirmed, otherwise deactivate it."
              )
            : "A managed profile was assigned and is now ACTIVATING. Open Admin to review it. INFO MISSING may remain visible after activation if shipping/card information still needs to be completed.",

        customerName:
          customer.name,
        customerEmail:
          customer.email,

        profileLabel:
          profileType,

        profileType,

        expiresAt:
          assignment.expiresAt ||
          null
      });

    if (messageId) {
      assignment.discordProfileMessageId =
        messageId;

      assignment.discordProfileMessageType =
        activationStatus;

      return true;
    }
  } catch (error) {
    console.error(
      "Managed profile Discord notification failed:",
      error.message
    );
  }

  return false;
}


function membershipPlanFromStripePriceId(priceId) {
  return planForStripePriceId(priceId);
}


const adminUpgradeNotificationInProgress =
  new Set();


async function sendAdminSubscriptionInvoiceNotification(
  invoice
) {
  const billingReason =
    String(
      invoice?.billing_reason ||
      ""
    );

  /*
    Initial subscription payment is already reported
    from checkout.session.completed. Skipping it here
    prevents two admin Discord messages for one sale.
  */
  if (
    billingReason ===
    "subscription_create"
  ) {
    return false;
  }

  const subscriptionId =
    typeof invoice?.subscription ===
      "string"
      ? invoice.subscription
      : (
          invoice?.subscription?.id ||
          invoice?.parent
            ?.subscription_details
            ?.subscription ||
          null
        );

  const customerId =
    typeof invoice?.customer ===
      "string"
      ? invoice.customer
      : (
          invoice?.customer?.id ||
          null
        );

  if (
    billingReason ===
      "subscription_update" &&
    subscriptionId &&
    adminUpgradeNotificationInProgress.has(
      String(
        subscriptionId
      )
    )
  ) {
    return false;
  }

  const paid =
    await readJson(
      PAID_FILE,
      []
    );

  const paidRecords =
    Array.isArray(paid)
      ? paid
      : [];

  let record =
    paidRecords.find(
      item =>
        subscriptionId &&
        String(
          item.stripeSubscriptionId ||
          ""
        ) ===
        String(
          subscriptionId
        )
    );

  if (
    !record &&
    customerId
  ) {
    record =
      paidRecords.find(
        item =>
          String(
            item.stripeCustomerId ||
            ""
          ) ===
          String(
            customerId
          )
      );
  }

  let livePlan =
    null;

  if (
    subscriptionId
  ) {
    try {
      const subscription =
        await stripe
          .subscriptions
          .retrieve(
            subscriptionId
          );

      const priceId =
        subscription
          ?.items
          ?.data
          ?.[0]
          ?.price
          ?.id ||
        "";

      livePlan =
        membershipPlanFromStripePriceId(
          priceId
        );

    } catch (error) {
      console.error(
        "Admin payment notification subscription lookup failed:",
        error.message
      );
    }
  }

  const plan =
    livePlan ||
    record?.plan ||
    null;

  const isUpgrade =
    billingReason ===
      "subscription_update";

  if (
    isUpgrade &&
    record?.adminUpgradeDiscordNotifiedAt &&
    Number(
      record?.adminUpgradeDiscordTier ||
      0
    ) ===
      Number(
        plan?.tier ||
        0
      )
  ) {
    const notifiedAt =
      new Date(
        record.adminUpgradeDiscordNotifiedAt
      ).getTime();

    if (
      Number.isFinite(
        notifiedAt
      ) &&
      Date.now() -
        notifiedAt <
        60 * 60 * 1000
    ) {
      return false;
    }
  }

  const paymentType =
    isUpgrade
      ? "Membership upgrade / proration"
      : "Membership renewal";

  const purchaseSummary =
    plan
      ? `${plan.name || "Membership"} — ${Number(
          plan.profiles ||
          0
        )} profile(s)`
      : "Membership payment";

  await sendDiscordAdminPaymentNotification({
    paymentType,

    headline:
      isUpgrade
        ? "A membership upgrade payment was received."
        : "A recurring membership payment was received.",

    amount:
      moneyFromStripeCents(
        invoice?.amount_paid
      ),

    profile:
      record?.profile ||
      {},

    customerEmail:
      invoice
        ?.customer_email ||
      record
        ?.profile
        ?.email ||
      "",

    purchaseSummary,

    orderId:
      record?.id ||
      null,

    profiles:
      plan?.profiles ??
      null,

    paidAt:
      invoice
        ?.status_transitions
        ?.paid_at
        ? new Date(
            invoice
              .status_transitions
              .paid_at *
            1000
          ).toISOString()
        : new Date()
            .toISOString()
  });

  return true;
}



/* -------------------------------------------------------
   ADMIN MEMBERSHIP CANCELLATION NOTIFICATIONS

   Uses the same private admin webhook as payment alerts:
   DISCORD_ADMIN_PAYMENT_WEBHOOK_URL

   Two stages can be reported:
   1. Cancellation scheduled by the member.
   2. Membership actually ended when the period lapses
      or Stripe reports the subscription deleted/canceled.

   Stored notification timestamps prevent duplicates.
------------------------------------------------------- */

function subscriptionEndIso(
  record,
  subscription = null
) {
  const raw =
    subscription?.cancel_at ||
    subscription?.current_period_end ||
    record?.cancelAt ||
    record?.subscriptionEndDate ||
    record?.currentPeriodEnd ||
    null;

  if (!raw) {
    return null;
  }

  if (
    typeof raw ===
      "number"
  ) {
    return new Date(
      raw * 1000
    ).toISOString();
  }

  const parsed =
    new Date(raw);

  return Number.isNaN(
    parsed.getTime()
  )
    ? null
    : parsed.toISOString();
}


function adminMembershipPurchaseSummary(
  record
) {
  return `${record?.plan?.name || "Membership"} — ${Number(
    record?.plan?.profiles ||
    0
  )} profile(s)`;
}


async function sendDiscordAdminMembershipCancellationNotification(
  record,
  {
    stage = "ended",
    reason = "",
    endAt = null
  } = {}
) {
  const webhookUrl =
    String(
      process.env
        .DISCORD_ADMIN_PAYMENT_WEBHOOK_URL ||
      ""
    ).trim();

  if (!webhookUrl) {
    return false;
  }

  const customer =
    adminPaymentCustomerLabel(
      record?.profile ||
      {},
      record?.profile?.email ||
      ""
    );

  const scheduled =
    stage ===
      "scheduled";

  const fields = [
    {
      name:
        "Customer",
      value:
        clean(
          customer.name,
          150
        ),
      inline:
        false
    },

    {
      name:
        "Customer Email",
      value:
        clean(
          customer.email,
          200
        ),
      inline:
        false
    },

    {
      name:
        "Membership",
      value:
        clean(
          adminMembershipPurchaseSummary(
            record
          ),
          500
        ),
      inline:
        false
    },

    {
      name:
        scheduled
          ? "Scheduled End"
          : "Ended",
      value:
        endAt
          ? new Date(
              endAt
            ).toLocaleString(
              "en-US",
              {
                timeZone:
                  "America/New_York",
                dateStyle:
                  "medium",
                timeStyle:
                  "short"
              }
            )
          : "Not available",
      inline:
        true
    },

    {
      name:
        "Reason",
      value:
        clean(
          reason ||
          (
            scheduled
              ? "Member scheduled cancellation"
              : "Membership period ended / subscription canceled"
          ),
          300
        ),
      inline:
        true
    }
  ];

  if (
    record?.id
  ) {
    fields.push({
      name:
        "Order / Submission",
      value:
        clean(
          record.id,
          150
        ),
      inline:
        true
    });
  }

  const response =
    await fetch(
      webhookUrl,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            username:
              "SLABS N GRABS ACO Admin",

            allowed_mentions: {
              parse: []
            },

            embeds: [
              {
                title:
                  scheduled
                    ? "⚠️ MEMBERSHIP CANCELLATION SCHEDULED"
                    : "❌ MEMBERSHIP ENDED",

                description:
                  scheduled
                    ? "A member has scheduled their paid membership to cancel at the end of the current billing period."
                    : "A paid membership has ended and should no longer be treated as active.",

                fields,

                timestamp:
                  new Date()
                    .toISOString(),

                footer: {
                  text:
                    "Private admin membership notification"
                }
              }
            ]
          })
      }
    );

  if (!response.ok) {
    throw new Error(
      `Admin cancellation Discord webhook returned ${response.status}.`
    );
  }

  return true;
}


async function notifyScheduledMembershipCancellation(
  record,
  subscription
) {
  const endAt =
    subscriptionEndIso(
      record,
      subscription
    );

  const noticeKey =
    endAt ||
    String(
      subscription?.id ||
      record?.stripeSubscriptionId ||
      "scheduled"
    );

  if (
    record
      ?.adminCancellationScheduledKey ===
    noticeKey
  ) {
    return false;
  }

  await sendDiscordAdminMembershipCancellationNotification(
    record,
    {
      stage:
        "scheduled",

      reason:
        "Member scheduled cancellation at the end of the billing period.",

      endAt
    }
  );

  record
    .adminCancellationScheduledKey =
      noticeKey;

  record
    .adminCancellationScheduledNotifiedAt =
      new Date()
        .toISOString();

  return true;
}


async function notifyEndedMembership(
  record,
  {
    subscription = null,
    reason = ""
  } = {}
) {
  const endAt =
    subscriptionEndIso(
      record,
      subscription
    ) ||
    new Date()
      .toISOString();

  const noticeKey =
    `${String(
      subscription?.id ||
      record?.stripeSubscriptionId ||
      record?.id ||
      ""
    )}:${String(
      subscription?.status ||
      record?.subscriptionStatus ||
      "ended"
    )}:${endAt}`;

  if (
    record
      ?.adminMembershipEndedKey ===
    noticeKey
  ) {
    return false;
  }

  await sendDiscordAdminMembershipCancellationNotification(
    record,
    {
      stage:
        "ended",

      reason:
        reason ||
        "Membership period ended / subscription canceled.",

      endAt
    }
  );

  record
    .adminMembershipEndedKey =
      noticeKey;

  record
    .adminMembershipEndedNotifiedAt =
      new Date()
        .toISOString();

  return true;
}


/*
  Fallback reconciliation:
  if a cancellation-at-period-end record reaches
  its stored end date before a Stripe deleted event
  is processed, send the private admin alert once.
*/
async function reconcileLapsedMembershipNotifications() {
  const paid =
    await readJson(
      PAID_FILE,
      []
    );

  const records =
    Array.isArray(paid)
      ? paid
      : [];

  let changed =
    false;

  const now =
    Date.now();

  for (
    const record of
    records
  ) {
    if (
      record?.cancelAtPeriodEnd !==
        true
    ) {
      continue;
    }

    const endAt =
      subscriptionEndIso(
        record
      );

    if (!endAt) {
      continue;
    }

    const endTime =
      new Date(
        endAt
      ).getTime();

    if (
      !Number.isFinite(
        endTime
      ) ||
      endTime >
        now
    ) {
      continue;
    }

    const alreadyEnded =
      [
        "canceled",
        "cancelled",
        "unpaid",
        "incomplete_expired"
      ].includes(
        String(
          record
            .subscriptionStatus ||
          ""
        ).toLowerCase()
      );

    try {
      const sent =
        await notifyEndedMembership(
          record,
          {
            reason:
              alreadyEnded
                ? "Stripe reports the membership ended."
                : "The scheduled membership period elapsed."
          }
        );

      if (sent) {
        changed =
          true;
      }

    } catch (error) {
      console.error(
        "Lapsed membership Discord notification failed:",
        error.message
      );
    }
  }

  if (changed) {
    await writeJson(
      PAID_FILE,
      records
    );
  }
}


/* -------------------------------------------------------
   ADMIN SESSIONS
------------------------------------------------------- */

const adminSessions = new Map();
const loginAttempts = new Map();
const customerAuthAttempts =
  new Map();
const apiAbuseAttempts =
  new Map();


function adminSessionKey(
  token
) {
  return crypto
    .createHash("sha256")
    .update(
      String(
        token ||
        ""
      )
    )
    .digest("hex");
}


function adminUserAgentHash(
  req
) {
  return auditHash(
    req.headers[
      "user-agent"
    ] ||
    ""
  );
}

function customerAuthRateLimit(
  req,
  res,
  next
) {
  const ip =
    req.ip || "unknown";

  const now =
    Date.now();

  const windowMs =
    15 * 60 * 1000;

  const maxAttempts =
    10;

  let attempt =
    customerAuthAttempts.get(
      ip
    );

  if (
    !attempt ||
    now > attempt.reset
  ) {
    attempt = {
      count: 0,
      reset:
        now + windowMs
    };
  }

  if (
    attempt.count >=
    maxAttempts
  ) {
    const retryAfter =
      Math.max(
        1,
        Math.ceil(
          (
            attempt.reset -
            now
          ) / 1000
        )
      );

    res.setHeader(
      "Retry-After",
      String(retryAfter)
    );

    return res
      .status(429)
      .json({
        error:
          "Too many requests. Please try again later."
      });
  }

  attempt.count += 1;

  customerAuthAttempts.set(
    ip,
    attempt
  );

  next();
}


function apiAbuseRateLimit(
  req,
  res,
  next
) {
  /*
    High ceiling for normal Admin dashboards, but still bounds
    automated scraping / brute-force request floods from one IP.
  */
  const ip =
    req.ip ||
    "unknown";

  const now =
    Date.now();

  const windowMs =
    15 * 60 * 1000;

  const mutating =
    ![
      "GET",
      "HEAD",
      "OPTIONS"
    ].includes(
      req.method
    );

  const maxRequests =
    mutating
      ? 300
      : 1500;

  const key =
    `${ip}:${mutating ? "write" : "read"}`;

  let record =
    apiAbuseAttempts.get(
      key
    );

  if (
    !record ||
    now >
      record.reset
  ) {
    record = {
      count: 0,
      reset:
        now +
        windowMs
    };
  }

  if (
    record.count >=
    maxRequests
  ) {
    const retryAfter =
      Math.max(
        1,
        Math.ceil(
          (
            record.reset -
            now
          ) /
          1000
        )
      );

    res.setHeader(
      "Retry-After",
      String(
        retryAfter
      )
    );

    return res
      .status(429)
      .json({
        error:
          "Too many requests. Please try again shortly."
      });
  }

  record.count +=
    1;

  apiAbuseAttempts.set(
    key,
    record
  );

  next();
}


function pruneRateLimitMaps() {
  const now =
    Date.now();

  for (
    const map of [
      loginAttempts,
      customerAuthAttempts,
      apiAbuseAttempts
    ]
  ) {
    for (
      const [
        key,
        record
      ] of map.entries()
    ) {
      if (
        Number(
          record?.reset ||
          0
        ) <=
        now
      ) {
        map.delete(
          key
        );
      }
    }
  }

  for (
    const [
      key,
      session
    ] of adminSessions.entries()
  ) {
    if (
      Number(
        session?.absoluteExpires ||
        0
      ) <=
      now
    ) {
      adminSessions.delete(
        key
      );
    }
  }
}


const rateLimitPruneTimer =
  setInterval(
    pruneRateLimitMaps,
    10 * 60 * 1000
  );

if (
  typeof rateLimitPruneTimer
    .unref ===
  "function"
) {
  rateLimitPruneTimer
    .unref();
}


function requestExpectedOrigins(
  req
) {
  const origins =
    new Set();

  try {
    origins.add(
      new URL(
        BASE_URL
      ).origin
    );
  } catch {
    // Ignore malformed BASE_URL here; startup validation handles it.
  }

  const host =
    String(
      req.headers.host ||
      ""
    ).trim();

  if (host) {
    const protocol =
      requestIsHttps(
        req
      )
        ? "https"
        : "http";

    origins.add(
      `${protocol}://${host}`
    );
  }

  return origins;
}


function requireSameOriginMutation(
  req,
  res,
  next
) {
  if (
    [
      "GET",
      "HEAD",
      "OPTIONS"
    ].includes(
      req.method
    )
  ) {
    return next();
  }

  const expectedOrigins =
    requestExpectedOrigins(
      req
    );

  const origin =
    String(
      req.headers.origin ||
      ""
    ).trim();

  const referer =
    String(
      req.headers.referer ||
      ""
    ).trim();

  const fetchSite =
    String(
      req.headers[
        "sec-fetch-site"
      ] ||
      ""
    )
      .trim()
      .toLowerCase();

  /*
    A browser that explicitly says this request is cross-site
    is never allowed to mutate application state.
  */
  if (
    fetchSite &&
    ![
      "same-origin",
      "none"
    ].includes(
      fetchSite
    )
  ) {
    return res
      .status(403)
      .json({
        error:
          "Cross-site request blocked."
      });
  }

  if (
    origin &&
    !expectedOrigins.has(
      origin
    )
  ) {
    return res
      .status(403)
      .json({
        error:
          "Request origin is not allowed."
      });
  }

  if (
    !origin &&
    referer
  ) {
    let refererOrigin =
      "";

    try {
      refererOrigin =
        new URL(
          referer
        ).origin;
    } catch {
      refererOrigin =
        "";
    }

    if (
      !refererOrigin ||
      !expectedOrigins.has(
        refererOrigin
      )
    ) {
      return res
        .status(403)
        .json({
          error:
            "Request origin is not allowed."
        });
    }
  }

  /*
    Authenticated browser mutations should always provide at least
    Origin/Referer/Sec-Fetch-Site. Reject silent cookie-bearing
    mutations that provide none of those signals.
  */
  const cookies =
    parseCookies(
      req
    );

  const hasSessionCookie =
    Boolean(
      cookies.sng_admin ||
      cookies[
        CUSTOMER_SESSION_COOKIE
      ]
    );

  if (
    hasSessionCookie &&
    !origin &&
    !referer &&
    !fetchSite
  ) {
    return res
      .status(403)
      .json({
        error:
          "Unable to verify request origin."
      });
  }

  return next();
}


function containsUnsafeObjectKey(
  value,
  depth = 0
) {
  if (
    depth > 8 ||
    value == null ||
    typeof value !== "object"
  ) {
    return false;
  }

  for (
    const [
      key,
      item
    ] of Object.entries(
      value
    )
  ) {
    if (
      [
        "__proto__",
        "prototype",
        "constructor"
      ].includes(
        key
      )
    ) {
      return true;
    }

    if (
      containsUnsafeObjectKey(
        item,
        depth + 1
      )
    ) {
      return true;
    }
  }

  return false;
}


function rejectUnsafeJsonKeys(
  req,
  res,
  next
) {
  if (
    req.body &&
    containsUnsafeObjectKey(
      req.body
    )
  ) {
    return res
      .status(400)
      .json({
        error:
          "Invalid request payload."
      });
  }

  next();
}


function requireJsonForMutation(
  req,
  res,
  next
) {
  if (
    [
      "GET",
      "HEAD",
      "OPTIONS"
    ].includes(
      req.method
    )
  ) {
    return next();
  }

  const contentLength =
    Number(
      req.headers[
        "content-length"
      ] ||
      0
    );

  /*
    Empty POST/DELETE actions such as logout do not need JSON.
  */
  if (
    !contentLength
  ) {
    return next();
  }

  if (
    !req.is(
      "application/json"
    )
  ) {
    return res
      .status(415)
      .json({
        error:
          "JSON request body required."
      });
  }

  next();
}


function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .filter(Boolean)
      .map(cookie => {
        const index =
          cookie.indexOf("=");

        return [
          cookie
            .slice(0, index)
            .trim(),

          decodeURIComponent(
            cookie.slice(index + 1)
          )
        ];
      })
  );
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));

  return (
    A.length === B.length &&
    crypto.timingSafeEqual(A, B)
  );
}

/* -------------------------------------------------------
   CUSTOMER ACCOUNT SECURITY
------------------------------------------------------- */

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .slice(0, 200);
}

function customerSessionSecret() {
  const secret =
    process.env.CUSTOMER_SESSION_SECRET || "";

  if (secret.length < 32) {
    throw new Error(
      "CUSTOMER_SESSION_SECRET is not configured securely"
    );
  }

  return secret;
}

function base64url(value) {
  return Buffer
    .from(value)
    .toString("base64url");
}

function signCustomerSession(payload) {
  const encoded =
    base64url(
      JSON.stringify(payload)
    );

  const signature =
    crypto
      .createHmac(
        "sha256",
        customerSessionSecret()
      )
      .update(encoded)
      .digest("base64url");

  return `${encoded}.${signature}`;
}

function verifyCustomerSession(token) {
  try {
    const [
      encoded,
      suppliedSignature
    ] = String(token || "")
      .split(".");

    if (
      !encoded ||
      !suppliedSignature
    ) {
      return null;
    }

    const expectedSignature =
      crypto
        .createHmac(
          "sha256",
          customerSessionSecret()
        )
        .update(encoded)
        .digest("base64url");

    if (
      !safeEqual(
        suppliedSignature,
        expectedSignature
      )
    ) {
      return null;
    }

    const payload =
      JSON.parse(
        Buffer
          .from(
            encoded,
            "base64url"
          )
          .toString("utf8")
      );

    if (
      !payload.accountId ||
      !payload.expires ||
      Number(payload.expires) <
        Date.now()
    ) {
      return null;
    }

    return payload;

  } catch {
    return null;
  }
}

function customerSessionVersion(
  account
) {
  return Number(
    account?.sessionVersion ||
    0
  );
}


function setCustomerSession(
  res,
  account
) {
  const expires =
    Date.now() +
    CUSTOMER_SESSION_MAX_AGE *
    1000;

  const token =
    signCustomerSession({
      accountId:
        account.id,

      version:
        customerSessionVersion(
          account
        ),

      issuedAt:
        Date.now(),

      expires
    });

  res.setHeader(
    "Set-Cookie",
    `${CUSTOMER_SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${CUSTOMER_SESSION_MAX_AGE}; Priority=High${
      SECURE_COOKIES
        ? "; Secure"
        : ""
    }`
  );
}


function clearCustomerSession(res) {
  res.setHeader(
    "Set-Cookie",
    `${CUSTOMER_SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Priority=High${
      SECURE_COOKIES
        ? "; Secure"
        : ""
    }`
  );
}


async function hashCustomerPassword(
  password,
  existingSalt = null
) {
  const salt =
    existingSalt ||
    crypto
      .randomBytes(16)
      .toString("hex");

  const derivedKey =
    await new Promise(
      (resolve, reject) => {
        crypto.scrypt(
          String(password),
          salt,
          64,
          (error, key) => {
            if (error) {
              reject(error);
              return;
            }

            resolve(key);
          }
        );
      }
    );

  return {
    salt,
    hash:
      derivedKey.toString("hex")
  };
}

async function verifyCustomerPassword(
  password,
  account
) {
  if (
    !account?.passwordSalt ||
    !account?.passwordHash
  ) {
    return false;
  }

  try {
    const result =
      await hashCustomerPassword(
        password,
        account.passwordSalt
      );

    return safeEqual(
      result.hash,
      account.passwordHash
    );

  } catch {
    return false;
  }
}

async function getCustomerAccounts() {
  const accounts =
    await readJson(
      CUSTOMER_ACCOUNTS_FILE,
      []
    );

  return Array.isArray(accounts)
    ? accounts
    : [];
}

async function saveCustomerAccounts(
  accounts
) {
  await writeJson(
    CUSTOMER_ACCOUNTS_FILE,
    accounts
  );
}

function referralDiscordValue(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  if (/^<@!?\d{17,22}>$/.test(input)) return input;
  if (/^@?[a-z0-9_.]{2,32}$/i.test(input)) return input.startsWith("@") ? input : `@${input}`;
  return null;
}

function findLinkedReferrer(accounts, input) {
  if (!input) return null;
  const mention = input.match(/^<@!?(\d{17,22})>$/);
  const username = input.replace(/^@/, "").toLowerCase();
  const matches = accounts.filter(item =>
    item.disabled !== true && item.discordLinkedAt && /^\d{17,22}$/.test(String(item.discordUserId || "")) &&
    (mention ? String(item.discordUserId) === mention[1] : String(item.discordUsername || "").toLowerCase() === username)
  );
  return matches.length === 1 ? matches[0] : null;
}

function discordChannelLabel(name) {
  return String(name || "").split(/[|│┃┊｜]/).pop().toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function sendDiscordReferralMessage(channelId, content, allowedUsers = []) {
  const token = String(process.env.DISCORD_BOT_TOKEN || "").trim();
  if (!token) throw new Error("Discord bot is not configured.");
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: [], users: allowedUsers } }),
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`Discord referral message HTTP ${response.status}`);
}

async function referralDiscordChannels() {
  const { token, channelId } = await resolvedDiscordSuccessConfig();
  if (!token || !/^\d{17,22}$/.test(channelId)) throw new Error("Discord community channel is not configured.");
  const headers = { Authorization: `Bot ${token}` };
  const source = await fetch(`https://discord.com/api/v10/channels/${channelId}`, { headers, signal: AbortSignal.timeout(12000) });
  if (!source.ok) throw new Error(`Discord community lookup HTTP ${source.status}`);
  const guildId = (await source.json()).guild_id;
  if (!/^\d{17,22}$/.test(String(guildId || ""))) throw new Error("Discord community has no server ID.");
  const response = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, { headers, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Discord channel lookup HTTP ${response.status}`);
  return await response.json();
}

async function sendPrivateReferralNotice(content) {
  try {
    const channels = await referralDiscordChannels();
    const adminCategory = channels.find(item => item.type === 4 && discordChannelLabel(item.name) === "adminonly");
    const adminProfiles = channels.find(item => item.type === 0 && item.parent_id === adminCategory?.id && discordChannelLabel(item.name) === "adminprofiles");
    if (!adminProfiles) throw new Error("Private Admin Profiles channel is unavailable.");
    const guild = await fetch(`https://discord.com/api/v10/guilds/${adminProfiles.guild_id}`, {
      headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }, signal: AbortSignal.timeout(12000)
    });
    if (!guild.ok) throw new Error(`Discord owner lookup HTTP ${guild.status}`);
    const ownerId = (await guild.json()).owner_id;
    await sendDiscordReferralMessage(adminProfiles.id, `${ownerId ? `<@${ownerId}> — ` : ""}${content}`, ownerId ? [String(ownerId)] : []);
    return;
  } catch (error) {
    const webhook = String(process.env.DISCORD_ADMIN_PROFILE_WEBHOOK_URL || "").trim();
    if (!webhook) throw error;
    const response = await fetch(webhook, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) throw new Error(`Private signup webhook HTTP ${response.status}`);
  }
}

async function notifyReferralSignup(account) {
  if (!account.referredByAccountId || !account.referredByDiscord) return;
  await sendPrivateReferralNotice(`New website signup — referral field: ${account.referredByDiscord}`);
}

async function notifyReferralAward(account, referrer) {
  await sendPrivateReferralNotice(`Referral confirmed: ${account.email} was referred by @${referrer.discordUsername} (${referrer.discordUserId}). A one-month gifted profile reward was granted.`);
}

async function announceReferralReward(referrer) {
  const channels = await referralDiscordChannels();
  const general = channels.find(item => item.type === 0 && discordChannelLabel(item.name) === "general");
  if (!general) throw new Error("Discord General channel is unavailable.");
  const member = await fetch(`https://discord.com/api/v10/guilds/${general.guild_id}/members/${referrer.discordUserId}`, {
    headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
    signal: AbortSignal.timeout(12000)
  });
  if (!member.ok) throw new Error(`Referral member is not currently available in Discord (HTTP ${member.status}).`);
  await sendDiscordReferralMessage(general.id, `<@${referrer.discordUserId}> Thank you for the referral. You have received your free profile for 1 month`, [String(referrer.discordUserId)]);
}

const REFERRAL_REWARD_MESSAGE = "Thank you for the referral. You have received your free profile for 1 month";

async function assignReferralRewardProfiles(referralId) {
  const gifts = await getGiftedMemberships();
  const grant = gifts.find(item => item.referralSourceAccountId === referralId);
  if (!grant) return;
  const assignments = await getFreeAssignments();
  if (new Date(grant.expiresAt).getTime() <= Date.now()) {
    let changed = false;
    for (const item of assignments) {
      if (item.referralGiftId !== grant.id || !managedAssignmentIsLinked(item)) continue;
      item.active = false;
      item.activationStatus = "expired";
      item.endReason = "expired";
      item.endedAt = new Date().toISOString();
      item.updatedAt = item.endedAt;
      changed = true;
    }
    if (changed) await saveFreeAssignments(assignments);
    return;
  }
  const already = new Set(assignments.filter(item => item.referralGiftId === grant.id).map(item => item.referralRetailer));
  const targets = await getAvailableManagedAccountsForRetailer("target");
  const walmart = await getAvailableManagedAccountsForRetailer("walmart");
  const pokemon = await getAvailableManagedAccountsForRetailer("pokemoncenter");
  const username = item => {
    try { return normalizeEmail(normalizeRetailerCredentials(decryptJson(item.credentials))?.target?.username); }
    catch { return ""; }
  };
  const pokemonUsername = item => {
    try { return normalizeEmail(normalizeRetailerCredentials(decryptJson(item.credentials))?.pokemoncenter?.username); }
    catch { return ""; }
  };
  const existingTarget = assignments.find(item => item.referralGiftId === grant.id && item.referralRetailer === "target");
  const assignedTarget = existingTarget && (await getManagedAccounts()).find(item => String(item.id) === String(existingTarget.managedAccountId));
  const target = assignedTarget || targets.find(item => pokemon.some(other => pokemonUsername(other) === username(item))) || targets[0];
  const matchingPokemon = pokemon.find(item => target && pokemonUsername(item) === username(target));
  const choices = { target: assignedTarget ? null : target, walmart: walmart[0], pokemoncenter: matchingPokemon || pokemon[0] };
  const now = new Date().toISOString();
  let changed = false;
  for (const [retailer, item] of Object.entries(choices)) {
    if (!item || already.has(retailer) || assignments.some(record => String(record.managedAccountId) === String(item.id) && managedAssignmentIsLinked(record))) continue;
    assignments.push({ id: crypto.randomUUID(), freeMembershipId: item.id,
      managedAccountId: item.id, customerAccountId: grant.customerAccountId,
      referralGiftId: grant.id, referralRetailer: retailer, active: true,
      durationType: "1_month", activationStatus: "incomplete", activationRequestedAt: null,
      startsAt: null, expiresAt: null, createdAt: now, updatedAt: now,
      endedAt: null, endReason: null });
    already.add(retailer);
    changed = true;
  }
  if (changed) await saveFreeAssignments(assignments);
}

async function processPendingReferrals() {
  const accounts = await getCustomerAccounts();
  for (const account of accounts) {
    if (account.referralAwardedAt) {
      try { await assignReferralRewardProfiles(account.id); }
      catch (error) { console.error("Referral managed profile assignment:", error.message); }
    }
    if (account.referralRecordedAt && account.referredByAccountId && account.referredByDiscord && !account.referralSignupAlertAt) {
      try {
        await notifyReferralSignup(account);
        account.referralSignupAlertAt = new Date().toISOString();
        await saveCustomerAccounts(accounts);
      } catch (error) {
        console.error("Private referral signup notification:", error.message);
      }
    }
    if (account.referralAwardedAt && account.referredByAccountId && (!account.referralAnnouncementAt || !account.referralRewardAlertAt)) {
      const referrer = accounts.find(item => item.id === account.referredByAccountId && item.discordLinkedAt && item.discordUserId);
      if (!referrer) continue;
      if (!account.referralRewardAlertAt) {
        try {
          await notifyReferralAward(account, referrer);
          account.referralRewardAlertAt = new Date().toISOString();
          await saveCustomerAccounts(accounts);
        } catch (error) {
          console.error("Private referral reward notification:", error.message);
        }
      }
      if (!account.referralAnnouncementAt) {
        try {
          await announceReferralReward(referrer);
          account.referralAnnouncementAt = new Date().toISOString();
          await saveCustomerAccounts(accounts);
        } catch (error) {
          console.error("Referral reward announcement:", error.message);
        }
      }
    }
  }
}

async function awardVerifiedReferral(account) {
  if (!account.emailVerifiedAt || !account.referredByAccountId || account.referralAwardedAt) return false;
  const accounts = await getCustomerAccounts();
  const referred = accounts.find(item => item.id === account.id);
  const referrer = accounts.find(item => item.id === account.referredByAccountId && item.discordLinkedAt && item.discordUserId && item.disabled !== true);
  if (!referred || !referrer || referred.id === referrer.id || referred.referralAwardedAt) return false;
  const grants = await getGiftedMemberships();
  if (grants.some(item => item.referralSourceAccountId === referred.id)) return false;
  const now = new Date();
  const end = new Date(now);
  end.setUTCMonth(end.getUTCMonth() + 1);
  grants.push({ id: crypto.randomUUID(), customerAccountId: referrer.id,
    customerEmail: referrer.email || "", tier: 1, tierName: "Referral reward",
    profiles: 3, months: 1, startsAt: now.toISOString(), expiresAt: end.toISOString(),
    createdAt: now.toISOString(), createdBy: "referral", referralSourceAccountId: referred.id });
  await saveGiftedMemberships(grants);
  const notes = customerNotifications(referrer);
  if (!notes.some(item => item.kind === "referral_reward" && item.referralSourceAccountId === referred.id)) {
    notes.push({ id: crypto.randomUUID(), kind: "referral_reward", title: "Referral reward",
      message: REFERRAL_REWARD_MESSAGE, referralSourceAccountId: referred.id,
      createdAt: now.toISOString(), updatedAt: now.toISOString() });
  }
  referred.referralAwardedAt = now.toISOString();
  await saveCustomerAccounts(accounts);
  void processPendingReferrals().catch(error => console.error("Referral announcement:", error.message));
  return true;
}

setInterval(() => void processPendingReferrals().catch(error =>
  console.error("Referral notifications:", error.message)), 5 * 60 * 1000).unref?.();

async function getAuthenticatedCustomer(
  req
) {
  const token =
    parseCookies(req)[
      CUSTOMER_SESSION_COOKIE
    ];

  if (!token) {
    return null;
  }

  const session =
    verifyCustomerSession(token);

  if (!session) {
    return null;
  }

  const accounts =
    await getCustomerAccounts();

  const account =
    accounts.find(
      item =>
        item.id ===
        session.accountId
    );

  if (
    !account ||
    account.disabled === true
  ) {
    return null;
  }

  if (
    Number(
      session.version ||
      0
    ) !==
    customerSessionVersion(
      account
    )
  ) {
    return null;
  }

  return account;
}

async function requireCustomer(
  req,
  res,
  next
) {
  try {
    const account =
      await getAuthenticatedCustomer(
        req
      );

    if (!account) {
      return res
        .status(401)
        .json({
          error:
            "Please sign in to your customer account."
        });
    }

    req.customerAccount =
      account;

    if (account.mustChangePassword && req.path !== "/api/account/change-password") {
      return res.status(403).json({
        error: "Change your temporary password to continue.",
        passwordChangeRequired: true
      });
    }

    next();

  } catch (error) {
    console.error(
      "Customer authentication error:",
      error.message
    );

    return res
      .status(401)
      .json({
        error:
          "Customer authentication required."
      });
  }
}


function customerVaultPath(
  accountId
) {
  return path.join(
    SECRET_DIR,
    `customer-${String(
      accountId
    )}-vault.encrypted.json`
  );
}

async function getCustomerVault(
  accountId
) {
  try {
    const encrypted =
      await readJson(
        customerVaultPath(
          accountId
        ),
        null
      );

    if (!encrypted) {
      return {
        paymentMethods: []
      };
    }

    const vault =
      decryptJson(
        encrypted
      );

    return {
      paymentMethods:
        Array.isArray(
          vault?.paymentMethods
        )
          ? vault.paymentMethods
          : []
    };
  } catch (error) {
    if (
      error?.code ===
      "ENOENT"
    ) {
      return {
        paymentMethods: []
      };
    }

    throw error;
  }
}

async function saveCustomerVault(
  accountId,
  vault
) {
  await writeJson(
    customerVaultPath(
      accountId
    ),
    encryptJson({
      paymentMethods:
        Array.isArray(
          vault?.paymentMethods
        )
          ? vault.paymentMethods
          : []
    })
  );
}

function sanitizeShippingAddress(
  body,
  existingId = null
) {
  return {
    id:
      existingId ||
      crypto.randomUUID(),

    label:
      clean(
        body?.label,
        80
      ) ||
      "Saved Address",

    firstName:
      clean(
        body?.firstName,
        100
      ),

    lastName:
      clean(
        body?.lastName,
        100
      ),

    address:
      clean(
        body?.address,
        300
      ),

    address2:
      clean(
        body?.address2,
        300
      ),

    city:
      clean(
        body?.city,
        100
      ),

    state:
      clean(
        body?.state,
        100
      ),

    zip:
      clean(
        body?.zip,
        30
      ),

    country:
      clean(
        body?.country,
        100
      )
  };
}

function validShippingAddress(
  address
) {
  return [
    "label",
    "firstName",
    "lastName",
    "address",
    "city",
    "state",
    "zip",
    "country"
  ].every(
    key =>
      Boolean(
        address?.[key]
      )
  );
}

function sanitizeSavedPaymentMethod(
  body,
  existing = null
) {
  const rawNumber =
    clean(
      body?.acoCardNumber,
      30
    ).replace(
      /[^\d]/g,
      ""
    );

  return {
    id:
      existing?.id ||
      crypto.randomUUID(),

    cardLabel:
      clean(
        body?.cardLabel,
        100
      ) ||
      existing?.cardLabel ||
      "Payment",

    cardholder:
      clean(
        body?.cardholder,
        150
      ) ||
      existing?.cardholder ||
      "",

    acoCardNumber:
      rawNumber ||
      existing?.acoCardNumber ||
      "",

    expMonth:
      clean(
        body?.expMonth,
        2
      ) ||
      existing?.expMonth ||
      "",

    expYear:
      clean(
        body?.expYear,
        4
      ) ||
      existing?.expYear ||
      "",

    securityCode:
      String(
        body?.securityCode ||
        ""
      ).trim() ||
      existing?.securityCode ||
      "",

    createdAt:
      existing?.createdAt ||
      new Date()
        .toISOString(),

    updatedAt:
      new Date()
        .toISOString()
  };
}

function validSavedPaymentMethod(
  method
) {
  return (
    method.cardLabel &&
    method.cardholder &&
    /^\d{12,19}$/.test(
      method.acoCardNumber
    ) &&
    /^(0[1-9]|1[0-2])$/.test(
      method.expMonth
    ) &&
    /^\d{4}$/.test(
      method.expYear
    )
  );
}

function publicSavedPaymentMethod(
  method,
  index
) {
  const digits =
    String(
      method?.acoCardNumber ||
      ""
    ).replace(
      /\D/g,
      ""
    );

  const last4 =
    digits.slice(-4);

  return {
    id:
      method.id,

    cardLabel:
      method.cardLabel ||
      `Payment ${index + 1}`,

    cardholder:
      method.cardholder ||
      "",

    acoCardNumber:
      digits,

    cardNumber:
      digits,

    maskedNumber:
      last4
        ? `•••• •••• •••• ${last4}`
        : "Card saved",

    expMonth:
      method.expMonth ||
      "",

    expYear:
      method.expYear ||
      "",

    securityCode:
      String(
        method?.securityCode ||
        ""
      ),

    securityCodeConfigured:
      Boolean(
        method.securityCode
      ),

    source:
      method.source ||
      "saved",

    createdAt:
      method.createdAt ||
      null,

    updatedAt:
      method.updatedAt ||
      null
  };
}


function adminSavedPaymentMethod(
  method,
  index
) {
  return {
    ...publicSavedPaymentMethod(
      method,
      index
    ),

    accountSecurityCode:
      String(
        method?.securityCode ||
        ""
      )
  };
}




function customerSavedAddresses(
  account
) {
  return Array.isArray(
    account?.shippingAddresses
  )
    ? account.shippingAddresses
    : [];
}

function savedAddressDedupeKey(
  item = {}
) {
  return JSON.stringify({
    firstName:
      clean(
        item.firstName,
        100
      ).toUpperCase(),

    lastName:
      clean(
        item.lastName,
        100
      ).toUpperCase(),

    address:
      clean(
        item.address,
        200
      ).toUpperCase(),

    address2:
      clean(
        item.address2,
        200
      ).toUpperCase(),

    city:
      clean(
        item.city,
        100
      ).toUpperCase(),

    state:
      clean(
        item.state,
        100
      ).toUpperCase(),

    zip:
      clean(
        item.zip,
        30
      ).toUpperCase(),

    country:
      clean(
        item.country,
        100
      ).toUpperCase()
  });
}


function savedPaymentDedupeKey(
  item = {}
) {
  return JSON.stringify({
    number:
      String(
        item.acoCardNumber ||
        item.cardNumber ||
        ""
      ).replace(
        /\D/g,
        ""
      ),

    expMonth:
      clean(
        item.expMonth,
        2
      ),

    expYear:
      clean(
        item.expYear,
        4
      ),

    cardholder:
      clean(
        item.cardholder,
        150
      ).toUpperCase()
  });
}


async function allCustomerSavedDetails(
  account,
  {
    admin = false
  } = {}
) {
  const vault =
    await getCustomerVault(
      account.id
    );

  const addresses = [];
  const payments = [];

  const addressKeys =
    new Set();

  const paymentKeys =
    new Set();

  const addAddress =
    (
      item,
      fallbackLabel,
      fallbackId,
      source
    ) => {
      if (
        !item ||
        !String(
          item.address ||
          ""
        ).trim()
      ) {
        return;
      }

      const normalized = {
        id:
          item.id ||
          fallbackId ||
          crypto.randomUUID(),

        label:
          item.label ||
          fallbackLabel ||
          "Shipping Address",

        firstName:
          item.firstName ||
          "",

        lastName:
          item.lastName ||
          "",

        phone:
          item.phone ||
          "",

        email:
          item.email ||
          "",

        address:
          item.address ||
          "",

        address2:
          item.address2 ||
          "",

        city:
          item.city ||
          "",

        state:
          item.state ||
          "",

        zip:
          item.zip ||
          "",

        country:
          item.country ||
          "US",

        source:
          source ||
          item.source ||
          "saved"
      };

      const key =
        savedAddressDedupeKey(
          normalized
        );

      if (
        !key ||
        addressKeys.has(key)
      ) {
        return;
      }

      addressKeys.add(key);
      addresses.push(
        normalized
      );
    };

  const addPayment =
    (
      item,
      fallbackLabel,
      fallbackId,
      source
    ) => {
      if (!item) {
        return;
      }

      const digits =
        String(
          item.acoCardNumber ||
          item.cardNumber ||
          ""
        ).replace(
          /\D/g,
          ""
        );

      if (!digits) {
        return;
      }

      const normalized = {
        id:
          item.id ||
          fallbackId ||
          crypto.randomUUID(),

        cardLabel:
          item.cardLabel ||
          fallbackLabel ||
          "Payment",

        cardholder:
          item.cardholder ||
          "",

        acoCardNumber:
          digits,

        expMonth:
          item.expMonth ||
          "",

        expYear:
          item.expYear ||
          "",

        securityCode:
          item.securityCode ||
          item.accountSecurityCode ||
          "",

        source:
          source ||
          item.source ||
          "saved",

        createdAt:
          item.createdAt ||
          null,

        updatedAt:
          item.updatedAt ||
          null
      };

      const key =
        savedPaymentDedupeKey(
          normalized
        );

      if (
        !key ||
        paymentKeys.has(key)
      ) {
        return;
      }

      paymentKeys.add(key);
      payments.push(
        normalized
      );
    };

  const extraAddresses =
    customerSavedAddresses(
      account
    );

  extraAddresses.forEach(
    (
      item,
      index
    ) => {
      addAddress(
        item,
        item.label ||
        `Saved Address ${index + 1}`,
        item.id ||
        `saved-address:${index + 1}`,
        "extra_saved_address"
      );
    }
  );

  vault.paymentMethods.forEach(
    (
      item,
      index
    ) => {
      addPayment(
        item,
        item.cardLabel ||
        `Saved Payment ${index + 1}`,
        item.id ||
        `saved-payment:${index + 1}`,
        "extra_saved_payment"
      );
    }
  );

  /*
    Include the customer's account/profile address too. Exact duplicates
    are removed by savedAddressDedupeKey.
  */
  addAddress(
    account?.adminProfile ||
    {},
    "Customer Account Address",
    `customer-account-address:${account.id}`,
    "customer_account"
  );

  const paidOrders =
    await readJson(
      PAID_FILE,
      []
    );

  const customerPaidOrders =
    (
      Array.isArray(
        paidOrders
      )
        ? paidOrders
        : []
    )
      .filter(
        record =>
          String(
            record.customerAccountId ||
            ""
          ) ===
            String(
              account.id
            )
      );

  for (
    let index = 0;
    index <
      customerPaidOrders.length;
    index += 1
  ) {
    const record =
      customerPaidOrders[
        index
      ];

    addAddress(
      record.profile ||
      record.customer ||
      {},
      `Checkout Address ${index + 1}`,
      `paid-order-address:${record.id || index + 1}`,
      "paid_order"
    );

    /*
      The original checkout card is stored in the encrypted submission
      package rather than the customer vault. Include it so the Admin
      JIG/card rotation truly sees every card the customer provided.
    */
    const checkoutSecrets =
      await loadEncryptedPackage(
        record.id
      );

    addPayment(
      checkoutSecrets ||
      {},
      `Checkout Card ${index + 1}`,
      `paid-order-card:${record.id || index + 1}`,
      "paid_order"
    );
  }

  const retailerProfiles =
    await getRetailerProfiles();

  const paidProfiles =
    retailerProfiles
      .filter(
        record =>
          String(
            record.customerAccountId ||
            ""
          ) ===
            String(
              account.id
            )
      )
      .sort(
        (
          a,
          b
        ) =>
          Number(
            a.slot ||
            0
          ) -
          Number(
            b.slot ||
            0
          )
      );

  for (
    const record of
    paidProfiles
  ) {
    const label =
      record.profileName ||
      `Paid Profile ${record.slot || ""}`;

    addAddress(
      record.customerProfile ||
      {},
      `${label} Shipping`,
      `paid-profile-address:${record.id}`,
      "paid_profile"
    );

    let secrets = {};

    try {
      if (
        record.customerSecrets
      ) {
        secrets =
          decryptJson(
            record.customerSecrets
          ) || {};
      }
    } catch {
      secrets = {};
    }

    addPayment(
      secrets,
      `${label} Card`,
      `paid-profile-card:${record.id}`,
      "paid_profile"
    );
  }

  return {
    addresses,

    paymentMethods:
      payments.map(
        (
          item,
          index
        ) =>
          admin
            ? adminSavedPaymentMethod(
                item,
                index
              )
            : publicSavedPaymentMethod(
                item,
                index
              )
      )
  };
}


async function customerSavedDetailsPayload(
  account
) {
  return allCustomerSavedDetails(
    account,
    {
      admin: false
    }
  );
}


async function adminCustomerSavedDetailsPayload(
  account
) {
  return allCustomerSavedDetails(
    account,
    {
      admin: true
    }
  );
}




function normalizeProfileActivationStatus(
  value,
  ready = false
) {
  const status =
    String(
      value ||
      ""
    )
      .trim()
      .toLowerCase();

  if (
    [
      "incomplete",
      "awaiting_activation",
      "activated",
      "deactivated",
      "expired"
    ].includes(status)
  ) {
    return status;
  }

  return ready
    ? "awaiting_activation"
    : "incomplete";
}


function profileActivationLabel(
  status
) {
  const value =
    normalizeProfileActivationStatus(
      status
    );

  if (
    value ===
    "activated"
  ) {
    return "Activated";
  }

  if (
    value ===
    "deactivated"
  ) {
    return "Deactivated";
  }

  if (
    value ===
    "expired"
  ) {
    return "Expired";
  }

  if (
    value ===
    "awaiting_activation"
  ) {
    return "Awaiting Activation";
  }

  return "Incomplete";
}



function exactManagedAddressKey(
  profile = {}
) {
  const required = [
    "address",
    "city",
    "state",
    "zip",
    "country"
  ];

  if (
    !required.every(
      key =>
        String(
          profile?.[key] ||
          ""
        ).trim()
    )
  ) {
    return "";
  }

  return JSON.stringify({
    address:
      String(
        profile.address ||
        ""
      ).trim(),

    address2:
      String(
        profile.address2 ||
        ""
      ).trim(),

    city:
      String(
        profile.city ||
        ""
      ).trim(),

    state:
      String(
        profile.state ||
        ""
      ).trim(),

    zip:
      String(
        profile.zip ||
        ""
      ).trim(),

    country:
      String(
        profile.country ||
        ""
      ).trim()
  });
}


function managedAssignmentMembershipId(
  assignment = {}
) {
  return String(
    assignment.managedAccountId ||
    assignment.freeMembershipId ||
    assignment.rentedMembershipId ||
    assignment.membershipId ||
    ""
  );
}


function managedAccountCanonicalEmail(
  membership,
  suppliedCredentials = null
) {
  if (!membership) {
    return "";
  }

  let credentials =
    suppliedCredentials;

  if (!credentials) {
    try {
      credentials =
        membership.credentials
          ? normalizeRetailerCredentials(
              decryptJson(
                membership.credentials
              )
            )
          : emptyRetailerCredentials();
    } catch {
      credentials =
        emptyRetailerCredentials();
    }
  }

  return String(
    membership.accountEmail ||
    membership.displayEmail ||
    credentials?.target?.username ||
    credentials?.walmart?.username ||
    credentials?.pkc?.username ||
    credentials?.samsClub?.username ||
    credentials?.costco?.username ||
    ""
  ).trim();
}


function exactManagedAddressMatches(
  profile,
  currentMembershipId,
  memberships,
  freeAssignments,
  rentalAssignments
) {
  const key =
    exactManagedAddressKey(
      profile
    );

  if (!key) {
    return [];
  }

  const matches = [];

  const inspect =
    (
      assignment,
      type,
      activeFn
    ) => {
      if (
        !assignment ||
        !managedAssignmentIsLinked(
          assignment
        ) ||
        exactManagedAddressKey(
          assignment.customerProfile ||
          {}
        ) !==
          key
      ) {
        return;
      }

      const membershipId =
        managedAssignmentMembershipId(
          assignment
        );

      if (
        !membershipId ||
        String(
          membershipId
        ) ===
          String(
            currentMembershipId ||
            ""
          )
      ) {
        return;
      }

      const membership =
        memberships.find(
          item =>
            String(item.id) ===
            String(membershipId)
        );

      matches.push({
        id:
          membershipId,

        type,

        profileName:
          membership?.profileName ||
          (
            type === "free"
              ? "Gifted Profile"
              : "Rented Profile"
          ),

        accountEmail:
          membership?.accountEmail ||
          ""
      });
    };

  for (
    const assignment of
    freeAssignments || []
  ) {
    inspect(
      assignment,
      "free",
      freeAssignmentIsActive
    );
  }

  for (
    const assignment of
    rentalAssignments || []
  ) {
    inspect(
      assignment,
      "rented",
      rentalAssignmentIsActive
    );
  }

  return matches;
}


function managedProfileReadiness(
  profile,
  secrets
) {
  const shippingRequired = [
    "firstName",
    "lastName",
    "address",
    "city",
    "state",
    "zip",
    "country"
  ];

  const shippingReady =
    shippingRequired.every(
      key =>
        Boolean(
          String(
            profile?.[key] ||
            ""
          ).trim()
        )
    );

  const digits =
    String(
      secrets?.acoCardNumber ||
      ""
    ).replace(
      /\D/g,
      ""
    );

  const cardReady =
    Boolean(
      String(
        secrets?.cardholder ||
        ""
      ).trim()
    ) &&
    /^\d{12,19}$/.test(
      digits
    ) &&
    /^(0[1-9]|1[0-2])$/.test(
      String(
        secrets?.expMonth ||
        ""
      )
    ) &&
    /^\d{4}$/.test(
      String(
        secrets?.expYear ||
        ""
      )
    );

  return {
    ready:
      shippingReady &&
      cardReady,

    shippingReady,
    cardReady
  };
}


async function savedCheckoutSelection(
  account,
  addressId,
  paymentId
) {
  const address =
    addressId
      ? customerSavedAddresses(
          account
        ).find(
          item =>
            String(
              item.id
            ) ===
            String(
              addressId
            )
        ) || null
      : null;

  const vault =
    await getCustomerVault(
      account.id
    );

  const payment =
    paymentId
      ? vault.paymentMethods.find(
          item =>
            String(
              item.id
            ) ===
            String(
              paymentId
            )
        ) || null
      : null;

  return {
    address,
    payment
  };
}


function shippingProfileFromSavedAddress(
  address,
  fallbackEmail = "",
  existing = {}
) {
  if (!address) {
    return existing || {};
  }

  return sanitizeProfile({
    ...(existing || {}),

    profileName:
      existing?.profileName ||
      "ACO Profile",

    firstName:
      address.firstName ||
      existing?.firstName ||
      "",

    lastName:
      address.lastName ||
      existing?.lastName ||
      "",

    email:
      existing?.email ||
      fallbackEmail ||
      "",

    phone:
      existing?.phone ||
      "",

    address:
      address.address ||
      "",

    address2:
      address.address2 ||
      "",

    city:
      address.city ||
      "",

    state:
      address.state ||
      "",

    zip:
      address.zip ||
      "",

    country:
      address.country ||
      ""
  });
}


function paymentSecretsFromSavedPayment(
  payment,
  existing = {}
) {
  if (!payment) {
    return existing || {};
  }

  return {
    ...(existing || {}),

    cardLabel:
      payment.cardLabel ||
      "",

    cardholder:
      payment.cardholder ||
      "",

    acoCardNumber:
      payment.acoCardNumber ||
      "",

    expMonth:
      payment.expMonth ||
      "",

    expYear:
      payment.expYear ||
      "",

    securityCode:
      payment.securityCode ||
      ""
  };
}


function publicProfileCardSummary(
  secrets
) {
  const digits =
    String(
      secrets?.acoCardNumber ||
      ""
    ).replace(
      /\D/g,
      ""
    );

  const readiness =
    managedProfileReadiness(
      {},
      secrets
    );

  return {
    cardLabel:
      secrets?.cardLabel ||
      "",

    cardholder:
      secrets?.cardholder ||
      "",

    maskedNumber:
      digits
        ? `•••• •••• •••• ${digits.slice(-4)}`
        : "",

    expMonth:
      secrets?.expMonth ||
      "",

    expYear:
      secrets?.expYear ||
      "",

    cardReady:
      readiness.cardReady
  };
}


function fullProfileCardDetails(
  secrets
) {
  const digits =
    String(
      secrets?.acoCardNumber ||
      ""
    ).replace(
      /\D/g,
      ""
    );

  return {
    cardLabel:
      clean(
        secrets?.cardLabel,
        100
      ),

    cardholder:
      clean(
        secrets?.cardholder,
        150
      ),

    acoCardNumber:
      digits,

    cardNumber:
      digits,

    maskedNumber:
      digits
        ? `•••• •••• •••• ${digits.slice(-4)}`
        : "",

    expMonth:
      clean(
        secrets?.expMonth,
        2
      ),

    expYear:
      clean(
        secrets?.expYear,
        4
      ),

    securityCode:
      clean(
        secrets?.securityCode,
        300
      ),

    cardReady:
      managedProfileReadiness(
        {},
        secrets || {}
      ).cardReady
  };
}


function publicCustomerAccount(
  account
) {
  const notifications =
    Array.isArray(
      account?.notifications
    )
      ? account.notifications
      : [];

  return {
    id:
      account.id,

    email:
      account.email,

    passwordChangeRequired:
      account.mustChangePassword === true,

    discordUsername:
      account.discordUsername ||
      "",

    discordLinked: Boolean(account.discordUserId && account.discordLinkedAt),

    notificationCount:
      notifications.length,

    emailVerified:
      !!account.emailVerifiedAt,

    emailVerifiedAt:
      account.emailVerifiedAt ||
      null,

    createdAt:
      account.createdAt,

    lastLoginAt:
      account.lastLoginAt ||
      null
  };
}

function createSecureToken() {
  return crypto
    .randomBytes(32)
    .toString("hex");
}

function hashSecureToken(token) {
  return crypto
    .createHash("sha256")
    .update(String(token))
    .digest("hex");
}

async function sendCustomerVerificationEmail(
  email,
  token
) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error(
      "Email service is not configured."
    );
  }

  const verifyUrl =
    `${BASE_URL}/?verifyEmail=${encodeURIComponent(
      token
    )}#my-profile`;

  const response =
    await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${process.env.RESEND_API_KEY}`,

          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          from:
            process.env.FROM_EMAIL ||
            "SLABSNGRABSACO <onboarding@resend.dev>",

          to: [email],

          subject:
            "Verify your SLABS N GRABS ACO account",

          text:
`Welcome to SLABS N GRABS ACO.

Please verify your email address by opening this secure link:

${verifyUrl}

This verification link expires in 30 minutes.

If you did not create this account, you can ignore this email.`
        })
      }
    );

  if (!response.ok) {
    throw new Error(
      "Verification email could not be sent."
    );
  }
}

async function sendSignupOrderConfirmation(account) {
  const orders = await getCustomerOwnedOrders(account.id);
  if (!orders.length || !process.env.RESEND_API_KEY) return false;
  const lines = orders.map(order => {
    const amount = Number(order.plan?.amount || 0);
    return `Order number: ${customerOrderNumber(order)}\nMembership tier: ${order.plan?.name || "Membership"}\nPrice: $${amount.toFixed(2)}${order.plan?.period ? `/${order.plan.period}` : " per month"}`;
  });
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL || "SLABSNGRABSACO <onboarding@resend.dev>",
      to: [account.email],
      subject: "Your SLABSNGRABSACO account and membership confirmation",
      text: `Welcome to SLABSNGRABSACO. Your email is verified and your membership order is linked to your website account.\n\n${lines.join("\n\n")}\n\nYour order should appear automatically in My Profile. If it does not, use the order number above and the purchase email to claim it in My Profile, or open a private support ticket.\n\nVisit ${BASE_URL}/#my-profile to access your account. No password or payment card details are included in this email.`
    })
  });
  if (!response.ok) throw new Error(`Signup confirmation email HTTP ${response.status}`);
  return true;
}

async function sendPasswordResetEmail(
  email,
  token
) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error(
      "Email service is not configured."
    );
  }

  const resetUrl =
    `${BASE_URL}/?resetPassword=${encodeURIComponent(
      token
    )}#my-profile`;

  const response =
    await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${process.env.RESEND_API_KEY}`,

          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          from:
            process.env.FROM_EMAIL ||
            "SLABSNGRABSACO <onboarding@resend.dev>",

          to: [email],

          subject:
            "Reset your SLABS N GRABS ACO password",

          text:
`A password reset was requested for your SLABS N GRABS ACO account.

Use this secure link to choose a new password:

${resetUrl}

This link expires in 15 minutes.

If you did not request a password reset, you can ignore this email.`
        })
      }
    );

  if (!response.ok) {
    throw new Error(
      "Password reset email could not be sent."
    );
  }
}

async function createEmailVerification(
  account
) {
  const rawToken =
    createSecureToken();

  const records =
    await readJson(
      EMAIL_VERIFY_FILE,
      []
    );

  const now =
    Date.now();

  const activeRecords =
    (
      Array.isArray(records)
        ? records
        : []
    ).filter(
      item =>
        Number(item.expiresAt) >
          now &&
        item.accountId !==
          account.id
    );

  activeRecords.push({
    id:
      crypto.randomUUID(),

    accountId:
      account.id,

    tokenHash:
      hashSecureToken(
        rawToken
      ),

    createdAt:
      new Date(now)
        .toISOString(),

    expiresAt:
      now +
      30 * 60 * 1000
  });

  await writeJson(
    EMAIL_VERIFY_FILE,
    activeRecords
  );

  await sendCustomerVerificationEmail(
    account.email,
    rawToken
  );
}

function requireAdmin(req, res, next) {
  const token =
    parseCookies(req)
      .sng_admin;

  const key =
    token
      ? adminSessionKey(
          token
        )
      : "";

  const session =
    key
      ? adminSessions.get(
          key
        )
      : null;

  const now =
    Date.now();

  const invalid =
    !session ||
    Number(
      session.absoluteExpires ||
      0
    ) <= now ||
    Number(
      session.idleExpires ||
      0
    ) <= now ||
    !safeEqual(
      String(
        session.userAgentHash ||
        ""
      ),
      adminUserAgentHash(
        req
      )
    );

  if (invalid) {
    if (key) {
      adminSessions.delete(
        key
      );
    }

    return res
      .status(401)
      .json({
        error:
          "Unauthorized"
      });
  }

  session.idleExpires =
    Math.min(
      now +
        ADMIN_SESSION_IDLE_MS,
      session.absoluteExpires
    );

  req.adminSession = {
    key,
    createdAt:
      session.createdAt,
    absoluteExpires:
      session.absoluteExpires
  };

  next();
}


/* -------------------------------------------------------
   OG MEMBER LAUNCH WINDOW
   September 24, 2026 8:09 AM ET
   through October 24, 2026 8:09 AM ET.

   The badge is earned permanently when a customer's
   first paid membership falls inside this window.
------------------------------------------------------- */

const OG_MEMBER_START_AT =
  Date.parse(
    "2026-09-24T12:09:00.000Z"
  );

const OG_MEMBER_END_AT =
  Date.parse(
    "2026-10-24T12:09:00.000Z"
  );

function dateFallsInOgMemberWindow(
  value
) {
  const timestamp =
    new Date(
      value || 0
    ).getTime();

  return (
    Number.isFinite(
      timestamp
    ) &&
    timestamp >=
      OG_MEMBER_START_AT &&
    timestamp <=
      OG_MEMBER_END_AT
  );
}


function recordQualifiesForOgMember(
  record
) {
  return (
    record?.ogMember ===
      true ||
    dateFallsInOgMemberWindow(
      record?.paidAt ||
      record?.createdAt
    )
  );
}


function customerHasOgMemberStatus(
  records
) {
  const list =
    Array.isArray(records)
      ? records
      : [];

  if (!list.length) {
    return false;
  }

  const paidRecords =
    list
      .filter(
        record =>
          record?.paidAt ||
          record?.createdAt
      )
      .sort(
        (a, b) =>
          new Date(
            a.paidAt ||
            a.createdAt ||
            0
          ).getTime() -
          new Date(
            b.paidAt ||
            b.createdAt ||
            0
          ).getTime()
      );

  if (!paidRecords.length) {
    return false;
  }

  /*
    Qualification is based on the customer's
    FIRST paid membership, so the badge cannot
    be earned later by cancelling/rejoining.
  */
  return recordQualifiesForOgMember(
    paidRecords[0]
  );
}



function preferPreviouslyAssignedManagedAccounts(availableAccounts, assignmentHistory, customerAccountId, retailer) {
  const intervals = new Map();
  for (const assignment of assignmentHistory) {
    if (String(assignment.customerAccountId || "") !== String(customerAccountId)) continue;
    const priorRetailer = assignment.rentalRetailer || assignment.assignmentRetailer || "";
    if (priorRetailer && String(priorRetailer) !== String(retailer)) continue;
    const id = String(assignment.managedAccountId || assignment.rentedMembershipId || assignment.freeMembershipId || "");
    if (!id) continue;
    const start = Date.parse(assignment.createdAt || assignment.startsAt || "");
    const end = Date.parse(assignment.endedAt || assignment.updatedAt || assignment.expiresAt || "");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    const ranges = intervals.get(id) || [];
    ranges.push([start, end]);
    intervals.set(id, ranges);
  }
  const scores = new Map();
  for (const [id, ranges] of intervals) {
    ranges.sort((a, b) => a[0] - b[0]);
    let duration = 0, start = ranges[0][0], end = ranges[0][1];
    for (const range of ranges.slice(1)) {
      if (range[0] <= end) end = Math.max(end, range[1]);
      else { duration += end - start; [start, end] = range; }
    }
    scores.set(id, { duration: duration + end - start, recent: end });
  }
  return [...availableAccounts].sort((a, b) => {
    const ai = scores.get(String(a.id)), bi = scores.get(String(b.id));
    if (!ai || !bi) return Number(Boolean(bi)) - Number(Boolean(ai));
    return bi.duration - ai.duration || bi.recent - ai.recent;
  });
}

/* -------------------------------------------------------
   STRIPE WEBHOOK
   MUST COME BEFORE express.json()
------------------------------------------------------- */

app.post(
  "/api/stripe-webhook",
  express.raw({
    type: "application/json"
  }),
  async (req, res) => {
    let event;

    try {
      event =
        stripe.webhooks.constructEvent(
          req.body,
          req.headers[
            "stripe-signature"
          ],
          process.env
            .STRIPE_WEBHOOK_SECRET
        );
    } catch (error) {
      console.error(
        "Stripe webhook signature verification failed:",
        error?.name ||
        "stripe_webhook_signature_error"
      );

      return res
        .status(400)
        .json({
          error:
            "Webhook signature verification failed."
        });
    }

    try {

      /* CHECKOUT COMPLETED */

      if (
        event.type ===
        "checkout.session.completed"
      ) {
        const session =
          event.data.object;

        if (
          session.metadata
            ?.purchase_type ===
          "rental"
        ) {
          const retailer =
            normalizeRentalRetailer(
              session.metadata
                ?.retailer
            );

          const quantity =
            Number(
              session.metadata
                ?.account_quantity
            );

          const durationType =
            normalizeSpecialProfileDuration(
              session.metadata
                ?.duration_type
            );

          const customerAccountId =
            clean(
              session.metadata
                ?.customer_account_id,
              150
            );

          const paidSubmissionId =
            clean(
              session.metadata
                ?.paid_submission_id,
              150
            );

          const expectedPrice =
            quantity === 1
              ? Number(session.metadata?.rental_price)
              : rentalPriceFor(quantity, durationType);

          if (
            retailer &&
            [1, 5, 10, 15].includes(
              quantity
            ) &&
            [
              "1_drop",
              "1_week",
              "1_month"
            ].includes(durationType) &&
            Number.isFinite(expectedPrice) && expectedPrice > 0 &&
            customerAccountId &&
            paidSubmissionId
          ) {
            const assignments =
              await getRentalAssignments();

            const alreadyFulfilled =
              assignments.some(
                assignment =>
                  String(
                    assignment
                      .stripeSessionId ||
                    ""
                  ) ===
                  String(session.id)
              );

            if (!alreadyFulfilled) {
              const paid =
                await readJson(
                  PAID_FILE,
                  []
                );

              const paidRecords =
                Array.isArray(paid)
                  ? paid
                  : [];

              let paidRecord =
                paidRecords.find(
                  record =>
                    String(record.id) ===
                      String(
                        paidSubmissionId
                      ) &&
                    String(
                      record.customerAccountId ||
                      ""
                    ) ===
                      String(
                        customerAccountId
                      ) &&
                    subscriptionAllowsProfiles(
                      record
                    )
                );

              if (!paidRecord && String(paidSubmissionId).startsWith("gift:")) {
                const giftId = String(paidSubmissionId).slice(5);
                const grants = await getGiftedMemberships();
                const now = Date.now();
                const gift = grants.find(item =>
                  String(item.id) === giftId &&
                  String(item.customerAccountId) === String(customerAccountId) &&
                  new Date(item.startsAt).getTime() <= now &&
                  new Date(item.expiresAt).getTime() > now
                );
                if (gift) paidRecord = { id: paidSubmissionId, customerAccountId, profile: { email: gift.customerEmail } };
              }

              if (!paidRecord) {
                console.error(
                  "Rental fulfillment skipped: active paid membership was not found.",
                  session.id
                );
              } else {
                const rentalOrderNumber = newCustomerOrderNumber();
                const rawAvailableAccounts =
                  await getAvailableManagedAccountsForRetailer(
                    retailer,
                    {
                      restoreCustomerAccountId:
                        customerAccountId,

                      restoreType:
                        "rented"
                    }
                  );

                const rentalHistory = [
                  ...await getRentalAssignments(),
                  ...await getFreeAssignments()
                ];

                const availableAccounts =
                  preferPreviouslyAssignedManagedAccounts(
                    rawAvailableAccounts,
                    rentalHistory,
                    customerAccountId,
                    retailer
                  );

                if (
                  availableAccounts.length <
                  quantity
                ) {
                  console.error(
                    "Rental fulfillment inventory shortage:",
                    session.id,
                    retailer,
                    quantity,
                    availableAccounts.length
                  );

                  if (
                    session.payment_intent
                  ) {
                    try {
                      await stripe
                        .refunds
                        .create({
                          payment_intent:
                            typeof session
                              .payment_intent ===
                              "string"
                              ? session
                                  .payment_intent
                              : session
                                  .payment_intent
                                  .id
                        });
                    } catch (refundError) {
                      console.error(
                        "Automatic rental refund failed:",
                        refundError.message
                      );
                    }
                  }
                } else {
                  const now =
                    new Date();

                  const startsAt =
                    now.toISOString();

                  const expiresAt =
                    specialProfileExpiresAt(
                      durationType,
                      now
                    );

                  const customerProfile =
                    sanitizeProfile(
                      paidRecord.profile ||
                      {}
                    );

                  const paidSecrets =
                    String(paidRecord.id).startsWith("gift:")
                      ? null
                      : await loadEncryptedPackage(paidRecord.id);

                  const rentalCustomer = (await getCustomerAccounts()).find(item => String(item.id) === String(customerAccountId));
                  const reservedRentalJigs = new Set();

                  for (
                    const account of
                    availableAccounts.slice(
                      0,
                      quantity
                    )
                  ) {
                    assignments.push({
                      id:
                        crypto.randomUUID(),

                      rentedMembershipId:
                        account.id,

                      managedAccountId:
                        account.id,

                      customerAccountId,

                      paidSubmissionId:
                        paidRecord.id,

                      active: true,

                      durationType,

                      activationStatus:
                        "awaiting_activation",

                      activationRequestedAt:
                        now.toISOString(),

                      startsAt:
                        null,

                      expiresAt:
                        null,

                      customerProfile,

                      customerSecrets:
                        paidSecrets
                          ? encryptJson(
                              paidSecrets
                            )
                          : null,

                      stripeSessionId:
                        session.id,

                      orderNumber: rentalOrderNumber,

                      stripePaymentIntentId:
                        typeof session
                          .payment_intent ===
                          "string"
                          ? session
                              .payment_intent
                          : session
                              .payment_intent
                              ?.id ||
                            null,

                      stripeCustomerId:
                        typeof session
                          .customer ===
                          "string"
                          ? session.customer
                          : session.customer
                              ?.id ||
                            null,

                      rentalRetailer:
                        retailer,

                      rentalPrice:
                        expectedPrice,

                      createdAt:
                        startsAt,

                      updatedAt:
                        startsAt,

                      endedAt: null,

                      endReason: null
                    });
                    await prepareNewManagedAssignment(assignments.at(-1), account, rentalCustomer, paidRecord, reservedRentalJigs);
                  }

                  for (
                    const assignment of
                    assignments
                  ) {
                    if (
                      String(
                        assignment.stripeSessionId ||
                        ""
                      ) ===
                        String(
                          session.id
                        ) &&
                      assignment.activationStatus ===
                        "awaiting_activation"
                    ) {
                      await ensureManagedProfileDiscordMessage(
                        assignment,
                        "rented"
                      );
                    }
                  }

                  await saveRentalAssignments(
                    assignments
                  );

                  try {
                    await sendPaidOrderConfirmation(customerAccountId, {
                      id: session.id,
                      orderNumber: rentalOrderNumber,
                      plan: { name: `${quantity} ${retailerDisplayName(retailer)} rental profiles` },
                      paidAt: new Date().toISOString()
                    }, session.amount_total != null ? Number(session.amount_total) / 100 : expectedPrice,
                    `Rental duration: ${durationType === "1_month" ? "1 Month" : durationType === "1_week" ? "1 Week" : "1 Drop"}\nLinked membership order: ${customerOrderNumber(paidRecord)}`);
                  } catch (error) {
                    console.error("Customer rental confirmation:", error.message);
                  }

                  await consumeRestoreHoldItems(
                    customerAccountId,
                    "rented",
                    availableAccounts
                      .slice(
                        0,
                        quantity
                      )
                      .map(
                        account =>
                          account.id
                      )
                  );

                  try {
                    const retailerLabel = retailerDisplayName(retailer);

                    const durationLabel =
                      durationType ===
                        "1_week"
                        ? "1 Week"
                        : durationType ===
                          "1_month"
                          ? "1 Month"
                          : "1 Drop";

                    const rentalPaymentMessageId =
                      await sendDiscordAdminPaymentNotification({
                      paymentType:
                        "Rental purchase",

                      headline:
                        "A rental package payment was received and fulfilled.",

                      amount:
                        moneyFromStripeCents(
                          session.amount_total
                        ) ||
                        expectedPrice,

                      profile:
                        paidRecord.profile ||
                        {},

                      customerEmail:
                        session
                          ?.customer_details
                          ?.email ||
                        paidRecord
                          ?.profile
                          ?.email ||
                        "",

                      purchaseSummary:
                        `${quantity} ${retailerLabel} rental account(s) — ${durationLabel}`,

                      orderId:
                        paidRecord.id,

                      retailer:
                        retailerLabel,

                      quantity,

                      duration:
                        durationLabel,

                      paidAt:
                        new Date()
                          .toISOString()
                    });

                    if (
                      rentalPaymentMessageId &&
                      rentalPaymentMessageId !== true
                    ) {
                      for (
                        const assignment of
                        assignments
                      ) {
                        if (
                          String(
                            assignment.stripeSessionId ||
                            ""
                          ) ===
                          String(
                            session.id
                          )
                        ) {
                          assignment.adminPaymentDiscordMessageId =
                            rentalPaymentMessageId;
                        }
                      }

                      await saveRentalAssignments(
                        assignments
                      );
                    }

                  } catch (error) {
                    console.error(
                      "Admin rental payment Discord notification failed:",
                      error.message
                    );
                  }
                }
              }
            }
          }
        }

        const id =
          session.metadata
            ?.submission_id;

        if (id) {
          const pending =
            await readJson(
              PENDING_FILE,
              {}
            );

          const entry =
            pending[id];

          if (entry) {
            const record = {
              id,

              orderNumber: entry.orderNumber || newCustomerOrderNumber(),

              plan: entry.plan,
              profile: entry.profile,

              customerAccountId:
                entry.customerAccountId ||
                null,

              customerLinkedAt:
                entry.customerAccountId
                  ? new Date().toISOString()
                  : null,

              createdAt:
                entry.createdAt,

              purchaseAuthorizationAcceptedAt:
                entry.purchaseAuthorizationAcceptedAt || null,

              consentRecordId:
                entry.consentRecordId || null,

              paidAt:
                new Date()
                  .toISOString(),

              ogMember:
                false,

              stripeSessionId:
                session.id,

              stripeCustomerId:
                session.customer || null,

              stripeSubscriptionId:
                session.subscription || null,

              subscriptionStatus:
                "active",

              currentPeriodEnd:
                null
            };

            /*
              Permanently mark qualifying launch
              members. Qualification is based on
              the customer's first paid membership.
            */

            if (
              record.customerAccountId
            ) {
              const existingPaid =
                await readJson(
                  PAID_FILE,
                  []
                );

              const customerPaidRecords =
                (
                  Array.isArray(
                    existingPaid
                  )
                    ? existingPaid
                    : []
                )
                  .filter(
                    item =>
                      String(
                        item.customerAccountId ||
                        ""
                      ) ===
                      String(
                        record.customerAccountId
                      )
                  );

              record.ogMember =
                (await getCustomerAccounts()).some(account =>
                  String(account.id) === String(record.customerAccountId) && account.ogMemberGrantedAt
                ) || customerHasOgMemberStatus(
                  [
                    ...customerPaidRecords,
                    record
                  ]
                );
            } else {
              record.ogMember =
                dateFallsInOgMemberWindow(
                  record.paidAt
                );
            }


            /*
              Retrieve the subscription so the
              actual Stripe billing period can
              be stored.
            */

            if (
              record.stripeSubscriptionId
            ) {
              try {
                const subscription =
                  await stripe
                    .subscriptions
                    .retrieve(
                      record
                        .stripeSubscriptionId
                    );

                await applySubscriptionInfo(
                  record,
                  subscription
                );

              } catch (error) {
                console.error(
                  "Subscription lookup failed:",
                  error.message
                );
              }
            }

            const paid =
              await readJson(
                PAID_FILE,
                []
              );

            /*
              Avoid duplicate records if Stripe
              retries the webhook.
            */

            const existingIndex =
              paid.findIndex(
                item =>
                  item.id === id
              );

            if (
              existingIndex >= 0
            ) {
              record.orderNumber = paid[existingIndex].orderNumber || record.orderNumber;
              record.customerConfirmationSentAt = paid[existingIndex].customerConfirmationSentAt || null;
              paid[existingIndex] =
                record;
            } else {
              paid.push(record);
            }

            await writeJson(
              PAID_FILE,
              paid
            );

            if (existingIndex < 0 && record.consentRecordId) {
              await appendConsentRecord({
                type: "checkout_payment_confirmed", accountId: record.customerAccountId,
                submissionId: id, consentRecordId: record.consentRecordId,
                stripeSessionId: session.id, paidAt: record.paidAt
              });
            }

            if (!record.customerConfirmationSentAt) {
              try {
                await sendPaidOrderConfirmation(
                  record.customerAccountId,
                  record,
                  session.amount_total != null ? Number(session.amount_total) / 100 : Number(record.plan?.amount || 0),
                  `Membership tier: ${record.plan?.name || "Membership"}\nProfiles: ${Number(record.plan?.profiles || 0)}\nBilling: Monthly`
                );
                record.customerConfirmationSentAt = new Date().toISOString();
                const latest = await readJson(PAID_FILE, []);
                const current = latest.find(item => item.id === record.id);
                if (current) {
                  current.customerConfirmationSentAt = record.customerConfirmationSentAt;
                  await writeJson(PAID_FILE, latest);
                }
              } catch (error) {
                console.error("Customer membership confirmation:", error.message);
              }
            }

            delete pending[id];

            await writeJson(
              PENDING_FILE,
              pending
            );

            try {
              await sendNotification(
                record
              );
            } catch (error) {
              console.error(
                "Notification failed:",
                error.message
              );
            }

            try {
              const paidPaymentMessageId =
                await sendDiscordAdminPaymentNotification({
                paymentType:
                  "New paid membership",

                headline:
                  "A new paid membership was purchased.",

                amount:
                  moneyFromStripeCents(
                    session.amount_total
                  ) ||
                  Number(
                    record
                      ?.plan
                      ?.amount ||
                    0
                  ),

                profile:
                  record.profile ||
                  {},

                customerEmail:
                  session
                    ?.customer_details
                    ?.email ||
                  record
                    ?.profile
                    ?.email ||
                  "",

                purchaseSummary:
                  `${record.plan?.name || "Membership"} — ${Number(
                    record.plan?.profiles ||
                    0
                  )} profile(s) / month`,

                orderId:
                  record.id,

                profiles:
                  record.plan
                    ?.profiles ??
                  null,

                paidAt:
                  record.paidAt
              });

              if (
                paidPaymentMessageId &&
                paidPaymentMessageId !== true
              ) {
                record.adminPaymentDiscordMessageId =
                  paidPaymentMessageId;

                const latestPaid =
                  await readJson(
                    PAID_FILE,
                    []
                  );

                const latestIndex =
                  Array.isArray(
                    latestPaid
                  )
                    ? latestPaid.findIndex(
                        item =>
                          String(
                            item.id
                          ) ===
                          String(
                            record.id
                          )
                      )
                    : -1;

                if (
                  latestIndex >= 0
                ) {
                  latestPaid[
                    latestIndex
                  ] = record;

                  await writeJson(
                    PAID_FILE,
                    latestPaid
                  );
                }
              }

            } catch (error) {
              console.error(
                "Admin membership payment Discord notification failed:",
                error.message
              );
            }
          }
        }
      }

      /*
        SUBSCRIPTION INVOICE PAID
        Covers recurring renewals and immediate
        upgrade/proration invoices.
      */

      if (
        event.type ===
        "invoice.payment_succeeded"
      ) {
        try {
          await sendAdminSubscriptionInvoiceNotification(
            event.data.object
          );
        } catch (error) {
          console.error(
            "Admin recurring payment Discord notification failed:",
            error.message
          );
        }
      }

      /* SUBSCRIPTION UPDATED / CANCELED */

      if (
        event.type ===
        "customer.subscription.updated" ||
        event.type ===
        "customer.subscription.deleted"
      ) {
        const subscription =
          event.data.object;

        const paid =
          await readJson(
            PAID_FILE,
            []
          );

        let changed =
          false;

        for (
          const record of
          paid
        ) {
          if (
            String(
              record
                .stripeSubscriptionId ||
              ""
            ) !==
            String(
              subscription.id
            )
          ) {
            continue;
          }

          const previousStatus =
            String(
              record
                .subscriptionStatus ||
              ""
            ).toLowerCase();

          const previousCancelAtPeriodEnd =
            record
              .cancelAtPeriodEnd ===
            true;

          await applySubscriptionInfo(
            record,
            subscription
          );

          record.subscriptionUpdatedAt =
            new Date()
              .toISOString();

          const currentStatus =
            String(
              record
                .subscriptionStatus ||
              subscription?.status ||
              ""
            ).toLowerCase();

          const currentCancelAtPeriodEnd =
            record
              .cancelAtPeriodEnd ===
            true ||
            subscription
              ?.cancel_at_period_end ===
            true;

          /*
            Notify immediately when the member first
            schedules cancellation for period end.
          */
          if (
            currentCancelAtPeriodEnd &&
            !previousCancelAtPeriodEnd
          ) {
            try {
              await notifyScheduledMembershipCancellation(
                record,
                subscription
              );
            } catch (error) {
              console.error(
                "Scheduled cancellation Discord notification failed:",
                error.message
              );
            }
          }

          /*
            Notify when Stripe reports the subscription
            actually ended. customer.subscription.deleted
            covers the normal end-of-period lapse too.
          */
          const endedNow =
            event.type ===
              "customer.subscription.deleted" ||
            (
              [
                "canceled",
                "cancelled",
                "unpaid",
                "incomplete_expired"
              ].includes(
                currentStatus
              ) &&
              ![
                "canceled",
                "cancelled",
                "unpaid",
                "incomplete_expired"
              ].includes(
                previousStatus
              )
            );

          if (endedNow) {
            try {
              await notifyEndedMembership(
                record,
                {
                  subscription,

                  reason:
                    event.type ===
                      "customer.subscription.deleted"
                      ? (
                          currentCancelAtPeriodEnd ||
                          previousCancelAtPeriodEnd
                            ? "Scheduled cancellation reached the end of the billing period."
                            : "Subscription was canceled."
                        )
                      : `Subscription status changed to ${currentStatus || "ended"}.`
                }
              );
            } catch (error) {
              console.error(
                "Membership ended Discord notification failed:",
                error.message
              );
            }
          }

          changed =
            true;
        }

        if (changed) {
          await writeJson(
            PAID_FILE,
            paid
          );
        }
      }

    } catch (error) {
      console.error(
        "Webhook processing error:",
        error
      );

      /*
        Return 500 so Stripe can retry
        processing this event.
      */

      return res
        .status(500)
        .json({
          error:
            "Webhook processing failed"
        });
    }

    res.json({
      received: true
    });
  }
);

/* -------------------------------------------------------
   NORMAL JSON MIDDLEWARE
------------------------------------------------------- */

app.use(
  express.json({
    limit: "50kb",
    strict: true
  })
);

/*
  The Stripe webhook route is intentionally declared before this
  section so its signed raw body bypasses JSON/CSRF middleware.
*/
app.use(
  "/api",
  apiAbuseRateLimit
);

app.use(
  "/api",
  requireSameOriginMutation
);

app.use(
  "/api",
  requireJsonForMutation
);

app.use(
  "/api",
  rejectUnsafeJsonKeys
);


/*
  Security audit entries never include request bodies or credentials.
  The authenticated subject is detected after route middleware runs.
*/
app.use(
  "/api/admin",
  (req, res, next) => {
    if (
      ![
        "GET",
        "HEAD",
        "OPTIONS"
      ].includes(
        req.method
      )
    ) {
      res.on(
        "finish",
        () => {
          if (
            req.adminSession &&
            req.path !==
              "/login" &&
            req.path !==
              "/logout"
          ) {
            appendSecurityAudit({
              event:
                "admin_mutation",

              requestId:
                req.securityRequestId,

              method:
                req.method,

              path:
                req.path,

              status:
                res.statusCode,

              ip:
                req.ip,

              userAgent:
                req.headers[
                  "user-agent"
                ]
            });
          }
        }
      );
    }

    next();
  }
);


app.use(
  "/api/account",
  (req, res, next) => {
    if (
      ![
        "GET",
        "HEAD",
        "OPTIONS"
      ].includes(
        req.method
      )
    ) {
      res.on(
        "finish",
        () => {
          if (
            req.customerAccount
          ) {
            appendSecurityAudit({
              event:
                "customer_mutation",

              requestId:
                req.securityRequestId,

              method:
                req.method,

              path:
                req.path,

              status:
                res.statusCode,

              ip:
                req.ip,

              userAgent:
                req.headers[
                  "user-agent"
                ],

              subject:
                req.customerAccount
                  .id
            });
          }
        }
      );
    }

    next();
  }
);


/* -------------------------------------------------------
   ADMIN PAGE
------------------------------------------------------- */

app.get(
  "/admin",
  (req, res) => {
    res.set(
      "Cache-Control",
      "no-store, private, max-age=0"
    );

    res.set(
      "X-Robots-Tag",
      "noindex, nofollow, noarchive"
    );

    res.sendFile(
      path.join(
        __dirname,
        "public",
        "admin.html"
      )
    );
  }
);


app.get(
  "/admin.html",
  (req, res) => {
    return res.redirect(
      302,
      "/admin"
    );
  }
);


app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    ),
    {
      dotfiles:
        "deny",

      fallthrough:
        true,

      index:
        "index.html",

      setHeaders:
        (
          res,
          filePath
        ) => {
          if (
            filePath.endsWith(
              ".html"
            )
          ) {
            res.setHeader(
              "Cache-Control",
              "no-cache"
            );
          }
        }
    }
  )
);

/* -------------------------------------------------------
   CUSTOMER ACCOUNT ROUTES
------------------------------------------------------- */

const discordOAuthStates = new Map();
const discordPendingIdentities = new Map();
const discordRedirectUri = `${BASE_URL.replace(/\/$/, "")}/api/discord/oauth/callback`;
let discordOAuthClientId;
let communityInviteCache = null;
let communityInviteRequest = null;

app.get("/join-discord", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    if (!communityInviteCache || communityInviteCache.expiresAt <= Date.now()) {
      communityInviteRequest ||= (async () => {
        const config = await resolvedDiscordSuccessConfig();
        const url = await getCommunityInvite(config);
        communityInviteCache = { url, expiresAt: Date.now() + 5 * 60 * 1000 };
        return url;
      })().finally(() => { communityInviteRequest = null; });
      await communityInviteRequest;
    }
    return res.redirect(302, communityInviteCache.url);
  } catch (error) {
    console.error("Discord community invite:", error.message);
    return res.status(503).send("The Discord invite is temporarily unavailable. Please try again shortly.");
  }
});

app.get("/api/discord/oauth/start", async (req, res) => {
  try {
    if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_CLIENT_SECRET) {
      return res.status(503).send("Discord authorization is not configured yet.");
    }
    const context = req.query.context === "account" ? "account" : "signup";
    const account = context === "account" ? await getAuthenticatedCustomer(req) : null;
    if (context === "account" && !account) return res.status(401).send("Sign in before connecting Discord.");
    if (account?.discordLinkedAt) return res.status(409).send("Unlink your current Discord account before connecting another one.");
    if (!discordOAuthClientId) {
      const response = await fetch("https://discord.com/api/v10/users/@me", {
        headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }, signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) throw new Error(`Discord bot identity HTTP ${response.status}`);
      discordOAuthClientId = (await response.json()).id;
    }
    const state = crypto.randomBytes(24).toString("hex");
    discordOAuthStates.set(state, { context, accountId: account?.id, linkVersion: Number(account?.discordLinkVersion || 0), expiresAt: Date.now() + 600000 });
    const url = new URL("https://discord.com/oauth2/authorize");
    url.search = new URLSearchParams({ client_id: discordOAuthClientId, response_type: "code", redirect_uri: discordRedirectUri, scope: "identify", state }).toString();
    res.redirect(url.toString());
  } catch (error) {
    console.error("Discord authorization start:", error.message);
    res.status(502).send("Unable to start Discord authorization.");
  }
});

app.get("/api/discord/oauth/callback", async (req, res) => {
  const state = String(req.query.state || "");
  const pending = discordOAuthStates.get(state);
  discordOAuthStates.delete(state);
  let payload = { type: "slabsngrabsaco-discord", error: "Discord authorization was canceled or expired." };
  try {
    if (!pending || pending.expiresAt < Date.now() || typeof req.query.code !== "string") throw new Error("OAuth state invalid or expired");
    const tokenResponse = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: discordOAuthClientId, client_secret: process.env.DISCORD_CLIENT_SECRET || "", grant_type: "authorization_code", code: req.query.code, redirect_uri: discordRedirectUri }),
      signal: AbortSignal.timeout(10000)
    });
    if (!tokenResponse.ok) throw new Error(`Discord OAuth token HTTP ${tokenResponse.status}`);
    const accessToken = (await tokenResponse.json()).access_token;
    const identityResponse = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10000)
    });
    if (!identityResponse.ok) throw new Error(`Discord identity HTTP ${identityResponse.status}`);
    const identity = await identityResponse.json();
    if (!/^\d{17,22}$/.test(identity.id) || !identity.username) throw new Error("Invalid Discord identity");
    const accounts = await getCustomerAccounts();
    if (accounts.some(item => String(item.discordUserId || "") === identity.id && item.id !== pending.accountId)) {
      payload.error = "This Discord account is already linked to another website account.";
    } else if (pending.context === "account") {
      const signedIn = await getAuthenticatedCustomer(req);
      if (!signedIn || signedIn.id !== pending.accountId || signedIn.discordLinkedAt ||
        Number(signedIn.discordLinkVersion || 0) !== pending.linkVersion) throw new Error("Customer session or Discord connection changed");
      const account = accounts.find(item => item.id === signedIn.id);
      account.discordUserId = identity.id;
      account.discordLinkedAt = new Date().toISOString();
      account.discordUsername = identity.username;
      account.updatedAt = account.discordLinkedAt;
      await saveCustomerAccounts(accounts);
      payload = { type: "slabsngrabsaco-discord", username: identity.username, linked: true };
    } else {
      const ticket = crypto.randomBytes(24).toString("hex");
      discordPendingIdentities.set(ticket, { id: identity.id, username: identity.username, expiresAt: Date.now() + 600000 });
      payload = { type: "slabsngrabsaco-discord", username: identity.username, ticket };
    }
  } catch (error) {
    console.error("Discord authorization callback:", error.message);
  }
  const safePayload = JSON.stringify(payload).replace(/</g, "\\u003c");
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Discord connection</title><p id="discord-callback-message">Returning to SLABSNGRABSACO…</p><script id="discord-callback-payload" type="application/json">${safePayload}</script><script src="/discord-oauth-callback.js" defer></script>`);
});

app.post(
  "/api/account/register",
  customerAuthRateLimit,
  async (req, res) => {
    try {
      const email =
        normalizeEmail(
          req.body.email
        );

      const password =
        String(
          req.body.password || ""
        );

      if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
          email
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Enter a valid email address."
          });
      }

      if (
        password.length < 12 ||
        password.length > 200
      ) {
        return res
          .status(400)
          .json({
            error:
              "Password must be at least 12 characters."
          });
      }

      const accounts =
        await getCustomerAccounts();

      const existing =
        accounts.find(
          account =>
            normalizeEmail(
              account.email
            ) === email
        );

      if (existing) {
        return res
          .status(409)
          .json({
            error:
              "An account already exists for this email address."
          });
      }

      const referredByDiscord = referralDiscordValue(req.body.referredByDiscord);
      if (referredByDiscord === null) {
        return res.status(400).json({ error: "Enter a Discord @username or a Discord user mention for the person who referred you." });
      }
      const referrer = findLinkedReferrer(accounts, referredByDiscord);
      if (referredByDiscord && !referrer) {
        return res.status(400).json({ error: "We could not find that referral. Ask the member to connect Discord in My Profile, or leave the referral field blank." });
      }

      const passwordData =
        await hashCustomerPassword(
          password
        );

      const discordTicket = String(req.body.discordVerificationTicket || "");
      const verifiedDiscord = discordPendingIdentities.get(discordTicket);
      if (verifiedDiscord && verifiedDiscord.expiresAt <= Date.now()) discordPendingIdentities.delete(discordTicket);
      if (verifiedDiscord && verifiedDiscord.expiresAt > Date.now() &&
        accounts.some(item => item.discordUserId === verifiedDiscord.id)) {
        return res.status(409).json({ error: "This Discord account is already linked to another website account." });
      }
      if (referrer && verifiedDiscord?.id === referrer.discordUserId) {
        return res.status(400).json({ error: "You cannot refer yourself." });
      }

      const now =
        new Date().toISOString();

      const account = {
        id:
          crypto.randomUUID(),

        email,

        referredByDiscord,

        referredByAccountId: referrer?.id || null,

        referralRecordedAt: referrer ? now : null,

        discordUsername:
          verifiedDiscord?.expiresAt > Date.now() ? verifiedDiscord.username : clean(req.body.discordUsername, 100),

        ...(verifiedDiscord?.expiresAt > Date.now() ? {
          discordUserId: verifiedDiscord.id, discordLinkedAt: new Date().toISOString()
        } : {}),

        notifications: [],

        passwordSalt:
          passwordData.salt,

        passwordHash:
          passwordData.hash,

        emailVerifiedAt:
          null,

        createdAt:
          now,

        updatedAt:
          now,

        lastLoginAt:
          now,

        sessionVersion:
          1,

        disabled:
          false
      };

      accounts.push(account);

      await saveCustomerAccounts(
        accounts
      );
      if (verifiedDiscord) discordPendingIdentities.delete(discordTicket);

      // Registration has no card-consent checkboxes. Record that distinction
      // explicitly; purchase authorization is recorded at membership checkout.
      const signupRecord = await appendConsentRecord({
        type: "signup_completed", accountId: account.id, email: account.email,
        emailVerifiedAt: null, cardPurchaseConsentAtSignup: false,
        ...consentRequestMetadata(req)
      });
      await queueConsentReceipt(
        `New website signup — ${account.email}`,
        `Website account created\n\nAccount ID: ${account.id}\nEmail: ${account.email}\nServer signup time (UTC): ${signupRecord.recordedAt}\nAudit record ID: ${signupRecord.id}\n\nNo card or purchase authorization checkbox is presented during account registration. Those choices are recorded separately when a member starts a membership checkout. No card number or security code is included.`
      ).catch(error => console.error("Signup owner email queue:", error.message));

      if (referrer) {
        try {
          await notifyReferralSignup(account);
          account.referralSignupAlertAt = new Date().toISOString();
          await saveCustomerAccounts(accounts);
        } catch (error) {
          console.error("Private referral signup notification:", error.message);
        }
      }

      const autoLinkResult =
  await autoLinkVerifiedCustomerOrders(
    account
  );

      try {
        await createEmailVerification(
          account
        );
      } catch (error) {
        console.error(
          "Verification email send failed:",
          error.message
        );
      }

      setCustomerSession(
        res,
        account
      );

      customerAuthAttempts.delete(
        req.ip ||
        "unknown"
      );

      await appendSecurityAudit({
        event:
          "customer_registration_success",

        requestId:
          req.securityRequestId,

        method:
          req.method,

        path:
          req.path,

        status:
          201,

        ip:
          req.ip,

        userAgent:
          req.headers[
            "user-agent"
          ],

        subject:
          account.id
      });

      return res
        .status(201)
        .json({
          ok: true,

          account:
            publicCustomerAccount(
              account
            )
        });

    } catch (error) {
      console.error(
        "Customer registration error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to create your account."
        });
    }
  }
);

app.post(
  "/api/account/login",
  customerAuthRateLimit,
  async (req, res) => {
    try {
      const email =
        normalizeEmail(
          req.body.email
        );

      const password =
        String(
          req.body.password || ""
        );

      const accounts =
        await getCustomerAccounts();

      const account =
        accounts.find(
          item =>
            normalizeEmail(
              item.email
            ) === email
        );

      /*
        Use the same public error whether the
        email or password is incorrect.
      */

      if (
        !account ||
        account.disabled === true
      ) {
        await appendSecurityAudit({
          event:
            "customer_login_failure",

          requestId:
            req.securityRequestId,

          method:
            req.method,

          path:
            req.path,

          status:
            401,

          ip:
            req.ip,

          userAgent:
            req.headers[
              "user-agent"
            ],

          subject:
            email,

          detail:
            "invalid_credentials"
        });

        return res
          .status(401)
          .json({
            error:
              "Incorrect email or password."
          });
      }

      if (account.mustChangePassword && Date.parse(account.temporaryPasswordExpiresAt || "") <= Date.now()) {
        return res.status(401).json({ error: "Your temporary password has expired. Ask support to reset it again." });
      }

      const passwordValid =
        await verifyCustomerPassword(
          password,
          account
        );

      if (!passwordValid) {
        await appendSecurityAudit({
          event:
            "customer_login_failure",

          requestId:
            req.securityRequestId,

          method:
            req.method,

          path:
            req.path,

          status:
            401,

          ip:
            req.ip,

          userAgent:
            req.headers[
              "user-agent"
            ],

          subject:
            email,

          detail:
            "invalid_credentials"
        });

        return res
          .status(401)
          .json({
            error:
              "Incorrect email or password."
          });
      }

      account.lastLoginAt =
        new Date().toISOString();

      account.updatedAt =
        account.updatedAt ||
        account.lastLoginAt;

      await saveCustomerAccounts(
        accounts
      );

      setCustomerSession(
        res,
        account
      );

      customerAuthAttempts.delete(
        req.ip ||
        "unknown"
      );

      await appendSecurityAudit({
        event:
          "customer_login_success",

        requestId:
          req.securityRequestId,

        method:
          req.method,

        path:
          req.path,

        status:
          200,

        ip:
          req.ip,

        userAgent:
          req.headers[
            "user-agent"
          ],

        subject:
          account.id
      });

      return res.json({
        ok: true,

        account:
          publicCustomerAccount(
            account
          )
      });

    } catch (error) {
      console.error(
        "Customer login error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to sign in."
        });
    }
  }
);

app.post("/api/account/purchase-consent-event", requireCustomer, async (req, res) => {
  try {
    const flowId = String(req.body?.flowId || "");
    const checkbox = String(req.body?.checkbox || "");
    if (!/^[0-9a-f-]{36}$/i.test(flowId) || !PURCHASE_CONSENT_KEYS.includes(checkbox) ||
      typeof req.body?.checked !== "boolean") {
      return res.status(400).json({ error: "Invalid consent event." });
    }
    const clientTime = Date.parse(String(req.body?.clientClickedAt || ""));
    const event = await appendConsentRecord({
      type: "checkbox_event", accountId: req.customerAccount.id, flowId,
      checkbox, checked: req.body.checked, consentVersion: PURCHASE_CONSENT_VERSION,
      displayedText: PURCHASE_CONSENT_TEXT[checkbox],
      clientReportedClickAt: Number.isFinite(clientTime) && Math.abs(Date.now() - clientTime) < 24 * 60 * 60 * 1000
        ? new Date(clientTime).toISOString() : null,
      ...consentRequestMetadata(req)
    });
    return res.json({ ok: true, id: event.id, receivedAt: event.recordedAt });
  } catch (error) {
    console.error("Consent checkbox record failed:", error.message);
    return res.status(503).json({ error: "Unable to record consent right now. Please try again." });
  }
});

app.get("/api/admin/signup-consent-log", requireAdmin, async (req, res) => {
  try {
    await consentLedgerQueue;
    const { entries } = await readConsentLedger();
    const pendingReceipts = await readConsentEmailQueue();
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
    return res.json({ ok: true, total: entries.length, offset,
      pendingEmailReceipts: Array.isArray(pendingReceipts) ? pendingReceipts.length : 0,
      receiptEmail: CONSENT_RECEIPT_EMAIL,
      entries: entries.slice(Math.max(0, entries.length - offset - limit), Math.max(0, entries.length - offset)).reverse() });
  } catch (error) {
    console.error("Consent ledger read failed:", error.message);
    return res.status(503).json({ error: "Consent ledger is unavailable or failed its integrity check." });
  }
});

app.post(
  "/api/account/logout",
  async (req, res) => {
    try {
      const account =
        await getAuthenticatedCustomer(
          req
        );

      if (account) {
        const accounts =
          await getCustomerAccounts();

        const stored =
          accounts.find(
            item =>
              String(
                item.id
              ) ===
              String(
                account.id
              )
          );

        if (stored) {
          stored.sessionVersion =
            customerSessionVersion(
              stored
            ) + 1;

          stored.updatedAt =
            new Date()
              .toISOString();

          await saveCustomerAccounts(
            accounts
          );
        }
      }
    } catch (error) {
      console.error(
        "Customer logout session revocation failed:",
        error?.message ||
        "logout_revocation_error"
      );
    }

    clearCustomerSession(
      res
    );

    return res.json({
      ok: true
    });
  }
);

app.get(
  "/api/account/session",
  async (req, res) => {
    try {
      const account =
        await getAuthenticatedCustomer(
          req
        );

      if (!account) {
        return res
          .status(401)
          .json({
            authenticated:
              false
          });
      }

      return res.json({
        authenticated:
          true,

        account:
          publicCustomerAccount(
            account
          )
      });

    } catch (error) {
      console.error(
        "Customer session error:",
        error
      );

      return res
        .status(401)
        .json({
          authenticated:
            false
        });
    }
  }
);

app.put(
  "/api/account/discord",
  requireCustomer,
  async (req, res) => {
    try {
      const accounts =
        await getCustomerAccounts();

      const account =
        accounts.find(
          item =>
            String(item.id) ===
            String(
              req.customerAccount.id
            )
        );

      if (!account) {
        return res
          .status(404)
          .json({
            error:
              "Customer account could not be found."
          });
      }

      if (!account.discordLinkedAt) {
        account.discordUsername = clean(req.body?.discordUsername, 100);
      }

      // Editing a display name never changes the verified Discord link.

      account.updatedAt =
        new Date()
          .toISOString();

      await saveCustomerAccounts(
        accounts
      );

      return res.json({
        ok: true,
        account:
          publicCustomerAccount(
            account
          )
      });

    } catch (error) {
      console.error(
        "Discord settings update error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to save Discord information."
        });
    }
  }
);

app.post("/api/account/discord-link", requireCustomer, async (req, res) => {
  try {
    if (req.customerAccount.discordLinkedAt) return res.status(409).json({ error: "Unlink your current Discord account first." });
    if (!process.env.DISCORD_BOT_TOKEN) return res.status(503).json({ error: "Discord linking is not configured yet." });
    const code = await createDiscordLinkCode(DATA_DIR, req.customerAccount.id);
    res.json({ code, expiresInSeconds: 600 });
  } catch (error) {
    console.error("Discord link code error:", error);
    res.status(500).json({ error: "Unable to create a Discord link code." });
  }
});

app.delete("/api/account/discord-link", requireCustomer, async (req, res) => {
  try {
    const accounts = await getCustomerAccounts();
    const account = accounts.find(item => String(item.id) === String(req.customerAccount.id));
    if (!account) return res.status(404).json({ error: "Customer account could not be found." });
    if (account.discordUserId && account.discordLinkedAt) {
      const oldDiscordId = account.discordUserId;
      account.discordLinkVersion = Number(account.discordLinkVersion || 0) + 1;
      delete account.discordUserId;
      delete account.discordLinkedAt;
      account.discordUsername = "";
      account.updatedAt = new Date().toISOString();
      await saveCustomerAccounts(accounts);
      await queueDiscordRoleRemoval(DATA_DIR, oldDiscordId);
    }
    await revokeDiscordLinkCodes(DATA_DIR, account.id);
    for (const [state, pending] of discordOAuthStates) {
      if (pending.accountId === account.id) discordOAuthStates.delete(state);
    }
    return res.json({ ok: true, account: publicCustomerAccount(account) });
  } catch (error) {
    console.error("Discord unlink error:", error.message);
    return res.status(500).json({ error: "Unable to unlink Discord. Please try again." });
  }
});

// Admin links are verified against the actual member of the configured server.
async function discordServerMember(username, userId) {
  const { token, channelId } = await resolvedDiscordSuccessConfig();
  if (!token || !/^\d{17,22}$/.test(String(channelId))) throw new Error("Configure the Discord bot and success channel first.");
  async function discordGet(route) {
    const response = await fetch(`https://discord.com/api/v10${route}`, {
      headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(response.status === 403 ? "Discord denied the lookup. Check the bot permissions or provide a numeric User ID." : `Discord lookup failed (HTTP ${response.status}).`);
    return response.json();
  }
  const channel = await discordGet(`/channels/${channelId}`);
  if (!/^\d{17,22}$/.test(String(channel.guild_id || ""))) throw new Error("The success channel has no Discord server.");
  const guild = channel.guild_id;
  let member;
  if (userId) {
    if (!/^\d{17,22}$/.test(userId)) throw new Error("Enter a valid numeric Discord User ID.");
    member = await discordGet(`/guilds/${guild}/members/${userId}`);
  } else {
    if (!username || username.length < 2) throw new Error("Enter a Discord username or User ID.");
    const matches = await discordGet(`/guilds/${guild}/members/search?query=${encodeURIComponent(username)}&limit=100`);
    const exact = matches.filter(item => [item.user?.username, item.user?.global_name, item.nick]
      .some(value => value?.toLowerCase() === username.toLowerCase()));
    if (exact.length !== 1) throw new Error("Could not uniquely verify that username in your server. Enter the member's numeric Discord User ID.");
    member = exact[0];
  }
  if (!/^\d{17,22}$/.test(String(member.user?.id || ""))) throw new Error("This Discord member could not be verified.");
  // The numeric ID identifies the member; display names and usernames can change.
  return member.user;
}

app.get("/api/admin/customers/:id/discord", requireAdmin, async (req, res) => {
  const account = (await getCustomerAccounts()).find(item => item.id === req.params.id);
  if (!account) return res.status(404).json({ error: "Customer account not found." });
  res.setHeader("Cache-Control", "no-store");
  res.json({ username: account.discordUsername || "", userId: account.discordUserId || "", linked: Boolean(account.discordLinkedAt && account.discordUserId) });
});

app.put("/api/admin/customers/:id/discord", requireAdmin, async (req, res) => {
  try {
    const accounts = await getCustomerAccounts();
    const account = accounts.find(item => item.id === req.params.id);
    if (!account) return res.status(404).json({ error: "Customer account not found." });
    const username = String(req.body.username || "").trim().replace(/^@/, "");
    const userId = String(req.body.userId || "").trim().replace(/^<@!?(\d{17,22})>$/, "$1");
    if (username.length > 100) return res.status(400).json({ error: "Username is too long." });
    const identity = await discordServerMember(username, userId);
    if (accounts.some(item => item.id !== account.id && item.discordLinkedAt && item.discordUserId === identity.id)) {
      return res.status(409).json({ error: "That Discord member is already linked to another customer." });
    }
    const previousId = account.discordUserId;
    account.discordUserId = identity.id;
    account.discordUsername = identity.username;
    account.discordLinkedAt = new Date().toISOString();
    account.discordLinkVersion = Number(account.discordLinkVersion || 0) + 1;
    account.updatedAt = account.discordLinkedAt;
    await saveCustomerAccounts(accounts);
    await revokeDiscordLinkCodes(DATA_DIR, account.id);
    if (previousId && previousId !== identity.id) await queueDiscordRoleRemoval(DATA_DIR, previousId);
    res.json({ username: identity.username, userId: identity.id, linked: true });
  } catch (error) {
    console.error("Admin Discord link:", error.message);
    res.status(/not found|username|User ID|member|denied|Configure/.test(error.message) ? 400 : 502).json({ error: error.message });
  }
});

app.delete("/api/admin/customers/:id/discord", requireAdmin, async (req, res) => {
  try {
    const accounts = await getCustomerAccounts();
    const account = accounts.find(item => item.id === req.params.id);
    if (!account) return res.status(404).json({ error: "Customer account not found." });
    const previousId = account.discordUserId;
    account.discordLinkVersion = Number(account.discordLinkVersion || 0) + 1;
    delete account.discordUserId;
    delete account.discordLinkedAt;
    account.discordUsername = "";
    account.updatedAt = new Date().toISOString();
    await saveCustomerAccounts(accounts);
    await revokeDiscordLinkCodes(DATA_DIR, account.id);
    if (previousId) await queueDiscordRoleRemoval(DATA_DIR, previousId);
    res.json({ username: "", userId: "", linked: false });
  } catch (error) { console.error("Admin Discord unlink:", error.message); res.status(500).json({ error: "Unable to unlink Discord." }); }
});


app.get(
  "/api/account/notifications",
  requireCustomer,
  async (req, res) => {
    try {
      const sync =
        await syncCustomerMissingNotification(
          req.customerAccount.id
        );

      const notifications =
        Array.isArray(
          sync.account?.notifications
        )
          ? sync.account.notifications
          : [];

      return res.json({
        ok: true,
        notifications,
        checklist: sync.checklist
      });

    } catch (error) {
      console.error(
        "Customer notifications load error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to load notifications."
        });
    }
  }
);


app.delete(
  "/api/account/notifications",
  requireCustomer,
  async (req, res) => {
    try {
      const accounts =
        await getCustomerAccounts();

      const account =
        accounts.find(
          item =>
            String(item.id) ===
            String(
              req.customerAccount.id
            )
        );

      if (!account) {
        return res
          .status(404)
          .json({
            error:
              "Customer account could not be found."
          });
      }

      const notifications =
        customerNotifications(
          account
        );

      for (
        const notification of
        notifications
      ) {
        if (
          notification.discordMessageId
        ) {
          await deleteActionNeededDiscordMessage(
            notification.discordMessageId
          );
        }
      }

      account.notifications = [];
      account.updatedAt =
        new Date()
          .toISOString();

      await saveCustomerAccounts(
        accounts
      );

      return res.json({
        ok: true
      });

    } catch (error) {
      console.error(
        "Customer notifications clear error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to clear notifications."
        });
    }
  }
);


/* -------------------------------------------------------
   CUSTOMER EMAIL VERIFICATION
------------------------------------------------------- */

app.post(
  "/api/account/resend-verification",
  customerAuthRateLimit,
  requireCustomer,
  async (req, res) => {
    try {
      if (
        req.customerAccount
          .emailVerifiedAt
      ) {
        return res.json({
          ok: true,
          alreadyVerified: true,
          message:
            "Your email address is already verified."
        });
      }

      await createEmailVerification(
        req.customerAccount
      );

      return res.json({
        ok: true,
        message:
          "A new verification email has been sent."
      });

    } catch (error) {
      console.error(
        "Resend verification error:",
        error.message
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to send the verification email."
        });
    }
  }
);

app.post(
  "/api/account/verify-email",
  requireCustomer,
  async (req, res) => {
    try {
      const rawToken =
        String(
          req.body.token || ""
        ).trim();

      if (!rawToken) {
        return res
          .status(400)
          .json({
            error:
              "Verification link is invalid."
          });
      }

      const tokenHash =
        hashSecureToken(
          rawToken
        );

      const records =
        await readJson(
          EMAIL_VERIFY_FILE,
          []
        );

      const now =
        Date.now();

      const verification =
        (
          Array.isArray(records)
            ? records
            : []
        ).find(
          item =>
            item.accountId ===
              req.customerAccount.id &&
            Number(
              item.expiresAt
            ) > now &&
            safeEqual(
              item.tokenHash || "",
              tokenHash
            )
        );

      if (!verification) {
        return res
          .status(400)
          .json({
            error:
              "This verification link is invalid or has expired."
          });
      }

      const accounts =
        await getCustomerAccounts();

      const account =
        accounts.find(
          item =>
            item.id ===
            req.customerAccount.id
        );

      if (!account) {
        return res
          .status(404)
          .json({
            error:
              "Customer account could not be found."
          });
      }

      const verifiedAt =
        new Date()
          .toISOString();

      account.emailVerifiedAt =
        verifiedAt;

      account.updatedAt =
        verifiedAt;

     await saveCustomerAccounts(
  accounts
);

const autoLinkResult =
  await autoLinkVerifiedCustomerOrders(
    account
  );

try {
  if (!account.signupOrderConfirmationAt && await sendSignupOrderConfirmation(account)) {
    account.signupOrderConfirmationAt = new Date().toISOString();
    await saveCustomerAccounts(accounts);
  }
} catch (error) {
  console.error("Signup order confirmation email:", error.message);
}

await awardVerifiedReferral(account);

const remaining =
        (
          Array.isArray(records)
            ? records
            : []
        ).filter(
          item =>
            item.accountId !==
              account.id &&
            Number(
              item.expiresAt
            ) > now
        );

      await writeJson(
        EMAIL_VERIFY_FILE,
        remaining
      );

      return res.json({
  ok: true,

  message:
    autoLinkResult.linked > 0
      ? `Your email address has been verified and ${autoLinkResult.linked} existing order${autoLinkResult.linked === 1 ? "" : "s"} ${autoLinkResult.linked === 1 ? "has" : "have"} been connected to your account.`
      : "Your email address has been verified.",

  linkedOrders:
    autoLinkResult.linked,

  account:
    publicCustomerAccount(
      account
    )
});

    } catch (error) {
      console.error(
        "Email verification error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to verify your email address."
        });
    }
  }
);

/* -------------------------------------------------------
   CUSTOMER PASSWORD RESET
------------------------------------------------------- */

app.post(
  "/api/account/request-password-reset",
  customerAuthRateLimit,
  async (req, res) => {
    const genericResponse = {
      ok: true,
      message:
        "If an account exists for that email address, a password reset link will be sent."
    };

    try {
      const email =
        normalizeEmail(
          req.body.email
        );

      if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
          email
        )
      ) {
        return res.json(
          genericResponse
        );
      }

      const accounts =
        await getCustomerAccounts();

      const account =
        accounts.find(
          item =>
            normalizeEmail(
              item.email
            ) === email &&
            item.disabled !== true
        );

      if (!account) {
        return res.json(
          genericResponse
        );
      }

      const rawToken =
        createSecureToken();

      const records =
        await readJson(
          PASSWORD_RESET_FILE,
          []
        );

      const now =
        Date.now();

      const activeRecords =
        (
          Array.isArray(records)
            ? records
            : []
        ).filter(
          item =>
            Number(
              item.expiresAt
            ) > now &&
            item.accountId !==
              account.id
        );

      activeRecords.push({
        id:
          crypto.randomUUID(),

        accountId:
          account.id,

        tokenHash:
          hashSecureToken(
            rawToken
          ),

        createdAt:
          new Date(now)
            .toISOString(),

        expiresAt:
          now +
          15 * 60 * 1000
      });

      await writeJson(
        PASSWORD_RESET_FILE,
        activeRecords
      );

      try {
        await sendPasswordResetEmail(
          account.email,
          rawToken
        );
      } catch (error) {
        console.error(
          "Password reset email send failed:",
          error.message
        );
      }

      return res.json(
        genericResponse
      );

    } catch (error) {
      console.error(
        "Password reset request error:",
        error
      );

      return res.json(
        genericResponse
      );
    }
  }
);

// Signed-in customers may receive a clear delivery error without exposing
// whether another person's email has an account.
app.post("/api/account/send-password-reset", requireCustomer, async (req, res) => {
  try {
    const rawToken = createSecureToken();
    const records = await readJson(PASSWORD_RESET_FILE, []);
    const now = Date.now();
    const active = (Array.isArray(records) ? records : []).filter(item =>
      Number(item.expiresAt) > now && item.accountId !== req.customerAccount.id
    );
    active.push({
      id: crypto.randomUUID(),
      accountId: req.customerAccount.id,
      tokenHash: hashSecureToken(rawToken),
      createdAt: new Date(now).toISOString(),
      expiresAt: now + 15 * 60 * 1000
    });
    await writeJson(PASSWORD_RESET_FILE, active);
    await sendPasswordResetEmail(req.customerAccount.email, rawToken);
    return res.json({ ok: true, message: "Password reset email sent to your account email." });
  } catch (error) {
    console.error("Signed-in password reset email failed:", error.message);
    return res.status(502).json({ error: "The password reset email could not be sent. Please try again or change your password below." });
  }
});

app.post("/api/account/change-password", requireCustomer, customerAuthRateLimit, async (req, res) => {
  try {
    const currentPassword = String(req.body?.currentPassword || "");
    const newPassword = String(req.body?.newPassword || "");
    if (newPassword.length < 12 || newPassword.length > 200) {
      return res.status(400).json({ error: "Your new password must be at least 12 characters." });
    }
    const accounts = await getCustomerAccounts();
    const account = accounts.find(item => item.id === req.customerAccount.id && item.disabled !== true);
    if (!account || !await verifyCustomerPassword(currentPassword, account)) {
      return res.status(400).json({ error: "Your current password is incorrect." });
    }
    const passwordData = await hashCustomerPassword(newPassword);
    account.passwordSalt = passwordData.salt;
    account.passwordHash = passwordData.hash;
    account.sessionVersion = customerSessionVersion(account) + 1;
    account.mustChangePassword = false;
    account.temporaryPasswordExpiresAt = null;
    account.updatedAt = new Date().toISOString();
    await saveCustomerAccounts(accounts);
    setCustomerSession(res, account);
    return res.json({ ok: true, message: "Your password has been changed. Other sessions have been signed out." });
  } catch (error) {
    console.error("Customer password change failed:", error.message);
    return res.status(500).json({ error: "Your password could not be changed. Please try again." });
  }
});

app.post("/api/admin/customers/:id/reset-password", requireAdmin, async (req, res) => {
  try {
    const customerAccountId = clean(req.params.id, 150);
    const accounts = await getCustomerAccounts();
    const account = accounts.find(item => String(item.id) === customerAccountId && item.disabled !== true);
    if (!account) return res.status(404).json({ error: "Linked website account was not found." });
    const passwordData = await hashCustomerPassword("password123");
    const resets = await readJson(PASSWORD_RESET_FILE, []);
    await writeJson(PASSWORD_RESET_FILE, (Array.isArray(resets) ? resets : [])
      .filter(item => item.accountId !== account.id && Number(item.expiresAt) > Date.now()));
    account.passwordSalt = passwordData.salt;
    account.passwordHash = passwordData.hash;
    account.sessionVersion = customerSessionVersion(account) + 1;
    account.mustChangePassword = true;
    account.temporaryPasswordExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    account.updatedAt = new Date().toISOString();
    await saveCustomerAccounts(accounts);
    try {
      await appendSecurityAudit({
        event: "admin_customer_password_reset", requestId: req.securityRequestId,
        method: req.method, path: req.path, status: 200, ip: req.ip,
        userAgent: req.headers["user-agent"], subject: account.id
      });
    } catch (auditError) {
      console.error("Admin password reset audit failed:", auditError.message);
    }
    return res.json({ ok: true, message: "Temporary website password set to password123 for one hour. Existing sessions were signed out; the customer must choose a new password after signing in." });
  } catch (error) {
    console.error("Admin customer password reset failed:", error.message);
    return res.status(500).json({ error: "Unable to update the customer's website password." });
  }
});

app.post(
  "/api/account/reset-password",
  async (req, res) => {
    try {
      const rawToken =
        String(
          req.body.token || ""
        ).trim();

      const newPassword =
        String(
          req.body.password || ""
        );

      if (!rawToken) {
        return res
          .status(400)
          .json({
            error:
              "This password reset link is invalid or has expired."
          });
      }

      if (
        newPassword.length < 12 ||
        newPassword.length > 200
      ) {
        return res
          .status(400)
          .json({
            error:
              "Password must be at least 12 characters."
          });
      }

      const tokenHash =
        hashSecureToken(
          rawToken
        );

      const records =
        await readJson(
          PASSWORD_RESET_FILE,
          []
        );

      const now =
        Date.now();

      const resetRecord =
        (
          Array.isArray(records)
            ? records
            : []
        ).find(
          item =>
            Number(
              item.expiresAt
            ) > now &&
            safeEqual(
              item.tokenHash || "",
              tokenHash
            )
        );

      if (!resetRecord) {
        return res
          .status(400)
          .json({
            error:
              "This password reset link is invalid or has expired."
          });
      }

      const accounts =
        await getCustomerAccounts();

      const account =
        accounts.find(
          item =>
            item.id ===
              resetRecord.accountId &&
            item.disabled !== true
        );

      if (!account) {
        return res
          .status(400)
          .json({
            error:
              "This password reset link is invalid or has expired."
          });
      }

      const passwordData =
        await hashCustomerPassword(
          newPassword
        );

      const updatedAt =
        new Date()
          .toISOString();

      account.passwordSalt =
        passwordData.salt;

      account.passwordHash =
        passwordData.hash;

      /*
        Revoke every previously issued customer session after a
        password reset. A stolen old cookie can no longer be reused.
      */
      account.sessionVersion =
        customerSessionVersion(
          account
        ) + 1;

      account.mustChangePassword = false;
      account.temporaryPasswordExpiresAt = null;

      account.updatedAt =
        updatedAt;

      await saveCustomerAccounts(
        accounts
      );

      const remaining =
        (
          Array.isArray(records)
            ? records
            : []
        ).filter(
          item =>
            item.accountId !==
              account.id &&
            Number(
              item.expiresAt
            ) > now
        );

      await writeJson(
        PASSWORD_RESET_FILE,
        remaining
      );

      setCustomerSession(
        res,
        account
      );

      return res.json({
        ok: true,
        message:
          "Your password has been reset successfully."
      });

    } catch (error) {
      console.error(
        "Password reset error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to reset your password."
        });
    }
  }
);

/* -------------------------------------------------------
   EXISTING ORDER CLAIM
------------------------------------------------------- */

function normalizePhone(value) {
  return String(value || "")
    .replace(/\D/g, "")
    .slice(-10);
}

function customerOrderNumber(
  record
) {
  return String(
    record?.orderNumber ||
    record?.id ||
    ""
  ).trim();
}

function newCustomerOrderNumber() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `SNG-${date}-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
}

async function sendPaidOrderConfirmation(accountId, order, amount, details = "") {
  if (!process.env.RESEND_API_KEY) throw new Error("Email service is not configured.");
  const account = (await getCustomerAccounts()).find(item => String(item.id) === String(accountId));
  if (!account?.email) throw new Error("Customer sign-in email is unavailable.");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL || "SLABSNGRABSACO <onboarding@resend.dev>",
      to: [account.email],
      subject: `Your SLABSNGRABSACO order confirmation — ${customerOrderNumber(order)}`,
      text: `Your order is confirmed.\n\nOrder number: ${customerOrderNumber(order)}\nOrder ID: ${order.id}\nItem: ${order.plan?.name || "Membership"}\n${details ? `${details}\n` : ""}Price paid: $${(Number(amount) || 0).toFixed(2)} USD\nPaid: ${order.paidAt || new Date().toISOString()}\nStatus: Paid\n\nThis order is linked to your website account. Sign in at ${BASE_URL}/#my-profile to view it. If you need to claim an order, enter either the order number or order ID and verify the purchase email in My Profile. For help with an order, open a private support ticket in Discord. Never post your order details in #ask-ai.\n\nNo passwords, card numbers, or verification codes are included.`
    })
  });
  if (!response.ok) throw new Error(`Order confirmation email HTTP ${response.status}`);
}

async function sendOrderClaimEmail(
  email,
  token,
  orderNumber
) {
  if (
    !process.env.RESEND_API_KEY
  ) {
    throw new Error(
      "Email service is not configured."
    );
  }

  const verifyUrl =
    `${BASE_URL}/?claim=${encodeURIComponent(
      token
    )}#my-profile`;

  const response =
    await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${process.env.RESEND_API_KEY}`,

          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          from:
            process.env.FROM_EMAIL ||
            "SLABSNGRABSACO <onboarding@resend.dev>",

          to: [email],

          subject:
            "Verify your SLABS N GRABS ACO order",

          text:
`A request was made to connect an existing SLABS N GRABS ACO order to a customer account.

Order: ${orderNumber}

To verify ownership and connect the order, open this secure link:

${verifyUrl}

This link expires in 15 minutes.

If you did not request this, you can ignore this email.`
        })
      }
    );

  if (!response.ok) {
    throw new Error(
      "Verification email could not be sent."
    );
  }
}

app.post(
  "/api/account/claim-order",
  customerAuthRateLimit,
  requireCustomer,
  async (req, res) => {
    try {
      const orderNumber =
        clean(
          req.body.orderNumber,
          150
        );

      const suppliedEmail =
        normalizeEmail(
          req.body.email
        );

      const suppliedPhone =
        normalizePhone(
          req.body.phone
        );

      if (
        !orderNumber ||
        (
          !suppliedEmail &&
          !suppliedPhone
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Enter the order number and the email or phone number used for the purchase."
          });
      }

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const record =
        paid.find(item =>
          [customerOrderNumber(item), String(item.id || "")]
            .some(value => value.toLowerCase() === orderNumber.toLowerCase())
        );

      const genericResponse = {
        ok: true,
        message:
          "If the order information matches our records, a verification email will be sent to the email address used for that purchase."
      };

      if (!record) {
        return res.json(
          genericResponse
        );
      }

      if (
        record.customerAccountId &&
        record.customerAccountId !==
          req.customerAccount.id
      ) {
        return res.json(
          genericResponse
        );
      }

      if (
        record.customerAccountId ===
        req.customerAccount.id
      ) {
        return res.json({
          ok: true,
          alreadyLinked: true,
          message:
            "This order is already connected to your account."
        });
      }

      const orderEmail =
        normalizeEmail(
          record.profile?.email
        );

      const orderPhone =
        normalizePhone(
          record.profile?.phone
        );

      const emailMatches =
        suppliedEmail &&
        orderEmail &&
        suppliedEmail ===
          orderEmail;

      const phoneMatches =
        suppliedPhone &&
        orderPhone &&
        suppliedPhone ===
          orderPhone;

      if (
        !emailMatches &&
        !phoneMatches
      ) {
        return res.json(
          genericResponse
        );
      }

      if (!orderEmail) {
        return res.json(
          genericResponse
        );
      }

      const rawToken =
        createSecureToken();

      const claimRecords =
        await readJson(
          ORDER_CLAIM_FILE,
          []
        );

      const now =
        Date.now();

      const filteredClaims =
        Array.isArray(
          claimRecords
        )
          ? claimRecords.filter(
              claim =>
                Number(
                  claim.expiresAt
                ) > now
            )
          : [];

      const activeClaims =
        filteredClaims.filter(
          claim =>
            !(
              claim.accountId ===
                req.customerAccount.id &&
              claim.orderId ===
                record.id
            )
        );

      activeClaims.push({
        id:
          crypto.randomUUID(),

        tokenHash:
          hashSecureToken(
            rawToken
          ),

        accountId:
          req.customerAccount.id,

        orderId:
          record.id,

        createdAt:
          new Date(
            now
          ).toISOString(),

        expiresAt:
          now +
          15 * 60 * 1000
      });

      await writeJson(
        ORDER_CLAIM_FILE,
        activeClaims
      );

      await sendOrderClaimEmail(
        orderEmail,
        rawToken,
        customerOrderNumber(
          record
        )
      );

      return res.json(
        genericResponse
      );

    } catch (error) {
      console.error(
        "Order claim request error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to start order verification."
        });
    }
  }
);

app.post(
  "/api/account/verify-order-claim",
  requireCustomer,
  async (req, res) => {
    try {
      const rawToken =
        String(
          req.body.token || ""
        ).trim();

      if (!rawToken) {
        return res
          .status(400)
          .json({
            error:
              "Verification link is invalid."
          });
      }

      const tokenHash =
        hashSecureToken(
          rawToken
        );

      const claims =
        await readJson(
          ORDER_CLAIM_FILE,
          []
        );

      const now =
        Date.now();

      const claim =
        (
          Array.isArray(claims)
            ? claims
            : []
        ).find(
          item =>
            safeEqual(
              item.tokenHash || "",
              tokenHash
            ) &&
            item.accountId ===
              req.customerAccount.id &&
            Number(
              item.expiresAt
            ) > now
        );

      if (!claim) {
        return res
          .status(400)
          .json({
            error:
              "This verification link is invalid or has expired."
          });
      }

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const record =
        paid.find(
          item =>
            item.id ===
            claim.orderId
        );

      if (
        !record ||
        (
          record.customerAccountId &&
          record.customerAccountId !==
            req.customerAccount.id
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "This order can no longer be connected."
          });
      }

      const linkedAt =
        new Date().toISOString();

      record.customerAccountId =
        req.customerAccount.id;

      record.customerLinkedAt =
        linkedAt;

      await writeJson(
        PAID_FILE,
        paid
      );

      const remainingClaims =
        (
          Array.isArray(claims)
            ? claims
            : []
        ).filter(
          item =>
            item.orderId !==
              record.id &&
            Number(
              item.expiresAt
            ) > now
        );

      await writeJson(
        ORDER_CLAIM_FILE,
        remainingClaims
      );

      return res.json({
        ok: true,
        message:
          "Your order has been connected to your account."
      });

    } catch (error) {
      console.error(
        "Order claim verification error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to connect this order."
        });
    }
  }
);

/* -------------------------------------------------------
   RETAILER PROFILE HELPERS
------------------------------------------------------- */

const RETAILER_KEYS = [
  "target",
  "walmart",
  "pokemoncenter",
  "pkc",
  "samsClub",
  "costco"
];

function emptyRetailerCredentials() {
  return {
    target: {
      username: "",
      password: ""
    },

    walmart: {
      username: "",
      password: ""
    },

    pokemoncenter: {
      username: "",
      password: ""
    },

    pkc: {
      username: "",
      password: ""
    },

    samsClub: {
      username: "",
      password: ""
    },

    costco: {
      username: "",
      password: ""
    }
  };
}

function normalizeRetailerCredentials(
  value
) {
  const normalized =
    emptyRetailerCredentials();

  const source =
    value &&
    typeof value === "object"
      ? value
      : {};

  for (
    const retailer of
    RETAILER_KEYS
  ) {
    const item =
      source[retailer] &&
      typeof source[retailer] ===
        "object"
        ? source[retailer]
        : {};

    normalized[retailer] = {
      username:
        clean(
          item.username,
          254
        ),

      password:
        String(
          item.password || ""
        ).slice(0, 512)
    };
  }

  normalized.pkc = {
    ...(
      normalized.pkc ||
      {}
    ),
    password: ""
  };

  return normalized;
}

// One retailer login cannot be offered to two different managed profiles.
// Compare complete username/password pairs; empty credentials do not identify an account.
function managedCredentialPairs(credentials) {
  const pairs = [];
  const normalized = normalizeRetailerCredentials(credentials);
  for (const retailer of RETAILER_KEYS) {
    const username = String(normalized[retailer]?.username || "").trim().toLowerCase();
    const password = String(normalized[retailer]?.password || "");
    if (username && password) pairs.push({ retailer, key: JSON.stringify([retailer, username, password]) });
  }
  return pairs;
}

function managedCredentialConflict(accounts, credentials, excludeId = "") {
  const proposed = new Map(managedCredentialPairs(credentials).map(pair => [pair.key, pair.retailer]));
  for (const account of accounts || []) {
    if (String(account.id) === String(excludeId) || !account.credentials) continue;
    let existing;
    try { existing = decryptJson(account.credentials); } catch { continue; }
    for (const pair of managedCredentialPairs(existing)) {
      if (proposed.has(pair.key)) return { retailer: pair.retailer };
    }
  }
  return null;
}

function managedDuplicateCredentialState(accounts, inUseIds = new Set()) {
  const groups = new Map();
  const duplicateIds = new Set();
  const duplicateOf = new Map();
  for (const account of accounts || []) {
    if (!account.credentials) continue;
    let credentials;
    try { credentials = decryptJson(account.credentials); } catch { continue; }
    for (const pair of managedCredentialPairs(credentials)) {
      const ids = groups.get(pair.key) || [];
      ids.push(String(account.id));
      groups.set(pair.key, ids);
    }
  }
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const assigned = ids.filter(id => inUseIds.has(id));
    const keeper = assigned.length === 1 ? assigned[0] : assigned.length ? null : ids[0];
    for (const id of ids) if (id !== keeper) {
      duplicateIds.add(id);
      if (keeper) duplicateOf.set(id, keeper);
    }
  }
  return { duplicateIds, duplicateOf };
}

/* -------------------------------------------------------
   SPECIAL PROFILE HELPERS
------------------------------------------------------- */

const SPECIAL_PROFILE_TYPES = [
  "free",
  "rented"
];

const SPECIAL_PROFILE_DURATIONS = [
  "indefinite",
  "1_drop",
  "1_week",
  "1_month"
];


function normalizeSpecialProfileType(
  value
) {
  const type =
    String(
      value || ""
    )
      .trim()
      .toLowerCase();

  return SPECIAL_PROFILE_TYPES.includes(
    type
  )
    ? type
    : null;
}


function normalizeSpecialProfileDuration(
  value
) {
  const duration =
    String(
      value || ""
    )
      .trim()
      .toLowerCase();

  return SPECIAL_PROFILE_DURATIONS.includes(
    duration
  )
    ? duration
    : null;
}


function specialProfileExpiresAt(
  durationType,
  startValue = new Date()
) {
  const duration =
    normalizeSpecialProfileDuration(
      durationType
    );

  if (
    !duration ||
    duration === "indefinite"
  ) {
    return null;
  }

  const start =
    startValue instanceof Date
      ? new Date(
          startValue.getTime()
        )
      : new Date(
          startValue
        );

  if (
    Number.isNaN(
      start.getTime()
    )
  ) {
    return null;
  }

  if (
    duration === "1_drop"
  ) {
    start.setDate(
      start.getDate() + 1
    );

    return start.toISOString();
  }

  if (
    duration === "1_week"
  ) {
    start.setDate(
      start.getDate() + 7
    );

    return start.toISOString();
  }

if (
  duration === "1_month"
) {
  const originalDay =
    start.getDate();

  start.setDate(1);

  start.setMonth(
    start.getMonth() + 1
  );

  const lastDayOfTargetMonth =
    new Date(
      start.getFullYear(),
      start.getMonth() + 1,
      0
    ).getDate();

  start.setDate(
    Math.min(
      originalDay,
      lastDayOfTargetMonth
    )
  );

  return start.toISOString();
}

  return null;
}


function specialProfileIsActive(
  record
) {
  if (
    record?.active !== true
  ) {
    return false;
  }

  const duration =
    normalizeSpecialProfileDuration(
      record?.durationType
    );

  if (
    duration === "indefinite"
  ) {
    return true;
  }

  if (!record?.expiresAt) {
    return false;
  }

  const expiration =
    new Date(
      record.expiresAt
    );

  if (
    Number.isNaN(
      expiration.getTime()
    )
  ) {
    return false;
  }

  return (
    expiration.getTime() >
    Date.now()
  );
}


function specialProfileDaysRemaining(
  record
) {
  if (
    !specialProfileIsActive(
      record
    )
  ) {
    return 0;
  }

  if (
    normalizeSpecialProfileDuration(
      record?.durationType
    ) === "indefinite"
  ) {
    return null;
  }

  const expiration =
    new Date(
      record.expiresAt
    );

  return Math.max(
    0,
    Math.ceil(
      (
        expiration.getTime() -
        Date.now()
      ) /
      (
        1000 *
        60 *
        60 *
        24
      )
    )
  );
}


async function getSpecialProfiles() {
  const records =
    await readJson(
      SPECIAL_PROFILES_FILE,
      []
    );

  return Array.isArray(records)
    ? records
    : [];
}


async function saveSpecialProfiles(
  records
) {
  await writeJson(
    SPECIAL_PROFILES_FILE,
    records
  );
}

async function getRentedMemberships() {
  const records =
    await readJson(
      RENTED_MEMBERSHIPS_FILE,
      []
    );

  return Array.isArray(records)
    ? records
    : [];
}


async function saveRentedMemberships(
  records
) {
  await writeJson(
    RENTED_MEMBERSHIPS_FILE,
    records
  );
}



const MANAGED_RESTORE_HOLD_DAYS =
  7;

const MANAGED_RESTORE_HOLD_MS =
  MANAGED_RESTORE_HOLD_DAYS *
  24 *
  60 *
  60 *
  1000;

let restoreHoldMutationQueue =
  Promise.resolve();


async function mutateRestoreHolds(
  mutator
) {
  const run =
    restoreHoldMutationQueue
      .catch(
        () => {}
      )
      .then(
        async () => {
          const holds =
            normalizeRestoreHoldRecords(
              await readJson(
                RESTORE_HOLDS_FILE,
                []
              )
            );

          const result =
            await mutator(
              holds
            );

          await saveRestoreHolds(
            holds
          );

          return result;
        }
      );

  restoreHoldMutationQueue =
    run.catch(
      () => {}
    );

  return run;
}


function managedAssignmentExpirationIsDue(
  assignment,
  now = Date.now()
) {
  if (
    !assignment ||
    !assignment.expiresAt
  ) {
    return false;
  }

  const expires =
    new Date(
      assignment.expiresAt
    ).getTime();

  return (
    Number.isFinite(
      expires
    ) &&
    expires <= now
  );
}


async function saveRestoreHolds(
  records
) {
  await writeJson(
    RESTORE_HOLDS_FILE,
    records
  );
}


function restoreHoldRemainingItems(
  hold
) {
  return (
    Array.isArray(
      hold?.items
    )
      ? hold.items
      : []
  ).filter(
    item =>
      item &&
      !item.restoredAt &&
      !item.releasedAt
  );
}


function restoreHoldIsActive(
  hold,
  now = Date.now()
) {
  if (
    !hold ||
    ![
      "held",
      "partial"
    ].includes(
      String(
        hold.status ||
        ""
      )
    )
  ) {
    return false;
  }

  if (
    !restoreHoldRemainingItems(
      hold
    ).length
  ) {
    return false;
  }

  const until =
    new Date(
      hold.holdUntil ||
      0
    ).getTime();

  return (
    Number.isFinite(
      until
    ) &&
    until > now
  );
}


function normalizeRestoreHoldRecords(
  records
) {
  return (
    Array.isArray(records)
      ? records
      : []
  ).filter(
    record =>
      record &&
      record.id
  );
}


async function getRestoreHolds() {
  return normalizeRestoreHoldRecords(
    await readJson(
      RESTORE_HOLDS_FILE,
      []
    )
  );
}


function activeRestoreHoldsFor(
  holds,
  {
    customerAccountId = "",
    type = ""
  } = {}
) {
  const now =
    Date.now();

  return (
    Array.isArray(holds)
      ? holds
      : []
  ).filter(
    hold =>
      restoreHoldIsActive(
        hold,
        now
      ) &&
      (
        !customerAccountId ||
        String(
          hold.customerAccountId ||
          ""
        ) ===
          String(
            customerAccountId
          )
      ) &&
      (
        !type ||
        String(
          hold.type ||
          ""
        ) ===
          String(type)
      )
  );
}


function heldManagedAccountIdsFromHolds(
  holds
) {
  const ids =
    new Set();

  for (
    const hold of
    activeRestoreHoldsFor(
      holds
    )
  ) {
    for (
      const item of
      restoreHoldRemainingItems(
        hold
      )
    ) {
      if (
        item.managedAccountId
      ) {
        ids.add(
          String(
            item.managedAccountId
          )
        );
      }
    }
  }

  return ids;
}


function clearManagedAssignmentCustomerData(
  assignment,
  {
    reason = "expired",
    nowIso =
      new Date().toISOString()
  } = {}
) {
  if (!assignment) {
    return false;
  }

  /*
    The managed retailer account/login belongs to the managed pool
    and is stored separately. Only customer-specific attached data
    is cleared here.
  */

  assignment.active =
    false;

  assignment.activationStatus =
    reason ===
      "returned_to_pool"
      ? "returned_to_pool"
      : "expired";

  assignment.endReason =
    reason;

  assignment.endedAt =
    assignment.endedAt ||
    nowIso;

  if (
    reason ===
    "expired"
  ) {
    assignment.expiredAt =
      assignment.expiredAt ||
      nowIso;
  }

  if (
    reason ===
    "returned_to_pool"
  ) {
    assignment.returnedToPoolAt =
      assignment.returnedToPoolAt ||
      nowIso;
  }

  assignment.updatedAt =
    nowIso;

  /*
    Remove everything belonging to the former customer before
    this managed account can become available to another customer.
    Restore Holds are stored separately and keep only the internal
    customer ID plus the managed account IDs needed for restoration.
  */
  assignment.customerAccountId =
    null;

  delete assignment.customerProfile;
  delete assignment.customerSecrets;
  delete assignment.customerUpdatedAt;

  delete assignment.selectedAddressId;
  delete assignment.selectedPaymentId;
  delete assignment.savedAddressId;
  delete assignment.savedPaymentMethodId;

  delete assignment.jigSourceKey;
  delete assignment.jigSourceAddress;
  delete assignment.jiggedAddress;
  delete assignment.jigVariantIndex;
  delete assignment.jigHistoryKeys;

  delete assignment.paidSubmissionId;

  delete assignment.activationRequestedAt;
  delete assignment.startsAt;
  delete assignment.activatedAt;
  delete assignment.deactivatedAt;

  if (assignment.discordProfileMessageId) {
    assignment.pendingDiscordProfileMessageId = assignment.discordProfileMessageId;
  }
  delete assignment.discordProfileMessageId;
  delete assignment.discordProfileMessageType;
  delete assignment.discordProfileMessageUpdatedAt;

  return true;
}


async function sendRestoreHoldExpirationDiscord(
  hold,
  managedAccounts
) {
  if (
    !hold ||
    hold.expirationDiscordSentAt
  ) {
    return false;
  }

  try {
    const customer =
      await customerLabelForProfileWorkflow(
        hold.customerAccountId,
        {}
      );

    const items =
      restoreHoldRemainingItems(
        hold
      );

    const emails =
      items
        .map(item => {
          const account =
            managedAccounts.find(
              record =>
                String(
                  record.id
                ) ===
                  String(
                    item.managedAccountId
                  )
            );

          return (
            managedAccountCanonicalEmail(
              account
            ) ||
            String(
              item.managedAccountId ||
              ""
            )
          );
        })
        .filter(Boolean);

    const typeLabel =
      hold.type === "free"
        ? "Gifted"
        : "Rented";

    const count =
      items.length;

    const emailList =
      emails.length
        ? emails
            .slice(
              0,
              30
            )
            .join(", ")
        : "Open Admin to review the held managed accounts.";

    if (
      !adminProfileWebhookUrl()
    ) {
      return false;
    }

    const messageId =
      await sendDiscordAdminProfileWorkflowNotification({
        title:
          `🔴 ${count} ${typeLabel.toUpperCase()} ACCOUNT${count === 1 ? "" : "S"} EXPIRED`,

        description:
          `${count} ${typeLabel.toLowerCase()} managed account${count === 1 ? "" : "s"} expired. Mark these profile(s) inactive in your other program. The same managed accounts are reserved for this customer for ${MANAGED_RESTORE_HOLD_DAYS} days unless you release them early. Accounts: ${emailList}`,

        customerName:
          customer.name,

        customerEmail:
          customer.email,

        profileLabel:
          `${count} account${count === 1 ? "" : "s"} on Restore Hold`,

        profileType:
          `${typeLabel} Restore Hold`,

        expiresAt:
          hold.holdUntil ||
          null
      });

    if (!messageId) {
      return false;
    }

    hold.expirationDiscordSentAt =
      new Date()
        .toISOString();

    hold.expirationDiscordMessageId =
      messageId;

    hold.updatedAt =
      new Date()
        .toISOString();

    return true;

  } catch (error) {
    console.error(
      "Restore Hold expiration Discord notification failed:",
      error.message
    );

    return false;
  }
}


async function sendRestoreCompletedDiscord(
  {
    customerAccountId,
    type,
    restoredManagedAccountIds = []
  } = {}
) {
  if (
    !customerAccountId ||
    !restoredManagedAccountIds.length
  ) {
    return;
  }

  try {
    const [
      customer,
      managedAccounts
    ] = await Promise.all([
      customerLabelForProfileWorkflow(
        customerAccountId,
        {}
      ),
      getManagedAccounts()
    ]);

    const emails =
      restoredManagedAccountIds
        .map(id => {
          const account =
            managedAccounts.find(
              record =>
                String(
                  record.id
                ) ===
                  String(id)
            );

          return (
            managedAccountCanonicalEmail(
              account
            ) ||
            String(id)
          );
        })
        .filter(Boolean);

    const typeLabel =
      type === "free"
        ? "Gifted"
        : "Rented";

    await sendDiscordAdminProfileWorkflowNotification({
      title:
        `🟢 ${restoredManagedAccountIds.length} ${typeLabel.toUpperCase()} ACCOUNT${restoredManagedAccountIds.length === 1 ? "" : "S"} RESTORED`,

      description:
        `Previously used ${typeLabel.toLowerCase()} managed account${restoredManagedAccountIds.length === 1 ? "" : "s"} were restored to this customer and returned to Linked Profiles. Accounts: ${emails.slice(0, 30).join(", ")}`,

      customerName:
        customer.name,

      customerEmail:
        customer.email,

      profileLabel:
        `${restoredManagedAccountIds.length} restored account${restoredManagedAccountIds.length === 1 ? "" : "s"}`,

      profileType:
        `${typeLabel} Restore`
    });

  } catch (error) {
    console.error(
      "Restore completed Discord notification failed:",
      error.message
    );
  }
}


async function consumeRestoreHoldItems(
  customerAccountId,
  type,
  managedAccountIds
) {
  const ids =
    new Set(
      (
        Array.isArray(
          managedAccountIds
        )
          ? managedAccountIds
          : []
      ).map(
        id =>
          String(id)
      )
    );

  if (
    !customerAccountId ||
    !ids.size
  ) {
    return 0;
  }

  const restoredIds =
    await mutateRestoreHolds(
      async holds => {
        const nowIso =
          new Date()
            .toISOString();

        const restored = [];

        for (
          const hold of
          activeRestoreHoldsFor(
            holds,
            {
              customerAccountId,
              type
            }
          )
        ) {
          for (
            const item of
            restoreHoldRemainingItems(
              hold
            )
          ) {
            if (
              !ids.has(
                String(
                  item.managedAccountId ||
                  ""
                )
              )
            ) {
              continue;
            }

            item.restoredAt =
              nowIso;

            restored.push(
              String(
                item.managedAccountId
              )
            );
          }

          const remaining =
            restoreHoldRemainingItems(
              hold
            );

          hold.status =
            remaining.length
              ? "partial"
              : "restored";

          if (
            !remaining.length
          ) {
            hold.restoredAt =
              nowIso;
          }

          hold.updatedAt =
            nowIso;
        }

        return restored;
      }
    );

  if (
    restoredIds.length
  ) {
    await sendRestoreCompletedDiscord({
      customerAccountId,
      type,
      restoredManagedAccountIds:
        restoredIds
    });
  }

  return restoredIds.length;
}


async function managedAccountRestoreHoldOwner(
  managedAccountId
) {
  const holds =
    await getRestoreHolds();

  for (
    const hold of
    activeRestoreHoldsFor(
      holds
    )
  ) {
    if (
      restoreHoldRemainingItems(
        hold
      ).some(
        item =>
          String(
            item.managedAccountId ||
            ""
          ) ===
            String(
              managedAccountId ||
              ""
            )
      )
    ) {
      return {
        customerAccountId:
          hold.customerAccountId,

        type:
          hold.type,

        holdId:
          hold.id,

        holdUntil:
          hold.holdUntil
      };
    }
  }

  return null;
}


async function cleanupExpiredManagedAssignments(
  assignments,
  type
) {
  const now =
    Date.now();

  const nowIso =
    new Date(
      now
    ).toISOString();

  const due =
    assignments.filter(
      assignment =>
        assignment &&
        assignment.customerAccountId &&
        assignment.active ===
          true &&
        String(
          assignment.activationStatus ||
          ""
        ) ===
          "activated" &&
        managedAssignmentExpirationIsDue(
          assignment,
          now
        )
    );

  if (!due.length) {
    return false;
  }

  const managedAccounts =
    await getManagedAccounts();

  const grouped =
    new Map();

  for (
    const assignment of
    due
  ) {
    const customerAccountId =
      String(
        assignment.customerAccountId ||
        ""
      );

    if (!customerAccountId) {
      continue;
    }

    if (
      !grouped.has(
        customerAccountId
      )
    ) {
      grouped.set(
        customerAccountId,
        []
      );
    }

    grouped.get(
      customerAccountId
    ).push(
      assignment
    );
  }

  /*
    Serialize Restore Hold mutations so Gifted and Rented expirations
    occurring in the same request cannot overwrite each other's holds.
  */
  await mutateRestoreHolds(
    async holds => {
      for (
        const [
          customerAccountId,
          customerAssignments
        ] of
        grouped
      ) {
        let hold =
          activeRestoreHoldsFor(
            holds,
            {
              customerAccountId,
              type
            }
          )[0] ||
          null;

        if (!hold) {
          hold = {
            id:
              crypto.randomUUID(),

            customerAccountId,

            type,

            status:
              "held",

            holdStartedAt:
              nowIso,

            holdUntil:
              new Date(
                now +
                MANAGED_RESTORE_HOLD_MS
              ).toISOString(),

            items: [],

            createdAt:
              nowIso,

            updatedAt:
              nowIso,

            expirationDiscordSentAt:
              null,

            expirationDiscordMessageId:
              null
          };

          holds.push(
            hold
          );
        }

        const existingIds =
          new Set(
            restoreHoldRemainingItems(
              hold
            ).map(
              item =>
                String(
                  item.managedAccountId ||
                  ""
                )
            )
          );

        let added =
          0;

        for (
          const assignment of
          customerAssignments
        ) {
          const managedAccountId =
            managedAssignmentMembershipId(
              assignment
            );

          if (
            !managedAccountId ||
            existingIds.has(
              managedAccountId
            )
          ) {
            continue;
          }

          const membership =
            managedAccounts.find(
              item =>
                String(
                  item.id
                ) ===
                  String(
                    managedAccountId
                  )
            );

          let retailer =
            String(
              assignment.rentalRetailer ||
              assignment.assignmentRetailer ||
              ""
            ).trim();

          if (
            !retailer &&
            membership
          ) {
            try {
              const credentials =
                membership.credentials
                  ? normalizeRetailerCredentials(
                      decryptJson(
                        membership.credentials
                      )
                    )
                  : emptyRetailerCredentials();

              retailer =
                [
                  "target",
                  "walmart",
                  "pkc",
                  "samsClub",
                  "costco"
                ].find(
                  key =>
                    String(
                      credentials?.[key]
                        ?.username ||
                      ""
                    ).trim()
                ) || "";
            } catch {
              retailer = "";
            }
          }

          hold.items.push({
            managedAccountId,

            previousAssignmentId:
              assignment.id ||
              null,

            durationType:
              assignment.durationType ||
              null,

            retailer:
              retailer ||
              null,

            heldAt:
              nowIso,

            restoredAt:
              null,

            releasedAt:
              null
          });

          existingIds.add(
            managedAccountId
          );

          added += 1;
        }

        if (added) {
          hold.status =
            "held";

          hold.holdUntil =
            new Date(
              now +
              MANAGED_RESTORE_HOLD_MS
            ).toISOString();

          hold.updatedAt =
            nowIso;

          hold.expirationDiscordSentAt =
            null;

          hold.expirationDiscordMessageId =
            null;

          await sendRestoreHoldExpirationDiscord(
            hold,
            managedAccounts
          );
        }
      }
    }
  );

  for (
    const assignment of
    due
  ) {
    clearManagedAssignmentCustomerData(
      assignment,
      {
        reason:
          "expired",
        nowIso
      }
    );
  }

  return true;
}


async function getRentalAssignments() {
  const records =
    await readJson(
      RENTAL_ASSIGNMENTS_FILE,
      []
    );

  const assignments =
    Array.isArray(records)
      ? records
      : [];

  if (
    await cleanupExpiredManagedAssignments(
      assignments,
      "rented"
    )
  ) {
    await saveRentalAssignments(
      assignments
    );
  }

  return assignments;
}


async function saveRentalAssignments(
  records
) {
  await writeJson(
    RENTAL_ASSIGNMENTS_FILE,
    records
  );
  await clearPendingManagedProfileAlerts(records, RENTAL_ASSIGNMENTS_FILE);
}

async function clearPendingManagedProfileAlerts(records, file) {
  let changed = false;
  for (const assignment of records) {
    if (!assignment.pendingDiscordProfileMessageId) continue;
    try {
      await deleteDiscordAdminProfileWorkflowNotification(assignment.pendingDiscordProfileMessageId);
      delete assignment.pendingDiscordProfileMessageId;
      changed = true;
    } catch (error) {
      console.error("Managed profile Discord cleanup retry:", error.message);
    }
  }
  if (changed) await writeJson(file, records);
}

async function getManagedAccounts() {
  const records =
    await readJson(
      MANAGED_ACCOUNTS_FILE,
      []
    );

  if (!Array.isArray(records)) return [];
  const deleted = await deletedManagedLogins();
  if (!deleted.size) return records;
  return records.filter(record => {
    try {
      const credentials = record.credentials ? normalizeRetailerCredentials(decryptJson(record.credentials)) : null;
      return !RETAILER_KEYS.some(retailer => credentials?.[retailer]?.username &&
        deleted.has(managedLoginFingerprint(retailer, credentials[retailer].username)));
    } catch { return true; }
  });
}


async function saveManagedAccounts(
  records
) {
  await writeJson(
    MANAGED_ACCOUNTS_FILE,
    records
  );
}

function managedLoginFingerprint(retailer, username) {
  return crypto.createHash("sha256")
    .update(`${retailer}:${normalizeEmail(username)}`).digest("hex");
}

async function deletedManagedLogins() {
  const hashes = await readJson(DELETED_MANAGED_LOGINS_FILE, []);
  return new Set(Array.isArray(hashes) ? hashes : []);
}

async function excludeDeletedManagedLogins(accounts) {
  const deleted = await deletedManagedLogins();
  for (const account of accounts) {
    let credentials;
    try { credentials = account.credentials ? normalizeRetailerCredentials(decryptJson(account.credentials)) : null; }
    catch { continue; }
    for (const retailer of RETAILER_KEYS) {
      const username = credentials?.[retailer]?.username;
      if (username) deleted.add(managedLoginFingerprint(retailer, username));
    }
  }
  await writeJson(DELETED_MANAGED_LOGINS_FILE, [...deleted]);
}

async function rejectDeletedManagedLogins(retailer, accounts) {
  const deleted = await deletedManagedLogins();
  if (accounts.some(item => deleted.has(managedLoginFingerprint(retailer, item.email)))) {
    const error = new Error("This account was permanently deleted from the pool and cannot be imported again.");
    error.status = 409;
    throw error;
  }
}

async function getFreeMemberships() {
  const records =
    await readJson(
      FREE_MEMBERSHIPS_FILE,
      []
    );

  return Array.isArray(records)
    ? records
    : [];
}


async function saveFreeMemberships(
  records
) {
  await writeJson(
    FREE_MEMBERSHIPS_FILE,
    records
  );
}

async function getGiftedMemberships() {
  const records = await readJson(GIFTED_MEMBERSHIPS_FILE, []);
  return Array.isArray(records) ? records : [];
}

async function saveGiftedMemberships(records) {
  await writeJson(GIFTED_MEMBERSHIPS_FILE, records);
}

async function activeMembershipRecordForCustomer(customerAccountId, paidRecords = []) {
  const paid = paidRecords.find(record =>
    String(record.customerAccountId) === String(customerAccountId) &&
    subscriptionAllowsProfiles(record)
  );
  if (paid) return paid;
  const now = Date.now();
  const grants = await getGiftedMemberships();
  const gift = grants.filter(item =>
    String(item.customerAccountId) === String(customerAccountId) &&
    new Date(item.startsAt).getTime() <= now &&
    new Date(item.expiresAt).getTime() > now
  ).sort((a, b) => Number(b.profiles) - Number(a.profiles))[0];
  if (!gift) return null;
  const account = (await getCustomerAccounts()).find(item => String(item.id) === String(customerAccountId));
  if (!account) return null;
  return {
    id: `gift:${gift.id}`,
    customerAccountId,
    profile: { ...(account.adminProfile || {}), email: account.email },
    subscriptionStatus: "gifted",
    currentPeriodEnd: gift.expiresAt
  };
}

function membershipEncryptedPackage(record) {
  return String(record?.id || "").startsWith("gift:")
    ? Promise.resolve(null)
    : loadEncryptedPackage(record.id);
}

async function getDiscountCodes() {
  const records = await readJson(DISCOUNT_CODES_FILE, []);
  return Array.isArray(records) ? records : [];
}

async function saveDiscountCodes(records) {
  await writeJson(DISCOUNT_CODES_FILE, records);
}


async function getFreeAssignments() {
  const records =
    await readJson(
      FREE_ASSIGNMENTS_FILE,
      []
    );

  const assignments =
    Array.isArray(records)
      ? records
      : [];

  if (
    await cleanupExpiredManagedAssignments(
      assignments,
      "free"
    )
  ) {
    await saveFreeAssignments(
      assignments
    );
  }

  return assignments;
}


async function saveFreeAssignments(
  records
) {
  await writeJson(
    FREE_ASSIGNMENTS_FILE,
    records
  );
  await clearPendingManagedProfileAlerts(records, FREE_ASSIGNMENTS_FILE);
}


function freeAssignmentIsActive(
  assignment
) {
  if (
    assignment?.active !== true
  ) {
    return false;
  }

  if (!assignment?.expiresAt) {
    return true;
  }

  const expiresAt =
    new Date(
      assignment.expiresAt
    );

  if (
    Number.isNaN(
      expiresAt.getTime()
    )
  ) {
    return false;
  }

  return (
    expiresAt.getTime() >
    Date.now()
  );
}


function freeAssignmentDaysRemaining(
  assignment
) {
  if (
    !freeAssignmentIsActive(
      assignment
    )
  ) {
    return 0;
  }

  if (!assignment?.expiresAt) {
    return null;
  }

  const expiresAt =
    new Date(
      assignment.expiresAt
    );

  const remaining =
    expiresAt.getTime() -
    Date.now();

  return Math.max(
    0,
    Math.ceil(
      remaining /
      (
        1000 *
        60 *
        60 *
        24
      )
    )
  );
}


function currentFreeAssignment(
  assignments,
  freeMembershipId
) {
  const wantedId =
    String(
      freeMembershipId ||
      ""
    );

  return (
    assignments.find(
      assignment =>
        String(
          assignment
            .managedAccountId ||
          assignment
            .freeMembershipId ||
          ""
        ) ===
          wantedId &&
        managedAssignmentIsLinked(
          assignment
        )
    ) || null
  );
}


function rentalAssignmentIsActive(
  assignment
) {
  if (
    assignment?.active !== true
  ) {
    return false;
  }

  if (!assignment?.expiresAt) {
    return true;
  }

  const expiresAt =
    new Date(
      assignment.expiresAt
    );

  if (
    Number.isNaN(
      expiresAt.getTime()
    )
  ) {
    return false;
  }

  return (
    expiresAt.getTime() >
    Date.now()
  );
}


function rentalAssignmentDaysRemaining(
  assignment
) {
  if (
    !rentalAssignmentIsActive(
      assignment
    )
  ) {
    return 0;
  }

  if (!assignment?.expiresAt) {
    return null;
  }

  const expiresAt =
    new Date(
      assignment.expiresAt
    );

  const remaining =
    expiresAt.getTime() -
    Date.now();

  return Math.max(
    0,
    Math.ceil(
      remaining /
      (
        1000 *
        60 *
        60 *
        24
      )
    )
  );
}


function currentRentalAssignment(
  assignments,
  rentedMembershipId
) {
  const wantedId =
    String(
      rentedMembershipId ||
      ""
    );

  return (
    assignments.find(
      assignment =>
        String(
          assignment
            .managedAccountId ||
          assignment
            .rentedMembershipId ||
          ""
        ) ===
          wantedId &&
        managedAssignmentIsLinked(
          assignment
        )
    ) || null
  );
}


function managedAssignmentIsLinked(
  assignment
) {
  if (
    !assignment ||
    !assignment.customerAccountId
  ) {
    return false;
  }

  if (
    assignment.returnedToPoolAt ||
    String(
      assignment.endReason ||
      ""
    ) === "returned_to_pool"
  ) {
    return false;
  }

  if (
    String(
      assignment.activationStatus ||
      ""
    ) === "expired" ||
    String(
      assignment.endReason ||
      ""
    ) === "expired"
  ) {
    return false;
  }

  if (
    assignment.expiresAt
  ) {
    const end =
      new Date(
        assignment.expiresAt
      ).getTime();

    if (
      Number.isFinite(end) &&
      end <= Date.now()
    ) {
      return false;
    }
  }

  return true;
}


function linkedFreeAssignment(
  assignments,
  membershipId
) {
  return (
    assignments.find(
      assignment =>
        String(
          assignment.managedAccountId ||
          assignment.freeMembershipId ||
          ""
        ) ===
          String(membershipId) &&
        managedAssignmentIsLinked(
          assignment
        )
    ) || null
  );
}


function linkedRentalAssignment(
  assignments,
  membershipId
) {
  return (
    assignments.find(
      assignment =>
        String(
          assignment.managedAccountId ||
          assignment.rentedMembershipId ||
          ""
        ) ===
          String(membershipId) &&
        managedAssignmentIsLinked(
          assignment
        )
    ) || null
  );
}


function actionNeededWebhookUrl() {
  return String(
    process.env
      .DISCORD_ACTION_NEEDED_WEBHOOK_URL ||
    ""
  ).trim();
}


function customerNotifications(
  account
) {
  if (
    !Array.isArray(
      account.notifications
    )
  ) {
    account.notifications = [];
  }

  return account.notifications;
}


async function deleteActionNeededDiscordMessage(
  messageId
) {
  const webhookUrl =
    actionNeededWebhookUrl();

  if (
    !webhookUrl ||
    !messageId
  ) {
    return false;
  }

  try {
    const url =
      new URL(
        webhookUrl
      );

    url.pathname =
      `${url.pathname.replace(/\/$/, "")}/messages/${encodeURIComponent(
        messageId
      )}`;

    const response =
      await fetch(
        url,
        {
          method: "DELETE"
        }
      );

    return (
      response.ok ||
      response.status === 404
    );

  } catch (error) {
    console.error(
      "Action needed Discord delete failed:",
      error.message
    );

    return false;
  }
}


async function sendActionNeededDiscordMessage(
  account,
  message,
  { missingInfo = false } = {}
) {
  const webhookUrl =
    actionNeededWebhookUrl();

  if (!webhookUrl) {
    throw new Error(
      "DISCORD_ACTION_NEEDED_WEBHOOK_URL is not configured."
    );
  }

  const discordId =
    account?.discordLinkedAt &&
    /^\d{17,22}$/.test(String(account?.discordUserId || ""))
      ? String(account.discordUserId)
      : "";

  const websiteUrl =
    `${BASE_URL}/#my-profile`;

  const url =
    new URL(
      webhookUrl
    );

  url.searchParams.set(
    "wait",
    "true"
  );

  const response =
    await fetch(
      url,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            username:
              "SLABS N GRABS ACO Action Needed",

            allowed_mentions: {
              parse: [],
              users: discordId ? [discordId] : []
            },

            content:
              `${discordId ? `<@${discordId}> ` : ""}ACTION NEEDED — please check your profile page${missingInfo ? " because information is missing" : ""}: ${websiteUrl}`,

            embeds: [
              {
                title:
                  "Action Needed",

                description:
                  missingInfo
                    ? "Please open your profile on the website to see which information is missing. Do not post account or payment details in Discord."
                    : clean(message, 3500) || "Please check your profile page.",

                url:
                  websiteUrl,

                timestamp:
                  new Date()
                    .toISOString()
              }
            ]
          })
      }
    );

  const result =
    await response
      .json()
      .catch(
        () => ({})
      );

  if (!response.ok) {
    throw new Error(
      `Action-needed Discord webhook returned ${response.status}.`
    );
  }

  return result?.id ||
    null;
}

async function sendCustomerMissingInfoDiscordDm(account) {
  const discordId = account?.discordLinkedAt &&
    /^\d{17,22}$/.test(String(account?.discordUserId || ""))
      ? String(account.discordUserId) : "";
  if (!discordId) return false;
  const token = String(process.env.DISCORD_BOT_TOKEN || "").trim();
  if (!token) throw new Error("Discord bot is not configured to message the customer.");
  const headers = { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
  const channelResponse = await fetch("https://discord.com/api/v10/users/@me/channels", {
    method: "POST", headers, body: JSON.stringify({ recipient_id: discordId }),
    signal: AbortSignal.timeout(12000)
  });
  if (!channelResponse.ok) throw new Error(`Discord could not open the customer DM (HTTP ${channelResponse.status}).`);
  const channel = await channelResponse.json();
  const response = await fetch(`https://discord.com/api/v10/channels/${channel.id}/messages`, {
    method: "POST", headers,
    body: JSON.stringify({
      content: `Action needed: information is missing from your profile. Please check your notifications and complete the listed fields: ${BASE_URL}/#my-profile`,
      allowed_mentions: { parse: [] }
    }), signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`Discord could not send the customer DM (HTTP ${response.status}).`);
  return true;
}


function profileMissingFieldLabels(
  profile,
  secrets,
  label
) {
  const missing = [];

  const shippingFields = [
    ["firstName", "first name"],
    ["lastName", "last name"],
    ["email", "email"],
    ["phone", "phone"],
    ["address", "street address"],
    ["city", "city"],
    ["state", "state"],
    ["zip", "ZIP code"],
    ["country", "country"]
  ];

  for (
    const [
      key,
      fieldLabel
    ] of
    shippingFields
  ) {
    if (
      !String(
        profile?.[key] ||
        ""
      ).trim()
    ) {
      missing.push(
        `${label}: ${fieldLabel}`
      );
    }
  }

  const digits =
    String(
      secrets?.acoCardNumber ||
      ""
    ).replace(
      /\D/g,
      ""
    );

  if (
    !String(
      secrets?.cardholder ||
      ""
    ).trim()
  ) {
    missing.push(
      `${label}: cardholder name`
    );
  }

  if (
    !/^\d{12,19}$/.test(
      digits
    )
  ) {
    missing.push(
      `${label}: card number`
    );
  }

  if (
    !/^(0[1-9]|1[0-2])$/.test(
      String(
        secrets?.expMonth ||
        ""
      )
    )
  ) {
    missing.push(
      `${label}: expiration month`
    );
  }

  if (
    !/^\d{4}$/.test(
      String(
        secrets?.expYear ||
        ""
      )
    )
  ) {
    missing.push(
      `${label}: expiration year`
    );
  }

  if (!String(secrets?.securityCode || "").trim()) {
    missing.push(`${label}: Security Code`);
  }

  return missing;
}


function paidProfileMissingItems(
  record,
  index = 1
) {
  const profile =
    record?.customerProfile ||
    {};

  let secrets = {};

  try {
    if (
      record?.customerSecrets
    ) {
      secrets =
        decryptJson(
          record.customerSecrets
        ) || {};
    }
  } catch {
    secrets = {};
  }

  const missing = profileMissingFieldLabels(
    profile,
    secrets,
    `Paid Profile ${index}`
  );
  let credentials = emptyRetailerCredentials();
  try {
    if (record?.credentials) credentials = normalizeRetailerCredentials(decryptJson(record.credentials));
  } catch {
    credentials = emptyRetailerCredentials();
  }
  // Only show field names. Never put retailer login values in notifications.
  for (const retailer of ["target", "walmart"]) {
    const label = retailerDisplayName(retailer);
    if (!String(credentials[retailer]?.username || "").trim()) {
      missing.push(`Paid Profile ${index}: ${label} username / email`);
    }
    if (!String(credentials[retailer]?.password || "").trim()) {
      missing.push(`Paid Profile ${index}: ${label} password`);
    }
  }
  return missing;
}

const PROFILE_SETUP_FIELDS = [
  "first name", "last name", "email", "phone", "street address",
  "city", "state", "ZIP code", "country", "cardholder name",
  "card number", "expiration month", "expiration year", "Security Code"
];

// Return statuses and field names only. Checkout and retailer secrets never leave the server.
async function customerSetupChecklist(account) {
  const missing = new Set(await customerMissingInformation(account.id));
  const tasks = [];
  const add = (label, target, complete = !missing.has(label)) => {
    tasks.push({ label, target, complete: Boolean(complete) });
  };

  const allowance = Math.min(50, await getCustomerProfileAllowance(account.id));
  for (let slot = 1; slot <= allowance; slot += 1) {
    const label = `Paid Profile ${slot}`;
    for (const field of PROFILE_SETUP_FIELDS) add(`${label}: ${field}`, { type: "paid", slot });
    for (const retailer of ["Target", "Walmart"]) {
      add(`${label}: ${retailer} username / email`, { type: "paid", slot });
      add(`${label}: ${retailer} password`, { type: "paid", slot });
    }
  }

  const [freeAssignments, rentalAssignments] = await Promise.all([
    getFreeAssignments(), getRentalAssignments()
  ]);
  for (const [assignments, type, label] of [
    [freeAssignments, "free", "Gifted"], [rentalAssignments, "rented", "Rented"]
  ]) {
    let number = 0;
    for (const assignment of assignments) {
      if (String(assignment.customerAccountId || "") !== String(account.id) ||
          !managedAssignmentIsLinked(assignment)) continue;
      number += 1;
      for (const field of PROFILE_SETUP_FIELDS) {
        add(`${label} Profile ${number}: ${field}`, { type, number });
      }
    }
  }

  if (tasks.length) {
    const details = await customerSavedDetailsPayload(account);
    const hasAddress = details.addresses.some(address =>
      ["firstName", "lastName", "address", "city", "state", "zip", "country"]
        .every(key => String(address[key] || "").trim()));
    const hasCard = details.paymentMethods.some(card =>
      Boolean(String(card.cardholder || "").trim()) &&
      /^\d{12,19}$/.test(String(card.acoCardNumber || "").replace(/\D/g, "")) &&
      /^(0[1-9]|1[0-2])$/.test(String(card.expMonth || "")) &&
      /^\d{4}$/.test(String(card.expYear || "")));
    add("Account: one shipping address", { type: "shipping" }, hasAddress);
    add("Account: one payment card", { type: "payment" }, hasCard);
  }

  if (allowance) {
    const paid = await readJson(PAID_FILE, []);
    const order = (Array.isArray(paid) ? paid : [])
      .filter(record => String(record.customerAccountId || "") === String(account.id) &&
        subscriptionAllowsProfiles(record))
      .sort((a, b) => new Date(b.paidAt || b.createdAt || 0) -
        new Date(a.paidAt || a.createdAt || 0))[0];
    if (order) {
      const secrets = await loadEncryptedPackage(order.id) || {};
      const target = { type: "order", orderNumber: order.orderNumber || order.submissionNumber || order.id };
      add("Order: IMAP / host email", target,
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(secrets.acoEmail || "")));
      add("Order: IMAP / host app password", target,
        String(secrets.acoPassword || "").length >= 6);
    }
  }

  return tasks;
}

async function customerMissingInformation(
  customerAccountId
) {
  const [
    retailerProfiles,
    freeAssignments,
    rentalAssignments
  ] = await Promise.all([
    getRetailerProfiles(),
    getFreeAssignments(),
    getRentalAssignments()
  ]);

  const missing = [];

  const paid =
    retailerProfiles.filter(
      record =>
        String(
          record.customerAccountId ||
          ""
        ) ===
          String(
            customerAccountId
          )
    );

  const paidAllowance = Math.min(50, await getCustomerProfileAllowance(customerAccountId));
  const paidBySlot = new Map(paid.map(record => [Number(record.slot), record]));
  for (let slot = 1; slot <= paidAllowance; slot += 1) {
    const record = paidBySlot.get(slot);
    missing.push(...paidProfileMissingItems(record, slot));
  }

  const inspectManaged =
    (
      assignment,
      type,
      number
    ) => {
      if (
        String(
          assignment.customerAccountId ||
          ""
        ) !==
          String(
            customerAccountId
          ) ||
        !managedAssignmentIsLinked(
          assignment
        )
      ) {
        return;
      }

      let secrets = {};

      try {
        if (
          assignment.customerSecrets
        ) {
          secrets =
            decryptJson(
              assignment.customerSecrets
            ) || {};
        }
      } catch {
        secrets = {};
      }

      const label =
        type === "free"
          ? `Gifted Profile ${number}`
          : `Rented Profile ${number}`;

      missing.push(
        ...profileMissingFieldLabels(
          assignment.customerProfile ||
            {},
          secrets,
          label
        )
      );
    };

  let giftedNumber = 0;

  for (
    const assignment of
    freeAssignments
  ) {
    if (
      String(
        assignment.customerAccountId ||
        ""
      ) ===
        String(
          customerAccountId
        ) &&
      managedAssignmentIsLinked(
        assignment
      )
    ) {
      giftedNumber += 1;
      inspectManaged(
        assignment,
        "free",
        giftedNumber
      );
    }
  }

  let rentedNumber = 0;

  for (
    const assignment of
    rentalAssignments
  ) {
    if (
      String(
        assignment.customerAccountId ||
        ""
      ) ===
        String(
          customerAccountId
        ) &&
      managedAssignmentIsLinked(
        assignment
      )
    ) {
      rentedNumber += 1;
      inspectManaged(
        assignment,
        "rented",
        rentedNumber
      );
    }
  }

  return missing;
}


async function syncCustomerMissingNotification(
  customerAccountId
) {
  const accounts =
    await getCustomerAccounts();

  const account =
    accounts.find(
      item =>
        String(item.id) ===
        String(customerAccountId)
    );

  if (!account) {
    return {
      account: null,
      missing: [],
      checklist: []
    };
  }

  const notifications =
    customerNotifications(
      account
    );

  const checklist = await customerSetupChecklist(account);
  const missing = checklist.filter(item => !item.complete).map(item => item.label);

  const existing =
    notifications.find(
      item =>
        item.kind ===
        "missing_info"
    );

  if (!missing.length) {
    if (existing) {
      if (
        existing.discordMessageId
      ) {
        const removed = await deleteActionNeededDiscordMessage(
          existing.discordMessageId
        );
        if (!removed) {
          existing.message = "All required fields are complete. The Discord alert is awaiting removal.";
          existing.missingItems = [];
          await saveCustomerAccounts(accounts);
          return { account, missing, checklist };
        }
      }

      account.notifications =
        notifications.filter(
          item =>
            item.id !==
            existing.id
        );

      if (checklist.length) {
        account.notifications.unshift({
          id: crypto.randomUUID(),
          kind: "setup_complete",
          title: "All Necessary Fields Completed",
          message: "All necessary fields have been completed. Your Action Needed message has been removed from Discord.",
          createdAt: new Date().toISOString()
        });
      }

      account.updatedAt =
        new Date()
          .toISOString();

      await saveCustomerAccounts(
        accounts
      );

      try {
        if (!checklist.length) return { account, missing, checklist };
        const retailerProfiles =
          await getRetailerProfiles();

        const firstProfile =
          retailerProfiles.find(
            record =>
              String(
                record.customerAccountId ||
                ""
              ) ===
                String(
                  customerAccountId
                )
          );

        const customerName =
          [
            firstProfile
              ?.customerProfile
              ?.firstName,
            firstProfile
              ?.customerProfile
              ?.lastName
          ]
            .filter(Boolean)
            .join(" ") ||
          account.email ||
          "Customer";

        await sendDiscordAdminProfileWorkflowNotification({
          title:
            "PROFILE COMPLETED",

          description:
            `${customerName} profile completed.`,

          customerName,

          customerEmail:
            account.email ||
            "Not available",

          profileLabel:
            "All required information complete",

          profileType:
            "Customer"
        });

      } catch (error) {
        console.error(
          "Profile completed admin Discord notification failed:",
          error.message
        );
      }
    }

    return {
      account,
      missing,
      checklist
    };
  }

  // A new missing field supersedes an earlier completion notice.
  for (let i = notifications.length - 1; i >= 0; i -= 1) {
    if (notifications[i].kind === "setup_complete") notifications.splice(i, 1);
  }

  const message =
    `Important information is missing:\n• ${missing.join(
      "\n• "
    )}`;

  if (existing) {
    existing.message =
      message;

    existing.missingItems =
      missing;

    existing.updatedAt =
      new Date()
        .toISOString();

  } else {
    notifications.push({
      id:
        crypto.randomUUID(),

      kind:
        "missing_info",

      title:
        "Action Needed",

      message,

      missingItems:
        missing,

      createdAt:
        new Date()
          .toISOString(),

      updatedAt:
        new Date()
          .toISOString(),

      discordMessageId:
        null
    });
  }

  account.updatedAt =
    new Date()
      .toISOString();

  await saveCustomerAccounts(
    accounts
  );

  return {
    account,
    missing,
    checklist
  };
}


function specialProfileLabel(
  profileType
) {
  return (
    normalizeSpecialProfileType(
      profileType
    ) === "rented"
      ? "RENTED PROFILE"
      : "FREE PROFILE"
  );
}



function managedAssignmentStatus(
  assignment
) {
  const status =
    String(
      assignment?.activationStatus ||
      ""
    )
      .trim()
      .toLowerCase();

  if (
    status === "awaiting_activation"
  ) {
    return "awaiting_activation";
  }

  if (
    status === "activated"
  ) {
    return "activated";
  }

  if (
    [
      "deactivated",
      "inactive",
      "expired"
    ].includes(status)
  ) {
    return "inactive";
  }

  return assignment?.active === true
    ? "awaiting_activation"
    : "inactive";
}


function prepareManagedAssignmentForActivation(
  assignment,
  durationType,
  now = new Date()
) {
  assignment.active = true;
  assignment.durationType = durationType;
  assignment.activationStatus =
    "awaiting_activation";
  assignment.activationRequestedAt =
    now.toISOString();

  /*
    Access time starts only after Admin activates.
  */
  assignment.startsAt = null;
  assignment.expiresAt = null;
  assignment.activatedAt = null;
  assignment.deactivatedAt = null;
  assignment.endedAt = null;
  assignment.endReason = null;
  assignment.updatedAt =
    now.toISOString();

  return assignment;
}


function activateManagedAssignmentTimer(
  assignment,
  now = new Date()
) {
  assignment.active = true;
  assignment.activationStatus =
    "activated";
  assignment.activatedAt =
    now.toISOString();
  assignment.startsAt =
    now.toISOString();
  assignment.expiresAt =
    specialProfileExpiresAt(
      assignment.durationType,
      now
    );
  assignment.deactivatedAt = null;
  assignment.endedAt = null;
  assignment.endReason = null;
  assignment.updatedAt =
    now.toISOString();

  return assignment;
}


function specialProfileDurationLabel(
  durationType
) {
  const duration =
    normalizeSpecialProfileDuration(
      durationType
    );

  if (
    duration === "1_drop"
  ) {
    return "1 DROP";
  }

  if (
    duration === "1_week"
  ) {
    return "1 WEEK";
  }

  if (
    duration === "1_month"
  ) {
    return "1 MONTH";
  }

  return "INDEFINITELY";
}


function safeSpecialProfile(
  record
) {
  let credentials =
    emptyRetailerCredentials();

  try {
    if (record?.credentials) {
      credentials =
        normalizeRetailerCredentials(
          decryptJson(
            record.credentials
          )
        );
    }
  } catch (error) {
    console.error(
      "Special profile decrypt error:",
      error.message
    );
  }

  const retailers = {};

  for (
    const retailer of
    RETAILER_KEYS
  ) {
    const saved =
      credentials[retailer] || {
        username: "",
        password: ""
      };

    retailers[retailer] = {
      username:
        saved.username || "",

      passwordConfigured:
        Boolean(
          saved.password
        )
    };
  }

  const active =
    specialProfileIsActive(
      record
    );

  return {
    id:
      record.id || null,

    profileType:
      normalizeSpecialProfileType(
        record.profileType
      ),

    profileName:
      specialProfileLabel(
        record.profileType
      ),

    active,

    durationType:
      normalizeSpecialProfileDuration(
        record.durationType
      ),

    durationLabel:
      specialProfileDurationLabel(
        record.durationType
      ),

    startsAt:
      record.startsAt || null,

    expiresAt:
      record.expiresAt || null,

    daysRemaining:
      specialProfileDaysRemaining(
        record
      ),

    retailers,

    createdAt:
      record.createdAt || null,

    updatedAt:
      record.updatedAt || null
  };
}


function adminSpecialProfile(
  record
) {
  let credentials =
    emptyRetailerCredentials();

  try {
    if (record?.credentials) {
      credentials =
        normalizeRetailerCredentials(
          decryptJson(
            record.credentials
          )
        );
    }
  } catch (error) {
    console.error(
      "Admin special profile decrypt error:",
      error.message
    );
  }

  const retailers = {};

  for (
    const retailer of
    RETAILER_KEYS
  ) {
    const saved =
      credentials[retailer] || {
        username: "",
        password: ""
      };

    retailers[retailer] = {
      username:
        saved.username || "",

      password:
        saved.password || "",

      passwordConfigured:
        Boolean(
          saved.password
        )
    };
  }

  const active =
    specialProfileIsActive(
      record
    );

  return {
    id:
      record.id || null,

    customerAccountId:
      record.customerAccountId ||
      null,

    profileType:
      normalizeSpecialProfileType(
        record.profileType
      ),

    profileName:
      specialProfileLabel(
        record.profileType
      ),

    active,

    durationType:
      normalizeSpecialProfileDuration(
        record.durationType
      ),

    durationLabel:
      specialProfileDurationLabel(
        record.durationType
      ),

    startsAt:
      record.startsAt || null,

    expiresAt:
      record.expiresAt || null,

    daysRemaining:
      specialProfileDaysRemaining(
        record
      ),

    retailers,

    createdAt:
      record.createdAt || null,

    updatedAt:
      record.updatedAt || null
  };
}

async function getRetailerProfiles() {
  const records =
    await readJson(
      RETAILER_PROFILES_FILE,
      []
    );

  return Array.isArray(records)
    ? records
    : [];
}

async function saveRetailerProfiles(
  records
) {
  await writeJson(
    RETAILER_PROFILES_FILE,
    records
  );
}

function subscriptionAllowsProfiles(
  record
) {
  const status =
    String(
      record?.subscriptionStatus ||
      ""
    )
      .trim()
      .toLowerCase();

  /*
    Current Stripe subscription statuses that
    should have access to retailer profiles.
  */
  if (
    [
      "active",
      "trialing"
    ].includes(status)
  ) {
    return true;
  }

  /*
    Explicit inactive Stripe statuses must
    never receive profile access.
  */
  if (
    [
      "canceled",
      "cancelled",
      "unpaid",
      "incomplete",
      "incomplete_expired",
      "paused"
    ].includes(status)
  ) {
    return false;
  }

  /*
    Past-due memberships are not treated as
    active until Stripe reports them active again.
  */
  if (status === "past_due") {
    return false;
  }

  /*
    Compatibility for older paid records created
    before subscriptionStatus was stored.

    Only allow the legacy record when:
    - it is in paid-submissions.json
    - it has evidence of a completed payment
    - it has not been explicitly ended/canceled
  */
  const hasPaidRecord =
    Boolean(
      record?.paidAt ||
      record?.stripeSessionId
    );

  const hasEnded =
    Boolean(
      record?.endedAt ||
      record?.canceledAt
    );

  return (
    !status &&
    hasPaidRecord &&
    !hasEnded
  );
}

function profileAllowanceForRecord(
  record
) {
  const planProfiles =
    Number(
      record?.plan?.profiles
    );

  if (
    Number.isInteger(
      planProfiles
    ) &&
    planProfiles > 0
  ) {
    return Math.min(
      planProfiles,
      50
    );
  }

  const planTier =
    Number(
      record?.plan?.tier ||
      record?.plan?.id
    );

  if (
    PLANS[planTier]?.profiles
  ) {
    return PLANS[
      planTier
    ].profiles;
  }

  const planName =
    String(
      record?.plan?.name ||
      ""
    )
      .trim()
      .toLowerCase();

  const matchingPlan =
    Object.values(
      PLANS
    ).find(
      plan =>
        String(
          plan.name
        ).toLowerCase() ===
          planName
    );

  return matchingPlan
    ? matchingPlan.profiles
    : 0;
}

async function getCustomerProfileAllowance(
  accountId
) {
  const paid =
    await readJson(
      PAID_FILE,
      []
    );

  const owned =
    (
      Array.isArray(paid)
        ? paid
        : []
    ).filter(
      record =>
        record.customerAccountId ===
          accountId &&
        subscriptionAllowsProfiles(
          record
        )
    );

  const paidAllowance = owned.length
    ? Math.max(0, ...owned.map(profileAllowanceForRecord))
    : 0;

  const now = Date.now();
  const gifted = await getGiftedMemberships();
  const activeGifts = gifted
    .filter(item =>
      String(item.customerAccountId) === String(accountId) &&
      (!item.startsAt || new Date(item.startsAt).getTime() <= now) &&
      (!item.expiresAt || new Date(item.expiresAt).getTime() > now)
    );
  const giftedAllowance = activeGifts
    .filter(item => item.createdBy !== "referral")
    .reduce((max, item) => Math.max(max, Number(item.profiles) || 0), 0);

  const referralAllowance = activeGifts
    .filter(item => item.createdBy === "referral")
    .reduce((sum, item) => sum + Math.max(0, Number(item.profiles) || 0), 0);
  const baseAllowance = Math.max(paidAllowance, giftedAllowance) + referralAllowance;
  if (!baseAllowance) return 0;
  const customer = (await getCustomerAccounts()).find(item => String(item.id) === String(accountId));
  const bonus = Math.max(0, Number(customer?.referralBonusProfiles) || 0);
  return Math.min(100, baseAllowance + bonus);
}

function safeRetailerProfile(
  record,
  allowance
) {
  let credentials =
    emptyRetailerCredentials();

  let customerSecrets = {};

  try {
    if (record?.credentials) {
      credentials =
        normalizeRetailerCredentials(
          decryptJson(
            record.credentials
          )
        );
    }
  } catch (error) {
    console.error(
      "Retailer profile decrypt error:",
      error.message
    );
  }

  try {
    if (
      record?.customerSecrets
    ) {
      customerSecrets =
        decryptJson(
          record.customerSecrets
        ) || {};
    }
  } catch (error) {
    console.error(
      "Retailer profile customer details decrypt error:",
      error.message
    );
  }

  const retailers = {};

  for (
    const retailer of
    RETAILER_KEYS
  ) {
    retailers[retailer] = {
      username:
        credentials[
          retailer
        ].username,

      password:
        credentials[
          retailer
        ].password ||
        "",

      passwordConfigured:
        Boolean(
          credentials[
            retailer
          ].password
        )
    };
  }

  const customerProfile =
    record?.customerProfile &&
    typeof record.customerProfile ===
      "object"
      ? record.customerProfile
      : null;

  const readiness =
    managedProfileReadiness(
      customerProfile,
      customerSecrets
    );

  return {
    id:
      record.id,

    slot:
      Number(record.slot),

    profileName:
      clean(
        record.profileName,
        80
      ),

    locked:
      Number(record.slot) >
      allowance,

    retailers,

    customerProfile,

    customerCard:
      fullProfileCardDetails(
        customerSecrets
      ),

    readiness,

    ...exportReadinessPayload(
      customerProfile ||
        {},
      customerSecrets
    ),

    jigNeeded: record.jigNeeded === true,
    exportAttemptStatus: record.exportAttemptStatus || null,
    exportAttemptedAt: record.exportAttemptedAt || null,

    activationStatus:
      normalizeProfileActivationStatus(
        record.activationStatus,
        readiness.ready
      ),

    activationLabel:
      profileActivationLabel(
        normalizeProfileActivationStatus(
          record.activationStatus,
          readiness.ready
        )
      ),

    activatedAt:
      record.activatedAt ||
      null,

    deactivatedAt:
      record.deactivatedAt ||
      null,

    selectedAddressId:
      record.selectedAddressId ||
      null,

    selectedPaymentId:
      record.selectedPaymentId ||
      null,

    createdAt:
      record.createdAt ||
      null,

    updatedAt:
      record.updatedAt ||
      null
  };
}

function adminRetailerProfile(
  record,
  allowance
) {
  let credentials =
    emptyRetailerCredentials();

  let customerSecrets = {};

  try {
    if (record?.credentials) {
      credentials =
        normalizeRetailerCredentials(
          decryptJson(
            record.credentials
          )
        );
    }
  } catch (error) {
    console.error(
      "Admin retailer profile decrypt error:",
      error.message
    );
  }

  try {
    if (
      record?.customerSecrets
    ) {
      customerSecrets =
        decryptJson(
          record.customerSecrets
        ) || {};
    }
  } catch {
    customerSecrets = {};
  }

  const customerProfile =
    record?.customerProfile &&
    typeof record.customerProfile ===
      "object"
      ? record.customerProfile
      : null;

  const readiness =
    managedProfileReadiness(
      customerProfile,
      customerSecrets
    );

  const retailers = {};

  for (
    const retailer of
    RETAILER_KEYS
  ) {
    const saved =
      credentials[retailer] || {
        username: "",
        password: ""
      };

    retailers[retailer] = {
      username:
        saved.username || "",

      password:
        saved.password || "",

      passwordConfigured:
        Boolean(
          saved.password
        )
    };
  }

  return {
    id:
      record.id,

    slot:
      Number(record.slot),

    profileName:
      clean(
        record.profileName,
        80
      ),

    locked:
      Number(record.slot) >
      allowance,

    retailers,

    customerProfile,

    customerCard:
      fullProfileCardDetails(
        customerSecrets
      ),

    readiness,

    ...exportReadinessPayload(
      customerProfile ||
        {},
      customerSecrets
    ),

    jigNeeded: record.jigNeeded === true,
    exportAttemptStatus: record.exportAttemptStatus || null,
    exportAttemptedAt: record.exportAttemptedAt || null,

    activationStatus:
      normalizeProfileActivationStatus(
        record.activationStatus,
        readiness.ready
      ),

    activationLabel:
      profileActivationLabel(
        normalizeProfileActivationStatus(
          record.activationStatus,
          readiness.ready
        )
      ),

    activatedAt:
      record.activatedAt ||
      null,

    deactivatedAt:
      record.deactivatedAt ||
      null,

    createdAt:
      record.createdAt ||
      null,

    updatedAt:
      record.updatedAt ||
      null
  };
}

/* -------------------------------------------------------
   RETAILER PROFILE ROUTES
------------------------------------------------------- */

app.get(
  "/api/account/free-memberships",
  requireCustomer,
  async (req, res) => {
    try {
      const memberships =
        await getManagedAccounts();

      const assignments =
        await getFreeAssignments();

      let assignmentsChanged =
        false;

      const now =
        new Date();

      /*
        Expire free assignments automatically
        before returning customer data.
      */

      for (
        const assignment of
        assignments
      ) {
        if (
          assignment.active !== true ||
          String(
            assignment.activationStatus ||
            ""
          ) !==
            "activated" ||
          !assignment.expiresAt
        ) {
          continue;
        }

        const expiresAt =
          new Date(
            assignment.expiresAt
          );

        if (
          !Number.isNaN(
            expiresAt.getTime()
          ) &&
          expiresAt.getTime() <=
            now.getTime()
        ) {
          if (
            assignment.activationStatus !==
            "expired"
          ) {
            clearManagedAssignmentCustomerData(
              assignment,
              {
                reason:
                  "expired",
                nowIso:
                  now.toISOString()
              }
            );

            assignmentsChanged =
              true;
          }

          const discordChanged =
            await ensureManagedProfileDiscordMessage(
              assignment,
              "free"
            );

          if (discordChanged) {
            assignmentsChanged =
              true;
          }
        }
      }

      for (
        const assignment of
        assignments
      ) {
        if (
          assignment.active !==
            true ||
          assignment.activationStatus ===
            "expired" ||
          assignment.activationStatus ===
            "activated" ||
          !assignment.customerProfile ||
          !assignment.customerSecrets
        ) {
          continue;
        }

        let secrets = {};

        try {
          secrets =
            decryptJson(
              assignment.customerSecrets
            ) || {};
        } catch {
          secrets = {};
        }

        const readiness =
          managedProfileReadiness(
            assignment.customerProfile,
            secrets
          );

        if (
          readiness.ready &&
          assignment.activationStatus !==
            "awaiting_activation"
        ) {
          assignment.activationStatus =
            "awaiting_activation";

          assignment.activationRequestedAt =
            assignment.activationRequestedAt ||
            now.toISOString();

          assignment.updatedAt =
            now.toISOString();

          assignmentsChanged =
            true;

          const discordChanged =
            await ensureManagedProfileDiscordMessage(
              assignment,
              "free"
            );

          assignmentsChanged =
            assignmentsChanged ||
            discordChanged;
        }
      }

      if (assignmentsChanged) {
        await saveFreeAssignments(
          assignments
        );
      }

      const customerAssignments =
        assignments.filter(
          assignment =>
            assignment
              .customerAccountId ===
              req.customerAccount.id &&
            assignment.active ===
              true
        );

      const result =
        customerAssignments
          .map(assignment => {
            const membership =
              memberships.find(
                item =>
                  item.id ===
                  assignment
                    .freeMembershipId
              );

            if (!membership) {
              return null;
            }

            let customerCard =
  null;

try {
  if (
    assignment.customerSecrets
  ) {
    const customerSecrets =
      decryptJson(
        assignment.customerSecrets
      );

    customerCard = {
      cardLabel:
        customerSecrets.cardLabel || "",
      cardholder:
        customerSecrets.cardholder || "",
      acoCardNumber:
        customerSecrets.acoCardNumber || "",
      expMonth:
        customerSecrets.expMonth || "",
      expYear:
        customerSecrets.expYear || "",
      securityCode:
        customerSecrets.securityCode || ""
    };
  }
} catch (error) {
  console.error(
    "Customer free membership card decrypt error:",
    assignment.id,
    error.message
  );
}

            return {
              id:
                membership.id,

              assignmentId:
                assignment.id,

              profileType:
                "free",

              profileName:
                membership.profileName ||
                "FREE MEMBERSHIP",

              status:
                assignment.activationStatus ===
                  "expired"
                  ? "expired"
                  : "active",

              active:
                assignment.activationStatus !==
                  "expired",

              activationStatus:
                normalizeProfileActivationStatus(
                  assignment.activationStatus,
                  false
                ),

              activationLabel:
                profileActivationLabel(
                  normalizeProfileActivationStatus(
                    assignment.activationStatus,
                    false
                  )
                ),

              startsAt:
                assignment.startsAt ||
                null,

              expiresAt:
                assignment.expiresAt ||
                null,

              durationType:
                assignment.durationType ||
                null,

              durationLabel:
                specialProfileDurationLabel(
                  assignment.durationType
                ),

              daysRemaining:
                freeAssignmentDaysRemaining(
                  assignment
                ),

              paidSubmissionId:
                assignment
                  .paidSubmissionId ||
                null,

              customerProfile:
                assignment
                  .customerProfile ||
                null,

              customerCard,

              createdAt:
                membership.createdAt ||
                null,

              updatedAt:
                membership.updatedAt ||
                null
            };
          })
          .filter(Boolean);

      return res.json({
        ok: true,

        memberships:
          result
      });

    } catch (error) {
      console.error(
        "Customer free memberships error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to load free memberships."
        });
    }
  }
);

app.get(
  "/api/account/rented-memberships",
  requireCustomer,
  async (req, res) => {
    try {
      const memberships =
        await getManagedAccounts();

      const assignments =
        await getRentalAssignments();

      let assignmentsChanged =
        false;

      const now =
        new Date();

      /*
        Expire assignments automatically
        before returning customer data.
      */

      for (
        const assignment of
        assignments
      ) {
        if (
          assignment.active !== true ||
          String(
            assignment.activationStatus ||
            ""
          ) !==
            "activated" ||
          !assignment.expiresAt
        ) {
          continue;
        }

        const expiresAt =
          new Date(
            assignment.expiresAt
          );

        if (
          !Number.isNaN(
            expiresAt.getTime()
          ) &&
          expiresAt.getTime() <=
            now.getTime()
        ) {
          if (
            assignment.activationStatus !==
            "expired"
          ) {
            clearManagedAssignmentCustomerData(
              assignment,
              {
                reason:
                  "expired",
                nowIso:
                  now.toISOString()
              }
            );

            assignmentsChanged =
              true;
          }

          const discordChanged =
            await ensureManagedProfileDiscordMessage(
              assignment,
              "rented"
            );

          if (discordChanged) {
            assignmentsChanged =
              true;
          }
        }
      }

      for (
        const assignment of
        assignments
      ) {
        if (
          assignment.active !==
            true ||
          assignment.activationStatus ===
            "expired" ||
          assignment.activationStatus ===
            "activated" ||
          !assignment.customerProfile ||
          !assignment.customerSecrets
        ) {
          continue;
        }

        let secrets = {};

        try {
          secrets =
            decryptJson(
              assignment.customerSecrets
            ) || {};
        } catch {
          secrets = {};
        }

        const readiness =
          managedProfileReadiness(
            assignment.customerProfile,
            secrets
          );

        if (
          readiness.ready &&
          assignment.activationStatus !==
            "awaiting_activation"
        ) {
          assignment.activationStatus =
            "awaiting_activation";

          assignment.activationRequestedAt =
            assignment.activationRequestedAt ||
            now.toISOString();

          assignment.updatedAt =
            now.toISOString();

          assignmentsChanged =
            true;

          const discordChanged =
            await ensureManagedProfileDiscordMessage(
              assignment,
              "rented"
            );

          assignmentsChanged =
            assignmentsChanged ||
            discordChanged;
        }
      }

      if (assignmentsChanged) {
        await saveRentalAssignments(
          assignments
        );
      }

      const customerAssignments =
        assignments.filter(
          assignment =>
            assignment
              .customerAccountId ===
              req.customerAccount.id &&
            assignment.active ===
              true
        );

      const result =
        customerAssignments
          .map(assignment => {
            const membership =
              memberships.find(
                item =>
                  item.id ===
                  assignment
                    .rentedMembershipId
              );

            if (!membership) {
              return null;
            }

            let customerCard =
  null;

try {
  if (
    assignment.customerSecrets
  ) {
    const customerSecrets =
      decryptJson(
        assignment.customerSecrets
      );

    customerCard = {
      cardLabel:
        customerSecrets.cardLabel || "",
      cardholder:
        customerSecrets.cardholder || "",
      acoCardNumber:
        customerSecrets.acoCardNumber || "",
      expMonth:
        customerSecrets.expMonth || "",
      expYear:
        customerSecrets.expYear || "",
      securityCode:
        customerSecrets.securityCode || ""
    };
  }
} catch (error) {
  console.error(
    "Customer rented membership card decrypt error:",
    assignment.id,
    error.message
  );
}
            

            return {
              id:
                membership.id,

              assignmentId:
                assignment.id,

              profileType:
                "rented",

              profileName:
                membership.profileName ||
                "RENTED MEMBERSHIP",

              status:
                assignment.activationStatus ===
                  "expired"
                  ? "expired"
                  : "active",

              active:
                assignment.activationStatus !==
                  "expired",

              activationStatus:
                normalizeProfileActivationStatus(
                  assignment.activationStatus,
                  false
                ),

              activationLabel:
                profileActivationLabel(
                  normalizeProfileActivationStatus(
                    assignment.activationStatus,
                    false
                  )
                ),

              startsAt:
                assignment.startsAt ||
                null,

              expiresAt:
                assignment.expiresAt ||
                null,

              durationType:
                assignment.durationType ||
                null,

              durationLabel:
                specialProfileDurationLabel(
                  assignment.durationType
                ),

              daysRemaining:
                rentalAssignmentDaysRemaining(
                  assignment
                ),

              paidSubmissionId:
                assignment
                  .paidSubmissionId ||
                null,

              stripeSubscriptionId:
                assignment
                  .stripeSubscriptionId ||
                null,

              createdAt:
                membership.createdAt ||
                null,

              updatedAt:
  membership.updatedAt ||
  null,

customerProfile:
  assignment.customerProfile ||
  null,

customerCard,
            };
          })
          .filter(Boolean);

      return res.json({
        ok: true,

        memberships:
          result
      });

    } catch (error) {
      console.error(
        "Customer rented memberships error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to load rented memberships."
        });
    }
  }
);

app.get(
  "/api/account/retailer-profiles",
  requireCustomer,
  async (req, res) => {
    try {
      const allowance =
        await getCustomerProfileAllowance(
          req.customerAccount.id
        );

      const records =
        await getRetailerProfiles();

      const ownedRecords =
        records
          .filter(
            record =>
              record.customerAccountId ===
                req.customerAccount.id
          )
          .sort(
            (a, b) =>
              Number(a.slot) -
              Number(b.slot)
          );

      
    return res.json({
  ok: true,

  allowance,

  profiles:
    ownedRecords.map(
      record =>
        safeRetailerProfile(
          record,
          allowance
        )
    ),

  specialProfiles: []
      
});

    } catch (error) {
      console.error(
        "Retailer profile list error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to load retailer profiles."
        });
    }
  }
);

app.put(
  "/api/account/retailer-profiles/:slot",
  requireCustomer,
  async (req, res) => {
    try {
      const slot =
        Number(
          req.params.slot
        );

      if (
        !Number.isInteger(slot) ||
        slot < 1 ||
        slot > 100
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid profile slot."
          });
      }

      const allowance =
        await getCustomerProfileAllowance(
          req.customerAccount.id
        );

      if (allowance <= 0) {
        return res
          .status(403)
          .json({
            error:
              "An active membership is required before retailer profiles can be saved."
          });
      }

      if (slot > allowance) {
        return res
          .status(403)
          .json({
            error:
              `Your current membership allows ${allowance} profile${allowance === 1 ? "" : "s"}.`
          });
      }

      const profileName =
        clean(
          req.body?.profileName,
          80
        );

      if (!profileName) {
        return res
          .status(400)
          .json({
            error:
              "Enter a profile name."
          });
      }

      const submitted =
        req.body?.retailers &&
        typeof req.body
          .retailers ===
          "object"
          ? req.body.retailers
          : {};

      const records =
        await getRetailerProfiles();

      const existingIndex =
        records.findIndex(
          record =>
            record.customerAccountId ===
              req.customerAccount.id &&
            Number(record.slot) ===
              slot
        );

      const existingRecord =
        existingIndex >= 0
          ? records[
              existingIndex
            ]
          : null;

      const selectedAddressId =
        clean(
          req.body?.shippingAddressId,
          150
        ) ||
        existingRecord
          ?.selectedAddressId ||
        null;

      const selectedPaymentId =
        clean(
          req.body?.paymentMethodId,
          150
        ) ||
        existingRecord
          ?.selectedPaymentId ||
        null;

      const selectedSavedDetails =
        await savedCheckoutSelection(
          req.customerAccount,
          selectedAddressId,
          selectedPaymentId
        );

      if (
        selectedAddressId &&
        !selectedSavedDetails.address
      ) {
        return res
          .status(400)
          .json({
            error:
              "The selected saved shipping address could not be found."
          });
      }

      if (
        selectedPaymentId &&
        !selectedSavedDetails.payment
      ) {
        return res
          .status(400)
          .json({
            error:
              "The selected saved payment card could not be found."
          });
      }

      let existingCustomerSecrets = {};

      try {
        if (
          existingRecord
            ?.customerSecrets
        ) {
          existingCustomerSecrets =
            decryptJson(
              existingRecord
                .customerSecrets
            ) || {};
        }
      } catch {
        existingCustomerSecrets = {};
      }

      const savedProfileBase =
        shippingProfileFromSavedAddress(
          selectedSavedDetails.address,
          req.customerAccount.email,
          existingRecord
            ?.customerProfile ||
          {}
        );

      const submittedCustomerProfile =
        req.body
          ?.customerProfile &&
        typeof req.body
          .customerProfile ===
          "object"
          ? req.body
              .customerProfile
          : {};

      const customerProfile =
        sanitizeProfile({
          ...savedProfileBase,
          ...submittedCustomerProfile,

          profileName,

          email:
            submittedCustomerProfile
              .email ||
            savedProfileBase.email ||
            req.customerAccount
              .email ||
            ""
        });

      const savedCardBase =
        paymentSecretsFromSavedPayment(
          selectedSavedDetails.payment,
          existingCustomerSecrets
        );

      const submittedCustomerCard =
        req.body
          ?.customerCard &&
        typeof req.body
          .customerCard ===
          "object"
          ? req.body
              .customerCard
          : {};

      const suppliedCardNumber =
        clean(
          submittedCustomerCard
            .acoCardNumber,
          30
        ).replace(
          /[^\d]/g,
          ""
        );

      const suppliedSecurityCode =
        clean(
          submittedCustomerCard
            .securityCode,
          300
        );

      const customerSecrets = {
        ...savedCardBase,

        cardLabel:
          clean(
            submittedCustomerCard
              .cardLabel,
            100
          ) ||
          savedCardBase
            .cardLabel ||
          "",

        cardholder:
          clean(
            submittedCustomerCard
              .cardholder,
            150
          ) ||
          savedCardBase
            .cardholder ||
          "",

        acoCardNumber:
          suppliedCardNumber ||
          savedCardBase
            .acoCardNumber ||
          existingCustomerSecrets
            .acoCardNumber ||
          "",

        expMonth:
          clean(
            submittedCustomerCard
              .expMonth,
            2
          ) ||
          savedCardBase
            .expMonth ||
          "",

        expYear:
          clean(
            submittedCustomerCard
              .expYear,
            4
          ) ||
          savedCardBase
            .expYear ||
          "",

        securityCode:
          suppliedSecurityCode ||
          savedCardBase
            .securityCode ||
          existingCustomerSecrets
            .securityCode ||
          ""
      };

      if (
        customerSecrets
          .acoCardNumber &&
        !/^\d{12,19}$/.test(
          customerSecrets
            .acoCardNumber
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Enter a valid card number for this profile."
          });
      }

      if (
        customerSecrets
          .expMonth &&
        !/^(0[1-9]|1[0-2])$/.test(
          customerSecrets
            .expMonth
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Enter a valid expiration month."
          });
      }

      if (
        customerSecrets
          .expYear &&
        !/^\d{4}$/.test(
          customerSecrets
            .expYear
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Enter a valid expiration year."
          });
      }

      let existingCredentials =
        emptyRetailerCredentials();

      if (
        existingRecord
          ?.credentials
      ) {
        try {
          existingCredentials =
            normalizeRetailerCredentials(
              decryptJson(
                existingRecord
                  .credentials
              )
            );
        } catch (error) {
          console.error(
            "Existing retailer profile decrypt error:",
            error.message
          );

          return res
            .status(500)
            .json({
              error:
                "Unable to update this retailer profile securely."
            });
        }
      }

      const updatedCredentials =
        emptyRetailerCredentials();

      for (
        const retailer of
        RETAILER_KEYS
      ) {
        const submittedRetailer =
          submitted[
            retailer
          ] &&
          typeof submitted[
            retailer
          ] === "object"
            ? submitted[
                retailer
              ]
            : {};

        const username =
          clean(
            submittedRetailer
              .username,
            254
          );

        const suppliedPassword =
          String(
            submittedRetailer
              .password ||
            ""
          );

        if (
          suppliedPassword.length >
          512
        ) {
          return res
            .status(400)
            .json({
              error:
                "A retailer password is too long."
            });
        }

        updatedCredentials[
          retailer
        ] = {
          username,

          /*
            An empty password means:
            keep the currently encrypted password.

            A non-empty password means:
            replace it with the new value.
          */

          password:
            suppliedPassword ||
            existingCredentials[
              retailer
            ].password ||
            ""
        };
      }

      updatedCredentials.pkc = {
        ...(
          updatedCredentials.pkc ||
          {}
        ),
        password: ""
      };

      if (
        !String(
          updatedCredentials
            .pkc
            ?.username ||
          ""
        ).trim()
      ) {
        const guestEmail =
          [
            "target",
            "walmart",
            "samsClub",
            "costco"
          ]
            .map(
              retailer =>
                String(
                  updatedCredentials
                    [retailer]
                    ?.username ||
                  ""
                ).trim()
            )
            .find(Boolean) ||
          String(
            customerProfile.email ||
            req.customerAccount.email ||
            ""
          ).trim();

        if (guestEmail) {
          updatedCredentials.pkc = {
            username:
              guestEmail,
            password:
              ""
          };
        }
      }

      const now =
        new Date()
          .toISOString();

      const readiness =
        managedProfileReadiness(
          customerProfile,
          customerSecrets
        );

      const previousActivationStatus =
        normalizeProfileActivationStatus(
          existingRecord
            ?.activationStatus,
          false
        );

      const activationStatus =
        previousActivationStatus === "activated" && readiness.ready
          ? "activated"
          : "awaiting_activation";

      const record = {
        id:
          existingRecord?.id ||
          crypto.randomUUID(),

        customerAccountId:
          req.customerAccount.id,

        slot,

        profileName,

        credentials:
          encryptJson(
            updatedCredentials
          ),

        customerProfile,

        customerSecrets:
          encryptJson(
            customerSecrets
          ),

        selectedAddressId,

        selectedPaymentId,

        activationStatus,

        activationRequestedAt:
          activationStatus ===
            "awaiting_activation"
            ? (
                existingRecord
                  ?.activationRequestedAt ||
                now
              )
            : null,

        activatedAt:
          activationStatus ===
            "activated"
            ? (
                existingRecord
                  ?.activatedAt ||
                now
              )
            : null,

        deactivatedAt:
          null,

        discordProfileMessageId:
          activationStatus ===
            "awaiting_activation"
            ? (
                existingRecord
                  ?.discordProfileMessageId ||
                null
              )
            : null,

        discordProfileMessageType:
          activationStatus ===
            "awaiting_activation"
            ? (
                existingRecord
                  ?.discordProfileMessageType ||
                null
              )
            : null,

        createdAt:
          existingRecord
            ?.createdAt ||
          now,

        updatedAt:
          now
      };

      if (
        existingIndex >= 0
      ) {
        records[
          existingIndex
        ] = record;
      } else {
        records.push(
          record
        );
      }

      await saveRetailerProfiles(
        records
      );

      if (
        record.activationStatus ===
        "awaiting_activation"
      ) {
        const discordChanged =
          await ensurePaidProfileDiscordAwaitingMessage(
            record
          );

        if (discordChanged) {
          const savedIndex =
            existingIndex >= 0
              ? existingIndex
              : records.length - 1;

          if (savedIndex >= 0) {
            records[
              savedIndex
            ] = record;
          }

          await saveRetailerProfiles(
            records
          );
        }
      }

      return res.json({
        ok: true,
        allowance,

        profile:
          safeRetailerProfile(
            record,
            allowance
          ),

        message:
          "Retailer profile saved securely."
      });

    } catch (error) {
      console.error(
        "Retailer profile save error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to save this retailer profile."
        });
    }
  }
);

app.put(
  "/api/account/special-profiles/:profileType",
  requireCustomer,
  async (req, res) => {
    try {
      const profileType =
        normalizeSpecialProfileType(
          req.params.profileType
        );

      if (!profileType) {
        return res
          .status(400)
          .json({
            error:
              "Invalid special profile type."
          });
      }

      const records =
        await getSpecialProfiles();

      const existingIndex =
        records.findIndex(
          record =>
            record.customerAccountId ===
              req.customerAccount.id &&
            normalizeSpecialProfileType(
              record.profileType
            ) === profileType
        );

      if (existingIndex < 0) {
        return res
          .status(404)
          .json({
            error:
              "Special profile could not be found."
          });
      }

      const existingRecord =
        records[
          existingIndex
        ];

      if (
        !specialProfileIsActive(
          existingRecord
        )
      ) {
        return res
          .status(403)
          .json({
            error:
              "This special profile is not currently active."
          });
      }

      const submitted =
        req.body?.retailers &&
        typeof req.body.retailers ===
          "object"
          ? req.body.retailers
          : {};

      let existingCredentials =
        emptyRetailerCredentials();

      if (
        existingRecord
          ?.credentials
      ) {
        try {
          existingCredentials =
            normalizeRetailerCredentials(
              decryptJson(
                existingRecord
                  .credentials
              )
            );
        } catch (error) {
          console.error(
            "Existing special profile decrypt error:",
            error.message
          );

          return res
            .status(500)
            .json({
              error:
                "Unable to update this special profile securely."
            });
        }
      }

      const updatedCredentials =
        emptyRetailerCredentials();

      for (
        const retailer of
        RETAILER_KEYS
      ) {
        const submittedRetailer =
          submitted[
            retailer
          ] &&
          typeof submitted[
            retailer
          ] === "object"
            ? submitted[
                retailer
              ]
            : {};

        const username =
          clean(
            submittedRetailer
              .username,
            254
          );

        const suppliedPassword =
          String(
            submittedRetailer
              .password ||
            ""
          );

        if (
          suppliedPassword.length >
          512
        ) {
          return res
            .status(400)
            .json({
              error:
                "A retailer password is too long."
            });
        }

        updatedCredentials[
          retailer
        ] = {
          username,

          password:
            suppliedPassword ||
            existingCredentials[
              retailer
            ].password ||
            ""
        };
      }

      updatedCredentials.pkc = {
        ...(
          updatedCredentials.pkc ||
          {}
        ),
        password: ""
      };

      const now =
        new Date()
          .toISOString();

      const record = {
        ...existingRecord,

        credentials:
          encryptJson(
            updatedCredentials
          ),

        updatedAt:
          now,

        customerUpdatedAt:
          now
      };

      records[
        existingIndex
      ] = record;

      await saveSpecialProfiles(
        records
      );

      return res.json({
        ok: true,

        message:
          `${specialProfileLabel(
            profileType
          )} saved securely.`,

        profile:
          safeSpecialProfile(
            record
          )
      });

    } catch (error) {
      console.error(
        "Customer special profile update error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to update this special profile."
        });
    }
  }
);
/* -------------------------------------------------------
   ADMIN LOGIN
------------------------------------------------------- */

app.post(
  "/api/admin/login",
  async (req, res) => {
    try {
      const password =
        String(
          req.body.password || ""
        );

      const code =
        String(
          req.body.code || ""
        )
          .replace(/\s/g, "");

      const ip =
        req.ip || "unknown";

      const now =
        Date.now();

      const windowMs =
        15 * 60 * 1000;

      const maxAttempts =
        8;

      let attempt =
        loginAttempts.get(ip);

      if (
        !attempt ||
        now > attempt.reset
      ) {
        attempt = {
          count: 0,
          reset:
            now + windowMs
        };
      }

      if (
        attempt.count >=
        maxAttempts
      ) {
        const retryAfter =
          Math.max(
            1,
            Math.ceil(
              (
                attempt.reset -
                now
              ) / 1000
            )
          );

        res.setHeader(
          "Retry-After",
          String(retryAfter)
        );

        return res
          .status(429)
          .json({
            error:
              "Too many login attempts. Please try again later."
          });
      }

      attempt.count += 1;

      loginAttempts.set(
        ip,
        attempt
      );

      const secret =
        process.env
          .ADMIN_2FA_SECRET || "";

      const passwordValid =
        process.env
          .ADMIN_PASSWORD &&
        safeEqual(
          password,
          process.env
            .ADMIN_PASSWORD
        );

      let codeValid = false;

      if (secret && code) {
        try {
          codeValid =
            authenticator.check(
              code,
              secret
            );
        } catch {
          codeValid = false;
        }
      }

      if (
        !passwordValid ||
        !codeValid
      ) {
        await appendSecurityAudit({
          event:
            "admin_login_failure",

          requestId:
            req.securityRequestId,

          method:
            req.method,

          path:
            req.path,

          status:
            401,

          ip:
            req.ip,

          userAgent:
            req.headers[
              "user-agent"
            ],

          detail:
            !passwordValid
              ? "invalid_password"
              : "invalid_mfa"
        });

        return res
          .status(401)
          .json({
            error:
              "Invalid password or authentication code."
          });
      }

      loginAttempts.delete(ip);

      const token =
        crypto
          .randomBytes(32)
          .toString("hex");

      const createdAt =
        Date.now();

      const absoluteExpires =
        createdAt +
        ADMIN_SESSION_MAX_AGE_MS;

      adminSessions.set(
        adminSessionKey(
          token
        ),
        {
          createdAt,

          absoluteExpires,

          idleExpires:
            Math.min(
              createdAt +
                ADMIN_SESSION_IDLE_MS,
              absoluteExpires
            ),

          userAgentHash:
            adminUserAgentHash(
              req
            )
        }
      );

      res.setHeader(
        "Set-Cookie",
        `sng_admin=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(
          ADMIN_SESSION_MAX_AGE_MS /
          1000
        )}; Priority=High${
          SECURE_COOKIES
            ? "; Secure"
            : ""
        }`
      );

      await appendSecurityAudit({
        event:
          "admin_login_success",

        requestId:
          req.securityRequestId,

        method:
          req.method,

        path:
          req.path,

        status:
          200,

        ip:
          req.ip,

        userAgent:
          req.headers[
            "user-agent"
          ]
      });

      return res.json({
        ok: true
      });

    } catch (error) {
      console.error(
        "Admin login error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to sign in."
        });
    }
  }
);

/* -------------------------------------------------------
   ADMIN LOGOUT
------------------------------------------------------- */

app.post(
  "/api/admin/logout",
  async (req, res) => {
    const token =
      parseCookies(req)
        .sng_admin;

    if (token) {
      adminSessions.delete(
        adminSessionKey(
          token
        )
      );
    }

    res.setHeader(
      "Set-Cookie",
      `sng_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Priority=High${
        SECURE_COOKIES
          ? "; Secure"
          : ""
      }`
    );

    await appendSecurityAudit({
      event:
        "admin_logout",

      requestId:
        req.securityRequestId,

      method:
        req.method,

      path:
        req.path,

      status:
        200,

      ip:
        req.ip,

      userAgent:
        req.headers[
          "user-agent"
        ]
    });

    return res.json({
      ok: true
    });
  }
);

/* -------------------------------------------------------
   ADMIN UPDATE SUBMISSION
------------------------------------------------------- */

app.post(
  "/api/admin/customer-accounts/:id/success-history",
  requireAdmin,
  async (req, res) => {
    try {
      if (typeof req.body?.fullHistory !== "boolean") {
        return res.status(400).json({ error: "Choose whether to scan complete mailbox history." });
      }
      const accounts = await getCustomerAccounts();
      const account = accounts.find(item => String(item.id) === String(req.params.id));
      if (!account) return res.status(404).json({ error: "Customer account was not found." });
      account.successFullHistory = req.body.fullHistory;
      account.updatedAt = new Date().toISOString();
      await saveCustomerAccounts(accounts);
      liveSuccessLastSyncByAccount.delete(String(account.id));
      for (const key of liveSuccessMailboxScanSince.keys()) {
        if (key.startsWith(`${account.id}:`)) liveSuccessMailboxScanSince.delete(key);
      }
      return res.json({ ok: true, fullHistory: account.successFullHistory });
    } catch (error) {
      console.error("Admin Success history setting failed:", error?.code || error?.name || "setting_error");
      return res.status(500).json({ error: "Could not update mailbox history setting." });
    }
  }
);

/* -------------------------------------------------------
   ADMIN MEMBERSHIP GRANTS / DISCOUNT CODES
------------------------------------------------------- */

app.get("/api/admin/gifted-memberships", requireAdmin, async (req, res) => {
  const records = await getGiftedMemberships();
  return res.json({ memberships: records });
});

app.get("/api/admin/giftable-customers", requireAdmin, async (req, res) => {
  const customers = await getCustomerAccounts();
  return res.json({ customers: customers.map(item => ({ id: item.id, email: item.email })).filter(item => item.id && item.email) });
});

app.post("/api/admin/gifted-memberships", requireAdmin, async (req, res) => {
  try {
    const customerAccountId = String(req.body?.customerAccountId || "").trim();
    const tier = Number(req.body?.tier);
    const months = Number(req.body?.months);
    if (!customerAccountId || !PLANS[tier] || !Number.isInteger(months) || months < 1 || months > 12) {
      return res.status(400).json({ error: "Choose a customer, valid tier, and a duration from 1 to 12 months." });
    }
    const customers = await getCustomerAccounts();
    const customer = customers.find(item => String(item.id) === customerAccountId);
    if (!customer) return res.status(404).json({ error: "Customer account was not found." });

    const paid = await readJson(PAID_FILE, []);
    const activePaid = (Array.isArray(paid) ? paid : [])
      .filter(item => String(item.customerAccountId) === customerAccountId && subscriptionAllowsProfiles(item));
    const paidEnd = activePaid
      .map(item => subscriptionEndIso(item))
      .filter(Boolean)
      .map(value => new Date(value).getTime())
      .filter(Number.isFinite)
      .reduce((max, value) => Math.max(max, value), Date.now());
    const records = await getGiftedMemberships();
    const priorGiftEnd = records
      .filter(item => String(item.customerAccountId) === customerAccountId)
      .map(item => new Date(item.expiresAt).getTime())
      .filter(Number.isFinite)
      .reduce((max, value) => Math.max(max, value), Date.now());
    const startDate = new Date(Math.max(Date.now(), paidEnd, priorGiftEnd));
    const startsAt = startDate.toISOString();
    const endDate = new Date(startDate);
    endDate.setUTCMonth(endDate.getUTCMonth() + months);
    const expiresAt = endDate.toISOString();
    const grant = {
      id: crypto.randomUUID(),
      customerAccountId,
      customerEmail: customer.email || "",
      tier,
      tierName: PLANS[tier].name,
      profiles: PLANS[tier].profiles,
      months,
      startsAt,
      expiresAt,
      createdAt: new Date().toISOString(),
      createdBy: "admin"
    };
    records.push(grant);
    await saveGiftedMemberships(records);
    return res.status(201).json({ ok: true, membership: grant });
  } catch (error) {
    console.error("Gifted membership creation failed:", error);
    return res.status(500).json({ error: "Unable to create gifted membership." });
  }
});

app.delete("/api/admin/gifted-memberships/:id", requireAdmin, async (req, res) => {
  const records = await getGiftedMemberships();
  const next = records.filter(item => String(item.id) !== String(req.params.id));
  if (next.length === records.length) return res.status(404).json({ error: "Gifted membership was not found." });
  await saveGiftedMemberships(next);
  return res.json({ ok: true });
});

app.get("/api/admin/discount-codes", requireAdmin, async (req, res) => {
  return res.json({ codes: await getDiscountCodes() });
});

app.get("/api/public/membership-discounts", async (req, res) => {
  const records = await getDiscountCodes();
  const discounts = {};
  for (const tier of Object.keys(PLANS)) {
    const sale = activeSitewideDiscount(records, tier);
    if (sale) discounts[tier] = { percent: sale.percent, duration: sale.duration };
  }
  res.set("Cache-Control", "no-store");
  return res.json({ discounts });
});

app.put("/api/admin/customers/:id/og-status", requireAdmin, async (req, res) => {
  try {
    const accounts = await getCustomerAccounts();
    const account = accounts.find(item => String(item.id) === String(req.params.id));
    if (!account) return res.status(404).json({ error: "Customer account not found." });
    const paid = await readJson(PAID_FILE, []);
    const customerPaid = (Array.isArray(paid) ? paid : []).filter(item =>
      String(item.customerAccountId || "") === String(account.id) && item.paidAt);
    if (!customerPaid.length) return res.status(400).json({ error: "OG status can only be granted to paid customers." });
    account.ogMemberGrantedAt ||= new Date().toISOString();
    account.updatedAt = new Date().toISOString();
    await saveCustomerAccounts(accounts);
    return res.json({ ok: true, ogMember: true });
  } catch (error) {
    console.error("Admin OG grant:", error);
    return res.status(500).json({ error: "Unable to grant OG status." });
  }
});

async function saveAdminDiscount(req, res, existingId = null) {
  try {
    const code = String(req.body?.code || "").trim().toUpperCase();
    const percent = Number(req.body?.percent);
    const tier = req.body?.tier === "all" || req.body?.tier === "" || req.body?.tier == null ? "all" : Number(req.body.tier);
    const appliesToRentals = req.body?.appliesToRentals === true;
    const duration = req.body?.duration === "forever" ? "forever" : "once";
    const sitewide = req.body?.sitewide === true;
    const recipientEmail = String(req.body?.recipientEmail || "").trim().toLowerCase();
    if ((sitewide && recipientEmail) || (recipientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail))) {
      return res.status(400).json({ error: "Choose a sitewide sale or enter a valid recipient email for a private code." });
    }
    const expiration = req.body?.expiresAt ? new Date(req.body.expiresAt) : null;
    if (!/^[A-Z0-9]{3,40}$/.test(code) || !Number.isInteger(percent) || percent < 1 || percent > 100 ||
        (tier !== "all" && !PLANS[tier]) || (expiration && (!Number.isFinite(expiration.getTime()) || expiration.getTime() <= Date.now()))) {
      return res.status(400).json({ error: "Provide a valid code, discount percentage, tier and future expiration." });
    }
    if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: "Stripe is not configured." });
    const records = await getDiscountCodes();
    const existing = existingId ? records.find(item => item.id === existingId) : null;
    if (existingId && !existing) return res.status(404).json({ error: "Discount code was not found." });
    if (records.some(item => item.code === code && item.id !== existingId)) return res.status(409).json({ error: "That discount code already exists." });
    const priceIds = [
      ...(tier === "all" ? Object.values(PLANS).map(plan => plan.priceId) : [PLANS[tier].priceId]),
      ...(appliesToRentals ? Object.values(RENTAL_PACKAGES).flatMap(packages => Object.values(packages).map(pack => pack.priceId)) : [])
    ].filter(Boolean);
    if (!priceIds.length) return res.status(400).json({ error: "No Stripe prices are configured for this selection." });
    const prices = await Promise.all([...new Set(priceIds)].map(id => stripe.prices.retrieve(id)));
    const productIds = [...new Set(prices.map(price => typeof price.product === "string" ? price.product : price.product?.id).filter(Boolean))];
    const coupon = await stripe.coupons.create({
      percent_off: percent,
      duration,
      applies_to: { products: productIds },
      name: `SLABSNGRABSACO ${code}`
    });
    let promotion;
    let oldPromotionDisabled = false;
    try {
      if (existing?.stripePromotionCodeId) {
        await stripe.promotionCodes.update(existing.stripePromotionCodeId, { active: false });
        oldPromotionDisabled = true;
      }
      // Private codes are redeemed only through the authenticated endpoint.
      promotion = recipientEmail ? null : await stripe.promotionCodes.create({
        coupon: coupon.id, code, active: existing ? existing.active : true,
        ...(expiration ? { expires_at: Math.floor(expiration.getTime() / 1000) } : {})
      });
    } catch (error) {
      await stripe.coupons.del(coupon.id).catch(() => {});
      if (oldPromotionDisabled && existing.active) {
        try { await stripe.promotionCodes.update(existing.stripePromotionCodeId, { active: true }); }
        catch {
          existing.active = false;
          await saveDiscountCodes(records);
        }
      }
      throw error;
    }
    const discount = {
      id: existing?.id || crypto.randomUUID(), code, percent, tier, appliesToRentals, duration,
      expiresAt: expiration?.toISOString() || null,
      active: existing ? existing.active : true, sitewide, recipientEmail: recipientEmail || null,
      stripeCouponId: coupon.id, stripePromotionCodeId: promotion?.id || null,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    if (existing) records[records.indexOf(existing)] = discount;
    else records.push(discount);
    try { await saveDiscountCodes(records); }
    catch (error) {
      if (promotion?.id) await stripe.promotionCodes.update(promotion.id, { active: false }).catch(() => {});
      await stripe.coupons.del(coupon.id).catch(() => {});
      if (existing?.active && existing.stripePromotionCodeId) {
        await stripe.promotionCodes.update(existing.stripePromotionCodeId, { active: true }).catch(() => {});
      }
      throw error;
    }
    if (existing?.stripeCouponId) {
      // Retire the old coupon for new checkouts; existing discounts stay intact.
      await stripe.coupons.del(existing.stripeCouponId).catch(error =>
        console.error("Old discount coupon cleanup failed:", error?.type || "Stripe error"));
    }
    return res.status(existing ? 200 : 201).json({ ok: true, discount });
  } catch (error) {
    console.error("Discount code creation failed:", error?.message);
    return res.status(502).json({ error: error?.statusCode === 403
      ? "Stripe permission denied. Enable Coupons Write and Promotion codes Write on the website's restricted API key."
      : "Could not save this discount in Stripe. The previous code was kept if this was an edit." });
  }
}

// Serialize discount mutations to prevent concurrent edits overwriting one another.
let discountMutationQueue = Promise.resolve();
function queueDiscountMutation(handler) {
  return (req, res, next) => {
    const task = discountMutationQueue.then(() => handler(req, res));
    discountMutationQueue = task.catch(() => {});
    task.catch(next);
  };
}
app.post("/api/admin/discount-codes", requireAdmin, queueDiscountMutation((req, res) => saveAdminDiscount(req, res)));
app.put("/api/admin/discount-codes/:id", requireAdmin, queueDiscountMutation((req, res) => saveAdminDiscount(req, res, req.params.id)));

app.delete("/api/admin/discount-codes/:id", requireAdmin, queueDiscountMutation(async (req, res) => {
  const records = await getDiscountCodes();
  const item = records.find(record => record.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Discount code was not found." });
  try {
    if (item.stripePromotionCodeId) await stripe.promotionCodes.update(item.stripePromotionCodeId, { active: false });
    if (item.stripeCouponId) {
      try { await stripe.coupons.del(item.stripeCouponId); }
      catch (error) { if (error?.code !== "resource_missing") throw error; }
    }
    await saveDiscountCodes(records.filter(record => record.id !== item.id));
    return res.json({ ok: true });
  } catch (error) {
    // Reflect a successfully disabled promotion even if coupon deletion failed.
    if (item.stripePromotionCodeId) {
      const promotion = await stripe.promotionCodes.retrieve(item.stripePromotionCodeId).catch(() => null);
      if (promotion?.active === false) { item.active = false; await saveDiscountCodes(records); }
    }
    return res.status(502).json({ error: "Could not delete this discount in Stripe. Check Coupons Write and Promotion codes Write permissions, then retry." });
  }
}));

app.patch("/api/admin/discount-codes/:id", requireAdmin, queueDiscountMutation(async (req, res) => {
  const records = await getDiscountCodes();
  const item = records.find(record => String(record.id) === String(req.params.id));
  if (!item) return res.status(404).json({ error: "Discount code was not found." });
  if (typeof req.body?.active !== "boolean") return res.status(400).json({ error: "Choose active or inactive." });
  try {
    if (item.stripePromotionCodeId) await stripe.promotionCodes.update(item.stripePromotionCodeId, { active: req.body.active });
  } catch (error) {
    console.error("Stripe promotion code update failed:", error?.message);
    return res.status(502).json({ error: "Could not update this promotion code in Stripe." });
  }
  item.active = req.body.active;
  await saveDiscountCodes(records);
  return res.json({ ok: true, discount: item });
}));

/* One prominent announcement at a time, visible throughout the public site. */
async function getSiteNotification() {
  const record = await readJson(SITE_NOTIFICATION_FILE, null);
  return record && typeof record === "object" && !Array.isArray(record) ? record : null;
}

const siteNotificationListeners = new Set();
app.get("/api/public/notification/events", (req, res) => {
  openSuccessEventStream(req, res, siteNotificationListeners);
});
function announceSiteNotificationChanged() {
  for (const listener of siteNotificationListeners) {
    listener.write("event: notification\ndata: {}\n\n");
  }
}

app.get("/api/public/notification", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const record = await getSiteNotification();
    const account = record?.active === true ? await getAuthenticatedCustomer(req) : null;
    const dismissed = account && Array.isArray(account.dismissedSiteNotifications)
      ? account.dismissedSiteNotifications.includes(record.id)
      : false;
    return res.json({ notification: record?.active === true
      ? { id: record.id, title: record.title, message: record.message, createdAt: record.createdAt }
      : null, dismissed });
  } catch (error) {
    console.error("Public notification read failed:", error?.message);
    return res.status(503).json({ error: "Notification unavailable." });
  }
});

app.get("/api/admin/site-notification", requireAdmin, async (_req, res) => {
  return res.json({ notification: await getSiteNotification() });
});

app.post("/api/admin/site-notification", requireAdmin, async (req, res) => {
  const title = clean(req.body?.title, 80);
  const message = clean(req.body?.message, 400);
  if (!title || !message) {
    return res.status(400).json({ error: "Add a title and notification message." });
  }
  try {
    const notification = {
      id: crypto.randomUUID(), title, message,
      active: true, createdAt: new Date().toISOString()
    };
    await writeJson(SITE_NOTIFICATION_FILE, notification);
    announceSiteNotificationChanged();
    return res.status(201).json({ ok: true, notification });
  } catch (error) {
    console.error("Publish notification failed:", error?.message);
    return res.status(500).json({ error: "Could not publish the notification." });
  }
});

app.post("/api/admin/site-notification/:id/retract", requireAdmin, async (req, res) => {
  try {
    const record = await getSiteNotification();
    if (!record || record.id !== req.params.id || record.active !== true) {
      return res.status(404).json({ error: "This notification is no longer active." });
    }
    const notification = { ...record, active: false, retractedAt: new Date().toISOString() };
    await writeJson(SITE_NOTIFICATION_FILE, notification);
    announceSiteNotificationChanged();
    return res.json({ ok: true, notification });
  } catch (error) {
    console.error("Retract notification failed:", error?.message);
    return res.status(500).json({ error: "Could not retract the notification." });
  }
});

app.post("/api/account/site-notification/:id/dismiss", requireCustomer, async (req, res) => {
  try {
    const notification = await getSiteNotification();
    if (!notification || notification.active !== true || notification.id !== req.params.id) {
      return res.status(404).json({ error: "Notification is no longer active." });
    }
    const accounts = await getCustomerAccounts();
    const account = accounts.find(item => String(item.id) === String(req.customerAccount.id));
    if (!account) return res.status(401).json({ error: "Please sign in again." });
    const dismissed = Array.isArray(account.dismissedSiteNotifications) ? account.dismissedSiteNotifications : [];
    account.dismissedSiteNotifications = [...new Set([...dismissed, notification.id])].slice(-50);
    await saveCustomerAccounts(accounts);
    return res.json({ ok: true });
  } catch (error) {
    console.error("Dismiss notification failed:", error?.message);
    return res.status(500).json({ error: "Could not save notification dismissal." });
  }
});

app.get(
  "/api/admin/submissions",
  requireAdmin,
  async (req, res) => {
    try {
      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const records =
        Array.isArray(paid)
          ? paid
          : [];

      const result = [];
      const customerAccounts = await getCustomerAccounts();
      const customerAccountMap = new Map(customerAccounts.map(account => [String(account.id), account]));

      let paidChanged =
        false;

      // Repair older guest checkouts only when the purchase email belongs
      // to a verified website account. Never overwrite an existing owner.
      const verifiedAccountsByEmail = new Map(
        customerAccounts
          .filter(account => account.emailVerifiedAt && account.disabled !== true)
          .map(account => [normalizeEmail(account.email), account])
      );
      for (const record of records) {
        if (record.customerAccountId) continue;
        const account = verifiedAccountsByEmail.get(normalizeEmail(record?.profile?.email));
        if (!account) continue;
        record.customerAccountId = account.id;
        record.customerLinkedAt = new Date().toISOString();
        record.customerLinkedBy = "verified-email";
        paidChanged = true;
      }

      const [
        freeAssignmentsForAdmin,
        rentalAssignmentsForAdmin
      ] = await Promise.all([
        getFreeAssignments(),
        getRentalAssignments()
      ]);

      for (
        const record of records
      ) {

        /*
          Refresh Stripe subscription information
          before returning the admin dashboard.

          This keeps:
          - active / inactive status
          - current period start
          - current period end
          - cancel state
          - upgraded plan
          synchronized with Stripe.
        */

      if (
  !record.stripeSubscriptionId &&
  record.stripeSessionId
) {

  try {

    const checkoutSession =
      await stripe.checkout.sessions.retrieve(
        record.stripeSessionId
      );

    if (checkoutSession.subscription) {

      record.stripeSubscriptionId =
        typeof checkoutSession.subscription === "string"
          ? checkoutSession.subscription
          : checkoutSession.subscription.id;

      paidChanged = true;
    }

  } catch (error) {

    console.error(
      "Admin subscription ID recovery failed:",
      record.id,
      error.message
    );

  }
}


if (
  record.stripeSubscriptionId
) {


  try {

    const subscription =
      await stripe
        .subscriptions
        .retrieve(
          record.stripeSubscriptionId
        );

    await applySubscriptionInfo(
      record,
      subscription
    );

    record.subscriptionUpdatedAt =
      new Date().toISOString();

    paidChanged = true;

  } catch (error) {

    console.error(
      "Admin subscription refresh failed:",
      record.id,
      error.message
    );

  }
}
        let secrets =
  null;
        try {
          const encrypted =
            await readJson(
              path.join(
                SECRET_DIR,
                `${record.id}.encrypted.json`
              ),
              null
            );

          if (encrypted) {
            secrets =
              decryptJson(
                encrypted
              );
          }

        } catch (error) {
          console.error(
            "Admin secure package decrypt error:",
            record.id,
            error.message
          );
        }


        const linkedAssignmentsForCustomer =
          record.customerAccountId
            ? [
                ...freeAssignmentsForAdmin.filter(
                  assignment =>
                    String(
                      assignment.customerAccountId ||
                      ""
                    ) ===
                      String(
                        record.customerAccountId
                      ) &&
                    managedAssignmentIsLinked(
                      assignment
                    )
                ),

                ...rentalAssignmentsForAdmin.filter(
                  assignment =>
                    String(
                      assignment.customerAccountId ||
                      ""
                    ) ===
                      String(
                        record.customerAccountId
                      ) &&
                    managedAssignmentIsLinked(
                      assignment
                    )
                )
              ]
            : [];

        const linkedProfileCount =
          linkedAssignmentsForCustomer
            .length;

        const linkedActiveProfileCount =
          linkedAssignmentsForCustomer
            .filter(
              assignment =>
                managedAssignmentStatus(
                  assignment
                ) ===
                  "activated"
            )
            .length;

        /*
          Main customer-card "inactive" count intentionally includes
          both Awaiting Activation and Inactive profiles. The detailed
          managed profile row still distinguishes those two statuses.
        */
        const linkedInactiveProfileCount =
          Math.max(
            0,
            linkedProfileCount -
              linkedActiveProfileCount
          );

        const paidProfileCount =
          Math.max(
            0,
            Number(
              record.plan?.profiles ||
              0
            ) || 0
          );

        const customerPaidRecords =
          record.customerAccountId
            ? records.filter(
                item =>
                  String(
                    item.customerAccountId ||
                    ""
                  ) ===
                  String(
                    record.customerAccountId
                  )
              )
            : [record];

        const ogMember =
          customerAccountMap.get(String(record.customerAccountId))?.ogMemberGrantedAt
          ? true : customerHasOgMemberStatus(
            customerPaidRecords
          );

        if (
          ogMember &&
          record.ogMember !== true
        ) {
          record.ogMember =
            true;

          paidChanged =
            true;
        }

        result.push({
          ...record,

          successFullHistory:
            customerAccountMap.get(String(record.customerAccountId))?.successFullHistory === true,

          ogMember,

          linkedProfileCount,

          linkedActiveProfileCount,

          linkedInactiveProfileCount,

          totalProfileCount:
            paidProfileCount +
            linkedProfileCount,

          secrets:
            effectiveAdminImap(secrets, savedImapEntries(customerAccountMap.get(String(record.customerAccountId)))) || null
        });
      }


      if (
        paidChanged
      ) {
        await writeJson(
          PAID_FILE,
          records
        );
      }


      return res.json(
        result
      );

    } catch (error) {
      console.error(
        "Admin submissions error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to load submissions."
        });
    }
  }
);

app.get(
  "/api/admin/free-submissions",
  requireAdmin,
  async (req, res) => {
    try {
      const accounts =
        await getCustomerAccounts();

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const paidRecords =
        Array.isArray(paid)
          ? paid
          : [];

      const linkedAccountIds =
        new Set(
          paidRecords
            .map(
              record =>
                record.customerAccountId
            )
            .filter(Boolean)
        );

      const paidEmails =
        new Set(
          paidRecords
            .map(
              record =>
                normalizeEmail(
                  record.profile?.email
                )
            )
            .filter(Boolean)
        );

      const freeSubmissions =
        accounts
          .filter(account => {
            const accountEmail =
              normalizeEmail(
                account.email
              );

            return (
              !linkedAccountIds.has(
                account.id
              ) &&
              !paidEmails.has(
                accountEmail
              )
            );
          })
        .map(account => {
  let secrets = null;

  if (account.adminSecrets) {
    try {
      secrets =
        decryptJson(
          account.adminSecrets
        );
    } catch (error) {
      console.error(
        "Free account secure data decrypt error:",
        account.id,
        error.message
      );
    }
  }

  const savedProfile =
    account.adminProfile &&
    typeof account.adminProfile ===
      "object"
      ? account.adminProfile
      : {};

  return {
    id:
      account.id,

    customerAccountId:
      account.id,

    submissionType:
      "free",

    accountOnly:
      true,

    profile: {
      profileName:
        savedProfile.profileName ||
        "",

      email:
        savedProfile.email ||
        account.email ||
        "",

      firstName:
        savedProfile.firstName ||
        "",

      lastName:
        savedProfile.lastName ||
        "",

      phone:
        savedProfile.phone ||
        "",

      address:
        savedProfile.address ||
        "",

      address2:
        savedProfile.address2 ||
        "",

      country:
        savedProfile.country ||
        "",

      city:
        savedProfile.city ||
        "",

      state:
        savedProfile.state ||
        "",

      zip:
        savedProfile.zip ||
        ""
    },

    plan: {
      name:
        "No Paid Membership",

      amount:
        null,

      profiles:
        0
    },

    secrets:
      effectiveAdminImap(secrets, savedImapEntries(account)) || null,

    subscriptionStatus:
      "none",

    currentPeriodStart:
      null,

    currentPeriodEnd:
      null,

    paidAt:
      null,

    createdAt:
      account.createdAt ||
      null,

    accountCreatedAt:
      account.createdAt ||
      null,

    emailVerifiedAt:
      account.emailVerifiedAt ||
      null,

    disabled:
      account.disabled ===
      true
  };
});

      return res.json(
        freeSubmissions
      );

    } catch (error) {
      console.error(
        "Admin free submissions error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to load free submissions."
        });
    }
  }
);

app.get(
  "/api/admin/special-profiles/:profileType",
  requireAdmin,
  async (req, res) => {
    try {
      const profileType =
        normalizeSpecialProfileType(
          req.params.profileType
        );

      if (!profileType) {
        return res
          .status(400)
          .json({
            error:
              "Invalid special profile type."
          });
      }

      const accounts =
        await getCustomerAccounts();

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const paidRecords =
        Array.isArray(paid)
          ? paid
          : [];

      const specialRecords =
        await getSpecialProfiles();

      const matchingProfiles =
        specialRecords.filter(
          record =>
            normalizeSpecialProfileType(
              record.profileType
            ) === profileType
        );

      const profiles =
        matchingProfiles.map(
          record => {
            const account =
              accounts.find(
                item =>
                  item.id ===
                  record.customerAccountId
              );

            const paidRecord =
              paidRecords.find(
                item =>
                  item.customerAccountId ===
                  record.customerAccountId
              );

            const savedProfile =
              account?.adminProfile &&
              typeof account.adminProfile ===
                "object"
                ? account.adminProfile
                : {};

            const paidProfile =
              paidRecord?.profile &&
              typeof paidRecord.profile ===
                "object"
                ? paidRecord.profile
                : {};

            const firstName =
              savedProfile.firstName ||
              paidProfile.firstName ||
              "";

            const lastName =
              savedProfile.lastName ||
              paidProfile.lastName ||
              "";

            const customerName =
              [
                firstName,
                lastName
              ]
                .filter(Boolean)
                .join(" ") ||
              savedProfile.profileName ||
              paidProfile.profileName ||
              "Customer";

            return {
              ...adminSpecialProfile(
                record
              ),

              customer: {
                id:
                  record.customerAccountId,

                name:
                  customerName,

                email:
                  account?.email ||
                  savedProfile.email ||
                  paidProfile.email ||
                  ""
              }
            };
          }
        );

      const customers =
        accounts.map(
          account => {
            const paidRecord =
              paidRecords.find(
                item =>
                  item.customerAccountId ===
                  account.id
              );

            const savedProfile =
              account.adminProfile &&
              typeof account.adminProfile ===
                "object"
                ? account.adminProfile
                : {};

            const paidProfile =
              paidRecord?.profile &&
              typeof paidRecord.profile ===
                "object"
                ? paidRecord.profile
                : {};

            const firstName =
              savedProfile.firstName ||
              paidProfile.firstName ||
              "";

            const lastName =
              savedProfile.lastName ||
              paidProfile.lastName ||
              "";

            const customerName =
              [
                firstName,
                lastName
              ]
                .filter(Boolean)
                .join(" ") ||
              savedProfile.profileName ||
              paidProfile.profileName ||
              "Customer";

            const hasProfile =
              matchingProfiles.some(
                record =>
                  record.customerAccountId ===
                  account.id
              );

            return {
              id:
                account.id,

              name:
                customerName,

              email:
                account.email ||
                savedProfile.email ||
                paidProfile.email ||
                "",

              hasProfile,

              paid:
                Boolean(
                  paidRecord
                )
            };
          }
        );

      return res.json({
        ok: true,
        profileType,
        profiles,
        customers
      });

    } catch (error) {
      console.error(
        "Admin special profile list error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to load special profiles."
        });
    }
  }
);

async function migrateFreeAccountsToManagedPoolOnce() {
  const deletedLogins = await deletedManagedLogins();
  const managedAccounts =
    await getManagedAccounts();

  const freeMemberships =
    await getFreeMemberships();

  const existingKeys =
    new Set();

  for (const account of managedAccounts) {
    try {
      const credentials =
        account.credentials
          ? decryptJson(
              account.credentials
            )
          : null;

      for (const retailer of RETAILER_KEYS) {
        const username =
          String(
            credentials?.[retailer]?.username ||
            ""
          )
            .trim()
            .toLowerCase();

        if (username) {
          existingKeys.add(
            `${retailer}:${username}`
          );
        }
      }
    } catch {
      // Ignore unreadable records
      // during duplicate checking.
    }
  }

  const now =
    new Date().toISOString();

  let added = 0;

  for (const membership of freeMemberships) {
    if (!membership.credentials) {
      continue;
    }

    let credentials;

    try {
      credentials =
        normalizeRetailerCredentials(
          decryptJson(
            membership.credentials
          )
        );
    } catch {
      continue;
    }

    const hasAnyRetailer =
      RETAILER_KEYS.some(
        retailer =>
          credentials[retailer]
            ?.username
      );

    if (!hasAnyRetailer) {
      continue;
    }

    if (RETAILER_KEYS.some(retailer => credentials[retailer]?.username &&
      deletedLogins.has(managedLoginFingerprint(retailer, credentials[retailer].username)))) {
      continue;
    }

    const alreadyExists =
      RETAILER_KEYS.some(
        retailer => {
          const username =
            String(
              credentials[retailer]
                ?.username ||
              ""
            )
              .trim()
              .toLowerCase();

          return (
            username &&
            existingKeys.has(
              `${retailer}:${username}`
            )
          );
        }
      );

    if (alreadyExists) {
      continue;
    }

    managedAccounts.push({
      id:
        membership.id ||
        crypto.randomUUID(),

      profileName:
        membership.profileName ||
        "MANAGED ACCOUNT",

      accountEmail:
        membership.accountEmail ||
        "",

      notes:
        membership.notes ||
        "",

      credentials:
        encryptJson(
          credentials
        ),

      source:
        "free-membership-migration",

      createdAt:
        membership.createdAt ||
        now,

      updatedAt:
        now
    });

    for (const retailer of RETAILER_KEYS) {
      const username =
        String(
          credentials[retailer]
            ?.username ||
          ""
        )
          .trim()
          .toLowerCase();

      if (username) {
        existingKeys.add(
          `${retailer}:${username}`
        );
      }
    }

    added += 1;
  }

  if (added > 0) {
    await saveManagedAccounts(
      managedAccounts
    );
  }

  console.log(
    `Managed pool migration: ${added} account(s) added.`
  );
}

async function getManagedAvailability() {
  const [
    managedAccounts,
    freeAssignments,
    rentalAssignments
  ] = await Promise.all([
    getManagedAccounts(),
    getFreeAssignments(),
    getRentalAssignments()
  ]);

  const restoreHolds =
    await getRestoreHolds();

  const inUseAccountIds =
    heldManagedAccountIdsFromHolds(
      restoreHolds
    );

  for (const assignment of freeAssignments) {
    if (
      !managedAssignmentIsLinked(
        assignment
      )
    ) {
      continue;
    }

    const managedId =
      assignment.managedAccountId ||
      assignment.freeMembershipId ||
      "";

    if (managedId) {
      inUseAccountIds.add(
        String(managedId)
      );
    }
  }

  for (const assignment of rentalAssignments) {
    if (
      !managedAssignmentIsLinked(
        assignment
      )
    ) {
      continue;
    }

    const managedId =
      assignment.managedAccountId ||
      assignment.rentedMembershipId ||
      "";

    if (managedId) {
      inUseAccountIds.add(
        String(managedId)
      );
    }
  }

  const duplicateState =
    managedDuplicateCredentialState(
      managedAccounts,
      inUseAccountIds
    );

  const availability = {
    target: {
      total: 0,
      available: 0,
      inUse: 0,
      duplicates: 0
    },

    walmart: {
      total: 0,
      available: 0,
      inUse: 0,
      duplicates: 0
    },

    pokemoncenter: {
      total: 0,
      available: 0,
      inUse: 0,
      duplicates: 0
    }
  };

  for (const account of managedAccounts) {
    let credentials;

    try {
      credentials =
        account.credentials
          ? normalizeRetailerCredentials(
              decryptJson(
                account.credentials
              )
            )
          : emptyRetailerCredentials();
    } catch {
      continue;
    }

    const accountInUse =
      inUseAccountIds.has(
        String(account.id)
      );

    for (const retailer of [
      "target",
      "walmart",
      "pokemoncenter"
    ]) {
      const username =
        String(
          credentials?.[retailer]
            ?.username ||
          ""
        ).trim();

      if (!username) {
        continue;
      }

      if (
        duplicateState
          .duplicateIds
          .has(
            String(
              account.id
            )
          )
      ) {
        availability[
          retailer
        ].duplicates += 1;

        continue;
      }

      availability[
        retailer
      ].total += 1;

      if (accountInUse) {
        availability[
          retailer
        ].inUse += 1;
      } else {
        availability[
          retailer
        ].available += 1;
      }
    }
  }

  return availability;
}


async function getAvailableManagedAccountsForRetailer(
  retailer,
  {
    restoreCustomerAccountId = "",
    restoreType = ""
  } = {}
) {
  const normalizedRetailer =
    normalizeManagedPoolRetailer(
      retailer
    );

  if (!normalizedRetailer) {
    return [];
  }

  const [
    managedAccounts,
    freeAssignments,
    rentalAssignments
  ] = await Promise.all([
    getManagedAccounts(),
    getFreeAssignments(),
    getRentalAssignments()
  ]);

  const restoreHolds =
    await getRestoreHolds();

  const inUseAccountIds =
    new Set();

  for (
    const assignment of
    freeAssignments
  ) {
    if (
      !managedAssignmentIsLinked(
        assignment
      )
    ) {
      continue;
    }

    const id =
      assignment.managedAccountId ||
      assignment.freeMembershipId ||
      "";

    if (id) {
      inUseAccountIds.add(
        String(id)
      );
    }
  }

  for (
    const assignment of
    rentalAssignments
  ) {
    if (
      !managedAssignmentIsLinked(
        assignment
      )
    ) {
      continue;
    }

    const id =
      assignment.managedAccountId ||
      assignment.rentedMembershipId ||
      "";

    if (id) {
      inUseAccountIds.add(
        String(id)
      );
    }
  }

  const duplicateState =
    managedDuplicateCredentialState(
      managedAccounts,
      inUseAccountIds
    );

  const heldIds =
    heldManagedAccountIdsFromHolds(
      restoreHolds
    );

  const restoreCandidateIds =
    new Set();

  if (
    restoreCustomerAccountId &&
    [
      "free",
      "rented"
    ].includes(
      restoreType
    )
  ) {
    for (
      const hold of
      activeRestoreHoldsFor(
        restoreHolds,
        {
          customerAccountId:
            restoreCustomerAccountId,

          type:
            restoreType
        }
      )
    ) {
      for (
        const item of
        restoreHoldRemainingItems(
          hold
        )
      ) {
        if (
          item.retailer &&
          String(
            item.retailer
          ) !==
            String(
              normalizedRetailer
            )
        ) {
          continue;
        }

        restoreCandidateIds.add(
          String(
            item.managedAccountId
          )
        );
      }
    }
  }

  const available = [];

  for (
    const account of
    managedAccounts
  ) {
    const accountId =
      String(
        account.id
      );

    if (
      inUseAccountIds.has(
        accountId
      ) ||
      duplicateState
        .duplicateIds
        .has(
          accountId
        )
    ) {
      continue;
    }

    if (
      heldIds.has(
        accountId
      ) &&
      !restoreCandidateIds.has(
        accountId
      )
    ) {
      continue;
    }

    try {
      const credentials =
        account.credentials
          ? normalizeRetailerCredentials(
              decryptJson(
                account.credentials
              )
            )
          : emptyRetailerCredentials();

      if (
        String(
          credentials
            ?.[normalizedRetailer]
            ?.username ||
          ""
        ).trim()
      ) {
        available.push(
          account
        );
      }
    } catch {
      // Skip accounts that cannot be decrypted.
    }
  }

  /*
    Exact accounts reserved on this customer's Restore Hold
    are always placed first when they reactivate the same type.
  */
  return available.sort(
    (
      a,
      b
    ) =>
      (
        restoreCandidateIds.has(
          String(b.id)
        )
          ? 1
          : 0
      ) -
      (
        restoreCandidateIds.has(
          String(a.id)
        )
          ? 1
          : 0
      )
  );
}


app.get(
  "/api/admin/managed-success-mailbox-status",
  requireAdmin,
  async (req, res) => {
    const config =
      managedSuccessMailboxConfig();

    return res.json({
      ok: true,
      configured:
        config.configured,
      emailConfigured:
        Boolean(
          config.email
        ),
      passwordConfigured:
        Boolean(config.password),
      hostConfigured:
        Boolean(
          config.host
        ),
      running: Boolean(managedSuccessScanPromise),
      ...managedSuccessScanStatus
    });
  }
);

app.post(
  "/api/admin/managed-success-mailbox-scan",
  requireAdmin,
  (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!managedSuccessMailboxConfig().configured) {
      return res.status(400).json({ error: "Complete the managed mailbox settings in Render first." });
    }
    runManagedSuccessScan().catch(() => {});
    return res.status(202).json({ ok: true, running: true });
  }
);


app.get(
  "/api/admin/security-status",
  requireAdmin,
  async (req, res) => {
    const status =
      securityConfigurationSnapshot();

    return res.json({
      ok: true,

      headers: {
        contentSecurityPolicy:
          true,

        hstsWhenHttps:
          true,

        noSniff:
          true,

        frameProtection:
          true,

        permissionsPolicy:
          true
      },

      sessions: {
        adminHttpOnly:
          true,

        adminSameSiteStrict:
          true,

        adminAbsoluteHours:
          Math.round(
            ADMIN_SESSION_MAX_AGE_MS /
            3600000
          ),

        adminIdleHours:
          Math.round(
            ADMIN_SESSION_IDLE_MS /
            3600000
          ),

        customerHttpOnly:
          true,

        customerSameSiteLax:
          true,

        customerRevocationVersion:
          true
      },

      protections: {
        sameOriginMutations:
          true,

        apiRateLimiting:
          true,

        adminMfa:
          status.adminMfaConfigured,

        customerPasswordMinimum:
          12,

        encryptedSensitiveStorage:
          status.encryptionKeyConfigured,

        secureCookies:
          status.secureCookies,

        auditLogging:
          true,

        sensitiveLogRedaction:
          true
      },

      configuration: {
        baseUrlHttps:
          status.baseUrlHttps,

        customerSessionSecretStrong:
          status.customerSessionSecretStrong,

        adminPasswordStrong:
          status.adminPasswordStrong,

        stripeSecretConfigured:
          status.stripeSecretConfigured,

        stripeWebhookSecretConfigured:
          status.stripeWebhookSecretConfigured
      }
    });
  }
);


app.get(
  "/api/managed-availability",
  async (req, res) => {
    try {
      const availability =
        await getManagedAvailability();

      res.set(
        "Cache-Control",
        "no-store"
      );

      return res.json({
        ok: true,

        target:
          availability.target,

        walmart:
          availability.walmart,

        pokemoncenter:
          availability.pokemoncenter,

        updatedAt:
          new Date()
            .toISOString()
      });

    } catch (error) {
      console.error(
        "Managed availability error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to load account availability."
        });
    }
  }
);




function normalizeManagedPoolRetailer(
  value
) {
  const retailer =
    String(value || "")
      .trim()
      .toLowerCase();

  return [
    "target",
    "walmart",
    "pokemoncenter"
  ].includes(retailer)
    ? retailer
    : null;
}


function parseManagedPoolAccounts(
  raw
) {
  const lines =
    String(raw || "")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

  const parsed = [];
  const seen = new Set();

  for (
    let index = 0;
    index < lines.length;
    index += 1
  ) {
    const line = lines[index];
    const separator =
      line.indexOf(":");

    if (separator <= 0) {
      const error =
        new Error(
          `Line ${index + 1} is not in email:password format.`
        );
      error.status = 400;
      throw error;
    }

    const email =
      normalizeEmail(
        line.slice(0, separator)
      );

    const password =
      line.slice(separator + 1);

    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        email
      )
    ) {
      const error =
        new Error(
          `Line ${index + 1} has an invalid email address.`
        );
      error.status = 400;
      throw error;
    }

    if (!password) {
      const error =
        new Error(
          `Line ${index + 1} is missing a password.`
        );
      error.status = 400;
      throw error;
    }

    if (seen.has(email)) {
      const error =
        new Error(
          `Duplicate email found on line ${index + 1}.`
        );
      error.status = 400;
      throw error;
    }

    seen.add(email);
    parsed.push({
      email,
      password
    });
  }

  return parsed;
}


async function managedAssignedIdSet() {
  const [
    freeAssignments,
    rentalAssignments
  ] = await Promise.all([
    getFreeAssignments(),
    getRentalAssignments()
  ]);

  const ids = new Set();

  for (
    const assignment of
    [
      ...freeAssignments,
      ...rentalAssignments
    ]
  ) {
    if (
      managedAssignmentIsLinked(
        assignment
      )
    ) {
      const id =
        assignment.managedAccountId ||
        assignment.freeMembershipId ||
        assignment.rentedMembershipId ||
        null;

      if (id) {
        ids.add(String(id));
      }
    }
  }

  return ids;
}


app.post(
  "/api/admin/account-pool/:retailer/add",
  requireAdmin,
  async (req, res) => {
    try {
      const retailer =
        normalizeManagedPoolRetailer(
          req.params.retailer
        );

      if (!retailer) {
        return res
          .status(400)
          .json({
            error:
              "Choose Target or Walmart."
          });
      }

      const parsed =
        parseManagedPoolAccounts(
          req.body?.accounts
        );

      await rejectDeletedManagedLogins(retailer, parsed);

      if (!parsed.length) {
        return res
          .status(400)
          .json({
            error:
              "Add at least one account."
          });
      }

      const records =
        await getManagedAccounts();

      const existingEmails =
        new Set();

      for (
        const record of records
      ) {
        try {
          const credentials =
            record.credentials
              ? normalizeRetailerCredentials(
                  decryptJson(
                    record.credentials
                  )
                )
              : emptyRetailerCredentials();

          const email =
            normalizeEmail(
              credentials
                ?.[retailer]
                ?.username
            );

          if (email) {
            existingEmails.add(
              email
            );
          }
        } catch {
          // Preserve unreadable records.
        }
      }

      const duplicates =
        parsed.filter(
          item =>
            existingEmails.has(
              item.email
            )
        );

      if (duplicates.length) {
        return res
          .status(409)
          .json({
            error:
              `${duplicates.length} ${retailer} account${duplicates.length === 1 ? "" : "s"} already exist.`
          });
      }

      const now =
        new Date()
          .toISOString();

      for (
        const item of parsed
      ) {
        const credentials =
          emptyRetailerCredentials();

        credentials[retailer] = {
          username: item.email,
          password: item.password
        };

        records.push({
          id:
            crypto.randomUUID(),
          profileName:
            `MANAGED ${retailer.toUpperCase()} ACCOUNT`,
          accountEmail: "",
          notes: "",
          credentials:
            encryptJson(
              credentials
            ),
          source:
            `${retailer}-secure-add`,
          createdAt: now,
          updatedAt: now
        });
      }

      await saveManagedAccounts(
        records
      );

      const availability =
        await getManagedAvailability();

      return res.json({
        ok: true,
        added:
          parsed.length,
        retailer,
        availability:
          availability[retailer]
      });

    } catch (error) {
      console.error(
        "Managed pool add error:",
        error
      );

      return res
        .status(
          error.status || 500
        )
        .json({
          error:
            error.message ||
            "Unable to add managed accounts."
        });
    }
  }
);


app.post(
  "/api/admin/account-pool/:retailer/replace",
  requireAdmin,
  async (req, res) => {
    try {
      const retailer =
        normalizeManagedPoolRetailer(
          req.params.retailer
        );

      if (!retailer) {
        return res
          .status(400)
          .json({
            error:
              "Choose Target or Walmart."
          });
      }

      const parsed =
        parseManagedPoolAccounts(
          req.body?.accounts
        );

      await rejectDeletedManagedLogins(retailer, parsed);

      if (!parsed.length) {
        return res
          .status(400)
          .json({
            error:
              "Add at least one account."
          });
      }

      const records =
        await getManagedAccounts();

      const assignedIds =
        await managedAssignedIdSet();

      const retained = [];
      let removed = 0;

      for (
        const record of records
      ) {
        let credentials =
          emptyRetailerCredentials();

        try {
          credentials =
            record.credentials
              ? normalizeRetailerCredentials(
                  decryptJson(
                    record.credentials
                  )
                )
              : emptyRetailerCredentials();
        } catch {
          retained.push(record);
          continue;
        }

        const hasRetailer =
          Boolean(
            String(
              credentials
                ?.[retailer]
                ?.username ||
              ""
            ).trim()
          );

        if (!hasRetailer) {
          retained.push(record);
          continue;
        }

        if (
          assignedIds.has(
            String(record.id)
          )
        ) {
          return res
            .status(409)
            .json({
              error:
                `A current ${retailer} account is assigned to a customer. Finish/remove assigned accounts before replacing the entire pool.`
            });
        }

        removed += 1;

        credentials[retailer] = {
          username: "",
          password: ""
        };

        const hasOther =
          RETAILER_KEYS.some(
            key =>
              key !== retailer &&
              Boolean(
                String(
                  credentials
                    ?.[key]
                    ?.username ||
                  ""
                ).trim()
              )
          );

        if (hasOther) {
          retained.push({
            ...record,
            credentials:
              encryptJson(
                credentials
              ),
            updatedAt:
              new Date()
                .toISOString()
          });
        }
      }

      const now =
        new Date()
          .toISOString();

      const additions =
        parsed.map(item => {
          const credentials =
            emptyRetailerCredentials();

          credentials[retailer] = {
            username: item.email,
            password: item.password
          };

          return {
            id:
              crypto.randomUUID(),
            profileName:
              `MANAGED ${retailer.toUpperCase()} ACCOUNT`,
            accountEmail: "",
            notes: "",
            credentials:
              encryptJson(
                credentials
              ),
            source:
              `${retailer}-secure-replacement`,
            createdAt: now,
            updatedAt: now
          };
        });

      await saveManagedAccounts([
        ...retained,
        ...additions
      ]);

      const availability =
        await getManagedAvailability();

      return res.json({
        ok: true,
        removed,
        added:
          additions.length,
        retailer,
        availability:
          availability[retailer]
      });

    } catch (error) {
      console.error(
        "Managed pool replace error:",
        error
      );

      return res
        .status(
          error.status || 500
        )
        .json({
          error:
            error.message ||
            "Unable to replace managed pool."
        });
    }
  }
);


app.post(
  "/api/admin/account-pool/:retailer/delete-selected",
  requireAdmin,
  async (req, res) => {
    try {
      const retailer =
        normalizeManagedPoolRetailer(
          req.params.retailer
        );

      const ids =
        Array.isArray(
          req.body?.ids
        )
          ? req.body.ids
              .map(item =>
                String(item)
              )
              .filter(Boolean)
          : [];

      if (
        !retailer ||
        !ids.length
      ) {
        return res
          .status(400)
          .json({
            error:
              "Choose at least one account to delete."
          });
      }

      const wanted =
        new Set(ids);

      const assignedIds =
        await managedAssignedIdSet();

      const blocked =
        ids.filter(
          id =>
            assignedIds.has(id)
        );

      if (blocked.length) {
        return res
          .status(409)
          .json({
            error:
              `${blocked.length} selected account${blocked.length === 1 ? " is" : "s are"} still assigned. Remove the assignment first.`
          });
      }

      const records =
        await getManagedAccounts();

      const next = [];
      const removedAccounts = [];
      let deleted = 0;

      for (
        const record of records
      ) {
        if (
          !wanted.has(
            String(record.id)
          )
        ) {
          next.push(record);
          continue;
        }

        let credentials =
          emptyRetailerCredentials();

        try {
          credentials =
            record.credentials
              ? normalizeRetailerCredentials(
                  decryptJson(
                    record.credentials
                  )
                )
              : emptyRetailerCredentials();
        } catch {
          next.push(record);
          continue;
        }

        if (
          !String(
            credentials
              ?.[retailer]
              ?.username ||
            ""
          ).trim()
        ) {
          next.push(record);
          continue;
        }

        credentials[retailer] = {
          username: "",
          password: ""
        };

        removedAccounts.push(record);

        deleted += 1;

        const hasOther =
          RETAILER_KEYS.some(
            key =>
              Boolean(
                String(
                  credentials
                    ?.[key]
                    ?.username ||
                  ""
                ).trim()
              )
          );

        if (hasOther) {
          next.push({
            ...record,
            credentials:
              encryptJson(
                credentials
              ),
            updatedAt:
              new Date()
                .toISOString()
          });
        }
      }

      await excludeDeletedManagedLogins(removedAccounts);
      await saveManagedAccounts(next);

      const availability =
        await getManagedAvailability();

      return res.json({
        ok: true,
        deleted,
        retailer,
        availability:
          availability[retailer]
      });

    } catch (error) {
      console.error(
        "Managed pool delete-selected error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to delete selected managed accounts."
        });
    }
  }
);


/* -------------------------------------------------------
   ADMIN TARGET POOL REPLACEMENT

   Credentials are submitted at runtime from Admin and are
   encrypted immediately using SUBMISSION_ENCRYPTION_KEY.
   They are NOT embedded in the source repository.

   For safety, replacement is blocked while any current
   Target managed account is actively assigned.
------------------------------------------------------- */

app.post(
  "/api/admin/target-pool/replace",
  requireAdmin,
  async (req, res) => {
    try {
      const raw =
        String(
          req.body?.accounts ||
          ""
        );

      const lines =
        raw
          .split(/\r?\n/)
          .map(
            line =>
              line.trim()
          )
          .filter(Boolean);

      const parsed =
        [];

      const seen =
        new Set();

      for (
        let index = 0;
        index < lines.length;
        index += 1
      ) {
        const line =
          lines[index];

        const separator =
          line.indexOf(":");

        if (
          separator <= 0
        ) {
          return res
            .status(400)
            .json({
              error:
                `Line ${index + 1} is not in email:password format.`
            });
        }

        const email =
          normalizeEmail(
            line.slice(
              0,
              separator
            )
          );

        const password =
          line.slice(
            separator + 1
          );

        if (
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
            email
          )
        ) {
          return res
            .status(400)
            .json({
              error:
                `Line ${index + 1} has an invalid email address.`
            });
        }

        if (!password) {
          return res
            .status(400)
            .json({
              error:
                `Line ${index + 1} is missing a password.`
            });
        }

        if (
          seen.has(
            email
          )
        ) {
          return res
            .status(400)
            .json({
              error:
                `Duplicate Target email found on line ${index + 1}.`
            });
        }

        seen.add(
          email
        );

        parsed.push({
          email,
          password
        });
      }

      if (
        parsed.length !==
        100
      ) {
        return res
          .status(400)
          .json({
            error:
              `This replacement requires exactly 100 Target accounts. Received ${parsed.length}.`
          });
      }

      const [
        managedAccounts,
        freeAssignments,
        rentalAssignments
      ] = await Promise.all([
        getManagedAccounts(),
        getFreeAssignments(),
        getRentalAssignments()
      ]);

      const activeManagedIds =
        new Set();

      for (
        const assignment of
        freeAssignments
      ) {
        if (
          managedAssignmentIsLinked(
            assignment
          )
        ) {
          const id =
            assignment
              .managedAccountId ||
            assignment
              .freeMembershipId ||
            "";

          if (id) {
            activeManagedIds.add(
              String(id)
            );
          }
        }
      }

      for (
        const assignment of
        rentalAssignments
      ) {
        if (
          managedAssignmentIsLinked(
            assignment
          )
        ) {
          const id =
            assignment
              .managedAccountId ||
            assignment
              .rentedMembershipId ||
            "";

          if (id) {
            activeManagedIds.add(
              String(id)
            );
          }
        }
      }

      const targetAccountIds =
        new Set();

      for (
        const account of
        managedAccounts
      ) {
        try {
          const credentials =
            account.credentials
              ? normalizeRetailerCredentials(
                  decryptJson(
                    account.credentials
                  )
                )
              : emptyRetailerCredentials();

          if (
            String(
              credentials
                ?.target
                ?.username ||
              ""
            ).trim()
          ) {
            targetAccountIds.add(
              String(
                account.id
              )
            );
          }
        } catch {
          // Ignore unreadable entries.
        }
      }

      const targetInUse =
        Array.from(
          targetAccountIds
        ).filter(
          id =>
            activeManagedIds.has(
              id
            )
        );

      if (
        targetInUse.length >
        0
      ) {
        return res
          .status(409)
          .json({
            error:
              `${targetInUse.length} current Target account${targetInUse.length === 1 ? " is" : "s are"} still assigned. Deactivate/return ${targetInUse.length === 1 ? "it" : "them"} before replacing the Target pool so no customer assignment is broken.`,
            inUse:
              targetInUse.length
          });
      }

      const retained =
        [];

      let removedTarget =
        0;

      for (
        const account of
        managedAccounts
      ) {
        let credentials =
          emptyRetailerCredentials();

        try {
          if (
            account.credentials
          ) {
            credentials =
              normalizeRetailerCredentials(
                decryptJson(
                  account.credentials
                )
              );
          }
        } catch {
          retained.push(
            account
          );
          continue;
        }

        const hasTarget =
          Boolean(
            String(
              credentials
                ?.target
                ?.username ||
              ""
            ).trim()
          );

        if (!hasTarget) {
          retained.push(
            account
          );
          continue;
        }

        removedTarget +=
          1;

        const otherRetailerExists =
          RETAILER_KEYS
            .filter(
              retailer =>
                retailer !==
                "target"
            )
            .some(
              retailer =>
                Boolean(
                  String(
                    credentials
                      ?.[retailer]
                      ?.username ||
                    ""
                  ).trim()
                )
            );

        if (
          otherRetailerExists
        ) {
          credentials.target = {
            username: "",
            password: ""
          };

          retained.push({
            ...account,
            credentials:
              encryptJson(
                credentials
              ),
            updatedAt:
              new Date()
                .toISOString()
          });
        }
      }

      const now =
        new Date()
          .toISOString();

      const replacements =
        parsed.map(
          item => {
            const credentials =
              emptyRetailerCredentials();

            credentials.target = {
              username:
                item.email,
              password:
                item.password
            };

            return {
              id:
                crypto.randomUUID(),

              profileName:
                "MANAGED TARGET ACCOUNT",

              accountEmail:
                "",

              notes:
                "",

              credentials:
                encryptJson(
                  credentials
                ),

              source:
                "target-secure-replacement",

              createdAt:
                now,

              updatedAt:
                now
            };
          }
        );

      await saveManagedAccounts([
        ...retained,
        ...replacements
      ]);

      const availability =
        await getManagedAvailability();

      return res.json({
        ok: true,

        removedTarget,

        addedTarget:
          replacements.length,

        target:
          availability.target,

        message:
          `Target pool replaced successfully. Removed ${removedTarget}; added ${replacements.length}.`
      });

    } catch (error) {
      console.error(
        "Target pool replacement error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to replace the Target account pool."
        });
    }
  }
);


/* -------------------------------------------------------
   ADMIN AVAILABLE MEMBERSHIP INVENTORY
------------------------------------------------------- */

async function getAvailableManagedMembershipRecords() {
  const [
    managedAccounts,
    freeAssignments,
    rentalAssignments
  ] = await Promise.all([
    getManagedAccounts(),
    getFreeAssignments(),
    getRentalAssignments()
  ]);

  const restoreHolds =
    await getRestoreHolds();

  const inUseIds =
    heldManagedAccountIdsFromHolds(
      restoreHolds
    );

  for (const assignment of freeAssignments) {
    if (!managedAssignmentIsLinked(assignment)) {
      continue;
    }

    const id =
      assignment.managedAccountId ||
      assignment.freeMembershipId ||
      "";

    if (id) {
      inUseIds.add(String(id));
    }
  }

  for (const assignment of rentalAssignments) {
    if (!managedAssignmentIsLinked(assignment)) {
      continue;
    }

    const id =
      assignment.managedAccountId ||
      assignment.rentedMembershipId ||
      "";

    if (id) {
      inUseIds.add(String(id));
    }
  }

  const duplicateState =
    managedDuplicateCredentialState(
      managedAccounts,
      inUseIds
    );

  return managedAccounts
    .filter(
      account =>
        !inUseIds.has(
          String(account.id)
        ) &&
        !duplicateState
          .duplicateIds
          .has(
            String(
              account.id
            )
          )
    )
    .map(account => {
      let retailers =
        emptyRetailerCredentials();

      try {
        if (account.credentials) {
          retailers =
            normalizeRetailerCredentials(
              decryptJson(
                account.credentials
              )
            );
        }
      } catch (error) {
        console.error(
          "Available membership decrypt error:",
          account.id,
          error.message
        );
      }

      const targetEmail =
        clean(
          retailers?.target?.username,
          254
        );

      const walmartEmail =
        clean(
          retailers?.walmart?.username,
          254
        );

      const pokemoncenterEmail = clean(retailers?.pokemoncenter?.username, 254);

      const displayEmail =
        clean(
          account.accountEmail,
          254
        ) ||
        targetEmail ||
        walmartEmail ||
        pokemoncenterEmail ||
        "";

      return {
        id:
          account.id,

        profileName:
          account.profileName ||
          "AVAILABLE MEMBERSHIP",

        accountEmail:
          account.accountEmail ||
          "",

        displayEmail,

        notes:
          account.notes ||
          "",

        createdAt:
          account.createdAt ||
          null,

        updatedAt:
          account.updatedAt ||
          null,

        retailers
      };
    });
}


app.get(
  "/api/admin/available-memberships",
  requireAdmin,
  async (req, res) => {
    try {
      const memberships =
        await getAvailableManagedMembershipRecords();

      return res.json({
        ok: true,
        memberships
      });

    } catch (error) {
      console.error(
        "Admin available membership list error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to load available memberships."
        });
    }
  }
);


app.post(
  "/api/admin/available-memberships",
  requireAdmin,
  async (req, res) => {
    try {
      const profileName =
        clean(
          req.body?.profileName,
          100
        ) ||
        "AVAILABLE MEMBERSHIP";

      const accountEmail =
        clean(
          req.body?.accountEmail,
          200
        );

      const notes =
        clean(
          req.body?.notes,
          500
        );

      const submitted =
        req.body?.retailers &&
        typeof req.body.retailers ===
          "object"
          ? req.body.retailers
          : {};

      const credentials =
        emptyRetailerCredentials();

      for (const retailer of RETAILER_KEYS) {
        const submittedRetailer =
          submitted[retailer] &&
          typeof submitted[retailer] ===
            "object"
            ? submitted[retailer]
            : {};

        const username =
          clean(
            submittedRetailer.username,
            254
          );

        const password =
          String(
            submittedRetailer.password ||
            ""
          );

        if (password.length > 512) {
          return res
            .status(400)
            .json({
              error:
                "A retailer password is too long."
            });
        }

        credentials[retailer] = {
          username,
          password
        };
      }

      const memberships =
        await getManagedAccounts();


      const duplicateCredential =
        managedCredentialConflict(
          memberships,
          credentials
        );

      for (const retailer of RETAILER_KEYS) {
        const username = credentials[retailer]?.username;
        if (username) await rejectDeletedManagedLogins(retailer, [{ email: username }]);
      }

      if (
        duplicateCredential
      ) {
        return res
          .status(409)
          .json({
            error:
              `Duplicate managed profile blocked. The exact ${duplicateCredential.retailer} username/password is already stored on another managed profile.`
          });
      }

      const now =
        new Date()
          .toISOString();

      const record = {
        id:
          crypto.randomUUID(),

        profileName,
        accountEmail,
        notes,

        credentials:
          encryptJson(
            credentials
          ),

        source:
          "admin-available-inventory",

        createdAt:
          now,

        updatedAt:
          now
      };

      memberships.push(record);

      await saveManagedAccounts(
        memberships
      );

      return res.json({
        ok: true,
        id:
          record.id,
        message:
          "Available membership added successfully."
      });

    } catch (error) {
      console.error(
        "Admin available membership create error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to add available membership."
        });
    }
  }
);


app.put(
  "/api/admin/available-memberships/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        clean(
          req.params.id,
          150
        );

      const memberships =
        await getManagedAccounts();

      const index =
        memberships.findIndex(
          item =>
            String(item.id) ===
            id
        );

      if (index < 0) {
        return res
          .status(404)
          .json({
            error:
              "Available membership could not be found."
          });
      }

      const existing =
        memberships[index];

      let existingCredentials =
        emptyRetailerCredentials();

      try {
        if (existing.credentials) {
          existingCredentials =
            normalizeRetailerCredentials(
              decryptJson(
                existing.credentials
              )
            );
        }
      } catch {}

      const submitted =
        req.body?.retailers &&
        typeof req.body.retailers ===
          "object"
          ? req.body.retailers
          : {};

      const credentials =
        emptyRetailerCredentials();

      for (const retailer of RETAILER_KEYS) {
        const input =
          submitted[retailer] &&
          typeof submitted[retailer] ===
            "object"
            ? submitted[retailer]
            : {};

        const username =
          clean(
            input.username,
            254
          );

        const password =
          String(
            input.password ||
            ""
          );

        if (password.length > 512) {
          return res
            .status(400)
            .json({
              error:
                "A retailer password is too long."
            });
        }

        credentials[retailer] = {
          username:
            username ||
            existingCredentials[retailer]
              ?.username ||
            "",

          password:
            password ||
            existingCredentials[retailer]
              ?.password ||
            ""
        };
      }

            const duplicateCredential =
        managedCredentialConflict(
          memberships,
          credentials,
          id
        );

      if (
        duplicateCredential
      ) {
        return res
          .status(409)
          .json({
            error:
              `Duplicate managed profile blocked. The exact ${duplicateCredential.retailer} username/password is already stored on another managed profile.`
          });
      }


memberships[index] = {
        ...existing,

        profileName:
          clean(
            req.body?.profileName,
            100
          ) ||
          existing.profileName ||
          "AVAILABLE MEMBERSHIP",

        accountEmail:
          clean(
            req.body?.accountEmail,
            200
          ) ||
          existing.accountEmail ||
          "",

        notes:
          clean(
            req.body?.notes,
            500
          ),

        credentials:
          encryptJson(
            credentials
          ),

        updatedAt:
          new Date()
            .toISOString()
      };

      await saveManagedAccounts(
        memberships
      );

      return res.json({
        ok: true,
        message:
          "Available membership updated successfully."
      });

    } catch (error) {
      console.error(
        "Admin available membership update error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to update available membership."
        });
    }
  }
);


app.delete(
  "/api/admin/available-memberships/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        clean(
          req.params.id,
          150
        );

      const freeAssignments =
        await getFreeAssignments();

      const rentalAssignments =
        await getRentalAssignments();

      const restoreHoldOwner =
        await managedAccountRestoreHoldOwner(
          id
        );

      if (
        currentFreeAssignment(
          freeAssignments,
          id
        ) ||
        currentRentalAssignment(
          rentalAssignments,
          id
        ) ||
        restoreHoldOwner
      ) {
        return res
          .status(409)
          .json({
            error:
              "This membership is currently assigned or on a 7-day Restore Hold and cannot be deleted."
          });
      }

      const memberships =
        await getManagedAccounts();

      const next =
        memberships.filter(
          item =>
            String(item.id) !== id
        );

      if (
        next.length ===
        memberships.length
      ) {
        return res
          .status(404)
          .json({
            error:
              "Available membership could not be found."
          });
      }

      await excludeDeletedManagedLogins(memberships.filter(item => String(item.id) === id));

      await saveManagedAccounts(next);

      return res.json({
        ok: true,
        message:
          "Available membership deleted."
      });

    } catch (error) {
      console.error(
        "Admin available membership delete error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to delete available membership."
        });
    }
  }
);


app.post(
  "/api/admin/available-memberships/assign",
  requireAdmin,
  async (req, res) => {
    try {
      const customerAccountId =
        clean(
          req.body?.customerAccountId,
          150
        );

      const retailer =
        normalizeManagedPoolRetailer(
          req.body?.retailer
        );

      const assignmentType =
        String(
          req.body?.assignmentType ||
          ""
        )
          .trim()
          .toLowerCase();

      const quantity =
        Math.min(
          50,
          Math.max(
            1,
            Math.floor(
              Number(
                req.body?.quantity ||
                1
              )
            )
          )
        );

      const durationType =
        normalizeSpecialProfileDuration(
          req.body?.durationType
        );

      if (
        !customerAccountId ||
        !retailer ||
        ![
          "free",
          "rented"
        ].includes(
          assignmentType
        ) ||
        !durationType
      ) {
        return res
          .status(400)
          .json({
            error:
              "Choose a customer, retailer, assignment type, quantity, and duration."
          });
      }

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const paidRecords =
        Array.isArray(paid)
          ? paid
          : [];

      const paidRecord = await activeMembershipRecordForCustomer(customerAccountId, paidRecords);
      if (!paidRecord) {
        return res.status(403).json({
          error: "An active paid or gifted membership is required for managed profiles."
        });
      }

      let available =
        await getAvailableManagedAccountsForRetailer(
          retailer,
          {
            restoreCustomerAccountId:
              customerAccountId,

            restoreType:
              assignmentType
          }
        );

      if (assignmentType === "rented") {
        available = preferPreviouslyAssignedManagedAccounts(available,
          [...await getRentalAssignments(), ...await getFreeAssignments()],
          customerAccountId, retailer);
      }

      if (
        available.length <
        quantity
      ) {
        return res
          .status(409)
          .json({
            error:
              `Only ${available.length} ${retailer} membership${available.length === 1 ? "" : "s"} are currently available.`
          });
      }

      const now =
        new Date();

      const customerProfile =
        sanitizeProfile(
          paidRecord.profile ||
          {}
        );

      const paidSecrets = await membershipEncryptedPackage(paidRecord);
      const customerAccount = (await getCustomerAccounts()).find(item => String(item.id) === String(customerAccountId));
      const reservedNewJigs = new Set();

      if (
        assignmentType ===
        "free"
      ) {
        const assignments =
          await getFreeAssignments();

        for (
          const account of
          available.slice(
            0,
            quantity
          )
        ) {
          assignments.push({
            id:
              crypto.randomUUID(),

            freeMembershipId:
              account.id,

            managedAccountId:
              account.id,

            customerAccountId,

            paidSubmissionId:
              paidRecord.id,

            active:
              true,

            durationType,

            assignmentRetailer:
              retailer,

            activationStatus:
              "awaiting_activation",

            activationRequestedAt:
              now.toISOString(),

            startsAt:
              null,

            expiresAt:
              null,

            customerProfile,

            customerSecrets:
              paidSecrets
                ? encryptJson(
                    paidSecrets
                  )
                : null,

            createdAt:
              now.toISOString(),

            updatedAt:
              now.toISOString(),

            endedAt:
              null,

            endReason:
              null
          });
          await prepareNewManagedAssignment(assignments.at(-1), account, customerAccount, paidRecord, reservedNewJigs);
        }

        for (
          const assignment of
          assignments
        ) {
          if (
            assignment.customerAccountId ===
              customerAccountId &&
            assignment.activationStatus ===
              "awaiting_activation" &&
            !assignment.discordProfileMessageId
          ) {
            await ensureManagedProfileDiscordMessage(
              assignment,
              "free"
            );
          }
        }

        await saveFreeAssignments(
          assignments
        );

      } else {
        const assignments =
          await getRentalAssignments();

        for (
          const account of
          available.slice(
            0,
            quantity
          )
        ) {
          assignments.push({
            id:
              crypto.randomUUID(),

            rentedMembershipId:
              account.id,

            managedAccountId:
              account.id,

            customerAccountId,

            paidSubmissionId:
              paidRecord.id,

            active:
              true,

            durationType,

            activationStatus:
              "awaiting_activation",

            activationRequestedAt:
              now.toISOString(),

            startsAt:
              null,

            expiresAt:
              null,

            customerProfile,

            customerSecrets:
              paidSecrets
                ? encryptJson(
                    paidSecrets
                  )
                : null,

            rentalRetailer:
              retailer,

            stripeSubscriptionId:
              null,

            stripeCustomerId:
              paidRecord
                .stripeCustomerId ||
              null,

            createdAt:
              now.toISOString(),

            updatedAt:
              now.toISOString(),

            endedAt:
              null,

            endReason:
              null
          });
          await prepareNewManagedAssignment(assignments.at(-1), account, customerAccount, paidRecord, reservedNewJigs);
        }

        for (
          const assignment of
          assignments
        ) {
          if (
            assignment.customerAccountId ===
              customerAccountId &&
            assignment.activationStatus ===
              "awaiting_activation" &&
            !assignment.discordProfileMessageId
          ) {
            await ensureManagedProfileDiscordMessage(
              assignment,
              "rented"
            );
          }
        }

        await saveRentalAssignments(
          assignments
        );
      }

      await consumeRestoreHoldItems(
        customerAccountId,
        assignmentType,
        available
          .slice(
            0,
            quantity
          )
          .map(
            account =>
              account.id
          )
      );

      return res.json({
        ok: true,

        assigned:
          quantity,

        assignmentType,
        retailer,

        message:
          `${quantity} available membership${quantity === 1 ? "" : "s"} assigned successfully.`
      });

    } catch (error) {
      console.error(
        "Available membership assignment error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to assign available memberships."
        });
    }
  }
);


/* -------------------------------------------------------
   ADMIN FREE MEMBERSHIPS
------------------------------------------------------- */

app.get(
  "/api/admin/free-memberships",
  requireAdmin,
  async (req, res) => {
    try {
      const memberships =
        await getManagedAccounts();

      const assignments =
        await getFreeAssignments();

      const otherAssignments =
        await getRentalAssignments();

      const accounts =
        await getCustomerAccounts();

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const paidRecords =
        Array.isArray(paid)
          ? paid
          : [];

      let assignmentsChanged =
        false;

      const now =
        new Date();

      for (
        const assignment of
        assignments
      ) {
        if (
          assignment.active !== true ||
          String(
            assignment.activationStatus ||
            ""
          ) !==
            "activated" ||
          !assignment.expiresAt
        ) {
          continue;
        }

        const expiresAt =
          new Date(
            assignment.expiresAt
          );

        if (
          !Number.isNaN(
            expiresAt.getTime()
          ) &&
          expiresAt.getTime() <=
            now.getTime()
        ) {
          clearManagedAssignmentCustomerData(
            assignment,
            {
              reason:
                "expired",
              nowIso:
                now.toISOString()
            }
          );

          assignmentsChanged =
            true;
        }
      }

      if (assignmentsChanged) {
        await saveFreeAssignments(
          assignments
        );
      }

      /* Paid and currently active gifted tiers can use managed profiles. */

      const paidCustomerMap =
        new Map();

      for (
        const record of
        paidRecords
      ) {
        if (
          !record.customerAccountId ||
          !subscriptionAllowsProfiles(
            record
          )
        ) {
          continue;
        }

        if (
          !paidCustomerMap.has(
            record.customerAccountId
          )
        ) {
          paidCustomerMap.set(
            record.customerAccountId,
            record
          );
        }
      }

      const activeGifts = await getGiftedMemberships();
      for (const gift of activeGifts) {
        if (
          paidCustomerMap.has(gift.customerAccountId) ||
          new Date(gift.startsAt).getTime() > now.getTime() ||
          new Date(gift.expiresAt).getTime() <= now.getTime()
        ) continue;
        const account = accounts.find(item => String(item.id) === String(gift.customerAccountId));
        if (!account) continue;
        paidCustomerMap.set(gift.customerAccountId, {
          id: `gift:${gift.id}`,
          customerAccountId: gift.customerAccountId,
          profile: { ...(account.adminProfile || {}), email: account.email },
          subscriptionStatus: "gifted",
          currentPeriodEnd: gift.expiresAt
        });
      }

      const paidCustomers =
        Array.from(
          paidCustomerMap.values()
        ).map(record => {
          const account =
            accounts.find(
              item =>
                item.id ===
                record.customerAccountId
            );

          const savedProfile =
            account?.adminProfile &&
            typeof account.adminProfile ===
              "object"
              ? account.adminProfile
              : {};

          const paidProfile =
            record.profile &&
            typeof record.profile ===
              "object"
              ? record.profile
              : {};

          const customerName =
            [
              savedProfile.firstName ||
                paidProfile.firstName ||
                "",
              savedProfile.lastName ||
                paidProfile.lastName ||
                ""
            ]
              .filter(Boolean)
              .join(" ") ||
            savedProfile.profileName ||
            paidProfile.profileName ||
            "Customer";

          return {
            customerAccountId:
              record.customerAccountId,

            paidSubmissionId:
              record.id,

            name:
              customerName,

            email:
              account?.email ||
              savedProfile.email ||
              paidProfile.email ||
              "",

            subscriptionStatus:
              record.subscriptionStatus ||
              null,

            currentPeriodEnd:
              record.currentPeriodEnd ||
              null
          };
        });

      const result =
        memberships
          .filter(
            membership =>
              Boolean(
                linkedFreeAssignment(
                  assignments,
                  membership.id
                )
              )
          )
          .map(
          membership => {
            const assignment =
              linkedFreeAssignment(
                assignments,
                membership.id
              );

            const otherAssignment =
              linkedRentalAssignment(
                otherAssignments,
                membership.id
              );

            let assignedCustomer =
              null;

            if (assignment) {
              const account =
                accounts.find(
                  item =>
                    item.id ===
                    assignment
                      .customerAccountId
                );

              const paidRecord =
                paidRecords.find(
                  item =>
                    item.customerAccountId ===
                      assignment
                        .customerAccountId &&
                    subscriptionAllowsProfiles(
                      item
                    )
                );

              const savedProfile =
                account?.adminProfile &&
                typeof account.adminProfile ===
                  "object"
                  ? account.adminProfile
                  : {};

              const paidProfile =
                paidRecord?.profile &&
                typeof paidRecord.profile ===
                  "object"
                  ? paidRecord.profile
                  : {};

              assignedCustomer = {
                customerAccountId:
                  assignment
                    .customerAccountId,

                paidSubmissionId:
                  paidRecord?.id ||
                  null,

                name:
                  [
                    savedProfile.firstName ||
                      paidProfile.firstName ||
                      "",
                    savedProfile.lastName ||
                      paidProfile.lastName ||
                      ""
                  ]
                    .filter(Boolean)
                    .join(" ") ||
                  savedProfile.profileName ||
                  paidProfile.profileName ||
                  "Customer",

                email:
                  account?.email ||
                  savedProfile.email ||
                  paidProfile.email ||
                  ""
              };
            }

            let retailers =
              emptyRetailerCredentials();

            try {
              if (
                membership.credentials
              ) {
                retailers =
                  normalizeRetailerCredentials(
                    decryptJson(
                      membership
                        .credentials
                    )
                  );
              }
            } catch (error) {
              console.error(
                "Free membership decrypt error:",
                membership.id,
                error.message
              );
            }

            
            let customerSecrets =
  null;

try {
  if (
    assignment?.customerSecrets
  ) {
    customerSecrets =
      decryptJson(
        assignment.customerSecrets
      );
  }
} catch (error) {
  console.error(
    "Free membership customer data decrypt error:",
    membership.id,
    error.message
  );
}

            const readiness =
              managedProfileReadiness(
                assignment?.customerProfile ||
                {},
                customerSecrets ||
                {}
              );

            const exactAddressMatches =
              exactManagedAddressMatches(
                assignment?.customerProfile ||
                {},
                membership.id,
                memberships,
                assignments,
                otherAssignments
              );

            return {
              id:
                membership.id,

              profileName:
                membership.profileName ||
                "FREE MEMBERSHIP",

              accountEmail:
  membership.accountEmail ||
  "",

              displayEmail:
                managedAccountCanonicalEmail(
                  membership,
                  retailers
                ),

              notes:
                membership.notes ||
                "",

              createdAt:
                membership.createdAt ||
                null,

              updatedAt:
                membership.updatedAt ||
                null,

              active:
                Boolean(
                  assignment
                ),

              status:
                assignment
                  ? "active"
                  : (
                      otherAssignment
                        ? "occupied"
                        : "inactive"
                    ),

              occupiedByOtherType:
                Boolean(
                  otherAssignment
                ),

              occupiedType:
                otherAssignment
                  ? "rented"
                  : null,

              assignment:
                assignment
                  ? {
                      id:
                        assignment.id,

                      customerAccountId:
                        assignment
                          .customerAccountId,

                      startsAt:
                        assignment.startsAt ||
                        null,

                      expiresAt:
                        assignment.expiresAt ||
                        null,

                      durationType:
                        assignment.durationType ||
                        null,

                      activationStatus:
                        managedAssignmentStatus(
                          assignment
                        ),

                      activationLabel:
                        profileActivationLabel(
                          assignment.activationStatus
                        ),

                      daysRemaining:
                        freeAssignmentDaysRemaining(
                          assignment
                        )
                    }
                  : null,

              assignedCustomer,

              retailers,

              customerProfile:
  assignment?.customerProfile ||
  null,

customerSecrets,

              readiness,

              exactAddressMatches,

              jiggedAddress:
                assignment?.jiggedAddress ||
                null,

              jigVariantNumber:
                assignment?.jigVariantIndex ||
                null
            };
          }
        );

      const [
        availableMemberships,
        restoreHolds
      ] = await Promise.all([
        getAvailableManagedMembershipRecords(),
        getRestoreHolds()
      ]);

      const activeRestoreHolds =
        activeRestoreHoldsFor(
          restoreHolds,
          {
            type:
              "free"
          }
        ).map(
          hold => ({
            id:
              hold.id,

            customerAccountId:
              hold.customerAccountId,

            type:
              hold.type,

            holdUntil:
              hold.holdUntil,

            count:
              restoreHoldRemainingItems(
                hold
              ).length,

            customerName:
              (
                paidCustomers.find(
                  customer =>
                    String(
                      customer.customerAccountId ||
                      ""
                    ) ===
                      String(
                        hold.customerAccountId ||
                        ""
                      )
                )?.name
              ) ||
              (
                accounts.find(
                  account =>
                    String(
                      account.id
                    ) ===
                      String(
                        hold.customerAccountId ||
                        ""
                      )
                )?.email
              ) ||
              "Customer",

            customerEmail:
              (
                paidCustomers.find(
                  customer =>
                    String(
                      customer.customerAccountId ||
                      ""
                    ) ===
                      String(
                        hold.customerAccountId ||
                        ""
                      )
                )?.email
              ) ||
              (
                accounts.find(
                  account =>
                    String(
                      account.id
                    ) ===
                      String(
                        hold.customerAccountId ||
                        ""
                      )
                )?.email
              ) ||
              "",

            canRestore:
              paidCustomers.some(
                customer =>
                  String(
                    customer.customerAccountId ||
                    ""
                  ) ===
                    String(
                      hold.customerAccountId ||
                      ""
                    )
              )
          })
        );

      return res.json({
        ok: true,

        memberships:
          result,

        paidCustomers,

        availableMemberships,

        restoreHolds:
          activeRestoreHolds
      });

    } catch (error) {
      console.error(
        "Admin free membership list error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to load free memberships."
        });
    }
  }
);


app.post(
  "/api/admin/free-memberships",
  requireAdmin,
  async (req, res) => {
    try {
      const profileName =
        clean(
          req.body?.profileName,
          100
        ) ||
        "FREE MEMBERSHIP";

      const accountEmail =
  clean(
    req.body?.accountEmail,
    200
  );

      const notes =
        clean(
          req.body?.notes,
          500
        );

      const submitted =
        req.body?.retailers &&
        typeof req.body.retailers ===
          "object"
          ? req.body.retailers
          : {};

      const credentials =
        emptyRetailerCredentials();

      for (
        const retailer of
        RETAILER_KEYS
      ) {
        const submittedRetailer =
          submitted[retailer] &&
          typeof submitted[
            retailer
          ] === "object"
            ? submitted[
                retailer
              ]
            : {};

        const username =
          clean(
            submittedRetailer
              .username,
            254
          );

        const password =
          String(
            submittedRetailer
              .password ||
            ""
          );

        if (
          password.length >
          512
        ) {
          return res
            .status(400)
            .json({
              error:
                "A retailer password is too long."
            });
        }

        credentials[
          retailer
        ] = {
          username,
          password
        };
      }

      const memberships =
        await getManagedAccounts();


      const duplicateCredential =
        managedCredentialConflict(
          memberships,
          credentials
        );

      if (
        duplicateCredential
      ) {
        return res
          .status(409)
          .json({
            error:
              `Duplicate managed profile blocked. The exact ${duplicateCredential.retailer} username/password is already stored on another managed profile.`
          });
      }

      const now =
        new Date()
          .toISOString();

      const record = {
        id:
          crypto.randomUUID(),

        profileName,
        accountEmail,

        notes,

        credentials:
          encryptJson(
            credentials
          ),

        createdAt:
          now,

        updatedAt:
          now
      };

      memberships.push(
        record
      );

      await saveManagedAccounts(
        memberships
      );

      return res.json({
        ok: true,

        id:
          record.id,

        message:
          "Free membership created successfully."
      });

    } catch (error) {
      console.error(
        "Admin free membership create error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to create free membership."
        });
    }
  }
);


app.put(
  "/api/admin/free-memberships/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        clean(
          req.params.id,
          150
        );

      const memberships =
        await getManagedAccounts();

      const index =
        memberships.findIndex(
          membership =>
            String(
              membership.id
            ) === id
        );

      if (index < 0) {
        return res
          .status(404)
          .json({
            error:
              "Free membership could not be found."
          });
      }

      const existing =
  memberships[index];

const profileName =
  clean(
    req.body?.profileName,
    100
  ) ||
  existing.profileName ||
  "FREE MEMBERSHIP";

const accountEmail =
  clean(
    req.body?.accountEmail,
    200
  );

const notes =
  clean(
    req.body?.notes,
    500
  );

let existingCredentials =
  emptyRetailerCredentials();

try {
  if (
    existing.credentials
  ) {
    existingCredentials =
      normalizeRetailerCredentials(
        decryptJson(
          existing.credentials
        )
      );
  }
} catch (error) {
  console.error(
    "Existing free membership decrypt error:",
    error.message
  );
}

const submitted =
  req.body?.retailers &&
  typeof req.body.retailers ===
    "object"
    ? req.body.retailers
    : {};

const credentials =
  emptyRetailerCredentials();

for (
  const retailer of
  RETAILER_KEYS
) {
  const submittedRetailer =
    submitted[retailer] &&
    typeof submitted[
      retailer
    ] === "object"
      ? submitted[
          retailer
        ]
      : {};

  const username =
    clean(
      submittedRetailer
        .username,
      254
    );

  const password =
    String(
      submittedRetailer
        .password ||
      ""
    );

  if (
    password.length >
    512
  ) {
    return res
      .status(400)
      .json({
        error:
          "A retailer password is too long."
      });
  }

  credentials[
    retailer
  ] = {
    username,

    password:
      password ||
      existingCredentials[
        retailer
      ]?.password ||
      ""
  };
}

      const duplicateCredential =
        managedCredentialConflict(
          memberships,
          credentials,
          id
        );

      for (const retailer of RETAILER_KEYS) {
        const username = credentials[retailer]?.username;
        if (username && normalizeEmail(username) !== normalizeEmail(existingCredentials[retailer]?.username)) {
          await rejectDeletedManagedLogins(retailer, [{ email: username }]);
        }
      }

      if (
        duplicateCredential
      ) {
        return res
          .status(409)
          .json({
            error:
              `Duplicate managed profile blocked. The exact ${duplicateCredential.retailer} username/password is already stored on another managed profile.`
          });
      }


memberships[index] = {
  ...existing,

  accountEmail:
    accountEmail ||
    existing.accountEmail ||
    "",

  profileName,

  notes,

  credentials:
    encryptJson(
      credentials
    ),

  updatedAt:
    new Date()
      .toISOString()
};

await saveManagedAccounts(
  memberships
);


      return res.json({
        ok: true,

        message:
          "Free membership updated successfully."
      });

    } catch (error) {
      console.error(
        "Admin free membership update error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to update free membership."
        });
    }
  }
);


app.post(
  "/api/admin/free-memberships/:id/assign",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        clean(
          req.params.id,
          150
        );

      const customerAccountId =
        clean(
          req.body
            ?.customerAccountId,
          150
        );

      const durationType =
        normalizeSpecialProfileDuration(
          req.body?.durationType
        );

      if (!customerAccountId) {
        return res
          .status(400)
          .json({
            error:
              "Choose a paid customer."
          });
      }

      if (!durationType) {
        return res
          .status(400)
          .json({
            error:
              "Choose a valid free membership duration."
          });
      }

      const memberships =
        await getManagedAccounts();

      const linkedIds =
        new Set();

      for (
        const assignment of
        [
          ...(
            await getFreeAssignments()
          ),
          ...(
            await getRentalAssignments()
          )
        ]
      ) {
        if (
          managedAssignmentIsLinked(
            assignment
          )
        ) {
          linkedIds.add(
            String(
              assignment.managedAccountId ||
              assignment.freeMembershipId ||
              assignment.rentedMembershipId ||
              ""
            )
          );
        }
      }

      const duplicateState =
        managedDuplicateCredentialState(
          memberships,
          linkedIds
        );

      if (
        duplicateState
          .duplicateIds
          .has(
            String(
              id
            )
          )
      ) {
        return res
          .status(409)
          .json({
            error:
              "This managed profile has the exact same retailer username/password as another managed profile and is quarantined from assignment. Delete or correct the duplicate first."
          });
      }

      const membership =
        memberships.find(
          item =>
            String(
              item.id
            ) === id
        );

      if (!membership) {
        return res
          .status(404)
          .json({
            error:
              "Free membership could not be found."
          });
      }

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const paidRecords =
        Array.isArray(paid)
          ? paid
          : [];

      const paidRecord = await activeMembershipRecordForCustomer(customerAccountId, paidRecords);

      if (!paidRecord) {
        return res
          .status(403)
          .json({
            error:
              "Free managed memberships require an active paid or gifted tier."
          });
      }

      const assignments =
        await getFreeAssignments();

      const existingActive =
        currentFreeAssignment(
          assignments,
          id
        );

      const rentalAssignments =
        await getRentalAssignments();

      const activeRental =
        currentRentalAssignment(
          rentalAssignments,
          id
        );

      if (activeRental) {
        return res
          .status(409)
          .json({
            error:
              "This managed account is already being used as a rental."
          });
      }

      if (
        existingActive &&
        existingActive
          .customerAccountId !==
          customerAccountId
      ) {
        return res
          .status(409)
          .json({
            error:
              "This free membership is already assigned to another customer."
          });
      }

      const restoreHoldOwner =
        await managedAccountRestoreHoldOwner(
          id
        );

      if (
        restoreHoldOwner &&
        (
          String(
            restoreHoldOwner.customerAccountId
          ) !==
            String(
              customerAccountId
            ) ||
          restoreHoldOwner.type !==
            "free"
        )
      ) {
        return res
          .status(409)
          .json({
            error:
              "This managed account is currently reserved on another customer's 7-day Restore Hold."
          });
      }

      const now =
        new Date();

      if (existingActive) {
        existingActive
          .customerAccountId =
          customerAccountId;

        existingActive
          .paidSubmissionId =
          paidRecord.id;

        const wasActivated =
          String(
            existingActive.activationStatus ||
            ""
          ) ===
          "activated";

        if (wasActivated) {
          const extensionBase =
            existingActive.expiresAt &&
            new Date(
              existingActive.expiresAt
            ).getTime() >
              now.getTime()
              ? new Date(
                  existingActive.expiresAt
                )
              : now;

          existingActive.durationType =
            durationType;

          existingActive.expiresAt =
            specialProfileExpiresAt(
              durationType,
              extensionBase
            );

          existingActive.updatedAt =
            now.toISOString();

        } else {
          prepareManagedAssignmentForActivation(
            existingActive,
            durationType,
            now
          );
        }

      } else {
        assignments.push({
          id:
            crypto.randomUUID(),

          freeMembershipId:
            id,

          managedAccountId:
            id,

          customerAccountId,

          paidSubmissionId:
            paidRecord.id,

          active:
            true,

          durationType,

          activationStatus:
            "awaiting_activation",

          activationRequestedAt:
            now.toISOString(),

          startsAt:
            null,

          expiresAt:
            null,

          createdAt:
            now.toISOString(),

          updatedAt:
            now.toISOString(),

          endedAt:
            null,

          endReason:
            null
        });
        const customerAccount = (await getCustomerAccounts()).find(item => String(item.id) === String(customerAccountId));
        await prepareNewManagedAssignment(assignments.at(-1), membership, customerAccount, paidRecord);
      }

      await saveFreeAssignments(
        assignments
      );

      await consumeRestoreHoldItems(
        customerAccountId,
        "free",
        [id]
      );

      const current =
        currentFreeAssignment(
          assignments,
          id
        );

      if (
        current &&
        current.activationStatus ===
          "awaiting_activation"
      ) {
        const discordChanged =
          await ensureManagedProfileDiscordMessage(
            current,
            "free"
          );

        if (discordChanged) {
          await saveFreeAssignments(
            assignments
          );
        }
      }

      return res.json({
        ok: true,

        message:
          "Free membership assigned successfully."
      });

    } catch (error) {
      console.error(
        "Admin free membership assignment error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to assign free membership."
        });
    }
  }
);


app.post(
  "/api/admin/free-memberships/:id/end",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        clean(
          req.params.id,
          150
        );

      const assignments =
        await getFreeAssignments();

      const assignment =
        currentFreeAssignment(
          assignments,
          id
        );

      if (!assignment) {
        return res
          .status(404)
          .json({
            error:
              "This free membership is not currently assigned."
          });
      }

      const now =
        new Date()
          .toISOString();

      clearManagedAssignmentCustomerData(
        assignment,
        {
          reason:
            "returned_to_pool",

          nowIso:
            now
        }
      );

      await saveFreeAssignments(
        assignments
      );

      return res.json({
        ok: true,

        message:
          "Free membership ended and returned to the available pool."
      });

    } catch (error) {
      console.error(
        "Admin free membership end error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to end free membership."
        });
    }
  }
);

/* -------------------------------------------------------
   ADMIN MANAGED MEMBERSHIP AUTO POPULATE
------------------------------------------------------- */

app.post(
  "/api/admin/managed-memberships/:type/:id/auto-populate",
  requireAdmin,
  async (req, res) => {
    try {
      const type =
        String(
          req.params.type ||
          ""
        )
          .trim()
          .toLowerCase();

      const id =
        clean(
          req.params.id,
          150
        );

      const customerAccountId =
        clean(
          req.body
            ?.customerAccountId,
          150
        );

      if (
        ![
          "free",
          "rented"
        ].includes(type)
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid managed membership type."
          });
      }

      if (!customerAccountId) {
        return res
          .status(400)
          .json({
            error:
              "Choose a paid customer first."
          });
      }

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const paidRecords =
        Array.isArray(paid)
          ? paid
          : [];

      const paidRecord = await activeMembershipRecordForCustomer(customerAccountId, paidRecords);

      if (!paidRecord) {
        return res
          .status(404)
          .json({
            error:
              "An active paid or gifted tier could not be found for this customer."
          });
      }

      const accounts =
        await getCustomerAccounts();

      const account =
        accounts.find(
          item =>
            item.id ===
            customerAccountId
        );

      const savedProfile =
        account?.adminProfile &&
        typeof account.adminProfile ===
          "object"
          ? account.adminProfile
          : {};

      const paidProfile =
        paidRecord.profile &&
        typeof paidRecord.profile ===
          "object"
          ? paidRecord.profile
          : {};

      /*
        Prefer the information submitted
        with the paid subscription.

        Fall back to saved Admin profile
        information when necessary.
      */

      const customerProfile =
        sanitizeProfile({
          profileName:
            paidProfile.profileName ||
            savedProfile.profileName ||
            "",

          firstName:
            paidProfile.firstName ||
            savedProfile.firstName ||
            "",

          lastName:
            paidProfile.lastName ||
            savedProfile.lastName ||
            "",

          email:
            paidProfile.email ||
            savedProfile.email ||
            account?.email ||
            "",

          phone:
            paidProfile.phone ||
            savedProfile.phone ||
            "",

          address:
            paidProfile.address ||
            savedProfile.address ||
            "",

          address2:
            paidProfile.address2 ||
            savedProfile.address2 ||
            "",

          country:
            paidProfile.country ||
            savedProfile.country ||
            "",

          state:
            paidProfile.state ||
            savedProfile.state ||
            "",

          city:
            paidProfile.city ||
            savedProfile.city ||
            "",

          zip:
            paidProfile.zip ||
            savedProfile.zip ||
            ""
        });

      /*
        Load the customer's sensitive
        ACO/card information from the
        encrypted paid-order package.

        It stays encrypted when copied
        into the managed membership.
      */

      const paidSecrets = await membershipEncryptedPackage(paidRecord);

      let memberships;

      if (type === "free") {
        memberships =
          await getManagedAccounts();
      } else {
        memberships =
          await getManagedAccounts();
      }

      const index =
        memberships.findIndex(
          membership =>
            String(
              membership.id
            ) === id
        );

      if (index < 0) {
        return res
          .status(404)
          .json({
            error:
              `${
                type === "free"
                  ? "Free"
                  : "Rented"
              } membership could not be found.`
          });
      }

const assignments =
  type === "free"
    ? await getFreeAssignments()
    : await getRentalAssignments();

const assignment =
  type === "free"
    ? currentFreeAssignment(
        assignments,
        id
      )
    : currentRentalAssignment(
        assignments,
        id
      );

if (!assignment) {
  return res
    .status(400)
    .json({
      error:
        `Start the ${
          type === "free"
            ? "free"
            : "rented"
        } membership before using Auto Populate.`
    });
}

if (
  String(
    assignment.customerAccountId ||
    ""
  ) !==
  String(customerAccountId)
) {
  return res
    .status(409)
    .json({
      error:
        "This membership is assigned to a different customer."
    });
}

const now =
  new Date()
    .toISOString();

assignment.customerProfile =
  customerProfile;

assignment.customerSecrets =
  paidSecrets
    ? encryptJson(
        paidSecrets
      )
    : (
        assignment.customerSecrets ||
        null
      );

assignment.sourcePaidSubmissionId =
  paidRecord.id;

assignment.autoPopulatedAt =
  now;

assignment.updatedAt =
  now;

if (type === "free") {
  await saveFreeAssignments(
    assignments
  );
} else {
  await saveRentalAssignments(
    assignments
  );
}

      return res.json({
        ok: true,

        customerProfile,

        message:
          `${
            type === "free"
              ? "Free"
              : "Rented"
          } membership auto populated successfully.`
      });

    } catch (error) {
      console.error(
        "Managed membership auto populate error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to auto populate the managed membership."
        });
    }
  }
);

/* -------------------------------------------------------
   ADMIN RENTED MEMBERSHIPS
------------------------------------------------------- */

app.get(
  "/api/admin/rented-memberships",
  requireAdmin,
  async (req, res) => {
    try {
      const memberships =
        await getManagedAccounts();

      const assignments =
        await getRentalAssignments();

      const otherAssignments =
        await getFreeAssignments();

      const accounts =
        await getCustomerAccounts();

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const paidRecords =
        Array.isArray(paid)
          ? paid
          : [];

      let assignmentsChanged =
        false;

      const now =
        new Date();

      /*
        Automatically expire rental assignments
        whose end date has passed.
      */

      for (
        const assignment of
        assignments
      ) {
        if (
          assignment.active !== true ||
          String(
            assignment.activationStatus ||
            ""
          ) !==
            "activated" ||
          !assignment.expiresAt
        ) {
          continue;
        }

        const expiresAt =
          new Date(
            assignment.expiresAt
          );

        if (
          !Number.isNaN(
            expiresAt.getTime()
          ) &&
          expiresAt.getTime() <=
            now.getTime()
        ) {
          clearManagedAssignmentCustomerData(
            assignment,
            {
              reason:
                "expired",
              nowIso:
                now.toISOString()
            }
          );

          assignmentsChanged =
            true;
        }
      }

      if (assignmentsChanged) {
        await saveRentalAssignments(
          assignments
        );
      }

      /*
        Only ACTIVE PAID SUBSCRIPTIONS may
        receive a rented membership.
      */

      const paidCustomerMap =
        new Map();

      for (
        const record of
        paidRecords
      ) {
        if (
          !record.customerAccountId ||
          !subscriptionAllowsProfiles(
            record
          )
        ) {
          continue;
        }

        const existing =
          paidCustomerMap.get(
            record.customerAccountId
          );

        if (!existing) {
          paidCustomerMap.set(
            record.customerAccountId,
            record
          );
        }
      }

      const paidCustomers =
        Array.from(
          paidCustomerMap.values()
        ).map(record => {
          const account =
            accounts.find(
              item =>
                item.id ===
                record.customerAccountId
            );

          const savedProfile =
            account?.adminProfile &&
            typeof account.adminProfile ===
              "object"
              ? account.adminProfile
              : {};

          const paidProfile =
            record.profile &&
            typeof record.profile ===
              "object"
              ? record.profile
              : {};

          const customerName =
            [
              savedProfile.firstName ||
                paidProfile.firstName ||
                "",
              savedProfile.lastName ||
                paidProfile.lastName ||
                ""
            ]
              .filter(Boolean)
              .join(" ") ||
            savedProfile.profileName ||
            paidProfile.profileName ||
            "Customer";

          return {
            customerAccountId:
              record.customerAccountId,

            paidSubmissionId:
              record.id,

            name:
              customerName,

            email:
              account?.email ||
              savedProfile.email ||
              paidProfile.email ||
              "",

            subscriptionStatus:
              record.subscriptionStatus ||
              null,

            currentPeriodEnd:
              record.currentPeriodEnd ||
              null
          };
        });

      const result =
        memberships
          .filter(
            membership =>
              Boolean(
                linkedRentalAssignment(
                  assignments,
                  membership.id
                )
              )
          )
          .map(
          membership => {
            const assignment =
              linkedRentalAssignment(
                assignments,
                membership.id
              );

            const otherAssignment =
              linkedFreeAssignment(
                otherAssignments,
                membership.id
              );

            let assignedCustomer =
              null;

            if (assignment) {
              const account =
                accounts.find(
                  item =>
                    item.id ===
                    assignment
                      .customerAccountId
                );

              const paidRecord =
                paidRecords.find(
                  item =>
                    item.customerAccountId ===
                      assignment
                        .customerAccountId &&
                    subscriptionAllowsProfiles(
                      item
                    )
                );

              const savedProfile =
                account?.adminProfile &&
                typeof account.adminProfile ===
                  "object"
                  ? account.adminProfile
                  : {};

              const paidProfile =
                paidRecord?.profile &&
                typeof paidRecord.profile ===
                  "object"
                  ? paidRecord.profile
                  : {};

              assignedCustomer = {
                customerAccountId:
                  assignment
                    .customerAccountId,

                paidSubmissionId:
                  paidRecord?.id ||
                  null,

                name:
                  [
                    savedProfile.firstName ||
                      paidProfile.firstName ||
                      "",
                    savedProfile.lastName ||
                      paidProfile.lastName ||
                      ""
                  ]
                    .filter(Boolean)
                    .join(" ") ||
                  savedProfile.profileName ||
                  paidProfile.profileName ||
                  "Customer",

                email:
                  account?.email ||
                  savedProfile.email ||
                  paidProfile.email ||
                  ""
              };
            }

            let retailers =
  emptyRetailerCredentials();

try {
  if (
    membership.credentials
  ) {
    retailers =
      normalizeRetailerCredentials(
        decryptJson(
          membership.credentials
        )
      );
  }
} catch (error) {
  console.error(
    "Rented membership decrypt error:",
    membership.id,
    error.message
  );
}

let customerSecrets =
  null;

try {
  if (
    assignment?.customerSecrets
  ) {
    customerSecrets =
      decryptJson(
        assignment.customerSecrets
      );
  }
} catch (error) {
  console.error(
    "Rented membership customer data decrypt error:",
    membership.id,
    error.message
  );
}
            
            const readiness =
              managedProfileReadiness(
                assignment?.customerProfile ||
                {},
                customerSecrets ||
                {}
              );

            const exactAddressMatches =
              exactManagedAddressMatches(
                assignment?.customerProfile ||
                {},
                membership.id,
                memberships,
                otherAssignments,
                assignments
              );

            return {
              id:
                membership.id,

              profileName:
                membership.profileName ||
                "RENTED MEMBERSHIP",

              accountEmail:
  membership.accountEmail ||
  "",

              displayEmail:
                managedAccountCanonicalEmail(
                  membership,
                  retailers
                ),

              notes:
                membership.notes ||
                "",

              createdAt:
                membership.createdAt ||
                null,

              updatedAt:
                membership.updatedAt ||
                null,

              active:
                Boolean(
                  assignment
                ),

              status:
                assignment
                  ? "active"
                  : (
                      otherAssignment
                        ? "occupied"
                        : "inactive"
                    ),

              occupiedByOtherType:
                Boolean(
                  otherAssignment
                ),

              occupiedType:
                otherAssignment
                  ? "free"
                  : null,

              assignment:
                assignment
                  ? {
                      id:
                        assignment.id,

                      customerAccountId:
                        assignment
                          .customerAccountId,

                      startsAt:
                        assignment.startsAt ||
                        null,

                      expiresAt:
                        assignment.expiresAt ||
                        null,

                      durationType:
                        assignment.durationType ||
                        null,

                      activationStatus:
                        managedAssignmentStatus(
                          assignment
                        ),

                      activationLabel:
                        profileActivationLabel(
                          assignment.activationStatus
                        ),

                      daysRemaining:
                        rentalAssignmentDaysRemaining(
                          assignment
                        ),

                      stripeSubscriptionId:
                        assignment
                          .stripeSubscriptionId ||
                        null
                    }
                  : null,

             assignedCustomer,

retailers,

customerProfile:
  assignment?.customerProfile ||
  null,

customerSecrets,

              readiness,

              exactAddressMatches,

              jiggedAddress:
                assignment?.jiggedAddress ||
                null,

              jigVariantNumber:
                assignment?.jigVariantIndex ||
                null
            };
          }
        );

      const [
        availableMemberships,
        restoreHolds
      ] = await Promise.all([
        getAvailableManagedMembershipRecords(),
        getRestoreHolds()
      ]);

      const activeRestoreHolds =
        activeRestoreHoldsFor(
          restoreHolds,
          {
            type:
              "rented"
          }
        ).map(
          hold => ({
            id:
              hold.id,

            customerAccountId:
              hold.customerAccountId,

            type:
              hold.type,

            holdUntil:
              hold.holdUntil,

            count:
              restoreHoldRemainingItems(
                hold
              ).length,

            customerName:
              (
                paidCustomers.find(
                  customer =>
                    String(
                      customer.customerAccountId ||
                      ""
                    ) ===
                      String(
                        hold.customerAccountId ||
                        ""
                      )
                )?.name
              ) ||
              (
                accounts.find(
                  account =>
                    String(
                      account.id
                    ) ===
                      String(
                        hold.customerAccountId ||
                        ""
                      )
                )?.email
              ) ||
              "Customer",

            customerEmail:
              (
                paidCustomers.find(
                  customer =>
                    String(
                      customer.customerAccountId ||
                      ""
                    ) ===
                      String(
                        hold.customerAccountId ||
                        ""
                      )
                )?.email
              ) ||
              (
                accounts.find(
                  account =>
                    String(
                      account.id
                    ) ===
                      String(
                        hold.customerAccountId ||
                        ""
                      )
                )?.email
              ) ||
              "",

            canRestore:
              paidCustomers.some(
                customer =>
                  String(
                    customer.customerAccountId ||
                    ""
                  ) ===
                    String(
                      hold.customerAccountId ||
                      ""
                    )
              )
          })
        );

      return res.json({
        ok: true,

        memberships:
          result,

        paidCustomers,

        availableMemberships,

        restoreHolds:
          activeRestoreHolds
      });

    } catch (error) {
      console.error(
        "Admin rented membership list error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to load rented memberships."
        });
    }
  }
);


app.post(
  "/api/admin/rented-memberships",
  requireAdmin,
  async (req, res) => {
    try {
      const profileName =
        clean(
          req.body?.profileName,
          100
        ) ||
        "RENTED MEMBERSHIP";

      const accountEmail =
  clean(
    req.body?.accountEmail,
    200
  );

      const notes =
        clean(
          req.body?.notes,
          500
        );

      const submitted =
        req.body?.retailers &&
        typeof req.body.retailers ===
          "object"
          ? req.body.retailers
          : {};

      const credentials =
        emptyRetailerCredentials();

      for (
        const retailer of
        RETAILER_KEYS
      ) {
        const submittedRetailer =
          submitted[retailer] &&
          typeof submitted[
            retailer
          ] === "object"
            ? submitted[
                retailer
              ]
            : {};

        const username =
          clean(
            submittedRetailer
              .username,
            254
          );

        const password =
          String(
            submittedRetailer
              .password ||
            ""
          );

        if (
          password.length >
          512
        ) {
          return res
            .status(400)
            .json({
              error:
                "A retailer password is too long."
            });
        }

        credentials[
          retailer
        ] = {
          username,
          password
        };
      }

      const memberships =
        await getManagedAccounts();


      const duplicateCredential =
        managedCredentialConflict(
          memberships,
          credentials
        );

      if (
        duplicateCredential
      ) {
        return res
          .status(409)
          .json({
            error:
              `Duplicate managed profile blocked. The exact ${duplicateCredential.retailer} username/password is already stored on another managed profile.`
          });
      }

      const now =
        new Date()
          .toISOString();

      const record = {
        id:
          crypto.randomUUID(),

        profileName,

        accountEmail,

        notes,

        credentials:
          encryptJson(
            credentials
          ),

        createdAt:
          now,

        updatedAt:
          now
      };

      memberships.push(
        record
      );

      await saveManagedAccounts(
        memberships
      );

      return res.json({
        ok: true,

        id:
          record.id,

        message:
          "Rented membership created successfully."
      });

    } catch (error) {
      console.error(
        "Admin rented membership create error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to create rented membership."
        });
    }
  }
);


app.put(
  "/api/admin/rented-memberships/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        clean(
          req.params.id,
          150
        );

      const memberships =
        await getManagedAccounts();

      const index =
        memberships.findIndex(
          membership =>
            String(
              membership.id
            ) === id
        );

      if (index < 0) {
        return res
          .status(404)
          .json({
            error:
              "Rented membership could not be found."
          });
      }

      const existing =
        memberships[
          index
        ];

      const profileName =
        clean(
          req.body?.profileName,
          100
        ) ||
        existing.profileName ||
        "RENTED MEMBERSHIP";

      const accountEmail =
  clean(
    req.body?.accountEmail,
    200
  );

      const notes =
        clean(
          req.body?.notes,
          500
        );

      let existingCredentials =
        emptyRetailerCredentials();

      try {
        if (
          existing.credentials
        ) {
          existingCredentials =
            normalizeRetailerCredentials(
              decryptJson(
                existing.credentials
              )
            );
        }
      } catch (error) {
        console.error(
          "Existing rented membership decrypt error:",
          error.message
        );
      }


      const submitted =
        req.body?.retailers &&
        typeof req.body.retailers ===
          "object"
          ? req.body.retailers
          : {};

      const credentials =
        emptyRetailerCredentials();

      for (
        const retailer of
        RETAILER_KEYS
      ) {
        const submittedRetailer =
          submitted[retailer] &&
          typeof submitted[
            retailer
          ] === "object"
            ? submitted[
                retailer
              ]
            : {};

        const username =
          clean(
            submittedRetailer
              .username,
            254
          );

        const password =
          String(
            submittedRetailer
              .password ||
            ""
          );

        if (
          password.length >
          512
        ) {
          return res
            .status(400)
            .json({
              error:
                "A retailer password is too long."
            });
        }

        credentials[
          retailer
        ] = {
          username,

          password:
            password ||
            existingCredentials[
              retailer
            ]?.password ||
            ""
        };
      }

            const duplicateCredential =
        managedCredentialConflict(
          memberships,
          credentials,
          id
        );

      if (
        duplicateCredential
      ) {
        return res
          .status(409)
          .json({
            error:
              `Duplicate managed profile blocked. The exact ${duplicateCredential.retailer} username/password is already stored on another managed profile.`
          });
      }


memberships[
        index
      ] = {
        ...existing,
        
        accountEmail:
  accountEmail ||
  existing.accountEmail ||
  "",

        profileName,

        notes,

        credentials:
          encryptJson(
            credentials
          ),

        updatedAt:
          new Date()
            .toISOString()
      };

      await saveManagedAccounts(
        memberships
      );

      return res.json({
        ok: true,

        message:
          "Rented membership updated successfully."
      });

    } catch (error) {
      console.error(
        "Admin rented membership update error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to update rented membership."
        });
    }
  }
);


app.post(
  "/api/admin/rented-memberships/:id/assign",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        clean(
          req.params.id,
          150
        );

      const customerAccountId =
        clean(
          req.body
            ?.customerAccountId,
          150
        );

      const durationType =
        normalizeSpecialProfileDuration(
          req.body?.durationType
        );

      if (
        !customerAccountId
      ) {
        return res
          .status(400)
          .json({
            error:
              "Choose a paid customer."
          });
      }

      if (!durationType) {
        return res
          .status(400)
          .json({
            error:
              "Choose a valid rental duration."
          });
      }

      const memberships =
        await getManagedAccounts();

      const linkedIds =
        new Set();

      for (
        const assignment of
        [
          ...(
            await getFreeAssignments()
          ),
          ...(
            await getRentalAssignments()
          )
        ]
      ) {
        if (
          managedAssignmentIsLinked(
            assignment
          )
        ) {
          linkedIds.add(
            String(
              assignment.managedAccountId ||
              assignment.freeMembershipId ||
              assignment.rentedMembershipId ||
              ""
            )
          );
        }
      }

      const duplicateState =
        managedDuplicateCredentialState(
          memberships,
          linkedIds
        );

      if (
        duplicateState
          .duplicateIds
          .has(
            String(
              id
            )
          )
      ) {
        return res
          .status(409)
          .json({
            error:
              "This managed profile has the exact same retailer username/password as another managed profile and is quarantined from assignment. Delete or correct the duplicate first."
          });
      }

      const membership =
        memberships.find(
          item =>
            String(
              item.id
            ) === id
        );

      if (!membership) {
        return res
          .status(404)
          .json({
            error:
              "Rented membership could not be found."
          });
      }

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const paidRecords =
        Array.isArray(paid)
          ? paid
          : [];

      const paidRecord = await activeMembershipRecordForCustomer(customerAccountId, paidRecords);

      if (!paidRecord) {
        return res
          .status(403)
          .json({
            error:
              "Rented memberships require an active paid or gifted tier."
          });
      }

      const assignments =
        await getRentalAssignments();

      const existingActive =
        currentRentalAssignment(
          assignments,
          id
        );

      const freeAssignments =
        await getFreeAssignments();

      const activeFree =
        currentFreeAssignment(
          freeAssignments,
          id
        );

      if (activeFree) {
        return res
          .status(409)
          .json({
            error:
              "This managed account is already being used as a free membership."
          });
      }

      if (
        existingActive &&
        existingActive
          .customerAccountId !==
          customerAccountId
      ) {
        return res
          .status(409)
          .json({
            error:
              "This rented membership is already assigned to another customer."
          });
      }

      const restoreHoldOwner =
        await managedAccountRestoreHoldOwner(
          id
        );

      if (
        restoreHoldOwner &&
        (
          String(
            restoreHoldOwner.customerAccountId
          ) !==
            String(
              customerAccountId
            ) ||
          restoreHoldOwner.type !==
            "rented"
        )
      ) {
        return res
          .status(409)
          .json({
            error:
              "This managed account is currently reserved on another customer's 7-day Restore Hold."
          });
      }

      const now =
        new Date();

      if (existingActive) {
        existingActive
          .customerAccountId =
          customerAccountId;

        existingActive
          .paidSubmissionId =
          paidRecord.id;

        const wasActivated =
          String(
            existingActive.activationStatus ||
            ""
          ) ===
          "activated";

        if (wasActivated) {
          const extensionBase =
            existingActive.expiresAt &&
            new Date(
              existingActive.expiresAt
            ).getTime() >
              now.getTime()
              ? new Date(
                  existingActive.expiresAt
                )
              : now;

          existingActive.durationType =
            durationType;

          existingActive.expiresAt =
            specialProfileExpiresAt(
              durationType,
              extensionBase
            );

          existingActive.updatedAt =
            now.toISOString();

        } else {
          prepareManagedAssignmentForActivation(
            existingActive,
            durationType,
            now
          );
        }

      } else {
        assignments.push({
          id:
            crypto.randomUUID(),

          rentedMembershipId:
            id,

          managedAccountId:
            id,

          customerAccountId,

          paidSubmissionId:
            paidRecord.id,

          active:
            true,

          durationType,

          activationStatus:
            "awaiting_activation",

          activationRequestedAt:
            now.toISOString(),

          startsAt:
            null,

          expiresAt:
            null,

          stripeSubscriptionId:
            null,

          stripeCustomerId:
            paidRecord
              .stripeCustomerId ||
            null,

          createdAt:
            now.toISOString(),

          updatedAt:
            now.toISOString(),

          endedAt:
            null,

          endReason:
            null
        });
        const customerAccount = (await getCustomerAccounts()).find(item => String(item.id) === String(customerAccountId));
        await prepareNewManagedAssignment(assignments.at(-1), membership, customerAccount, paidRecord);
      }

      await saveRentalAssignments(
        assignments
      );

      await consumeRestoreHoldItems(
        customerAccountId,
        "rented",
        [id]
      );

      const current =
        currentRentalAssignment(
          assignments,
          id
        );

      if (
        current &&
        current.activationStatus ===
          "awaiting_activation"
      ) {
        const discordChanged =
          await ensureManagedProfileDiscordMessage(
            current,
            "rented"
          );

        if (discordChanged) {
          await saveRentalAssignments(
            assignments
          );
        }
      }

      return res.json({
        ok: true,

        message:
          "Rented membership assigned successfully."
      });

    } catch (error) {
      console.error(
        "Admin rented membership assignment error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to assign rented membership."
        });
    }
  }
);


app.post(
  "/api/admin/rented-memberships/:id/end",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        clean(
          req.params.id,
          150
        );

      const assignments =
        await getRentalAssignments();

      const assignment =
        currentRentalAssignment(
          assignments,
          id
        );

      if (!assignment) {
        return res
          .status(404)
          .json({
            error:
              "This rented membership is not currently assigned."
          });
      }

      const now =
        new Date()
          .toISOString();

      clearManagedAssignmentCustomerData(
        assignment,
        {
          reason:
            "returned_to_pool",

          nowIso:
            now
        }
      );

      await saveRentalAssignments(
        assignments
      );

      return res.json({
        ok: true,

        message:
          "Rented membership ended and returned to the available pool."
      });

    } catch (error) {
      console.error(
        "Admin rented membership end error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to end rented membership."
        });
    }
  }
);


/* -------------------------------------------------------
   ADMIN LINKED MANAGED PROFILES / SAVED DETAILS
------------------------------------------------------- */

function managedRetailerCredentialsForAdmin(
  membership
) {
  let retailers =
    emptyRetailerCredentials();

  try {
    if (membership?.credentials) {
      retailers =
        normalizeRetailerCredentials(
          decryptJson(
            membership.credentials
          )
        );
    }
  } catch (error) {
    console.error(
      "Managed credential decrypt failed:",
      membership?.id,
      error.message
    );
  }

  return retailers;
}


app.put(
  "/api/admin/submissions/:submissionId/linked-memberships/:type/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const submissionId =
        clean(
          req.params.submissionId,
          150
        );

      const type =
        clean(
          req.params.type,
          20
        );

      const id =
        clean(
          req.params.id,
          150
        );

      if (
        type !== "free" &&
        type !== "rented"
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid linked profile type."
          });
      }

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const paidRecords =
        Array.isArray(paid)
          ? paid
          : [];

      const paidRecord =
        paidRecords.find(
          record =>
            String(record.id) ===
            String(submissionId)
        );

      if (!paidRecord) {
        return res
          .status(404)
          .json({
            error:
              "Customer submission could not be found."
          });
      }

      const assignments =
        type === "free"
          ? await getFreeAssignments()
          : await getRentalAssignments();

      const assignment =
        type === "free"
          ? linkedFreeAssignment(
              assignments,
              id
            )
          : linkedRentalAssignment(
              assignments,
              id
            );

      if (!assignment) {
        return res
          .status(404)
          .json({
            error:
              "This linked profile is no longer assigned to this customer."
          });
      }

      if (
        String(
          assignment.customerAccountId ||
          ""
        ) !==
        String(
          paidRecord.customerAccountId ||
          ""
        )
      ) {
        return res
          .status(403)
          .json({
            error:
              "This linked profile does not belong to this customer."
          });
      }

      const customerProfile =
        sanitizeProfile({
          profileName:
            clean(
              req.body?.profileName ||
              assignment.customerProfile
                ?.profileName ||
              "",
              150
            ),

          firstName:
            req.body?.firstName,

          lastName:
            req.body?.lastName,

          email:
            req.body?.email,

          phone:
            req.body?.phone,

          address:
            req.body?.address,

          address2:
            req.body?.address2,

          country:
            req.body?.country,

          state:
            req.body?.state,

          city:
            req.body?.city,

          zip:
            req.body?.zip
        });

      const customerSecrets =
        sanitizeSecrets({
          acoEmail:
            req.body?.acoEmail,

          acoPassword:
            req.body?.acoPassword,

          cardLabel:
            req.body?.cardLabel,

          cardholder:
            req.body?.cardholder,

          acoCardNumber:
            req.body?.acoCardNumber,

          expMonth:
            req.body?.expMonth,

          expYear:
            req.body?.expYear,

          securityCode:
            req.body?.securityCode
        });

      assignment.customerProfile =
        customerProfile;

      assignment.customerSecrets =
        encryptJson(
          customerSecrets
        );

      assignment.updatedAt =
        new Date()
          .toISOString();

      /*
        If Admin manually edits the address after a JIG, the manual
        edit becomes authoritative and the old JIG metadata is cleared.
      */
      delete assignment.jiggedAddress;
      delete assignment.jigVariantIndex;
      delete assignment.jigSourceKey;
      delete assignment.jigSourceAddress;

      /*
        Keep jigHistoryKeys so previously generated exact JIGs
        stay unavailable even after manual editing.
      */

      if (type === "free") {
        await saveFreeAssignments(
          assignments
        );
      } else {
        await saveRentalAssignments(
          assignments
        );
      }

      if (
        assignment.customerAccountId
      ) {
        await syncCustomerMissingNotification(
          assignment.customerAccountId
        );
      }

      return res.json({
        ok: true,
        customerProfile,

        customerCard: {
          cardLabel:
            customerSecrets.cardLabel ||
            "",

          cardholder:
            customerSecrets.cardholder ||
            "",

          cardNumber:
            customerSecrets.acoCardNumber ||
            "",

          maskedNumber:
            customerSecrets.acoCardNumber
              ? `•••• •••• •••• ${customerSecrets.acoCardNumber.slice(-4)}`
              : "",

          expMonth:
            customerSecrets.expMonth ||
            "",

          expYear:
            customerSecrets.expYear ||
            "",

          securityCode:
            customerSecrets.securityCode ||
            ""
        }
      });

    } catch (error) {
      console.error(
        "Linked profile update error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to update linked profile information."
        });
    }
  }
);




async function restoreHeldManagedAccountsForCustomer(
  customerAccountId,
  type
) {
  if (
    !customerAccountId ||
    ![
      "free",
      "rented"
    ].includes(type)
  ) {
    throw new Error(
      "Invalid Restore Hold request."
    );
  }

  const holds =
    await getRestoreHolds();

  const candidateItems =
    activeRestoreHoldsFor(
      holds,
      {
        customerAccountId,
        type
      }
    ).flatMap(
      hold =>
        restoreHoldRemainingItems(
          hold
        )
    );

  if (!candidateItems.length) {
    return {
      restored:
        0,
      managedAccountIds:
        []
    };
  }

  const paid =
    await readJson(
      PAID_FILE,
      []
    );

  const paidRecords =
    Array.isArray(paid)
      ? paid
      : [];

  const paidRecord = await activeMembershipRecordForCustomer(customerAccountId, paidRecords);

  if (!paidRecord) {
    throw new Error(
      "This customer does not currently have an active paid or gifted tier."
    );
  }

  const [
    managedAccounts,
    freeAssignments,
    rentalAssignments
  ] = await Promise.all([
    getManagedAccounts(),
    getFreeAssignments(),
    getRentalAssignments()
  ]);

  const usedIds =
    new Set();

  for (
    const assignment of
    [
      ...freeAssignments,
      ...rentalAssignments
    ]
  ) {
    if (
      managedAssignmentIsLinked(
        assignment
      )
    ) {
      usedIds.add(
        managedAssignmentMembershipId(
          assignment
        )
      );
    }
  }

  const duplicateState =
    managedDuplicateCredentialState(
      managedAccounts,
      usedIds
    );

  const currentManagedIds =
    new Set(
      managedAccounts.map(
        item =>
          String(
            item.id
          )
      )
    );

  const customerProfile =
    sanitizeProfile(
      paidRecord.profile ||
      {}
    );

  const paidSecrets = await membershipEncryptedPackage(paidRecord);

  const now =
    new Date();

  const targetAssignments =
    type === "free"
      ? freeAssignments
      : rentalAssignments;

  const restoredIds = [];

  for (
    const item of
    candidateItems
  ) {
    const managedAccountId =
      String(
        item.managedAccountId ||
        ""
      );

    if (
      !managedAccountId ||
      !currentManagedIds.has(
        managedAccountId
      ) ||
      usedIds.has(
        managedAccountId
      ) ||
      duplicateState
        .duplicateIds
        .has(
          managedAccountId
        )
    ) {
      continue;
    }

    const durationType =
      normalizeSpecialProfileDuration(
        item.durationType
      ) ||
      "1_week";

    const assignment = {
      id:
        crypto.randomUUID(),

      managedAccountId,

      customerAccountId,

      paidSubmissionId:
        paidRecord.id,

      active:
        true,

      durationType,

      activationStatus:
        "awaiting_activation",

      activationRequestedAt:
        now.toISOString(),

      startsAt:
        null,

      expiresAt:
        null,

      customerProfile,

      customerSecrets:
        paidSecrets
          ? encryptJson(
              paidSecrets
            )
          : null,

      createdAt:
        now.toISOString(),

      updatedAt:
        now.toISOString(),

      endedAt:
        null,

      endReason:
        null
    };

    if (
      type === "free"
    ) {
      assignment.freeMembershipId =
        managedAccountId;

      assignment.assignmentRetailer =
        item.retailer ||
        null;

    } else {
      assignment.rentedMembershipId =
        managedAccountId;

      assignment.rentalRetailer =
        item.retailer ||
        null;

      assignment.stripeSubscriptionId =
        null;

      assignment.stripeCustomerId =
        paidRecord.stripeCustomerId ||
        null;
    }

    targetAssignments.push(
      assignment
    );

    usedIds.add(
      managedAccountId
    );

    restoredIds.push(
      managedAccountId
    );
  }

  if (
    type === "free"
  ) {
    await saveFreeAssignments(
      freeAssignments
    );
  } else {
    await saveRentalAssignments(
      rentalAssignments
    );
  }

  for (
    const assignment of
    targetAssignments
  ) {
    if (
      restoredIds.includes(
        managedAssignmentMembershipId(
          assignment
        )
      ) &&
      assignment.activationStatus ===
        "awaiting_activation"
    ) {
      await ensureManagedProfileDiscordMessage(
        assignment,
        type
      );
    }
  }

  if (
    type === "free"
  ) {
    await saveFreeAssignments(
      freeAssignments
    );
  } else {
    await saveRentalAssignments(
      rentalAssignments
    );
  }

  await consumeRestoreHoldItems(
    customerAccountId,
    type,
    restoredIds
  );

  return {
    restored:
      restoredIds.length,

    managedAccountIds:
      restoredIds
  };
}


app.post(
  "/api/admin/restore-holds/:type/:customerAccountId/restore",
  requireAdmin,
  async (req, res) => {
    try {
      const type =
        clean(
          req.params.type,
          20
        );

      const customerAccountId =
        clean(
          req.params.customerAccountId,
          150
        );

      if (
        ![
          "free",
          "rented"
        ].includes(type) ||
        !customerAccountId
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid Restore Hold request."
          });
      }

      const result =
        await restoreHeldManagedAccountsForCustomer(
          customerAccountId,
          type
        );

      if (
        !result.restored
      ) {
        return res
          .status(404)
          .json({
            error:
              "No restorable managed accounts are currently on hold for this customer."
          });
      }

      return res.json({
        ok: true,

        restored:
          result.restored,

        message:
          `${result.restored} ${type === "free" ? "gifted" : "rented"} account${result.restored === 1 ? "" : "s"} restored to Linked Profiles.`
      });

    } catch (error) {
      console.error(
        "Restore Hold restore error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            "Unable to restore managed accounts."
        });
    }
  }
);


app.post(
  "/api/admin/restore-holds/:type/:customerAccountId/release",
  requireAdmin,
  async (req, res) => {
    try {
      const type =
        clean(
          req.params.type,
          20
        );

      const customerAccountId =
        clean(
          req.params.customerAccountId,
          150
        );

      if (
        ![
          "free",
          "rented"
        ].includes(type) ||
        !customerAccountId
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid Restore Hold request."
          });
      }

      const released =
        await mutateRestoreHolds(
          async holds => {
            const active =
              activeRestoreHoldsFor(
                holds,
                {
                  customerAccountId,
                  type
                }
              );

            const nowIso =
              new Date()
                .toISOString();

            let count =
              0;

            for (
              const hold of
              active
            ) {
              for (
                const item of
                restoreHoldRemainingItems(
                  hold
                )
              ) {
                item.releasedAt =
                  nowIso;

                count += 1;
              }

              hold.status =
                "released";

              hold.releasedAt =
                nowIso;

              hold.releaseReason =
                "admin_released";

              hold.updatedAt =
                nowIso;
            }

            return count;
          }
        );

      return res.json({
        ok: true,

        released,

        message:
          `${released} held managed account${released === 1 ? "" : "s"} released to the normal available pool.`
      });

    } catch (error) {
      console.error(
        "Restore Hold release error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to release Restore Hold."
        });
    }
  }
);


app.post(
  "/api/admin/linked-memberships/free/:id/extend",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        clean(
          req.params.id,
          150
        );

      const extension =
        clean(
          req.body?.extension,
          30
        )
          .trim()
          .toLowerCase();

      if (
        ![
          "1_week",
          "1_month",
          "indefinite"
        ].includes(
          extension
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Choose 1 week, 1 month, or indefinitely."
          });
      }

      const assignments =
        await getFreeAssignments();

      const assignment =
        linkedFreeAssignment(
          assignments,
          id
        );

      if (!assignment) {
        return res
          .status(404)
          .json({
            error:
              "Gifted profile assignment could not be found."
          });
      }

      const now =
        new Date();

      const base =
        assignment.expiresAt &&
        new Date(
          assignment.expiresAt
        ).getTime() >
          now.getTime()
          ? new Date(
              assignment.expiresAt
            )
          : now;

      if (
        extension ===
        "indefinite"
      ) {
        assignment.expiresAt =
          null;

        assignment.durationType =
          "indefinite";

      } else if (
        extension ===
        "1_week"
      ) {
        base.setDate(
          base.getDate() + 7
        );

        assignment.expiresAt =
          base.toISOString();

        assignment.durationType =
          "1_week";

      } else {
        base.setMonth(
          base.getMonth() + 1
        );

        assignment.expiresAt =
          base.toISOString();

        assignment.durationType =
          "1_month";
      }

      assignment.active =
        true;

      if (
        String(
          assignment.activationStatus ||
          ""
        ) === "expired"
      ) {
        assignment.activationStatus =
          "activated";
      }

      assignment.updatedAt =
        now.toISOString();

      await saveFreeAssignments(
        assignments
      );

      return res.json({
        ok: true,
        expiresAt:
          assignment.expiresAt ||
          null,
        durationType:
          assignment.durationType
      });

    } catch (error) {
      console.error(
        "Extend gifted profile error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to extend gifted profile."
        });
    }
  }
);


app.post(
  "/api/admin/linked-memberships/:type/:id/extend",
  requireAdmin,
  async (req, res) => {
    try {
      const type =
        clean(
          req.params.type,
          20
        );

      const id =
        clean(
          req.params.id,
          150
        );

      const extension =
        clean(
          req.body?.extension,
          30
        )
          .trim()
          .toLowerCase();

      if (
        ![
          "free",
          "rented"
        ].includes(
          type
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid managed profile type."
          });
      }

      const allowed =
        type === "free"
          ? [
              "1_week",
              "1_month",
              "indefinite"
            ]
          : [
              "1_week",
              "1_month"
            ];

      if (
        !allowed.includes(
          extension
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              type === "free"
                ? "Choose 1 week, 1 month, or indefinitely."
                : "Choose 1 week or 1 month."
          });
      }

      const assignments =
        type === "free"
          ? await getFreeAssignments()
          : await getRentalAssignments();

      const assignment =
        type === "free"
          ? linkedFreeAssignment(
              assignments,
              id
            )
          : linkedRentalAssignment(
              assignments,
              id
            );

      if (!assignment) {
        return res
          .status(404)
          .json({
            error:
              `${type === "free" ? "Gifted" : "Rented"} profile assignment could not be found.`
          });
      }

      const now =
        new Date();

      const base =
        assignment.expiresAt &&
        new Date(
          assignment.expiresAt
        ).getTime() >
          now.getTime()
          ? new Date(
              assignment.expiresAt
            )
          : now;

      if (
        extension ===
        "indefinite"
      ) {
        assignment.expiresAt =
          null;

        assignment.durationType =
          "indefinite";

      } else if (
        extension ===
        "1_week"
      ) {
        base.setDate(
          base.getDate() + 7
        );

        assignment.expiresAt =
          base.toISOString();

        assignment.durationType =
          "1_week";

      } else {
        base.setMonth(
          base.getMonth() + 1
        );

        assignment.expiresAt =
          base.toISOString();

        assignment.durationType =
          "1_month";
      }

      /*
        Extension changes only the Gifted/Rented time window.
        Activation is controlled independently by the ACTIVATE /
        DEACTIVATE button on the managed profile card.
      */
      assignment.updatedAt =
        now.toISOString();

      if (
        type === "free"
      ) {
        await saveFreeAssignments(
          assignments
        );
      } else {
        await saveRentalAssignments(
          assignments
        );
      }

      return res.json({
        ok: true,

        expiresAt:
          assignment.expiresAt ||
          null,

        durationType:
          assignment.durationType,

        message:
          `${type === "free" ? "Gifted" : "Rented"} profile extended successfully.`
      });

    } catch (error) {
      console.error(
        "Extend linked managed profile error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to extend managed profile."
        });
    }
  }
);


app.post(
  "/api/admin/linked-memberships/:type/:id/return-to-pool",
  requireAdmin,
  async (req, res) => {
    try {
      const type =
        clean(
          req.params.type,
          20
        );

      const id =
        clean(
          req.params.id,
          150
        );

      if (
        type !== "free" &&
        type !== "rented"
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid managed profile type."
          });
      }

      const assignments =
        type === "free"
          ? await getFreeAssignments()
          : await getRentalAssignments();

      const assignment =
        type === "free"
          ? linkedFreeAssignment(
              assignments,
              id
            )
          : linkedRentalAssignment(
              assignments,
              id
            );

      if (!assignment) {
        return res
          .status(404)
          .json({
            error:
              "Managed assignment could not be found."
          });
      }

      const now =
        new Date()
          .toISOString();

      clearManagedAssignmentCustomerData(
        assignment,
        {
          reason:
            "returned_to_pool",
          nowIso:
            now
        }
      );

      if (type === "free") {
        await saveFreeAssignments(
          assignments
        );
      } else {
        await saveRentalAssignments(
          assignments
        );
      }

      return res.json({
        ok: true
      });

    } catch (error) {
      console.error(
        "Return managed profile to pool error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to return this profile to the pool."
        });
    }
  }
);




function exportProfileMissingFields(
  profile = {},
  secrets = {}
) {
  const missing = [];

  const requiredProfileFields = [
    ["firstName", "first name"],
    ["lastName", "last name"],
    ["email", "email"],
    ["phone", "phone"],
    ["address", "street address"],
    ["country", "country"],
    ["state", "state"],
    ["city", "city"],
    ["zip", "ZIP code"]
  ];

  for (
    const [
      key,
      label
    ] of
    requiredProfileFields
  ) {
    if (
      !String(
        profile?.[key] ||
        ""
      ).trim()
    ) {
      missing.push(
        label
      );
    }
  }

  const digits =
    String(
      secrets?.acoCardNumber ||
      secrets?.cardNumber ||
      ""
    ).replace(
      /\D/g,
      ""
    );

  if (
    !/^\d{12,19}$/.test(
      digits
    )
  ) {
    missing.push(
      "card number"
    );
  }

  if (
    !String(
      secrets?.cardholder ||
      ""
    ).trim()
  ) {
    missing.push(
      "cardholder name"
    );
  }

  if (
    !/^(0[1-9]|1[0-2])$/.test(
      String(
        secrets?.expMonth ||
        ""
      )
    )
  ) {
    missing.push(
      "expiration month"
    );
  }

  if (
    !/^\d{4}$/.test(
      String(
        secrets?.expYear ||
        ""
      )
    )
  ) {
    missing.push(
      "expiration year"
    );
  }

  if (
    !String(
      secrets?.securityCode ||
      ""
    ).trim()
  ) {
    missing.push(
      "Security Code"
    );
  }

  return missing;
}


function exportReadinessPayload(
  profile,
  secrets
) {
  const missingFields =
    exportProfileMissingFields(
      profile,
      secrets
    );

  return {
    exportReady:
      missingFields.length ===
      0,

    missingFields
  };
}


function retailerDisplayName(
  retailer
) {
  return {
    target:
      "Target",

    walmart:
      "Walmart",

    pokemoncenter:
      "Pokemon Center",

    pkc:
      "PKC",

    samsClub:
      "Sam's Club",

    costco:
      "Costco"
  }[retailer] ||
  retailer;
}


function recordRetailerKeys(
  record
) {
  let credentials =
    emptyRetailerCredentials();

  try {
    if (
      record?.credentials
    ) {
      credentials =
        normalizeRetailerCredentials(
          decryptJson(
            record.credentials
          )
        );
    }
  } catch {
    credentials =
      emptyRetailerCredentials();
  }

  return RETAILER_KEYS.filter(
    retailer =>
      Boolean(
        String(
          credentials?.[retailer]
            ?.username ||
          ""
        ).trim()
      )
  );
}


function managedRetailerKeys(
  membership
) {
  const credentials =
    managedRetailerCredentialsForAdmin(
      membership
    );

  return RETAILER_KEYS.filter(
    retailer =>
      Boolean(
        String(
          credentials?.[retailer]
            ?.username ||
          ""
        ).trim()
      )
  );
}


function hayhaProfileHasExactShape(
  item
) {
  if (
    !item ||
    typeof item !==
      "object" ||
    Array.isArray(item)
  ) {
    return false;
  }

  const topKeys =
    Object.keys(item);

  const requiredTopKeys = [
    "name",
    "shipping",
    "cardInfo",
    "sameAsBilling",
    "groupId",
    "id",
    "encrypted"
  ];

  if (
    JSON.stringify(topKeys) !==
    JSON.stringify(
      requiredTopKeys
    )
  ) {
    return false;
  }

  const shippingKeys =
    Object.keys(
      item.shipping ||
      {}
    );

  const requiredShippingKeys = [
    "firstName",
    "lastName",
    "email",
    "phone",
    "address",
    "address2",
    "country",
    "state",
    "city",
    "zipCode"
  ];

  if (
    JSON.stringify(
      shippingKeys
    ) !==
    JSON.stringify(
      requiredShippingKeys
    )
  ) {
    return false;
  }

  const cardKeys =
    Object.keys(
      item.cardInfo ||
      {}
    );

  const requiredCardKeys = [
    "cardNumber",
    "holder",
    "expMonth",
    "expYear",
    "cvv"
  ];

  return (
    JSON.stringify(
      cardKeys
    ) ===
      JSON.stringify(
        requiredCardKeys
      ) &&
    item.sameAsBilling ===
      true &&
    item.encrypted ===
      false
  );
}


function linkedAssignmentRetailerKeys(
  assignment,
  memberships
) {
  const membershipId =
    assignment.managedAccountId ||
    assignment.freeMembershipId ||
    assignment.rentedMembershipId ||
    "";

  const membership =
    memberships.find(
      item =>
        String(item.id) ===
        String(
          membershipId
        )
    );

  return membership
    ? managedRetailerKeys(
        membership
      )
    : [];
}


function decryptAssignmentSecrets(
  assignment
) {
  try {
    return assignment
      ?.customerSecrets
      ? (
          decryptJson(
            assignment.customerSecrets
          ) ||
          {}
        )
      : {};
  } catch {
    return {};
  }
}


function hayhaProfileObject(
  name,
  profile,
  secrets,
  groupId
) {
  return {
    name,

    shipping: {
      firstName:
        profile?.firstName ||
        "",

      lastName:
        profile?.lastName ||
        "",

      email:
        profile?.email ||
        "",

      phone:
        profile?.phone ||
        "",

      address:
        profile?.address ||
        "",

      address2:
        profile?.address2 ||
        "",

      country:
        profile?.country ||
        "United States",

      state:
        profile?.state ||
        "",

      city:
        profile?.city ||
        "",

      zipCode:
        profile?.zip ||
        ""
    },

    cardInfo: {
      cardNumber:
        String(
          secrets?.acoCardNumber ||
          secrets?.cardNumber ||
          ""
        ).replace(
          /\\D/g,
          ""
        ),

      holder:
        secrets?.cardholder ||
        "",

      expMonth:
        secrets?.expMonth ||
        "",

      expYear:
        Number(
          secrets?.expYear ||
          0
        ) || "",

      /*
        The .hayha schema names this field "cvv".
        For this export format, populate that required schema field
        from the customer's SLABSNGRABSACO Security Code.
        The site UI continues to label the stored value Security Code.
      */
      cvv:
        String(
          secrets?.securityCode ||
          ""
        ).trim()
    },

    sameAsBilling:
      true,

    groupId,

    id:
      crypto.randomUUID(),

    encrypted:
      false
  };
}


function safeExportFilePart(
  value
) {
  return String(
    value ||
    "Customer"
  )
    .replace(
      /[^a-z0-9 _-]+/gi,
      ""
    )
    .replace(
      /\\s+/g,
      " "
    )
    .trim() ||
    "Customer";
}

async function adminJigContext(orderId) {
  const orders = await readJson(PAID_FILE, []);
  let order = (Array.isArray(orders) ? orders : []).find(item => String(item.id) === String(orderId));
  const account = (await getCustomerAccounts()).find(item =>
    String(item.id) === String(order?.customerAccountId || orderId)
  );
  if (!account) return null;
  if (!order) order = { id: orderId, customerAccountId: account.id, profile: account.adminProfile || {} };
  const [paidProfiles, freeAssignments, rentalAssignments] = await Promise.all([
    getRetailerProfiles(), getFreeAssignments(), getRentalAssignments()
  ]);
  const paid = paidProfiles.filter(item => String(item.customerAccountId || "") === String(account.id));
  const linked = [...freeAssignments, ...rentalAssignments].filter(item =>
    String(item.customerAccountId || "") === String(account.id) && managedAssignmentIsLinked(item)
  );
  const pool = await customerJigPoolWithSources(account, order, paid);
  return { account, order, pool, paid, linked, paidProfiles, freeAssignments, rentalAssignments };
}

const JIG_RULES_VERSION = "combined-four-2026-09-29";
async function resetCustomerJigs(context) {
  const { pool } = context;
  const now = new Date().toISOString();
  const records = [...context.paid, ...context.linked];
  const backup = { pool, records: records.map(record => ({
    id: record.id, customerProfile: record.customerProfile, jiggedAddress: record.jiggedAddress,
    jigSourceAddress: record.jigSourceAddress, jigPoolVariantId: record.jigPoolVariantId,
    jigHistoryKeys: record.jigHistoryKeys, jigNeeded: record.jigNeeded
  })) };
  await writeJson(path.join(SECRET_DIR, "jig-reset-backups", `${context.account.id}-${crypto.randomUUID()}.encrypted.json`), encryptJson(backup));
  let updatedProfiles = 0, needsAddress = 0;
  const claimed = new Set();
  for (const source of pool.sources) {
    const oldVariants = new Set((source.variants || []).map(item => safeAddressVariantKey(item.address)));
    const originalKey = safeAddressVariantKey(source.original);
    const assigned = records.filter(record => !claimed.has(record) && (
      safeAddressVariantKey(record.jigSourceAddress || {}) === originalKey ||
      (!record.jigSourceAddress && (oldVariants.has(safeAddressVariantKey(record.customerProfile || {})) ||
        safeAddressVariantKey(record.customerProfile || {}) === originalKey))
    ));
    source.variants = defaultJigVariants(source.original, 4, new Set(source.excludedVariantKeys || [])).map(address => ({ id: crypto.randomUUID(), address }));
    source.generatedSafeVariantsAt = now;
    for (const [index, record] of assigned.entries()) {
      claimed.add(record);
      const variant = source.variants[index];
      const deliveryAddress = variant?.address || Object.fromEntries(
        ["address", "address2", "city", "state", "zip", "country"].map(field => [field, source.original[field] || ""])
      );
      record.customerProfile = { ...record.customerProfile, ...deliveryAddress };
      record.jigSourceAddress = { ...source.original };
      record.jigSourceKey = source.id;
      record.jiggedAddress = variant ? { ...variant.address } : null;
      record.jigPoolVariantId = variant?.id || null;
      record.jigVariantIndex = variant ? index + 1 : null;
      record.jigHistoryKeys = variant ? [safeAddressVariantKey(variant.address)] : [];
      record.jigNeeded = !variant;
      record.jigNeededReason = variant ? null : "Four JIGs are already assigned for this Main address. Add another Main address.";
      record.exportAttemptStatus = null;
      record.updatedAt = now;
      updatedProfiles++;
      if (!variant) needsAddress++;
    }
  }
  await saveRetailerProfiles(context.paidProfiles);
  await saveFreeAssignments(context.freeAssignments);
  await saveRentalAssignments(context.rentalAssignments);
  pool.rulesVersion = JIG_RULES_VERSION;
  pool.resetAt = now;
  await saveCustomerJigPool(context.account.id, pool);
  return { updatedProfiles, needsAddress };
}

async function migrateCustomerJigs() {
  const migrationFile = path.join(SECRET_DIR, "jig-rules-migration.json");
  const completed = await readJson(migrationFile, null);
  if (completed?.version === JIG_RULES_VERSION) return;
  let resetCustomers = 0, updatedProfiles = 0, needsAddress = 0;
  for (const account of await getCustomerAccounts()) {
    const context = await adminJigContext(account.id);
    if (!context?.pool.sources.length || context.pool.rulesVersion === JIG_RULES_VERSION) continue;
    const result = await resetCustomerJigs(context);
    resetCustomers++;
    updatedProfiles += result.updatedProfiles;
    needsAddress += result.needsAddress;
  }
  await writeJson(migrationFile, { version: JIG_RULES_VERSION, completedAt: new Date().toISOString() });
  console.log("Combined four-JIG reset:", JSON.stringify({ resetCustomers, updatedProfiles, needsAddress }));
}

app.post("/api/admin/submissions/:id/jigs-reset", requireAdmin, async (req, res) => {
  try {
    const context = await adminJigContext(req.params.id);
    if (!context) return res.status(404).json({ error: "Customer not found." });
    return res.json({ ok: true, ...await resetCustomerJigs(context) });
  } catch (error) {
    console.error("Customer JIG reset failed:", error?.name);
    return res.status(500).json({ error: "Unable to reset JIGs." });
  }
});

function jigAssignedRecords(context, variant, source) {
  const key = safeAddressVariantKey(variant);
  const originalKey = safeAddressVariantKey(source.original);
  return [...context.paid, ...context.linked].filter(record =>
    record.jiggedAddress && safeAddressVariantKey(record.jiggedAddress) === key &&
    safeAddressVariantKey(record.jigSourceAddress || {}) === originalKey
  );
}

app.get("/api/admin/submissions/:id/jigs", requireAdmin, async (req, res) => {
  try {
    const context = await adminJigContext(req.params.id);
    if (!context) return res.status(404).json({ error: "Customer not found." });
    const sources = context.pool.sources.map(source => {
      const variants = [...(source.variants || [])];
      for (const record of [...context.paid, ...context.linked]) {
        if (!record.jiggedAddress || safeAddressVariantKey(record.jigSourceAddress || {}) !== safeAddressVariantKey(source.original)) continue;
        if (!variants.some(item => safeAddressVariantKey(item.address) === safeAddressVariantKey(record.jiggedAddress))) {
          variants.push({ id: `assigned:${record.id}`, address: record.jiggedAddress });
        }
      }
      return {
        id: source.id, label: source.label, original: source.original,
        variants: variants.map(variant => ({
          ...variant,
          assignedProfiles: jigAssignedRecords(context, variant.address, source).map(record =>
            record.customerProfile?.profileName || record.profileName || record.id
          )
        }))
      };
    });
    return res.json({ ok: true, sources });
  } catch (error) {
    console.error("Admin JIG pool load error:", error);
    return res.status(500).json({ error: "Unable to load address JIGs." });
  }
});

app.post("/api/admin/submissions/:id/jigs/main", requireAdmin, async (req, res) => {
  try {
    const context = await adminJigContext(req.params.id);
    if (!context) return res.status(404).json({ error: "Customer not found." });
    const original = jigSourceAddress(req.body?.address || {});
    if (![original.address, original.city, original.state, original.zip].every(Boolean)) {
      return res.status(400).json({ error: "Street address, city, state and ZIP are required." });
    }
    const key = safeAddressVariantKey(original);
    if (context.pool.sources.some(source => safeAddressVariantKey(source.original) === key || jigVariantAllowed(source.original, original))) {
      return res.status(409).json({ error: "This address already has a Main address and JIG pool. Use its existing pool." });
    }
    const source = { id: crypto.randomUUID(), label: clean(req.body?.label, 100) || "Admin-added Main address", original,
      variants: defaultJigVariants(original, 4).map(address => ({ id: crypto.randomUUID(), address })),
      generatedSafeVariantsAt: new Date().toISOString(), addedBy: "admin" };
    context.pool.sources.push(source);
    await saveCustomerJigPool(context.account.id, context.pool);
    return res.json({ ok: true, source });
  } catch (error) { return res.status(500).json({ error: "Unable to add Main address." }); }
});

app.post("/api/admin/submissions/:id/jigs/:sourceId", requireAdmin, async (req, res) => {
  return saveAdminJigVariant(req, res, false);
});
app.put("/api/admin/submissions/:id/jigs/:sourceId/:variantId", requireAdmin, async (req, res) => {
  return saveAdminJigVariant(req, res, true);
});

function jigDeliveryAddress(address) {
  return Object.fromEntries(["address", "address2", "city", "state", "zip", "country"].map(field => [field, address[field] || ""]));
}
async function saveJigContext(context) {
  await saveRetailerProfiles(context.paidProfiles);
  await saveFreeAssignments(context.freeAssignments);
  await saveRentalAssignments(context.rentalAssignments);
  await saveCustomerJigPool(context.account.id, context.pool);
}
app.delete("/api/admin/submissions/:id/jigs/:sourceId/:variantId", requireAdmin, async (req, res) => {
  try {
    const context = await adminJigContext(req.params.id);
    const source = context?.pool.sources.find(item => item.id === req.params.sourceId);
    const variant = source?.variants.find(item => item.id === req.params.variantId);
    if (!variant) return res.status(404).json({ error: "JIG not found." });
    const key = safeAddressVariantKey(variant.address);
    if (req.body?.block === true) source.excludedVariantKeys = [...new Set([...(source.excludedVariantKeys || []), key])];
    const assigned = jigAssignedRecords(context, variant.address, source);
    source.variants = source.variants.filter(item => item.id !== variant.id);
    for (const record of assigned) {
      record.customerProfile = { ...record.customerProfile, ...jigDeliveryAddress(source.original) };
      record.jiggedAddress = null;
      record.jigPoolVariantId = null;
      record.jigVariantIndex = null;
      record.jigNeeded = true;
      record.jigNeededReason = "The assigned JIG was removed. Choose an available JIG or add another Main address.";
      record.exportAttemptStatus = null;
      record.updatedAt = new Date().toISOString();
    }
    await saveJigContext(context);
    return res.json({ ok: true, updatedProfiles: assigned.length, blocked: req.body?.block === true });
  } catch (error) { return res.status(500).json({ error: "Unable to remove JIG." }); }
});
app.post("/api/admin/submissions/:id/jigs/:sourceId/:variantId/rejig", requireAdmin, async (req, res) => {
  try {
    const context = await adminJigContext(req.params.id);
    const source = context?.pool.sources.find(item => item.id === req.params.sourceId);
    const variant = source?.variants.find(item => item.id === req.params.variantId);
    if (!variant) return res.status(404).json({ error: "JIG not found." });
    const excluded = new Set([...(source.excludedVariantKeys || []), ...source.variants.map(item => safeAddressVariantKey(item.address))]);
    const replacement = defaultJigVariants(source.original, 1, excluded,
      source.variants.filter(item => item !== variant).map(item => item.address))[0];
    if (!replacement) return res.status(409).json({ error: "No unused permitted combination remains. Edit the JIG or add another Main address." });
    const assigned = jigAssignedRecords(context, variant.address, source);
    source.excludedVariantKeys = [...new Set([...(source.excludedVariantKeys || []), safeAddressVariantKey(variant.address)])];
    variant.address = replacement;
    for (const record of assigned) {
      record.customerProfile = { ...record.customerProfile, ...replacement };
      record.jiggedAddress = { ...replacement };
      record.jigHistoryKeys = [...new Set([...(record.jigHistoryKeys || []), safeAddressVariantKey(replacement)])];
      record.jigNeeded = false;
      record.jigNeededReason = null;
      record.exportAttemptStatus = null;
      record.updatedAt = new Date().toISOString();
    }
    await saveJigContext(context);
    return res.json({ ok: true, variant, updatedProfiles: assigned.length });
  } catch (error) { return res.status(500).json({ error: "Unable to rejig this address." }); }
});

async function saveAdminJigVariant(req, res, editing) {
  try {
    const context = await adminJigContext(req.params.id);
    if (!context) return res.status(404).json({ error: "Customer not found." });
    const source = context.pool.sources.find(item => item.id === req.params.sourceId);
    if (!source) return res.status(404).json({ error: "Main address not found." });
    const candidate = jigSourceAddress(req.body?.address);
    // City, state, ZIP and country always come from the submitted main address.
    const address = {
      address: candidate.address, address2: candidate.address2,
      city: source.original.city, state: source.original.state,
      zip: source.original.zip, country: source.original.country
    };
    if (!jigVariantAllowed(source.original, address)) {
      return res.status(400).json({ error: "Use only truthful formatting of the original street and unit. House number, street name, unit number, city, state and ZIP must stay the same." });
    }
    if (!editing && (source.variants || []).length >= 4) {
      return res.status(409).json({ error: "This Main address has four JIGs. Edit an existing JIG or add a different Main address." });
    }
    if ((source.excludedVariantKeys || []).includes(safeAddressVariantKey(address))) {
      return res.status(409).json({ error: "This exact JIG was removed from the pool and cannot be used again." });
    }
    const variantId = req.params.variantId;
    const old = editing && (source.variants || []).find(item => item.id === variantId);
    const assignedRecord = editing && variantId?.startsWith("assigned:")
      ? [...context.paid, ...context.linked].find(item => String(item.id) === variantId.slice(9)) : null;
    if (editing && !old && !assignedRecord) return res.status(404).json({ error: "JIG not found." });
    const oldAddress = old?.address || assignedRecord?.jiggedAddress;
    const key = safeAddressVariantKey(address);
    const duplicate = context.pool.sources.some(item => (item.variants || []).some(variant =>
      variant.id !== variantId && safeAddressVariantKey(variant.address) === key
    )) || [...context.paid, ...context.linked].some(record =>
      record !== assignedRecord && safeAddressVariantKey(record.jiggedAddress || {}) === key &&
      (!oldAddress || safeAddressVariantKey(record.jiggedAddress) !== safeAddressVariantKey(oldAddress))
    );
    if (duplicate) return res.status(409).json({ error: "That JIG is already used or saved for this customer." });
    const now = new Date().toISOString();
    const assigned = oldAddress ? jigAssignedRecords(context, oldAddress, source) : [];
    if (assignedRecord && !assigned.includes(assignedRecord)) assigned.push(assignedRecord);
    const variant = old || { id: crypto.randomUUID() };
    variant.address = address;
    if (!old) source.variants.push(variant);
    for (const record of assigned) {
      record.jiggedAddress = { ...address };
      record.jigPoolVariantId = variant.id;
      record.customerProfile = { ...record.customerProfile, ...address };
      record.exportAttemptStatus = null;
      record.jigNeeded = false;
      record.updatedAt = now;
    }
    await Promise.all([
      saveCustomerJigPool(context.account.id, context.pool),
      saveRetailerProfiles(context.paidProfiles),
      saveFreeAssignments(context.freeAssignments),
      saveRentalAssignments(context.rentalAssignments)
    ]);
    return res.json({ ok: true, variant, updatedProfiles: assigned.length });
  } catch (error) {
    console.error("Admin JIG pool save error:", error);
    return res.status(500).json({ error: "Unable to save JIG." });
  }
}



app.get(
  "/api/admin/submissions/:id/export-options",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        clean(
          req.params.id,
          150
        );

      const retailer =
        clean(
          req.query?.retailer,
          30
        );

      if (
        retailer &&
        !RETAILER_KEYS.includes(
          retailer
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Unsupported retailer."
          });
      }

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const order =
        (
          Array.isArray(paid)
            ? paid
            : []
        ).find(
          item =>
            String(item.id) ===
            String(id)
        );

      if (
        !order?.customerAccountId
      ) {
        return res
          .status(404)
          .json({
            error:
              "Customer order could not be found."
          });
      }

      const account =
        (
          await getCustomerAccounts()
        ).find(
          item =>
            String(item.id) ===
            String(
              order.customerAccountId
            )
        );

      const customerName =
        [
          order?.profile?.firstName,
          order?.profile?.lastName
        ]
          .filter(Boolean)
          .join(" ") ||
        order?.profile?.profileName ||
        account?.email ||
        "Customer";

      const [
        paidProfiles,
        memberships,
        freeAssignments,
        rentalAssignments
      ] = await Promise.all([
        getRetailerProfiles(),
        getManagedAccounts(),
        getFreeAssignments(),
        getRentalAssignments()
      ]);

      const linkedIdsForDuplicateCheck =
        new Set(
          [
            ...freeAssignments,
            ...rentalAssignments
          ]
            .filter(
              assignment =>
                managedAssignmentIsLinked(
                  assignment
                )
            )
            .map(
              assignment =>
                String(
                  managedAssignmentMembershipId(
                    assignment
                  ) ||
                  ""
                )
            )
            .filter(Boolean)
        );

      const duplicateCredentialState =
        managedDuplicateCredentialState(
          memberships,
          linkedIdsForDuplicateCheck
        );

      const options = [];

      const paidRecords =
        paidProfiles.filter(
          record =>
            String(
              record.customerAccountId ||
              ""
            ) ===
              String(
                order.customerAccountId
              )
        );

      let paidNumber = 0;

      for (
        const record of
        paidRecords
      ) {
        const retailerKeys =
          recordRetailerKeys(
            record
          );

        if (
          retailer &&
          !retailerKeys.includes(
            retailer
          )
        ) {
          continue;
        }

        paidNumber += 1;

        let secrets = {};

        try {
          secrets =
            record.customerSecrets
              ? (
                  decryptJson(
                    record.customerSecrets
                  ) ||
                  {}
                )
              : {};
        } catch {
          secrets = {};
        }

        const status =
          exportReadinessPayload(
            record.customerProfile ||
              {},
            secrets
          );

        options.push({
          key:
            `paid:${record.id}`,

          type:
            "paid",

          retailerKeys,

          label:
            `${customerName} ${options.length + 1}`,

          accountEmail:
            record.customerProfile
              ?.email ||
            "",

          exportReady:
            status.exportReady,

          missingFields:
            status.missingFields,

          exportAttemptStatus:
            record.exportAttemptStatus || null,

          exportAttemptedAt:
            record.exportAttemptedAt || null,

          updatedAt: record.updatedAt || null,

          jigNeeded:
            record.jigNeeded === true
        });
      }

      const addLinked =
        (
          assignment,
          type,
          number
        ) => {
          const retailerKeys =
            linkedAssignmentRetailerKeys(
              assignment,
              memberships
            );

          if (
            retailer &&
            !retailerKeys.includes(
              retailer
            )
          ) {
            return;
          }

          const membershipId =
            assignment.managedAccountId ||
            assignment.freeMembershipId ||
            assignment.rentedMembershipId ||
            assignment.id;

          const membership =
            memberships.find(
              item =>
                String(item.id) ===
                String(
                  membershipId
                )
            );

          const secrets =
            decryptAssignmentSecrets(
              assignment
            );

          const status =
            exportReadinessPayload(
              assignment.customerProfile ||
                {},
              secrets
            );

          const duplicateManagedLogin =
            duplicateCredentialState
              .duplicateIds
              .has(
                String(
                  membershipId
                )
              );

          if (
            duplicateManagedLogin
          ) {
            status.exportReady =
              false;

            status.missingFields = [
              ...(
                Array.isArray(
                  status.missingFields
                )
                  ? status.missingFields
                  : []
              ),
              "duplicate managed login"
            ];
          }

          options.push({
            key:
              `${type}:${membershipId}`,

            type,

            retailerKeys,

            label:
              `${customerName} ${options.length + 1}`,

            accountEmail:
              assignment.customerProfile?.email ||
              "",

            exportReady:
              status.exportReady,

            missingFields:
              status.missingFields,

            exportAttemptStatus:
              assignment.exportAttemptStatus || null,

            exportAttemptedAt:
              assignment.exportAttemptedAt || null,

            updatedAt: assignment.updatedAt || null,

            jigNeeded:
              assignment.jigNeeded === true
          });
        };

      let giftedNumber = 0;

      for (
        const assignment of
        freeAssignments
      ) {
        if (
          String(
            assignment.customerAccountId ||
            ""
          ) !==
            String(
              order.customerAccountId
            ) ||
          !managedAssignmentIsLinked(
            assignment
          )
        ) {
          continue;
        }

        const retailerKeys =
          linkedAssignmentRetailerKeys(
            assignment,
            memberships
          );

        if (
          retailer &&
          !retailerKeys.includes(
            retailer
          )
        ) {
          continue;
        }

        giftedNumber += 1;

        addLinked(
          assignment,
          "free",
          giftedNumber
        );
      }

      let rentedNumber = 0;

      for (
        const assignment of
        rentalAssignments
      ) {
        if (
          String(
            assignment.customerAccountId ||
            ""
          ) !==
            String(
              order.customerAccountId
            ) ||
          !managedAssignmentIsLinked(
            assignment
          )
        ) {
          continue;
        }

        const retailerKeys =
          linkedAssignmentRetailerKeys(
            assignment,
            memberships
          );

        if (
          retailer &&
          !retailerKeys.includes(
            retailer
          )
        ) {
          continue;
        }

        rentedNumber += 1;

        addLinked(
          assignment,
          "rented",
          rentedNumber
        );
      }

      const seenExportEmails = new Set();
      for (const option of options) {
        const email = String(option.accountEmail || "").trim().toLowerCase();
        if (email && seenExportEmails.has(email)) {
          option.exportReady = false;
          option.missingFields = [...option.missingFields, "unique profile email"];
        } else if (email && option.exportReady) {
          seenExportEmails.add(email);
        }
      }

      return res.json({
        ok: true,

        customerName,

        retailer:
          retailer ||
          null,

        retailerLabel:
          retailer
            ? retailerDisplayName(
                retailer
              )
            : "All",

        totalCount:
          options.length,

        exportReadyCount:
          options.filter(
            item =>
              item.exportReady
          ).length,

        missingCount:
          options.filter(
            item =>
              !item.exportReady
          ).length,

        options
      });

    } catch (error) {
      console.error(
        "Export options error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to load export profile options."
        });
    }
  }
);


app.post(
  "/api/admin/submissions/:id/export-profiles",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        clean(
          req.params.id,
          150
        );

      const retailer =
        clean(
          req.body?.retailer,
          30
        );

      if (
        !retailer ||
        !RETAILER_KEYS.includes(
          retailer
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Choose a supported retailer before exporting."
          });
      }

      const selected =
        Array.isArray(
          req.body?.selected
        )
          ? req.body.selected.map(
              item =>
                String(item)
            )
          : [];

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const order =
        (
          Array.isArray(paid)
            ? paid
            : []
        ).find(
          item =>
            String(item.id) ===
            String(id)
        );

      if (
        !order?.customerAccountId
      ) {
        return res
          .status(404)
          .json({
            error:
              "Customer order could not be found."
          });
      }

      const account =
        (
          await getCustomerAccounts()
        ).find(
          item =>
            String(item.id) ===
            String(
              order.customerAccountId
            )
        );

      const customerName =
        [
          order?.profile?.firstName,
          order?.profile?.lastName
        ]
          .filter(Boolean)
          .join(" ") ||
        order?.profile?.profileName ||
        account?.email ||
        "Customer";

      const [
        paidProfiles,
        memberships,
        freeAssignments,
        rentalAssignments
      ] = await Promise.all([
        getRetailerProfiles(),
        getManagedAccounts(),
        getFreeAssignments(),
        getRentalAssignments()
      ]);

      const linkedIdsForDuplicateCheck =
        new Set(
          [
            ...freeAssignments,
            ...rentalAssignments
          ]
            .filter(
              assignment =>
                managedAssignmentIsLinked(
                  assignment
                )
            )
            .map(
              assignment =>
                String(
                  managedAssignmentMembershipId(
                    assignment
                  ) ||
                  ""
                )
            )
            .filter(Boolean)
        );

      const duplicateCredentialState =
        managedDuplicateCredentialState(
          memberships,
          linkedIdsForDuplicateCheck
        );

      const groupId =
        crypto.randomUUID();

      const candidates = [];

      let paidNumber = 0;

      for (
        const record of
        paidProfiles.filter(
          item =>
            String(
              item.customerAccountId ||
              ""
            ) ===
              String(
                order.customerAccountId
              )
        )
      ) {
        if (
          !recordRetailerKeys(
            record
          ).includes(
            retailer
          )
        ) {
          continue;
        }

        paidNumber += 1;

        let secrets = {};

        try {
          secrets =
            record.customerSecrets
              ? (
                  decryptJson(
                    record.customerSecrets
                  ) ||
                  {}
                )
              : {};
        } catch {
          secrets = {};
        }

        const missingFields =
          exportProfileMissingFields(
            record.customerProfile ||
              {},
            secrets
          );

        candidates.push({
          key:
            `paid:${record.id}`,

          record,

          email:
            String(record.customerProfile?.email || "").trim().toLowerCase(),

          exportReady:
            missingFields.length ===
            0,

          missingFields,

          item:
            hayhaProfileObject(
              "",
              record.customerProfile ||
                {},
              secrets,
              groupId
            )
        });
      }

      const addLinkedCandidate =
        (
          assignment,
          type,
          number
        ) => {
          if (
            !linkedAssignmentRetailerKeys(
              assignment,
              memberships
            ).includes(
              retailer
            )
          ) {
            return;
          }

          const membershipId =
            assignment.managedAccountId ||
            assignment.freeMembershipId ||
            assignment.rentedMembershipId ||
            assignment.id;

          const secrets =
            decryptAssignmentSecrets(
              assignment
            );

          const missingFields =
            exportProfileMissingFields(
              assignment.customerProfile ||
                {},
              secrets
            );

          if (
            duplicateCredentialState
              .duplicateIds
              .has(
                String(
                  membershipId
                )
              )
          ) {
            missingFields.push(
              "duplicate managed login"
            );
          }

          candidates.push({
            key:
              `${type}:${membershipId}`,

            record: assignment,

            email:
              String(assignment.customerProfile?.email || "").trim().toLowerCase(),

            exportReady:
              missingFields.length ===
              0,

            missingFields,

            item:
              hayhaProfileObject(
                "",
                assignment.customerProfile ||
                  {},
                secrets,
                groupId
              )
          });
        };

      let giftedNumber = 0;

      for (
        const assignment of
        freeAssignments
      ) {
        if (
          String(
            assignment.customerAccountId ||
            ""
          ) !==
            String(
              order.customerAccountId
            ) ||
          !managedAssignmentIsLinked(
            assignment
          ) ||
          !linkedAssignmentRetailerKeys(
            assignment,
            memberships
          ).includes(
            retailer
          )
        ) {
          continue;
        }

        giftedNumber += 1;

        addLinkedCandidate(
          assignment,
          "free",
          giftedNumber
        );
      }

      let rentedNumber = 0;

      for (
        const assignment of
        rentalAssignments
      ) {
        if (
          String(
            assignment.customerAccountId ||
            ""
          ) !==
            String(
              order.customerAccountId
            ) ||
          !managedAssignmentIsLinked(
            assignment
          ) ||
          !linkedAssignmentRetailerKeys(
            assignment,
            memberships
          ).includes(
            retailer
          )
        ) {
          continue;
        }

        rentedNumber += 1;

        addLinkedCandidate(
          assignment,
          "rented",
          rentedNumber
        );
      }

      const attempted = candidates.filter(candidate =>
        !selected.length || selected.includes(candidate.key)
      );
      const usedEmails = new Set();
      const chosen = [];
      for (const candidate of attempted) {
        if (!candidate.exportReady) continue;
        if (!candidate.email || usedEmails.has(candidate.email)) {
          candidate.exportReady = false;
          candidate.missingFields.push("unique profile email");
          continue;
        }
        usedEmails.add(candidate.email);
        chosen.push(candidate);
      }

      if (!chosen.length) {
        const attemptedAt = new Date().toISOString();
        for (const candidate of attempted) {
          candidate.record.exportAttemptStatus = "failed";
          candidate.record.exportAttemptedAt = attemptedAt;
          candidate.record.updatedAt = attemptedAt;
        }
        await Promise.all([
          saveRetailerProfiles(paidProfiles),
          saveFreeAssignments(freeAssignments),
          saveRentalAssignments(rentalAssignments)
        ]);
        return res
          .status(400)
          .json({
            error:
              `No ${retailerDisplayName(
                retailer
              )} profiles are currently export ready.`
          });
      }

      const output =
        chosen.map((candidate, index) => ({
          ...candidate.item,
          name: `${customerName} ${index + 1}`
        }));

      /*
        Never send an export unless every profile exactly matches
        the .hayha object structure supplied by the user.
      */
      if (
        !Array.isArray(
          output
        ) ||
        !output.every(
          hayhaProfileHasExactShape
        )
      ) {
        const attemptedAt = new Date().toISOString();
        for (const candidate of attempted) {
          candidate.record.exportAttemptStatus = "failed";
          candidate.record.exportAttemptedAt = attemptedAt;
          candidate.record.updatedAt = attemptedAt;
        }
        await Promise.all([
          saveRetailerProfiles(paidProfiles),
          saveFreeAssignments(freeAssignments),
          saveRentalAssignments(rentalAssignments)
        ]);
        return res
          .status(500)
          .json({
            error:
              "Export stopped because the generated file did not match the required .hayha profile format."
          });
      }

      const exportedAt = new Date().toISOString();
      for (const candidate of attempted) {
        candidate.record.exportAttemptStatus =
          chosen.includes(candidate) ? "success" : "failed";
        candidate.record.exportAttemptedAt = exportedAt;
        candidate.record.updatedAt = exportedAt;
      }
      await Promise.all([
        saveRetailerProfiles(paidProfiles),
        saveFreeAssignments(freeAssignments),
        saveRentalAssignments(rentalAssignments)
      ]);

      const fileName =
        `${safeExportFilePart(
          customerName
        )} ${safeExportFilePart(
          retailerDisplayName(
            retailer
          )
        )} Profiles.hayha`;

      res.setHeader(
        "Content-Type",
        "application/json; charset=utf-8"
      );

      res.setHeader(
        "X-Export-Profile-Count",
        String(
          output.length
        )
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileName.replace(/"/g, "")}"`
      );

      return res.send(
        JSON.stringify(
          output,
          null,
          2
        )
      );

    } catch (error) {
      console.error(
        "Profile export error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            "Unable to export profiles."
        });
    }
  }
);




app.post(
  "/api/admin/submissions/:id/notify-missing-info",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        clean(
          req.params.id,
          150
        );

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const order =
        (
          Array.isArray(paid)
            ? paid
            : []
        ).find(
          item =>
            String(item.id) ===
            String(id)
        );

      if (
        !order?.customerAccountId
      ) {
        return res
          .status(404)
          .json({
            error:
              "Customer account is not linked to this order."
          });
      }

      const sync =
        await syncCustomerMissingNotification(
          order.customerAccountId
        );

      if (!sync.missing.length) {
        return res
          .status(400)
          .json({
            error:
              "This customer currently has no missing profile information."
          });
      }

      const accounts =
        await getCustomerAccounts();

      const account =
        accounts.find(
          item =>
            String(item.id) ===
            String(
              order.customerAccountId
            )
        );

      const notification =
        customerNotifications(
          account
        ).find(
          item =>
            item.kind ===
            "missing_info"
        );

      if (
        notification
          ?.discordMessageId
      ) {
        await deleteActionNeededDiscordMessage(
          notification.discordMessageId
        );
      }

      let messageId =
        null;

      let discordError =
        "";

      let discordDmSent = false;

      try {
        messageId =
          await sendActionNeededDiscordMessage(
            account,
            notification?.message || "",
            { missingInfo: true }
          );

        if (notification) {
          notification.discordMessageId =
            messageId;

          notification.discordSentAt =
            new Date()
              .toISOString();
        }

        await saveCustomerAccounts(
          accounts
        );

      } catch (error) {
        discordError =
          error.message ||
          "Discord notification could not be sent.";
      }

      try {
        discordDmSent = await sendCustomerMissingInfoDiscordDm(account);
      } catch (error) {
        discordError = [discordError, error.message].filter(Boolean).join(" ");
      }

      return res.json({
        ok: true,

        discordUsernameConfigured:
          Boolean(
            account.discordLinkedAt && account.discordUserId
          ),

        discordSent:
          Boolean(
            messageId
          ),

        discordDmSent,

        discordError
      });

    } catch (error) {
      console.error(
        "Notify missing info error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            "Unable to notify customer."
        });
    }
  }
);


app.post(
  "/api/admin/submissions/:id/message-customer",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        clean(
          req.params.id,
          150
        );

      const message =
        clean(
          req.body?.message,
          3500
        );

      if (!message) {
        return res
          .status(400)
          .json({
            error:
              "Enter a message for the customer."
          });
      }

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const order =
        (
          Array.isArray(paid)
            ? paid
            : []
        ).find(
          item =>
            String(item.id) ===
            String(id)
        );

      if (
        !order?.customerAccountId
      ) {
        return res
          .status(404)
          .json({
            error:
              "Customer account is not linked to this order."
          });
      }

      const accounts =
        await getCustomerAccounts();

      const account =
        accounts.find(
          item =>
            String(item.id) ===
            String(
              order.customerAccountId
            )
        );

      if (!account) {
        return res
          .status(404)
          .json({
            error:
              "Customer account could not be found."
          });
      }

      const notifications =
        customerNotifications(
          account
        );

      const notification = {
        id:
          crypto.randomUUID(),

        kind:
          "admin_message",

        title:
          "Message from SLABS N GRABS ACO",

        message,

        createdAt:
          new Date()
            .toISOString(),

        updatedAt:
          new Date()
            .toISOString(),

        discordMessageId:
          null
      };

      notifications.push(
        notification
      );

      account.updatedAt =
        new Date()
          .toISOString();

      await saveCustomerAccounts(
        accounts
      );

      let discordMessageId =
        null;

      let discordError =
        "";

      try {
        discordMessageId =
          await sendActionNeededDiscordMessage(
            account,
            message
          );

        notification.discordMessageId =
          discordMessageId;

        await saveCustomerAccounts(
          accounts
        );

      } catch (error) {
        discordError =
          error.message ||
          "Discord notification could not be sent.";
      }

      return res.json({
        ok: true,

        discordUsernameConfigured:
          Boolean(
            account.discordUsername
          ),

        discordSent:
          Boolean(
            discordMessageId
          ),

        discordError
      });

    } catch (error) {
      console.error(
        "Message customer error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            "Unable to message customer."
        });
    }
  }
);



app.post(
  "/api/admin/submissions/:id/jig-attach-payment",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        clean(
          req.params.id,
          150
        );

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const order =
        (
          Array.isArray(paid)
            ? paid
            : []
        ).find(
          item =>
            String(item.id) ===
            String(id)
        );

      if (
        !order?.customerAccountId
      ) {
        return res
          .status(404)
          .json({
            error:
              "Customer account could not be found."
          });
      }

      const accounts =
        await getCustomerAccounts();

      const account =
        accounts.find(
          item =>
            String(item.id) ===
            String(
              order.customerAccountId
            )
        );

      if (!account) {
        return res
          .status(404)
          .json({
            error:
              "Customer account could not be found."
          });
      }

      const [
        details,
        retailerProfiles,
        memberships,
        freeAssignments,
        rentalAssignments
      ] = await Promise.all([
        adminCustomerSavedDetailsPayload(
          account
        ),
        getRetailerProfiles(),
        getManagedAccounts(),
        getFreeAssignments(),
        getRentalAssignments()
      ]);

      /*
        CROSS-RETAILER ADDRESS / PAYMENT POOL

        Shipping addresses and payment cards belong to the customer,
        not to a specific retailer. An address/card originally entered
        on a Target paid profile may therefore fill a Walmart/PKC/
        Sam's Club/Costco profile, and vice versa.

        Retailer login credentials are NEVER copied here. This route
        does not edit paid record.credentials or managed-account pool
        login credentials, so retailer usernames/emails/passwords stay
        with their original retailer account.
      */
      const jigPool = await customerJigPoolWithSources(
        account, order,
        retailerProfiles.filter(record => String(record.customerAccountId || "") === String(account.id))
      );
      const addresses = jigPool.sources.map(source => ({
        ...source.original, id: source.id, label: source.label,
        savedVariants: source.variants || []
      }));

      const cards =
        (
          details.paymentMethods ||
          []
        ).filter(
          item => {
            const digits =
              String(
                item.acoCardNumber ||
                item.cardNumber ||
                ""
              ).replace(
                /\D/g,
                ""
              );

            return (
              /^\d{12,19}$/.test(
                digits
              ) &&
              String(
                item.cardholder ||
                ""
              ).trim() &&
              /^(0[1-9]|1[0-2])$/.test(
                String(
                  item.expMonth ||
                  ""
                )
              ) &&
              /^\d{4}$/.test(
                String(
                  item.expYear ||
                  ""
                )
              ) &&
              Boolean(
                String(
                  item.securityCode ||
                  item.accountSecurityCode ||
                  ""
                ).trim()
              )
            );
          }
        );

      const paidRecords =
        retailerProfiles.filter(
          record =>
            String(
              record.customerAccountId ||
              ""
            ) ===
              String(
                order.customerAccountId
              )
        );

      const linkedAssignments = [
        ...freeAssignments
          .filter(
            assignment =>
              String(
                assignment.customerAccountId ||
                ""
              ) ===
                String(
                  order.customerAccountId
                ) &&
              managedAssignmentIsLinked(
                assignment
              )
          )
          .map(
            assignment => ({
              type:
                "free",
              assignment
            })
          ),

        ...rentalAssignments
          .filter(
            assignment =>
              String(
                assignment.customerAccountId ||
                ""
              ) ===
                String(
                  order.customerAccountId
                ) &&
              managedAssignmentIsLinked(
                assignment
              )
          )
          .map(
            assignment => ({
              type:
                "rented",
              assignment
            })
          )
      ];

      const profileTargets = [];

      let linkedRotationIndex =
        0;

      for (
        const record of
        paidRecords
      ) {
        let secrets = {};

        try {
          secrets =
            record.customerSecrets
              ? (
                  decryptJson(
                    record.customerSecrets
                  ) ||
                  {}
                )
              : {};
        } catch {
          secrets = {};
        }

        profileTargets.push({
          kind:
            "paid",

          linkedRotationIndex:
            null,

          record,

          profile:
            record.customerProfile ||
            {},

          secrets
        });
      }

      for (
        const entry of
        linkedAssignments
      ) {
        profileTargets.push({
          kind:
            entry.type,

          linkedRotationIndex:
            linkedRotationIndex++,

          record:
            entry.assignment,

          profile:
            entry.assignment
              .customerProfile ||
            {},

          secrets:
            decryptAssignmentSecrets(
              entry.assignment
            )
        });
      }

      if (
        !profileTargets.length
      ) {
        return res
          .status(400)
          .json({
            error:
              "This customer does not have any paid or linked profiles to update."
          });
      }

      /*
        Exact addresses already attached to profiles are reserved.
        If the same exact address is currently attached to more than
        one profile, keep the first instance and mark the later
        instances for repair when JIG & ATTACH PAYMENT is pressed.
      */
      const usedAddressKeys =
        new Set();

      const seenCurrentAddressKeys =
        new Set();

      const duplicateShippingTargetIndexes =
        new Set();

      for (
        let index = 0;
        index <
          profileTargets.length;
        index += 1
      ) {
        const target =
          profileTargets[
            index
          ];

        const profile =
          target.profile ||
          {};

        if (
          String(
            profile.address ||
            ""
          ).trim()
        ) {
          const key =
            safeAddressVariantKey(
              profile
            );

          if (
            seenCurrentAddressKeys.has(
              key
            )
          ) {
            duplicateShippingTargetIndexes.add(
              index
            );
          } else {
            seenCurrentAddressKeys.add(
              key
            );
          }

          usedAddressKeys.add(
            key
          );
        }

        const history =
          Array.isArray(
            target.record
              ?.jigHistoryKeys
          )
            ? target.record
                .jigHistoryKeys
            : [];

        for (
          const key of
          history
        ) {
          if (key) {
            usedAddressKeys.add(
              String(key)
            );
          }
        }
      }

      /*
        Build one global queue using EVERY customer-provided address.

        Important: interleave the address sources instead of exhausting
        source #1 first. With 5 saved addresses, the first 5 linked
        managed profiles will therefore each be based on a different
        source address before we begin the next round of safe variants.
      */
      const perSourceVariantLists =
        [];

      for (
        const source of
        addresses
      ) {
        const variants = [
          ...(source.savedVariants || []).map(item => ({ ...item.address, jigPoolVariantId: item.id }))
        ];

        const sourceKey =
          safeAddressVariantKey(
            source
          );

        const changed =
          variants.filter(
            item =>
              safeAddressVariantKey(
                item
              ) !==
              sourceKey
          );

        const unchanged =
          variants.filter(
            item =>
              safeAddressVariantKey(
                item
              ) ===
              sourceKey
          );

        const sourceEntries =
          [];

        for (
          const variant of
          [
            ...changed,
            ...unchanged
          ]
        ) {
          const key =
            safeAddressVariantKey(
              variant
            );

          if (
            !key ||
            usedAddressKeys.has(
              key
            ) ||
            sourceEntries.some(
              entry =>
                entry.key ===
                key
            )
          ) {
            continue;
          }

          sourceEntries.push({
            source,
            variant,
            key
          });
        }

        if (
          sourceEntries.length
        ) {
          perSourceVariantLists.push(
            sourceEntries
          );
        }
      }

      const variantQueue =
        [];

      let variantRound =
        0;

      let variantsRemain =
        true;

      while (
        variantsRemain &&
        variantQueue.length <
          1000
      ) {
        variantsRemain =
          false;

        for (
          const sourceEntries of
          perSourceVariantLists
        ) {
          const entry =
            sourceEntries[
              variantRound
            ];

          if (!entry) {
            continue;
          }

          variantsRemain =
            true;

          if (
            variantQueue.some(
              existing =>
                existing.key ===
                entry.key
            )
          ) {
            continue;
          }

          variantQueue.push(
            entry
          );
        }

        variantRound +=
          1;
      }

      let paidCardCursor = 0;

      let shippingFilled = 0;
      let cardsFilled = 0;
      let duplicateAddressesRepaired = 0;

      const profilesStillMissingShipping =
        [];

      const duplicateAddressesRemaining =
        [];

      const profilesStillMissingCard =
        [];

      for (
        let index = 0;
        index <
          profileTargets.length;
        index += 1
      ) {
        const target =
          profileTargets[
            index
          ];

        const record =
          target.record;

        let profile = {
          ...(
            target.profile ||
            {}
          )
        };

        let secrets = {
          ...(
            target.secrets ||
            {}
          )
        };

        const shippingReady =
          [
            "firstName",
            "lastName",
            "email",
            "phone",
            "address",
            "country",
            "state",
            "city",
            "zip"
          ].every(
            key =>
              Boolean(
                String(
                  profile?.[key] ||
                  ""
                ).trim()
              )
          );

        const currentCardMissing =
          exportProfileMissingFields(
            {
              firstName: "x",
              lastName: "x",
              email: "x",
              phone: "x",
              address: "x",
              country: "x",
              state: "x",
              city: "x",
              zip: "x"
            },
            secrets
          );

        const cardReady =
          !currentCardMissing.some(
            item =>
              [
                "card number",
                "cardholder name",
                "expiration month",
                "expiration year",
                "Security Code"
              ].includes(
                item
              )
          );

        const isLinkedProfile =
          target.kind !==
          "paid";

        const duplicateShipping =
          duplicateShippingTargetIndexes.has(
            index
          );

        /*
          Paid retailer profiles keep complete customer-entered shipping
          and card data. Linked Gifted/Rented profiles are deliberately
          redistributed every time JIG & ATTACH PAYMENT runs so the full
          customer address/card pool is actually used.
        */
        // An address already attached to a profile is never replaced by
        // another bulk JIG run. Flag collisions for a deliberate edit.
        const hasShippingAddress = !!(profile.address && profile.city && profile.state && profile.zip);
        const shouldAssignShipping = !hasShippingAddress || !record.jiggedAddress;

        if (!profile.email && isLinkedProfile) {
          const managed = memberships.find(item => String(item.id) === String(record.managedAccountId || record.freeMembershipId || record.rentedMembershipId));
          profile.email = managed?.accountEmail || managedAccountCanonicalEmail(managed) || "";
        }

        if (
          shouldAssignShipping
        ) {
          // A complete submitted address gets a formatting variant of itself.
          // Only profiles missing an address may draw from any source.
          const entryIndex = hasShippingAddress ? variantQueue.findIndex(candidate =>
            safeAddressVariantKey(candidate.source) === safeAddressVariantKey(profile)
          ) : 0;
          const entry = entryIndex >= 0 ? variantQueue.splice(entryIndex, 1)[0] : null;

          if (entry) {

            profile = {
              ...profile,

              firstName:
                entry.source
                  .firstName ||
                profile.firstName ||
                "",

              lastName:
                entry.source
                  .lastName ||
                profile.lastName ||
                "",

              email:
                profile.email ||
                (() => { const managed = memberships.find(item => String(item.id) === String(record.managedAccountId || record.freeMembershipId || record.rentedMembershipId)); return managed?.accountEmail || managedAccountCanonicalEmail(managed); })() ||
                "",

              phone:
                entry.source
                  .phone ||
                profile.phone ||
                "",

              address:
                entry.variant
                  .address ||
                "",

              address2:
                entry.variant
                  .address2 ||
                "",

              country:
                entry.variant
                  .country ||
                entry.source
                  .country ||
                "US",

              state:
                entry.variant
                  .state ||
                "",

              city:
                entry.variant
                  .city ||
                "",

              zip:
                entry.variant
                  .zip ||
                ""
            };

            record.jigSourceKey =
              String(
                entry.source.id ||
                safeAddressVariantKey(
                  entry.source
                )
              );

            record.jigSourceAddress = {
              ...entry.source
            };

            const poolSource = jigPool.sources.find(item => item.id === entry.source.id);
            let poolVariant = (poolSource?.variants || []).find(item => safeAddressVariantKey(item.address) === entry.key);
            if (poolSource && !poolVariant) {
              poolVariant = { id: crypto.randomUUID(), address: {
                address: entry.variant.address, address2: entry.variant.address2,
                city: entry.variant.city, state: entry.variant.state,
                zip: entry.variant.zip, country: entry.variant.country
              } };
              poolSource.variants.push(poolVariant);
            }
            record.jiggedAddress = { ...(poolVariant?.address || entry.variant) };
            record.jigPoolVariantId = poolVariant?.id || null;
            record.jigNeeded = false;
            record.exportAttemptStatus = null;

            record.jigHistoryKeys =
              Array.from(
                new Set([
                  ...(
                    Array.isArray(
                      record.jigHistoryKeys
                    )
                      ? record
                          .jigHistoryKeys
                      : []
                  ),
                  entry.key
                ])
              );

            record.selectedAddressId =
              entry.source.id ||
              record.selectedAddressId ||
              null;

            record.savedAddressId =
              entry.source.id ||
              record.savedAddressId ||
              null;

            shippingFilled += 1;

            if (
              duplicateShipping
            ) {
              duplicateAddressesRepaired +=
                1;
            }

          } else if (
            duplicateShipping
          ) {
            duplicateAddressesRemaining.push(
              index + 1
            );

            record.jigNeeded = true;

          } else if (
            shouldAssignShipping
          ) {
            profilesStillMissingShipping.push(
              index + 1
            );

            record.jigNeeded = true;
          }
        } else if (duplicateShipping) {
          duplicateAddressesRemaining.push(index + 1);
          record.jigNeeded = true;
        }

        if (
          isLinkedProfile &&
          !cardReady &&
          cards.length
        ) {
          /*
            Deterministic round-robin across ALL linked profiles:
            with 5 cards, profiles 1-5 receive cards 1-5 and
            profiles 6-10 repeat cards 1-5 in the same order.
          */
          const card =
            cards[
              Number(
                target.linkedRotationIndex ||
                0
              ) %
              cards.length
            ];

          secrets = {
            ...secrets,

            cardLabel:
              card.cardLabel ||
              "",

            cardholder:
              card.cardholder ||
              "",

            acoCardNumber:
              String(
                card.acoCardNumber ||
                card.cardNumber ||
                ""
              ).replace(
                /\D/g,
                ""
              ),

            expMonth:
              card.expMonth ||
              "",

            expYear:
              card.expYear ||
              "",

            securityCode:
              card.securityCode ||
              card.accountSecurityCode ||
              ""
          };

          record.selectedPaymentId =
            card.id ||
            null;

          record.savedPaymentMethodId =
            card.id ||
            null;

          cardsFilled += 1;

        } else if (
          !isLinkedProfile &&
          !cardReady &&
          cards.length
        ) {
          const card =
            cards[
              paidCardCursor %
              cards.length
            ];

          paidCardCursor +=
            1;

          secrets = {
            ...secrets,

            cardLabel:
              card.cardLabel ||
              "",

            cardholder:
              card.cardholder ||
              "",

            acoCardNumber:
              String(
                card.acoCardNumber ||
                card.cardNumber ||
                ""
              ).replace(
                /\D/g,
                ""
              ),

            expMonth:
              card.expMonth ||
              "",

            expYear:
              card.expYear ||
              "",

            securityCode:
              card.securityCode ||
              card.accountSecurityCode ||
              ""
          };

          record.selectedPaymentId =
            card.id ||
            record.selectedPaymentId ||
            null;

          record.savedPaymentMethodId =
            card.id ||
            record.savedPaymentMethodId ||
            null;

          cardsFilled += 1;

        } else if (
          !cardReady
        ) {
          profilesStillMissingCard.push(
            index + 1
          );
        }

        record.customerProfile =
          profile;

        record.customerSecrets =
          encryptJson(
            secrets
          );

        record.updatedAt =
          new Date()
            .toISOString();
      }

      await Promise.all([
        saveCustomerJigPool(account.id, jigPool),
        saveRetailerProfiles(
          retailerProfiles
        ),
        saveFreeAssignments(
          freeAssignments
        ),
        saveRentalAssignments(
          rentalAssignments
        )
      ]);

      await syncCustomerMissingNotification(
        order.customerAccountId
      );

      const countedEmails = new Set();
      const exportReadyCount =
        profileTargets.filter(
          target => {
            const record =
              target.record;

            let secrets = {};

            try {
              secrets =
                record.customerSecrets
                  ? (
                      decryptJson(
                        record.customerSecrets
                      ) ||
                      {}
                    )
                  : {};
            } catch {
              secrets = {};
            }

            const email = String(record.customerProfile?.email || "").trim().toLowerCase();
            const ready = exportProfileMissingFields(
                record.customerProfile ||
                  {},
                secrets
              ).length === 0 && email && !countedEmails.has(email);
            if (ready) countedEmails.add(email);
            return ready;
          }
        ).length;

      return res.json({
        ok: true,

        profileCount:
          profileTargets.length,

        shippingFilled,

        cardsFilled,

        exportReadyCount,

        stillMissingShippingCount:
          profilesStillMissingShipping.length,

        duplicateAddressesRepaired,

        duplicateAddressesRemainingCount:
          duplicateAddressesRemaining.length,

        stillMissingCardCount:
          profilesStillMissingCard.length,

        crossRetailerAddressAndPaymentPool:
          true,

        retailerCredentialsPreserved:
          true,

        addressSourceCount:
          addresses.length,

        cardSourceCount:
          cards.length,

        linkedProfileCount:
          linkedRotationIndex,

        message:
          `Saved updates using ${addresses.length} unique customer address source(s) and ${cards.length} unique customer card(s). ${shippingFilled} profile(s) received a unique safe address formatting variant, ${cardsFilled} profile(s) received round-robin card information, ${exportReadyCount} profile(s) are export ready, and ${duplicateAddressesRemaining.length} duplicate address(es) could not be replaced because no unused safe variant remained.`
      });

    } catch (error) {
      console.error(
        "JIG & attach payment error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            "Unable to JIG addresses and attach payment information."
        });
    }
  }
);

app.get(
  "/api/admin/submissions/:id/linked-memberships",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        clean(
          req.params.id,
          150
        );

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const order =
        (
          Array.isArray(paid)
            ? paid
            : []
        ).find(
          item =>
            String(item.id) ===
            id
        );

      const customerAccountId =
        order?.customerAccountId ||
        null;

      if (!customerAccountId) {
        return res.json({
          ok: true,
          memberships: []
        });
      }

      const [
        memberships,
        freeAssignments,
        rentalAssignments
      ] = await Promise.all([
        getManagedAccounts(),
        getFreeAssignments(),
        getRentalAssignments()
      ]);

      const linkedManagedIds =
        new Set(
          [
            ...freeAssignments,
            ...rentalAssignments
          ]
            .filter(
              assignment =>
                managedAssignmentIsLinked(
                  assignment
                )
            )
            .map(
              assignment =>
                String(
                  assignment.managedAccountId ||
                  assignment.freeMembershipId ||
                  assignment.rentedMembershipId ||
                  ""
                )
            )
            .filter(Boolean)
        );

      const duplicateCredentialState =
        managedDuplicateCredentialState(
          memberships,
          linkedManagedIds
        );

      const active = [];

      for (const assignment of freeAssignments) {
        if (
          assignment.customerAccountId !==
            customerAccountId ||
          !managedAssignmentIsLinked(
            assignment
          )
        ) {
          continue;
        }

        const membership =
          memberships.find(
            item =>
              String(item.id) ===
              String(
                assignment.managedAccountId ||
                assignment.freeMembershipId ||
                ""
              )
          );

        if (!membership) {
          continue;
        }

        active.push({
          id:
            membership.id,

          assignmentId:
            assignment.id,

          type:
            "free",

          profileName:
            membership.profileName ||
            "Free Membership",

          accountEmail:
            membership.accountEmail ||
            "",

          retailers:
            managedRetailerCredentialsForAdmin(
              membership
            ),

          startsAt:
            assignment.startsAt ||
            null,

          expiresAt:
            assignment.expiresAt ||
            null,

          durationType:
            assignment.durationType ||
            null,

          activationStatus:
            managedAssignmentStatus(
              assignment
            ),

          active:
            assignment.active === true,

          duplicateManagedLogin:
            duplicateCredentialState
              .duplicateIds
              .has(
                String(
                  membership.id
                )
              ),

          duplicateOfManagedAccountId:
            duplicateCredentialState
              .duplicateOf
              .get(
                String(
                  membership.id
                )
              ) ||
            null,

          customerProfile:
            assignment.customerProfile ||
            {},

          jigNeeded: assignment.jigNeeded === true,
          exportAttemptStatus: assignment.exportAttemptStatus || null,
          exportAttemptedAt: assignment.exportAttemptedAt || null,
          updatedAt: assignment.updatedAt || null,

          customerCard:
            (() => {
              let secrets = {};

              try {
                if (
                  assignment.customerSecrets
                ) {
                  secrets =
                    decryptJson(
                      assignment.customerSecrets
                    );
                }
              } catch {
                secrets = {};
              }

              const digits =
                String(
                  secrets.acoCardNumber ||
                  ""
                ).replace(
                  /\D/g,
                  ""
                );

              return {
                cardLabel:
                  secrets.cardLabel ||
                  "",

                cardholder:
                  secrets.cardholder ||
                  "",

                cardNumber:
                  digits,

                maskedNumber:
                  digits
                    ? `•••• •••• •••• ${digits.slice(-4)}`
                    : "",

                expMonth:
                  secrets.expMonth ||
                  "",

                expYear:
                  secrets.expYear ||
                  "",

                securityCode:
                  secrets.securityCode ||
                  ""
              };
            })()
        });
      }

      for (const assignment of rentalAssignments) {
        if (
          assignment.customerAccountId !==
            customerAccountId ||
          !managedAssignmentIsLinked(
            assignment
          )
        ) {
          continue;
        }

        const membership =
          memberships.find(
            item =>
              String(item.id) ===
              String(
                assignment.managedAccountId ||
                assignment.rentedMembershipId ||
                ""
              )
          );

        if (!membership) {
          continue;
        }

        active.push({
          id:
            membership.id,

          assignmentId:
            assignment.id,

          type:
            "rented",

          profileName:
            membership.profileName ||
            "Rented Membership",

          accountEmail:
            membership.accountEmail ||
            "",

          retailers:
            managedRetailerCredentialsForAdmin(
              membership
            ),

          startsAt:
            assignment.startsAt ||
            null,

          expiresAt:
            assignment.expiresAt ||
            null,

          durationType:
            assignment.durationType ||
            null,

          activationStatus:
            managedAssignmentStatus(
              assignment
            ),

          active:
            assignment.active === true,

          duplicateManagedLogin:
            duplicateCredentialState
              .duplicateIds
              .has(
                String(
                  membership.id
                )
              ),

          duplicateOfManagedAccountId:
            duplicateCredentialState
              .duplicateOf
              .get(
                String(
                  membership.id
                )
              ) ||
            null,

          customerProfile:
            assignment.customerProfile ||
            {},

          jigNeeded: assignment.jigNeeded === true,
          exportAttemptStatus: assignment.exportAttemptStatus || null,
          exportAttemptedAt: assignment.exportAttemptedAt || null,
          updatedAt: assignment.updatedAt || null,

          customerCard:
            (() => {
              let secrets = {};

              try {
                if (
                  assignment.customerSecrets
                ) {
                  secrets =
                    decryptJson(
                      assignment.customerSecrets
                    );
                }
              } catch {
                secrets = {};
              }

              const digits =
                String(
                  secrets.acoCardNumber ||
                  ""
                ).replace(
                  /\D/g,
                  ""
                );

              return {
                cardLabel:
                  secrets.cardLabel ||
                  "",

                cardholder:
                  secrets.cardholder ||
                  "",

                cardNumber:
                  digits,

                maskedNumber:
                  digits
                    ? `•••• •••• •••• ${digits.slice(-4)}`
                    : "",

                expMonth:
                  secrets.expMonth ||
                  "",

                expYear:
                  secrets.expYear ||
                  "",

                securityCode:
                  secrets.securityCode ||
                  ""
              };
            })()
        });
      }

      for (
        const item of
        active
      ) {
        const exportSecrets = {
          cardholder:
            item.customerCard?.cardholder ||
            "",

          acoCardNumber:
            item.customerCard?.cardNumber ||
            "",

          expMonth:
            item.customerCard?.expMonth ||
            "",

          expYear:
            item.customerCard?.expYear ||
            "",

          securityCode:
            item.customerCard?.securityCode ||
            ""
        };

        item.readiness =
          managedProfileReadiness(
            item.customerProfile ||
            {},
            exportSecrets
          );

        const exportStatus =
          exportReadinessPayload(
            item.customerProfile ||
              {},
            exportSecrets
          );

        if (
          item.duplicateManagedLogin
        ) {
          exportStatus.exportReady =
            false;

          exportStatus.missingFields = [
            ...(
              Array.isArray(
                exportStatus.missingFields
              )
                ? exportStatus.missingFields
                : []
            ),
            "duplicate managed login"
          ];
        }

        item.exportReady =
          exportStatus.exportReady;

        item.missingFields =
          exportStatus.missingFields;

        const key =
          exactManagedAddressKey(
            item.customerProfile ||
            {}
          );

        item.exactAddressMatches =
          key
            ? active
                .filter(
                  other =>
                    String(other.id) !==
                      String(item.id) &&
                    exactManagedAddressKey(
                      other.customerProfile ||
                      {}
                    ) ===
                      key
                )
                .map(other => ({
                  id:
                    other.id,

                  type:
                    other.type,

                  profileName:
                    other.profileName,

                  accountEmail:
                    other.accountEmail
                }))
            : [];
      }

      return res.json({
        ok: true,
        memberships:
          active
      });

    } catch (error) {
      console.error(
        "Admin linked memberships error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to load linked profiles."
        });
    }
  }
);

app.post("/api/admin/submissions/:id/link-customer", requireAdmin, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: "Enter the customer's website sign-in email." });
    const accounts = await getCustomerAccounts();
    const account = accounts.find(item => normalizeEmail(item.email) === email && !item.disabled);
    if (!account) return res.status(404).json({ error: "No active website account has that sign-in email." });
    if (!account.emailVerifiedAt) return res.status(409).json({ error: "The customer must verify their sign-in email first." });
    const paid = await readJson(PAID_FILE, []);
    const order = (Array.isArray(paid) ? paid : []).find(item =>
      String(item.id) === String(req.params.id) || customerOrderNumber(item).toLowerCase() === String(req.params.id).toLowerCase());
    if (!order) return res.status(404).json({ error: "Paid order not found." });
    if (order.customerAccountId && String(order.customerAccountId) !== String(account.id)) {
      return res.status(409).json({ error: "This order is already linked to a different customer. Contact support before changing its owner." });
    }
    if (order.customerAccountId === account.id) return res.json({ ok: true, alreadyLinked: true });
    order.customerAccountId = account.id;
    order.customerLinkedAt = new Date().toISOString();
    order.customerLinkedBy = "admin";
    await writeJson(PAID_FILE, paid);
    return res.json({ ok: true, orderId: order.id, accountId: account.id });
  } catch (error) {
    console.error("Admin customer order link:", error);
    return res.status(500).json({ error: "Unable to link this order." });
  }
});

async function adminOrderCustomerAccount(
  orderId
) {
  const paid =
    await readJson(
      PAID_FILE,
      []
    );

  const order =
    (
      Array.isArray(paid)
        ? paid
        : []
    ).find(
      item =>
        String(item.id) ===
        String(orderId)
    );

  if (
    !order?.customerAccountId
  ) {
    return null;
  }

  const accounts =
    await getCustomerAccounts();

  return (
    accounts.find(
      account =>
        account.id ===
        order.customerAccountId
    ) ||
    null
  );
}

app.get(
  "/api/admin/submissions/:id/saved-details",
  requireAdmin,
  async (req, res) => {
    try {
      const account =
        await adminOrderCustomerAccount(
          req.params.id
        );

      if (!account) {
        return res.json({
          ok: true,
          addresses: [],
          paymentMethods: []
        });
      }

      const payload =
        await adminCustomerSavedDetailsPayload(
          account
        );

      return res.json({
        ok: true,
        ...payload
      });

    } catch (error) {
      console.error(
        "Admin saved details load error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to load saved customer details."
        });
    }
  }
);



app.put(
  "/api/admin/submissions/:id/saved-payment/:paymentId",
  requireAdmin,
  async (req, res) => {
    try {
      const orderId =
        clean(
          req.params.id,
          150
        );

      const paymentId =
        clean(
          req.params.paymentId,
          220
        );

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const order =
        (
          Array.isArray(paid)
            ? paid
            : []
        ).find(
          item =>
            String(item.id) ===
            String(orderId)
        );

      if (
        !order?.customerAccountId
      ) {
        return res
          .status(404)
          .json({
            error:
              "Customer account could not be found."
          });
      }

      const payload = {
        cardLabel:
          clean(
            req.body?.cardLabel,
            100
          ),

        cardholder:
          clean(
            req.body?.cardholder,
            150
          ),

        acoCardNumber:
          clean(
            req.body?.acoCardNumber,
            30
          ).replace(
            /\D/g,
            ""
          ),

        expMonth:
          clean(
            req.body?.expMonth,
            2
          ),

        expYear:
          clean(
            req.body?.expYear,
            4
          ),

        securityCode:
          clean(
            req.body?.securityCode,
            300
          )
      };

      if (
        !/^\d{12,19}$/.test(
          payload.acoCardNumber
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Enter a valid card number."
          });
      }

      if (
        !/^(0[1-9]|1[0-2])$/.test(
          payload.expMonth
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Enter a valid expiration month."
          });
      }

      if (
        !/^\d{4}$/.test(
          payload.expYear
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Enter a valid expiration year."
          });
      }

      const now =
        new Date()
          .toISOString();

      if (
        paymentId.startsWith(
          "paid-profile-card:"
        )
      ) {
        const profileId =
          paymentId.slice(
            "paid-profile-card:"
              .length
          );

        const profiles =
          await getRetailerProfiles();

        const record =
          profiles.find(
            item =>
              String(item.id) ===
                String(profileId) &&
              String(
                item.customerAccountId ||
                ""
              ) ===
                String(
                  order.customerAccountId
                )
          );

        if (!record) {
          return res
            .status(404)
            .json({
              error:
                "Paid profile card could not be found."
            });
        }

        let secrets = {};

        try {
          secrets =
            record.customerSecrets
              ? (
                  decryptJson(
                    record.customerSecrets
                  ) ||
                  {}
                )
              : {};
        } catch {
          secrets = {};
        }

        record.customerSecrets =
          encryptJson({
            ...secrets,
            ...payload
          });

        record.updatedAt =
          now;

        await saveRetailerProfiles(
          profiles
        );

      } else {
        const accounts =
          await getCustomerAccounts();

        const account =
          accounts.find(
            item =>
              String(item.id) ===
                String(
                  order.customerAccountId
                )
          );

        if (!account) {
          return res
            .status(404)
            .json({
              error:
                "Customer account could not be found."
            });
        }

        const vault =
          await getCustomerVault(
            account.id
          );

        const method =
          vault.paymentMethods.find(
            item =>
              String(item.id) ===
              String(paymentId)
          );

        if (!method) {
          return res
            .status(404)
            .json({
              error:
                "Saved payment card could not be found."
            });
        }

        Object.assign(
          method,
          payload,
          {
            updatedAt:
              now
          }
        );

        await saveCustomerVault(
          account.id,
          vault
        );
      }

      return res.json({
        ok: true
      });

    } catch (error) {
      console.error(
        "Admin saved payment update error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to update saved payment card."
        });
    }
  }
);


app.get(
  "/api/admin/profile-search",
  requireAdmin,
  async (req, res) => {
    try {
      const query =
        clean(
          req.query?.q,
          120
        )
          .trim()
          .toLowerCase();

      if (!query) {
        return res.json({
          ok: true,
          results: []
        });
      }

      const [
        paid,
        accounts,
        retailerProfiles,
        memberships,
        freeAssignments,
        rentalAssignments
      ] = await Promise.all([
        readJson(
          PAID_FILE,
          []
        ),
        getCustomerAccounts(),
        getRetailerProfiles(),
        getManagedAccounts(),
        getFreeAssignments(),
        getRentalAssignments()
      ]);

      const paidRecords =
        Array.isArray(paid)
          ? paid
          : [];

      const results = [];
      const seen =
        new Set();

      const normalized =
        value =>
          String(
            value ||
            ""
          )
            .trim()
            .toLowerCase();

      const prefixMatch =
        entries => {
          for (
            const entry of
            entries
          ) {
            const rawValue =
              entry?.value;

            const value =
              normalized(
                rawValue
              );

            if (
              value &&
              value.startsWith(
                query
              )
            ) {
              return {
                label:
                  entry.label ||
                  "Matched field",

                value:
                  entry.display ||
                  String(
                    rawValue ||
                    ""
                  )
              };
            }
          }

          return null;
        };

      const paidOrderForAccount =
        accountId =>
          paidRecords.find(
            record =>
              String(
                record.customerAccountId ||
                ""
              ) ===
                String(
                  accountId ||
                  ""
                )
          ) ||
          null;

      const accountForId =
        accountId =>
          accounts.find(
            item =>
              String(
                item.id
              ) ===
                String(
                  accountId ||
                  ""
                )
          ) ||
          null;

      const push =
        item => {
          const key =
            item.view === "paid"
              ? [
                  "paid",
                  item.orderId ||
                  item.customerAccountId
                ].join(":")
              : [
                  item.view,
                  item.customerAccountId,
                  item.profileId
                ].join(":");

          if (
            seen.has(
              key
            )
          ) {
            return;
          }

          seen.add(
            key
          );

          results.push(
            item
          );
        };

      /*
        PAID RETAILER PROFILES

        Search only actual customer/profile values:
        emails/usernames, shipping information and card information.
        Generic labels such as "Managed", "Paid Profile", retailer
        names, etc. are deliberately not part of the searchable values.
      */
      for (
        const record of
        retailerProfiles
      ) {
        let credentials =
          emptyRetailerCredentials();

        let secrets = {};

        try {
          credentials =
            record.credentials
              ? normalizeRetailerCredentials(
                  decryptJson(
                    record.credentials
                  )
                )
              : emptyRetailerCredentials();
        } catch {
          credentials =
            emptyRetailerCredentials();
        }

        try {
          secrets =
            record.customerSecrets
              ? (
                  decryptJson(
                    record.customerSecrets
                  ) ||
                  {}
                )
              : {};
        } catch {
          secrets = {};
        }

        const account =
          accountForId(
            record.customerAccountId
          );

        const order =
          paidOrderForAccount(
            record.customerAccountId
          );

        const cardDigits =
          String(
            secrets.acoCardNumber ||
            secrets.cardNumber ||
            ""
          ).replace(
            /\D/g,
            ""
          );

        const searchable = [
          {
            label:
              "Customer email",
            value:
              account?.email
          },
          {
            label:
              "Profile email",
            value:
              record.customerProfile
                ?.email
          },
          ...RETAILER_KEYS.map(
            retailer => ({
              label:
                `${retailerDisplayName(
                  retailer
                )} email / username`,
              value:
                credentials
                  ?.[retailer]
                  ?.username
            })
          ),
          {
            label:
              "First name",
            value:
              record.customerProfile
                ?.firstName
          },
          {
            label:
              "Last name",
            value:
              record.customerProfile
                ?.lastName
          },
          {
            label:
              "Phone",
            value:
              record.customerProfile
                ?.phone
          },
          {
            label:
              "Shipping address",
            value:
              record.customerProfile
                ?.address
          },
          {
            label:
              "Address line 2",
            value:
              record.customerProfile
                ?.address2
          },
          {
            label:
              "City",
            value:
              record.customerProfile
                ?.city
          },
          {
            label:
              "State",
            value:
              record.customerProfile
                ?.state
          },
          {
            label:
              "ZIP",
            value:
              record.customerProfile
                ?.zip
          },
          {
            label:
              "Cardholder",
            value:
              secrets.cardholder
          },
          {
            label:
              "Card label",
            value:
              secrets.cardLabel
          },
          {
            label:
              "Card number",
            value:
              cardDigits,
            display:
              cardDigits
                ? `Card ending ${cardDigits.slice(-4)}`
                : ""
          }
        ];

        const matched =
          prefixMatch(
            searchable
          );

        if (!matched) {
          continue;
        }

        const customerEmail =
          account?.email ||
          record.customerProfile
            ?.email ||
          order?.profile?.email ||
          "";

        push({
          view:
            "paid",

          orderId:
            order?.id ||
            "",

          customerAccountId:
            record.customerAccountId ||
            "",

          profileId:
            record.id,

          customerEmail,

          linkedEmail:
            "",

          matchedLabel:
            matched.label,

          matchedValue:
            matched.value,

          label:
            customerEmail ||
            "Customer"
        });
      }

      /*
        LINKED GIFTED / RENTED PROFILES

        Search only the actual linked/customer values. Do not search
        generic "Managed", "Gifted", "Rented", "Account" labels.
      */
      const addManaged =
        (
          assignments,
          type
        ) => {
          for (
            const assignment of
            assignments
          ) {
            if (
              !managedAssignmentIsLinked(
                assignment
              )
            ) {
              continue;
            }

            const membershipId =
              assignment.managedAccountId ||
              assignment.freeMembershipId ||
              assignment.rentedMembershipId ||
              assignment.id;

            const membership =
              memberships.find(
                item =>
                  String(item.id) ===
                  String(
                    membershipId
                  )
              );

            if (!membership) {
              continue;
            }

            const account =
              accountForId(
                assignment.customerAccountId
              );

            const secrets =
              decryptAssignmentSecrets(
                assignment
              );

            const cardDigits =
              String(
                secrets.acoCardNumber ||
                secrets.cardNumber ||
                ""
              ).replace(
                /\D/g,
                ""
              );

            let managedCredentials =
              emptyRetailerCredentials();

            try {
              managedCredentials =
                membership.credentials
                  ? normalizeRetailerCredentials(
                      decryptJson(
                        membership.credentials
                      )
                    )
                  : emptyRetailerCredentials();
            } catch {
              managedCredentials =
                emptyRetailerCredentials();
            }

            const linkedEmail =
              managedAccountCanonicalEmail(
                membership,
                managedCredentials
              );

            const customerEmail =
              account?.email ||
              assignment
                ?.customerProfile
                ?.email ||
              "";

            const searchable = [
              {
                label:
                  "Customer email",
                value:
                  customerEmail
              },
              {
                label:
                  "Linked profile email",
                value:
                  linkedEmail
              },
              {
                label:
                  "Target email / username",
                value:
                  managedCredentials
                    ?.target
                    ?.username
              },
              {
                label:
                  "Walmart email / username",
                value:
                  managedCredentials
                    ?.walmart
                    ?.username
              },
              {
                label:
                  "PKC email",
                value:
                  managedCredentials
                    ?.pkc
                    ?.username
              },
              {
                label:
                  "Sam's Club email / username",
                value:
                  managedCredentials
                    ?.samsClub
                    ?.username
              },
              {
                label:
                  "Costco email / username",
                value:
                  managedCredentials
                    ?.costco
                    ?.username
              },
              {
                label:
                  "First name",
                value:
                  assignment
                    ?.customerProfile
                    ?.firstName
              },
              {
                label:
                  "Last name",
                value:
                  assignment
                    ?.customerProfile
                    ?.lastName
              },
              {
                label:
                  "Phone",
                value:
                  assignment
                    ?.customerProfile
                    ?.phone
              },
              {
                label:
                  "Shipping address",
                value:
                  assignment
                    ?.customerProfile
                    ?.address
              },
              {
                label:
                  "Address line 2",
                value:
                  assignment
                    ?.customerProfile
                    ?.address2
              },
              {
                label:
                  "City",
                value:
                  assignment
                    ?.customerProfile
                    ?.city
              },
              {
                label:
                  "State",
                value:
                  assignment
                    ?.customerProfile
                    ?.state
              },
              {
                label:
                  "ZIP",
                value:
                  assignment
                    ?.customerProfile
                    ?.zip
              },
              {
                label:
                  "Cardholder",
                value:
                  secrets.cardholder
              },
              {
                label:
                  "Card label",
                value:
                  secrets.cardLabel
              },
              {
                label:
                  "Card number",
                value:
                  cardDigits,
                display:
                  cardDigits
                    ? `Card ending ${cardDigits.slice(-4)}`
                    : ""
              }
            ];

            const matched =
              prefixMatch(
                searchable
              );

            if (!matched) {
              continue;
            }

            push({
              view:
                type === "free"
                  ? "free-profile"
                  : "rented-profile",

              orderId:
                "",

              customerAccountId:
                assignment.customerAccountId ||
                "",

              profileId:
                membershipId,

              customerEmail,

              linkedEmail,

              matchedLabel:
                matched.label,

              matchedValue:
                matched.value,

              label:
                linkedEmail ||
                customerEmail ||
                "Linked Profile"
            });
          }
        };

      addManaged(
        freeAssignments,
        "free"
      );

      addManaged(
        rentalAssignments,
        "rented"
      );

      /*
        Customer-level paid order values remain searchable even if
        the customer does not yet have a saved retailer profile.
      */
      for (
        const account of
        accounts
      ) {
        const order =
          paidOrderForAccount(
            account.id
          );

        if (!order) {
          continue;
        }

        const searchable = [
          {
            label:
              "Customer email",
            value:
              account.email
          },
          {
            label:
              "Profile email",
            value:
              order?.profile?.email
          },
          {
            label:
              "First name",
            value:
              order?.profile?.firstName
          },
          {
            label:
              "Last name",
            value:
              order?.profile?.lastName
          },
          {
            label:
              "Phone",
            value:
              order?.profile?.phone
          },
          {
            label:
              "Shipping address",
            value:
              order?.profile?.address
          },
          {
            label:
              "Address line 2",
            value:
              order?.profile?.address2
          },
          {
            label:
              "City",
            value:
              order?.profile?.city
          },
          {
            label:
              "State",
            value:
              order?.profile?.state
          },
          {
            label:
              "ZIP",
            value:
              order?.profile?.zip
          }
        ];

        const matched =
          prefixMatch(
            searchable
          );

        if (!matched) {
          continue;
        }

        push({
          view:
            "paid",

          orderId:
            order.id,

          customerAccountId:
            account.id,

          profileId:
            "",

          customerEmail:
            account.email ||
            order?.profile?.email ||
            "",

          linkedEmail:
            "",

          matchedLabel:
            matched.label,

          matchedValue:
            matched.value,

          label:
            account.email ||
            order?.profile?.email ||
            "Customer"
        });
      }

      return res.json({
        ok: true,

        results:
          results.slice(
            0,
            30
          )
      });

    } catch (error) {
      console.error(
        "Admin profile search error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to search profiles."
        });
    }
  }
);


/* -------------------------------------------------------
   ADMIN RETAILER PROFILES
------------------------------------------------------- */

app.get(
  "/api/admin/submissions/:id/retailer-profiles",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        clean(
          req.params.id,
          150
        );

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const paidRecords =
        Array.isArray(paid)
          ? paid
          : [];

      const order =
        paidRecords.find(
          item =>
            String(
              item.id
            ) === id
        );

      let customerAccountId =
        order?.customerAccountId ||
        null;

      /*
        Free submissions use the customer
        account ID directly instead of a
        paid order ID.
      */

      if (!customerAccountId) {
        const accounts =
          await getCustomerAccounts();

        const account =
          accounts.find(
            item =>
              String(
                item.id
              ) === id
          );

        if (account) {
          customerAccountId =
            account.id;
        }
      }

      if (!customerAccountId) {
        return res
          .status(404)
          .json({
            error:
              "Customer account could not be found."
          });
      }

      const allowance =
        await getCustomerProfileAllowance(
          customerAccountId
        );

      const retailerRecords =
        await getRetailerProfiles();

      const owned =
        retailerRecords
          .filter(
            record =>
              record.customerAccountId ===
              customerAccountId
          )
          .sort(
            (a, b) =>
              Number(a.slot) -
              Number(b.slot)
          );

      const specialRecords =
        await getSpecialProfiles();

      const ownedSpecialProfiles =
        specialRecords
          .filter(
            record =>
              record.customerAccountId ===
              customerAccountId
          )
          .sort(
            (a, b) => {
              const typeOrder = {
                free: 1,
                rented: 2
              };

              return (
                (
                  typeOrder[
                    normalizeSpecialProfileType(
                      a.profileType
                    )
                  ] || 99
                ) -
                (
                  typeOrder[
                    normalizeSpecialProfileType(
                      b.profileType
                    )
                  ] || 99
                )
              );
            }
          );

      const profiles =
        owned.map(
          record =>
            adminRetailerProfile(
              record,
              allowance
            )
        );

      return res.json({
        ok: true,

        allowance,

        profiles,

        specialProfiles:
          ownedSpecialProfiles.map(
            record =>
              adminSpecialProfile(
                record
              )
          )
      });

    } catch (error) {
      console.error(
        "Admin retailer profile list error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to load retailer profiles."
        });
    }
  }
);

      


/* -------------------------------------------------------
   MANAGED MEMBERSHIP CUSTOMER DETAILS
------------------------------------------------------- */

function managedCustomerCardFromSecrets(
  secrets
) {
  return {
    cardLabel:
      clean(
        secrets?.cardLabel,
        100
      ),

    cardholder:
      clean(
        secrets?.cardholder,
        150
      ),

    acoCardNumber:
      clean(
        secrets?.acoCardNumber,
        30
      ).replace(
        /[^\d]/g,
        ""
      ),

    expMonth:
      clean(
        secrets?.expMonth,
        2
      ),

    expYear:
      clean(
        secrets?.expYear,
        4
      ),

    securityCode:
      clean(
        secrets?.securityCode,
        300
      )
  };
}


function mergeManagedCustomerProfile(
  existingProfile,
  submittedProfile,
  fallbackEmail = ""
) {
  const existing =
    existingProfile &&
    typeof existingProfile ===
      "object"
      ? existingProfile
      : {};

  const submitted =
    submittedProfile &&
    typeof submittedProfile ===
      "object"
      ? submittedProfile
      : {};

  return sanitizeProfile({
    ...existing,
    ...submitted,

    profileName:
      submitted.profileName ||
      existing.profileName ||
      "Managed Membership",

    email:
      submitted.email ||
      existing.email ||
      fallbackEmail ||
      ""
  });
}


function mergeManagedCustomerSecrets(
  existingSecrets,
  submittedCard
) {
  const existing =
    existingSecrets &&
    typeof existingSecrets ===
      "object"
      ? existingSecrets
      : {};

  const submitted =
    submittedCard &&
    typeof submittedCard ===
      "object"
      ? submittedCard
      : {};

  return {
    ...existing,

    cardLabel:
      clean(
        submitted.cardLabel,
        100
      ),

    cardholder:
      clean(
        submitted.cardholder,
        150
      ),

    acoCardNumber:
      clean(
        submitted.acoCardNumber,
        30
      ).replace(
        /[^\d]/g,
        ""
      ),

    expMonth:
      clean(
        submitted.expMonth,
        2
      ),

    expYear:
      clean(
        submitted.expYear,
        4
      ),

    securityCode:
      clean(
        submitted.securityCode,
        300
      )
  };
}



app.post(
  "/api/account/managed-memberships/:type/:assignmentId/autofill",
  requireCustomer,
  async (req, res) => {
    try {
      const type =
        clean(
          req.params.type,
          20
        );

      const assignmentId =
        clean(
          req.params.assignmentId,
          150
        );

      if (
        type !== "free" &&
        type !== "rented"
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid managed membership type."
          });
      }

      const assignments =
        type === "free"
          ? await getFreeAssignments()
          : await getRentalAssignments();

      const isActive =
        type === "free"
          ? freeAssignmentIsActive
          : rentalAssignmentIsActive;

      const assignment =
        assignments.find(
          item =>
            String(
              item.id
            ) ===
              String(
                assignmentId
              ) &&
            String(
              item.customerAccountId ||
              ""
            ) ===
              String(
                req.customerAccount.id
              ) &&
            isActive(item)
        );

      if (!assignment) {
        return res
          .status(404)
          .json({
            error:
              "Managed membership assignment could not be found."
          });
      }

      const addressId =
        clean(
          req.body?.shippingAddressId,
          150
        );

      const paymentId =
        clean(
          req.body?.paymentMethodId,
          150
        );

      if (
        !addressId &&
        !paymentId
      ) {
        return res
          .status(400)
          .json({
            error:
              "Choose a saved shipping address or payment card."
          });
      }

      const selected =
        await savedCheckoutSelection(
          req.customerAccount,
          addressId,
          paymentId
        );

      if (
        addressId &&
        !selected.address
      ) {
        return res
          .status(400)
          .json({
            error:
              "The selected shipping address could not be found."
          });
      }

      if (
        paymentId &&
        !selected.payment
      ) {
        return res
          .status(400)
          .json({
            error:
              "The selected payment card could not be found."
          });
      }

      let existingSecrets = {};

      try {
        if (
          assignment.customerSecrets
        ) {
          existingSecrets =
            decryptJson(
              assignment.customerSecrets
            ) || {};
        }
      } catch {
        existingSecrets = {};
      }

      assignment.customerProfile =
        shippingProfileFromSavedAddress(
          selected.address,
          req.customerAccount.email,
          assignment.customerProfile ||
          {}
        );

      const nextSecrets =
        paymentSecretsFromSavedPayment(
          selected.payment,
          existingSecrets
        );

      assignment.customerSecrets =
        encryptJson(
          nextSecrets
        );

      assignment.selectedAddressId =
        addressId ||
        assignment.selectedAddressId ||
        null;

      assignment.selectedPaymentId =
        paymentId ||
        assignment.selectedPaymentId ||
        null;

      assignment.customerUpdatedAt =
        new Date()
          .toISOString();

      assignment.updatedAt =
        assignment.customerUpdatedAt;

      const readiness =
        managedProfileReadiness(
          assignment.customerProfile,
          nextSecrets
        );

      const previousStatus =
        normalizeProfileActivationStatus(
          assignment.activationStatus,
          false
        );

      assignment.activationStatus =
        readiness.ready
          ? (
              previousStatus ===
                "activated"
                ? "activated"
                : "awaiting_activation"
            )
          : "incomplete";

      if (
        assignment.activationStatus ===
        "awaiting_activation"
      ) {
        assignment.activationRequestedAt =
          assignment.activationRequestedAt ||
          assignment.customerUpdatedAt;
      }

      if (type === "free") {
        await saveFreeAssignments(
          assignments
        );
      } else {
        await saveRentalAssignments(
          assignments
        );
      }

      if (
        assignment.activationStatus ===
        "awaiting_activation"
      ) {
        const discordChanged =
          await ensureManagedProfileDiscordMessage(
            assignment,
            type
          );

        if (discordChanged) {
          if (type === "free") {
            await saveFreeAssignments(
              assignments
            );
          } else {
            await saveRentalAssignments(
              assignments
            );
          }
        }
      }

      return res.json({
        ok: true,
        readiness,
        activationStatus:
          assignment.activationStatus,
        message:
          readiness.ready
            ? "Saved information applied. This profile is now ACTIVATING and is awaiting admin activation."
            : "Saved information applied. Additional profile information is still required."
      });

    } catch (error) {
      console.error(
        "Managed membership autofill error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to apply saved profile information."
        });
    }
  }
);


app.put(
  "/api/account/managed-memberships/:type/:assignmentId",
  requireCustomer,
  async (req, res) => {
    try {
      const type =
        clean(
          req.params.type,
          20
        );

      const assignmentId =
        clean(
          req.params.assignmentId,
          150
        );

      if (
        type !== "free" &&
        type !== "rented"
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid managed membership type."
          });
      }

      const assignments =
        type === "free"
          ? await getFreeAssignments()
          : await getRentalAssignments();

      const isActive =
        type === "free"
          ? freeAssignmentIsActive
          : rentalAssignmentIsActive;

      const assignment =
        assignments.find(
          item =>
            String(
              item.id
            ) === assignmentId &&
            String(
              item.customerAccountId ||
              ""
            ) ===
              String(
                req.customerAccount.id
              ) &&
            isActive(item)
        );

      if (!assignment) {
        return res
          .status(404)
          .json({
            error:
              "Managed membership assignment could not be found."
          });
      }

      let existingSecrets = {};

      try {
        if (
          assignment.customerSecrets
        ) {
          existingSecrets =
            decryptJson(
              assignment.customerSecrets
            );
        }
      } catch {
        existingSecrets = {};
      }

      const customerProfile =
        mergeManagedCustomerProfile(
          assignment.customerProfile,
          req.body?.customerProfile,
          req.customerAccount.email
        );

      const customerSecrets =
        mergeManagedCustomerSecrets(
          existingSecrets,
          req.body?.customerCard
        );

      assignment.customerProfile =
        customerProfile;

      assignment.customerSecrets =
        encryptJson(
          customerSecrets
        );

      assignment.customerUpdatedAt =
        new Date()
          .toISOString();

      assignment.updatedAt =
        assignment.customerUpdatedAt;

      const readiness =
        managedProfileReadiness(
          customerProfile,
          customerSecrets
        );

      const previousStatus =
        normalizeProfileActivationStatus(
          assignment.activationStatus,
          false
        );

      assignment.activationStatus =
        readiness.ready
          ? (
              previousStatus ===
                "activated"
                ? "activated"
                : "awaiting_activation"
            )
          : "incomplete";

      if (
        assignment.activationStatus ===
        "awaiting_activation"
      ) {
        assignment.activationRequestedAt =
          assignment.activationRequestedAt ||
          assignment.customerUpdatedAt;
      }

      if (type === "free") {
        await saveFreeAssignments(
          assignments
        );
      } else {
        await saveRentalAssignments(
          assignments
        );
      }

      if (
        assignment.activationStatus ===
        "awaiting_activation"
      ) {
        const discordChanged =
          await ensureManagedProfileDiscordMessage(
            assignment,
            type
          );

        if (discordChanged) {
          if (type === "free") {
            await saveFreeAssignments(
              assignments
            );
          } else {
            await saveRentalAssignments(
              assignments
            );
          }
        }
      }

      return res.json({
        ok: true,

        activationStatus:
          assignment.activationStatus,

        customerProfile,

        customerCard:
          managedCustomerCardFromSecrets(
            customerSecrets
          ),

        updatedAt:
          assignment.customerUpdatedAt,

        message:
          "Managed membership details saved successfully."
      });

    } catch (error) {
      console.error(
        "Customer managed membership update error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to save managed membership details."
        });
    }
  }
);




app.post(
  "/api/admin/managed-memberships/:type/:id/jig-address",
  requireAdmin,
  async (req, res) => {
    try {
      const type =
        clean(
          req.params.type,
          20
        );

      const id =
        clean(
          req.params.id,
          150
        );

      if (
        type !== "free" &&
        type !== "rented"
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid managed membership type."
          });
      }

      const savedAddressId =
        clean(
          req.body?.savedAddressId,
          150
        );

      const manualRaw =
        req.body?.manualAddress &&
        typeof req.body.manualAddress ===
          "object"
          ? req.body.manualAddress
          : null;

      const manualAddress =
        manualRaw
          ? {
              id:
                "manual-address",

              label:
                "Manual Address",

              firstName:
                clean(
                  manualRaw.firstName,
                  120
                ),

              lastName:
                clean(
                  manualRaw.lastName,
                  120
                ),

              phone:
                clean(
                  manualRaw.phone,
                  80
                ),

              address:
                clean(
                  manualRaw.address,
                  240
                ),

              address2:
                clean(
                  manualRaw.address2,
                  160
                ),

              city:
                clean(
                  manualRaw.city,
                  120
                ),

              state:
                clean(
                  manualRaw.state,
                  80
                ),

              zip:
                clean(
                  manualRaw.zip,
                  40
                ),

              country:
                clean(
                  manualRaw.country ||
                  "US",
                  80
                )
            }
          : null;

      const usingManualAddress =
        Boolean(
          manualAddress?.address &&
          manualAddress?.city &&
          manualAddress?.state &&
          manualAddress?.zip
        );

      if (
        !savedAddressId &&
        !usingManualAddress
      ) {
        return res
          .status(400)
          .json({
            error:
              "Select a saved shipping address or enter a complete manual address before using JIG."
          });
      }

      const assignments =
        type === "free"
          ? await getFreeAssignments()
          : await getRentalAssignments();

      const assignment =
        type === "free"
          ? linkedFreeAssignment(
              assignments,
              id
            )
          : linkedRentalAssignment(
              assignments,
              id
            );

      if (!assignment) {
        return res
          .status(404)
          .json({
            error:
              "This managed account is not currently assigned."
          });
      }

      if (assignment.jiggedAddress) {
        return res.json({ ok: true, variant: assignment.jiggedAddress,
          message: "This profile already has a JIG. Use Show Jigs to edit it without changing the main address." });
      }

      const accounts =
        await getCustomerAccounts();

      const account =
        accounts.find(
          item =>
            String(item.id) ===
            String(
              assignment.customerAccountId ||
              ""
            )
        );

      if (!account) {
        return res
          .status(404)
          .json({
            error:
              "Assigned customer account could not be found."
          });
      }

      let sourceAddress =
        manualAddress;

      if (!usingManualAddress) {
        const payload =
          await adminCustomerSavedDetailsPayload(
            account
          );

        const addresses =
          Array.isArray(
            payload.addresses
          )
            ? [...payload.addresses]
            : [];

        /*
          Add the paid account's original shipping address here
          as well so JIG works when that is the selected source.
        */
        const paid =
          await readJson(
            PAID_FILE,
            []
          );

        const paidRecords =
          Array.isArray(paid)
            ? paid
            : [];

        const originalPaidRecord =
          paidRecords.find(
            record =>
              String(
                record.customerAccountId ||
                ""
              ) ===
                String(
                  assignment.customerAccountId ||
                  ""
                ) &&
              record.profile?.address
          );

        if (
          originalPaidRecord?.profile?.address
        ) {
          const p =
            sanitizeProfile(
              originalPaidRecord.profile
            );

          addresses.unshift({
            id:
              "original-account-shipping",
            label:
              "Original Account Shipping",
            firstName:
              p.firstName,
            lastName:
              p.lastName,
            phone:
              p.phone,
            address:
              p.address,
            address2:
              p.address2,
            city:
              p.city,
            state:
              p.state,
            zip:
              p.zip,
            country:
              p.country
          });
        }

        sourceAddress =
          addresses.find(
            item =>
              String(item.id) ===
              String(savedAddressId)
          ) ||
          null;
      }

      if (!sourceAddress) {
        return res
          .status(404)
          .json({
            error:
              "That shipping address could not be found."
          });
      }

      const orders = await readJson(PAID_FILE, []);
      const customerOrder = (Array.isArray(orders) ? orders : []).find(item =>
        String(item.customerAccountId || "") === String(account.id)
      );
      const paidProfiles = (await getRetailerProfiles()).filter(item => String(item.customerAccountId || "") === String(account.id));
      const pool = await customerJigPoolWithSources(account, customerOrder, paidProfiles);
      const poolSource = pool.sources.find(item =>
        safeAddressVariantKey(item.original) === safeAddressVariantKey(sourceAddress)
      );
      if (!poolSource) return res.status(400).json({ error: "Choose one of this customer's unchanged main addresses." });

      const variants = (poolSource.variants || []).map(item => item.address);

      if (!variants.length) {
        return res
          .status(400)
          .json({
            error:
              "No safe address formatting variants are available for this address."
          });
      }

      const sourceKey =
        usingManualAddress
          ? safeAddressVariantKey(
              sourceAddress
            )
          : String(
              savedAddressId
            );

      /*
        Permanent no-repeat rule:
        Once a safe JIG variant has been created for this customer
        from this source address, never create that exact stored
        address again. History remains even if JIG is later removed.
      */
      const usedKeys =
        new Set();

      for (
        const item of
        assignments
      ) {
        if (
          String(
            item.customerAccountId ||
            ""
          ) !==
            String(
              assignment.customerAccountId ||
              ""
            )
        ) {
          continue;
        }

        const itemSourceKey =
          String(
            item.jigSourceKey ||
            item.savedAddressId ||
            ""
          );

        if (
          itemSourceKey !==
            String(sourceKey)
        ) {
          continue;
        }

        if (item.jiggedAddress) {
          usedKeys.add(
            safeAddressVariantKey(
              item.jiggedAddress
            )
          );
        }

        const history =
          Array.isArray(
            item.jigHistoryKeys
          )
            ? item.jigHistoryKeys
            : [];

        for (
          const historyKey of
          history
        ) {
          if (historyKey) {
            usedKeys.add(
              String(
                historyKey
              )
            );
          }
        }
      }

      const chosen =
        variants.find(
          item =>
            !usedKeys.has(
              safeAddressVariantKey(
                item
              )
            )
        );

      if (!chosen) {
        assignment.jigNeeded = true;
        if (type === "free") await saveFreeAssignments(assignments);
        else await saveRentalAssignments(assignments);
        return res
          .status(409)
          .json({
            error:
              `No more JIGs available for this address. All ${variants.length} safe variants have already been used.`
          });
      }

      const chosenIndex =
        Math.max(
          0,
          variants.findIndex(
            item =>
              safeAddressVariantKey(
                item
              ) ===
              safeAddressVariantKey(
                chosen
              )
          )
        );

      assignment.savedAddressId =
        usingManualAddress
          ? "manual-address"
          : savedAddressId;

      assignment.jigSourceKey =
        sourceKey;

      assignment.jigSourceAddress = {
        firstName:
          sourceAddress.firstName ||
          "",

        lastName:
          sourceAddress.lastName ||
          "",

        phone:
          sourceAddress.phone ||
          "",

        address:
          sourceAddress.address ||
          "",

        address2:
          sourceAddress.address2 ||
          "",

        city:
          sourceAddress.city ||
          "",

        state:
          sourceAddress.state ||
          "",

        zip:
          sourceAddress.zip ||
          "",

        country:
          sourceAddress.country ||
          ""
      };

      assignment.jigVariantIndex =
        chosenIndex + 1;

      const chosenKey =
        safeAddressVariantKey(
          chosen
        );

      assignment.jigHistoryKeys =
        Array.from(
          new Set([
            ...(
              Array.isArray(
                assignment.jigHistoryKeys
              )
                ? assignment.jigHistoryKeys
                : []
            ),
            chosenKey
          ])
        );

      assignment.jiggedAddress = {
        ...chosen
      };
      let poolVariant = poolSource.variants.find(item => safeAddressVariantKey(item.address) === chosenKey);
      if (!poolVariant) {
        poolVariant = { id: crypto.randomUUID(), address: { ...chosen } };
        poolSource.variants.push(poolVariant);
      }
      assignment.jigPoolVariantId = poolVariant.id;
      assignment.jigNeeded = false;
      assignment.exportAttemptStatus = null;
      await saveCustomerJigPool(account.id, pool);

      assignment.customerProfile = {
        ...(
          assignment.customerProfile ||
          {}
        ),

        firstName:
          sourceAddress.firstName ||
          assignment.customerProfile
            ?.firstName ||
          "",

        lastName:
          sourceAddress.lastName ||
          assignment.customerProfile
            ?.lastName ||
          "",

        phone:
          sourceAddress.phone ||
          assignment.customerProfile
            ?.phone ||
          "",

        address:
          chosen.address ||
          "",

        address2:
          chosen.address2 ||
          "",

        city:
          chosen.city ||
          "",

        state:
          chosen.state ||
          "",

        zip:
          chosen.zip ||
          "",

        country:
          chosen.country ||
          ""
      };

      assignment.updatedAt =
        new Date()
          .toISOString();

      if (type === "free") {
        await saveFreeAssignments(
          assignments
        );
      } else {
        await saveRentalAssignments(
          assignments
        );
      }

      return res.json({
        ok: true,

        savedAddressId:
          assignment.savedAddressId,

        variant:
          chosen,

        variantNumber:
          chosenIndex + 1,

        totalVariants:
          variants.length
      });

    } catch (error) {
      console.error(
        "Managed JIG address error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to create a safe address variant."
        });
    }
  }
);


app.delete(
  "/api/admin/managed-memberships/:type/:id/jig-address",
  requireAdmin,
  async (req, res) => {
    try {
      const type =
        clean(
          req.params.type,
          20
        );

      const id =
        clean(
          req.params.id,
          150
        );

      const assignments =
        type === "free"
          ? await getFreeAssignments()
          : type === "rented"
            ? await getRentalAssignments()
            : null;

      if (!assignments) {
        return res
          .status(400)
          .json({
            error:
              "Invalid managed membership type."
          });
      }

      const assignment =
        type === "free"
          ? linkedFreeAssignment(
              assignments,
              id
            )
          : linkedRentalAssignment(
              assignments,
              id
            );

      if (!assignment) {
        return res
          .status(404)
          .json({
            error:
              "This managed profile is not currently assigned."
          });
      }

      const source =
        assignment.jigSourceAddress &&
        typeof assignment.jigSourceAddress ===
          "object"
          ? assignment.jigSourceAddress
          : null;

      if (source) {
        assignment.customerProfile = {
          ...(
            assignment.customerProfile ||
            {}
          ),

          firstName:
            source.firstName ||
            assignment.customerProfile?.firstName ||
            "",

          lastName:
            source.lastName ||
            assignment.customerProfile?.lastName ||
            "",

          phone:
            source.phone ||
            assignment.customerProfile?.phone ||
            "",

          address:
            source.address ||
            "",

          address2:
            source.address2 ||
            "",

          city:
            source.city ||
            "",

          state:
            source.state ||
            "",

          zip:
            source.zip ||
            "",

          country:
            source.country ||
            ""
        };
      }

      delete assignment.jiggedAddress;
      delete assignment.jigVariantIndex;
      delete assignment.jigSourceKey;
      delete assignment.jigSourceAddress;

      /*
        Do NOT delete jigHistoryKeys.
        Used JIG variants remain permanently unavailable for this
        customer/source so an exact JIG is never created twice.
      */

      assignment.updatedAt =
        new Date()
          .toISOString();

      if (type === "free") {
        await saveFreeAssignments(
          assignments
        );
      } else {
        await saveRentalAssignments(
          assignments
        );
      }

      return res.json({
        ok: true,
        customerProfile:
          assignment.customerProfile ||
          {}
      });

    } catch (error) {
      console.error(
        "Managed JIG remove error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to remove the JIG address."
        });
    }
  }
);


app.get(
  "/api/admin/managed-memberships/:type/:id/saved-details",
  requireAdmin,
  async (req, res) => {
    try {
      const type =
        clean(
          req.params.type,
          20
        );

      const id =
        clean(
          req.params.id,
          150
        );

      if (
        type !== "free" &&
        type !== "rented"
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid managed membership type."
          });
      }

      const assignments =
        type === "free"
          ? await getFreeAssignments()
          : await getRentalAssignments();

      const assignment =
        type === "free"
          ? currentFreeAssignment(
              assignments,
              id
            )
          : currentRentalAssignment(
              assignments,
              id
            );

      if (!assignment) {
        return res
          .status(404)
          .json({
            error:
              "This managed account is not currently assigned."
          });
      }

      const accounts =
        await getCustomerAccounts();

      const account =
        accounts.find(
          item =>
            String(item.id) ===
            String(
              assignment.customerAccountId ||
              ""
            )
        );

      if (!account) {
        return res
          .status(404)
          .json({
            error:
              "Assigned customer account could not be found."
          });
      }

      const payload =
        await adminCustomerSavedDetailsPayload(
          account
        );

      const addresses =
        Array.isArray(
          payload.addresses
        )
          ? [...payload.addresses]
          : [];

      /*
        Also include the original shipping address submitted
        with the customer's paid membership/account.
      */
      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const paidRecords =
        Array.isArray(paid)
          ? paid
          : [];

      const originalPaidRecord =
        paidRecords.find(
          record =>
            (
              assignment.paidSubmissionId &&
              String(record.id) ===
                String(
                  assignment.paidSubmissionId
                )
            ) ||
            (
              String(
                record.customerAccountId ||
                ""
              ) ===
                String(
                  assignment.customerAccountId ||
                  ""
                ) &&
              record.profile?.address
            )
        );

      const originalProfile =
        originalPaidRecord?.profile &&
        typeof originalPaidRecord.profile ===
          "object"
          ? sanitizeProfile(
              originalPaidRecord.profile
            )
          : null;

      if (
        originalProfile?.address &&
        originalProfile?.city &&
        originalProfile?.state &&
        originalProfile?.zip
      ) {
        const originalAddress = {
          id:
            "original-account-shipping",

          label:
            "Original Account Shipping",

          firstName:
            originalProfile.firstName ||
            "",

          lastName:
            originalProfile.lastName ||
            "",

          phone:
            originalProfile.phone ||
            "",

          address:
            originalProfile.address ||
            "",

          address2:
            originalProfile.address2 ||
            "",

          city:
            originalProfile.city ||
            "",

          state:
            originalProfile.state ||
            "",

          zip:
            originalProfile.zip ||
            "",

          country:
            originalProfile.country ||
            "US"
        };

        const originalKey =
          [
            originalAddress.address,
            originalAddress.address2,
            originalAddress.city,
            originalAddress.state,
            originalAddress.zip
          ]
            .join("|")
            .toLowerCase();

        const duplicate =
          addresses.some(item =>
            [
              item?.address,
              item?.address2,
              item?.city,
              item?.state,
              item?.zip
            ]
              .join("|")
              .toLowerCase() ===
            originalKey
          );

        if (!duplicate) {
          addresses.unshift(
            originalAddress
          );
        }
      }

      return res.json({
        ok: true,

        selectedAddressId:
          assignment.savedAddressId ||
          "",

        selectedPaymentMethodId:
          assignment.savedPaymentMethodId ||
          "",

        addresses,

        paymentMethods:
          payload.paymentMethods ||
          [],

        jiggedAddress:
          assignment.jiggedAddress ||
          null,

        jigVariantNumber:
          assignment.jigVariantIndex ||
          null
      });

    } catch (error) {
      console.error(
        "Admin managed saved details load error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to load saved customer address/card options."
        });
    }
  }
);


app.put(
  "/api/admin/managed-memberships/:type/:id/customer-details",
  requireAdmin,
  async (req, res) => {
    try {
      const type =
        clean(
          req.params.type,
          20
        );

      const id =
        clean(
          req.params.id,
          150
        );

      if (
        type !== "free" &&
        type !== "rented"
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid managed membership type."
          });
      }

      const assignments =
        type === "free"
          ? await getFreeAssignments()
          : await getRentalAssignments();

      const assignment =
        type === "free"
          ? linkedFreeAssignment(
              assignments,
              id
            )
          : linkedRentalAssignment(
              assignments,
              id
            );

      if (!assignment) {
        return res
          .status(404)
          .json({
            error:
              "This managed account is not currently assigned."
          });
      }

      let existingSecrets = {};

      try {
        if (
          assignment.customerSecrets
        ) {
          existingSecrets =
            decryptJson(
              assignment.customerSecrets
            );
        }
      } catch {
        existingSecrets = {};
      }

      const customerProfile =
        mergeManagedCustomerProfile(
          assignment.customerProfile,
          req.body?.customerProfile
        );

      const customerSecrets =
        mergeManagedCustomerSecrets(
          existingSecrets,
          req.body?.customerCard
        );

      assignment.customerProfile =
        customerProfile;

      assignment.customerSecrets =
        encryptJson(
          customerSecrets
        );

      if (
        Object.prototype.hasOwnProperty.call(
          req.body || {},
          "savedAddressId"
        )
      ) {
        assignment.savedAddressId =
          clean(
            req.body?.savedAddressId,
            150
          );
      }

      if (
        Object.prototype.hasOwnProperty.call(
          req.body || {},
          "savedPaymentMethodId"
        )
      ) {
        assignment.savedPaymentMethodId =
          clean(
            req.body?.savedPaymentMethodId,
            150
          );
      }

      assignment.customerUpdatedAt =
        new Date()
          .toISOString();

      assignment.updatedAt =
        assignment.customerUpdatedAt;

      if (type === "free") {
        await saveFreeAssignments(
          assignments
        );
      } else {
        await saveRentalAssignments(
          assignments
        );
      }

      if (
        assignment.customerAccountId
      ) {
        await syncCustomerMissingNotification(
          assignment.customerAccountId
        );
      }

      return res.json({
        ok: true,

        customerProfile,

        customerCard:
          managedCustomerCardFromSecrets(
            customerSecrets
          ),

        message:
          "Managed customer details saved successfully."
      });

    } catch (error) {
      console.error(
        "Admin managed customer details update error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to save managed customer details."
        });
    }
  }
);


app.delete(
  "/api/admin/managed-memberships/:type/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const type =
        clean(
          req.params.type,
          20
        );

      const id =
        clean(
          req.params.id,
          150
        );

      if (
        type !== "free" &&
        type !== "rented"
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid managed membership type."
          });
      }

      const managedAccounts =
        await getManagedAccounts();

      const index =
        managedAccounts.findIndex(
          item =>
            String(
              item.id
            ) === id
        );

      if (index < 0) {
        return res
          .status(404)
          .json({
            error:
              "Managed membership could not be found."
          });
      }

      managedAccounts.splice(
        index,
        1
      );

      const freeAssignments =
        await getFreeAssignments();

      const rentalAssignments =
        await getRentalAssignments();

      const remainingFreeAssignments =
        freeAssignments.filter(
          assignment =>
            String(
              assignment.freeMembershipId ||
              ""
            ) !== id
        );

      const remainingRentalAssignments =
        rentalAssignments.filter(
          assignment =>
            String(
              assignment.rentedMembershipId ||
              ""
            ) !== id
        );

      await Promise.all([
        saveManagedAccounts(
          managedAccounts
        ),

        saveFreeAssignments(
          remainingFreeAssignments
        ),

        saveRentalAssignments(
          remainingRentalAssignments
        )
      ]);

      return res.json({
        ok: true,

        message:
          "Managed membership permanently deleted."
      });

    } catch (error) {
      console.error(
        "Managed membership delete error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to delete managed membership."
        });
    }
  }
);




/* -------------------------------------------------------
   ADMIN TEST CUSTOMER PROFILE WORKFLOW
------------------------------------------------------- */


app.get(
  "/api/admin/test-managed-profile-workflow",
  requireAdmin,
  async (req, res) => {
    try {
      const [
        freeAssignments,
        rentalAssignments
      ] = await Promise.all([
        getFreeAssignments(),
        getRentalAssignments()
      ]);

      const profiles = [
        ...freeAssignments
          .filter(
            item =>
              String(
                item.customerAccountId ||
                ""
              ) ===
              "ADMIN-PREVIEW" &&
              item.testPreview ===
                true
          )
          .map(
            item => ({
              assignmentId:
                item.id,
              type:
                "free",
              activationStatus:
                normalizeProfileActivationStatus(
                  item.activationStatus,
                  false
                ),
              activationLabel:
                profileActivationLabel(
                  item.activationStatus
                )
            })
          ),

        ...rentalAssignments
          .filter(
            item =>
              String(
                item.customerAccountId ||
                ""
              ) ===
              "ADMIN-PREVIEW" &&
              item.testPreview ===
                true
          )
          .map(
            item => ({
              assignmentId:
                item.id,
              type:
                "rented",
              activationStatus:
                normalizeProfileActivationStatus(
                  item.activationStatus,
                  false
                ),
              activationLabel:
                profileActivationLabel(
                  item.activationStatus
                )
            })
          )
      ];

      return res.json({
        ok: true,
        profiles
      });

    } catch (error) {
      console.error(
        "Admin test managed workflow load error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to load test managed profile workflow."
        });
    }
  }
);


app.put(
  "/api/admin/test-managed-profile-workflow",
  requireAdmin,
  async (req, res) => {
    try {
      const type =
        clean(
          req.body?.type,
          20
        );

      const assignmentId =
        clean(
          req.body?.assignmentId,
          150
        );

      if (
        ![
          "free",
          "rented"
        ].includes(type) ||
        !assignmentId
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid test managed profile."
          });
      }

      const assignments =
        type === "free"
          ? await getFreeAssignments()
          : await getRentalAssignments();

      let assignment =
        assignments.find(
          item =>
            String(
              item.id
            ) ===
              String(
                assignmentId
              ) &&
            String(
              item.customerAccountId ||
              ""
            ) ===
              "ADMIN-PREVIEW"
        );

      const customerProfile =
        sanitizeProfile({
          ...(req.body
            ?.customerProfile ||
            {}),
          profileName:
            type === "free"
              ? "Gifted Profile"
              : "Rented Profile",
          email:
            req.body
              ?.customerProfile
              ?.email ||
            "admin-preview@slabsngrabsaco.com"
        });

      const card =
        req.body
          ?.customerCard &&
        typeof req.body
          .customerCard ===
          "object"
          ? req.body
              .customerCard
          : {};

      const customerSecrets = {
        cardLabel:
          clean(
            card.cardLabel,
            100
          ),
        cardholder:
          clean(
            card.cardholder,
            150
          ),
        acoCardNumber:
          clean(
            card.acoCardNumber,
            30
          ).replace(
            /[^\d]/g,
            ""
          ),
        expMonth:
          clean(
            card.expMonth,
            2
          ),
        expYear:
          clean(
            card.expYear,
            4
          ),
        securityCode:
          clean(
            card.securityCode,
            300
          )
      };

      const readiness =
        managedProfileReadiness(
          customerProfile,
          customerSecrets
        );

      const previousStatus =
        String(
          assignment
            ?.activationStatus ||
          ""
        )
          .trim()
          .toLowerCase();

      const activationStatus =
        readiness.ready
          ? (
              previousStatus ===
                "activated"
                ? "activated"
                : "awaiting_activation"
            )
          : "incomplete";

      const now =
        new Date()
          .toISOString();

      if (!assignment) {
        assignment = {
          id:
            assignmentId,
          customerAccountId:
            "ADMIN-PREVIEW",
          active:
            true,
          testPreview:
            true,
          createdAt:
            now
        };

        if (
          type === "free"
        ) {
          assignment.freeMembershipId =
            `TEST-${assignmentId}`;
        } else {
          assignment.rentedMembershipId =
            `TEST-${assignmentId}`;
        }

        assignments.push(
          assignment
        );
      }

      assignment.customerProfile =
        customerProfile;

      assignment.customerSecrets =
        encryptJson(
          customerSecrets
        );

      assignment.activationStatus =
        activationStatus;

      assignment.activationRequestedAt =
        activationStatus ===
          "awaiting_activation"
          ? (
              assignment.activationRequestedAt ||
              now
            )
          : null;

      assignment.expiresAt =
        clean(
          req.body?.expiresAt,
          100
        ) ||
        assignment.expiresAt ||
        null;

      assignment.durationType =
        clean(
          req.body?.durationType,
          30
        ) ||
        assignment.durationType ||
        null;

      assignment.updatedAt =
        now;

      if (
        type === "free"
      ) {
        await saveFreeAssignments(
          assignments
        );
      } else {
        await saveRentalAssignments(
          assignments
        );
      }

      if (
        activationStatus ===
        "awaiting_activation"
      ) {
        const discordChanged =
          await ensureManagedProfileDiscordMessage(
            assignment,
            type
          );

        if (discordChanged) {
          if (
            type === "free"
          ) {
            await saveFreeAssignments(
              assignments
            );
          } else {
            await saveRentalAssignments(
              assignments
            );
          }
        }
      }

      return res.json({
        ok: true,
        activationStatus,
        activationLabel:
          profileActivationLabel(
            activationStatus
          )
      });

    } catch (error) {
      console.error(
        "Admin test managed workflow save error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to save test managed profile workflow."
        });
    }
  }
);


app.get(
  "/api/admin/test-profile-workflow",
  requireAdmin,
  async (req, res) => {
    try {
      const records =
        await getRetailerProfiles();

      const profiles =
        records
          .filter(
            record =>
              String(
                record.customerAccountId ||
                ""
              ) ===
              "ADMIN-PREVIEW"
          )
          .sort(
            (a, b) =>
              Number(a.slot) -
              Number(b.slot)
          )
          .map(
            record =>
              safeRetailerProfile(
                record,
                50
              )
          );

      return res.json({
        ok: true,
        profiles
      });

    } catch (error) {
      console.error(
        "Admin Test Customer profile load error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to load Admin Test Customer profiles."
        });
    }
  }
);


app.put(
  "/api/admin/test-profile-workflow",
  requireAdmin,
  async (req, res) => {
    try {
      const slot =
        Number(
          req.body?.slot
        );

      if (
        !Number.isInteger(slot) ||
        slot < 1 ||
        slot > 100
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid test profile slot."
          });
      }

      const profileName =
        clean(
          req.body?.profileName,
          80
        ) ||
        `Profile ${slot}`;

      const submittedProfile =
        req.body?.customerProfile &&
        typeof req.body.customerProfile ===
          "object"
          ? req.body.customerProfile
          : {};

      const customerProfile =
        sanitizeProfile({
          ...submittedProfile,
          profileName,
          email:
            submittedProfile.email ||
            "admin-preview@slabsngrabsaco.com"
        });

      const submittedCard =
        req.body?.customerCard &&
        typeof req.body.customerCard ===
          "object"
          ? req.body.customerCard
          : {};

      const customerSecrets = {
        cardLabel:
          clean(
            submittedCard.cardLabel,
            100
          ),

        cardholder:
          clean(
            submittedCard.cardholder,
            150
          ),

        acoCardNumber:
          clean(
            submittedCard.acoCardNumber,
            30
          ).replace(
            /[^\d]/g,
            ""
          ),

        expMonth:
          clean(
            submittedCard.expMonth,
            2
          ),

        expYear:
          clean(
            submittedCard.expYear,
            4
          ),

        securityCode:
          clean(
            submittedCard.securityCode,
            300
          )
      };

      const readiness =
        managedProfileReadiness(
          customerProfile,
          customerSecrets
        );

      const records =
        await getRetailerProfiles();

      const existingIndex =
        records.findIndex(
          record =>
            String(
              record.customerAccountId ||
              ""
            ) ===
              "ADMIN-PREVIEW" &&
            Number(
              record.slot
            ) ===
              slot
        );

      const existingRecord =
        existingIndex >= 0
          ? records[
              existingIndex
            ]
          : null;

      const priorStatus =
        String(
          existingRecord?.activationStatus ||
          ""
        )
          .trim()
          .toLowerCase();

      const activationStatus =
        readiness.ready
          ? (
              priorStatus ===
                "activated"
                ? "activated"
                : "awaiting_activation"
            )
          : "incomplete";

      const submittedRetailers =
        req.body?.retailers &&
        typeof req.body.retailers ===
          "object"
          ? req.body.retailers
          : {};

      const credentials =
        emptyRetailerCredentials();

      for (
        const retailer of
        RETAILER_KEYS
      ) {
        credentials[
          retailer
        ] = {
          username:
            clean(
              submittedRetailers?.[
                retailer
              ]?.username,
              254
            ),

          password:
            String(
              submittedRetailers?.[
                retailer
              ]?.password ||
              ""
            )
        };
      }

      updatedCredentials.pkc = {
        ...(
          updatedCredentials.pkc ||
          {}
        ),
        password: ""
      };

      const now =
        new Date()
          .toISOString();

      const record = {
        id:
          existingRecord?.id ||
          crypto.randomUUID(),

        customerAccountId:
          "ADMIN-PREVIEW",

        slot,

        profileName,

        credentials:
          encryptJson(
            credentials
          ),

        customerProfile,

        customerSecrets:
          encryptJson(
            customerSecrets
          ),

        activationStatus,

        activationRequestedAt:
          activationStatus ===
            "awaiting_activation"
            ? (
                existingRecord
                  ?.activationRequestedAt ||
                now
              )
            : null,

        activatedAt:
          activationStatus ===
            "activated"
            ? (
                existingRecord
                  ?.activatedAt ||
                now
              )
            : null,

        deactivatedAt:
          null,

        discordProfileMessageId:
          activationStatus ===
            "awaiting_activation"
            ? (
                existingRecord
                  ?.discordProfileMessageId ||
                null
              )
            : null,

        discordProfileMessageType:
          activationStatus ===
            "awaiting_activation"
            ? (
                existingRecord
                  ?.discordProfileMessageType ||
                null
              )
            : null,

        createdAt:
          existingRecord?.createdAt ||
          now,

        updatedAt:
          now
      };

      if (
        existingIndex >= 0
      ) {
        records[
          existingIndex
        ] = record;
      } else {
        records.push(
          record
        );
      }

      await saveRetailerProfiles(
        records
      );

      if (
        record.activationStatus ===
        "awaiting_activation"
      ) {
        const discordChanged =
          await ensurePaidProfileDiscordAwaitingMessage(
            record
          );

        if (discordChanged) {
          const savedIndex =
            existingIndex >= 0
              ? existingIndex
              : records.length - 1;

          records[
            savedIndex
          ] = record;

          await saveRetailerProfiles(
            records
          );
        }
      }

      return res.json({
        ok: true,
        profile:
          safeRetailerProfile(
            record,
            50
          )
      });

    } catch (error) {
      console.error(
        "Admin Test Customer profile save error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to save Admin Test Customer profile."
        });
    }
  }
);


/* -------------------------------------------------------
   ADMIN PROFILE ACTIVATION TRACKER
------------------------------------------------------- */

app.get(
  "/api/admin/profile-activation-tracker",
  requireAdmin,
  async (req, res) => {
    try {
      const [
        paidProfiles,
        freeAssignments,
        rentalAssignments,
        accounts
      ] = await Promise.all([
        getRetailerProfiles(),
        getFreeAssignments(),
        getRentalAssignments(),
        getCustomerAccounts()
      ]);

      const groups =
        new Map();

      const addProfile = (
        {
          id,
          customerAccountId,
          customerProfile,
          profileName,
          slot = null,
          type,
          status,
          expiresAt = null
        }
      ) => {
        if (
          !status ||
          status ===
            "incomplete"
        ) {
          return;
        }

        const account =
          accounts.find(
            item =>
              String(
                item.id
              ) ===
              String(
                customerAccountId ||
                ""
              )
          ) || null;

        const customerName =
          [
            customerProfile
              ?.firstName,
            customerProfile
              ?.lastName
          ]
            .filter(Boolean)
            .join(" ") ||
          customerProfile
            ?.profileName ||
          account?.email ||
          "Customer";

        const customerEmail =
          account?.email ||
          customerProfile?.email ||
          "";

        const key =
          String(
            customerAccountId ||
            customerEmail ||
            "unlinked"
          );

        if (!groups.has(key)) {
          groups.set(
            key,
            {
              customerName,
              customerEmail,
              profiles: []
            }
          );
        }

        groups
          .get(key)
          .profiles
          .push({
            id,
            profileName,
            slot,
            type,
            status,
            label:
              profileActivationLabel(
                status
              ),
            expiresAt
          });
      };

      let paidProfilesChanged =
        false;

      for (
        const record of paidProfiles
      ) {
        let secrets = {};

        try {
          if (record.customerSecrets) {
            secrets =
              decryptJson(
                record.customerSecrets
              ) || {};
          }
        } catch {
          secrets = {};
        }

        const readiness =
          managedProfileReadiness(
            record.customerProfile,
            secrets
          );

        const storedStatus =
          String(
            record.activationStatus ||
            ""
          )
            .trim()
            .toLowerCase();

        const status =
          [
            "awaiting_activation",
            "activated",
            "deactivated",
            "expired"
          ].includes(
            storedStatus
          )
            ? storedStatus
            : normalizeProfileActivationStatus(
                record.activationStatus,
                readiness.ready
              );

        if (
          status ===
            "awaiting_activation" &&
          !record.discordProfileMessageId
        ) {
          const discordChanged =
            await ensurePaidProfileDiscordAwaitingMessage(
              record
            );

          paidProfilesChanged =
            paidProfilesChanged ||
            discordChanged;
        }

        addProfile({
          id:
            record.id,
          customerAccountId:
            record.customerAccountId,
          customerProfile:
            record.customerProfile,
          profileName:
            record.profileName ||
            `Profile ${record.slot}`,
          slot:
            Number(record.slot),
          type:
            "paid",
          status
        });
      }

      if (paidProfilesChanged) {
        await saveRetailerProfiles(
          paidProfiles
        );
      }

      const now =
        Date.now();

      const addManagedAssignments =
        async (
          assignments,
          type
        ) => {
          let changed = false;

          for (
            const assignment of assignments
          ) {
            // Reconcile alerts left by older versions after activation or removal.
            if (assignment.discordProfileMessageId && (
              !managedAssignmentIsLinked(assignment) ||
              ["activated", "deactivated", "returned_to_pool"].includes(assignment.activationStatus)
            )) {
              assignment.pendingDiscordProfileMessageId = assignment.discordProfileMessageId;
              delete assignment.discordProfileMessageId;
              delete assignment.discordProfileMessageType;
              changed = true;
            }
            if (assignment.pendingDiscordProfileMessageId) changed = true;
            if (
              !managedAssignmentIsLinked(
                assignment
              )
            ) {
              continue;
            }

            if (
              assignment.expiresAt
            ) {
              const end =
                new Date(
                  assignment.expiresAt
                ).getTime();

              if (
                Number.isFinite(end) &&
                end <= now &&
                assignment.activationStatus !==
                  "expired"
              ) {
                const expiredAt =
                  new Date()
                    .toISOString();

                clearManagedAssignmentCustomerData(
                  assignment,
                  {
                    reason:
                      "expired",
                    nowIso:
                      expiredAt
                  }
                );

                changed =
                  true;
              }
            }

            if (
              assignment.activationStatus ===
                "expired" &&
              !assignment.discordProfileMessageId
            ) {
              const discordChanged =
                await ensureManagedProfileDiscordMessage(
                  assignment,
                  type
                );

              changed =
                changed ||
                discordChanged;
            }

            const storedStatus =
              String(
                assignment.activationStatus ||
                ""
              )
                .trim()
                .toLowerCase();

            const status =
              storedStatus ===
                "expired"
                ? "expired"
                : managedAssignmentStatus(
                    assignment
                  );

            addProfile({
              id:
                assignment.id,
              customerAccountId:
                assignment.customerAccountId,
              customerProfile:
                assignment.customerProfile,
              profileName:
                type === "free"
                  ? "Gifted Profile"
                  : "Rented Profile",
              type:
                type === "free"
                  ? "gifted"
                  : "rented",
              status,
              expiresAt:
                assignment.expiresAt ||
                null
            });
          }

          if (changed) {
            if (type === "free") {
              await saveFreeAssignments(
                assignments
              );
            } else {
              await saveRentalAssignments(
                assignments
              );
            }
          }
        };

      await addManagedAssignments(
        freeAssignments,
        "free"
      );

      await addManagedAssignments(
        rentalAssignments,
        "rented"
      );

      const customers =
        Array.from(
          groups.values()
        ).map(group => ({
          ...group,
          profiles:
            group.profiles.sort(
              (a,b) => {
                const order = {
                  paid: 1,
                  gifted: 2,
                  rented: 3
                };

                return (
                  (order[a.type] || 9) -
                  (order[b.type] || 9)
                );
              }
            )
        }));

      const allProfiles =
        customers.flatMap(
          group =>
            group.profiles
        );

      return res.json({
        ok: true,

        profileWebhookConfigured:
          Boolean(
            adminProfileWebhookUrl()
          ),

        awaitingCount:
          allProfiles.filter(
            profile =>
              profile.status ===
              "awaiting_activation"
          ).length,

        activatedCount:
          allProfiles.filter(
            profile =>
              profile.status ===
              "activated"
          ).length,

        expiredCount:
          allProfiles.filter(
            profile =>
              profile.status ===
              "expired"
          ).length,

        customers
      });

    } catch (error) {
      console.error(
        "Admin profile activation tracker error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to load profile activation tracker."
        });
    }
  }
);



app.post(
  "/api/admin/managed-profile-activation/:type/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const type =
        clean(
          req.params.type,
          20
        );

      const id =
        clean(
          req.params.id,
          150
        );

      const action =
        clean(
          req.body?.action,
          30
        )
          .trim()
          .toLowerCase();

      if (
        ![
          "free",
          "rented"
        ].includes(type)
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid profile type."
          });
      }

      if (
        ![
          "activate",
          "activating",
          "deactivate",
          "inactive"
        ].includes(action)
      ) {
        return res
          .status(400)
          .json({
            error:
              "Choose activate, activating, or inactive."
          });
      }

      const assignments =
        type === "free"
          ? await getFreeAssignments()
          : await getRentalAssignments();

      const assignment =
        assignments.find(
          item =>
            String(
              item.id
            ) ===
            String(id)
        );

      if (!assignment) {
        return res
          .status(404)
          .json({
            error:
              "Profile assignment could not be found."
          });
      }

      if (
        [
          "activate",
          "activating"
        ].includes(
          action
        )
      ) {
        const managedAccounts =
          await getManagedAccounts();

        const [
          freeAssignmentsForDuplicateCheck,
          rentalAssignmentsForDuplicateCheck
        ] = await Promise.all([
          getFreeAssignments(),
          getRentalAssignments()
        ]);

        const linkedIds =
          new Set(
            [
              ...freeAssignmentsForDuplicateCheck,
              ...rentalAssignmentsForDuplicateCheck
            ]
              .filter(
                item =>
                  managedAssignmentIsLinked(
                    item
                  )
              )
              .map(
                item =>
                  String(
                    managedAssignmentMembershipId(
                      item
                    ) ||
                    ""
                  )
              )
              .filter(Boolean)
          );

        const duplicateState =
          managedDuplicateCredentialState(
            managedAccounts,
            linkedIds
          );

        const managedAccountId =
          String(
            managedAssignmentMembershipId(
              assignment
            ) ||
            ""
          );

        if (
          duplicateState
            .duplicateIds
            .has(
              managedAccountId
            )
        ) {
          return res
            .status(409)
            .json({
              error:
                "This managed profile duplicates the exact retailer username/password of another managed profile. Return or correct the duplicate before activation."
            });
        }
      }

      let secrets = {};

      try {
        if (
          assignment.customerSecrets
        ) {
          secrets =
            decryptJson(
              assignment.customerSecrets
            ) || {};
        }
      } catch {
        secrets = {};
      }

      const readiness =
        managedProfileReadiness(
          assignment.customerProfile,
          secrets
        );

      /*
        Admin is allowed to activate Gifted/Rented managed profiles
        even when shipping or card information is incomplete.

        Readiness remains informational only so Admin still sees
        INFO COMPLETE / INFO MISSING while activation controls remain
        independent from data completeness.
      */
      const activatedWithMissingInfo =
        action === "activate" &&
        !readiness.ready;

      const discordMessageId =
        assignment.discordProfileMessageId ||
        null;

      const nowDate =
        new Date();

      const now =
        nowDate.toISOString();

      if (
        action ===
          "activate"
      ) {
        activateManagedAssignmentTimer(
          assignment,
          nowDate
        );

      } else if (
        action ===
          "activating"
      ) {
        assignment.active =
          true;

        assignment.activationStatus =
          "awaiting_activation";

        assignment.activationRequestedAt =
          now;

        assignment.startsAt =
          null;

        assignment.expiresAt =
          null;

        assignment.activatedAt =
          null;

        assignment.deactivatedAt =
          null;

        assignment.endedAt =
          null;

        assignment.endReason =
          null;

        assignment.updatedAt =
          now;

      } else {
        assignment.active =
          false;

        assignment.activationStatus =
          "deactivated";

        assignment.deactivatedAt =
          now;

        assignment.endedAt =
          assignment.endedAt ||
          now;

        assignment.endReason =
          assignment.endReason ||
          "admin_deactivated";

        assignment.updatedAt =
          now;
      }

      if (
        action !==
          "activating"
      ) {
        if (discordMessageId) assignment.pendingDiscordProfileMessageId = discordMessageId;
        assignment.discordProfileMessageId =
          null;

        assignment.discordProfileMessageType =
          null;
      }

      if (type === "free") {
        await saveFreeAssignments(
          assignments
        );
      } else {
        await saveRentalAssignments(
          assignments
        );
      }

      if (
        action ===
          "activating"
      ) {
        try {
          const discordChanged =
            await ensureManagedProfileDiscordMessage(
              assignment,
              type
            );

          if (discordChanged) {
            if (type === "free") {
              await saveFreeAssignments(
                assignments
              );
            } else {
              await saveRentalAssignments(
                assignments
              );
            }
          }
        } catch (error) {
          console.error(
            "Managed activating Discord notification failed:",
            error.message
          );
        }
      }

      if (
        type === "rented"
      ) {
        try {
          const paymentCleared =
            await maybeClearRentalPurchaseDiscord(
              assignments,
              assignment
            );

          if (paymentCleared) {
            await saveRentalAssignments(
              assignments
            );
          }
        } catch (error) {
          console.error(
            "Rental purchase completion cleanup failed:",
            error.message
          );
        }
      }

      return res.json({
        ok: true,
        status:
          assignment.activationStatus,
        startsAt:
          assignment.startsAt ||
          null,
        expiresAt:
          assignment.expiresAt ||
          null,

        infoComplete:
          readiness.ready,

        activatedWithMissingInfo
      });

    } catch (error) {
      console.error(
        "Managed profile activation update error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to update profile activation."
        });
    }
  }
);


app.post(
  "/api/admin/profile-activation/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        clean(
          req.params.id,
          150
        );

      const action =
        clean(
          req.body?.action,
          30
        )
          .trim()
          .toLowerCase();

      if (
        ![
          "activate",
          "deactivate"
        ].includes(action)
      ) {
        return res
          .status(400)
          .json({
            error:
              "Choose activate or deactivate."
          });
      }

      const records =
        await getRetailerProfiles();

      const record =
        records.find(
          item =>
            String(
              item.id
            ) ===
            String(id)
        );

      if (!record) {
        return res
          .status(404)
          .json({
            error:
              "Paid profile could not be found."
          });
      }

      let secrets = {};

      try {
        if (
          record.customerSecrets
        ) {
          secrets =
            decryptJson(
              record.customerSecrets
            ) || {};
        }
      } catch {
        secrets = {};
      }

      const readiness =
        managedProfileReadiness(
          record.customerProfile,
          secrets
        );

      if (
        action ===
          "activate" &&
        !readiness.ready
      ) {
        return res
          .status(400)
          .json({
            error:
              "This profile still has missing shipping or card information."
          });
      }

      const now =
        new Date()
          .toISOString();

      const discordMessageId =
        record.discordProfileMessageId ||
        null;

      if (
        action ===
        "activate"
      ) {
        record.activationStatus =
          "activated";

        record.activatedAt =
          now;

        record.deactivatedAt =
          null;
      } else {
        record.activationStatus =
          "deactivated";

        record.deactivatedAt =
          now;
      }

      record.updatedAt =
        now;

      record.discordProfileMessageId =
        null;

      record.discordProfileMessageType =
        null;

      await saveRetailerProfiles(
        records
      );

      if (discordMessageId) {
        try {
          await deleteDiscordAdminProfileWorkflowNotification(
            discordMessageId
          );
        } catch (error) {
          console.error(
            "Paid profile Discord message delete failed:",
            error.message
          );
        }
      }

      if (
        action ===
        "activate"
      ) {
        try {
          await maybeClearPaidPurchaseDiscord(
            record.customerAccountId
          );
        } catch (error) {
          console.error(
            "Paid purchase completion cleanup failed:",
            error.message
          );
        }
      }

      return res.json({
        ok: true,
        status:
          record.activationStatus
      });

    } catch (error) {
      console.error(
        "Admin profile activation update error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to update profile activation."
        });
    }
  }
);


/* -------------------------------------------------------
   ADMIN SPECIAL PROFILES
------------------------------------------------------- */

app.put(
  "/api/admin/submissions/:id/special-profiles/:profileType",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        clean(
          req.params.id,
          150
        );

      const profileType =
        normalizeSpecialProfileType(
          req.params.profileType
        );

      if (!profileType) {
        return res
          .status(400)
          .json({
            error:
              "Invalid special profile type."
          });
      }

      const durationType =
        normalizeSpecialProfileDuration(
          req.body?.durationType
        );

      if (!durationType) {
        return res
          .status(400)
          .json({
            error:
              "Choose a valid profile duration."
          });
      }

      const active =
        req.body?.active !== false;

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const paidRecords =
        Array.isArray(paid)
          ? paid
          : [];

const order =
  paidRecords.find(
    item =>
      String(
        item.id
      ) === id
  );

let customerAccountId =
  order?.customerAccountId ||
  null;

if (!customerAccountId) {
  const accounts =
    await getCustomerAccounts();

  const account =
    accounts.find(
      item =>
        String(
          item.id
        ) === id
    );

  if (account) {
    customerAccountId =
      account.id;
  }
}

if (!customerAccountId) {
  return res
    .status(404)
    .json({
      error:
        "Customer account could not be found."
    });
}


      const submitted =
        req.body?.retailers &&
        typeof req.body.retailers ===
          "object"
          ? req.body.retailers
          : {};

      const records =
        await getSpecialProfiles();

      const existingIndex =
        records.findIndex(
          record =>
            record.customerAccountId ===
              customerAccountId &&
            normalizeSpecialProfileType(
              record.profileType
            ) === profileType
        );

      const existingRecord =
        existingIndex >= 0
          ? records[
              existingIndex
            ]
          : null;

      let existingCredentials =
        emptyRetailerCredentials();

      if (
        existingRecord
          ?.credentials
      ) {
        existingCredentials =
          normalizeRetailerCredentials(
            decryptJson(
              existingRecord
                .credentials
            )
          );
      }

      const updatedCredentials =
        emptyRetailerCredentials();

      for (
        const retailer of
        RETAILER_KEYS
      ) {
        const submittedRetailer =
          submitted[retailer] &&
          typeof submitted[
            retailer
          ] === "object"
            ? submitted[
                retailer
              ]
            : {};

        const username =
          clean(
            submittedRetailer
              .username,
            254
          );

        const password =
          String(
            submittedRetailer
              .password || ""
          );

        if (
          password.length > 512
        ) {
          return res
            .status(400)
            .json({
              error:
                "A retailer password is too long."
            });
        }

        updatedCredentials[
          retailer
        ] = {
          username,

          password:
            password ||
            existingCredentials[
              retailer
            ].password ||
            ""
        };
      }

      updatedCredentials.pkc = {
        ...(
          updatedCredentials.pkc ||
          {}
        ),
        password: ""
      };

    const now =
  new Date();

const existingDuration =
  normalizeSpecialProfileDuration(
    existingRecord
      ?.durationType
  );

const wasActive =
  existingRecord
    ? specialProfileIsActive(
        existingRecord
      )
    : false;

const restartTimer =
  active &&
  (
    !existingRecord ||
    !wasActive ||
    existingDuration !==
      durationType
  );

const startsAt =
  active
    ? (
        restartTimer
          ? now.toISOString()
          : (
              existingRecord
                ?.startsAt ||
              now.toISOString()
            )
      )
    : (
        existingRecord
          ?.startsAt ||
        null
      );

const expiresAt =
  active
    ? (
        restartTimer
          ? specialProfileExpiresAt(
              durationType,
              now
            )
          : (
              existingRecord
                ?.expiresAt ??
              specialProfileExpiresAt(
                durationType,
                existingRecord
                  ?.startsAt ||
                now
              )
            )
      )
    : (
        existingRecord
          ?.expiresAt ||
        null
      );

      const record = {
        id:
          existingRecord?.id ||
          crypto.randomUUID(),

        customerAccountId:
          customerAccountId,

        profileType,

        profileName:
          specialProfileLabel(
            profileType
          ),

        active,

        durationType,

        startsAt,

        expiresAt,

        credentials:
          encryptJson(
            updatedCredentials
          ),

        createdAt:
          existingRecord
            ?.createdAt ||
          now.toISOString(),

        updatedAt:
          now.toISOString(),

        adminUpdatedAt:
          now.toISOString()
      };

      if (
        existingIndex >= 0
      ) {
        records[
          existingIndex
        ] = record;

      } else {
        records.push(
          record
        );
      }

      await saveSpecialProfiles(
        records
      );

      return res.json({
        ok: true,

        message:
          `${specialProfileLabel(
            profileType
          )} updated successfully.`,

        profile:
          adminSpecialProfile(
            record
          )
      });

    } catch (error) {
      console.error(
        "Admin special profile update error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to update the special profile."
        });
    }
  }
);


app.put(
  "/api/admin/submissions/:id/retailer-profiles/:slot",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        clean(
          req.params.id,
          150
        );

      const slot =
        Number(
          req.params.slot
        );

      if (
        !Number.isInteger(slot) ||
        slot < 1 ||
        slot > 100
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid retailer profile slot."
          });
      }

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const paidRecords =
        Array.isArray(paid)
          ? paid
          : [];

      const order =
        paidRecords.find(
          item =>
            String(
              item.id
            ) === id
        );

      if (
        !order ||
        !order.customerAccountId
      ) {
        return res
          .status(404)
          .json({
            error:
              "Linked customer account could not be found."
          });
      }

      const allowance =
        await getCustomerProfileAllowance(
          order.customerAccountId
        );

      if (
        slot > allowance
      ) {
        return res
          .status(403)
          .json({
            error:
              `This membership currently allows ${allowance} profile${allowance === 1 ? "" : "s"}.`
          });
      }

      const profileName =
        clean(
          req.body?.profileName,
          80
        );

      if (!profileName) {
        return res
          .status(400)
          .json({
            error:
              "Enter a retailer profile name."
          });
      }

      const submitted =
        req.body?.retailers &&
        typeof req.body.retailers ===
          "object"
          ? req.body.retailers
          : {};

      const records =
        await getRetailerProfiles();

      const existingIndex =
        records.findIndex(
          record =>
            record.customerAccountId ===
              order.customerAccountId &&
            Number(record.slot) ===
              slot
        );

      const existingRecord =
        existingIndex >= 0
          ? records[
              existingIndex
            ]
          : null;

      let existingCredentials =
        emptyRetailerCredentials();

      if (
        existingRecord
          ?.credentials
      ) {
        existingCredentials =
          normalizeRetailerCredentials(
            decryptJson(
              existingRecord
                .credentials
            )
          );
      }

      const updatedCredentials =
        emptyRetailerCredentials();

      for (
        const retailer of
        RETAILER_KEYS
      ) {
        const submittedRetailer =
          submitted[retailer] &&
          typeof submitted[
            retailer
          ] === "object"
            ? submitted[
                retailer
              ]
            : {};

        const username =
          clean(
            submittedRetailer
              .username,
            254
          );

        const password =
          String(
            submittedRetailer
              .password || ""
          );

        if (
          password.length >
          512
        ) {
          return res
            .status(400)
            .json({
              error:
                "A retailer password is too long."
            });
        }

        updatedCredentials[
          retailer
        ] = {
          username,

          password:
            password ||
            existingCredentials[
              retailer
            ].password ||
            ""
        };
      }

      let existingCustomerSecrets = {};

      try {
        if (
          existingRecord
            ?.customerSecrets
        ) {
          existingCustomerSecrets =
            decryptJson(
              existingRecord.customerSecrets
            ) || {};
        }
      } catch {
        existingCustomerSecrets = {};
      }

      const submittedCustomerProfile =
        req.body?.customerProfile &&
        typeof req.body.customerProfile ===
          "object"
          ? req.body.customerProfile
          : null;

      const submittedCustomerCard =
        req.body?.customerCard &&
        typeof req.body.customerCard ===
          "object"
          ? req.body.customerCard
          : null;

      const customerProfile =
        submittedCustomerProfile
          ? sanitizeProfile({
              ...(
                existingRecord?.customerProfile ||
                {}
              ),
              ...submittedCustomerProfile,

              profileName:
                profileName,

              email:
                submittedCustomerProfile.email ||
                existingRecord?.customerProfile?.email ||
                ""
            })
          : (
              existingRecord?.customerProfile ||
              null
            );

      const customerSecrets = {
        ...existingCustomerSecrets
      };

      if (submittedCustomerCard) {
        if (
          Object.prototype.hasOwnProperty.call(
            submittedCustomerCard,
            "cardLabel"
          )
        ) {
          customerSecrets.cardLabel =
            clean(
              submittedCustomerCard.cardLabel,
              100
            );
        }

        if (
          Object.prototype.hasOwnProperty.call(
            submittedCustomerCard,
            "cardholder"
          )
        ) {
          customerSecrets.cardholder =
            clean(
              submittedCustomerCard.cardholder,
              150
            );
        }

        const submittedNumber =
          clean(
            submittedCustomerCard.acoCardNumber,
            30
          ).replace(
            /[^\d]/g,
            ""
          );

        if (submittedNumber) {
          customerSecrets.acoCardNumber =
            submittedNumber;
        }

        if (
          Object.prototype.hasOwnProperty.call(
            submittedCustomerCard,
            "expMonth"
          )
        ) {
          customerSecrets.expMonth =
            clean(
              submittedCustomerCard.expMonth,
              2
            );
        }

        if (
          Object.prototype.hasOwnProperty.call(
            submittedCustomerCard,
            "expYear"
          )
        ) {
          customerSecrets.expYear =
            clean(
              submittedCustomerCard.expYear,
              4
            );
        }

        if (
          Object.prototype.hasOwnProperty.call(
            submittedCustomerCard,
            "securityCode"
          )
        ) {
          customerSecrets.securityCode =
            clean(
              submittedCustomerCard.securityCode,
              300
            );
        }
      }

      updatedCredentials.pkc = {
        ...(
          updatedCredentials.pkc ||
          {}
        ),
        password: ""
      };

      const now =
        new Date()
          .toISOString();

      const record = {
        ...(
          existingRecord ||
          {}
        ),

        id:
          existingRecord?.id ||
          crypto.randomUUID(),

        customerAccountId:
          order.customerAccountId,

        slot,

        profileName,

        credentials:
          encryptJson(
            updatedCredentials
          ),

        customerProfile,

        customerSecrets:
          encryptJson(
            customerSecrets
          ),

        createdAt:
          existingRecord
            ?.createdAt ||
          now,

        updatedAt:
          now,

        adminUpdatedAt:
          now
      };

      if (
        existingIndex >= 0
      ) {
        records[
          existingIndex
        ] = record;

      } else {
        records.push(
          record
        );
      }

      await saveRetailerProfiles(
        records
      );

      if (
        order.customerAccountId
      ) {
        await syncCustomerMissingNotification(
          order.customerAccountId
        );
      }

      return res.json({
        ok: true,
        message:
          "Retailer profile updated successfully."
      });

    } catch (error) {
      console.error(
        "Admin retailer profile update error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to update the retailer profile."
        });
    }
  }
);

app.delete(
  "/api/admin/submissions/:id/special-profiles/:profileType",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        clean(
          req.params.id,
          150
        );

      const profileType =
        normalizeSpecialProfileType(
          req.params.profileType
        );

      if (!profileType) {
        return res
          .status(400)
          .json({
            error:
              "Invalid special profile type."
          });
      }

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const paidRecords =
        Array.isArray(paid)
          ? paid
          : [];

      const order =
        paidRecords.find(
          item =>
            String(
              item.id
            ) === id
        );

      let customerAccountId =
        order?.customerAccountId ||
        null;

      if (!customerAccountId) {
        const accounts =
          await getCustomerAccounts();

        const account =
          accounts.find(
            item =>
              String(
                item.id
              ) === id
          );

        if (account) {
          customerAccountId =
            account.id;
        }
      }

      if (!customerAccountId) {
        return res
          .status(404)
          .json({
            error:
              "Customer account could not be found."
          });
      }

      const records =
        await getSpecialProfiles();

      const existingIndex =
        records.findIndex(
          record =>
            record.customerAccountId ===
              customerAccountId &&
            normalizeSpecialProfileType(
              record.profileType
            ) === profileType
        );

      if (existingIndex < 0) {
        return res
          .status(404)
          .json({
            error:
              "Special profile could not be found."
          });
      }

      records.splice(
        existingIndex,
        1
      );

      await saveSpecialProfiles(
        records
      );

      return res.json({
        ok: true,

        message:
          `${specialProfileLabel(
            profileType
          )} removed successfully.`
      });

    } catch (error) {
      console.error(
        "Admin special profile remove error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to remove the special profile."
        });
    }
  }
);

/* -------------------------------------------------------
   ADMIN SUBMISSIONS
------------------------------------------------------- */
app.put(
  "/api/admin/submissions/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        clean(
          req.params.id,
          150
        );

      if (!id) {
        return res
          .status(400)
          .json({
            error:
              "Submission ID is required."
          });
      }

      const profileBody =
        req.body?.profile &&
        typeof req.body.profile ===
          "object"
          ? req.body.profile
          : {};

      const secretsBody =
        req.body?.secrets &&
        typeof req.body.secrets ===
          "object"
          ? req.body.secrets
          : {};

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const paidRecords =
        Array.isArray(paid)
          ? paid
          : [];

      const paidIndex =
        paidRecords.findIndex(
          item =>
            String(
              item.id
            ) === id
        );

      /*
        PAID SUBMISSION
      */

      if (paidIndex >= 0) {
        const record =
          paidRecords[
            paidIndex
          ];

        const existingSecrets =
          (
            await loadEncryptedPackage(
              id
            )
          ) || {};

        const existingProfile =
          record.profile &&
          typeof record.profile ===
            "object"
            ? record.profile
            : {};

        const nextProfile =
          sanitizeProfile({
            ...existingProfile,
            ...profileBody
          });

        const submittedSecrets =
          sanitizeSecrets(
            secretsBody
          );

        const nextSecrets = {
          ...existingSecrets
        };

        if (
          Object.prototype
            .hasOwnProperty.call(
              secretsBody,
              "acoEmail"
            )
        ) {
          nextSecrets.acoEmail =
            submittedSecrets.acoEmail;
        }

        if (
          submittedSecrets
            .acoPassword
        ) {
          nextSecrets.acoPassword =
            submittedSecrets
              .acoPassword;
        }

        if (
          Object.prototype
            .hasOwnProperty.call(
              secretsBody,
              "cardLabel"
            )
        ) {
          nextSecrets.cardLabel =
            submittedSecrets.cardLabel;
        }

        if (
          Object.prototype
            .hasOwnProperty.call(
              secretsBody,
              "cardholder"
            )
        ) {
          nextSecrets.cardholder =
            submittedSecrets.cardholder;
        }

        if (
          submittedSecrets
            .acoCardNumber
        ) {
          nextSecrets.acoCardNumber =
            submittedSecrets
              .acoCardNumber;
        }

        if (
          submittedSecrets
            .expMonth
        ) {
          nextSecrets.expMonth =
            submittedSecrets
              .expMonth;
        }

        if (
          submittedSecrets
            .expYear
        ) {
          nextSecrets.expYear =
            submittedSecrets
              .expYear;
        }

        if (
          submittedSecrets
            .securityCode
        ) {
          nextSecrets.securityCode =
            submittedSecrets
              .securityCode;
        }

        record.profile =
          nextProfile;

        record.adminUpdatedAt =
          new Date()
            .toISOString();

        paidRecords[
          paidIndex
        ] = record;

        await writeJson(
          PAID_FILE,
          paidRecords
        );

        if (secretsBody.acoEmail || secretsBody.acoPassword) {
          nextSecrets.imapUpdatedAt = new Date().toISOString();
          nextSecrets.imapConnectionStatus = await testSubmittedImap(nextSecrets.acoEmail, nextSecrets.acoPassword);
          await synchronizeStoredImapCopies(record.customerAccountId, existingSecrets.acoEmail,
            nextSecrets.acoEmail, nextSecrets.acoPassword, nextSecrets.imapUpdatedAt, nextSecrets.imapConnectionStatus);
        }
        await saveEncryptedPackage(
          id,
          nextSecrets
        );

        return res.json({
          ok: true,
        imapConnectionStatus: nextSecrets.imapConnectionStatus || null,

          message:
            "Customer information updated."
        });
      }

      /*
        FREE CUSTOMER ACCOUNT
      */

      const accounts =
        await getCustomerAccounts();

      const accountIndex =
        accounts.findIndex(
          account =>
            String(
              account.id
            ) === id
        );

      if (accountIndex < 0) {
        return res
          .status(404)
          .json({
            error:
              "Customer account could not be found."
          });
      }

      const account =
        accounts[
          accountIndex
        ];

      let existingSecrets = {};

      if (account.adminSecrets) {
        try {
          existingSecrets =
            decryptJson(
              account.adminSecrets
            ) || {};
        } catch (error) {
          console.error(
            "Free account secure data decrypt error:",
            account.id,
            error.message
          );
        }
      }

      const submittedSecrets =
        sanitizeSecrets(
          secretsBody
        );

      const nextSecrets = {
        ...existingSecrets
      };

      if (
        Object.prototype
          .hasOwnProperty.call(
            secretsBody,
            "acoEmail"
          )
      ) {
        nextSecrets.acoEmail =
          submittedSecrets.acoEmail;
      }

      if (
        submittedSecrets
          .acoPassword
      ) {
        nextSecrets.acoPassword =
          submittedSecrets
            .acoPassword;
      }

      if (
        Object.prototype
          .hasOwnProperty.call(
            secretsBody,
            "cardLabel"
          )
      ) {
        nextSecrets.cardLabel =
          submittedSecrets.cardLabel;
      }

      if (
        Object.prototype
          .hasOwnProperty.call(
            secretsBody,
            "cardholder"
          )
      ) {
        nextSecrets.cardholder =
          submittedSecrets.cardholder;
      }

      if (
        submittedSecrets
          .acoCardNumber
      ) {
        nextSecrets.acoCardNumber =
          submittedSecrets
            .acoCardNumber;
      }

      if (
        submittedSecrets
          .expMonth
      ) {
        nextSecrets.expMonth =
          submittedSecrets
            .expMonth;
      }

      if (
        submittedSecrets
          .expYear
      ) {
        nextSecrets.expYear =
          submittedSecrets
            .expYear;
      }

      if (
        submittedSecrets
          .securityCode
      ) {
        nextSecrets.securityCode =
          submittedSecrets
            .securityCode;
      }

      account.adminProfile =
        sanitizeProfile({
          ...(account.adminProfile ||
            {}),
          ...profileBody
        });

      if (secretsBody.acoEmail || secretsBody.acoPassword) {
        nextSecrets.imapUpdatedAt = new Date().toISOString();
        nextSecrets.imapConnectionStatus = await testSubmittedImap(nextSecrets.acoEmail, nextSecrets.acoPassword);
        await synchronizeImapCopies(account, existingSecrets.acoEmail, nextSecrets.acoEmail,
          nextSecrets.acoPassword, nextSecrets.imapUpdatedAt, nextSecrets.imapConnectionStatus);
      }
      account.adminSecrets =
        encryptJson(
          nextSecrets
        );

      account.adminUpdatedAt =
        new Date()
          .toISOString();

      account.updatedAt =
        account.adminUpdatedAt;

      accounts[
        accountIndex
      ] = account;

      await saveCustomerAccounts(
        accounts
      );

      return res.json({
        ok: true,
        imapConnectionStatus: nextSecrets.imapConnectionStatus || null,

        message:
          "Customer information updated."
      });

    } catch (error) {
      console.error(
        "Admin submission update error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to update customer information."
        });
    }
  }
);


app.delete(
  "/api/admin/submissions/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        clean(
          req.params.id,
          150
        );

      if (!id) {
        return res
          .status(400)
          .json({
            error:
              "Submission ID is required."
          });
      }

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const records =
        Array.isArray(paid)
          ? paid
          : [];

      const record =
        records.find(
          item =>
            String(
              item.id
            ) === id
        );

      if (!record) {
        return res
          .status(404)
          .json({
            error:
              "Submission could not be found."
          });
      }

      const remaining =
        records.filter(
          item =>
            String(
              item.id
            ) !== id
        );

      await writeJson(
        PAID_FILE,
        remaining
      );

      try {
        await fs.unlink(
          path.join(
            SECRET_DIR,
            `${id}.encrypted.json`
          )
        );
      } catch (error) {
        if (
          error?.code !==
          "ENOENT"
        ) {
          throw error;
        }
      }

      return res.json({
        ok: true,
        deletedId: id
      });

    } catch (error) {
      console.error(
        "Admin delete error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to delete this submission."
        });
    }
  }
);


/* -------------------------------------------------------
   CUSTOMER SAVED SHIPPING / PAYMENT METHODS
------------------------------------------------------- */

async function testSubmittedImap(email, password) {
  const checkedAt = new Date().toISOString();
  try { await verifyCustomerImap(email, password); return { connected: true, checkedAt, reason: null }; }
  catch (error) { return { connected: false, checkedAt, reason: mailboxFailureReason(error) }; }
}
async function synchronizeImapCopies(account, previousEmail, email, password, updatedAt = new Date().toISOString(), connectionStatus = null) {
  const orders = await readJson(PAID_FILE, []);
  for (const order of orders) {
    if (String(order.customerAccountId || "") !== String(account.id)) continue;
    const secrets = await loadEncryptedPackage(order.id);
    const next = updateMatchingImap(secrets, previousEmail, email, password, updatedAt, connectionStatus);
    if (next) await saveEncryptedPackage(order.id, next);
  }
  if (account.adminSecrets) {
    const next = updateMatchingImap(decryptJson(account.adminSecrets), previousEmail, email, password, updatedAt, connectionStatus);
    if (next) account.adminSecrets = encryptJson(next);
  }
  const entries = savedImapEntries(account);
  let changed = false;
  for (const entry of entries) {
    if (![normalizeEmail(previousEmail), normalizeEmail(email)].includes(normalizeEmail(entry.email))) continue;
    entry.email = normalizeEmail(email);
    if (password) entry.password = password;
    entry.updatedAt = updatedAt;
    entry.connectionStatus = connectionStatus;
    changed = true;
  }
  if (changed) account.savedImapCredentials = encryptJson(entries);
}
async function synchronizeStoredImapCopies(accountId, previousEmail, email, password, updatedAt, connectionStatus) {
  const accounts = await getCustomerAccounts();
  const account = accounts.find(item => String(item.id) === String(accountId));
  if (!account || !email) return;
  await synchronizeImapCopies(account, previousEmail, email, password, updatedAt, connectionStatus);
  await saveCustomerAccounts(accounts);
  liveSuccessLastSyncByAccount.delete(String(accountId));
}

function savedImapEntries(account) {
  try {
    const entries = account?.savedImapCredentials
      ? decryptJson(account.savedImapCredentials) : [];
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

app.get("/api/account/imap-credentials", requireCustomer, async (req, res) => {
  const entries = savedImapEntries(req.customerAccount);
  res.json({ ok: true, entries: entries.map(({ id, email, createdAt, updatedAt, connectionStatus }) => ({
    id, email, passwordConfigured: true, createdAt, updatedAt, connectionStatus
  })) });
});

app.post("/api/account/imap-credentials", requireCustomer, async (req, res) => {
  try {
    const accounts = await getCustomerAccounts();
    const account = accounts.find(item => item.id === req.customerAccount.id);
    if (!account) return res.status(404).json({ error: "Customer account not found." });
    const entries = savedImapEntries(account);
    if (entries.length >= 100) return res.status(400).json({ error: "You can save up to 100 IMAP logins." });
    const email = clean(req.body?.email, 254).toLowerCase();
    const password = String(req.body?.password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 6 || password.length > 512) {
      return res.status(400).json({ error: "Enter a valid IMAP email and app password (6–512 characters)." });
    }
    if (entries.some(item => item.email === email)) return res.status(409).json({ error: "This IMAP email is already saved. Edit its entry instead." });
    const now = new Date().toISOString();
    const entry = { id: crypto.randomUUID(), email, password, createdAt: now, updatedAt: now };
    entry.connectionStatus = await testSubmittedImap(email, password);
    entries.push(entry);
    account.savedImapCredentials = encryptJson(entries);
    await synchronizeImapCopies(account, email, email, password, now, entry.connectionStatus);
    await saveCustomerAccounts(accounts);
    liveSuccessLastSyncByAccount.delete(String(account.id));
    return res.json({ ok: true, entry: { id: entry.id, email, passwordConfigured: true, connectionStatus: entry.connectionStatus } });
  } catch (error) {
    console.error("Save IMAP credentials error:", error);
    return res.status(500).json({ error: "Unable to save IMAP login." });
  }
});

app.put("/api/account/imap-credentials/:id", requireCustomer, async (req, res) => {
  try {
    const accounts = await getCustomerAccounts();
    const account = accounts.find(item => item.id === req.customerAccount.id);
    if (!account) return res.status(404).json({ error: "Customer account not found." });
    const entries = savedImapEntries(account);
    const entry = entries.find(item => item.id === req.params.id);
    if (!entry) return res.status(404).json({ error: "IMAP login not found." });
    const email = clean(req.body?.email, 254).toLowerCase();
    const password = String(req.body?.password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length > 512 || (password && password.length < 6)) {
      return res.status(400).json({ error: "Enter a valid IMAP email and app password (at least 6 characters)." });
    }
    if (entries.some(item => item.id !== entry.id && item.email === email)) return res.status(409).json({ error: "This IMAP email is already saved." });
    const previousEmail = entry.email;
    entry.email = email;
    if (password) entry.password = password;
    entry.updatedAt = new Date().toISOString();
    entry.connectionStatus = await testSubmittedImap(email, entry.password);
    account.savedImapCredentials = encryptJson(entries);
    await synchronizeImapCopies(account, previousEmail, email, entry.password, entry.updatedAt, entry.connectionStatus);
    await saveCustomerAccounts(accounts);
    liveSuccessLastSyncByAccount.delete(String(account.id));
    return res.json({ ok: true, entry: { id: entry.id, email, passwordConfigured: true, connectionStatus: entry.connectionStatus } });
  } catch (error) {
    console.error("Update IMAP credentials error:", error);
    return res.status(500).json({ error: "Unable to update IMAP login." });
  }
});

app.delete("/api/account/imap-credentials/:id", requireCustomer, async (req, res) => {
  try {
    const accounts = await getCustomerAccounts();
    const account = accounts.find(item => item.id === req.customerAccount.id);
    if (!account) return res.status(404).json({ error: "Customer account not found." });
    const entries = savedImapEntries(account);
    const remaining = entries.filter(item => item.id !== req.params.id);
    if (remaining.length === entries.length) return res.status(404).json({ error: "IMAP login not found." });
    account.savedImapCredentials = encryptJson(remaining);
    await saveCustomerAccounts(accounts);
    return res.json({ ok: true });
  } catch (error) {
    console.error("Delete IMAP credentials error:", error);
    return res.status(500).json({ error: "Unable to delete IMAP login." });
  }
});

app.get(
  "/api/account/saved-details",
  requireCustomer,
  async (req, res) => {
    try {
      const payload =
        await customerSavedDetailsPayload(
          req.customerAccount
        );

      return res.json({
        ok: true,
        ...payload
      });
    } catch (error) {
      console.error(
        "Customer saved details load error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to load saved checkout details."
        });
    }
  }
);

app.post(
  "/api/account/shipping-addresses",
  requireCustomer,
  async (req, res) => {
    try {
      const accounts =
        await getCustomerAccounts();

      const index =
        accounts.findIndex(
          item =>
            item.id ===
            req.customerAccount.id
        );

      if (index < 0) {
        return res
          .status(404)
          .json({
            error:
              "Customer account not found."
          });
      }

      const address =
        sanitizeShippingAddress(
          req.body
        );

      if (
        !validShippingAddress(
          address
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Complete all required shipping address fields."
          });
      }

      const addresses =
        customerSavedAddresses(
          accounts[index]
        );

      if (
        addresses.length >= 20
      ) {
        return res
          .status(400)
          .json({
            error:
              "You can save up to 20 shipping addresses."
          });
      }

      addresses.push(
        address
      );

      accounts[index]
        .shippingAddresses =
          addresses;

      accounts[index]
        .updatedAt =
          new Date()
            .toISOString();

      await saveCustomerAccounts(
        accounts
      );

      return res.json({
        ok: true,
        id:
          address.id,
        message:
          "Shipping address saved."
      });
    } catch (error) {
      console.error(
        "Save shipping address error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to save shipping address."
        });
    }
  }
);

app.put(
  "/api/account/shipping-addresses/:id",
  requireCustomer,
  async (req, res) => {
    try {
      const id =
        clean(
          req.params.id,
          120
        );

      const accounts =
        await getCustomerAccounts();

      const accountIndex =
        accounts.findIndex(
          item =>
            item.id ===
            req.customerAccount.id
        );

      if (accountIndex < 0) {
        return res
          .status(404)
          .json({
            error:
              "Customer account not found."
          });
      }

      const addresses =
        customerSavedAddresses(
          accounts[
            accountIndex
          ]
        );

      const addressIndex =
        addresses.findIndex(
          item =>
            String(item.id) ===
            id
        );

      if (addressIndex < 0) {
        return res
          .status(404)
          .json({
            error:
              "Shipping address not found."
          });
      }

      const next =
        sanitizeShippingAddress(
          req.body,
          id
        );

      if (
        !validShippingAddress(
          next
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Complete all required shipping address fields."
          });
      }

      addresses[
        addressIndex
      ] = next;

      accounts[
        accountIndex
      ].shippingAddresses =
        addresses;

      accounts[
        accountIndex
      ].updatedAt =
        new Date()
          .toISOString();

      await saveCustomerAccounts(
        accounts
      );

      return res.json({
        ok: true,
        message:
          "Shipping address updated."
      });
    } catch (error) {
      console.error(
        "Update shipping address error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to update shipping address."
        });
    }
  }
);

app.delete(
  "/api/account/shipping-addresses/:id",
  requireCustomer,
  async (req, res) => {
    try {
      const id =
        clean(
          req.params.id,
          120
        );

      const accounts =
        await getCustomerAccounts();

      const accountIndex =
        accounts.findIndex(
          item =>
            item.id ===
            req.customerAccount.id
        );

      if (accountIndex < 0) {
        return res
          .status(404)
          .json({
            error:
              "Customer account not found."
          });
      }

      const before =
        customerSavedAddresses(
          accounts[
            accountIndex
          ]
        );

      const after =
        before.filter(
          item =>
            String(item.id) !==
            id
        );

      if (
        after.length ===
        before.length
      ) {
        return res
          .status(404)
          .json({
            error:
              "Shipping address not found."
          });
      }

      accounts[
        accountIndex
      ].shippingAddresses =
        after;

      accounts[
        accountIndex
      ].updatedAt =
        new Date()
          .toISOString();

      await saveCustomerAccounts(
        accounts
      );

      return res.json({
        ok: true,
        message:
          "Shipping address deleted."
      });
    } catch (error) {
      console.error(
        "Delete shipping address error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to delete shipping address."
        });
    }
  }
);

app.post(
  "/api/account/payment-methods",
  requireCustomer,
  async (req, res) => {
    try {
      const vault =
        await getCustomerVault(
          req.customerAccount.id
        );

      if (
        vault.paymentMethods
          .length >= 20
      ) {
        return res
          .status(400)
          .json({
            error:
              "You can save up to 20 payment cards."
          });
      }

      const method =
        sanitizeSavedPaymentMethod(
          req.body
        );

      if (
        !validSavedPaymentMethod(
          method
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Enter a card label, cardholder, valid card number, expiration month, and expiration year."
          });
      }

      vault.paymentMethods.push(
        method
      );

      await saveCustomerVault(
        req.customerAccount.id,
        vault
      );

      return res.json({
        ok: true,
        id:
          method.id,
        message:
          "Payment card saved."
      });
    } catch (error) {
      console.error(
        "Save payment method error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to save payment card."
        });
    }
  }
);

app.put(
  "/api/account/payment-methods/:id",
  requireCustomer,
  async (req, res) => {
    try {
      const id =
        clean(
          req.params.id,
          120
        );

      const vault =
        await getCustomerVault(
          req.customerAccount.id
        );

      const index =
        vault.paymentMethods
          .findIndex(
            item =>
              String(item.id) ===
              id
          );

      if (index < 0) {
        return res
          .status(404)
          .json({
            error:
              "Payment card not found."
          });
      }

      const next =
        sanitizeSavedPaymentMethod(
          req.body,
          vault.paymentMethods[
            index
          ]
        );

      if (
        !validSavedPaymentMethod(
          next
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Enter a card label, cardholder, valid card number, expiration month, and expiration year."
          });
      }

      vault.paymentMethods[
        index
      ] = next;

      await saveCustomerVault(
        req.customerAccount.id,
        vault
      );

      return res.json({
        ok: true,
        message:
          "Payment card updated."
      });
    } catch (error) {
      console.error(
        "Update payment method error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to update payment card."
        });
    }
  }
);

app.delete(
  "/api/account/payment-methods/:id",
  requireCustomer,
  async (req, res) => {
    try {
      const id =
        clean(
          req.params.id,
          120
        );

      const vault =
        await getCustomerVault(
          req.customerAccount.id
        );

      const before =
        vault.paymentMethods;

      const after =
        before.filter(
          item =>
            String(item.id) !==
            id
        );

      if (
        after.length ===
        before.length
      ) {
        return res
          .status(404)
          .json({
            error:
              "Payment card not found."
          });
      }

      vault.paymentMethods =
        after;

      await saveCustomerVault(
        req.customerAccount.id,
        vault
      );

      return res.json({
        ok: true,
        message:
          "Payment card deleted."
      });
    } catch (error) {
      console.error(
        "Delete payment method error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to delete payment card."
        });
    }
  }
);


/* -------------------------------------------------------
   CUSTOMER PROFILE / ORDER HELPERS
------------------------------------------------------- */

function safeCustomerOrder(
  record
) {
  return {
    id:
      record.id,

    orderNumber:
      customerOrderNumber(
        record
      ),

    plan:
      record.plan || null,

    profile:
      record.profile || null,

    createdAt:
      record.createdAt ||
      null,

    paidAt:
      record.paidAt ||
      null,

    subscriptionStatus:
      record.subscriptionStatus ||
      null,

    currentPeriodStart:
      record.currentPeriodStart ||
      null,

    currentPeriodEnd:
      record.currentPeriodEnd ||
      null,

    subscriptionEndDate:
      record.subscriptionEndDate ||
      null,

    cancelAtPeriodEnd:
      record.cancelAtPeriodEnd ===
      true,

    canceledAt:
      record.canceledAt ||
      null,

    endedAt:
      record.endedAt ||
      null,

    customerLinkedAt:
      record.customerLinkedAt ||
      null,

    updatedAt:
      record.updatedAt ||
      record.subscriptionUpdatedAt ||
      null
  };
}

async function getCustomerOwnedOrders(
  accountId
) {
  const paid =
    await readJson(
      PAID_FILE,
      []
    );

  return (
    Array.isArray(paid)
      ? paid
      : []
  ).filter(
    record =>
      record.customerAccountId ===
        accountId
  );
}

/* -------------------------------------------------------
   AUTO-LINK VERIFIED CUSTOMER ORDERS
------------------------------------------------------- */

async function autoLinkVerifiedCustomerOrders(
  account
) {
  if (
    !account?.id ||
    !account?.emailVerifiedAt
  ) {
    return {
      linked: 0
    };
  }

  const accountEmail =
    normalizeEmail(
      account.email
    );

  if (!accountEmail) {
    return {
      linked: 0
    };
  }

  const paid =
    await readJson(
      PAID_FILE,
      []
    );

  const records =
    Array.isArray(paid)
      ? paid
      : [];

  let linked = 0;

  const linkedAt =
    new Date()
      .toISOString();

  for (
    const record of records
  ) {
    /*
      Never move an order that is already
      connected to another account.
    */
    if (
      record.customerAccountId
    ) {
      continue;
    }

    const orderEmail =
      normalizeEmail(
        record?.profile?.email
      );

    if (
      !orderEmail ||
      orderEmail !==
        accountEmail
    ) {
      continue;
    }

    record.customerAccountId =
      account.id;

    record.customerLinkedAt =
      linkedAt;

    record.customerLinkedBy =
      "verified-email";

    linked += 1;
  }

  if (linked > 0) {
    await writeJson(
      PAID_FILE,
      records
    );
  }

  return {
    linked
  };
}

/* -------------------------------------------------------
   UPDATE CUSTOMER ORDER / ACO INFORMATION
------------------------------------------------------- */

app.put(
  "/api/account/orders/:orderNumber",
  requireCustomer,
  async (req, res) => {
    try {
      const requestedOrderNumber =
        clean(
          req.params.orderNumber,
          150
        );

      if (!requestedOrderNumber) {
        return res
          .status(400)
          .json({
            error:
              "Order number is required."
          });
      }

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const records =
        Array.isArray(paid)
          ? paid
          : [];

      const record =
        records.find(
          item =>
            customerOrderNumber(
              item
            ).toLowerCase() ===
              requestedOrderNumber
                .toLowerCase() &&
            item.customerAccountId ===
              req.customerAccount.id
        );

      if (!record) {
        return res
          .status(404)
          .json({
            error:
              "Order could not be found."
          });
      }

      const profileBody =
        req.body?.profile &&
        typeof req.body.profile ===
          "object"
          ? req.body.profile
          : {};

      const nextProfile = {
        ...(record.profile || {})
      };

      const editableProfileFields = [
        ["profileName", 300],
        ["firstName", 100],
        ["lastName", 100],
        ["email", 200],
        ["phone", 50],
        ["address", 300],
        ["address2", 300],
        ["country", 100],
        ["state", 100],
        ["city", 100],
        ["zip", 30]
      ];

      for (
        const [
          key,
          max
        ] of
        editableProfileFields
      ) {
        if (
          Object.prototype
            .hasOwnProperty.call(
              profileBody,
              key
            )
        ) {
          nextProfile[key] =
            clean(
              profileBody[key],
              max
            );
        }
      }

      if (Object.keys(profileBody).length && !validProfile(
        nextProfile
      )) {
        return res
          .status(400)
          .json({
            error:
              "Please complete all required customer and shipping information."
          });
      }

      let existingSecrets = {};

      try {
        const encrypted =
          await readJson(
            path.join(
              SECRET_DIR,
              `${record.id}.encrypted.json`
            ),
            null
          );

        if (encrypted) {
          existingSecrets =
            decryptJson(
              encrypted
            );
        }
      } catch (error) {
        console.error(
          "Customer secure package decrypt error:",
          error.message
        );

        return res
          .status(500)
          .json({
            error:
              "Unable to securely load the saved ACO information."
          });
      }

      const secretsBody =
        req.body?.secrets &&
        typeof req.body.secrets ===
          "object"
          ? req.body.secrets
          : {};

      const nextSecrets = {
        ...existingSecrets
      };

      if (
        Object.prototype
          .hasOwnProperty.call(
            secretsBody,
            "acoEmail"
          )
      ) {
        const value =
          clean(
            secretsBody.acoEmail,
            200
          );

        if (value) {
          nextSecrets.acoEmail =
            value;
        }
      }

      const replacementAcoPassword =
        String(
          secretsBody
            .acoPassword || ""
        );

      if (
        replacementAcoPassword
      ) {
        if (
          replacementAcoPassword
            .length > 300
        ) {
          return res
            .status(400)
            .json({
              error:
                "ACO password is too long."
            });
        }

        nextSecrets.acoPassword =
          replacementAcoPassword;
      }

      if (
        Object.prototype
          .hasOwnProperty.call(
            secretsBody,
            "cardLabel"
          )
      ) {
        const value =
          clean(
            secretsBody.cardLabel,
            100
          );

        if (value) {
          nextSecrets.cardLabel =
            value;
        }
      }

      if (
        Object.prototype
          .hasOwnProperty.call(
            secretsBody,
            "cardholder"
          )
      ) {
        const value =
          clean(
            secretsBody.cardholder,
            150
          );

        if (value) {
          nextSecrets.cardholder =
            value;
        }
      }

      const replacementCardNumber =
        clean(
          secretsBody
            .acoCardNumber,
          30
        ).replace(
          /[^\d]/g,
          ""
        );

      if (
        replacementCardNumber
      ) {
        if (
          !/^\d{12,19}$/.test(
            replacementCardNumber
          )
        ) {
          return res
            .status(400)
            .json({
              error:
                "Enter a valid replacement card number."
            });
        }

        nextSecrets.acoCardNumber =
          replacementCardNumber;
      }

      const replacementMonth =
        clean(
          secretsBody.expMonth,
          2
        );

      const replacementYear =
        clean(
          secretsBody.expYear,
          4
        );

      if (
        replacementMonth ||
        replacementYear
      ) {
        if (
          !replacementMonth ||
          !replacementYear
        ) {
          return res
            .status(400)
            .json({
              error:
                "Enter both the replacement expiration month and year."
            });
        }

        nextSecrets.expMonth =
          replacementMonth;

        nextSecrets.expYear =
          replacementYear;
      }

      /* -------------------------------------------------------
   SECURITY CODE REPLACEMENT
   Blank = keep the existing saved value
------------------------------------------------------- */

const replacementSecurityCode =
  clean(
    secretsBody.securityCode,
    300
  );

if (replacementSecurityCode) {
  nextSecrets.securityCode =
    replacementSecurityCode;
}


/* -------------------------------------------------------
   CUSTOMER UPDATE AUDIT
------------------------------------------------------- */

const updatedAt =
  new Date()
    .toISOString();

record.profile =
  nextProfile;

/*
  General last-modified timestamp.
*/
record.updatedAt =
  updatedAt;

/*
  Specifically identifies an edit made
  from the customer's My Profile page.
*/
record.customerUpdatedAt =
  updatedAt;

record.updatedBy =
  "customer";


if (secretsBody.acoEmail || replacementAcoPassword) {
  nextSecrets.imapUpdatedAt = updatedAt;
  nextSecrets.imapConnectionStatus = await testSubmittedImap(nextSecrets.acoEmail, nextSecrets.acoPassword);
  await synchronizeStoredImapCopies(record.customerAccountId, existingSecrets.acoEmail,
    nextSecrets.acoEmail, nextSecrets.acoPassword, updatedAt, nextSecrets.imapConnectionStatus);
}

/* Save updated encrypted ACO information */

await saveEncryptedPackage(
  record.id,
  nextSecrets
);


/* Save updated customer/order record */

await writeJson(
  PAID_FILE,
  records
);

      return res.json({
        ok: true,
        imapConnectionStatus: nextSecrets.imapConnectionStatus || null,

        message:
          "Your profile information has been updated.",

        order:
          safeCustomerOrder(
            record
          )
      });

    } catch (error) {
      console.error(
        "Customer order update error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to update your profile information."
        });
    }
  }
);

/* -------------------------------------------------------
   CREATE RENTAL CHECKOUT SESSION
------------------------------------------------------- */

app.get("/api/rental-single-prices", async (_req, res) => {
  try {
    const durations = ["1_drop", "1_week", "1_month"];
    const amounts = await Promise.all(durations.map(duration => rentalAmountFor(1, duration)));
    return res.json({ prices: Object.fromEntries(durations.map((duration, index) => [duration, amounts[index]])) });
  } catch (error) {
    console.error("Single account rental prices unavailable:", error?.message);
    return res.status(503).json({ error: "Single account rental prices are temporarily unavailable." });
  }
});

app.post(
  "/api/create-rental-checkout-session",
  requireCustomer,
  async (req, res) => {
    try {
      const retailer =
        normalizeRentalRetailer(
          req.body?.retailer
        );

      const quantity =
        Number(
          req.body?.quantity
        );

      const durationType =
        normalizeSpecialProfileDuration(
          req.body?.durationType
        );

      const price =
        await rentalAmountFor(
          quantity,
          durationType
        );

      const rentalPriceId =
        rentalPriceIdFor(
          quantity,
          durationType
        );

      if (
        !retailer ||
        ![1, 5, 10, 15].includes(
          quantity
        ) ||
        ![
          "1_drop",
          "1_week",
          "1_month"
        ].includes(durationType) ||
        price == null
      ) {
        return res
          .status(400)
          .json({
            error:
              "Choose a valid rental package."
          });
      }

      if (!rentalPriceId) {
        return res
          .status(500)
          .json({
            error:
              "This rental package is not configured for Stripe checkout yet."
          });
      }

      const customerAccountId =
        req.customerAccount.id;

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const paidRecords =
        Array.isArray(paid)
          ? paid
          : [];

      const paidRecord =
        paidRecords.find(
          record =>
            record.customerAccountId ===
              customerAccountId &&
            subscriptionAllowsProfiles(
              record
            )
        );

      const activeGift = !paidRecord
        ? (await getGiftedMemberships()).find(item =>
            String(item.customerAccountId) === String(customerAccountId) &&
            new Date(item.startsAt).getTime() <= Date.now() &&
            new Date(item.expiresAt).getTime() > Date.now()
          )
        : null;
      if (!paidRecord && !activeGift) {
        return res
          .status(403)
          .json({
            error:
              "An active membership is required before renting additional accounts."
          });
      }

      const availableAccounts =
        await getAvailableManagedAccountsForRetailer(
          retailer
        );

      if (
        availableAccounts.length <
        quantity
      ) {
        return res
          .status(409)
          .json({
            error:
              `Only ${availableAccounts.length} ${retailerDisplayName(retailer)} rental account(s) are currently available.`
          });
      }

      const retailerLabel = retailerDisplayName(retailer);

      const durationLabel =
        durationType === "1_week"
          ? "1 Week"
          : durationType === "1_month"
            ? "1 Month"
            : "1 Drop";

      const session =
        await stripe
          .checkout
          .sessions
          .create({
            mode: "payment",

            line_items: [
              {
                price:
                  rentalPriceId,
                quantity: 1
              }
            ],

            success_url:
              `${BASE_URL}/?rental=success#my-profile`,

            cancel_url:
              `${BASE_URL}/?rental=cancelled#my-profile`,

            metadata: {
              purchase_type:
                "rental",
              retailer,
              account_quantity:
                String(quantity),
              duration_type:
                durationType,
              rental_price:
                String(price),
              customer_account_id:
                String(
                  customerAccountId
                ),
              paid_submission_id:
                String(
                  paidRecord?.id || `gift:${activeGift.id}`
                )
            },

            customer_email:
              req.customerAccount.email ||
              paidRecord?.profile?.email ||
              undefined,

            allow_promotion_codes:
              true
          });

      return res.json({
        url: session.url
      });

    } catch (error) {
      console.error(
        "Rental checkout session error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to create the rental checkout session."
        });
    }
  }
);


/* -------------------------------------------------------
   CREATE CHECKOUT SESSION
------------------------------------------------------- */

app.post(
  "/api/create-checkout-session",
  requireCustomer,
  async (req, res) => {
    try {
      const tier =
        Number(
          req.body.tier
        );

      const plan =
        PLANS[tier];

      if (!plan) {
        return res
          .status(400)
          .json({
            error:
              "Invalid membership tier."
          });
      }

      if (!plan.priceId) {
        return res
          .status(500)
          .json({
            error:
              `${plan.name} is not configured for Stripe checkout yet.`
          });
      }

      if (req.body.acknowledgeAcoOutcome !== true) {
        return res.status(400).json({
          error: "Please acknowledge that ACO does not guarantee a checkout before continuing."
        });
      }

      if (req.body.authorizeRequestedPurchases !== true) {
        return res.status(400).json({
          error: "Please agree to the requested purchase authorization before continuing."
        });
      }
      if (req.body.confirm !== true) {
        return res.status(400).json({ error: "Please confirm that the checkout information is accurate." });
      }

      const consentFlowId = String(req.body.consentFlowId || "");
      let discountOptions;
      try {
        discountOptions = membershipDiscountOptions(await getDiscountCodes(), req.body.discountCode, tier, Date.now(), req.customerAccount.email);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
      if (!/^[0-9a-f-]{36}$/i.test(consentFlowId)) {
        return res.status(400).json({ error: "Please check the consent boxes again before checkout." });
      }
      await consentLedgerQueue;
      const consentEvents = (await readConsentLedger()).entries.filter(item =>
        item.type === "checkbox_event" && item.accountId === req.customerAccount.id &&
        item.flowId === consentFlowId && item.consentVersion === PURCHASE_CONSENT_VERSION
      );
      const accepted = {};
      for (const checkbox of PURCHASE_CONSENT_KEYS) {
        const latest = consentEvents.filter(item => item.checkbox === checkbox).at(-1);
        if (!latest?.checked || Date.now() - Date.parse(latest.recordedAt) > 24 * 60 * 60 * 1000) {
          return res.status(400).json({ error: "Please check each consent box again before checkout." });
        }
        accepted[checkbox] = {
          text: PURCHASE_CONSENT_TEXT[checkbox],
          serverReceivedAt: latest.recordedAt,
          clientReportedClickAt: latest.clientReportedClickAt,
          checkboxEventId: latest.id
        };
      }

      const profile =
        sanitizeProfile(
          req.body.profile || {}
        );

      const secrets =
        sanitizeSecrets(
          req.body.secrets || {}
        );


      if (
        !validProfile(profile)
      ) {
        return res
          .status(400)
          .json({
            error:
              "Please complete all required customer and shipping information."
          });
      }

      if (
        !validSecrets(secrets)
      ) {
        return res
          .status(400)
          .json({
            error:
              "Please complete all required ACO and card information."
          });
      }

      const referredByDiscord = referralDiscordValue(req.body.referredByDiscord);
      if (referredByDiscord === null) {
        return res.status(400).json({ error: "Enter a valid Discord @username for the person who referred you." });
      }
      if (referredByDiscord) {
        const accounts = await getCustomerAccounts();
        const account = accounts.find(item => item.id === req.customerAccount.id);
        if (!account) return res.status(401).json({ error: "Please sign in again." });
        const referrer = findLinkedReferrer(accounts, referredByDiscord);
        if (!referrer) {
          return res.status(400).json({ error: "We could not find that referral. Ask the member to connect Discord in My Profile." });
        }
        if (referrer.id === account.id) {
          return res.status(400).json({ error: "You cannot refer yourself." });
        }
        if (account.referredByAccountId && account.referredByAccountId !== referrer.id) {
          return res.status(409).json({ error: "A different referral is already linked to your account." });
        }
        if (!account.referredByAccountId) {
          account.referredByDiscord = referredByDiscord;
          account.referredByAccountId = referrer.id;
          account.referralRecordedAt = new Date().toISOString();
          account.updatedAt = account.referralRecordedAt;
          await saveCustomerAccounts(accounts);
          if (account.emailVerifiedAt) await awardVerifiedReferral(account);
          void processPendingReferrals().catch(error => console.error("Referral notification:", error.message));
        }
      }


      const id =
        crypto.randomUUID();

      const now =
        new Date()
          .toISOString();

      const consentRecord = await appendConsentRecord({
        type: "checkout_consent", accountId: req.customerAccount.id,
        signupEmail: req.customerAccount.email, purchaseEmail: profile.email,
        submissionId: id, planName: plan.name, consentVersion: PURCHASE_CONSENT_VERSION,
        checkboxes: accepted, checkoutStartedAt: now,
        paymentConfirmed: false, ...consentRequestMetadata(req)
      });
      const checkboxLines = PURCHASE_CONSENT_KEYS.map(key =>
        `${key}\nText: ${accepted[key].text}\nServer received click (UTC): ${accepted[key].serverReceivedAt}\nBrowser-reported click (UTC, unverified): ${accepted[key].clientReportedClickAt || "not available"}`
      ).join("\n\n");
      await queueConsentReceipt(
        `Membership checkout consent — ${req.customerAccount.email}`,
        `Membership checkout consent recorded\n\nAccount ID: ${req.customerAccount.id}\nAccount email: ${req.customerAccount.email}\nCheckout contact email: ${profile.email}\nSubmission ID: ${id}\nPlan: ${plan.name}\nServer checkout time (UTC): ${now}\nConsent version: ${PURCHASE_CONSENT_VERSION}\nAudit record ID: ${consentRecord.id}\n\n${checkboxLines}\n\nThis records choices before Stripe Checkout. It does not state that payment completed or authorize unspecified future items. No card number or security code is included.`
      );

      const pending =
        await readJson(
          PENDING_FILE,
          {}
        );

      pending[id] = {
        id,

        orderNumber: newCustomerOrderNumber(),

        plan: {
          tier,
          name:
            plan.name,
          profiles:
            plan.profiles,
          amount:
            plan.amount
        },

        profile,

        customerAccountId:
          req.customerAccount.id,

        purchaseAuthorizationAcceptedAt:
          now,

        consentRecordId:
          consentRecord.id,

        createdAt:
          now
      };

      await writeJson(
        PENDING_FILE,
        pending
      );

      await saveEncryptedPackage(
        id,
        secrets
      );

      const session =
        await stripe
          .checkout
          .sessions
          .create({
            mode:
              "subscription",

            line_items: [
              {
                price:
                  plan.priceId,
                quantity: 1
              }
            ],

            success_url:
              `${BASE_URL}/?payment=success#my-profile`,

            cancel_url:
              `${BASE_URL}/?payment=cancelled#pricing`,

            metadata: {
              submission_id:
                id,
              customer_account_id:
                String(req.customerAccount.id)
            },

            subscription_data: {
              metadata: {
                submission_id:
                  id,
                customer_account_id:
                  String(req.customerAccount.id)
              }
            },

            customer_email:
              profile.email,

            billing_address_collection:
              "auto",

            ...discountOptions
          });

      return res.json({
        url: session.url
      });

    } catch (error) {
      console.error(
        "Checkout session error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to create checkout session. Check the secure server and Stripe configuration."
        });
    }
  }
);

/* -------------------------------------------------------
   UPGRADE EXISTING MEMBERSHIP
   - Updates the existing Stripe subscription
   - Keeps the current billing-cycle date
   - Immediately invoices only the prorated difference
   - Does NOT create a second subscription
------------------------------------------------------- */

app.post(
  "/api/account/membership/upgrade",
  requireCustomer,
  async (req, res) => {
    try {
      const targetTier =
        Number(
          req.body?.tier
        );

      const targetPlan =
        PLANS[targetTier];

      if (
        !Number.isInteger(
          targetTier
        ) ||
        !targetPlan
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid membership tier."
          });
      }

      if (!targetPlan.priceId) {
        return res
          .status(500)
          .json({
            error:
              `${targetPlan.name} is not configured for Stripe yet.`
          });
      }

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const records =
        Array.isArray(paid)
          ? paid
          : [];

      /*
        Find this customer's active membership
        that actually has a Stripe subscription.
      */

      const activeRecords =
        records.filter(
          record =>
            record.customerAccountId ===
              req.customerAccount.id &&
            record.stripeSubscriptionId &&
            subscriptionAllowsProfiles(
              record
            )
        );

      if (!activeRecords.length) {
        return res
          .status(404)
          .json({
            error:
              "No active Stripe membership was found for this account."
          });
      }

      /*
        If historical duplicate memberships exist,
        use the membership with the highest current
        profile allowance.
      */

      const record =
        [...activeRecords]
          .sort(
            (a, b) =>
              profileAllowanceForRecord(
                b
              ) -
              profileAllowanceForRecord(
                a
              )
          )[0];

      const subscription =
        await stripe
          .subscriptions
          .retrieve(
            record
              .stripeSubscriptionId
          );

      if (
        subscription.status !==
        "active"
      ) {
        return res
          .status(409)
          .json({
            error:
              "Only an active membership can be upgraded."
          });
      }

      if (
        subscription
          .cancel_at_period_end ===
        true
      ) {
        return res
          .status(409)
          .json({
            error:
              "This membership is scheduled to cancel. Reactivate it before upgrading."
          });
      }

      const subscriptionItems =
        subscription
          ?.items
          ?.data || [];

      /*
        SLABS N GRABS ACO memberships are
        single-price subscriptions.

        Refuse to make an automatic change if
        Stripe contains an unexpected item setup.
      */

      if (
        subscriptionItems.length !== 1
      ) {
        return res
          .status(409)
          .json({
            error:
              "This membership has an unexpected Stripe configuration and cannot be upgraded automatically."
          });
      }

      const subscriptionItem =
        subscriptionItems[0];

      const currentPriceId =
        typeof subscriptionItem
          ?.price === "string"
          ? subscriptionItem.price
          : subscriptionItem
              ?.price?.id || "";

      const matchedCurrentPlan =
        planForStripePriceId(
          currentPriceId
        );

      const currentTier =
        matchedCurrentPlan
          ?.tier ||
        Number(
          record?.plan?.tier ||
          record?.plan?.id ||
          0
        );

      if (
        !Number.isInteger(
          currentTier
        ) ||
        currentTier < 1
      ) {
        return res
          .status(409)
          .json({
            error:
              "The current membership tier could not be identified."
          });
      }

      if (
        targetTier ===
        currentTier
      ) {
        return res
          .status(400)
          .json({
            error:
              `You are already on the ${targetPlan.name} membership.`
          });
      }

      if (
        targetTier <
        currentTier
      ) {
        return res
          .status(400)
          .json({
            error:
              "This upgrade option can only move to a higher membership tier."
          });
      }

      /*
        Use one timestamp for the proration
        calculation and the actual update.
      */

      const prorationDate =
        Math.floor(
          Date.now() / 1000
        );

      /*
        IMPORTANT:

        always_invoice:
        Creates the prorated credit/charge and
        invoices it immediately.

        error_if_incomplete:
        If the immediate payment fails, Stripe
        does NOT apply the membership upgrade.

        The billing-cycle anchor remains unchanged,
        so their normal renewal date stays the same.
      */

      adminUpgradeNotificationInProgress.add(
        String(
          subscription.id
        )
      );

      /*
        Failsafe: never allow a failed/interrupted upgrade
        request to leave the invoice notification suppressed.
      */
      setTimeout(
        () => {
          adminUpgradeNotificationInProgress.delete(
            String(
              subscription.id
            )
          );
        },
        120000
      );

      const updatedSubscription =
        await stripe
          .subscriptions
          .update(
            subscription.id,
            {
              items: [
                {
                  id:
                    subscriptionItem.id,

                  price:
                    targetPlan.priceId,

                  quantity: 1
                }
              ],

              proration_behavior:
                "always_invoice",

              payment_behavior:
                "error_if_incomplete",

              proration_date:
                prorationDate,

              metadata: {
                ...(
                  subscription
                    .metadata ||
                  {}
                ),

                membership_tier:
                  String(
                    targetTier
                  )
              }
            }
          );

      /*
        Keep our local paid membership record
        synchronized immediately.

        The Stripe webhook remains the secondary
        source of subscription updates.
      */

      await applySubscriptionInfo(
        record,
        updatedSubscription
      );

      /*
        Fallback assignment in case Stripe's
        response ever omits the expanded price.
      */

      record.plan = {
        tier:
          targetTier,

        name:
          targetPlan.name,

        profiles:
          targetPlan.profiles,

        amount:
          targetPlan.amount
      };

      const upgradedAt =
        new Date()
          .toISOString();

      record.membershipUpgradeFromTier =
        currentTier;

      record.membershipUpgradedAt =
        upgradedAt;

      record.subscriptionUpdatedAt =
        upgradedAt;

      await writeJson(
        PAID_FILE,
        records
      );

      try {
        let upgradeAmount =
          null;

        const latestInvoiceId =
          typeof updatedSubscription
            ?.latest_invoice ===
            "string"
            ? updatedSubscription
                .latest_invoice
            : updatedSubscription
                ?.latest_invoice
                ?.id ||
              null;

        if (latestInvoiceId) {
          try {
            const invoice =
              await stripe
                .invoices
                .retrieve(
                  latestInvoiceId
                );

            upgradeAmount =
              moneyFromStripeCents(
                invoice?.amount_paid ??
                invoice?.amount_due
              );

          } catch (invoiceError) {
            console.error(
              "Upgrade Discord invoice lookup failed:",
              invoiceError.message
            );
          }
        }

        await sendDiscordAdminPaymentNotification({
          paymentType:
            "Membership upgrade / proration",

          headline:
            `Membership upgraded from Tier ${currentTier} to Tier ${targetTier}.`,

          amount:
            upgradeAmount,

          profile:
            record.profile ||
            {},

          customerEmail:
            record.profile?.email ||
            req.customerAccount?.email ||
            "",

          purchaseSummary:
            `${targetPlan.name} — ${targetPlan.profiles} profile(s)`,

          orderId:
            record.id ||
            null,

          profiles:
            targetPlan.profiles,

          paidAt:
            upgradedAt
        });

        record.adminUpgradeDiscordNotifiedAt =
          new Date()
            .toISOString();

        record.adminUpgradeDiscordTier =
          targetTier;

        await writeJson(
          PAID_FILE,
          records
        );

      } catch (notificationError) {
        console.error(
          "Direct membership upgrade Discord notification failed:",
          notificationError.message
        );

      } finally {
        adminUpgradeNotificationInProgress.delete(
          String(
            subscription.id
          )
        );
      }


      return res.json({
        ok: true,

        message:
          `Membership upgraded to ${targetPlan.name}. Stripe charged the prorated difference for the remaining billing period.`,

        membership: {
          tier:
            targetTier,

          name:
            targetPlan.name,

          profiles:
            targetPlan.profiles,

          amount:
            targetPlan.amount,

          status:
            updatedSubscription
              .status ||
            "active",

          currentPeriodStart:
            record
              .currentPeriodStart ||
            null,

          currentPeriodEnd:
            record
              .currentPeriodEnd ||
            null,

          subscriptionEndDate:
            record
              .subscriptionEndDate ||
            null,

          cancelAtPeriodEnd:
            record
              .cancelAtPeriodEnd ===
            true
        }
      });

    } catch (error) {
      try {
        if (
          typeof subscription !==
            "undefined" &&
          subscription?.id
        ) {
          adminUpgradeNotificationInProgress.delete(
            String(
              subscription.id
            )
          );
        }
      } catch {
        // No-op cleanup.
      }

      console.error(
        "Membership upgrade error:",
        error?.type ||
        error?.code ||
        error?.message ||
        error
      );

      /*
        A failed immediate Stripe payment must
        not silently upgrade the membership.
      */

      if (
        error?.type ===
          "StripeCardError" ||
        error?.statusCode === 402 ||
        error?.code ===
          "card_declined" ||
        error?.code ===
          "payment_intent_authentication_failure"
      ) {
        return res
          .status(402)
          .json({
            error:
              "The prorated upgrade payment could not be completed. Your current membership was not changed."
          });
      }

      return res
        .status(500)
        .json({
          error:
            "Unable to upgrade the membership right now. Your current membership has not been changed."
        });
    }
  }
);


/* -------------------------------------------------------
   SUCCESS DASHBOARD
------------------------------------------------------- */

/* -------------------------------------------------------
   CUSTOMER IMAP CONNECTION
------------------------------------------------------- */

function getImapProvider(
  email
) {
  const normalized =
    normalizeEmail(email);

  const domain =
    normalized.split("@")[1] || "";

  const providers = {
    "gmail.com": {
      name: "Google",
      host: "imap.gmail.com",
      port: 993
    },

    "googlemail.com": {
      name: "Google",
      host: "imap.gmail.com",
      port: 993
    },

    "yahoo.com": {
      name: "Yahoo",
      host: "imap.mail.yahoo.com",
      port: 993
    },

    "ymail.com": {
      name: "Yahoo",
      host: "imap.mail.yahoo.com",
      port: 993
    },

    "outlook.com": {
      name: "Microsoft",
      host: "outlook.office365.com",
      port: 993
    },

    "hotmail.com": {
      name: "Microsoft",
      host: "outlook.office365.com",
      port: 993
    },

    "live.com": {
      name: "Microsoft",
      host: "outlook.office365.com",
      port: 993
    }
  };

  return (
    providers[domain] ||
    null
  );
}


function createCustomerImapClient(
  email,
  password
) {
  const provider =
    getImapProvider(email);

  if (!provider) {
    const error =
      new Error(
        "Unsupported mailbox provider."
      );

    error.code =
      "UNSUPPORTED_PROVIDER";

    throw error;
  }

  return {
    provider,

    client:
      protectImapClient(new ImapFlow({
        host:
          provider.host,

        port:
          provider.port,

        secure:
          true,

        auth: {
          user:
            normalizeEmail(email),

          pass:
            normalizeImapPassword(email, password)
        },

        /*
          Never allow IMAP credentials,
          commands or mailbox content
          into application logs.
        */
        logger:
          false,

        connectionTimeout:
          15000,

        greetingTimeout:
          10000,

        socketTimeout:
          30000,

        disableAutoIdle:
          true
      }))
  };
}


async function verifyCustomerImap(
  email,
  password
) {
  const {
    provider,
    client
  } =
    createCustomerImapClient(
      email,
      password
    );

  try {
    await client.connect();

    return {
      connected: true,
      provider:
        provider.name
    };

  } finally {
    if (client.usable) {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    } else {
      client.close();
    }
  }
}

async function getSuccessCheckouts() {
  const records =
    await readJson(
      SUCCESS_CHECKOUTS_FILE,
      []
    );

  return Array.isArray(records)
    ? records
    : [];
}

const REMOVED_SUCCESS_PRODUCT =
  "Pokemon Mega Evolution Chaos Rising Booster Box 36CT";

function isDiscordSuccessRecord(record) {
  if (String(record?.source || "") === "discord_success") {
    return true;
  }

  const ids = [
    record?.id,
    ...(Array.isArray(record?.sourceIds) ? record.sourceIds : [])
  ];

  return ids.some(id =>
    String(id || "").startsWith("discord:")
  );
}

function visibleDiscordSuccessRecords(records) {
  return (Array.isArray(records) ? records : [])
    .filter(isDiscordSuccessRecord)
    .map(record => {
      const originalItems =
        Array.isArray(record?.items)
          ? record.items
          : [];

      const removedItems =
        originalItems.filter(item =>
          String(item?.name || "").trim().toLowerCase() ===
            REMOVED_SUCCESS_PRODUCT.toLowerCase() &&
          Number(item?.quantity || 0) === 1
        );

      if (!removedItems.length) {
        return record;
      }

      const items =
        originalItems.filter(item =>
          !(
            String(item?.name || "").trim().toLowerCase() ===
              REMOVED_SUCCESS_PRODUCT.toLowerCase() &&
            Number(item?.quantity || 0) === 1
          )
        );

      if (!items.length) {
        return null;
      }

      const removedValue =
        removedItems.reduce(
          (sum, item) =>
            sum +
            Math.max(0, Number(item?.price || 0)) *
              Math.max(0, Number(item?.quantity || 0)),
          0
        );

      const orderTotal =
        removedValue > 0
          ? Math.max(0, Number(record?.orderTotal || 0) - removedValue)
          : Number(record?.orderTotal || 0);

      return {
        ...record,
        items,
        itemCount:
          items.reduce(
            (sum, item) =>
              sum +
              Math.max(0, Math.floor(Number(item?.quantity || 0))),
            0
          ),
        orderTotal
      };
    })
    .filter(Boolean);
}

// Read-only Discord channel import. Message authors are never attached to
// customer accounts; the channel contributes anonymous community totals.
const discordSuccessScan = { running: false, checkedAt: null, added: 0, skipped: 0, error: null, newestMessageId: null };
function discordSuccessConfig() {
  return {
    token: String(process.env.DISCORD_BOT_TOKEN || "").trim(),
    channelId: String(process.env.DISCORD_SUCCESS_CHANNEL_ID || "").trim()
  };
}

let discordSuccessChannelLookup = null;
async function resolvedDiscordSuccessConfig() {
  const config = discordSuccessConfig();
  if (/^\d{17,22}$/.test(config.channelId)) return config;
  let webhookUrl;
  try { webhookUrl = new URL(config.channelId); } catch { return config; }
  if (webhookUrl.protocol !== "https:" ||
      !["discord.com", "discordapp.com"].includes(webhookUrl.hostname) ||
      webhookUrl.port || webhookUrl.search || webhookUrl.hash) return config;
  const match = webhookUrl.pathname.match(/^\/api(?:\/v\d+)?\/webhooks\/(\d{17,22})\/([A-Za-z0-9._-]+)\/?$/);
  if (!match) return config;
  if (!discordSuccessChannelLookup) {
    discordSuccessChannelLookup = (async () => {
      const response = await fetch(`https://discord.com/api/v10/webhooks/${match[1]}/${match[2]}`, {
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) throw new Error(`Discord webhook lookup failed (HTTP ${response.status}).`);
      const webhook = await response.json();
      if (!/^\d{17,22}$/.test(String(webhook.channel_id || ""))) {
        throw new Error("The configured Discord webhook has no text channel ID.");
      }
      return String(webhook.channel_id);
    })();
  }
  try {
    return { ...config, channelId: await discordSuccessChannelLookup, source: "webhook" };
  } catch (error) {
    return { ...config, lookupError: error.message };
  }
}

let checkoutSourceChannelsCache = null;
async function discordCheckoutSourceChannels() {
  const config = await resolvedDiscordSuccessConfig();
  const explicit = String(process.env.DISCORD_CHECKOUT_SOURCE_CHANNEL_ID || '').trim();
  if (/^\d{17,22}$/.test(explicit)) return { token: config.token, channels: [...new Set([config.channelId, explicit].filter(id => /^\d{17,22}$/.test(id)))] };
  if (checkoutSourceChannelsCache) return { token: config.token, ...checkoutSourceChannelsCache };
  const channels = /^\d{17,22}$/.test(config.channelId) ? [config.channelId] : [];
  if (!config.token) return { token: '', channels };
  const get = async route => {
    const response = await fetch('https://discord.com/api/v10' + route,
      { headers: { Authorization: `Bot ${config.token}` }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Discord checkout source lookup failed (HTTP ${response.status}).`);
    return response.json();
  };
  const found = [];
  for (const guild of await get('/users/@me/guilds')) {
    const list = await get(`/guilds/${guild.id}/channels`);
    for (const channel of list) {
      if (channel.type === 0 && String(channel.name || '').toLowerCase().replace(/[^a-z]/g, '') === 'successwebhooks') found.push(channel.id);
    }
  }
  if (found.length === 1) channels.push(found[0]);
  else console.error('Checkout source channel discovery:', found.length ? 'multiple_success_webhooks_channels_set_explicit_id' : 'success_webhooks_channel_not_accessible_to_bot');
  checkoutSourceChannelsCache = { channels: [...new Set(channels)], webhookSourceFound: found.length === 1 };
  return { token: config.token, ...checkoutSourceChannelsCache };
}

function discordCheckoutFromMessage(message, channelId) {
  const embed = (message.embeds || []).find(item => /success|checkout|order confirm/i.test([item.title, item.description].join(" "))) || null;
  const messageText = String(message.content || "");
  if (!embed && !/success|checkout|order confirm/i.test(messageText)) return null;
  if (/NEW CHECKOUT SUCCESS/i.test(embed?.title || "")) return null; // Already saved by this site's own webhook.
  const body = [messageText, embed?.description || "", ...(embed?.fields || []).map(field => `${field.name}: ${field.value}`)].join("\n");
  const items = [];
  const fields = embed?.fields || [];
  const numbered = new Map();
  const fieldLabel = value => String(value || "").replace(/[*_`]/g, "").trim();
  const fieldValue = value => String(value || "").replace(/[*_`]/g, "").trim();
  for (const field of fields) {
    const match = fieldLabel(field.name).match(/^(product|price|quantity)\s*\((\d+)\)$/i);
    if (!match) continue;
    const entry = numbered.get(match[2]) || {};
    entry[match[1].toLowerCase()] = fieldValue(field.value);
    numbered.set(match[2], entry);
  }
  const itemField = fields.find(field => /^(item|product)$/i.test(fieldLabel(field.name)));
  if (!numbered.size && itemField) {
    const rawItem = fieldValue(itemField.value);
    const priceMatch = rawItem.match(/\s*[-–]\s*\$([\d,]+(?:\.\d{1,2})?)\s*$/);
    const priceField = fields.find(field => /^(price|unit price)$/i.test(fieldLabel(field.name)));
    const quantityField = fields.find(field => /^quantity$/i.test(fieldLabel(field.name)));
    numbered.set("1", { product: priceMatch ? rawItem.slice(0, priceMatch.index) : rawItem,
      quantity: fieldValue(quantityField?.value), price: priceMatch?.[1] || fieldValue(priceField?.value), priceIsLineTotal: Boolean(priceMatch) });
  }
  let subtotalCents = 0, completePrices = numbered.size > 0;
  for (const entry of numbered.values()) {
    const name = publicSuccessProductName(entry.product);
    const quantity = Number(entry.quantity);
    if (!name || !isPublicSuccessProduct(name) || /@|\b(?:address|email|phone|account|ship to)\b/i.test(name) ||
        !Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      completePrices = false;
      continue;
    }
    const money = String(entry.price || "").replace(/[$,\s]/g, "");
    const validPrice = /^\d+(?:\.\d{1,2})?$/.test(money);
    const priceCents = validPrice ? Math.round(Number(money) * 100) : null;
    if (priceCents === null || !Number.isSafeInteger(priceCents)) completePrices = false;
    else subtotalCents += entry.priceIsLineTotal ? priceCents : priceCents * quantity;
    items.push({ name, quantity, price: priceCents === null ? 0 : priceCents / 100 / (entry.priceIsLineTotal ? quantity : 1),
      imageUrl: publicSuccessImageUrl(embed?.thumbnail?.url || embed?.image?.url) });
  }
  for (const line of numbered.size ? [] : body.split(/\n+/)) {
    const match = line.match(/^\s*(?:[•*\-]\s*)?(.{5,120}?)\s*(?:[×xX]\s*(\d+)|\(\s*(\d+)\s*\))\s*$/);
    if (!match) continue;
    const name = publicSuccessProductName(match[1]);
    if (isPublicSuccessProduct(name) && !/@|\b(?:address|email|phone|account|ship to)\b/i.test(name)) {
      items.push({ name, quantity: Math.min(999, Number(match[2] || match[3])), imageUrl: publicSuccessImageUrl(embed?.thumbnail?.url || embed?.image?.url) });
    }
  }
  if (!items.length) return null;
  const retailer = (embed?.fields || []).find(field => /^(retailer|store|site)$/i.test(field.name || ""))?.value || "";
  const totalField = (embed?.fields || []).find(field => /total|spent|amount/i.test(field.name || ""))?.value ||
    body.match(/(?:total|spent|amount)\s*[:$]\s*\$?([\d,.]+)/i)?.[1] || "";
  const totalMatch = String(totalField).match(/\$?([\d,]+\.\d{2})/);
  return {
    id: `discord:${channelId}:${message.id}`,
    customerAccountId: null,
    orderNumber: discordCheckoutIdentity(message).orderNumber,
    retailer: normalizeSuccessRetailer(retailer),
    checkoutAt: message.timestamp || new Date().toISOString(),
    orderTotal: totalMatch ? Number(totalMatch[1].replace(/,/g, "")) : completePrices ? subtotalCents / 100 : 0,
    orderTotalBasis: totalMatch ? "order_total" : completePrices ? "item_subtotal" : "unknown",
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    items, status: "confirmed"
  };
}



const DISCORD_HIT_MIRROR_FILE = path.join(DATA_DIR, "discord-hit-mirror.json");
const DISCORD_HIT_MIRROR_VERSION = 8;
let discordHitsChannelIdCache = null;
let discordHitMirrorMutation = Promise.resolve();

function discordHitMirrorState(task) {
  const next = discordHitMirrorMutation.then(task);
  discordHitMirrorMutation = next.catch(() => {});
  return next;
}

async function discordBotJson(token, route, options = {}, retries = 5) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(`https://discord.com/api/v10${route}`, {
      ...options,
      headers: {
        Authorization: `Bot ${token}`,
        ...(options.headers || {})
      },
      signal: AbortSignal.timeout(15000)
    });
    if (response.status === 429 && attempt < retries) {
      const limited = await response.json().catch(() => ({}));
      const delay = Math.max(350, Math.ceil(Number(limited.retry_after || 0.5) * 1000) + 100);
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Discord request failed (HTTP ${response.status}) ${detail.slice(0, 200)}`);
    }
    return response.status === 204 ? null : response.json();
  }
  throw new Error("Discord request remained rate limited.");
}

async function resolveDiscordHitsChannelId(token) {
  if (discordHitsChannelIdCache) return discordHitsChannelIdCache;
  const found = [];
  for (const guild of await discordBotJson(token, "/users/@me/guilds")) {
    for (const channel of await discordBotJson(token, `/guilds/${guild.id}/channels`)) {
      const normalized = String(channel.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (channel.type === 0 && normalized === "slabsngrabsacohits") found.push(String(channel.id));
    }
  }
  if (found.length !== 1) {
    throw new Error(found.length
      ? "Multiple slabsngrabsaco-hits channels are visible to the bot."
      : "The slabsngrabsaco-hits channel is not visible to the bot.");
  }
  discordHitsChannelIdCache = found[0];
  return found[0];
}

function publicDiscordHitPayload(order) {
  const items = (Array.isArray(order?.items) ? order.items : [])
    .map(item => ({
      name: publicSuccessProductName(item?.name),
      quantity: Math.max(1, Math.floor(Number(item?.quantity) || 1)),
      sourceQuantity: clean(item?.sourceQuantity, 30),
      sourcePrice: clean(item?.sourcePrice, 30),
      price: Math.max(0, Number(item?.price) || 0)
    }))
    .filter(item => item.name &&
      !/@|\b(?:order|address|phone|email|account|password|card|ship(?:ping)? to|username|mode)\b/i.test(item.name));

  if (!items.length) return null;

  const site = clean(order?.sourceSite, 200) ||
    (order?.retailer === "PKC" ? "Pokemon Center US" : clean(order?.retailer, 200) || "Retailer");

  const fields = [{ name: "Site", value: site.slice(0, 1024), inline: false }];

  items.slice(0, 9).forEach((item, index) => {
    const number = index + 1;
    const suffix = items.length === 1 ? " (1)" : ` (${number})`;
    const price = item.sourcePrice || item.price.toFixed(2);
    const quantity = item.sourceQuantity || String(item.quantity);
    fields.push(
      { name: `Product${suffix}`, value: item.name.slice(0, 1024), inline: false },
      { name: `Price${suffix}`, value: String(price).slice(0, 1024), inline: false },
      { name: `Quantity${suffix}`, value: String(quantity).slice(0, 1024), inline: false }
    );
  });

  return {
    embeds: [{
      title: "Successful Checkout!",
      color: 0x00ff00,
      fields: fields.slice(0, 25)
    }],
    allowed_mentions: { parse: [] }
  };
}

async function postDiscordHit(token, channelId, order) {
  const payload = publicDiscordHitPayload(order);
  if (!payload) return null;
  return discordBotJson(token, `/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function clearBotHitMessages(token, channelId) {
  const me = await discordBotJson(token, "/users/@me");
  let before = "";
  for (let page = 0; page < 10; page++) {
    const messages = await discordBotJson(token,
      `/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ""}`);
    if (!Array.isArray(messages) || !messages.length) break;
    for (const message of messages) {
      const generatedCheckout = String(message.author?.id || "") === String(me.id) &&
        (message.embeds || []).some(embed => String(embed?.title || "").trim() === "Successful Checkout!");
      if (!generatedCheckout) continue;
      await discordBotJson(token, `/channels/${channelId}/messages/${message.id}`, { method: "DELETE" });
    }
    if (messages.length < 100) break;
    before = messages[messages.length - 1].id;
  }
}

// Checkout mirroring to #slabsngrabsaco-hits is intentionally disabled.
// Keep the source webhook/site reconciliation active, but never create hit posts.
// The cleanup is idempotent and removes only checkout messages generated by this bot.
async function mirrorDiscordCheckoutHits(imports, token) {
  if (!token || !Array.isArray(imports) || !imports.length) return;

  await discordHitMirrorState(async () => {
    const hitsChannelId = await resolveDiscordHitsChannelId(token);
    let state = await readJson(DISCORD_HIT_MIRROR_FILE, {});

    const explicitSourceChannelId =
      String(process.env.DISCORD_CHECKOUT_SOURCE_CHANNEL_ID || "").trim();

    const validImports = imports
      .filter(entry =>
        /^\d{17,22}$/.test(String(entry?.sourceMessageId || "")) &&
        /^\d{17,22}$/.test(String(entry?.sourceChannelId || "")) &&
        entry?.order
      );

    if (!validImports.length) return;

    const newestImport = [...validImports].sort((a, b) => {
      const at = new Date(a.order.checkoutAt || 0).getTime();
      const bt = new Date(b.order.checkoutAt || 0).getTime();
      if (at !== bt) return bt - at;
      return BigInt(b.sourceMessageId) > BigInt(a.sourceMessageId) ? 1 : -1;
    })[0];

    const sourceChannelId =
      /^\d{17,22}$/.test(explicitSourceChannelId)
        ? explicitSourceChannelId
        : String(state.sourceChannelId || newestImport.sourceChannelId);

    const sourceImports = validImports
      .filter(entry => String(entry.sourceChannelId) === sourceChannelId);

    if (!sourceImports.length) return;

    const uniqueBySource = new Map();
    for (const entry of sourceImports) {
      const id = String(entry.sourceMessageId);
      if (!uniqueBySource.has(id)) uniqueBySource.set(id, entry);
    }

    const orderedNewestFirst = [...uniqueBySource.values()].sort((a, b) => {
      const ai = BigInt(a.sourceMessageId);
      const bi = BigInt(b.sourceMessageId);
      return ai === bi ? 0 : (ai > bi ? -1 : 1);
    });

    if (Number(state.version || 0) !== DISCORD_HIT_MIRROR_VERSION ||
        state.sourceChannelId !== sourceChannelId ||
        !Array.isArray(state.baselineIds)) {
      await clearBotHitMessages(token, hitsChannelId);

      const baseline = orderedNewestFirst.slice(0, 11).reverse();
      state = {
        version: DISCORD_HIT_MIRROR_VERSION,
        sourceChannelId,
        initializedAt: new Date().toISOString(),
        baselineIds: baseline.map(entry => String(entry.sourceMessageId)),
        baselineMaxId: baseline.length
          ? String(baseline.reduce((max, entry) =>
              BigInt(entry.sourceMessageId) > BigInt(max) ? entry.sourceMessageId : max,
              baseline[0].sourceMessageId))
          : null,
        sent: {}
      };
      await writeJson(DISCORD_HIT_MIRROR_FILE, state);
    }

    if (!state.sent || typeof state.sent !== "object" || Array.isArray(state.sent)) {
      state.sent = {};
    }

    // Complete the fixed 11-message baseline first. Each source ID is
    // permanently reserved before POST so retries cannot duplicate it.
    for (const sourceMessageId of state.baselineIds || []) {
      if (state.sent[sourceMessageId]) continue;
      const entry = uniqueBySource.get(sourceMessageId);
      if (!entry) continue;

      state.sent[sourceMessageId] = {
        messageId: "",
        sourceChannelId,
        checkoutAt: entry.order.checkoutAt || null,
        posting: true
      };
      await writeJson(DISCORD_HIT_MIRROR_FILE, state);

      const posted = await postDiscordHit(token, hitsChannelId, entry.order);
      if (!posted) continue;

      state.sent[sourceMessageId] = {
        messageId: String(posted.id || ""),
        sourceChannelId,
        checkoutAt: entry.order.checkoutAt || null
      };
      await writeJson(DISCORD_HIT_MIRROR_FILE, state);
    }

    const baselineMaxId = state.baselineMaxId && /^\d{17,22}$/.test(String(state.baselineMaxId))
      ? BigInt(state.baselineMaxId)
      : null;

    if (baselineMaxId === null) return;

    // Strict one-to-one live mirror:
    // one new source message ID after the baseline => one public hit message.
    const future = [...uniqueBySource.values()]
      .filter(entry => BigInt(entry.sourceMessageId) > baselineMaxId)
      .sort((a, b) =>
        BigInt(a.sourceMessageId) === BigInt(b.sourceMessageId)
          ? 0
          : (BigInt(a.sourceMessageId) < BigInt(b.sourceMessageId) ? -1 : 1)
      );

    for (const entry of future) {
      const sourceMessageId = String(entry.sourceMessageId);
      if (state.sent[sourceMessageId]) continue;

      state.sent[sourceMessageId] = {
        messageId: "",
        sourceChannelId,
        checkoutAt: entry.order.checkoutAt || null,
        posting: true
      };
      await writeJson(DISCORD_HIT_MIRROR_FILE, state);

      const posted = await postDiscordHit(token, hitsChannelId, entry.order);
      if (!posted) continue;

      state.sent[sourceMessageId] = {
        messageId: String(posted.id || ""),
        sourceChannelId,
        checkoutAt: entry.order.checkoutAt || null
      };
      await writeJson(DISCORD_HIT_MIRROR_FILE, state);
    }
  });
}

function discordCheckoutIdentity(message) {
  const fields = (message.embeds || []).flatMap(embed => embed.fields || []);
  const value = pattern => String(fields.find(field => pattern.test(String(field.name).replace(/[*_`]/g, '').trim()))?.value || '').replace(/[*_`|]/g, '').trim();
  return {
    orderNumber: clean(value(/^order\s*(id|number|#)$/i).replace(/^#/, ''), 150),
    email: normalizeEmail(value(/^(email|account email|checkout email|account)$/i)),
    profileName: clean(value(/^profile(?: name)?$/i), 100)
  };
}

async function discordCheckoutOwners() {
  const [profiles, paid, managed, assignments] = await Promise.all([
    getRetailerProfiles(), readJson(PAID_FILE, []), getManagedAccounts(), managedAssignmentHistory()
  ]);
  const candidates = [];
  for (const profile of profiles) {
    let credentials = {};
    try { credentials = normalizeRetailerCredentials(decryptJson(profile.credentials)); } catch { continue; }
    for (const [key, login] of Object.entries(credentials)) {
      if (!login?.username) continue;
      candidates.push({ customerAccountId: profile.customerAccountId, retailer: normalizeSuccessRetailer(key),
        email: normalizeEmail(login.username), profileName: profile.profileName, profileSlot: profile.slot });
    }
  }
  // Primary ACO profile email is also used by guest checkouts.
  for (const order of Array.isArray(paid) ? paid : []) {
    if (!order.customerAccountId) continue;
    candidates.push({ customerAccountId: order.customerAccountId, email: normalizeEmail(order.profile?.email),
      profileName: order.profile?.profileName, profileSlot: order.profile?.slot, createdAt: order.createdAt });
  }
  for (const account of managed) {
    let credentials = {};
    try { credentials = normalizeRetailerCredentials(decryptJson(account.credentials)); } catch { continue; }
    for (const assignment of assignments.filter(item => String(item.managedAccountId) === String(account.id))) {
      for (const [key, login] of Object.entries(credentials)) {
        if (!login?.username) continue;
        candidates.push({ customerAccountId: assignment.customerAccountId, retailer: normalizeSuccessRetailer(key),
          email: normalizeEmail(login.username), profileName: account.profileName,
          managedAccountId: account.id, managedAssignmentId: assignment.id,
          managedAssignmentType: assignment.assignmentType, assignment });
      }
    }
  }
  return candidates;
}

function discordCheckoutAttribution(order, identity, candidates) {
  const eligible = candidates.filter(item => item.customerAccountId &&
    (!item.retailer || item.retailer === order.retailer) &&
    (!item.assignment || assignmentTimeContainsCheckout(item.assignment, order.checkoutAt)) &&
    (!item.createdAt || new Date(item.createdAt) <= new Date(order.checkoutAt)));
  const byEmail = identity.email ? eligible.filter(item => item.email === identity.email) : [];
  const byName = identity.profileName ? eligible.filter(item =>
    String(item.profileName || '').toLowerCase() === identity.profileName.toLowerCase()) : [];
  const match = uniqueCheckoutOwner(byEmail.length ? byEmail : byName);
  if (!match) return null;
  // Only attribution IDs and display labels enter the Success store, never credentials.
  return Object.fromEntries(['customerAccountId', 'profileName', 'profileSlot', 'managedAccountId',
    'managedAssignmentId', 'managedAssignmentType'].filter(key => match[key] != null).map(key => [key, match[key]]));
}

let discordSuccessScanQueued = false;

function queueDiscordSuccessScan(delay = 75) {
  if (discordSuccessScanQueued) return;
  discordSuccessScanQueued = true;

  const timer = setTimeout(async () => {
    discordSuccessScanQueued = false;

    if (discordSuccessScan.running) {
      queueDiscordSuccessScan(350);
      return;
    }

    await scanDiscordSuccessChannel();
  }, Math.max(0, Number(delay) || 0));

  timer.unref?.();
}

async function scanDiscordSuccessChannel() {
  if (discordSuccessScan.running) return false;
  discordSuccessScan.running = true;
  discordSuccessScan.error = null;
  let added = 0, updated = 0, attributed = 0, skipped = 0, before = "", newest = null;
  try {
    const { token, channels, webhookSourceFound } = await discordCheckoutSourceChannels();
    if (!token || !channels.length) throw new Error('Checkout source channel is not configured.');
    discordSuccessScan.sourceChannels = channels;
    discordSuccessScan.webhookSourceFound = webhookSourceFound ?? true;
    const candidates = await discordCheckoutOwners();
    await refreshSuccessRetailerImages();
    const imports = [];
    for (const channelId of channels) {
      before = '';
      for (let page = 0; page < 10; page++) {
      const url = `https://discord.com/api/v10/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ""}`;
      const response = await fetch(url, { headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Discord channel read failed (HTTP ${response.status}).`);
      const messages = await response.json();
      if (!Array.isArray(messages) || !messages.length) break;
      if (!newest) newest = String(messages[0].id);
      for (const message of messages) {
        const order = discordCheckoutFromMessage(message, channelId);
        if (!order) { skipped++; continue; }
        order.items = order.items.map(item => ({ ...item,
          imageUrl: publicSuccessProductImage(item.name, order.retailer, item.imageUrl) }));
        imports.push({
          order,
          sourceChannelId: String(channelId),
          sourceMessageId: String(message.id),
          attribution: discordCheckoutAttribution(order, discordCheckoutIdentity(message), candidates)
        });
      }
      if (messages.length < 100) break;
      before = messages[messages.length - 1].id;
      }
    }
    await withSuccessStoreLock(async () => {
      const existing = await getSuccessCheckouts();
      const original = JSON.stringify(existing);
      for (const { order, attribution } of imports.reverse()) {
        const result = reconcileWebhookCheckout(existing, order, attribution);
        if (!result.changed) { skipped++; continue; }
        if (result.added) added++; else updated++;
        if (result.record.customerAccountId) attributed++;
      }
      if (added || updated) {
        // Keep a restorable snapshot before correcting existing checkout values.
        if (updated) await fs.writeFile(path.join(DATA_DIR, 'success-before-webhook-reconciliation.json'), original, { flag: 'wx', mode: 0o600 }).catch(error => {
          if (error.code !== 'EEXIST') throw error;
        });
        await saveSuccessCheckouts(existing);
        for (const accountId of new Set(existing.map(record => record.customerAccountId).filter(Boolean))) announceSuccessCheckout(accountId);
        if (!attributed) for (const listener of publicSuccessListeners) listener.write("event: checkout\ndata: {}\n\n");
        broadcastLiveDataChange("discord-success");
      }
    });
    await mirrorDiscordCheckoutHits(imports, token).catch(error => {
      console.error("Discord hits mirror failed:", error?.message || error?.code || "discord_hits_mirror_error");
      discordSuccessScan.hitsError = error?.message || "Discord hits mirror failed.";
    });
    discordSuccessScan.added = added;
    discordSuccessScan.updated = updated;
    discordSuccessScan.attributed = attributed;
    discordSuccessScan.skipped = skipped;
    discordSuccessScan.checkedAt = new Date().toISOString();
    discordSuccessScan.newestMessageId = newest;
    console.log('Discord checkout reconciliation completed:', JSON.stringify({ added, updated, attributed, skipped }));
    return true;
  } catch (error) {
    console.error('Discord checkout reconciliation failed:', error?.code || error?.message);
    discordSuccessScan.error = error.message;
    discordSuccessScan.checkedAt = new Date().toISOString();
    return false;
  } finally {
    discordSuccessScan.running = false;
  }
}

app.get("/api/admin/discord-success-status", requireAdmin, async (_req, res) => {
  const config = await resolvedDiscordSuccessConfig();
  const validChannelId = /^\d{17,22}$/.test(config.channelId);
  res.json({
    configured: Boolean(config.token && validChannelId),
    source: config.source || null,
    configurationError: config.channelId && !validChannelId
      ? config.lookupError || "DISCORD_SUCCESS_CHANNEL_ID must be a numeric channel ID or a valid Discord webhook URL."
      : null,
    channelId: validChannelId ? config.channelId : null,
    ...discordSuccessScan,
    community: discordCommunityStatus
  });
});
app.post("/api/admin/discord-success-scan", requireAdmin, async (_req, res) => {
  const { token, channelId } = await resolvedDiscordSuccessConfig();
  if (!token || !/^\d{17,22}$/.test(channelId)) {
    return res.status(400).json({ error: "Set DISCORD_BOT_TOKEN and a numeric channel ID or valid Discord webhook URL in Render first." });
  }
  if (discordSuccessScan.running) return res.status(409).json({ error: "Discord scan is already running." });
  const ok = await scanDiscordSuccessChannel();
  res.status(ok ? 200 : 502).json({ ok, ...discordSuccessScan });
});

// Notify open dashboards immediately after a confirmed checkout is saved.
const publicSuccessListeners = new Set();
const customerSuccessListeners = new Map();

function openSuccessEventStream(req, res, listeners) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(": connected\n\n");
  listeners.add(res);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 25000);
  req.on("close", () => {
    clearInterval(heartbeat);
    listeners.delete(res);
  });
}

function announceSuccessCheckout(accountId) {
  for (const res of publicSuccessListeners) res.write("event: checkout\ndata: {}\n\n");
  for (const res of customerSuccessListeners.get(String(accountId)) || []) {
    res.write("event: checkout\ndata: {}\n\n");
  }
}

app.get("/api/public/success/events", (req, res) => {
  openSuccessEventStream(req, res, publicSuccessListeners);
});

app.get("/api/account/success/events", requireCustomer, (req, res) => {
  const accountId = String(req.customerAccount.id);
  if (!customerSuccessListeners.has(accountId)) customerSuccessListeners.set(accountId, new Set());
  const listeners = customerSuccessListeners.get(accountId);
  openSuccessEventStream(req, res, listeners);
  req.on("close", () => {
    if (!listeners.size) customerSuccessListeners.delete(accountId);
  });
});

app.get("/api/account/live/events", requireCustomer, (req, res) => {
  openSuccessEventStream(req, res, customerLiveDataListeners);
});

app.get("/api/admin/live/events", requireAdmin, (req, res) => {
  openSuccessEventStream(req, res, adminLiveDataListeners);
});

function isPublicSuccessProduct(name) {
  return /pok[eé]mon|lorcana|magic\s*[:\-]?\s*the\s*gathering|\bmtg\b|nee[\s-]?doh|trading\s*card|\btcg\b|yu[\s-]?gi[\s-]?oh|one\s*piece\s*(?:card|tcg)|digimon|flesh\s*and\s*blood|dragon\s*ball\s*(?:card|tcg)/i.test(name);
}

function publicSuccessProductName(value) {
  return clean(value, 120)
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_match, code) => {
      const point = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
      return point > 31 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
    })
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ").trim();
}

const verifiedPublicProductImages = [
  { match: /ascended heroes tin.*mega f(?:eraligatr|raligatr) ex/i, retailer: "Target",
    imageUrl: "https://target.scene7.com/is/image/Target/GUEST_9e3e1626-502a-42d0-b3eb-e8901ae0d162" },
  { match: /30th celebration tin/i, retailer: "Target",
    imageUrl: "https://target.scene7.com/is/image/Target/GUEST_d9d7ff82-a91c-4587-9dac-b9aaa88e8b33" },
  { match: /first partner illustration.*series 3/i, retailer: "Target",
    imageUrl: "https://target.scene7.com/is/image/Target/GUEST_8b8616a3-c1cb-4db9-9821-c6514376f967" },
  { match: /30th celebration.*sylveon ex box/i, retailer: "Target",
    imageUrl: "https://target.scene7.com/is/image/Target/GUEST_65085291-1d03-4b66-8c88-729c7ac7b66b" },

  { match: /delta reign.*elite trainer box/i, retailer: "PKC",
    imageUrl: "https://www.pokemoncenter.com/images/DAMRoot/High/10060/P11222_10-10438-112_01.jpg" },
  { match: /delta reign.*booster (?:display )?box/i, retailer: "PKC",
    imageUrl: "https://www.pokemoncenter.com/images/DAMRoot/High/10060/P11222_10-10446-120_01.jpg" },
  { match: /delta reign.*booster bundle/i, retailer: "PKC",
    imageUrl: "https://www.pokemoncenter.com/images/DAMRoot/High/10060/P11222_10-10439-109_01.jpg" },
  { match: /ascended heroes tin.*mega emboar ex/i, retailer: "Target",
    imageUrl: "https://target.scene7.com/is/image/Target/GUEST_bcb2529f-51fb-4b09-88a0-a1bcc00ee5d2" },

  {
    match: /30th celebration.*elite trainer box/i,
    retailer: "Target",
    imageUrl: "https://target.scene7.com/is/image/Target/GUEST_40ed4d44-2adc-4cfe-a27b-0ce8b6e73cba"
  },
  {
    match: /ascended heroes tin.*mega meganium ex/i,
    retailer: "Target",
    imageUrl: "https://target.scene7.com/is/image/Target/GUEST_d4830c25-748f-4052-ac1e-f87293a37d7c"
  }
];

const successRetailerCatalog = [
  { key: 'delta-reign-pkc-etb', match: /delta reign.*elite trainer box/i, retailer: 'PKC',
    productUrl: 'https://www.pokemoncenter.com/product/10-10438-112' },
  { key: 'delta-reign-bundle', match: /delta reign.*booster bundle/i, retailer: 'PKC',
    productUrl: 'https://www.pokemoncenter.com/product/10-10439-109' },
  { key: 'delta-reign-display', match: /delta reign.*booster (?:display )?box/i, retailer: 'PKC',
    productUrl: 'https://www.pokemoncenter.com/product/10-10446-120' }
];
let successRetailerImages = {};
let lastSuccessRetailerImageRefresh = 0;
function isRetailerStockImage(value, retailer) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      (retailer === 'PKC' ? /(^|\.)pokemoncenter\.com$/.test(url.hostname)
        : retailer === 'Target' ? url.hostname === 'target.scene7.com' : false);
  } catch { return false; }
}
async function refreshSuccessRetailerImages() {
  if (Date.now() - lastSuccessRetailerImageRefresh < 60 * 60 * 1000) return;
  lastSuccessRetailerImageRefresh = Date.now();
  successRetailerImages = await readJson(path.join(DATA_DIR, 'success-retailer-images.json'), {});
  const records = await getSuccessCheckouts();
  for (const product of successRetailerCatalog) {
    if (successRetailerImages[product.key]) continue;
    // Use stock assets already supplied in retailer confirmations when available.
    for (const record of records.filter(record => record.retailer === product.retailer)) {
      const item = (record.items || []).find(item => product.match.test(item.name) && isRetailerStockImage(item.imageUrl, product.retailer));
      if (item) { successRetailerImages[product.key] = publicSuccessImageUrl(item.imageUrl); break; }
    }
    if (successRetailerImages[product.key]) continue;
    try {
      const response = await fetch(product.productUrl, { signal: AbortSignal.timeout(8000), redirect: 'error' });
      if (!response.ok) continue;
      const html = await response.text();
      for (const tag of html.match(/<meta\b[^>]+>/gi) || []) {
        if (!/\b(?:property|name)=["']og:image["']/i.test(tag)) continue;
        const image = tag.match(/\bcontent=["']([^"']+)["']/i)?.[1]?.replace(/&amp;/g, '&');
        if (isRetailerStockImage(image, product.retailer)) successRetailerImages[product.key] = publicSuccessImageUrl(image);
      }
    } catch { /* The retailer may temporarily restrict public metadata access. */ }
  }
  await writeJson(path.join(DATA_DIR, 'success-retailer-images.json'), successRetailerImages);
  console.log('Success retailer stock images:', JSON.stringify({ available: Object.keys(successRetailerImages).length, expected: successRetailerCatalog.length }));
}

function publicSuccessProductImage(name, retailer, value) {
  const catalog = successRetailerCatalog.find(item => item.retailer === retailer && item.match.test(name));
  const verified = verifiedPublicProductImages.find(item =>
    item.retailer.toLowerCase() === String(retailer || "").toLowerCase() && item.match.test(name)
  );
  if (verified) return verified.imageUrl;
  if (catalog && successRetailerImages[catalog.key]) return successRetailerImages[catalog.key];
  const url = publicSuccessImageUrl(value);
  return url && !/\/gray-bag(?:[?/#]|$)|\/no[-_]?image(?:[?/#]|$)/i.test(url) ? url : null;
}

function publicSuccessImageUrl(value) {
  const safe = safeSuccessImageUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  if (url.username || url.password) return null;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/* Public totals contain only aggregate values and product counts. */
app.get(
  "/api/public/success",
  async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");

    try {
      const records =
        visibleDiscordSuccessRecords(
          await getSuccessCheckouts()
        );
      const products = new Map();
      let totalSpent = 0;
      let totalCheckouts = 0;

      for (const record of records) {
        if (!/^(confirmed|success|completed)$/i.test(String(record.status || "confirmed"))) continue;
        const eligibleItems = (Array.isArray(record.items) ? record.items : []).filter(item => {
          const name = publicSuccessProductName(item?.name);
          return name && isPublicSuccessProduct(name) && !/@|\b(?:order|address|phone|email|account|ship(?:ping)? to)\b|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/i.test(name) && Number(item?.quantity) > 0;
        });
        totalCheckouts += 1;
        const total = Number(record.orderTotal);
        if (Number.isFinite(total) && total > 0) totalSpent += total;

        const purchasedAt = new Date(record.checkoutAt || record.updatedAt || record.createdAt || 0).getTime();
        for (const item of eligibleItems) {
          const name = publicSuccessProductName(item?.name);
          const quantity = Math.max(0, Math.floor(Number(item?.quantity) || 0));
          if (!quantity) continue;
          const key = name.toLowerCase();
          const prior = products.get(key);
          products.set(key, {
            name: prior?.name || name,
            quantity: (prior?.quantity || 0) + quantity,
            imageUrl: prior?.imageUrl || publicSuccessProductImage(name, record.retailer, item?.imageUrl),
            latestPurchasedAt: Math.max(prior?.latestPurchasedAt || 0, Number.isFinite(purchasedAt) ? purchasedAt : 0)
          });
        }
      }

      const orderedProducts = [...products.values()]
        .sort((a, b) =>
          b.latestPurchasedAt - a.latestPurchasedAt ||
          b.quantity - a.quantity ||
          a.name.localeCompare(b.name)
        )
        .map(({ latestPurchasedAt, ...product }) => product);

      res.json({
        totalCheckouts,
        totalSpent: Math.round(totalSpent * 100) / 100,
        products: orderedProducts
      });
    } catch (error) {
      console.error("Public Success totals failed:", error?.code || error?.name || "success_totals_error");
      res.status(503).json({ error: "Checkout totals are temporarily unavailable." });
    }
  }
);

async function saveSuccessCheckouts(
  records
) {
  await writeJson(
    SUCCESS_CHECKOUTS_FILE,
    records
  );
}


async function recordSuccessCheckout(
  record,
  { notifyDiscord = true } = {}
) {
  return withSuccessStoreLock(() => recordSuccessCheckoutUnlocked(record, { notifyDiscord }));
}

let successStoreMutation = Promise.resolve();
function withSuccessStoreLock(operation) {
  const result = successStoreMutation.then(operation);
  successStoreMutation = result.catch(() => {});
  return result;
}

async function recordSuccessCheckoutUnlocked(record, { notifyDiscord = true } = {}) {
  const safeRecord =
    safeSuccessCheckout(
      record
    );

  if (
    !safeRecord.id ||
    !record?.customerAccountId
  ) {
    throw new Error(
      "Success checkout record is missing its ID or customer account."
    );
  }

  const records =
    await getSuccessCheckouts();

  const duplicate = records.find(item => sameCheckout(item, safeRecord));

  if (duplicate) {
    if (!duplicate.customerAccountId) {
      duplicate.customerAccountId = String(record.customerAccountId);
      for (const key of ['profileName', 'profileSlot', 'managedAccountId', 'managedAssignmentId', 'managedAssignmentType']) {
        if (record[key] != null) duplicate[key] = record[key];
      }
      duplicate.sourceIds = [...new Set([...(duplicate.sourceIds || []), safeRecord.id])];
      await saveSuccessCheckouts(records);
      announceSuccessCheckout(duplicate.customerAccountId);
    }
    return false;
  }

  const storedRecord = {
    ...safeRecord,

    customerAccountId:
      String(
        record.customerAccountId
      ),

    /*
      Immutable attribution snapshot.
      Once an order is written to Success, reassigning the
      managed profile later never moves this old checkout.
    */
    managedAccountId:
      record.managedAccountId
        ? String(
            record.managedAccountId
          )
        : null,

    managedAssignmentId:
      record.managedAssignmentId
        ? String(
            record.managedAssignmentId
          )
        : null,

    managedAssignmentType:
      record.managedAssignmentType
        ? String(
            record.managedAssignmentType
          )
        : null
  };

  records.push(
    storedRecord
  );

  await saveSuccessCheckouts(
    records
  );

  announceSuccessCheckout(storedRecord.customerAccountId);

  if (notifyDiscord) {
    try {
      await sendDiscordSuccessNotification(storedRecord);
    } catch (error) {
      console.error("Discord success notification failed:", error.message);
    }
  }

  return true;
}

/* Orders in the business mailbox without a customer assignment contribute
   anonymous checkout totals. Only eligible product names enter the carousel. */
async function recordCommunitySuccessCheckout(order) {
  return withSuccessStoreLock(() => recordCommunitySuccessCheckoutUnlocked(order));
}
async function recordCommunitySuccessCheckoutUnlocked(order) {
  const items = (Array.isArray(order?.items) ? order.items : [])
    .filter(item => {
      const name = clean(item?.name, 120).replace(/\s+/g, " ").trim();
      return name && isPublicSuccessProduct(name) &&
        !/@|\b(?:order|address|phone|email|account|ship(?:ping)? to)\b|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/i.test(name) &&
        Number(item?.quantity) > 0;
    })
    .map(item => ({
      name: clean(item.name, 120),
      quantity: Math.max(1, Math.floor(Number(item.quantity))),
      imageUrl: publicSuccessImageUrl(item.imageUrl)
    }));
  const sourceId = String(order.messageId || order.mailboxUid || order.orderNumber || "");
  if (!sourceId) return false;
  const id = `community-mailbox:${crypto.createHash("sha256")
    .update(`${managedSuccessMailboxConfig().email}:${sourceId}`)
    .digest("hex")}`;
  const records = await getSuccessCheckouts();
  const original = JSON.stringify(records);
  const backfilled = reconcileEmailCheckoutIdentity(records, {
    id, retailer: normalizeSuccessRetailer(order.retailer), orderNumber: clean(order.orderNumber, 150)
  });
  if (backfilled.changed) {
    await fs.writeFile(path.join(DATA_DIR, 'success-before-email-order-backfill.json'), original, { flag: 'wx', mode: 0o600 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    await saveSuccessCheckouts(records);
    for (const res of publicSuccessListeners) res.write("event: checkout\ndata: {}\n\n");
    return true;
  }
  if (records.some(record => sameCheckout(record, { ...order, id, retailer: normalizeSuccessRetailer(order.retailer) }))) return false;

  records.push({
    id,
    customerAccountId: null,
    retailer: normalizeSuccessRetailer(order.retailer),
    orderNumber: clean(order.orderNumber, 150),
    checkoutAt: order.checkoutAt || order.date || null,
    orderTotal: Math.max(0, Number(order.orderTotal) || 0),
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    items: items.map(item => ({ ...item, imageUrl: publicSuccessProductImage(item.name, normalizeSuccessRetailer(order?.retailer), item.imageUrl) })),
    status: "confirmed"
  });
  await saveSuccessCheckouts(records);
  for (const res of publicSuccessListeners) res.write("event: checkout\ndata: {}\n\n");
  return true;
}


function normalizeSuccessRetailer(
  value
) {
  const retailer =
    String(value || "")
      .trim()
      .toLowerCase();

  const retailers = {
    target: "Target",
    targetgo: "Target",
    walmart: "Walmart",
    walmartgo: "Walmart",
    "sam's club": "Sam's Club",
    "sams club": "Sam's Club",
    samsclub: "Sam's Club",
    costco: "Costco",
    pkc: "PKC",
    "pokemon center us": "PKC",
    "pokemon center": "PKC",
    pokemoncenter: "PKC"
  };

  return (
    retailers[retailer] ||
    clean(value, 80) ||
    "Retailer"
  );
}

function safeSuccessImageUrl(
  value
) {
  const raw =
    String(value || "")
      .trim();

  if (!raw) {
    return null;
  }

  try {
    const url =
      new URL(raw);

    if (
      url.protocol !== "https:"
    ) {
      return null;
    }

    return clean(
      url.toString(),
      2000
    );

  } catch {
    return null;
  }
}


function safeSuccessItem(item) {
  const quantity =
    Math.max(
      1,
      Math.floor(
        Number(
          item?.quantity || 1
        )
      )
    );

  const price =
    Number(
      item?.price || 0
    );

  const imageUrl =
    safeSuccessImageUrl(
      item?.imageUrl ||
      item?.image ||
      item?.productImage ||
      item?.thumbnail
    );

  return {
    name:
      clean(
        item?.name ||
        "Item",
        300
      ),

    quantity,

    price:
      Number.isFinite(price) &&
      price >= 0
        ? price
        : 0,

    imageUrl
  };
}

function safeSuccessCheckout(
  record
) {
  const total =
    Number(
      record?.orderTotal || 0
    );

  const items =
    Array.isArray(record?.items)
      ? record.items.map(item => {
          const safe = safeSuccessItem(item);
          return { ...safe, imageUrl: publicSuccessProductImage(safe.name, normalizeSuccessRetailer(record.retailer), safe.imageUrl) };
        })
      : [];

  let itemCount =
    Number(
      record?.itemCount
    );

  if (
    !Number.isFinite(itemCount) ||
    itemCount < 0
  ) {
    itemCount =
      items.reduce(
        (sum, item) =>
          sum +
          Number(
            item.quantity || 0
          ),
        0
      );
  }

  return {
    id:
      String(
        record?.id || ""
      ),

    retailer:
      normalizeSuccessRetailer(
        record?.retailer
      ),

    orderNumber:
      clean(
        record?.orderNumber,
        150
      ),

    profileSlot:
      Number.isInteger(
        Number(
          record?.profileSlot
        )
      )
        ? Number(
            record.profileSlot
          )
        : null,

    profileName:
      clean(
        record?.profileName,
        80
      ),

    checkoutAt:
      record?.checkoutAt ||
      record?.createdAt ||
      null,

    orderTotal:
      Number.isFinite(total) &&
      total >= 0
        ? total
        : 0,

    itemCount:
      Math.max(
        0,
        Math.floor(
          itemCount || 0
        )
      ),

    items,

    status:
      clean(
        record?.status ||
        "confirmed",
        50
      )
  };
}


async function sendDiscordSuccessNotification(
  record
) {
  const webhookUrl =
    String(
      process.env
        .DISCORD_SUCCESS_WEBHOOK_URL ||
      process.env
        .DISCORD_SNGACO_SUCCESS ||
      ""
    ).trim();

  if (!webhookUrl) {
    return false;
  }

  const safeRecord =
    safeSuccessCheckout(
      record
    );

  const items =
    Array.isArray(
      safeRecord.items
    )
      ? safeRecord.items
      : [];

  const itemLines =
    items.length
      ? items
          .slice(0, 10)
          .map(
            item =>
              `• ${item.name} ×${item.quantity}`
          )
          .join("\n")
      : "Purchase confirmed";

  const firstImage =
    items.find(
      item =>
        item.imageUrl
    )?.imageUrl ||
    null;

  const embed = {
    title:
      "NEW CHECKOUT SUCCESS",

    description:
      itemLines,

    color:
      1231359,

    fields: [
      {
        name:
          "Retailer",
        value:
          safeRecord.retailer ||
          "Retailer",
        inline:
          true
      },
      {
        name:
          "Quantity",
        value:
          String(
            safeRecord.itemCount ||
            items.reduce(
              (sum, item) =>
                sum +
                Number(
                  item.quantity ||
                  0
                ),
              0
            )
          ),
        inline:
          true
      },
      {
        name:
          "Order Value",
        value:
          `$${Number(
            safeRecord.orderTotal ||
            0
          ).toFixed(2)}`,
        inline:
          true
      }
    ],

    timestamp:
      safeRecord.checkoutAt ||
      new Date()
        .toISOString(),

    footer: {
      text:
        "SLABS N GRABS ACO • Personal customer information hidden"
    }
  };

  if (firstImage) {
    embed.image = {
      url:
        firstImage
    };
  }

  const response =
    await fetch(
      webhookUrl,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            username:
              "SLABS N GRABS ACO Success",

            embeds: [
              embed
            ],

            allowed_mentions: {
              parse: []
            }
          })
      }
    );

  if (!response.ok) {
    const detail =
      await response
        .text()
        .catch(
          () => ""
        );

    throw new Error(
      `Discord success webhook failed (${response.status}) ${detail.slice(0, 300)}`
    );
  }

  return true;
}





/* -------------------------------------------------------
   ADMIN MEMBERSHIP CANCELLATION DISCORD TEST
------------------------------------------------------- */

app.post(
  "/api/admin/test-cancellation-discord",
  requireAdmin,
  async (req, res) => {
    try {
      const configured =
        Boolean(
          String(
            process.env
              .DISCORD_ADMIN_PAYMENT_WEBHOOK_URL ||
            ""
          ).trim()
        );

      if (!configured) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "DISCORD_ADMIN_PAYMENT_WEBHOOK_URL is not configured."
          });
      }

      await sendDiscordAdminMembershipCancellationNotification(
        {
          id:
            "TEST-CANCELLATION",

          plan: {
            name:
              "Test Membership",
            profiles:
              5
          },

          profile: {
            firstName:
              "Test",
            lastName:
              "Customer",
            email:
              "test@example.com"
          }
        },
        {
          stage:
            "scheduled",

          reason:
            "Test cancellation notification.",

          endAt:
            new Date(
              Date.now() +
              30 *
              24 *
              60 *
              60 *
              1000
            ).toISOString()
        }
      );

      return res.json({
        ok: true,
        message:
          "Admin cancellation Discord test sent."
      });

    } catch (error) {
      console.error(
        "Admin cancellation Discord test failed:",
        error?.message ||
        "admin_cancellation_discord_test_error"
      );

      return res
        .status(502)
        .json({
          ok: false,
          error:
            "The cancellation Discord test could not be sent. Check the private admin webhook."
        });
    }
  }
);


/* -------------------------------------------------------
   ADMIN PAYMENT DISCORD TEST
   Sends a private admin payment fixture only.
------------------------------------------------------- */

app.post(
  "/api/admin/test-payment-discord",
  requireAdmin,
  async (req, res) => {
    try {
      const configured =
        Boolean(
          String(
            process.env
              .DISCORD_ADMIN_PAYMENT_WEBHOOK_URL ||
            ""
          ).trim()
        );

      if (!configured) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "DISCORD_ADMIN_PAYMENT_WEBHOOK_URL is not configured."
          });
      }

      await sendDiscordAdminPaymentNotification({
        paymentType:
          "Test payment",

        headline:
          "This is a test of the private admin payment webhook.",

        amount:
          45,

        profile: {
          firstName:
            "Test",
          lastName:
            "Customer",
          email:
            "test@example.com"
        },

        purchaseSummary:
          "Pro Membership — 5 profile(s) / month",

        orderId:
          "TEST-PAYMENT",

        profiles:
          5,

        paidAt:
          new Date()
            .toISOString()
      });

      return res.json({
        ok: true,
        message:
          "Admin payment Discord test sent."
      });

    } catch (error) {
      console.error(
        "Admin payment Discord test failed:",
        error?.message ||
        "admin_payment_discord_test_error"
      );

      return res
        .status(502)
        .json({
          ok: false,
          error:
            "The admin payment Discord test could not be sent. Check the webhook URL."
        });
    }
  }
);


/* -------------------------------------------------------
   ADMIN DISCORD SUCCESS TEST
   Sends a privacy-safe fixture only. It does not create
   a customer Success record.
------------------------------------------------------- */

app.post(
  "/api/admin/test-discord-success",
  requireAdmin,
  async (req, res) => {
    try {
      const configured =
        Boolean(
          String(
            process.env
              .DISCORD_SUCCESS_WEBHOOK_URL ||
            process.env
              .DISCORD_SNGACO_SUCCESS ||
            ""
          ).trim()
        );

      if (!configured) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "The Success Discord webhook is not configured."
          });
      }

      const sent =
        await sendDiscordSuccessNotification({
          id:
            `discord-test-${Date.now()}`,

          retailer:
            "Target",

          orderNumber:
            "TEST-ORDER",

          checkoutAt:
            new Date()
              .toISOString(),

          orderTotal:
            79.98,

          itemCount:
            2,

          items: [
            {
              name:
                "Discord Success Connection Test",
              quantity:
                2,
              price:
                39.99,
              imageUrl:
                null
            }
          ],

          status:
            "test"
        });

      if (!sent) {
        return res
          .status(500)
          .json({
            ok: false,
            error:
              "Discord webhook is not configured."
          });
      }

      return res.json({
        ok: true,
        message:
          "Discord test success was sent."
      });

    } catch (error) {
      console.error(
        "Discord success test failed:",
        error?.message ||
        "discord_test_error"
      );

      return res
        .status(502)
        .json({
          ok: false,
          error:
            "Discord test message could not be sent. Check the webhook URL."
        });
    }
  }
);


function successDateKey(
  value
) {
  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return null;
  }

  return date
    .toISOString()
    .slice(0, 10);
}

function buildSuccessActivity(
  records,
  startDate = null,
  endDate = null
) {
  const daily =
    new Map();

  for (
    const record of records
  ) {
    const key =
      successDateKey(
        record.checkoutAt
      );

    if (!key) {
      continue;
    }

    const existing =
      daily.get(key) || {
        count: 0,
        value: 0
      };

    existing.count += 1;

    existing.value +=
      Number(
        record.orderTotal || 0
      ) || 0;

    daily.set(
      key,
      existing
    );
  }

  const end =
    endDate
      ? new Date(
          `${endDate}T00:00:00.000Z`
        )
      : new Date();

  end.setUTCHours(
    0,
    0,
    0,
    0
  );

  const start =
    startDate
      ? new Date(
          `${startDate}T00:00:00.000Z`
        )
      : new Date(end);

  if (!startDate) {
    start.setUTCDate(
      end.getUTCDate() - 13
    );
  }

  start.setUTCHours(
    0,
    0,
    0,
    0
  );

  const activity = [];

  const cursor =
    new Date(start);

  while (
    cursor.getTime() <=
    end.getTime()
  ) {
    const key =
      cursor
        .toISOString()
        .slice(0, 10);

    const values =
      daily.get(key) || {
        count: 0,
        value: 0
      };

    activity.push({
      date: key,

      count:
        values.count,

      value:
        Number(
          values.value
            .toFixed(2)
        )
    });

    cursor.setUTCDate(
      cursor.getUTCDate() + 1
    );
  }

  return activity;
}

function buildSuccessSummary(
  records,
  startDate = null,
  endDate = null
) {
  const safeRecords =
    records.map(
      safeSuccessCheckout
    );

  const rangeRecords =
    safeRecords.filter(
      record => {
        const key =
          successDateKey(
            record.checkoutAt
          );

        if (!key) {
          return false;
        }

        if (
          startDate &&
          key < startDate
        ) {
          return false;
        }

        if (
          endDate &&
          key > endDate
        ) {
          return false;
        }

        return true;
      }
    );

  const totalCheckouts =
    rangeRecords.length;

  const totalItems =
    rangeRecords.reduce(
      (sum, record) =>
        sum +
        Number(
          record.itemCount || 0
        ),
      0
    );

  const checkoutValue =
    rangeRecords.reduce(
      (sum, record) =>
        sum +
        Number(
          record.orderTotal || 0
        ),
      0
    );

  const dailyCounts =
    new Map();

  for (
    const record of rangeRecords
  ) {
    const key =
      successDateKey(
        record.checkoutAt
      );

    if (!key) {
      continue;
    }

    dailyCounts.set(
      key,
      (
        dailyCounts.get(key) ||
        0
      ) + 1
    );
  }

  const bestDay =
    dailyCounts.size
      ? Math.max(
          ...dailyCounts.values()
        )
      : 0;

  const recentCheckouts =
    [...rangeRecords]
      .sort(
        (a, b) =>
          new Date(
            b.checkoutAt || 0
          ).getTime() -
          new Date(
            a.checkoutAt || 0
          ).getTime()
      )
      .slice(
        0,
        20
      );

  return {
    totalCheckouts,

    totalItems,

    checkoutValue:
      Number(
        checkoutValue
          .toFixed(2)
      ),

    bestDay,

    activity:
      buildSuccessActivity(
        safeRecords,
        startDate,
        endDate
      ),

    recentCheckouts
  };
}

/* -------------------------------------------------------
   TEMPORARY ADMIN MAILBOX READER
   Reads sanitized metadata only.
   Remove after mailbox integration is verified.
------------------------------------------------------- */

async function readRecentTestMailboxMessages(
  email,
  password,
  limit = 20
) {
  const {
    provider,
    client
  } =
    createCustomerImapClient(
      email,
      password
    );

  try {
    await client.connect();

    const lock =
      await client.getMailboxLock(
        "INBOX",
        {
          readOnly: true
        }
      );

    try {
      const totalMessages =
        Number(
          client.mailbox?.exists || 0
        );

      if (totalMessages === 0) {
        return {
          provider:
            provider.name,

          totalMessages: 0,

          messages: []
        };
      }

      const safeLimit =
        Math.min(
          Math.max(
            Number(limit) || 20,
            1
          ),
          50
        );

      const startSequence =
        Math.max(
          1,
          totalMessages -
            safeLimit +
            1
        );

      const messages =
        await client.fetchAll(
          `${startSequence}:*`,
          {
            uid: true,
            envelope: true,
            internalDate: true,
            size: true
          }
        );

      const sanitized =
        messages
          .map(message => {
            const envelope =
              message.envelope || {};

            const from =
              Array.isArray(
                envelope.from
              )
                ? envelope.from
                    .map(sender =>
                      String(
                        sender?.address ||
                        ""
                      )
                        .trim()
                        .toLowerCase()
                    )
                    .filter(Boolean)
                : [];

            return {
              uid:
                Number(
                  message.uid || 0
                ),

              messageId:
                String(
                  envelope.messageId ||
                  ""
                ).slice(0, 500),

              from,

              subject:
                String(
                  envelope.subject ||
                  ""
                ).slice(0, 500),

              date:
                (
                  envelope.date ||
                  message.internalDate
                )
                  ? new Date(
                      envelope.date ||
                      message.internalDate
                    ).toISOString()
                  : null,

              size:
                Number(
                  message.size || 0
                )
            };
          })
          .reverse();

      return {
        provider:
          provider.name,

        totalMessages,

        messages:
          sanitized
      };

    } finally {
      lock.release();
    }

  } finally {
    if (client.usable) {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    } else {
      client.close();
    }
  }
}


/* -------------------------------------------------------
   TEMPORARY ADMIN MAILBOX READER ENDPOINT
------------------------------------------------------- */

app.get(
  "/api/admin/test-imap/messages",
  requireAdmin,
  async (req, res) => {
    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    try {
      const testEmail =
        normalizeEmail(
          process.env.IMAP_TEST_EMAIL
        );

      const testPassword =
        String(
          process.env.IMAP_TEST_PASSWORD ||
          ""
        );

      if (
        !testEmail ||
        !testPassword
      ) {
        return res
          .status(500)
          .json({
            ok: false,

            error:
              "Test mailbox environment variables are not configured."
          });
      }

      const result =
        await readRecentTestMailboxMessages(
          testEmail,
          testPassword,
          20
        );

      return res.json({
        ok: true,

        provider:
          result.provider,

        totalMessages:
          result.totalMessages,

        returned:
          result.messages.length,

        messages:
          result.messages
      });

    } catch (error) {
      /*
        Never return raw provider errors.
        Provider responses can contain
        mailbox information.
      */

      if (
        error?.code ===
        "UNSUPPORTED_PROVIDER"
      ) {
        return res
          .status(400)
          .json({
            ok: false,

            error:
              "This test mailbox provider is not supported."
          });
      }

      if (
        error instanceof
          AuthenticationFailure ||
        error?.authenticationFailed ===
          true ||
        error?.code ===
          "AUTHENTICATIONFAILED"
      ) {
        return res
          .status(401)
          .json({
            ok: false,

            error:
              "Test mailbox authentication failed."
          });
      }

      console.error(
        "Admin mailbox reader failed:",
        error?.code ||
        error?.name ||
        "mailbox_reader_error"
      );

      return res
        .status(502)
        .json({
          ok: false,

          error:
            "The test mailbox could not be read right now."
        });
    }
  }
);

/* -------------------------------------------------------
   TEMPORARY REAL TARGET EMAIL DIAGNOSTIC
   Reads ONLY UID 24 from the test mailbox.
   Does NOT save anything.
------------------------------------------------------- */

app.get(
  "/api/admin/test-target-real-email",
  requireAdmin,
  async (req, res) => {
    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    const testEmail =
      normalizeEmail(
        process.env.IMAP_TEST_EMAIL
      );

    const testPassword =
      String(
        process.env.IMAP_TEST_PASSWORD ||
        ""
      );

    if (
      !testEmail ||
      !testPassword
    ) {
      return res
        .status(500)
        .json({
          ok: false,
          error:
            "Test mailbox environment variables are not configured."
        });
    }

    const {
      provider,
      client
    } =
      createCustomerImapClient(
        testEmail,
        testPassword
      );

    try {
      await client.connect();

      const lock =
        await client.getMailboxLock(
          "INBOX",
          {
            readOnly: true
          }
        );

      try {
        /*
          UID 24 is the real Target order
          forwarded into the test mailbox.
        */

        const message =
          await client.fetchOne(
            24,
            {
              uid: true,
              envelope: true,
              internalDate: true,
              source: true
            },
            {
              uid: true
            }
          );

        if (
          !message ||
          !message.source
        ) {
          return res
            .status(404)
            .json({
              ok: false,
              error:
                "UID 24 could not be read."
            });
        }

        /*
          Decode the real forwarded MIME email.
        */

        const parsed =
          await simpleParser(
            message.source,
            {
              skipHtmlToText: true,
              skipTextToHtml: true
            }
          );

        const text =
          String(
            parsed?.text || ""
          );

        const html =
          typeof parsed?.html ===
          "string"
            ? parsed.html
            : "";

        /*
          Use our existing image extractor against
          the decoded HTML.
        */

        const images =
          extractEmailImageUrls(
            html
          );

        /*
          Diagnostic only.

          We deliberately return short previews,
          not the entire real email.
        */

        const orderNumberMatches =
          [
            ...(
              `${message.envelope?.subject || ""}\n${text}`
            ).matchAll(
              /(?:order|order\s*#|order\s*number)[^A-Z0-9]{0,20}([A-Z0-9-]{6,40})/gi
            )
          ]
            .map(
              match =>
                clean(
                  match?.[1],
                  100
                )
            )
            .filter(Boolean)
            .slice(0, 10);

        const uniqueOrderNumbers =
          [
            ...new Set(
              orderNumberMatches
            )
          ];

        return res.json({
          ok: true,

          provider:
            provider.name,

          uid:
            message.uid,

          subject:
            message.envelope
              ?.subject ||
            "",

          date:
            (
              message.envelope?.date ||
              message.internalDate
            )
              ? new Date(
                  message.envelope?.date ||
                  message.internalDate
                ).toISOString()
              : null,

          parsedSubject:
            parsed?.subject ||
            null,

          textLength:
            text.length,

          htmlLength:
            html.length,

          hasText:
            text.length > 0,

          hasHtml:
            html.length > 0,

          detectedOrderNumbers:
            uniqueOrderNumbers,

          expectedOrderDetected:
            uniqueOrderNumbers.includes(
              "902003694213213"
            ),

          imageCount:
            images.length,

          images:
            images
              .slice(0, 30)
              .map(
                image => ({
                  imageUrl:
                    image.imageUrl,

                  alt:
                    image.alt,

                  title:
                    image.title,

                  width:
                    image.width,

                  height:
                    image.height
                })
              ),

          textPreview:
            text
              .slice(
                0,
                5000
              ),

          htmlPreview:
            html
              .slice(
                0,
                3000
              )
        });

      } finally {
        lock.release();
      }

    } catch (error) {
      console.error(
        "Real Target diagnostic failed:",
        error?.code ||
        error?.name ||
        "target_real_email_error"
      );

      return res
        .status(502)
        .json({
          ok: false,
          error:
            "The real Target test email could not be inspected."
        });

    } finally {
      if (client.usable) {
        try {
          await client.logout();
        } catch {
          client.close();
        }
      } else {
        client.close();
      }
    }
  }
);

/* -------------------------------------------------------
   TEMPORARY TARGET ORDER PARSER TEST
   Reads only likely Target order messages.
   Does NOT save anything to Success yet.
------------------------------------------------------- */

function htmlToPlainText(value) {
  return String(value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}


function extractEmailText(source) {
  const raw =
    Buffer.isBuffer(source)
      ? source.toString("utf8")
      : String(source || "");

  /*
    For this controlled parser test we only need
    readable text from the message source.

    We remove common MIME/HTML noise but do not
    permanently store the raw message.
  */

  return htmlToPlainText(
    raw
      .replace(
        /^Content-[^\n]*$/gim,
        " "
      )
      .replace(
        /^MIME-Version:[^\n]*$/gim,
        " "
      )
  );
}

function decodeEmailHtmlValue(
  value
) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .trim();
}


function extractEmailImageUrls(
  source
) {
  const raw =
    Buffer.isBuffer(source)
      ? source.toString("utf8")
      : String(source || "");

  const images = [];

  const imagePattern =
    /<img\b([^>]*)>/gi;

  let match;

  while (
    (
      match =
        imagePattern.exec(raw)
    ) !== null
  ) {
    const attributes =
      match[1] || "";

    const srcMatch =
      attributes.match(
        /\bsrc\s*=\s*["']([^"']+)["']/i
      );

    if (!srcMatch?.[1]) {
      continue;
    }

    const rawUrl =
      decodeEmailHtmlValue(
        srcMatch[1]
      );

    if (
      !rawUrl ||
      /^cid:/i.test(rawUrl) ||
      /^data:/i.test(rawUrl)
    ) {
      continue;
    }

    const imageUrl =
      safeSuccessImageUrl(
        rawUrl
      );

    if (!imageUrl) {
      continue;
    }


    const altMatch =
      attributes.match(
        /\balt\s*=\s*["']([^"']*)["']/i
      );


    const titleMatch =
      attributes.match(
        /\btitle\s*=\s*["']([^"']*)["']/i
      );


    const widthMatch =
      attributes.match(
        /\bwidth\s*=\s*["']?(\d{1,5})/i
      );


    const heightMatch =
      attributes.match(
        /\bheight\s*=\s*["']?(\d{1,5})/i
      );


    const alt =
      decodeEmailHtmlValue(
        altMatch?.[1]
      );


    const title =
      decodeEmailHtmlValue(
        titleMatch?.[1]
      );


    const width =
      Number(
        widthMatch?.[1] || 0
      );


    const height =
      Number(
        heightMatch?.[1] || 0
      );


    /*
      Ignore obvious tracking pixels.

      We intentionally do NOT require dimensions
      because many retailer emails omit width/height
      attributes entirely.
    */

    if (
      (
        width > 0 &&
        width <= 5
      ) ||
      (
        height > 0 &&
        height <= 5
      )
    ) {
      continue;
    }


    if (
      images.some(
        image =>
          image.imageUrl ===
          imageUrl
      )
    ) {
      continue;
    }


    images.push({
      imageUrl,

      alt:
        clean(
          alt,
          500
        ),

      title:
        clean(
          title,
          500
        ),

      width:
        width || null,

      height:
        height || null
    });
  }

  return images;
}

function normalizeTargetProductText(
  value
) {
  return String(value || "")
    .toLowerCase()
    .replace(
      /[^a-z0-9]+/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}


function findTargetProductImage(
  productName,
  images
) {
  const normalizedName =
    normalizeTargetProductText(
      productName
    );

  if (!normalizedName) {
    return null;
  }

  const candidates =
    Array.isArray(images)
      ? images
      : [];


  /*
    First choice:
    exact ALT or TITLE match.
  */

  for (
    const image of candidates
  ) {
    const alt =
      normalizeTargetProductText(
        image?.alt
      );

    const title =
      normalizeTargetProductText(
        image?.title
      );

    if (
      alt === normalizedName ||
      title === normalizedName
    ) {
      return (
        safeSuccessImageUrl(
          image?.imageUrl
        ) || null
      );
    }
  }


  /*
    Second choice:
    one normalized name contains
    the other.

    Require a meaningful amount of
    text so short retailer labels such
    as "Target" cannot match a product.
  */

  for (
    const image of candidates
  ) {
    const labels = [
      normalizeTargetProductText(
        image?.alt
      ),

      normalizeTargetProductText(
        image?.title
      )
    ].filter(
      label =>
        label.length >= 12
    );


    const matched =
      labels.some(
        label =>
          label.includes(
            normalizedName
          ) ||
          normalizedName.includes(
            label
          )
      );


    if (matched) {
      return (
        safeSuccessImageUrl(
          image?.imageUrl
        ) || null
      );
    }
  }


  return null;
}

const targetProductImageLookupCache = new Map();
async function targetProductImageFromEmailLinks(productName, html) {
  const ids = [...String(html || "").matchAll(/target\.com\/p\/[^"'<>\s]*?\/A-(\d{7,12})/gi)]
    .map(match => match[1]);
  const uniqueIds = [...new Set(ids)].slice(0, 5);
  if (!uniqueIds.length) return null;
  const wanted = normalizeTargetProductText(publicSuccessProductName(productName));
  for (const id of uniqueIds) {
    if (!targetProductImageLookupCache.has(id)) {
      targetProductImageLookupCache.set(id, (async () => {
        try {
          const response = await fetch(`https://www.target.com/p/-/A-${id}`, {
            signal: AbortSignal.timeout(5000),
            headers: { "User-Agent": "Mozilla/5.0 (compatible; SLABSNGRABSACO/1.0)" }
          });
          if (!response.ok) return null;
          const page = (await response.text()).slice(0, 400000);
          const metaContent = key => {
            const tag = page.match(new RegExp(`<meta\\b[^>]*property=["']${key}["'][^>]*>`, "i"))?.[0] || "";
            return tag.match(/content=["']([^"']+)/i)?.[1] || "";
          };
          const title = metaContent("og:title");
          const image = metaContent("og:image");
          return { title: publicSuccessProductName(title), imageUrl: safeSuccessImageUrl(image) };
        } catch { return null; }
      })());
    }
    const found = await targetProductImageLookupCache.get(id);
    const title = normalizeTargetProductText(found?.title);
    if (title && wanted && (title.includes(wanted) || wanted.includes(title)) &&
        found?.imageUrl && !/\/gray-bag(?:[?/#]|$)/i.test(found.imageUrl)) {
      return found.imageUrl;
    }
  }
  return null;
}

function parseMoney(value) {
  const amount =
    Number(
      String(value || "")
        .replace(/[$,\s]/g, "")
    );

  return Number.isFinite(amount)
    ? Math.round(amount * 100) / 100
    : null;
}

async function decodeImapMessage(
  source
) {
  const parsed =
    await simpleParser(
      source,
      {
        skipHtmlToText: true,
        skipTextToHtml: true
      }
    );

  const text =
    String(
      parsed?.text || ""
    );

  const html =
    typeof parsed?.html === "string"
      ? parsed.html
      : "";

  return {
    text,
    html
  };
}

async function parseTargetTestOrder({
  subject,
  source,
  uid,
  messageId,
  date
}) {
  const decoded =
    await decodeImapMessage(
      source
    );

  const text =
    decoded.text ||
    extractEmailText(
      source
    );

  const emailImages =
    extractEmailImageUrls(
      decoded.html
    );

  const combined =
    `${subject || ""}\n${text}`;

  /*
    Accept both:
    - direct Target emails
    - forwarded Target emails

    We require Target + order language somewhere
    in the decoded message.
  */

  if (
    !/target/i.test(combined) ||
    !/order/i.test(combined)
  ) {
    return null;
  }


  /* =====================================================
     ORDER NUMBER
  ===================================================== */

  const orderMatch =
    combined.match(
      /order\s*(?:number|#|no\.?)?\s*:?\s*#?\s*([0-9]{6,40})/i
    );

  const orderNumber =
    orderMatch?.[1]
      ? clean(
          orderMatch[1],
          100
        )
      : null;


  /* =====================================================
     ORDER TOTAL
  ===================================================== */

  const totalMatch =
    combined.match(
      /order\s+total\s*:?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i
    );

  const orderTotal =
    totalMatch?.[1]
      ? parseMoney(
          totalMatch[1]
        )
      : null;

  if (
    !orderNumber ||
    orderTotal === null
  ) {
    return null;
  }


  /* =====================================================
     REMOVE TARGET RECOMMENDATION / MARKETING SECTION

     Real Target emails can contain unrelated products
     under "Up next, just for you". Those must never
     become checkout items.
  ===================================================== */

  let orderText =
    combined;

  const recommendationIndex =
    orderText.search(
      /up\s+next,\s*just\s+for\s+you\s*:/i
    );

  if (
    recommendationIndex >= 0
  ) {
    orderText =
      orderText.slice(
        0,
        recommendationIndex
      );
  }


    /* =====================================================
     PRODUCT PARSERS

     Supports controlled fixture format:

       Product Name
       Quantity: 4
       $39.99 each

     Supports real Target format:

       [image: Product Name]
       tracking/product links
       Product Name
       tracking/product links
       Qty: 2
       $69.99 / ea

     The Qty/price pair is the anchor. For real Target
     emails, we look backward inside that item's local
     block for the nearest trustworthy product image
     marker and match it to an actual email image.
  ===================================================== */

  const items = [];

  /*
    Match the quantity + unit price first.

    This avoids treating Target tracking URLs as the
    product name.
  */

  const quantityPricePattern =
    /(?:quantity|qty)\s*:?\s*(\d{1,4})\s*\n+\s*\$?\s*([\d,]+(?:\.\d{2}))\s*(?:each|\/\s*(?:each|ea)|ea)\b/gi;

  let quantityPriceMatch;

  while (
    (
      quantityPriceMatch =
        quantityPricePattern.exec(
          orderText
        )
    ) !== null
  ) {
    const quantity =
      Number(
        quantityPriceMatch[1]
      );

    const price =
      parseMoney(
        quantityPriceMatch[2]
      );

    if (
      !Number.isInteger(
        quantity
      ) ||
      quantity <= 0 ||
      price === null
    ) {
      continue;
    }

    const quantityStart =
      quantityPriceMatch.index;

    /*
      Only inspect text immediately before this Qty
      block. This keeps one purchased product from
      accidentally borrowing the name/image belonging
      to another product.
    */

    const nearbyStart =
      Math.max(
        0,
        quantityStart - 2500
      );

    const nearbyText =
      orderText.slice(
        nearbyStart,
        quantityStart
      );

    const nearbyLines =
      nearbyText
        .split(/\r?\n/)
        .map(line =>
          clean(
            line,
            500
          )
        )
        .filter(Boolean);

    let name =
      "";

    let matchedProductImage =
      null;

    /*
      REAL TARGET EMAILS

      Gmail's decoded plain text exposes the product
      image ALT as:

        [image: Product Name]

      Search backward from Qty so the nearest matching
      image marker belongs to the current item.
    */

    for (
      let index =
        nearbyLines.length - 1;
      index >= 0;
      index -= 1
    ) {
      const line =
        nearbyLines[index];

      const imageMarker =
        line.match(
          /^\[image:\s*(.+?)\s*\]$/i
        );

      if (!imageMarker?.[1]) {
        continue;
      }

      const candidate =
        clean(
          imageMarker[1],
          500
        );

      const candidateImage =
        findTargetProductImage(
          candidate,
          emailImages
        );

      if (candidateImage) {
        name =
          candidate;

        matchedProductImage =
          candidateImage;

        break;
      }
    }

    /*
      FALLBACK FOR CONTROLLED/PLAIN-TEXT EMAILS

      If there is no [image: ...] marker, walk backward
      from Qty and use the nearest normal text line that
      is not a Target tracking URL or order label.
    */

    if (!name) {
      for (
        let index =
          nearbyLines.length - 1;
        index >= 0;
        index -= 1
      ) {
        const candidate =
          nearbyLines[index];

        if (
          !candidate ||
          /^https?:\/\//i.test(
            candidate
          ) ||
          /^\[image:/i.test(
            candidate
          ) ||
          /^order\b/i.test(
            candidate
          ) ||
          /^shipping\b/i.test(
            candidate
          ) ||
          /^delivers\s+to\b/i.test(
            candidate
          ) ||
          /^arrives\b/i.test(
            candidate
          ) ||
          /^thanks\b/i.test(
            candidate
          ) ||
          /^rate\b/i.test(
            candidate
          ) ||
          /^visit\b/i.test(
            candidate
          ) ||
          /^quantity\b/i.test(
            candidate
          ) ||
          /^qty\b/i.test(
            candidate
          ) ||
          /^subtotal\b/i.test(
            candidate
          ) ||
          /^delivery\b/i.test(
            candidate
          ) ||
          /^estimated taxes\b/i.test(
            candidate
          ) ||
          /^total\b/i.test(
            candidate
          ) ||
          /^\$[\d,.]+/.test(
            candidate
          )
        ) {
          continue;
        }

        name =
          clean(
            candidate,
            300
          );

        matchedProductImage =
          findTargetProductImage(
            name,
            emailImages
          );

        break;
      }
    }

    if (!name) {
      continue;
    }

    /*
      If the fallback captured only the second half of
      a wrapped product name, try joining it with the
      preceding trustworthy text line. Only accept the
      joined version when the email's image ALT/TITLE
      confirms it.
    */

    if (!matchedProductImage) {
      const nameIndex =
        nearbyLines.lastIndexOf(
          name
        );

      if (nameIndex > 0) {
        for (
          let index =
            nameIndex - 1;
          index >= 0;
          index -= 1
        ) {
          const previousLine =
            nearbyLines[index];

          if (
            !previousLine ||
            /^https?:\/\//i.test(
              previousLine
            ) ||
            /^\[image:/i.test(
              previousLine
            )
          ) {
            continue;
          }

          const combinedName =
            clean(
              `${previousLine} ${name}`,
              500
            );

          const combinedImage =
            findTargetProductImage(
              combinedName,
              emailImages
            );

          if (combinedImage) {
            name =
              combinedName;

            matchedProductImage =
              combinedImage;
          }

          break;
        }
      }
    }

    /*
      Reject obvious non-product labels.
    */

    if (
      /^order\b/i.test(name) ||
      /^quantity\b/i.test(name) ||
      /^qty\b/i.test(name) ||
      /^order total\b/i.test(
        name
      ) ||
      /^thanks for your order/i.test(
        name
      ) ||
      /^subtotal\b/i.test(
        name
      ) ||
      /^delivery\b/i.test(
        name
      ) ||
      /^estimated taxes\b/i.test(
        name
      ) ||
      /^total\b/i.test(
        name
      )
    ) {
      continue;
    }

    /*
      Avoid duplicate product rows if MIME conversion
      repeats the same purchased product.
    */

    const existing =
      items.find(
        item =>
          normalizeTargetProductText(
            item.name
          ) ===
          normalizeTargetProductText(
            name
          ) &&
          item.quantity ===
            quantity &&
          item.price ===
            price
      );

    if (existing) {
      continue;
    }

    items.push({
      name,

      quantity,

      price,

           imageUrl:
        matchedProductImage ||
        findTargetProductImage(
          name,
          emailImages
        ) ||
        null
    });
  }


  // If the email contains a product link but only a placeholder thumbnail,
  // check that item's official Target page before saving the checkout.
  for (const item of items) {
    if (!item.imageUrl || /\/gray-bag(?:[?/#]|$)/i.test(item.imageUrl)) {
      item.imageUrl = await targetProductImageFromEmailLinks(item.name, decoded.html) || item.imageUrl;
    }
  }

  /* =====================================================
     TOTAL ITEM COUNT
  ===================================================== */

  const itemCount =
    items.reduce(
      (
        total,
        item
      ) =>
        total +
        Number(
          item.quantity || 0
        ),
      0
    );


  /* =====================================================
     RETURN NORMALIZED TARGET CHECKOUT
  ===================================================== */

  return {
    retailer:
      "Target",

    orderNumber,

    checkoutAt:
      date || null,

    itemCount,

    orderTotal,

    items,

    source:
      "imap-test",

    mailboxUid:
      String(
        uid || ""
      ),

    messageId:
      clean(
        messageId,
        500
      )
  };
}



/* -------------------------------------------------------
   COSTCO ORDER PARSER

   Built around live Costco.com confirmations:
   - Sender: Costco Orders / orders.costco.com
   - Subject includes: "Your Costco.com order <number>"
   - Order Placed date
   - Product name
   - Item number
   - Price
   - Quantity
   - Subtotal
   - Shipping & Handling
   - Optional surcharge
   - Estimated Tax
   - Total
------------------------------------------------------- */

function isCostcoMessage(
  subject,
  sender,
  combined
) {
  return (
    /costco/i.test(
      sender || ""
    ) ||
    /costco\.com/i.test(
      subject || ""
    ) ||
    /costco\.com/i.test(
      combined || ""
    ) ||
    /orders\.costco\.com/i.test(
      sender || ""
    )
  );
}


function extractCostcoItems(
  text,
  html
) {
  const combined =
    `${text || ""}\n${html || ""}`;

  const items =
    [];

  /*
    Typical block:

    Monster Energy Drink, Zero Ultra, 24 fl oz, 12-count
    Item 1075207
    Price $38.99
    Quantity 1
  */

  const pattern =
    /([^\r\n]{4,300})\s*(?:\r?\n|\s{2,})\s*Item\s+([A-Z0-9-]{3,60})\s*(?:\r?\n|\s{2,})\s*Price\s*\$?\s*([\d,]+(?:\.\d{2}))\s*(?:\r?\n|\s{2,})\s*Quantity\s+(\d{1,3})/gi;

  let match;

  while (
    (
      match =
        pattern.exec(
          combined
        )
    ) !== null
  ) {
    const name =
      clean(
        match[1],
        300
      )
        .replace(
          /^your\s+order\s*/i,
          ""
        )
        .trim();

    const itemNumber =
      clean(
        match[2],
        100
      );

    const price =
      parseMoney(
        match[3]
      );

    const quantity =
      Math.max(
        1,
        Number(
          match[4]
        ) || 1
      );

    if (
      !name ||
      !itemNumber ||
      price === null
    ) {
      continue;
    }

    items.push({
      name,
      sku:
        itemNumber,
      quantity,
      price,
      imageUrl:
        null
    });
  }

  return items.slice(
    0,
    30
  );
}


async function parseCostcoOrder({
  subject,
  sender,
  source,
  uid,
  messageId,
  date
}) {
  const decoded =
    await decodeImapMessage(
      source
    );

  const text =
    decoded.text ||
    extractEmailText(
      source
    );

  const htmlText =
    htmlToPlainText(
      decoded.html
    );

  const combined =
    `${subject || ""}\n${sender || ""}\n${text}\n${htmlText}`;

  if (
    !isCostcoMessage(
      subject,
      sender,
      combined
    )
  ) {
    return null;
  }


  /* =====================================================
     ORDER NUMBER

     Costco normally places the number directly in the
     email subject: "Your Costco.com order 1308657677..."
  ===================================================== */

  const orderMatch =
    String(
      subject || ""
    ).match(
      /costco\.com\s+order\s+#?\s*([0-9]{7,24})/i
    ) ||
    combined.match(
      /(?:order\s*(?:number|#)?|costco\.com\s+order)\s*:?\s*#?\s*([0-9]{7,24})/i
    );

  const orderNumber =
    orderMatch?.[1]
      ? clean(
          orderMatch[1],
          100
        )
      : null;


  /* =====================================================
     ORDER DATE
  ===================================================== */

  const dateMatch =
    combined.match(
      /order\s+placed\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i
    );

  let checkoutAt =
    date ||
    null;

  if (
    dateMatch?.[1]
  ) {
    const parts =
      dateMatch[1]
        .split("/")
        .map(Number);

    if (
      parts.length === 3
    ) {
      const [
        month,
        day,
        year
      ] = parts;

      const parsedDate =
        new Date(
          Date.UTC(
            year,
            month - 1,
            day,
            12,
            0,
            0
          )
        );

      if (
        !Number.isNaN(
          parsedDate.getTime()
        )
      ) {
        checkoutAt =
          parsedDate.toISOString();
      }
    }
  }


  /* =====================================================
     PRODUCTS
  ===================================================== */

  const items =
    extractCostcoItems(
      text,
      htmlText
    );

  const itemCount =
    items.reduce(
      (sum, item) =>
        sum +
        Number(
          item.quantity ||
          1
        ),
      0
    );


  /* =====================================================
     TOTAL

     Use the final Costco "Total" value rather than
     subtotal, tax or surcharge amounts.
  ===================================================== */

  const totalMatches =
    [
      ...combined.matchAll(
        /(?:^|\n|\r|\s)Total\s*\$?\s*([\d,]+(?:\.\d{2}))/gi
      )
    ];

  const finalTotalMatch =
    totalMatches.at(-1);

  const orderTotal =
    finalTotalMatch?.[1]
      ? parseMoney(
          finalTotalMatch[1]
        )
      : null;


  /* =====================================================
     PRODUCT IMAGES
  ===================================================== */

  const images =
    extractEmailImageUrls(
      decoded.html
    );

  for (
    const item of
    items
  ) {
    const key =
      normalizeWalmartProductText(
        item.name
      );

    const image =
      images.find(image => {
        const alt =
          normalizeWalmartProductText(
            image?.alt
          );

        const title =
          normalizeWalmartProductText(
            image?.title
          );

        return (
          alt === key ||
          title === key ||
          (
            alt.length >= 12 &&
            (
              alt.includes(key) ||
              key.includes(alt)
            )
          ) ||
          (
            title.length >= 12 &&
            (
              title.includes(key) ||
              key.includes(title)
            )
          )
        );
      });

    if (image?.imageUrl) {
      item.imageUrl =
        image.imageUrl;
    }
  }


  if (
    !orderNumber ||
    orderTotal === null
  ) {
    return null;
  }

  return {
    retailer:
      "Costco",

    orderNumber,

    checkoutAt,

    itemCount,

    orderTotal,

    items,

    source:
      "imap-live-costco",

    mailboxUid:
      String(
        uid ||
        ""
      ),

    messageId:
      clean(
        messageId,
        500
      )
  };
}


/* -------------------------------------------------------
   POKEMON CENTER / PKC ORDER PARSER

   Built around live Pokemon Center confirmations:
   - Sender: info@em.pokemon.com / Pokemon Center
   - Subject: "Thank you for shopping at PokemonCenter.com!"
   - Order Number
   - Date Ordered
   - Order Summary
   - Product name
   - SKU
   - Qty
   - Price
   - Order Subtotal
   - Sales Tax
   - Shipping
   - Order Total
------------------------------------------------------- */

function isPokemonCenterMessage(
  subject,
  sender,
  combined
) {
  return (
    /pokemon\s*center/i.test(
      sender || ""
    ) ||
    /pokemoncenter\.com/i.test(
      subject || ""
    ) ||
    /pokemoncenter\.com/i.test(
      combined || ""
    ) ||
    /@em\.pokemon\.com\b/i.test(
      sender || ""
    )
  );
}


function extractPokemonCenterItems(
  text,
  html
) {
  const combined =
    `${text || ""}\n${html || ""}`;

  const items =
    [];

  /*
    Typical block:

    Pokémon TCG: 30th Celebration Booster Bundle (6 Packs)
    SKU #: 10-10451-115
    Qty: 3
    Price: $26.94
  */

  const pattern =
    /(?:order\s+summary[\s\S]*?)?([^\r\n]{4,300})\s*(?:\r?\n|\s{2,})\s*SKU\s*#?\s*:?\s*([A-Z0-9-]{3,80})\s*(?:\r?\n|\s{2,})\s*Qty\s*:?\s*(\d{1,3})\s*(?:\r?\n|\s{2,})\s*Price\s*:?\s*\$\s*([\d,]+(?:\.\d{2}))/gi;

  let match;

  while (
    (
      match =
        pattern.exec(
          combined
        )
    ) !== null
  ) {
    const name =
      clean(
        match[1],
        300
      )
        .replace(
          /^order\s+summary\s*/i,
          ""
        )
        .trim();

    const sku =
      clean(
        match[2],
        100
      );

    const quantity =
      Math.max(
        1,
        Number(
          match[3]
        ) || 1
      );

    const price =
      parseMoney(
        match[4]
      );

    if (
      !name ||
      !sku ||
      price === null
    ) {
      continue;
    }

    items.push({
      name,
      sku,
      quantity,
      price,
      imageUrl:
        null
    });
  }

  return items.slice(
    0,
    30
  );
}


async function parsePokemonCenterOrder({
  subject,
  sender,
  source,
  uid,
  messageId,
  date
}) {
  const decoded =
    await decodeImapMessage(
      source
    );

  const text =
    decoded.text ||
    extractEmailText(
      source
    );

  const htmlText =
    htmlToPlainText(
      decoded.html
    );

  const combined =
    `${subject || ""}\n${sender || ""}\n${text}\n${htmlText}`;

  if (
    !isPokemonCenterMessage(
      subject,
      sender,
      combined
    )
  ) {
    return null;
  }


  /* =====================================================
     ORDER NUMBER
  ===================================================== */

  const orderMatch =
    combined.match(
      /order\s+number\s*:?\s*([A-Z0-9-]{5,50})/i
    );

  const orderNumber =
    orderMatch?.[1]
      ? clean(
          orderMatch[1],
          100
        )
      : null;


  /* =====================================================
     DATE ORDERED
  ===================================================== */

  const dateMatch =
    combined.match(
      /date\s+ordered\s*:?\s*([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})/i
    );

  let checkoutAt =
    date ||
    null;

  if (
    dateMatch?.[1]
  ) {
    const parsedDate =
      new Date(
        dateMatch[1]
      );

    if (
      !Number.isNaN(
        parsedDate.getTime()
      )
    ) {
      checkoutAt =
        parsedDate.toISOString();
    }
  }


  /* =====================================================
     PRODUCTS
  ===================================================== */

  const items =
    extractPokemonCenterItems(
      text,
      htmlText
    );

  const itemCount =
    items.reduce(
      (sum, item) =>
        sum +
        Number(
          item.quantity ||
          1
        ),
      0
    );


  /* =====================================================
     ORDER TOTAL
  ===================================================== */

  const totalMatch =
    combined.match(
      /order\s+total\s*:?\s*\$\s*([\d,]+(?:\.\d{2}))/i
    ) ||
    combined.match(
      /order\s+total[\s\S]{0,120}?\$\s*([\d,]+(?:\.\d{2}))/i
    );

  const orderTotal =
    totalMatch?.[1]
      ? parseMoney(
          totalMatch[1]
        )
      : null;


  /* =====================================================
     OPTIONAL PRODUCT IMAGES

     Match ALT/TITLE labels to known product names when
     the email HTML exposes them.
  ===================================================== */

  const images =
    extractEmailImageUrls(
      decoded.html
    );

  for (
    const item of
    items
  ) {
    const key =
      normalizeWalmartProductText(
        item.name
      );

    const image =
      images.find(image => {
        const alt =
          normalizeWalmartProductText(
            image?.alt
          );

        const title =
          normalizeWalmartProductText(
            image?.title
          );

        return (
          alt === key ||
          title === key ||
          (
            alt.length >= 12 &&
            (
              alt.includes(key) ||
              key.includes(alt)
            )
          ) ||
          (
            title.length >= 12 &&
            (
              title.includes(key) ||
              key.includes(title)
            )
          )
        );
      });

    if (image?.imageUrl) {
      item.imageUrl =
        image.imageUrl;
    }
  }


  if (
    !orderNumber ||
    orderTotal === null
  ) {
    return null;
  }

  return {
    retailer:
      "PKC",

    orderNumber,

    checkoutAt,

    itemCount,

    orderTotal,

    items,

    source:
      "imap-live-pkc",

    mailboxUid:
      String(
        uid ||
        ""
      ),

    messageId:
      clean(
        messageId,
        500
      )
  };
}


/* -------------------------------------------------------
   WALMART ORDER PARSER

   Built around Walmart's live confirmation format:
   - Subject: "Thanks for your order, <name>"
   - Sender/domain: Walmart / walmart.com
   - "Order number: #2000148-92736323"
   - Fulfillment sections with "1 item" / "4 items"
   - "Order total" followed by the final order amount
   - A separate Payment method / Temporary hold amount

   IMPORTANT:
   We intentionally parse ORDER TOTAL and ignore the
   temporary authorization hold amount.
------------------------------------------------------- */

function normalizeWalmartProductText(
  value
) {
  return String(value || "")
    .toLowerCase()
    .replace(
      /[^a-z0-9]+/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}


function isWalmartNonProductImageLabel(
  value
) {
  const label =
    normalizeWalmartProductText(
      value
    );

  if (!label) {
    return true;
  }

  const blocked = [
    "walmart",
    "walmart logo",
    "walmart plus",
    "google play",
    "app store",
    "download on the app store",
    "get it on google play",
    "shop anywhere",
    "curbside pickup",
    "delivery",
    "view order",
    "see item",
    "see all",
    "questions",
    "help center",
    "facebook",
    "instagram",
    "pinterest",
    "youtube"
  ];

  return blocked.some(
    text =>
      label === text ||
      label.startsWith(
        `${text} `
      )
  );
}


function walmartProductCandidates(
  text,
  images
) {
  const candidates =
    [];

  const seen =
    new Set();

  /*
    Decoded HTML/plain-text commonly exposes useful
    image ALT text as "[image: Product Name]".
  */
  const markerPattern =
    /\[image:\s*([^\]\r\n]{4,500})\]/gi;

  let marker;

  while (
    (
      marker =
        markerPattern.exec(
          String(text || "")
        )
    ) !== null
  ) {
    const name =
      clean(
        marker[1],
        300
      );

    const key =
      normalizeWalmartProductText(
        name
      );

    if (
      !key ||
      isWalmartNonProductImageLabel(
        name
      ) ||
      seen.has(key)
    ) {
      continue;
    }

    const image =
      (
        Array.isArray(images)
          ? images
          : []
      ).find(item => {
        const alt =
          normalizeWalmartProductText(
            item?.alt
          );

        const title =
          normalizeWalmartProductText(
            item?.title
          );

        return (
          alt === key ||
          title === key ||
          (
            alt.length >= 12 &&
            (
              alt.includes(key) ||
              key.includes(alt)
            )
          ) ||
          (
            title.length >= 12 &&
            (
              title.includes(key) ||
              key.includes(title)
            )
          )
        );
      });

    seen.add(key);

    candidates.push({
      name,
      quantity:
        1,
      price:
        0,
      imageUrl:
        image?.imageUrl ||
        null
    });
  }

  /*
    If plain-text conversion did not expose [image:]
    markers, use meaningful ALT/TITLE labels from the
    email's product images.
  */
  for (
    const image of
    (
      Array.isArray(images)
        ? images
        : []
    )
  ) {
    const labels = [
      image?.alt,
      image?.title
    ]
      .map(value =>
        clean(
          value,
          300
        )
      )
      .filter(Boolean);

    const name =
      labels.find(
        label =>
          label.length >= 8 &&
          !isWalmartNonProductImageLabel(
            label
          )
      );

    if (!name) {
      continue;
    }

    const key =
      normalizeWalmartProductText(
        name
      );

    if (
      !key ||
      seen.has(key)
    ) {
      continue;
    }

    seen.add(key);

    candidates.push({
      name,
      quantity:
        1,
      price:
        0,
      imageUrl:
        image?.imageUrl ||
        null
    });
  }

  return candidates
    .slice(
      0,
      20
    );
}


async function parseWalmartOrder({
  subject,
  sender,
  source,
  uid,
  messageId,
  date
}) {
  const decoded =
    await decodeImapMessage(
      source
    );

  const text =
    decoded.text ||
    extractEmailText(
      source
    );

  const htmlText =
    htmlToPlainText(
      decoded.html
    );

  const combined =
    `${subject || ""}\n${sender || ""}\n${text}\n${htmlText}`;

  /*
    Walmart confirmation subjects do not necessarily
    say "Walmart"; the sender/domain does. Forwarded
    confirmations can still be recognized by body text.
  */
  if (
    !/order/i.test(
      combined
    ) ||
    !(
      /walmart/i.test(
        combined
      ) ||
      /@walmart\.com\b/i.test(
        sender || ""
      )
    )
  ) {
    return null;
  }


  /* =====================================================
     ORDER NUMBER
  ===================================================== */

  const orderMatch =
    combined.match(
      /order\s*(?:number|#|no\.?)?\s*:?\s*#?\s*([0-9]{4,12}-[0-9]{5,24})/i
    ) ||
    combined.match(
      /order\s*(?:number|#|no\.?)?\s*:?\s*#?\s*([A-Z0-9-]{8,40})/i
    );

  const orderNumber =
    orderMatch?.[1]
      ? clean(
          orderMatch[1],
          100
        )
      : null;


  /* =====================================================
     ORDER TOTAL

     Search only the short area immediately following
     "Order total". This prevents Walmart's separate
     "Temporary hold" amount from becoming the Success
     checkout value.
  ===================================================== */

  const totalSectionMatch =
    combined.match(
      /order\s+total\b([\s\S]{0,350})/i
    );

  const totalMoneyMatch =
    totalSectionMatch?.[1]
      ?.match(
        /\$\s*([\d,]+(?:\.\d{2}))/i
      );

  const orderTotal =
    totalMoneyMatch?.[1]
      ? parseMoney(
          totalMoneyMatch[1]
        )
      : null;

  if (
    !orderNumber ||
    orderTotal === null
  ) {
    return null;
  }


  /* =====================================================
     ITEM COUNT

     Walmart may split one order between curbside pickup
     and delivery. Sum the visible "N item(s)" counts
     before the Order total section.
  ===================================================== */

  const beforeTotal =
    combined
      .split(
        /order\s+total\b/i
      )[0] ||
    combined;

  const itemCountMatches =
    [
      ...beforeTotal.matchAll(
        /\b(\d{1,3})\s+items?\b/gi
      )
    ]
      .map(
        match =>
          Number(
            match[1]
          )
      )
      .filter(
        value =>
          Number.isInteger(
            value
          ) &&
          value > 0 &&
          value <= 100
      );

  let itemCount =
    itemCountMatches.reduce(
      (sum, value) =>
        sum + value,
      0
    );


  /* =====================================================
     PRODUCT NAMES + IMAGES

     Walmart's confirmation can summarize products by
     image/ALT text rather than showing a price row for
     every item. Success does not require per-item prices;
     the authoritative checkout value is Order total.
  ===================================================== */

  const allImages =
    extractEmailImageUrls(
      decoded.html
    );

  const items =
    walmartProductCandidates(
      beforeTotal,
      allImages
    );

  if (
    itemCount <= 0
  ) {
    itemCount =
      items.reduce(
        (sum, item) =>
          sum +
          Number(
            item.quantity ||
            1
          ),
        0
      );
  }


  /* =====================================================
     RETURN NORMALIZED WALMART CHECKOUT
  ===================================================== */

  return {
    retailer:
      "Walmart",

    orderNumber,

    checkoutAt:
      date ||
      null,

    itemCount,

    orderTotal,

    items,

    source:
      "imap-live-walmart",

    mailboxUid:
      String(
        uid ||
        ""
      ),

    messageId:
      clean(
        messageId,
        500
      )
  };
}


async function readLatestTargetTestOrder(
  email,
  password
) {
  const {
    provider,
    client
  } =
    createCustomerImapClient(
      email,
      password
    );

  try {
    await client.connect();

    const lock =
      await client.getMailboxLock(
        "INBOX",
        {
          readOnly: true
        }
      );

    try {
      const totalMessages =
        Number(
          client.mailbox?.exists || 0
        );

      if (!totalMessages) {
        return {
          provider:
            provider.name,

          matched:
            false,

          order:
            null
        };
      }

      /*
        Only inspect the newest 25 messages.
        First fetch envelope metadata.
      */

      const startSequence =
        Math.max(
          1,
          totalMessages - 24
        );

      const candidates =
        await client.fetchAll(
          `${startSequence}:*`,
          {
            uid: true,
            envelope: true,
            internalDate: true
          }
        );

      /*
        Newest first.
      */

      candidates.reverse();

      for (
        const candidate of candidates
      ) {
        const subject =
          String(
            candidate
              .envelope
              ?.subject ||
            ""
          );

        /*
          Do not fetch message content unless
          the subject looks like a Target order.
        */

        if (
          !/target/i.test(subject) ||
          !/order/i.test(subject)
        ) {
          continue;
        }

        const message =
          await client.fetchOne(
            candidate.uid,
            {
              uid: true,
              envelope: true,
              internalDate: true,
              source: true
            },
            {
              uid: true
            }
          );

        if (!message) {
          continue;
        }

        const parsed =
  await parseTargetTestOrder({
            subject:
              message.envelope
                ?.subject ||
              subject,

            source:
              message.source,

            uid:
              message.uid,

            messageId:
              message.envelope
                ?.messageId ||
              "",

            date:
              (
                message.envelope?.date ||
                message.internalDate
              )
                ? new Date(
                    message.envelope?.date ||
                    message.internalDate
                  ).toISOString()
                : null
          });

        if (parsed) {
          return {
            provider:
              provider.name,

            matched:
              true,

            order:
              parsed
          };
        }
      }

      return {
        provider:
          provider.name,

        matched:
          false,

        order:
          null
      };

    } finally {
      lock.release();
    }

  } finally {
    if (client.usable) {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    } else {
      client.close();
    }
  }
}


/* -------------------------------------------------------
   LIVE TARGET + WALMART + PKC + COSTCO SUCCESS SYNC
   Uses each active customer's encrypted ACO mailbox
   credentials, saves new Target order confirmations to
   the real Success store, then recordSuccessCheckout()
   sends the privacy-safe Discord notification.
------------------------------------------------------- */

const LIVE_SUCCESS_SYNC_INTERVAL_MS =
  Math.max(
    60 * 1000,
    Number(
      process.env
        .SUCCESS_SYNC_INTERVAL_MS ||
      60 * 1000
    )
  );

const LIVE_SUCCESS_MIN_ACCOUNT_INTERVAL_MS =
  Math.max(
    30 * 1000,
    Number(
      process.env
        .SUCCESS_ACCOUNT_SYNC_THROTTLE_MS ||
      60 * 1000
    )
  );

const liveSuccessLastSyncByAccount =
  new Map();

const liveSuccessMailboxScanSince = new Map();

const liveSuccessAccountLocks =
  new Set();

let liveSuccessCycleRunning =
  false;



function extractRoutingEmailsFromSource(
  source
) {
  const raw =
    Buffer.isBuffer(
      source
    )
      ? source.toString(
          "utf8"
        )
      : String(
          source ||
          ""
        );

  /*
    Forwarded/redirected mail can preserve the original
    recipient in headers OR in the forwarded message body.
    We only keep syntactically valid email addresses.
  */
  const matches =
    raw
      .slice(
        0,
        120000
      )
      .match(
        /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
      ) ||
    [];

  return [
    ...new Set(
      matches
        .map(
          normalizeEmail
        )
        .filter(Boolean)
    )
  ];
}


async function readRecentRetailerOrders(
  email,
  password,
  maxMessages = 60,
  sinceAt = null
) {
  const {
    provider,
    client
  } =
    createCustomerImapClient(
      email,
      password
    );

  try {
    client.successSyncPhase = "connecting";
    await client.connect();
    client.successSyncPhase = "opening_inbox";

    const lock =
      await client.getMailboxLock(
        "INBOX",
        {
          readOnly: true
        }
      );

    try {
      const totalMessages =
        Number(
          client.mailbox?.exists ||
          0
        );

      if (!totalMessages) {
        return {
          provider:
            provider.name,
          orders: []
        };
      }

      const safeMax =
        Math.min(
          120,
          Math.max(
            20,
            Number(maxMessages) ||
            60
          )
        );

      // Search by signup date so an already connected mailbox can backfill
      // confirmations after registration, even if the inbox has grown.
      const signupTime = new Date(sinceAt || 0).getTime();
      const signupDate = Number.isFinite(signupTime) && signupTime > 0
        ? new Date(signupTime)
        : null;
      const confirmationSubjects = { or: [
        { subject: "order" }, { subject: "purchase" },
        { subject: "receipt" }, { subject: "confirmation" }
      ] };
      client.successSyncPhase = "searching";
      const matchingUids = await client.search(
        signupDate ? { ...confirmationSubjects, since: signupDate } : confirmationSubjects,
        { uid: true }
      );

      client.successSyncPhase = "fetching_headers";
      const candidates = [];
      for (let offset = 0; offset < matchingUids.length; offset += safeMax) {
        candidates.push(...await client.fetchAll(
          matchingUids.slice(offset, offset + safeMax),
          { uid: true, envelope: true, internalDate: true },
          { uid: true }
        ));
      }

      /*
        Process oldest -> newest so Success history
        remains naturally ordered.
      */
      const orders = [];

      for (
        const candidate of
        candidates
      ) {
        const receivedAt = new Date(candidate.internalDate || candidate.envelope?.date || 0).getTime();
        if (signupDate && (!Number.isFinite(receivedAt) || receivedAt < signupTime)) continue;
        const subject =
          String(
            candidate
              .envelope
              ?.subject ||
            ""
          );

        const sender =
          (
            candidate
              .envelope
              ?.from ||
            []
          )
            .map(address =>
              `${address?.name || ""} <${address?.address || ""}>`
            )
            .join(" ");

        /*
          Target, Walmart and Pokemon Center confirmations contain
          order language. Walmart's subject is typically
          "Thanks for your order, <name>" and may not
          contain the retailer name.
        */
        if (
          !/order|purchase|receipt|confirmation/i.test(
            subject
          )
        ) {
          continue;
        }

        client.successSyncPhase = "fetching_message";
        const message =
          await client.fetchOne(
            candidate.uid,
            {
              uid: true,
              envelope: true,
              internalDate: true,
              source: true
            },
            {
              uid: true
            }
          );

        if (
          !message ||
          !message.source
        ) {
          continue;
        }

        const common = {
          subject:
            message.envelope
              ?.subject ||
            subject,

          sender:
            (
              message.envelope
                ?.from ||
              candidate.envelope
                ?.from ||
              []
            )
              .map(address =>
                `${address?.name || ""} <${address?.address || ""}>`
              )
              .join(" ") ||
            sender,

          source:
            message.source,

          uid:
            message.uid,

          messageId:
            message.envelope
              ?.messageId ||
            "",

          date:
            (
              message.envelope?.date ||
              message.internalDate
            )
              ? new Date(
                  message.envelope?.date ||
                  message.internalDate
                ).toISOString()
              : null
        };

        client.successSyncPhase = "parsing_message";
        let parsed =
          null;

        /*
          Costco has a distinctive sender/domain and
          order-number subject.
        */
        if (
          /costco/i.test(
            common.sender
          ) ||
          /costco\.com/i.test(
            common.subject
          )
        ) {
          parsed =
            await parseCostcoOrder(
              common
            );
        }

        /*
          Pokemon Center has a distinctive sender and
          subject, so try PKC next.
        */
        if (
          !parsed &&
          (
            /pokemon/i.test(
              common.sender
            ) ||
            /pokemoncenter\.com/i.test(
              common.subject
            )
          )
        ) {
          parsed =
            await parsePokemonCenterOrder(
              common
            );
        }

        /*
          Favor the sender/subject hint first, but each
          parser independently validates the body.
        */
        if (
          !parsed &&
          (
            /walmart/i.test(
              common.sender
            ) ||
            /thanks\s+for\s+your\s+order/i.test(
              common.subject
            )
          )
        ) {
          parsed =
            await parseWalmartOrder(
              common
            );
        }

        if (
          !parsed &&
          (
            /target/i.test(
              common.subject
            ) ||
            /target/i.test(
              common.sender
            )
          )
        ) {
          parsed =
            await parseTargetTestOrder(
              common
            );
        }

        /*
          Forwarded messages can hide the retailer in
          the envelope, so try the alternate parsers too.
        */
        if (!parsed) {
          parsed =
            await parseCostcoOrder(
              common
            );
        }

        if (!parsed) {
          parsed =
            await parsePokemonCenterOrder(
              common
            );
        }

        if (!parsed) {
          parsed =
            await parseWalmartOrder(
              common
            );
        }

        if (!parsed) {
          parsed =
            await parseTargetTestOrder(
              common
            );
        }

        if (parsed) {
          orders.push({
            ...parsed,

            messageId:
              parsed.messageId ||
              common.messageId ||
              "",

            mailboxUid:
              parsed.mailboxUid ||
              common.uid ||
              null,

            routingEmails:
              extractRoutingEmailsFromSource(
                message.source
              )
          });
        }
      }

      return {
        provider:
          provider.name,
        orders
      };

    } finally {
      lock.release();
    }

  } catch (error) {
    const failure = client.successMailboxError || error;
    failure.mailboxPhase = client.successSyncPhase || "connecting";
    throw failure;
  } finally {
    if (client.usable) {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    } else {
      client.close();
    }
  }
}

async function getCustomerSuccessMailboxes(
  customerAccountId
) {
  const accounts = await getCustomerAccounts();
  const owner = accounts.find(account =>
    String(account.id) === String(customerAccountId)
  );
  const signedUpAt = owner?.createdAt || null;
  const paid =
    await readJson(
      PAID_FILE,
      []
    );

  const paidRecords =
    Array.isArray(paid)
      ? paid
      : [];

  const customerOrders =
    paidRecords
      .filter(
        record =>
          String(
            record.customerAccountId ||
            ""
          ) ===
            String(
              customerAccountId
            ) &&
          subscriptionAllowsProfiles(
            record
          )
      )
      .sort(
        (a, b) =>
          new Date(
            b.paidAt ||
            b.createdAt ||
            0
          ).getTime() -
          new Date(
            a.paidAt ||
            a.createdAt ||
            0
          ).getTime()
      );

  const seen =
    new Set();

  // The most recently saved app-password entry takes precedence over an old
  // copy on an order; scan each inbox once for this customer.
  const mailboxes = customerOrders.length ? savedSuccessMailboxes(savedImapEntries(owner),
    owner?.successFullHistory === true ? null : signedUpAt) : [];
  for (const mailbox of mailboxes) seen.add(mailbox.email);

  for (
    const order of
    customerOrders
  ) {
    let secrets;

    try {
      secrets =
        await loadEncryptedPackage(
          order.id
        );
    } catch {
      continue;
    }

    const email =
      normalizeEmail(
        secrets?.acoEmail
      );

    const password =
      String(
        secrets?.acoPassword ||
        ""
      );

    if (
      !email ||
      !password
    ) {
      continue;
    }

    const mailboxKey =
      email.toLowerCase();

    if (
      seen.has(
        mailboxKey
      )
    ) {
      continue;
    }

    seen.add(
      mailboxKey
    );

    mailboxes.push({
      email,
      password,
      signedUpAt: owner?.successFullHistory === true
        ? null
        : signedUpAt || order.paidAt || order.createdAt || null,

      profileSlot:
        Number.isInteger(
          Number(
            order?.profile?.slot
          )
        )
          ? Number(
              order.profile.slot
            )
          : null,

      profileName:
        clean(
          order?.profile
            ?.profileName ||
          order?.profile
            ?.name ||
          `ACO Profile`,
          80
        )
    });
  }

  return mailboxes;
}


async function syncCustomerTargetSuccess(
  customerAccountId,
  {
    force = false
  } = {}
) {
  const accountId =
    String(
      customerAccountId ||
      ""
    );

  if (!accountId) {
    return {
      scanned: false,
      saved: 0,
      duplicates: 0,
      mailboxes: 0
    };
  }

  if (
    liveSuccessAccountLocks.has(
      accountId
    )
  ) {
    return {
      scanned: false,
      busy: true,
      saved: 0,
      duplicates: 0,
      mailboxes: 0
    };
  }

  const lastSync =
    Number(
      liveSuccessLastSyncByAccount
        .get(accountId) ||
      0
    );

  if (
    !force &&
    Date.now() -
      lastSync <
      LIVE_SUCCESS_MIN_ACCOUNT_INTERVAL_MS
  ) {
    return {
      scanned: false,
      throttled: true,
      saved: 0,
      duplicates: 0,
      mailboxes: 0
    };
  }

  liveSuccessAccountLocks.add(
    accountId
  );

  try {
    const mailboxes =
      await getCustomerSuccessMailboxes(
        accountId
      );

    let saved = 0;
    let duplicates = 0;
    let parsedOrders = 0;
    let failedMailboxes = 0;

    for (
      const mailbox of
      mailboxes
    ) {
      try {
        const mailboxKey = `${accountId}:${mailbox.email.toLowerCase()}`;
        const previousScan = liveSuccessMailboxScanSince.get(mailboxKey) || 0;
        // Revisit recent mail to catch late deliveries without rescanning the
        // complete historical inbox on every refresh.
        const recentStart = previousScan ? previousScan - 7 * 24 * 60 * 60 * 1000 : 0;
        const originalStart = new Date(mailbox.signedUpAt || 0).getTime();
        const searchSince = recentStart
          ? new Date(Math.max(recentStart, originalStart || 0)).toISOString()
          : mailbox.signedUpAt;
        const result =
          await readRecentRetailerOrders(
            mailbox.email,
            mailbox.password,
            60,
            searchSince
          );

        for (
          const order of
          result.orders
        ) {
          const checkoutTime = new Date(order.checkoutAt || order.date || 0).getTime();
          const signupTime = new Date(mailbox.signedUpAt || 0).getTime();
          if (!Number.isFinite(checkoutTime) || (mailbox.signedUpAt && checkoutTime < signupTime)) continue;
          parsedOrders += 1;

          /*
            Stable ID makes repeated IMAP scans safe.
            The customer ID prevents an order number
            collision between different customers.
          */
          const retailerKey =
            String(
              order.retailer ||
              "retailer"
            )
              .trim()
              .toLowerCase()
              .replace(
                /[^a-z0-9]+/g,
                "-"
              );

          const stableId =
            `${retailerKey}:${accountId}:${String(
              order.orderNumber ||
              order.messageId ||
              order.mailboxUid ||
              ""
            )}`;

          if (
            stableId.endsWith(":")
          ) {
            continue;
          }

          const successRecord = {
            id:
              stableId,

            customerAccountId:
              accountId,

            profileSlot:
              mailbox.profileSlot,

            profileName:
              mailbox.profileName,

            retailer:
              order.retailer ||
              "Retailer",

            orderNumber:
              order.orderNumber,

            checkoutAt:
              order.checkoutAt ||
              new Date()
                .toISOString(),

            orderTotal:
              order.orderTotal,

            itemCount:
              order.itemCount,

            items:
              order.items,

            status:
              "confirmed",

            source:
              order.source ||
              `imap-live-${retailerKey}`
          };

          const wasSaved =
            await recordSuccessCheckout(
              successRecord
            );

          if (wasSaved) {
            saved += 1;
          } else {
            duplicates += 1;
          }
        }

        liveSuccessMailboxScanSince.set(mailboxKey, Date.now());

      } catch (error) {
        /*
          Do not expose mailbox credentials or raw
          provider responses in production logs.
        */
        failedMailboxes++;
        console.error("Live retailer Success mailbox sync failed:", JSON.stringify({
          reason: mailboxFailureReason(error),
          phase: error?.mailboxPhase || "configuration",
          provider: getImapProvider(mailbox.email)?.name || "unsupported"
        }));
      }
    }

    liveSuccessLastSyncByAccount
      .set(
        accountId,
        Date.now()
      );

    if (mailboxes.length) console.log("Live retailer Success sync completed:", JSON.stringify({
      checked: mailboxes.length, connected: mailboxes.length - failedMailboxes,
      failed: failedMailboxes, saved, duplicates
    }));
    return {
      failedMailboxes,
      connectedMailboxes: mailboxes.length - failedMailboxes,
      scanned:
        true,

      saved,
      duplicates,
      parsedOrders,

      mailboxes:
        mailboxes.length
    };

  } finally {
    liveSuccessAccountLocks.delete(
      accountId
    );
  }
}



function managedSuccessMailboxConfig() {
  const email =
    normalizeEmail(
      process.env
        .MANAGED_SUCCESS_IMAP_EMAIL
    );

  const password =
    String(
      process.env
        .MANAGED_SUCCESS_IMAP_PASSWORD ||
      ""
    );

  const host =
    String(
      process.env
        .MANAGED_SUCCESS_IMAP_HOST ||
      ""
    ).trim();

  const port =
    Number(
      process.env
        .MANAGED_SUCCESS_IMAP_PORT ||
      993
    );

  return {
    email,
    password,
    host,
    port:
      Number.isFinite(port)
        ? port
        : 993,

    configured:
      Boolean(
        email &&
        password &&
        host
      )
  };
}


let managedSuccessLastScannedUid = 0;
const managedSuccessScanStatus = {
  lastAttemptAt: null,
  lastCompletedAt: null,
  lastError: null,
  parsedOrders: 0,
  savedOrders: 0,
  unmatchedOrders: 0,
  progress: { phase: "idle", percent: 0, processed: 0, total: 0, recognized: 0, saved: 0 }
};
let managedSuccessScanPromise = null;

async function readRecentManagedWorkMailboxOrders(
  maxMessages = 120,
  onProgress = () => {}
) {
  const config =
    managedSuccessMailboxConfig();

  if (
    !config.configured
  ) {
    return {
      configured:
        false,
      orders: []
    };
  }

  const client =
    protectImapClient(new ImapFlow({
      host:
        config.host,

      port:
        config.port,

      secure:
        true,

      auth: {
        user:
          config.email,

        pass:
          normalizeImapPassword(config.email, config.password)
      },

      logger:
        false,

      connectionTimeout:
        15000,

      greetingTimeout:
        10000,

      socketTimeout:
        30000,

      disableAutoIdle:
        true
    }));

  try {
    onProgress({ phase: "connecting", percent: 2, processed: 0, total: 0 });
    await client.connect();

    const lock =
      await client.getMailboxLock(
        "INBOX",
        {
          readOnly: true
        }
      );

    try {
      const total =
        Number(
          client.mailbox?.exists ||
          0
        );

      if (!total) {
        return {
          configured:
            true,
          orders: []
        };
      }

      const batchSize =
        Math.min(
          250,
          Math.max(
            20,
            Number(
              maxMessages
            ) ||
            120
          )
        );

      onProgress({ phase: "searching", percent: 5, processed: 0, total: 0 });
      const matchingUids = await client.search({ or: [
        { subject: "order" }, { subject: "purchase" },
        { subject: "receipt" }, { subject: "confirmation" }
      ] }, { uid: true });
      const pendingUids = matchingUids
        .filter(uid => Number(uid) > managedSuccessLastScannedUid)
        .sort((a, b) => Number(a) - Number(b));
      onProgress({ phase: "loading", percent: 10, processed: 0, total: pendingUids.length });
      const candidates = [];
      for (let offset = 0; offset < pendingUids.length; offset += batchSize) {
        candidates.push(...await client.fetchAll(
          pendingUids.slice(offset, offset + batchSize),
          { uid: true, envelope: true, internalDate: true },
          { uid: true }
        ));
        onProgress({ phase: "loading", percent: pendingUids.length ? 10 + Math.floor(10 * Math.min(candidates.length, pendingUids.length) / pendingUids.length) : 20, processed: 0, total: pendingUids.length });
      }

      const orders = [];
      let processed = 0;
      let sourceBatch = new Map();

      for (
        const candidate of
        candidates
      ) {
        processed += 1;
        onProgress({ phase: "checking", percent: 20 + Math.floor(60 * (processed - 1) / Math.max(1, candidates.length)), processed: processed - 1, total: candidates.length, recognized: orders.length, saved: 0 });
        const subject =
          String(
            candidate
              .envelope
              ?.subject ||
            ""
          );

        if (
          !/order|purchase|receipt|confirmation/i.test(
            subject
          )
        ) {
          continue;
        }

        if (!sourceBatch.has(Number(candidate.uid))) {
          const batchUids = candidates.slice(processed - 1, processed - 1 + 25).map(item => item.uid);
          const messages = await client.fetchAll(batchUids, {
            uid: true, envelope: true, internalDate: true, source: true
          }, { uid: true });
          sourceBatch = new Map(messages.map(item => [Number(item.uid), item]));
        }
        const message = sourceBatch.get(Number(candidate.uid));

        if (
          !message?.source
        ) {
          continue;
        }

        const common = {
          subject:
            message.envelope
              ?.subject ||
            subject,

          sender:
            (
              message.envelope
                ?.from ||
              []
            )
              .map(
                address =>
                  `${address?.name || ""} <${address?.address || ""}>`
              )
              .join(" "),

          source:
            message.source,

          uid:
            message.uid,

          messageId:
            message.envelope
              ?.messageId ||
            "",

          date:
            (
              message.envelope?.date ||
              message.internalDate
            )
              ? new Date(
                  message.envelope?.date ||
                  message.internalDate
                ).toISOString()
              : null
        };

        let parsed =
          null;

        if (!parsed) {
          parsed =
            await parseCostcoOrder(
              common
            );
        }

        if (!parsed) {
          parsed =
            await parsePokemonCenterOrder(
              common
            );
        }

        if (!parsed) {
          parsed =
            await parseWalmartOrder(
              common
            );
        }

        if (!parsed) {
          parsed =
            await parseTargetTestOrder(
              common
            );
        }

        if (parsed) {
          orders.push({
            ...parsed,

            messageId:
              parsed.messageId ||
              common.messageId ||
              "",

            mailboxUid:
              parsed.mailboxUid ||
              common.uid ||
              null,

            routingEmails:
              extractRoutingEmailsFromSource(
                message.source
              )
          });
        }
        onProgress({ phase: "checking", percent: 20 + Math.floor(60 * processed / Math.max(1, candidates.length)), processed, total: candidates.length, recognized: orders.length, saved: 0 });
      }

      return {
        configured:
          true,
        orders,
        lastUid: pendingUids.length ? Number(pendingUids.at(-1)) : 0
      };

    } finally {
      lock.release();
    }

  } finally {
    if (client.usable) {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    } else {
      client.close();
    }
  }
}


async function managedAccountEmailMap() {
  const accounts =
    await getManagedAccounts();

  const map =
    new Map();

  for (
    const account of
    accounts
  ) {
    let credentials =
      emptyRetailerCredentials();

    try {
      if (
        account.credentials
      ) {
        credentials =
          normalizeRetailerCredentials(
            decryptJson(
              account.credentials
            )
          );
      }
    } catch {
      continue;
    }

    for (
      const retailer of
      RETAILER_KEYS
    ) {
      const email =
        normalizeEmail(
          credentials
            ?.[retailer]
            ?.username
        );

      if (
        !email ||
        !email.includes(
          "@"
        )
      ) {
        continue;
      }

      map.set(
        email,
        {
          managedAccountId:
            String(
              account.id
            ),
          retailer
        }
      );
    }
  }

  return map;
}


function assignmentTimeContainsCheckout(
  assignment,
  checkoutAt
) {
  const checkout =
    new Date(
      checkoutAt ||
      0
    ).getTime();

  if (
    !Number.isFinite(
      checkout
    )
  ) {
    return false;
  }

  const start =
    new Date(
      assignment.startsAt ||
      assignment.createdAt ||
      0
    ).getTime();

  if (
    Number.isFinite(start) &&
    checkout < start
  ) {
    return false;
  }

  const endValue =
    assignment.endedAt ||
    assignment.expiresAt ||
    null;

  if (endValue) {
    const end =
      new Date(
        endValue
      ).getTime();

    if (
      Number.isFinite(end) &&
      checkout > end
    ) {
      return false;
    }
  }

  return true;
}


async function managedAssignmentHistory() {
  const [
    freeAssignments,
    rentalAssignments
  ] = await Promise.all([
    getFreeAssignments(),
    getRentalAssignments()
  ]);

  return [
    ...freeAssignments.map(
      item => ({
        ...item,
        assignmentType:
          "gifted",
        managedAccountId:
          item.managedAccountId ||
          item.freeMembershipId ||
          null
      })
    ),

    ...rentalAssignments.map(
      item => ({
        ...item,
        assignmentType:
          "rented",
        managedAccountId:
          item.managedAccountId ||
          item.rentedMembershipId ||
          null
      })
    )
  ];
}


async function syncManagedProfileSuccessMailbox() {
  const result =
    await readRecentManagedWorkMailboxOrders(
      180,
      progress => { managedSuccessScanStatus.progress = progress; }
    );

  if (
    !result.configured
  ) {
    return {
      configured:
        false,
      saved:
        0,
      unmatched:
        0
    };
  }

  const emailMap =
    await managedAccountEmailMap();

  const assignments =
    await managedAssignmentHistory();

  const totalOrders = result.orders.length;
  managedSuccessScanStatus.progress = { phase: "saving", percent: 80, processed: 0, total: totalOrders, recognized: totalOrders, saved: 0 };

  let saved = 0;
  let unmatched = 0;
  let processedOrders = 0;
  const updateSaveProgress = () => {
    processedOrders += 1;
    managedSuccessScanStatus.progress = { phase: "saving", percent: 80 + Math.floor(19 * processedOrders / Math.max(1, totalOrders)), processed: processedOrders, total: totalOrders, recognized: totalOrders, saved };
  };

  for (
    const order of
    result.orders
  ) {
    const routingEmails =
      Array.isArray(
        order.routingEmails
      )
        ? order.routingEmails
        : [];

    let accountMatch =
      null;

    for (
      const email of
      routingEmails
    ) {
      const candidate =
        emailMap.get(
          normalizeEmail(
            email
          )
        );

      if (candidate) {
        accountMatch =
          candidate;
        break;
      }
    }

    if (!accountMatch) {
      unmatched += 1;
      if (await recordCommunitySuccessCheckout(order)) saved += 1;
      updateSaveProgress();
      continue;
    }

    const checkoutAt =
      order.checkoutAt ||
      order.date ||
      new Date()
        .toISOString();

    const assignment =
      assignments
        .filter(
          item =>
            String(
              item.managedAccountId ||
              ""
            ) ===
              String(
                accountMatch
                  .managedAccountId
              ) &&
            item.customerAccountId &&
            assignmentTimeContainsCheckout(
              item,
              checkoutAt
            )
        )
        .sort(
          (a,b) =>
            new Date(
              b.startsAt ||
              b.createdAt ||
              0
            ).getTime() -
            new Date(
              a.startsAt ||
              a.createdAt ||
              0
            ).getTime()
        )[0] ||
      null;

    if (!assignment) {
      unmatched += 1;
      if (await recordCommunitySuccessCheckout(order)) saved += 1;
      updateSaveProgress();
      continue;
    }

    const retailerKey =
      String(
        order.retailer ||
        accountMatch.retailer ||
        "retailer"
      )
        .trim()
        .toLowerCase()
        .replace(
          /[^a-z0-9]+/g,
          "-"
        );

    const orderKey =
      String(
        order.orderNumber ||
        order.messageId ||
        order.mailboxUid ||
        ""
      );

    if (!orderKey) {
      unmatched += 1;
      updateSaveProgress();
      continue;
    }

    const stableId =
      `${retailerKey}:managed:${accountMatch.managedAccountId}:${orderKey}`;

    const successRecord = {
      id:
        stableId,

      customerAccountId:
        String(
          assignment
            .customerAccountId
        ),

      managedAccountId:
        String(
          accountMatch
            .managedAccountId
        ),

      managedAssignmentId:
        String(
          assignment.id
        ),

      managedAssignmentType:
        assignment
          .assignmentType,

      profileName:
        assignment
          .assignmentType ===
            "gifted"
          ? "Gifted Profile"
          : "Rented Profile",

      retailer:
        order.retailer ||
        accountMatch.retailer ||
        "Retailer",

      orderNumber:
        order.orderNumber,

      checkoutAt,

      orderTotal:
        order.orderTotal,

      itemCount:
        order.itemCount,

      items:
        order.items,

      status:
        "confirmed",

      source:
        `managed-work-mailbox-${retailerKey}`
    };

    const checkoutAge = Date.now() - new Date(checkoutAt).getTime();
    const wasSaved = await recordSuccessCheckout(successRecord, {
      notifyDiscord: Number.isFinite(checkoutAge) && checkoutAge >= 0 && checkoutAge < 10 * 60 * 1000
    });

    if (wasSaved) {
      saved += 1;
    }
    updateSaveProgress();
  }

  if (result.lastUid) {
    managedSuccessLastScannedUid = Math.max(managedSuccessLastScannedUid, result.lastUid);
  }

  return {
    configured:
      true,
    saved,
    unmatched,
    scanned:
      result.orders.length
  };
}


async function syncAllActiveCustomerSuccess() {
  if (
    liveSuccessCycleRunning
  ) {
    return;
  }

  liveSuccessCycleRunning =
    true;

  try {
    const paid =
      await readJson(
        PAID_FILE,
        []
      );

    const paidRecords =
      Array.isArray(paid)
        ? paid
        : [];

    const accountIds =
      [
        ...new Set(
          paidRecords
            .filter(
              record =>
                record.customerAccountId &&
                subscriptionAllowsProfiles(
                  record
                )
            )
            .map(
              record =>
                String(
                  record.customerAccountId
                )
            )
        )
      ];

    /*
      Sequential mailbox connections are intentional.
      They avoid creating a large burst of simultaneous
      IMAP logins when the site has many customers.
    */
    for (
      const accountId of
      accountIds
    ) {
      await syncCustomerTargetSuccess(
        accountId
      );
    }

  } catch (error) {
    console.error(
      "Live Success sync cycle failed:",
      error?.code ||
      error?.name ||
      "success_sync_cycle_error"
    );

  } finally {
    liveSuccessCycleRunning =
      false;
  }
}

/* Keep the managed mailbox on its own schedule so customer inbox scans
   cannot delay its first run. Concurrent manual and scheduled scans share
   one connection and one import pass. */
function runManagedSuccessScan() {
  if (managedSuccessScanPromise) return managedSuccessScanPromise;
  managedSuccessScanStatus.lastAttemptAt = new Date().toISOString();
  managedSuccessScanStatus.lastError = null;
  managedSuccessScanStatus.progress = { phase: "connecting", percent: 0, processed: 0, total: 0, recognized: 0, saved: 0 };
  managedSuccessScanPromise = (async () => {
    try {
      const result = await syncManagedProfileSuccessMailbox();
      managedSuccessScanStatus.lastCompletedAt = new Date().toISOString();
      managedSuccessScanStatus.parsedOrders = result.scanned || 0;
      managedSuccessScanStatus.savedOrders = result.saved || 0;
      managedSuccessScanStatus.unmatchedOrders = result.unmatched || 0;
      console.log("Managed Success mailbox reconciliation:", JSON.stringify({ configured: result.configured, parsed: result.scanned || 0, saved: result.saved || 0, unmatched: result.unmatched || 0 }));
      managedSuccessScanStatus.progress = { phase: "complete", percent: 100, processed: result.scanned || 0, total: result.scanned || 0, recognized: result.scanned || 0, saved: result.saved || 0 };
      return result;
    } catch (error) {
      managedSuccessScanStatus.lastError = error?.authenticationFailed ||
        error?.code === "AUTHENTICATIONFAILED" ? "authentication_failed" : "scan_failed";
      managedSuccessScanStatus.progress = { ...managedSuccessScanStatus.progress, phase: "failed", percent: null };
      console.error("Managed Success mailbox scan failed:", error?.code || error?.name || "scan_error");
      throw error;
    } finally {
      managedSuccessScanPromise = null;
    }
  })();
  return managedSuccessScanPromise;
}


function startLiveSuccessScheduler() {
  /*
    Start shortly after boot so initialization finishes
    first, then scan every configured interval.
  */
  const firstRun =
    setTimeout(
      () => {
        syncAllActiveCustomerSuccess()
          .catch(() => {});
        runManagedSuccessScan().catch(() => {});
        for (const delay of [30000, 90000, 180000]) {
          const progressLog = setTimeout(() => console.log("Managed Success mailbox scan progress:", JSON.stringify({
            running: Boolean(managedSuccessScanPromise), progress: managedSuccessScanStatus.progress,
            lastError: managedSuccessScanStatus.lastError, parsedOrders: managedSuccessScanStatus.parsedOrders,
            savedOrders: managedSuccessScanStatus.savedOrders
          })), delay);
          progressLog.unref?.();
        }

        reconcileLapsedMembershipNotifications()
          .catch(() => {});
      },
      20 * 1000
    );

  if (
    typeof firstRun.unref ===
    "function"
  ) {
    firstRun.unref();
  }

  const interval =
    setInterval(
      () => {
        syncAllActiveCustomerSuccess()
          .catch(() => {});
        runManagedSuccessScan().catch(() => {});

        reconcileLapsedMembershipNotifications()
          .catch(() => {});
      },
      LIVE_SUCCESS_SYNC_INTERVAL_MS
    );

  if (
    typeof interval.unref ===
    "function"
  ) {
    interval.unref();
  }
}





/* -------------------------------------------------------
   ADMIN COSTCO PARSER TEST
   Diagnostic only: reads the latest Costco confirmation
   from IMAP_TEST_EMAIL and does not save production data.
------------------------------------------------------- */

app.get(
  "/api/admin/test-imap/costco-order",
  requireAdmin,
  async (req, res) => {
    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    try {
      const email =
        normalizeEmail(
          process.env
            .IMAP_TEST_EMAIL
        );

      const password =
        String(
          process.env
            .IMAP_TEST_PASSWORD ||
          ""
        );

      if (
        !email ||
        !password
      ) {
        return res
          .status(500)
          .json({
            ok: false,
            error:
              "IMAP test credentials are not configured."
          });
      }

      const result =
        await readRecentRetailerOrders(
          email,
          password,
          120
        );

      const costcoOrders =
        result.orders
          .filter(
            order =>
              String(
                order?.retailer ||
                ""
              ).toLowerCase() ===
              "costco"
          );

      const order =
        costcoOrders.at(-1) ||
        null;

      if (!order) {
        return res
          .status(404)
          .json({
            ok: false,
            matched:
              false,
            error:
              "No Costco order confirmation was found in the recent test mailbox messages."
          });
      }

      return res.json({
        ok: true,
        matched:
          true,
        provider:
          result.provider,

        order: {
          retailer:
            order.retailer,
          orderNumber:
            order.orderNumber,
          checkoutAt:
            order.checkoutAt,
          itemCount:
            order.itemCount,
          orderTotal:
            order.orderTotal,
          items:
            order.items
        }
      });

    } catch (error) {
      console.error(
        "Costco parser diagnostic failed:",
        error?.code ||
        error?.name ||
        "costco_parser_error"
      );

      return res
        .status(502)
        .json({
          ok: false,
          error:
            "The Costco test order could not be parsed."
        });
    }
  }
);


/* -------------------------------------------------------
   ADMIN PKC PARSER TEST
   Diagnostic only: reads the latest Pokemon Center
   confirmation from IMAP_TEST_EMAIL and does not save
   anything into production Success.
------------------------------------------------------- */

app.get(
  "/api/admin/test-imap/pkc-order",
  requireAdmin,
  async (req, res) => {
    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    try {
      const email =
        normalizeEmail(
          process.env
            .IMAP_TEST_EMAIL
        );

      const password =
        String(
          process.env
            .IMAP_TEST_PASSWORD ||
          ""
        );

      if (
        !email ||
        !password
      ) {
        return res
          .status(500)
          .json({
            ok: false,
            error:
              "IMAP test credentials are not configured."
          });
      }

      const result =
        await readRecentRetailerOrders(
          email,
          password,
          100
        );

      const pkcOrders =
        result.orders
          .filter(
            order =>
              String(
                order?.retailer ||
                ""
              ).toLowerCase() ===
              "pkc"
          );

      const order =
        pkcOrders.at(-1) ||
        null;

      if (!order) {
        return res
          .status(404)
          .json({
            ok: false,
            matched:
              false,
            error:
              "No Pokemon Center order confirmation was found in the recent test mailbox messages."
          });
      }

      return res.json({
        ok: true,
        matched:
          true,
        provider:
          result.provider,

        order: {
          retailer:
            order.retailer,
          orderNumber:
            order.orderNumber,
          checkoutAt:
            order.checkoutAt,
          itemCount:
            order.itemCount,
          orderTotal:
            order.orderTotal,
          items:
            order.items
        }
      });

    } catch (error) {
      console.error(
        "PKC parser diagnostic failed:",
        error?.code ||
        error?.name ||
        "pkc_parser_error"
      );

      return res
        .status(502)
        .json({
          ok: false,
          error:
            "The Pokemon Center test order could not be parsed."
        });
    }
  }
);


/* -------------------------------------------------------
   ADMIN WALMART PARSER TEST
   Reads the newest Walmart confirmation from the
   configured IMAP test mailbox. Diagnostic only:
   nothing is saved to production Success.
------------------------------------------------------- */

app.get(
  "/api/admin/test-imap/walmart-order",
  requireAdmin,
  async (req, res) => {
    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    try {
      const email =
        normalizeEmail(
          process.env
            .IMAP_TEST_EMAIL
        );

      const password =
        String(
          process.env
            .IMAP_TEST_PASSWORD ||
          ""
        );

      if (
        !email ||
        !password
      ) {
        return res
          .status(500)
          .json({
            ok: false,
            error:
              "IMAP test credentials are not configured."
          });
      }

      const result =
        await readRecentRetailerOrders(
          email,
          password,
          80
        );

      const walmartOrders =
        result.orders
          .filter(
            order =>
              String(
                order?.retailer ||
                ""
              ).toLowerCase() ===
              "walmart"
          );

      const order =
        walmartOrders.at(-1) ||
        null;

      if (!order) {
        return res
          .status(404)
          .json({
            ok: false,
            matched:
              false,
            error:
              "No Walmart order confirmation was found in the recent test mailbox messages."
          });
      }

      return res.json({
        ok: true,
        matched:
          true,
        provider:
          result.provider,

        order: {
          retailer:
            order.retailer,
          orderNumber:
            order.orderNumber,
          checkoutAt:
            order.checkoutAt,
          itemCount:
            order.itemCount,
          orderTotal:
            order.orderTotal,
          items:
            order.items
        }
      });

    } catch (error) {
      console.error(
        "Walmart parser diagnostic failed:",
        error?.code ||
        error?.name ||
        "walmart_parser_error"
      );

      return res
        .status(502)
        .json({
          ok: false,
          error:
            "The Walmart test order could not be parsed."
        });
    }
  }
);


app.get(
  "/api/admin/test-target-html-images",
  requireAdmin,
  (req, res) => {
    const testHtml = `
      <html>
        <body>

          <!-- RETAILER LOGO — SHOULD NOT MATCH PRODUCT -->

          <img
            src="https://placehold.co/600x150.png?text=TARGET"
            alt="Target"
            width="600"
            height="150"
          >


          <!-- TRACKING PIXEL — SHOULD BE REMOVED -->

          <img
            src="https://placehold.co/1x1.png"
            alt=""
            width="1"
            height="1"
          >


          <!-- PRODUCT 1 -->

          <div class="product">

            <img
              src="https://placehold.co/400x400.png?text=Ascended+Heroes+Tin"
              alt="Pokemon Trading Card Game: Ascended Heroes Tin"
              width="400"
              height="400"
            >

            <div>
              Pokemon Trading Card Game:
              Ascended Heroes Tin
            </div>

          </div>


          <!-- PRODUCT 2 -->

          <div class="product">

            <img
              src="https://placehold.co/400x400.png?text=Elite+Trainer+Box"
              alt="Pokemon Trading Card Game: Elite Trainer Box"
              width="400"
              height="400"
            >

            <div>
              Pokemon Trading Card Game:
              Elite Trainer Box
            </div>

          </div>


          <!-- PRODUCT 3 -->

          <div class="product">

            <img
              src="https://placehold.co/400x400.png?text=Booster+Bundle"
              alt="Pokemon Trading Card Game: Booster Bundle"
              width="400"
              height="400"
            >

            <div>
              Pokemon Trading Card Game:
              Booster Bundle
            </div>

          </div>

        </body>
      </html>
    `;


    const images =
      extractEmailImageUrls(
        testHtml
      );


    /*
      These are the same product names our
      Target parser produced from the IMAP test.
    */

    const products = [
      {
        name:
          "Pokemon Trading Card Game: Ascended Heroes Tin"
      },

      {
        name:
          "Pokemon Trading Card Game: Elite Trainer Box"
      },

      {
        name:
          "Pokemon Trading Card Game: Booster Bundle"
      }
    ];


    const normalizeProductText =
      value =>
        String(value || "")
          .toLowerCase()
          .replace(
            /[^a-z0-9]+/g,
            " "
          )
          .trim();


    const matchedProducts =
      products.map(
        product => {
          const productName =
            normalizeProductText(
              product.name
            );


          const matchingImage =
            images.find(
              image => {
                const alt =
                  normalizeProductText(
                    image.alt
                  );

                const title =
                  normalizeProductText(
                    image.title
                  );


                return (
                  alt ===
                    productName ||
                  title ===
                    productName ||
                  (
                    alt &&
                    (
                      alt.includes(
                        productName
                      ) ||
                      productName.includes(
                        alt
                      )
                    )
                  ) ||
                  (
                    title &&
                    (
                      title.includes(
                        productName
                      ) ||
                      productName.includes(
                        title
                      )
                    )
                  )
                );
              }
            );


          return {
            name:
              product.name,

            imageUrl:
              matchingImage
                ?.imageUrl ||
              null
          };
        }
      );


    return res.json({
      ok: true,

      extractedImages:
        images.length,

      matchedProducts:
        matchedProducts.filter(
          product =>
            !!product.imageUrl
        ).length,

      products:
        matchedProducts,

      /*
        Keep this temporarily so we can verify
        that the Target logo was extracted but
        NOT assigned to a product.
      */

      detectedImages:
        images
    });
  }
);

    
/* -------------------------------------------------------
   TEMPORARY ADMIN TARGET PARSER ENDPOINT
------------------------------------------------------- */

/* -------------------------------------------------------
   TEMPORARY TARGET HTML EMAIL FIXTURE
------------------------------------------------------- */

app.post(
  "/api/admin/send-target-image-test",
  requireAdmin,
  async (req, res) => {
    try {
      const testEmail =
        normalizeEmail(
          process.env.IMAP_TEST_EMAIL
        );

      if (
        !testEmail ||
        !process.env.RESEND_API_KEY
      ) {
        return res
          .status(500)
          .json({
            error:
              "Target image test email is not configured."
          });
      }

      const orderNumber =
        "9876543210457";

      const html = `
        <!doctype html>
        <html>
          <body
            style="
              font-family: Arial, sans-serif;
              color: #111;
            "
          >
            <img
              src="https://placehold.co/600x150.png?text=TARGET"
              alt="Target"
              width="600"
              height="150"
            >

            <img
              src="https://placehold.co/1x1.png"
              alt=""
              width="1"
              height="1"
            >

            <p>
              Thanks for your order!
            </p>

            <p>
              Order #${orderNumber}
            </p>

            <div>
              <img
                src="https://placehold.co/400x400.png?text=Ascended+Heroes+Tin"
                alt="Pokemon Trading Card Game: Ascended Heroes Tin"
                width="400"
                height="400"
              >

              <p>
                Pokemon Trading Card Game: Ascended Heroes Tin<br>
                Quantity: 4<br>
                $39.99 each
              </p>
            </div>

            <div>
              <img
                src="https://placehold.co/400x400.png?text=Elite+Trainer+Box"
                alt="Pokemon Trading Card Game: Elite Trainer Box"
                width="400"
                height="400"
              >

              <p>
                Pokemon Trading Card Game: Elite Trainer Box<br>
                Quantity: 2<br>
                $54.99 each
              </p>
            </div>

            <div>
              <img
                src="https://placehold.co/400x400.png?text=Booster+Bundle"
                alt="Pokemon Trading Card Game: Booster Bundle"
                width="400"
                height="400"
              >

              <p>
                Pokemon Trading Card Game: Booster Bundle<br>
                Quantity: 1<br>
                $29.99 each
              </p>
            </div>

            <p>
              Order total: $299.93
            </p>

            <p>
              Your order has been confirmed.
            </p>
          </body>
        </html>
      `;

      const textBody =
`Thanks for your order!

Order #${orderNumber}

Pokemon Trading Card Game: Ascended Heroes Tin
Quantity: 4
$39.99 each

Pokemon Trading Card Game: Elite Trainer Box
Quantity: 2
$54.99 each

Pokemon Trading Card Game: Booster Bundle
Quantity: 1
$29.99 each

Order total: $299.93

Your order has been confirmed.`;

      const response =
        await fetch(
          "https://api.resend.com/emails",
          {
            method: "POST",

            headers: {
              Authorization:
                `Bearer ${process.env.RESEND_API_KEY}`,

              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify({
                from:
                  process.env.FROM_EMAIL ||
                  "SLABSNGRABSACO <onboarding@resend.dev>",

                to: [
                  testEmail
                ],

                subject:
                  `Your Target order is confirmed - Order #${orderNumber}`,

                text:
                  textBody,

                html
              })
          }
        );

      const result =
        await response
          .json()
          .catch(() => ({}));

      if (!response.ok) {
        console.error(
          "Target image fixture send failed:",
          response.status,
          result
        );

        return res
          .status(500)
          .json({
            error:
              "Unable to send Target image test email."
          });
      }

      return res.json({
        ok: true,
        sent: true,
        orderNumber,
        message:
          "Target HTML image test email sent."
      });

    } catch (error) {
      console.error(
        "Target image fixture error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to send Target image test email."
        });
    }
  }
);

app.get(
  "/api/admin/test-imap/target-html-debug",
  requireAdmin,
  async (req, res) => {
    try {
      const email =
        normalizeEmail(
          process.env.IMAP_TEST_EMAIL
        );

      const password =
        String(
          process.env.IMAP_TEST_PASSWORD ||
          ""
        );

      if (!email || !password) {
        return res
          .status(500)
          .json({
            error:
              "IMAP test credentials are not configured."
          });
      }

      const provider =
        getImapProvider(email);

      if (!provider) {
        return res
          .status(400)
          .json({
            error:
              "Unsupported IMAP test provider."
          });
      }

      const {
  client
} =
  createCustomerImapClient(
    email,
    password
  );

      try {
        await client.connect();

        const lock =
          await client.getMailboxLock(
            "INBOX"
          );

        try {
          const messages = [];

          for await (
            const message of client.fetch(
              "1:*",
              {
                uid: true,
                envelope: true,
                internalDate: true,
                source: true
              }
            )
          ) {
            const subject =
              String(
                message.envelope
                  ?.subject || ""
              );

            if (
              !/target/i.test(subject) ||
              !/order/i.test(subject)
            ) {
              continue;
            }

            messages.push(message);
          }

          const message =
            messages.at(-1);

          if (!message) {
            return res
              .status(404)
              .json({
                error:
                  "No Target order email was found."
              });
          }

          const decoded =
            await decodeImapMessage(
              message.source
            );

          const images =
            extractEmailImageUrls(
              decoded.html
            );

          return res.json({
            ok: true,

            subject:
              message.envelope
                ?.subject || "",

            hasText:
              !!decoded.text,

            textLength:
              decoded.text.length,

            hasHtml:
              !!decoded.html,

            htmlLength:
              decoded.html.length,

            imageCount:
              images.length,

            images,

            /*
              Only return a small sanitized HTML
              preview. Do not return the entire
              customer's email body.
            */
            htmlPreview:
              decoded.html
                .slice(0, 1500)
                .replace(
                  /[\r\n\t]+/g,
                  " "
                )
          });

        } finally {
          lock.release();
        }

      } finally {
        try {
          await client.logout();
        } catch {
          // Ignore logout errors.
        }
      }

    } catch (error) {
      console.error(
        "Target HTML debug error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to inspect the Target test email."
        });
    }
  }
);

/* -------------------------------------------------------
   TEMPORARY SUCCESS TEST STORAGE
   Completely separate from real customer Success data.
------------------------------------------------------- */

async function getTestSuccessCheckouts() {
  const records =
    await readJson(
      SUCCESS_CHECKOUTS_TEST_FILE,
      []
    );

  return Array.isArray(records)
    ? records
    : [];
}


async function saveTestSuccessCheckouts(
  records
) {
  await writeJson(
    SUCCESS_CHECKOUTS_TEST_FILE,
    records
  );
}


function sameTestCheckout(
  existing,
  incoming
) {
  /*
    Primary dedupe:
    same mailbox message.
  */

  if (
    incoming.messageId &&
    existing.messageId &&
    String(existing.messageId) ===
      String(incoming.messageId)
  ) {
    return true;
  }

  /*
    Secondary dedupe:
    same retailer + order number.

    This prevents the same order from being
    counted twice even if the retailer sends
    another confirmation message.
  */

  return (
    String(
      existing.retailer || ""
    ).toLowerCase() ===
      String(
        incoming.retailer || ""
      ).toLowerCase() &&

    String(
      existing.orderNumber || ""
    ).toLowerCase() ===
      String(
        incoming.orderNumber || ""
      ).toLowerCase()
  );
}


async function persistTargetTestOrder(
  order
) {
  if (
    !order ||
    !order.orderNumber
  ) {
    throw new Error(
      "INVALID_TEST_ORDER"
    );
  }

  const records =
    await getTestSuccessCheckouts();

  const duplicate =
    records.find(record =>
      sameTestCheckout(
        record,
        order
      )
    );

  if (duplicate) {
    return {
      saved: false,
      duplicate: true,
      record: duplicate,
      totalStored:
        records.length
    };
  }

  const now =
    new Date()
      .toISOString();

  const record = {
    id:
      crypto.randomUUID(),

    customerAccountId:
      "TEST-ACCOUNT",

    profileSlot: 1,

    profileName:
      "IMAP Test Profile",

    source:
      "imap-test",

    retailer:
      clean(
        order.retailer,
        100
      ),

    orderNumber:
      clean(
        order.orderNumber,
        100
      ),

    messageId:
      clean(
        order.messageId,
        500
      ),

    mailboxUid:
      clean(
        order.mailboxUid,
        100
      ),

    checkoutAt:
      order.checkoutAt ||
      now,

    orderTotal:
      Number(
        order.orderTotal || 0
      ),

    itemCount:
      Number(
        order.itemCount || 0
      ),

    items:
  Array.isArray(order.items)
    ? order.items.map(item => ({
        name:
          clean(
            item?.name,
            300
          ),

        quantity:
          Number(
            item?.quantity || 0
          ),

        price:
          item?.price === null ||
          item?.price === undefined
            ? null
            : Number(
                item.price
              ),

        imageUrl:
          safeSuccessImageUrl(
            item?.imageUrl
          )
      }))
    : [],

    status:
      "confirmed",

    createdAt: now,

    updatedAt: now
  };

  records.push(record);

  await saveTestSuccessCheckouts(
    records
  );

  return {
    saved: true,
    duplicate: false,
    record,
    totalStored:
      records.length
  };
}

/* -------------------------------------------------------
   TEMPORARY EXACT TARGET UID PARSER TEST
   Reads UID 24 directly.
   Does NOT save anything.
------------------------------------------------------- */

/* -------------------------------------------------------
   TEMPORARY TARGET UID 24 ITEM CONTEXT DEBUG
   Read-only. Does not save anything.
------------------------------------------------------- */

app.get(
  "/api/admin/test-imap/target-uid24-item-debug",
  requireAdmin,
  async (req, res) => {
    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    const testEmail =
      normalizeEmail(
        process.env.IMAP_TEST_EMAIL
      );

    const testPassword =
      String(
        process.env.IMAP_TEST_PASSWORD ||
        ""
      );

    if (
      !testEmail ||
      !testPassword
    ) {
      return res
        .status(500)
        .json({
          ok: false,
          error:
            "Test mailbox environment variables are not configured."
        });
    }

    const {
      provider,
      client
    } =
      createCustomerImapClient(
        testEmail,
        testPassword
      );

    try {
      await client.connect();

      const lock =
        await client.getMailboxLock(
          "INBOX",
          {
            readOnly: true
          }
        );

      try {
        const message =
          await client.fetchOne(
            24,
            {
              uid: true,
              envelope: true,
              source: true
            },
            {
              uid: true
            }
          );

        if (
          !message ||
          !message.source
        ) {
          return res
            .status(404)
            .json({
              ok: false,
              error:
                "UID 24 could not be found."
            });
        }

        const decoded =
          await decodeImapMessage(
            message.source
          );

        const text =
          String(
            decoded.text || ""
          );

        const html =
          String(
            decoded.html || ""
          );

        const lines =
          text
            .split(/\r?\n/)
            .map(line =>
              clean(
                line,
                500
              )
            )
            .filter(Boolean);

        /*
          Find the real purchased-item quantity
          line from the Target order.
        */

        const qtyIndex =
          lines.findIndex(line =>
            /^qty\s*:\s*2\b/i.test(
              line
            )
          );

        let contextLines = [];

        if (qtyIndex >= 0) {
          contextLines =
            lines.slice(
              Math.max(
                0,
                qtyIndex - 12
              ),
              Math.min(
                lines.length,
                qtyIndex + 8
              )
            );
        }

        /*
          Keep this diagnostic privacy-safe:
          only return lines relevant to the item,
          URLs, quantity, and price.
        */

        contextLines =
          contextLines.filter(line =>
            /pokemon/i.test(line) ||
            /qty\s*:/i.test(line) ||
            /\$69\.99/i.test(line) ||
            /https?:\/\//i.test(line) ||
            /elite\s+trainer/i.test(line)
          );

        const images =
          extractEmailImageUrls(
            html
          )
            .filter(image =>
              /pokemon/i.test(
                String(
                  image.alt || ""
                )
              ) ||
              /elite\s+trainer/i.test(
                String(
                  image.alt || ""
                )
              ) ||
              /pokemon/i.test(
                String(
                  image.title || ""
                )
              )
            )
            .slice(
              0,
              10
            )
            .map(image => ({
              alt:
                clean(
                  image.alt,
                  500
                ),

              title:
                clean(
                  image.title,
                  500
                ),

              imageUrl:
                safeSuccessImageUrl(
                  image.imageUrl
                )
            }));

        return res.json({
          ok: true,

          provider:
            provider.name,

          uid:
            message.uid,

          subject:
            clean(
              message.envelope
                ?.subject,
              300
            ),

          qtyLineFound:
            qtyIndex >= 0,

          qtyLineIndex:
            qtyIndex,

          contextLines,

          images
        });

      } finally {
        lock.release();
      }

    } catch (error) {
      console.error(
        "Target UID 24 item debug failed:",
        error?.code ||
        error?.name ||
        "target_item_debug_error"
      );

      return res
        .status(502)
        .json({
          ok: false,
          error:
            "Unable to inspect the Target test message."
        });

    } finally {
      if (client.usable) {
        try {
          await client.logout();
        } catch {
          client.close();
        }
      } else {
        client.close();
      }
    }
  }
);

app.get(
  "/api/admin/test-imap/target-order-uid24",
  requireAdmin,
  async (req, res) => {
    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    const testEmail =
      normalizeEmail(
        process.env.IMAP_TEST_EMAIL
      );

    const testPassword =
      String(
        process.env.IMAP_TEST_PASSWORD ||
        ""
      );

    if (
      !testEmail ||
      !testPassword
    ) {
      return res
        .status(500)
        .json({
          ok: false,
          error:
            "Test mailbox environment variables are not configured."
        });
    }

    const {
      provider,
      client
    } =
      createCustomerImapClient(
        testEmail,
        testPassword
      );

    try {
      await client.connect();

      const lock =
        await client.getMailboxLock(
          "INBOX",
          {
            readOnly: true
          }
        );

      try {
        const message =
          await client.fetchOne(
            24,
            {
              uid: true,
              envelope: true,
              internalDate: true,
              source: true
            },
            {
              uid: true
            }
          );

        if (
          !message ||
          !message.source
        ) {
          return res
            .status(404)
            .json({
              ok: false,
              error:
                "Target test message UID 24 could not be found."
            });
        }

        const parsed =
          await parseTargetTestOrder({
            subject:
              message.envelope
                ?.subject ||
              "",

            source:
              message.source,

            uid:
              message.uid,

            messageId:
              message.envelope
                ?.messageId ||
              "",

            date:
              (
                message.envelope?.date ||
                message.internalDate
              )
                ? new Date(
                    message.envelope?.date ||
                    message.internalDate
                  ).toISOString()
                : null
          });

        return res.json({
          ok: true,

          provider:
            provider.name,

          uid:
            message.uid,

          matched:
            !!parsed,

          order:
            parsed
        });

      } finally {
        lock.release();
      }

    } catch (error) {
      console.error(
        "Exact Target UID test failed:",
        error?.code ||
        error?.name ||
        "target_uid_test_error"
      );

      return res
        .status(502)
        .json({
          ok: false,
          error:
            "The exact Target test message could not be parsed."
        });

    } finally {
      if (client.usable) {
        try {
          await client.logout();
        } catch {
          client.close();
        }
      } else {
        client.close();
      }
    }
  }
);

/* -------------------------------------------------------
   TEMPORARY EXACT TARGET UID 24 -> SUCCESS TEST SAVE
   Saves ONLY UID 24 into isolated test Success storage.
   Does NOT touch production Success data.
------------------------------------------------------- */

app.post(
  "/api/admin/test-imap/target-order-uid24/save",
  requireAdmin,
  async (req, res) => {
    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    const testEmail =
      normalizeEmail(
        process.env.IMAP_TEST_EMAIL
      );

    const testPassword =
      String(
        process.env.IMAP_TEST_PASSWORD ||
        ""
      );

    if (
      !testEmail ||
      !testPassword
    ) {
      return res
        .status(500)
        .json({
          ok: false,
          saved: false,
          error:
            "Test mailbox environment variables are not configured."
        });
    }

    const {
      provider,
      client
    } =
      createCustomerImapClient(
        testEmail,
        testPassword
      );

    try {
      await client.connect();

      const lock =
        await client.getMailboxLock(
          "INBOX",
          {
            readOnly: true
          }
        );

      try {
        const message =
          await client.fetchOne(
            24,
            {
              uid: true,
              envelope: true,
              internalDate: true,
              source: true
            },
            {
              uid: true
            }
          );

        if (
          !message ||
          !message.source
        ) {
          return res
            .status(404)
            .json({
              ok: false,
              saved: false,
              error:
                "Target test message UID 24 could not be found."
            });
        }

        const parsed =
          await parseTargetTestOrder({
            subject:
              message.envelope
                ?.subject ||
              "",

            source:
              message.source,

            uid:
              message.uid,

            messageId:
              message.envelope
                ?.messageId ||
              "",

            date:
              (
                message.envelope?.date ||
                message.internalDate
              )
                ? new Date(
                    message.envelope?.date ||
                    message.internalDate
                  ).toISOString()
                : null
          });

        if (!parsed) {
          return res
            .status(422)
            .json({
              ok: false,
              saved: false,
              error:
                "UID 24 could not be parsed as a Target order."
            });
        }

        const persisted =
          await persistTargetTestOrder(
            parsed
          );

        return res.json({
          ok: true,

          provider:
            provider.name,

          uid:
            message.uid,

          saved:
            persisted.saved,

          duplicate:
            persisted.duplicate,

          totalStored:
            persisted.totalStored,

          order: {
            retailer:
              persisted.record.retailer,

            orderNumber:
              persisted.record.orderNumber,

            checkoutAt:
              persisted.record.checkoutAt,

            itemCount:
              persisted.record.itemCount,

            orderTotal:
              persisted.record.orderTotal,

            items:
              persisted.record.items
          }
        });

      } finally {
        lock.release();
      }

    } catch (error) {
      console.error(
        "Exact Target UID 24 save failed:",
        error?.code ||
        error?.name ||
        "target_uid24_save_error"
      );

      return res
        .status(502)
        .json({
          ok: false,
          saved: false,
          error:
            "The exact Target UID 24 order could not be saved to test storage."
        });

    } finally {
      if (client.usable) {
        try {
          await client.logout();
        } catch {
          client.close();
        }
      } else {
        client.close();
      }
    }
  }
);

app.get(
  "/api/admin/test-imap/target-order",
  requireAdmin,
  async (req, res) => {
    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    try {
      const testEmail =
        normalizeEmail(
          process.env.IMAP_TEST_EMAIL
        );

      const testPassword =
        String(
          process.env.IMAP_TEST_PASSWORD ||
          ""
        );

      if (
        !testEmail ||
        !testPassword
      ) {
        return res
          .status(500)
          .json({
            ok: false,

            error:
              "Test mailbox environment variables are not configured."
          });
      }

      const result =
        await readLatestTargetTestOrder(
          testEmail,
          testPassword
        );

      return res.json({
        ok: true,

        provider:
          result.provider,

        matched:
          result.matched,

        order:
          result.order
      });

    } catch (error) {
      if (
        error?.code ===
        "UNSUPPORTED_PROVIDER"
      ) {
        return res
          .status(400)
          .json({
            ok: false,

            error:
              "This test mailbox provider is not supported."
          });
      }

      if (
        error instanceof
          AuthenticationFailure ||
        error?.authenticationFailed ===
          true ||
        error?.code ===
          "AUTHENTICATIONFAILED"
      ) {
        return res
          .status(401)
          .json({
            ok: false,

            error:
              "Test mailbox authentication failed."
          });
      }

      console.error(
        "Target parser test failed:",
        error?.code ||
        error?.name ||
        "target_parser_error"
      );

      return res
        .status(502)
        .json({
          ok: false,

          error:
            "The Target test order could not be read right now."
        });
    }
  }
);
/* -------------------------------------------------------
   TEMPORARY ADMIN TARGET -> SUCCESS TEST SYNC
------------------------------------------------------- */

app.post(
  "/api/admin/test-imap/target-order/save",
  requireAdmin,
  async (req, res) => {
    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    try {
      const testEmail =
        normalizeEmail(
          process.env.IMAP_TEST_EMAIL
        );

      const testPassword =
        String(
          process.env.IMAP_TEST_PASSWORD ||
          ""
        );

      if (
        !testEmail ||
        !testPassword
      ) {
        return res
          .status(500)
          .json({
            ok: false,
            saved: false,
            error:
              "Test mailbox environment variables are not configured."
          });
      }

      const result =
        await readLatestTargetTestOrder(
          testEmail,
          testPassword
        );

      if (
        !result.matched ||
        !result.order
      ) {
        return res
          .status(404)
          .json({
            ok: false,
            saved: false,
            error:
              "No Target test order was found."
          });
      }

      const persisted =
        await persistTargetTestOrder(
          result.order
        );

      return res.json({
        ok: true,

        provider:
          result.provider,

        saved:
          persisted.saved,

        duplicate:
          persisted.duplicate,

        totalStored:
          persisted.totalStored,

        order: {
          retailer:
            persisted.record.retailer,

          orderNumber:
            persisted.record.orderNumber,

          checkoutAt:
            persisted.record.checkoutAt,

          itemCount:
            persisted.record.itemCount,

          orderTotal:
            persisted.record.orderTotal,

          items:
            persisted.record.items
        }
      });

    } catch (error) {
      console.error(
        "Target test persistence failed:",
        error?.code ||
        error?.name ||
        "target_test_persistence_error"
      );

      return res
        .status(502)
        .json({
          ok: false,
          saved: false,
          error:
            "The Target test order could not be saved."
        });
          }
  }
);
    

/* -------------------------------------------------------
   TEMPORARY ADMIN SUCCESS DASHBOARD TEST DATA
   Uses isolated success-checkouts-test.json only.
------------------------------------------------------- */

app.get(
  "/api/admin/test-success",
  requireAdmin,
  async (req, res) => {
    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    try {
      const records =
        await getTestSuccessCheckouts();

      const summary =
        buildSuccessSummary(
          records
        );

      return res.json({
        ok: true,

        testMode: true,

        sync: {
          status:
            "Test mailbox connected",

          lastSyncedAt:
            records.length
              ? (
                  records
                    .map(record =>
                      record.updatedAt ||
                      record.createdAt ||
                      null
                    )
                    .filter(Boolean)
                    .sort()
                    .reverse()[0] ||
                  null
                )
              : null
        },

        totalCheckouts:
          summary.totalCheckouts,

        totalItems:
          summary.totalItems,

        checkoutValue:
          summary.checkoutValue,

        bestDay:
          summary.bestDay,

        activity:
          summary.activity,

        recentCheckouts:
          summary.recentCheckouts
      });

    } catch (error) {
      console.error(
        "Admin Success test error:",
        error?.code ||
        error?.name ||
        "success_test_error"
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "Unable to load Success test data."
        });
    }
  }
);
/* -------------------------------------------------------
   TEMPORARY ADMIN IMAP TEST
   Remove after mailbox integration is verified.
------------------------------------------------------- */

app.post(
  "/api/admin/test-imap",
  requireAdmin,
  async (req, res) => {
    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    try {
      const testEmail =
        normalizeEmail(
          process.env.IMAP_TEST_EMAIL
        );

      const testPassword =
        String(
          process.env.IMAP_TEST_PASSWORD ||
          ""
        );

      if (
        !testEmail ||
        !testPassword
      ) {
        return res
          .status(500)
          .json({
            connected: false,
            error:
              "Test mailbox environment variables are not configured."
          });
      }

      const result =
        await verifyCustomerImap(
          testEmail,
          testPassword
        );

      return res.json({
        ok: true,
        connected: true,
        provider:
          result.provider,
        message:
          "Test mailbox connection successful."
      });

    } catch (error) {
      /*
        Never return the mailbox address,
        password, or raw provider response.
      */

      if (
        error?.code ===
        "UNSUPPORTED_PROVIDER"
      ) {
        return res
          .status(400)
          .json({
            connected: false,
            error:
              "This test mailbox provider is not supported yet."
          });
      }

      if (
        error?.authenticationFailed ===
          true ||
        error?.code ===
          "AUTHENTICATIONFAILED"
      ) {
        return res
          .status(401)
          .json({
            connected: false,
            error:
              "Test mailbox authentication failed. Check the app password."
          });
      }

      console.error(
        "Admin IMAP test failed:",
        error?.code ||
        error?.name ||
        "connection_error"
      );

      return res
        .status(502)
        .json({
          connected: false,
          error:
            "The test mailbox could not be connected right now."
        });
    }
  }
);

app.post(
  "/api/account/success/test-imap",
  requireCustomer,
  async (req, res) => {
    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    try {
      const accountId =
        req.customerAccount.id;

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      /*
        Only orders owned by the signed-in
        customer may supply IMAP credentials.
      */

      const ownedOrders =
        (
          Array.isArray(paid)
            ? paid
            : []
        )
          .filter(
            record =>
              record.customerAccountId ===
                accountId &&
              subscriptionAllowsProfiles(
                record
              )
          )
          .sort(
            (a, b) =>
              new Date(
                b.paidAt ||
                b.createdAt ||
                0
              ).getTime() -
              new Date(
                a.paidAt ||
                a.createdAt ||
                0
              ).getTime()
          );

      if (!ownedOrders.length) {
        return res
          .status(403)
          .json({
            connected: false,

            error:
              "An active membership with ACO setup information is required."
          });
      }

      /*
        For this first connection test we use
        the customer's newest active paid
        setup record.

        Later, when we build multi-profile
        synchronization, each mailbox will
        be mapped to its specific profile.
      */

      const order =
        ownedOrders[0];

      const secrets =
        await loadEncryptedPackage(
          order.id
        );

      const acoEmail =
        normalizeEmail(
          secrets?.acoEmail
        );

      const acoPassword =
        String(
          secrets?.acoPassword ||
          ""
        );

      if (
        !acoEmail ||
        !acoPassword
      ) {
        return res
          .status(400)
          .json({
            connected: false,

            error:
              "ACO email credentials are not configured for this account."
          });
      }

      const result =
        await verifyCustomerImap(
          acoEmail,
          acoPassword
        );

      return res.json({
        ok: true,

        connected: true,

        provider:
          result.provider,

        /*
          Deliberately return neither the
          mailbox email nor its password.
        */

        message:
          "Mailbox connection successful."
      });

    } catch (error) {
      /*
        Do not send raw IMAP server errors
        to the browser because provider
        responses may contain account
        information.
      */

      if (
        error?.code ===
        "UNSUPPORTED_PROVIDER"
      ) {
        return res
          .status(400)
          .json({
            connected: false,

            error:
              "This mailbox provider is not supported yet."
          });
      }

      if (
        error instanceof
          AuthenticationFailure ||
        error?.authenticationFailed ===
          true
      ) {
        return res
          .status(401)
          .json({
            connected: false,

            error:
              "Mailbox authentication failed. Check the ACO email app password."
          });
      }

      console.error(
        "IMAP connection test failed:",
        error?.code ||
        error?.name ||
        "connection_error"
      );

      return res
        .status(502)
        .json({
          connected: false,

          error:
            "The mailbox could not be connected right now."
        });
    }
  }
);

app.get(
  "/api/account/success",
  requireCustomer,
  async (req, res) => {
    try {
      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      const accountId =
        req.customerAccount.id;

      /*
        Success is sourced only from the configured Discord
        success channel. Customer mailbox scanning no longer
        updates the customer-facing Success dashboard.
      */

      /*
        Success records are always filtered
        server-side by the authenticated
        customer account.

        The browser never supplies an account ID.
      */

      const records =
        visibleDiscordSuccessRecords(
          await getSuccessCheckouts()
        );

      const ownedRecords =
        records.filter(
          record =>
            record.customerAccountId ===
            accountId
        );

      const requestedStart =
  clean(
    req.query.start,
    10
  );

const requestedEnd =
  clean(
    req.query.end,
    10
  );

const datePattern =
  /^\d{4}-\d{2}-\d{2}$/;

const startDate =
  datePattern.test(
    requestedStart
  )
    ? requestedStart
    : null;

const endDate =
  datePattern.test(
    requestedEnd
  )
    ? requestedEnd
    : null;

if (
  (
    requestedStart &&
    !startDate
  ) ||
  (
    requestedEnd &&
    !endDate
  )
) {
  return res
    .status(400)
    .json({
      error:
        "Invalid Success date range."
    });
}

if (
  startDate &&
  endDate &&
  startDate > endDate
) {
  return res
    .status(400)
    .json({
      error:
        "The start date must be before the end date."
    });
}

let rangeStart =
  startDate;

let rangeEnd =
  endDate;

if (
  !rangeStart ||
  !rangeEnd
) {
  const today =
    new Date();

  today.setUTCHours(
    0,
    0,
    0,
    0
  );

  const defaultStart =
    new Date(today);

  defaultStart.setUTCDate(
    today.getUTCDate() - 13
  );

  rangeStart =
    defaultStart
      .toISOString()
      .slice(0, 10);

  rangeEnd =
    today
      .toISOString()
      .slice(0, 10);
}

const startTime =
  new Date(
    `${rangeStart}T00:00:00.000Z`
  ).getTime();

const endTime =
  new Date(
    `${rangeEnd}T00:00:00.000Z`
  ).getTime();

const rangeDays =
  Math.floor(
    (
      endTime -
      startTime
    ) /
    (
      24 *
      60 *
      60 *
      1000
    )
  ) + 1;

/*
  Keep a single graph request
  reasonably sized while still
  allowing customers to look
  several months back.
*/
if (
  rangeDays < 1 ||
  rangeDays > 180
) {
  return res
    .status(400)
    .json({
      error:
        "Choose a date range of 180 days or less."
    });
}

const summary =
  buildSuccessSummary(
    ownedRecords,
    rangeStart,
    rangeEnd
  );

summary.range = {
  start: rangeStart,
  end: rangeEnd,
  days: rangeDays
};

      return res.json({
        ok: true,

        sync: {
          status:
            ownedRecords.length
              ? "ready"
              : "waiting",

          message:
            ownedRecords.length
              ? "Checkout data is up to date"
              : "Waiting for checkout data",

          lastSyncAt:
            ownedRecords
              .map(
                record =>
                  record.syncedAt ||
                  record.updatedAt ||
                  record.createdAt ||
                  null
              )
              .filter(Boolean)
              .sort()
              .reverse()[0] ||
            null
        },

        ...summary
      });

    } catch (error) {
      console.error(
        "Success dashboard error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to load Success data."
        });
    }
  }
);
/* -------------------------------------------------------
   MY PROFILE
------------------------------------------------------- */

app.get(
  "/api/my-profile",
  requireCustomer,
  async (req, res) => {
    try {
      await syncCustomerMissingNotification(
        req.customerAccount.id
      );

      const account =
  req.customerAccount;

/*
  If this customer has already verified the
  same email used on an older paid order,
  automatically connect that order now.

  This also repairs accounts that were created
  before automatic linking was added.
*/

if (
  account.emailVerifiedAt
) {
  await autoLinkVerifiedCustomerOrders(
    account
  );
}

const ownedOrders =
  await getCustomerOwnedOrders(
    account.id
  );

      /*
        Refresh subscription information from Stripe
        when possible so the customer dashboard has
        the latest membership status and billing dates.
      */

      let paidChanged = false;

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const paidRecords =
        Array.isArray(paid)
          ? paid
          : [];

      for (
        const order of
        ownedOrders
      ) {
        if (
          !order.stripeSubscriptionId
        ) {
          continue;
        }

        try {
          const subscription =
            await stripe
              .subscriptions
              .retrieve(
                order
                  .stripeSubscriptionId
              );

          const storedRecord =
            paidRecords.find(
              item =>
                item.id ===
                order.id
            );

          if (storedRecord) {
            await applySubscriptionInfo(
              storedRecord,
              subscription
            );

            storedRecord
              .subscriptionUpdatedAt =
              new Date()
                .toISOString();

            /*
              Keep the in-memory order used for
              this response synchronized too.
            */

            Object.assign(
              order,
              storedRecord
            );

            paidChanged = true;
          }

        } catch (error) {
          /*
            Do not block the customer dashboard if
            Stripe cannot be reached. The most
            recently stored subscription data will
            still be returned.
          */

          console.error(
            "Customer subscription refresh failed:",
            order.id,
            error.message
          );
        }
      }

      if (paidChanged) {
        await writeJson(
          PAID_FILE,
          paidRecords
        );
      }

      const safeOrders =
        ownedOrders
          .map(
            safeCustomerOrder
          )
          .sort(
            (a, b) => {
              const aTime =
                new Date(
                  a.paidAt ||
                  a.createdAt ||
                  0
                ).getTime();

              const bTime =
                new Date(
                  b.paidAt ||
                  b.createdAt ||
                  0
                ).getTime();

              return bTime - aTime;
            }
          );

      const profileDisplayOrder =
        [...ownedOrders]
          .sort(
            (a, b) =>
              new Date(
                b.paidAt ||
                b.createdAt ||
                0
              ).getTime() -
              new Date(
                a.paidAt ||
                a.createdAt ||
                0
              ).getTime()
          )[0] ||
        null;

      const profileDisplayName =
        [
          profileDisplayOrder
            ?.profile?.firstName,
          profileDisplayOrder
            ?.profile?.lastName
        ]
          .filter(Boolean)
          .join(" ") ||
        profileDisplayOrder
          ?.profile?.profileName ||
        "Member";

      const accountStats = {
        userSince:
          account.createdAt ||
          null,

        displayName:
          profileDisplayName,

        ogMember:
          account.ogMemberGrantedAt ? true : customerHasOgMemberStatus(
            ownedOrders
          ),

        totalOrders:
          safeOrders.length,

        lifetimeSpend:
          safeOrders.reduce(
            (sum, order) =>
              sum +
              Math.max(
                0,
                Number(
                  order?.plan?.amount ||
                  0
                ) || 0
              ),
            0
          )
      };

      /*
        Determine the customer's currently usable
        retailer-profile allowance from their active
        paid membership.
      */

      const profileAllowance =
        await getCustomerProfileAllowance(
          account.id
        );

      /*
        Pick the strongest currently active membership
        for the summary shown at the top of My Profile.

        This does not combine profile allowances from
        multiple subscriptions.
      */

      const activeOrders =
        ownedOrders.filter(
          subscriptionAllowsProfiles
        );

      let membership = null;

      if (activeOrders.length) {
        const selected =
          [...activeOrders]
            .sort(
              (a, b) =>
                profileAllowanceForRecord(
                  b
                ) -
                profileAllowanceForRecord(
                  a
                )
            )[0];

        membership = {
          orderNumber:
            customerOrderNumber(
              selected
            ),

          name:
            selected.plan?.name ||
            "Membership",

          tier:
            selected.plan?.tier ||
            selected.plan?.id ||
            null,

          profiles:
            profileAllowance,

          amount:
            Number(
              selected.plan?.amount ||
              0
            ),

          status:
            selected
              .subscriptionStatus ||
            "active",

          currentPeriodStart:
            selected
              .currentPeriodStart ||
            null,

          currentPeriodEnd:
            selected
              .currentPeriodEnd ||
            null,

          subscriptionEndDate:
            selected
              .subscriptionEndDate ||
            null,

          cancelAtPeriodEnd:
            selected
              .cancelAtPeriodEnd ===
            true
        };
        // Subscription billing can be active before the owner has finished
        // setting up any of this customer's ACO profiles.
        const customerProfiles = (await getRetailerProfiles()).filter(profile =>
          String(profile.customerAccountId || "") === String(account.id));
        membership.activationStatus = customerProfiles.some(profile =>
          profile.activationStatus === "activated") ? "activated" : "awaiting_activation";
      }

      if (!membership) {
        const grants = await getGiftedMemberships();
        const now = Date.now();
        const activeGrant = grants
          .filter(item => String(item.customerAccountId) === String(account.id) &&
            new Date(item.startsAt).getTime() <= now &&
            new Date(item.expiresAt).getTime() > now)
          .sort((a, b) => Number(b.profiles) - Number(a.profiles))[0];
        if (activeGrant) {
          membership = {
            name: activeGrant.tierName,
            tier: activeGrant.tier,
            profiles: activeGrant.profiles,
            amount: 0,
            status: "gifted",
            currentPeriodStart: activeGrant.startsAt,
            currentPeriodEnd: activeGrant.expiresAt,
            subscriptionEndDate: activeGrant.expiresAt,
            cancelAtPeriodEnd: false
          };
        }
      }

      return res.json({
        ok: true,

        account:
          publicCustomerAccount(
            account
          ),

        accountStats,

        membership,

        profileAllowance,

        orders:
          safeOrders
      });

    } catch (error) {
      console.error(
        "My profile error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to load your account."
        });
    }
  }
);

/* -------------------------------------------------------
   HEALTH CHECK
------------------------------------------------------- */

app.get(
  "/api/health",
  (req, res) => {
    return res.json({
      ok: true
    });
  }
);

/* -------------------------------------------------------
   FINAL API 404 / ERROR HANDLERS
------------------------------------------------------- */

app.use(
  "/api",
  (req, res) => {
    return res
      .status(404)
      .json({
        error:
          "API endpoint not found."
      });
  }
);


app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "Unhandled request error:",
      {
        requestId:
          req.securityRequestId,

        method:
          req.method,

        path:
          req.path,

        error
      }
    );

    if (
      res.headersSent
    ) {
      return next(
        error
      );
    }

    return res
      .status(500)
      .json({
        error:
          "Unexpected server error.",

        requestId:
          req.securityRequestId
      });
  }
);


/* -------------------------------------------------------
   START SERVER
------------------------------------------------------- */


let managedExpirationSweepRunning =
  false;


async function runManagedExpirationSweep() {
  if (
    managedExpirationSweepRunning
  ) {
    return;
  }

  managedExpirationSweepRunning =
    true;

  try {
    /*
      getFreeAssignments/getRentalAssignments perform the actual
      expiration cleanup, Restore Hold creation and Discord notice.
    */
    await getFreeAssignments();
    await getRentalAssignments();

    const managedAccounts =
      await getManagedAccounts();

    await mutateRestoreHolds(
      async holds => {
        for (
          const hold of
          activeRestoreHoldsFor(
            holds
          )
        ) {
          if (
            hold.expirationDiscordSentAt
          ) {
            continue;
          }

          await sendRestoreHoldExpirationDiscord(
            hold,
            managedAccounts
          );
        }
      }
    );

  } catch (error) {
    console.error(
      "Managed expiration sweep failed:",
      error.message
    );

  } finally {
    managedExpirationSweepRunning =
      false;
  }
}


function startManagedExpirationScheduler() {
  setTimeout(
    () => {
      runManagedExpirationSweep();
    },
    15 * 1000
  );

  const timer =
    setInterval(
      () => {
        runManagedExpirationSweep();
      },
      5 * 60 * 1000
    );

  if (
    typeof timer.unref ===
    "function"
  ) {
    timer.unref();
  }
}



async function removeLegacyDiscordUserIds() {
  const accounts =
    await getCustomerAccounts();

  let changed =
    false;

  for (
    const account of
    accounts
  ) {
    if (!account.discordLinkedAt &&
      Object.prototype
        .hasOwnProperty.call(
          account,
          "discordUserId"
        )
    ) {
      delete account.discordUserId;

      changed =
        true;
    }
  }

  if (changed) {
    await saveCustomerAccounts(
      accounts
    );
  }
}


function securityConfigurationSnapshot() {
  let baseUrlValid = false;
  let baseUrlHttps = false;

  try {
    const parsed = new URL(BASE_URL);
    baseUrlValid = Boolean(parsed.hostname);
    baseUrlHttps = parsed.protocol === "https:";
  } catch {
    baseUrlValid = false;
  }

  return {
    baseUrlValid,
    baseUrlHttps,
    secureCookies: SECURE_COOKIES,

    customerSessionSecretStrong:
      String(
        process.env.CUSTOMER_SESSION_SECRET || ""
      ).length >= 32,

    encryptionKeyConfigured:
      Boolean(
        String(
          process.env.SUBMISSION_ENCRYPTION_KEY || ""
        )
      ),

    adminPasswordConfigured:
      Boolean(
        String(
          process.env.ADMIN_PASSWORD || ""
        )
      ),

    adminPasswordStrong:
      String(
        process.env.ADMIN_PASSWORD || ""
      ).length >= 14,

    adminMfaConfigured:
      Boolean(
        String(
          process.env.ADMIN_2FA_SECRET || ""
        )
      ),

    stripeSecretConfigured:
      Boolean(
        String(
          process.env.STRIPE_SECRET_KEY || ""
        )
      ) &&
      String(
        process.env.STRIPE_SECRET_KEY || ""
      ) !== "sk_test_missing",

    stripeWebhookSecretConfigured:
      Boolean(
        String(
          process.env.STRIPE_WEBHOOK_SECRET || ""
        )
      )
  };
}


function validateCriticalSecurityConfiguration() {
  const status =
    securityConfigurationSnapshot();

  const failures = [];

  if (!status.baseUrlValid) {
    failures.push("BASE_URL");
  }

  if (!status.customerSessionSecretStrong) {
    failures.push("CUSTOMER_SESSION_SECRET");
  }

  if (!status.encryptionKeyConfigured) {
    failures.push("SUBMISSION_ENCRYPTION_KEY");
  }

  if (!status.adminPasswordConfigured) {
    failures.push("ADMIN_PASSWORD");
  }

  if (!status.adminMfaConfigured) {
    failures.push("ADMIN_2FA_SECRET");
  }

  if (failures.length) {
    throw new Error(
      `Critical security configuration missing or invalid: ${failures.join(", ")}`
    );
  }

  if (
    SECURE_COOKIES &&
    !status.baseUrlHttps
  ) {
    throw new Error(
      "Secure cookies require an HTTPS BASE_URL."
    );
  }

  if (!status.adminPasswordStrong) {
    console.warn(
      "SECURITY WARNING: ADMIN_PASSWORD should be at least 14 characters."
    );
  }

  if (!status.stripeWebhookSecretConfigured) {
    console.warn(
      "SECURITY WARNING: STRIPE_WEBHOOK_SECRET is not configured."
    );
  }

  if (!status.stripeSecretConfigured) {
    console.warn(
      "SECURITY WARNING: STRIPE_SECRET_KEY is not configured."
    );
  }
}


async function hardenStoragePermissions() {
  const publicDirectory =
    path.resolve(
      __dirname,
      "public"
    );

  const dataDirectory =
    path.resolve(DATA_DIR);

  if (
    dataDirectory === publicDirectory ||
    dataDirectory.startsWith(
      `${publicDirectory}${path.sep}`
    )
  ) {
    throw new Error(
      "DATA_DIR must never be inside the public web directory."
    );
  }

  for (
    const directory of [
      DATA_DIR,
      SECRET_DIR
    ]
  ) {
    try {
      await fs.chmod(
        directory,
        0o700
      );
    } catch {
      // Mounted filesystems may ignore chmod.
    }
  }

  const files = [
    PENDING_FILE,
    PAID_FILE,
    CUSTOMER_ACCOUNTS_FILE,
    PASSWORD_RESET_FILE,
    EMAIL_VERIFY_FILE,
    ORDER_CLAIM_FILE,
    RETAILER_PROFILES_FILE,
    SPECIAL_PROFILES_FILE,
    MANAGED_ACCOUNTS_FILE,
    RENTED_MEMBERSHIPS_FILE,
    RENTAL_ASSIGNMENTS_FILE,
    FREE_MEMBERSHIPS_FILE,
    FREE_ASSIGNMENTS_FILE,
    RESTORE_HOLDS_FILE,
    SUCCESS_CHECKOUTS_FILE,
    SUCCESS_CHECKOUTS_TEST_FILE,
    SECURITY_AUDIT_FILE
  ];

  for (const file of files) {
    try {
      await fs.chmod(
        file,
        0o600
      );
    } catch {
      // File may not exist yet.
    }
  }

  try {
    const entries =
      await fs.readdir(
        SECRET_DIR,
        {
          withFileTypes: true
        }
      );

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      try {
        await fs.chmod(
          path.join(
            SECRET_DIR,
            entry.name
          ),
          0o600
        );
      } catch {
        // Ignore permission limitations.
      }
    }
  } catch {
    // SECRET_DIR may be empty/new.
  }
}



async function startServer() {
  try {
    validateCriticalSecurityConfiguration();

    /*
      Make sure all persistent storage locations
      exist before accepting requests.
    */

    await fs.mkdir(
      DATA_DIR,
      {
        recursive: true,
        mode: 0o700
      }
    );

    await fs.mkdir(
      SECRET_DIR,
      {
        recursive: true,
        mode: 0o700
      }
    );

    /*
      Initialize persistent JSON files only when
      they do not already exist. readJson() safely
      returns the fallback if a file is missing,
      while writeJson() creates parent directories.
    */

    const initializeArrayFile =
      async file => {
        try {
          await fs.access(
            file
          );
        } catch {
          await writeJson(
            file,
            []
          );
        }
      };

    const initializeObjectFile =
      async file => {
        try {
          await fs.access(
            file
          );
        } catch {
          await writeJson(
            file,
            {}
          );
        }
      };

    await initializeObjectFile(
      PENDING_FILE
    );

    await initializeArrayFile(
      PAID_FILE
    );

    await initializeArrayFile(
      CUSTOMER_ACCOUNTS_FILE
    );

    await initializeArrayFile(
      PASSWORD_RESET_FILE
    );

    await initializeArrayFile(
      EMAIL_VERIFY_FILE
    );

    await initializeArrayFile(
      ORDER_CLAIM_FILE
    );

    await initializeArrayFile(
      RETAILER_PROFILES_FILE
    );

    await initializeArrayFile(
  SPECIAL_PROFILES_FILE
);

    await initializeArrayFile(
  MANAGED_ACCOUNTS_FILE
);

    await initializeArrayFile(
  RENTED_MEMBERSHIPS_FILE
);

await initializeArrayFile(
  RENTAL_ASSIGNMENTS_FILE
);

    await initializeArrayFile(
  FREE_MEMBERSHIPS_FILE
);

await initializeArrayFile(
  FREE_ASSIGNMENTS_FILE
);

    await initializeArrayFile(
      RESTORE_HOLDS_FILE
    );

    await initializeArrayFile(
  SUCCESS_CHECKOUTS_FILE
);

    
    await removeLegacyDiscordUserIds();

    await migrateCustomerJigs();

    await synchronizeMembershipPrices();

    await hardenStoragePermissions();

    app.listen(
      PORT,
      () => {
        console.log(
          `SLABSNGRABSACO server running on port ${PORT}`
        );

        startLiveSuccessScheduler();
        startManagedExpirationScheduler();
        startDiscordCommunity({
          token: String(process.env.DISCORD_BOT_TOKEN || "").trim(),
          channelId: String(process.env.DISCORD_SUCCESS_CHANNEL_ID || "").trim(),
          getChannelId: async () => (await resolvedDiscordSuccessConfig()).channelId,
          getAccounts: getCustomerAccounts,
          saveAccounts: saveCustomerAccounts,
          getAllowance: getCustomerProfileAllowance,
          getOgStatus: async accountId => {
            const account = (await getCustomerAccounts()).find(item => String(item.id) === String(accountId));
            if (account?.ogMemberGrantedAt) return true;
            const paid = await readJson(PAID_FILE, []);
            return customerHasOgMemberStatus((Array.isArray(paid) ? paid : []).filter(item =>
              String(item.customerAccountId || "") === String(accountId)));
          },
          dataDir: DATA_DIR,
          aiKey: String(process.env.OPENAI_API_KEY || "").trim(),
          geminiKey: String(process.env.GEMINI_API_KEY || "").trim(),
          onSuccessMessage: () => queueDiscordSuccessScan(50)
        });
        if (discordSuccessConfig().token) {
          setTimeout(() => scanDiscordSuccessChannel(), 12000);
          const discordTimer = setInterval(() => scanDiscordSuccessChannel(), 60 * 1000);
          discordTimer.unref?.();
        }
      }
    );

    
  } catch (error) {
    console.error(
      "Server startup failed:",
      error
    );

    process.exit(1);
  }
}

startServer();
