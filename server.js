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
    subscription.cancel_at_period_end ===
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

  /*
    If Stripe has an explicit cancel_at date,
    use that as the paid-through/end date when
    appropriate.
  */

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
    id: account.id,
    email: account.email,
    emailVerified:
      !!account.emailVerifiedAt,
    createdAt:
      account.createdAt,
    lastLoginAt:
      account.lastLoginAt || null
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
          "Your email address has been verified.",

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

/* -------------------------------------------------------
   RETAILER PROFILE ROUTES
------------------------------------------------------- */

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
          )
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
   ADMIN SUBMISSIONS
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

      const result = [];

      for (
        const record of
        Array.isArray(paid)
          ? paid
          : []
      ) {
        let secrets = null;

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
    Require clear Target/order language before
    attempting to parse anything.
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
      /order\s*(?:number|#|no\.?)?\s*:?\s*#?\s*([A-Z0-9-]{6,40})/i
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
     MULTI-PRODUCT PARSER

     Expected normalized text:

     Product Name
     Quantity: 4
     $39.99 each

     Product Name
     Quantity: 2
     $54.99 each
  ===================================================== */

  const items = [];


  const itemPattern =
    /(?:^|\n)\s*([^\n]{3,300}?)\s*\n+\s*quantity\s*:?\s*(\d{1,4})\s*\n+\s*\$?\s*([\d,]+(?:\.\d{2}))\s*(?:each|\/\s*each)/gi;


  let itemMatch;


  while (
    (
      itemMatch =
        itemPattern.exec(
          combined
        )
    ) !== null
  ) {
    const name =
      clean(
        itemMatch[1],
        300
      );


    const quantity =
      Number(
        itemMatch[2]
      );


    const price =
      parseMoney(
        itemMatch[3]
      );


    if (
      !name ||
      !Number.isInteger(
        quantity
      ) ||
      quantity <= 0 ||
      price === null
    ) {
      continue;
    }


    /*
      Ignore lines that clearly aren't
      product names.
    */

    if (
      /^order\b/i.test(name) ||
      /^quantity\b/i.test(name) ||
      /^order total\b/i.test(name) ||
      /^thanks for your order/i.test(
        name
      )
    ) {
      continue;
    }


    items.push({
  name,

  quantity,

  price,

  imageUrl:
    findTargetProductImage(
      name,
      emailImages
    )
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
