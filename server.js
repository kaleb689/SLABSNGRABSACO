import express from "express";
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
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const PORT = process.env.PORT || 4242;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const DATA_DIR = process.env.DATA_DIR || "/var/data/slabsngrabsaco";

const PENDING_FILE = path.join(DATA_DIR, "pending-submissions.json");
const PAID_FILE = path.join(DATA_DIR, "paid-submissions.json");
const SECRET_DIR = path.join(DATA_DIR, "secure-packages");
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

const CUSTOMER_SESSION_COOKIE =
  "sng_customer";

const CUSTOMER_SESSION_MAX_AGE =
  30 * 24 * 60 * 60;

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
    amount: 30,
    priceId: process.env.STRIPE_TIER1_PRICE_ID
  },

  2: {
    name: "Popular",
    profiles: 2,
    amount: 50,
    priceId: process.env.STRIPE_TIER2_PRICE_ID
  },

  3: {
    name: "Advanced",
    profiles: 3,
    amount: 80,
    priceId: process.env.STRIPE_TIER3_PRICE_ID
  },

  4: {
    name: "Pro",
    profiles: 5,
    amount: 130,
    priceId: process.env.STRIPE_TIER4_PRICE_ID
  },

  5: {
    name: "High Volume",
    profiles: 10,
    amount: 215,
    priceId: process.env.STRIPE_TIER5_PRICE_ID
  },

  6: {
    name: "Power User",
    profiles: 20,
    amount: 300,
    priceId: process.env.STRIPE_TIER6_PRICE_ID
  },

  7: {
    name: "Elite",
    profiles: 50,
    amount: 650,
    priceId: process.env.STRIPE_TIER7_PRICE_ID
  }
};

