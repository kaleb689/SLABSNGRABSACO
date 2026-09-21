import express from "express";
import Stripe from "stripe";
import { authenticator } from "otplib";
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
    expYear: clean(body.expYear, 4)
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
    secrets.expYear
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
  entry.customerAccountId || null,

customerLinkedAt:
  entry.customerAccountId
    ? new Date().toISOString()
    : null,

              cvvConfirmed:
                entry.cvvConfirmed === true,

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

      /*
        Always return the same public response,
        whether the account exists or not.
      */

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

      /*
        Keep the public response generic so this
        endpoint cannot be used to discover which
        email addresses have accounts.
      */

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

      /*
        Delete all reset tokens for this account.
        This makes the reset link single-use.
      */

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

      /*
        Give the customer a fresh authenticated
        session after a successful reset.
      */

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

      /*
        Use a generic response for failed matches
        so the endpoint does not reveal whether
        an order number exists.
      */

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

      /*
        Never allow an order already owned by a
        different account to be silently claimed.
      */

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

      /*
        Remove older pending claims for this
        same account/order combination.
      */

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

      if (!record) {
        return res
          .status(404)
          .json({
            error:
              "Order could not be found."
          });
      }

      if (
        record.customerAccountId &&
        record.customerAccountId !==
          req.customerAccount.id
      ) {
        return res
          .status(409)
          .json({
            error:
              "This order is already connected to another account."
          });
      }

      const verifiedAt =
        new Date()
          .toISOString();

      record.customerAccountId =
        req.customerAccount.id;

      record.customerLinkedAt =
        verifiedAt;

      record.updatedAt =
        verifiedAt;

      await writeJson(
        PAID_FILE,
        paid
      );

      /*
        Mark the customer's email as verified
        when the claim email is the same email
        used by their customer account.
      */

      const orderEmail =
        normalizeEmail(
          record.profile?.email
        );

      if (
        orderEmail &&
        orderEmail ===
          normalizeEmail(
            req.customerAccount.email
          )
      ) {
        const accounts =
          await getCustomerAccounts();

        const account =
          accounts.find(
            item =>
              item.id ===
              req.customerAccount.id
          );

        if (account) {
          account.emailVerifiedAt =
            account.emailVerifiedAt ||
            verifiedAt;

          account.updatedAt =
            verifiedAt;

          await saveCustomerAccounts(
            accounts
          );
        }
      }

      const remainingClaims =
        (
          Array.isArray(claims)
            ? claims
            : []
        ).filter(
          item =>
            item.id !==
              claim.id &&
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
          "Your order has been connected to your account.",

        orderNumber:
          customerOrderNumber(
            record
          )
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
            "Unable to verify this order."
        });
    }
  }
);
/* -------------------------------------------------------
   ADMIN LOGIN
------------------------------------------------------- */