/* -------------------------------------------------------
   SECURITY HEADERS
------------------------------------------------------- */

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (
    req.path === "/admin" ||
    req.path.startsWith("/api/admin/")
  ) {
    res.setHeader("Cache-Control", "no-store");
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
  await fs.mkdir(
    path.dirname(file),
    { recursive: true }
  );

  await fs.writeFile(
    file,
    JSON.stringify(value, null, 2),
    "utf8"
  );
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
      plan.priceId &&
      String(
        plan.priceId
      ) ===
        normalizedPriceId
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
          plan.amount,

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
   ADMIN SESSIONS
------------------------------------------------------- */

const adminSessions = new Map();
const loginAttempts = new Map();
const customerAuthAttempts =
  new Map();
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

function setCustomerSession(
  res,
  accountId
) {
  const expires =
    Date.now() +
    CUSTOMER_SESSION_MAX_AGE *
    1000;

  const token =
    signCustomerSession({
      accountId,
      expires
    });

  res.setHeader(
    "Set-Cookie",
    `${CUSTOMER_SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${CUSTOMER_SESSION_MAX_AGE}${
      BASE_URL.startsWith("https://")
        ? "; Secure"
        : ""
    }`
  );
}

function clearCustomerSession(res) {
  res.setHeader(
    "Set-Cookie",
    `${CUSTOMER_SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${
      BASE_URL.startsWith("https://")
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

function publicCustomerAccount(
  account
) {
  return {
    id:
      account.id,

    email:
      account.email,

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
    parseCookies(req).sng_admin;

  const session =
    token &&
    adminSessions.get(token);

  if (
    !session ||
    session.expires < Date.now()
  ) {
    if (token) {
      adminSessions.delete(token);
    }

    return res
      .status(401)
      .json({
        error: "Unauthorized"
      });
  }

  session.expires =
    Date.now() +
    30 * 60 * 1000;

  next();
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
      return res
        .status(400)
        .send(
          `Webhook signature verification failed: ${error.message}`
        );
    }

    try {

      /* CHECKOUT COMPLETED */

      if (
        event.type ===
        "checkout.session.completed"
      ) {
        const session =
          event.data.object;

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

              paidAt:
                new Date()
                  .toISOString(),

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
              paid[existingIndex] =
                record;
            } else {
              paid.push(record);
            }

            await writeJson(
              PAID_FILE,
              paid
            );

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
          }
        }
      }

      /* SUBSCRIPTION UPDATED */

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

        let changed = false;

        for (
          const record of paid
        ) {
          if (
            String(
              record
                .stripeSubscriptionId ||
              ""
            ) ===
            String(subscription.id)
          ) {
            await applySubscriptionInfo(
              record,
              subscription
            );

            record.subscriptionUpdatedAt =
              new Date().toISOString();

            changed = true;
          }
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
    limit: "50kb"
  })
);

/* -------------------------------------------------------
   ADMIN PAGE
------------------------------------------------------- */

app.get(
  "/admin",
  (req, res) => {
    res.set(
      "Cache-Control",
      "no-store"
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

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);

/* -------------------------------------------------------
   CUSTOMER ACCOUNT ROUTES
------------------------------------------------------- */

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
        password.length < 10 ||
        password.length > 200
      ) {
        return res
          .status(400)
          .json({
            error:
              "Password must be at least 10 characters."
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

      const passwordData =
        await hashCustomerPassword(
          password
        );

      const now =
        new Date().toISOString();

      const account = {
        id:
          crypto.randomUUID(),

        email,

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

        disabled:
          false
      };

      accounts.push(account);

      await saveCustomerAccounts(
        accounts
      );

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
        account.id
      );

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
        return res
          .status(401)
          .json({
            error:
              "Incorrect email or password."
          });
      }

      const passwordValid =
        await verifyCustomerPassword(
          password,
          account
        );

      if (!passwordValid) {
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
        account.id
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

app.post(
  "/api/account/logout",
  (req, res) => {
    clearCustomerSession(res);

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
        newPassword.length < 10 ||
        newPassword.length > 200
      ) {
        return res
          .status(400)
          .json({
            error:
              "Password must be at least 10 characters."
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
        account.id
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
          customerOrderNumber(
            item
          ).toLowerCase() ===
          orderNumber.toLowerCase()
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

  return normalized;
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


async function getRentalAssignments() {
  const records =
    await readJson(
      RENTAL_ASSIGNMENTS_FILE,
      []
    );

  return Array.isArray(records)
    ? records
    : [];
}


async function saveRentalAssignments(
  records
) {
  await writeJson(
    RENTAL_ASSIGNMENTS_FILE,
    records
  );
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


async function getFreeAssignments() {
  const records =
    await readJson(
      FREE_ASSIGNMENTS_FILE,
      []
    );

  return Array.isArray(records)
    ? records
    : [];
}


async function saveFreeAssignments(
  records
) {
  await writeJson(
    FREE_ASSIGNMENTS_FILE,
    records
  );
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
  return (
    assignments.find(
      assignment =>
        assignment
          .freeMembershipId ===
          freeMembershipId &&
        freeAssignmentIsActive(
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
  return (
    assignments.find(
      assignment =>
        assignment
          .rentedMembershipId ===
          rentedMembershipId &&
        rentalAssignmentIsActive(
          assignment
        )
    ) || null
  );
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

  if (!owned.length) {
    return 0;
  }

  return Math.max(
    0,
    ...owned.map(
      profileAllowanceForRecord
    )
  );
}

function safeRetailerProfile(
  record,
  allowance
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
      "Retailer profile decrypt error:",
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

      passwordConfigured:
        Boolean(
          credentials[
            retailer
          ].password
        )
    };
  }

  return {
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
        await getFreeMemberships();

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
          assignment.active =
            false;

          assignment.endedAt =
            now.toISOString();

          assignment.updatedAt =
            now.toISOString();

          assignment.endReason =
            "expired";

          assignmentsChanged =
            true;
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
            freeAssignmentIsActive(
              assignment
            )
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
                "active",

              active:
                true,

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
        await getRentedMemberships();

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
          assignment.active =
            false;

          assignment.endedAt =
            now.toISOString();

          assignment.updatedAt =
            now.toISOString();

          assignment.endReason =
            "expired";

          assignmentsChanged =
            true;
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
            rentalAssignmentIsActive(
              assignment
            )
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
                "active",

              active:
                true,

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
        slot > 50
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

      const now =
        new Date()
          .toISOString();

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

      adminSessions.set(
        token,
        {
          expires:
            Date.now() +
            30 * 60 * 1000
        }
      );

      res.setHeader(
        "Set-Cookie",
        `sng_admin=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800${
          BASE_URL.startsWith(
            "https://"
          )
            ? "; Secure"
            : ""
        }`
      );

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
  (req, res) => {
    const token =
      parseCookies(req)
        .sng_admin;

    if (token) {
      adminSessions.delete(
        token
      );
    }

    res.setHeader(
      "Set-Cookie",
      `sng_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${
        BASE_URL.startsWith(
          "https://"
        )
          ? "; Secure"
          : ""
      }`
    );

    return res.json({
      ok: true
    });
  }
);

/* -------------------------------------------------------
   ADMIN UPDATE SUBMISSION
------------------------------------------------------- */

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

      let paidChanged =
        false;

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


        result.push({
          ...record,

          secrets:
            secrets || null
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
      secrets || null,

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

/* -------------------------------------------------------
   ADMIN FREE MEMBERSHIPS
------------------------------------------------------- */

app.get(
  "/api/admin/free-memberships",
  requireAdmin,
  async (req, res) => {
    try {
      const memberships =
        await getFreeMemberships();

      const assignments =
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

      for (
        const assignment of
        assignments
      ) {
        if (
          assignment.active !== true ||
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
          assignment.active =
            false;

          assignment.endedAt =
            now.toISOString();

          assignment.endReason =
            "expired";

          assignmentsChanged =
            true;
        }
      }

      if (assignmentsChanged) {
        await saveFreeAssignments(
          assignments
        );
      }

      /*
        Only active PAID subscriptions
        can receive one of your managed
        free giveaway profiles.
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
        memberships.map(
          membership => {
            const assignment =
              currentFreeAssignment(
                assignments,
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
    "Free membership customer data decrypt error:",
    membership.id,
    error.message
  );
}

            return {
              id:
                membership.id,

              profileName:
                membership.profileName ||
                "FREE MEMBERSHIP",

              accountEmail:
  membership.accountEmail ||
  "",

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
                  : "inactive",

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

customerSecrets
            };
          }
        );

      return res.json({
        ok: true,

        memberships:
          result,

        paidCustomers
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
        await getFreeMemberships();

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

      await saveFreeMemberships(
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
        await getFreeMemberships();

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

await saveFreeMemberships(
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
        await getFreeMemberships();

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

      const paidRecord =
        paidRecords.find(
          record =>
            record.customerAccountId ===
              customerAccountId &&
            subscriptionAllowsProfiles(
              record
            )
        );

      if (!paidRecord) {
        return res
          .status(403)
          .json({
            error:
              "Free managed memberships can only be attached to an active paid subscription."
          });
      }

      const assignments =
        await getFreeAssignments();

      const existingActive =
        currentFreeAssignment(
          assignments,
          id
        );

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

      const now =
        new Date();

      const expirationBase =
  existingActive?.expiresAt &&
  new Date(
    existingActive.expiresAt
  ).getTime() >
    now.getTime()
    ? new Date(
        existingActive.expiresAt
      )
    : now;

const expiresAt =
  specialProfileExpiresAt(
    durationType,
    expirationBase
  );

      if (existingActive) {
        existingActive
          .customerAccountId =
          customerAccountId;

        existingActive
          .paidSubmissionId =
          paidRecord.id;

        existingActive.active =
          true;

        existingActive.durationType =
          durationType;

        existingActive.expiresAt =
          expiresAt;

        existingActive.updatedAt =
          now.toISOString();

        existingActive.endedAt =
          null;

        existingActive.endReason =
          null;

      } else {
        assignments.push({
          id:
            crypto.randomUUID(),

          freeMembershipId:
            id,

          customerAccountId,

          paidSubmissionId:
            paidRecord.id,

          active:
            true,

          durationType,

          startsAt:
            now.toISOString(),

          expiresAt,

          createdAt:
            now.toISOString(),

          updatedAt:
            now.toISOString(),

          endedAt:
            null,

          endReason:
            null
        });
      }

      await saveFreeAssignments(
        assignments
      );

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

      assignment.active =
        false;

      assignment.endedAt =
        now;

      assignment.updatedAt =
        now;

      assignment.endReason =
        "admin-ended";

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

      const paidRecord =
        paidRecords.find(
          record =>
            record.customerAccountId ===
              customerAccountId &&
            subscriptionAllowsProfiles(
              record
            )
        );

      if (!paidRecord) {
        return res
          .status(404)
          .json({
            error:
              "An active paid subscription could not be found for this customer."
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

      const paidSecrets =
        await loadEncryptedPackage(
          paidRecord.id
        );

      let memberships;

      if (type === "free") {
        memberships =
          await getFreeMemberships();
      } else {
        memberships =
          await getRentedMemberships();
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
        await getRentedMemberships();

      const assignments =
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
          assignment.active =
            false;

          assignment.endedAt =
            now.toISOString();

          assignment.endReason =
            "expired";

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
        memberships.map(
          membership => {
            const assignment =
              currentRentalAssignment(
                assignments,
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
            
            return {
              id:
                membership.id,

              profileName:
                membership.profileName ||
                "RENTED MEMBERSHIP",

              accountEmail:
  membership.accountEmail ||
  "",

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
                  : "inactive",

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

customerSecrets
            };
          }
        );

      return res.json({
        ok: true,

        memberships:
          result,

        paidCustomers
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
        await getRentedMemberships();

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

      await saveRentedMemberships(
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
        await getRentedMemberships();

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

      await saveRentedMemberships(
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
        await getRentedMemberships();

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

      const paidRecord =
        paidRecords.find(
          record =>
            record.customerAccountId ===
              customerAccountId &&
            subscriptionAllowsProfiles(
              record
            )
        );

      if (!paidRecord) {
        return res
          .status(403)
          .json({
            error:
              "Rented memberships can only be assigned to an active paid subscription."
          });
      }

      const assignments =
        await getRentalAssignments();

      const existingActive =
        currentRentalAssignment(
          assignments,
          id
        );

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

      const now =
        new Date();

      const startsAt =
        existingActive
          ?.startsAt ||
        now.toISOString();

      const expirationBase =
  existingActive?.expiresAt &&
  new Date(
    existingActive.expiresAt
  ).getTime() >
    now.getTime()
    ? new Date(
        existingActive.expiresAt
      )
    : now;

const expiresAt =
  specialProfileExpiresAt(
    durationType,
    expirationBase
  );

      if (existingActive) {
        existingActive
          .customerAccountId =
          customerAccountId;

        existingActive
          .paidSubmissionId =
          paidRecord.id;

        existingActive.active =
          true;

        existingActive.durationType =
          durationType;

        existingActive.startsAt =
          startsAt;

        existingActive.expiresAt =
          expiresAt;

        existingActive.updatedAt =
          now.toISOString();

        existingActive.endedAt =
          null;

        existingActive.endReason =
          null;

      } else {
        assignments.push({
          id:
            crypto.randomUUID(),

          rentedMembershipId:
            id,

          customerAccountId,

          paidSubmissionId:
            paidRecord.id,

          active:
            true,

          durationType,

          startsAt:
            now.toISOString(),

          expiresAt,

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
      }

      await saveRentalAssignments(
        assignments
      );

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

      assignment.active =
        false;

      assignment.endedAt =
        now;

      assignment.updatedAt =
        now;

      assignment.endReason =
        "admin-ended";

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
        slot > 50
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

      const now =
        new Date()
          .toISOString();

      const record = {
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

      const profile =
        sanitizeProfile(
          profileBody
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

        const submittedSecrets =
          sanitizeSecrets(
            secretsBody
          );

        const nextSecrets = {
          ...existingSecrets,

          acoEmail:
            submittedSecrets
              .acoEmail,

          cardLabel:
            submittedSecrets
              .cardLabel,

          cardholder:
            submittedSecrets
              .cardholder
        };

        if (
          submittedSecrets
            .acoPassword
        ) {
          nextSecrets.acoPassword =
            submittedSecrets
              .acoPassword;
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
          profile;

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

        await saveEncryptedPackage(
          id,
          nextSecrets
        );

        return res.json({
          ok: true,

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
        ...existingSecrets,

        acoEmail:
          submittedSecrets
            .acoEmail,

        cardLabel:
          submittedSecrets
            .cardLabel,

        cardholder:
          submittedSecrets
            .cardholder
      };

      if (
        submittedSecrets
          .acoPassword
      ) {
        nextSecrets.acoPassword =
          submittedSecrets
            .acoPassword;
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

      account.adminProfile = {
        ...(account.adminProfile ||
          {}),

        ...profile
      };

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

      if (!validProfile(
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
   CREATE CHECKOUT SESSION
------------------------------------------------------- */

app.post(
  "/api/create-checkout-session",
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


      const authenticatedAccount =
        await getAuthenticatedCustomer(
          req
        );

      const id =
        crypto.randomUUID();

      const now =
        new Date()
          .toISOString();

      const pending =
        await readJson(
          PENDING_FILE,
          {}
        );

      pending[id] = {
        id,

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
          authenticatedAccount
            ?.id ||
          null,
        

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
                id
            },

            subscription_data: {
              metadata: {
                submission_id:
                  id
              }
            },

            customer_email:
              profile.email,

            billing_address_collection:
              "auto",

            allow_promotion_codes:
              true
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
      new ImapFlow({
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
            String(password || "")
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
      })
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

async function saveSuccessCheckouts(
  records
) {
  await writeJson(
    SUCCESS_CHECKOUTS_FILE,
    records
  );
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
    walmart: "Walmart",
    "sam's club": "Sam's Club",
    "sams club": "Sam's Club",
    samsclub: "Sam's Club",
    costco: "Costco",
    pkc: "PKC"
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
      ? record.items.map(
          safeSuccessItem
        )
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
        Success records are always filtered
        server-side by the authenticated
        customer account.

        The browser never supplies an account ID.
      */

      const records =
        await getSuccessCheckouts();

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
            profileAllowanceForRecord(
              selected
            ),

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
      }

      return res.json({
        ok: true,

        account:
          publicCustomerAccount(
            account
          ),

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
      ok: true,
      service:
        "SLABSNGRABSACO"
    });
  }
);

/* -------------------------------------------------------
   START SERVER
------------------------------------------------------- */

async function startServer() {
  try {
    /*
      Make sure all persistent storage locations
      exist before accepting requests.
    */

    await fs.mkdir(
      DATA_DIR,
      {
        recursive: true
      }
    );

    await fs.mkdir(
      SECRET_DIR,
      {
        recursive: true
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
  SUCCESS_CHECKOUTS_FILE
);

    app.listen(
      PORT,
      () => {
        console.log(
          `SLABSNGRABSACO server running on port ${PORT}`
        );
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