app.post(
  "/api/admin/login",
  (req, res) => {
    const ip =
      req.ip || "unknown";

    const now =
      Date.now();

    const attempt =
      loginAttempts.get(ip) || {
        count: 0,
        reset:
          now +
          15 * 60 * 1000
      };

    if (
      now > attempt.reset
    ) {
      attempt.count = 0;

      attempt.reset =
        now +
        15 * 60 * 1000;
    }

    if (
      attempt.count >= 8
    ) {
      return res
        .status(429)
        .json({
          error:
            "Too many attempts"
        });
    }

    const password =
      req.body.password || "";

    const code =
      String(
        req.body.code || ""
      ).replace(/\s/g, "");

    const secret =
      process.env
        .ADMIN_2FA_SECRET || "";

    const passwordValid =
      !!process.env
        .ADMIN_PASSWORD &&
      safeEqual(
        password,
        process.env
          .ADMIN_PASSWORD
      );

    let codeValid = false;

    if (
      secret &&
      /^\d{6}$/.test(code)
    ) {
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
      attempt.count++;

      loginAttempts.set(
        ip,
        attempt
      );

      return res
        .status(401)
        .json({
          error:
            "Invalid credentials"
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
          now +
          30 * 60 * 1000
      }
    );

    res.setHeader(
      "Set-Cookie",
      `sng_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800${
        BASE_URL.startsWith(
          "https://"
        )
          ? "; Secure"
          : ""
      }`
    );

    res.json({
      ok: true
    });
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
      "sng_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
    );

    res.json({
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
    const paid =
      await readJson(
        PAID_FILE,
        []
      );


    /*
      Refresh subscription information directly
      from Stripe before showing Admin.

      This also repairs older saved records that
      are missing currentPeriodEnd.
    */

    let subscriptionDataChanged =
      false;


    for (const record of paid) {

      if (
        !record.stripeSubscriptionId
      ) {
        continue;
      }


      try {

        const subscription =
          await stripe
            .subscriptions
            .retrieve(
              record
                .stripeSubscriptionId
            );


        const before =
          JSON.stringify({
            subscriptionStatus:
              record.subscriptionStatus,

            currentPeriodStart:
              record.currentPeriodStart,

            currentPeriodEnd:
              record.currentPeriodEnd,

            cancelAtPeriodEnd:
              record.cancelAtPeriodEnd,

            cancelAt:
              record.cancelAt,

            canceledAt:
              record.canceledAt,

            endedAt:
              record.endedAt,

            subscriptionEndDate:
              record.subscriptionEndDate
          });


        await applySubscriptionInfo(
  record,
  subscription
);


        const after =
          JSON.stringify({
            subscriptionStatus:
              record.subscriptionStatus,

            currentPeriodStart:
              record.currentPeriodStart,

            currentPeriodEnd:
              record.currentPeriodEnd,

            cancelAtPeriodEnd:
              record.cancelAtPeriodEnd,

            cancelAt:
              record.cancelAt,

            canceledAt:
              record.canceledAt,

            endedAt:
              record.endedAt,

            subscriptionEndDate:
              record.subscriptionEndDate
          });


        if (before !== after) {

          record.subscriptionUpdatedAt =
            new Date().toISOString();

          subscriptionDataChanged =
            true;
        }


      } catch (error) {

        console.error(
          "Admin subscription refresh failed:",
          record.id,
          error.message
        );

      }

    }


    if (
      subscriptionDataChanged
    ) {

      await writeJson(
        PAID_FILE,
        paid
      );

    }


    const output = [];

    for (
      const record of paid
    ) {
      try {
        const encrypted =
          await readJson(
            path.join(
              SECRET_DIR,
              `${record.id}.encrypted.json`
            ),
            null
          );

        if (!encrypted) {
          continue;
        }

        const packageData =
          decryptJson(
            encrypted
          );

        output.push({
          ...record,

          secrets:
            packageData.secrets,

          cvvConfirmed:
            packageData
              .cvvConfirmed ===
              true ||
            record
              .cvvConfirmed ===
              true
        });

      } catch (error) {
        console.error(
          "Admin decrypt failed",
          record.id,
          error.message
        );
      }
    }

    res.json(
      output.sort(
        (a, b) =>
          String(
            b.paidAt
          ).localeCompare(
            String(a.paidAt)
          )
      )
    );
  }
);

/* -------------------------------------------------------
   DELETE SUBMISSION
------------------------------------------------------- */

app.delete(
  "/api/admin/submissions/:id",
  requireAdmin,
  async (req, res) => {
    const id =
      String(
        req.params.id || ""
      );

    if (
      !/^[a-f0-9-]{30,40}$/i.test(
        id
      )
    ) {
      return res
        .status(400)
        .json({
          error: "Bad id"
        });
    }

    try {
      await fs.unlink(
        path.join(
          SECRET_DIR,
          `${id}.encrypted.json`
        )
      );
    } catch {}

    const paid =
      await readJson(
        PAID_FILE,
        []
      );

    await writeJson(
      PAID_FILE,
      paid.filter(
        record =>
          record.id !== id
      )
    );

    res.json({
      ok: true
    });
  }
);

/* -------------------------------------------------------
   CREATE STRIPE CHECKOUT
------------------------------------------------------- */

app.post(
  "/api/create-checkout-session",
  async (req, res) => {
    try {
      const tier =
        Number(req.body.tier);

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

      /*
        The first three plans already have
        Stripe prices configured.

        Tiers 4-7 will work automatically
        once their Render environment
        variables are added.
      */

      if (!plan.priceId) {
        return res
          .status(400)
          .json({
            error:
              `${plan.name} checkout is not configured yet. Please contact us or choose another membership.`
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

      const cvvConfirmed =
        req.body
          .cvvConfirmed === true;

      if (
        !validProfile(profile) ||
        !validSecrets(secrets) ||
        !cvvConfirmed
      ) {
        return res
          .status(400)
          .json({
            error:
              "Please complete all required profile and ACO setup fields."
          });
      }

      const id =
        crypto.randomUUID();

      const createdAt =
        new Date()
          .toISOString();
      
      const customerAccount =
  await getAuthenticatedCustomer(req);
      
      await saveEncryptedPackage(
        id,
        {
          submissionId: id,
          profile,
          secrets,
          cvvConfirmed,
          createdAt
        }
      );

      const pending =
        await readJson(
          PENDING_FILE,
          {}
        );

      pending[id] = {
        id,

        customerAccountId:
  customerAccount?.id || null,
        
        plan: {
          tier,
          name: plan.name,
          profiles:
            plan.profiles,
          amount:
            plan.amount
        },

        profile,
        cvvConfirmed,
        createdAt
      };

      await writeJson(
        PENDING_FILE,
        pending
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

            customer_email:
              profile.email,

            client_reference_id:
              id,

            metadata: {
              submission_id:
                id,

              tier:
                String(tier)
            },

            subscription_data: {
              metadata: {
                submission_id:
                  id,

                tier:
                  String(tier)
              }
            },

            success_url:
              `${BASE_URL}/?payment=success`,

            cancel_url:
              `${BASE_URL}/?payment=cancelled`,

            billing_address_collection:
              "auto",

            allow_promotion_codes:
              true
          });

      res.json({
        url: session.url
      });

    } catch (error) {
      console.error(error);

      res
        .status(500)
        .json({
          error:
            "Unable to create checkout session. Check the secure server and Stripe configuration."
        });
    }
  }
);

/* -------------------------------------------------------
   MY PROFILE
------------------------------------------------------- */

/*
  IMPORTANT:

  Customer membership records are intentionally NOT
  exposed from this endpoint yet.

  We need customer authentication before returning
  private membership information. This prevents someone
  from obtaining another customer's information simply
  by knowing an email address or profile name.

  Once customer authentication is added, this endpoint
  will return the authenticated customer's Stripe
  subscription information.
*/

app.get(
  "/api/my-profile",
  requireCustomer,
  async (req, res) => {
    try {
      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const orders =
        paid
          .filter(
            record =>
              record.customerAccountId ===
              req.customerAccount.id
          )
          .sort(
            (a, b) =>
              new Date(
                b.paidAt ||
                b.createdAt ||
                0
              ) -
              new Date(
                a.paidAt ||
                a.createdAt ||
                0
              )
          );

      const safeOrders =
        orders.map(record => {
          const endDate =
            record.subscriptionEndDate ||
            record.currentPeriodEnd ||
            null;

          let daysRemaining =
            null;

          if (endDate) {
            const end =
              new Date(
                endDate
              ).getTime();

            if (
              Number.isFinite(end)
            ) {
              daysRemaining =
                Math.max(
                  0,
                  Math.ceil(
                    (
                      end -
                      Date.now()
                    ) /
                    86400000
                  )
                );
            }
          }

          return {
            orderNumber:
              customerOrderNumber(
                record
              ),

            createdAt:
              record.createdAt ||
              null,

            paidAt:
              record.paidAt ||
              null,

            updatedAt:
              record.updatedAt ||
              null,

            planName:
              record.plan?.name ||
              null,

            tier:
              record.plan?.tier ||
              null,

            amount:
              record.plan?.amount ??
              null,

            profiles:
              record.plan?.profiles ??
              null,

            status:
              record.subscriptionStatus ||
              "unknown",

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

            cancelAt:
              record.cancelAt ||
              null,

            daysRemaining,

            profile: {
              profileName:
                record.profile
                  ?.profileName || "",

              firstName:
                record.profile
                  ?.firstName || "",

              lastName:
                record.profile
                  ?.lastName || "",

              email:
                record.profile
                  ?.email || "",

              phone:
                record.profile
                  ?.phone || "",

              address:
                record.profile
                  ?.address || "",

              address2:
                record.profile
                  ?.address2 || "",

              country:
                record.profile
                  ?.country || "",

              state:
                record.profile
                  ?.state || "",

              city:
                record.profile
                  ?.city || "",

              zip:
                record.profile
                  ?.zip || ""
            }
          };
        });

      const currentOrder =
        safeOrders.find(
          order =>
            [
              "active",
              "trialing",
              "past_due"
            ].includes(
              String(
                order.status
              ).toLowerCase()
            )
        ) ||
        safeOrders[0] ||
        null;

      return res.json({
        account:
          publicCustomerAccount(
            req.customerAccount
          ),

        hasOrders:
          safeOrders.length > 0,

        currentMembership:
          currentOrder,

        orders:
          safeOrders
      });

    } catch (error) {
      console.error(
        "My Profile error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to load your customer profile."
        });
    }
  }
);

/* -------------------------------------------------------
   CUSTOMER ORDER EDITING
------------------------------------------------------- */

app.put(
  "/api/account/orders/:orderNumber",
  requireCustomer,
  async (req, res) => {
    try {
      const orderNumber =
        clean(
          req.params.orderNumber,
          150
        );

      const paid =
        await readJson(
          PAID_FILE,
          []
        );

      const record =
        paid.find(
          item =>
            customerOrderNumber(
              item
            ) === orderNumber &&
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

      /*
        Only customer-editable profile fields
        are accepted here.

        Membership tier changes are NOT handled
        by this endpoint.
      */

      const incomingProfile =
        sanitizeProfile(
          req.body.profile || {}
        );

      if (
        !validProfile(
          incomingProfile
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Please complete all required customer and shipping fields."
          });
      }

      record.profile = {
        ...record.profile,
        ...incomingProfile
      };

      /*
        Sensitive ACO information is replacement
        only. Existing passwords and card numbers
        are never sent back to the customer.
      */

      const replacement =
        req.body.secrets &&
        typeof req.body.secrets ===
          "object"
          ? req.body.secrets
          : {};

      const encryptedPath =
        path.join(
          SECRET_DIR,
          `${record.id}.encrypted.json`
        );

      let existingPackage;

      try {
        existingPackage =
          decryptJson(
            await readJson(
              encryptedPath,
              null
            )
          );
      } catch (error) {
        console.error(
          "Customer secure package read failed:",
          error.message
        );

        return res
          .status(500)
          .json({
            error:
              "Secure order information could not be loaded."
          });
      }

      if (!existingPackage) {
        return res
          .status(500)
          .json({
            error:
              "Secure order information could not be loaded."
          });
      }

      const existingSecrets =
        existingPackage.secrets ||
        {};

      const updatedSecrets = {
        ...existingSecrets
      };

      /*
        ACO email may be edited normally.
      */

      if (
        Object.prototype.hasOwnProperty.call(
          replacement,
          "acoEmail"
        )
      ) {
        const acoEmail =
          clean(
            replacement.acoEmail,
            200
          );

        if (
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
            acoEmail
          )
        ) {
          return res
            .status(400)
            .json({
              error:
                "Enter a valid ACO/IMAP email address."
            });
        }

        updatedSecrets.acoEmail =
          acoEmail;
      }

      /*
        Blank password means keep the existing
        password. A nonblank value replaces it.
      */

      if (
        clean(
          replacement.acoPassword,
          300
        )
      ) {
        const newPassword =
          clean(
            replacement.acoPassword,
            300
          );

        if (
          newPassword.length < 6
        ) {
          return res
            .status(400)
            .json({
              error:
                "The replacement ACO password is too short."
            });
        }

        updatedSecrets.acoPassword =
          newPassword;
      }

      if (
        Object.prototype.hasOwnProperty.call(
          replacement,
          "cardLabel"
        )
      ) {
        const cardLabel =
          clean(
            replacement.cardLabel,
            100
          );

        if (!cardLabel) {
          return res
            .status(400)
            .json({
              error:
                "Card label is required."
            });
        }

        updatedSecrets.cardLabel =
          cardLabel;
      }

      if (
        Object.prototype.hasOwnProperty.call(
          replacement,
          "cardholder"
        )
      ) {
        const cardholder =
          clean(
            replacement.cardholder,
            150
          );

        if (!cardholder) {
          return res
            .status(400)
            .json({
              error:
                "Cardholder name is required."
            });
        }

        updatedSecrets.cardholder =
          cardholder;
      }

      /*
        If a replacement card number is supplied,
        validate it and replace the stored number.

        Blank means retain the current number.
      */

      const replacementCard =
        clean(
          replacement.acoCardNumber,
          30
        ).replace(
          /[^\d]/g,
          ""
        );

      if (replacementCard) {
        if (
          !/^\d{12,19}$/.test(
            replacementCard
          )
        ) {
          return res
            .status(400)
            .json({
              error:
                "Enter a valid replacement card number."
            });
        }

        updatedSecrets.acoCardNumber =
          replacementCard;
      }

      /*
        Expiration may be updated when both
        month and year are supplied.
      */

      const expMonth =
        clean(
          replacement.expMonth,
          2
        );

      const expYear =
        clean(
          replacement.expYear,
          4
        );

      if (
        expMonth ||
        expYear
      ) {
        if (
          !/^(0?[1-9]|1[0-2])$/.test(
            expMonth
          ) ||
          !/^\d{4}$/.test(
            expYear
          )
        ) {
          return res
            .status(400)
            .json({
              error:
                "Enter a valid expiration month and year."
            });
        }

        updatedSecrets.expMonth =
          expMonth.padStart(
            2,
            "0"
          );

        updatedSecrets.expYear =
          expYear;
      }

      existingPackage.profile =
        record.profile;

      existingPackage.secrets =
        updatedSecrets;

      existingPackage.updatedAt =
        new Date()
          .toISOString();

      await saveEncryptedPackage(
        record.id,
        existingPackage
      );

      record.updatedAt =
        existingPackage.updatedAt;

      record.customerUpdatedAt =
        existingPackage.updatedAt;

      record.updatedBy =
        "customer";

      await writeJson(
        PAID_FILE,
        paid
      );

      return res.json({
        ok: true,

        message:
          "Your order information has been updated.",

        orderNumber:
          customerOrderNumber(
            record
          ),

        updatedAt:
          record.updatedAt
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
            "Unable to update your order information."
        });
    }
  }
);

/* -------------------------------------------------------
   FALLBACK
------------------------------------------------------- */

app.get(
  "*",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      `SLABSNGRABSACO running at ${BASE_URL}`
    );
  }
);
