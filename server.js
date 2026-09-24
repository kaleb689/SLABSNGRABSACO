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
    amount: 70,
    priceId: process.env.STRIPE_TIER5_PRICE_ID
  },

  6: {
    name: "Power User",
    profiles: 20,
    amount: 100,
    priceId: process.env.STRIPE_TIER6_PRICE_ID
  },

  7: {
    name: "Elite",
    profiles: 50,
    amount: 215,
    priceId: process.env.STRIPE_TIER7_PRICE_ID
  }
};

const RENTAL_PACKAGES = {
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

function normalizeRentalRetailer(
  value
) {
  const retailer =
    String(value || "")
      .trim()
      .toLowerCase();

  return [
    "target",
    "walmart"
  ].includes(retailer)
    ? retailer
    : null;
}

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
        method: "DELETE"
      }
    );

  if (
    !response.ok &&
    response.status !== 404
  ) {
    throw new Error(
      `Unable to delete admin profile Discord message (${response.status}).`
    );
  }

  return true;
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
          "A customer completed a paid ACO profile. Open Admin and activate it when setup is complete.",
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
            : "A managed profile was assigned and is now ACTIVATING. Open Admin to review it. Activate once the required customer shipping/payment information is complete.",

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


function membershipPlanFromStripePriceId(
  priceId
) {
  const wanted =
    String(
      priceId ||
      ""
    );

  if (!wanted) {
    return null;
  }

  for (
    const [
      tier,
      plan
    ] of
    Object.entries(
      PLANS
    )
  ) {
    if (
      String(
        plan?.priceId ||
        ""
      ) ===
      wanted
    ) {
      return {
        tier:
          Number(tier),
        ...plan
      };
    }
  }

  return null;
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

    securityCodeConfigured:
      Boolean(
        method.securityCode
      ),

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

    /*
      This is the separate account security
      code entered in the site profile.
      It is only returned through an
      authenticated ADMIN endpoint.
      It is not treated as a card CVV/CVC.
    */
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

async function customerSavedDetailsPayload(
  account
) {
  const vault =
    await getCustomerVault(
      account.id
    );

  return {
    addresses:
      customerSavedAddresses(
        account
      ),

    paymentMethods:
      vault.paymentMethods.map(
        publicSavedPaymentMethod
      )
  };
}


async function adminCustomerSavedDetailsPayload(
  account
) {
  const vault =
    await getCustomerVault(
      account.id
    );

  return {
    addresses:
      customerSavedAddresses(
        account
      ),

    paymentMethods:
      vault.paymentMethods.map(
        adminSavedPaymentMethod
      )
  };
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
    8 * 60 * 60 * 1000;

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



function preferPreviouslyAssignedManagedAccounts(
  availableAccounts,
  rentalAssignments,
  customerAccountId,
  retailer
) {
  const previousIds =
    [];

  for (
    const assignment of
    rentalAssignments
      .filter(
        item =>
          String(
            item.customerAccountId ||
            ""
          ) ===
            String(
              customerAccountId
            ) &&
          String(
            item.rentalRetailer ||
            ""
          ) ===
            String(
              retailer
            )
      )
      .sort(
        (a,b) =>
          new Date(
            b.endedAt ||
            b.updatedAt ||
            b.createdAt ||
            0
          ).getTime() -
          new Date(
            a.endedAt ||
            a.updatedAt ||
            a.createdAt ||
            0
          ).getTime()
      )
  ) {
    const id =
      String(
        assignment.managedAccountId ||
        assignment.rentedMembershipId ||
        ""
      );

    if (
      id &&
      !previousIds.includes(id)
    ) {
      previousIds.push(id);
    }
  }

  const preference =
    new Map(
      previousIds.map(
        (id,index) => [
          id,
          index
        ]
      )
    );

  return [
    ...availableAccounts
  ].sort(
    (a,b) => {
      const ai =
        preference.has(
          String(a.id)
        )
          ? preference.get(
              String(a.id)
            )
          : Number.MAX_SAFE_INTEGER;

      const bi =
        preference.has(
          String(b.id)
        )
          ? preference.get(
              String(b.id)
            )
          : Number.MAX_SAFE_INTEGER;

      return ai - bi;
    }
  );
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
            rentalPriceFor(
              quantity,
              durationType
            );

          if (
            retailer &&
            [5, 10, 15].includes(
              quantity
            ) &&
            [
              "1_drop",
              "1_week",
              "1_month"
            ].includes(durationType) &&
            expectedPrice != null &&
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

              const paidRecord =
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

              if (!paidRecord) {
                console.error(
                  "Rental fulfillment skipped: active paid membership was not found.",
                  session.id
                );
              } else {
                const rawAvailableAccounts =
                  await getAvailableManagedAccountsForRetailer(
                    retailer
                  );

                const rentalHistory =
                  await getRentalAssignments();

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
                    await loadEncryptedPackage(
                      paidRecord.id
                    );

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
                    const retailerLabel =
                      retailer ===
                      "walmart"
                        ? "Walmart"
                        : "Target";

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
                customerHasOgMemberStatus(
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

async function getManagedAccounts() {
  const records =
    await readJson(
      MANAGED_ACCOUNTS_FILE,
      []
    );

  return Array.isArray(records)
    ? records
    : [];
}


async function saveManagedAccounts(
  records
) {
  await writeJson(
    MANAGED_ACCOUNTS_FILE,
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
      publicProfileCardSummary(
        customerSecrets
      ),

    readiness,

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
      publicProfileCardSummary(
        customerSecrets
      ),

    readiness,

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
            assignment.activationStatus =
              "expired";

            assignment.expiredAt =
              now.toISOString();

            assignment.updatedAt =
              now.toISOString();

            assignment.endReason =
              "expired";

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
            assignment.activationStatus =
              "expired";

            assignment.expiredAt =
              now.toISOString();

            assignment.updatedAt =
              now.toISOString();

            assignment.endReason =
              "expired";

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
        readiness.ready
          ? (
              previousActivationStatus ===
                "activated"
                ? "activated"
                : "awaiting_activation"
            )
          : "incomplete";

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
            8 * 60 * 60 * 1000
        }
      );

      res.setHeader(
        "Set-Cookie",
        `sng_admin=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${
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


        const linkedProfileCount =
          record.customerAccountId
            ? (
                freeAssignmentsForAdmin.filter(
                  assignment =>
                    assignment.customerAccountId ===
                      record.customerAccountId &&
                    freeAssignmentIsActive(
                      assignment
                    )
                ).length +
                rentalAssignmentsForAdmin.filter(
                  assignment =>
                    assignment.customerAccountId ===
                      record.customerAccountId &&
                    rentalAssignmentIsActive(
                      assignment
                    )
                ).length
              )
            : 0;

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
          customerHasOgMemberStatus(
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

          ogMember,

          linkedProfileCount,

          totalProfileCount:
            paidProfileCount +
            linkedProfileCount,

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

async function importFreeTargetAccountsOnce() {
  const memberships =
    await getFreeMemberships();

  const accounts = [
    ["joan_west530@web.de", "h01G#g4ngyHo"],
    ["jason941_castro@web.de", "wrFNm8rz%oxz"],
    ["kimberly_hayes467@web.de", "^Zk@GvR76uWP"],
    ["nancy_rodriguez721@web.de", "#CK9r55#iScQ"],
    ["donna728_perez@web.de", "8ynghMp!a1J$"],
    ["julie920_phillips@web.de", "I^T#qeQE0Ggax"],
    ["xavier_gibson118@web.de", "Ot$QSesm35Yb"],
    ["tyler_flores72@web.de", "wZwdUlakp$4!Z"],
    ["linda948_morales@web.de", "SMbj@6xtivLu"],
    ["frances73_aguilar@web.de", "sqBCd%6Vh@2i"],
    ["amanda116_aguilar@web.de", "cq#oeczY3HLtH"],
    ["diego868_gibson@web.de", "Rk#t9KKZ0WEK"],
    ["betty585_gutierrez@web.de", "F0LL3xhFV$0W"],
    ["dominic_reynolds67@web.de", "YxNr1h#Y^V@^U"],
    ["chris40_myers@web.de", "HkP#gFVeYP3o"],
    ["evan648_dixon@web.de", "6%cJWnI0jrnT"],
    ["joe_foster614@web.de", "ClK^Sf9MXB4F"],
    ["sara_bailey408@web.de", "0ZfQt1@UhUm8#"],
    ["julie778_freeman@web.de", "fx^0t43pWcAoF"],
    ["david_campbell323@web.de", "wwAakz7Hj!th"],
    ["thomas_ford883@web.de", "ys@uH7!EI$Gy"],
    ["thomas_perry443@web.de", "2Q9HCGOX@!ko"],
    ["mark300_lee@web.de", "j6nq!%z$LZQ3"],
    ["carter392_cooper@web.de", "E8SNw^3Unhg5"],
    ["noah_clark569@web.de", "unbBH4w8WML!"],
    ["maria_ross469@web.de", "X6LqfvJvky$Za"],
    ["martha_rogers892@web.de", "D%7M9ImeDZ#jR"],
    ["william_powell402@web.de", "SBVv%#a6296X"],
    ["martha_bryant708@web.de", "#vW5lV9%a40T"],
    ["maria_torres386@web.de", "nsD$c@C3h9LgM"],
    ["hannah10_herrera@web.de", "^zzgAg599B4N"],
    ["mary623_mendoza@web.de", "RLYydS0y9!tso"],
    ["connor579_reynolds@web.de", "OeJ@6dmLZ1bWV"],
    ["linda480_roberts@web.de", "#135f3CFvswi@"],
    ["colin_wallace35@web.de", "5oJ%#vc7KQSOR"],
    ["kevin_griffin119@web.de", "s2p8ZZ##Tw3IC"],
    ["cynthia977_porter@web.de", "4iUgZW8B@cJ7"],
    ["tim389_rivera@web.de", "VQ$yjH#85hpRa"],
    ["nicholas159_evans@web.de", "0q$I^49N^ZiQm"],
    ["eli259_jackson@web.de", "ZoRpv2#@ZRbC"],
    ["laura837_west@web.de", "5btwyCE@L9Jw"],
    ["chase_ross271@web.de", "VCH7b0JFGIT%"],
    ["alexander_thomas404@web.de", "h2Hc1Peg^LuF"],
    ["judith_guerrero433@web.de", "X9$^FY8ZZeyZ"],
    ["landon_bryant874@web.de", "a$^3Wxh8e45l"],
    ["janet617_ramos@web.de", "DQ8DoTZ!Pgef#"],
    ["kevin_moore543@web.de", "5R9tdfjhkXN!"],
    ["deborah_harris583@web.de", "WK9wfPcHz!uXb"],
    ["judith_brooks580@web.de", "6MEgE!EO8mWc"],
    ["xavier_rodriguez973@web.de", "%6Xle!EJ3q%XJ"]
  ];

  const existingTargetEmails =
    new Set();

  for (const membership of memberships) {
    try {
      if (!membership.credentials) {
        continue;
      }

      const credentials =
        decryptJson(
          membership.credentials
        );

      const targetEmail =
        String(
          credentials?.target?.username ||
          ""
        )
          .trim()
          .toLowerCase();

      if (targetEmail) {
        existingTargetEmails.add(
          targetEmail
        );
      }
    } catch {
      // Ignore memberships that cannot
      // be decrypted during duplicate check.
    }
  }

  const now =
    new Date().toISOString();

  let added = 0;

  for (const [email, password] of accounts) {
    const normalizedEmail =
      email.trim().toLowerCase();

    if (
      existingTargetEmails.has(
        normalizedEmail
      )
    ) {
      continue;
    }

    const credentials =
      emptyRetailerCredentials();

    credentials.target = {
      username: email,
      password
    };

    memberships.push({
      id:
        crypto.randomUUID(),

      profileName:
        "FREE MEMBERSHIP",

      accountEmail:
        "",

      notes:
        "",

      credentials:
        encryptJson(
          credentials
        ),

      createdAt:
        now,

      updatedAt:
        now
    });

    existingTargetEmails.add(
      normalizedEmail
    );

    added += 1;
  }

  if (added > 0) {
    await saveFreeMemberships(
      memberships
    );
  }

  console.log(
    `FREE Target import: ${added} account(s) added.`
  );
}

async function migrateFreeAccountsToManagedPoolOnce() {
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

async function importWalmartManagedAccountsOnce() {
  const managedAccounts =
    await getManagedAccounts();

  const accounts = [
    ["thomas535_baker@web.de", "kIY^gjRRfl3B9"],
    ["diego_myers291@web.de", "IwCiv4nR%^kp"],
    ["anthony_webb331@web.de", "FQh8YuEoO@n^L"],
    ["nicholas_walker18@web.de", "e5L#zwRI7FU5"],
    ["nicholas_dixon663@web.de", "oFU#4gMC#g80w"],
    ["robert_rodriguez718@web.de", "KvuNZKw^D!E6z"],
    ["thomas_alvarez205@web.de", "V6gXHaCo2gvy^"],
    ["emily161_parker@web.de", "Cgkj36n@t$nu"],
    ["dorothy253_moreno@web.de", "zy8POninOOSR#"],
    ["anthony_hernandez560@web.de", "0K^j!pIrKQ8hI"],
    ["alex903_wallace@web.de", "PnChvEK^E1JL"],
    ["miles155_hill@web.de", "I!VbTZ4QHaTXc"],
    ["deborah_palmer832@web.de", "6%1#cB1sC#xB"],
    ["marie_rodriguez696@web.de", "Usjks8^Wams7y"],
    ["judith610_davis@web.de", "KuQ6Zi@zerl3"],
    ["joe_jenkins683@web.de", "R@jlAoL1D$m#"],
    ["owen505_vasquez@web.de", "5L@Mf@$8Ygbv2"],
    ["martha519_barnes@web.de", "ba%!y^5DJO!9"],
    ["cheryl333_roberts@web.de", "cUPv0ycg@3#5"],
    ["chris688_moore@web.de", "dgk0Fx!Q3o7D"],
    ["joseph_guerrero899@web.de", "355LnP8gLKgV^"],
    ["christian_guerrero265@web.de", "5ABOi98G#bvn"],
    ["dorothy_hill645@web.de", "$ZkXJ7rIq9kaw"],
    ["alexander171_garcia@web.de", "hFkYS9DTNO^9"],
    ["dorothy717_powell@web.de", "4hYd^GHA51Ud"],
    ["mark_vasquez836@web.de", "#5k3mi$FYjA^"],
    ["jack_hall116@web.de", "BY1h2eq%Qm$r"],
    ["nathaniel706_wallace@web.de", "ViBIblhjF@g%3"],
    ["andrea_wells291@web.de", "kCd8@qSFeZD$"],
    ["anthony163_webb@web.de", "!^!%d0H84DTBV"],
    ["brenda_aguilar985@web.de", "9zLHdhP%pX^g"],
    ["jane_hayes306@web.de", "6V0ek!HGmtBq9"],
    ["martha_evans495@web.de", "bnNEL#IvPP63k"],
    ["jessica_hughes877@web.de", "Z!GSP8rq@MevW"],
    ["nancy605_alvarez@web.de", "7jEp7CUj5@QvU"],
    ["jason79_ross@web.de", "Vxb6FLRl2^mV"],
    ["linda286_adams@web.de", "Kv#iq8Vl!zHa"],
    ["william269_robinson@web.de", "ewUD4q%%BTGe"],
    ["martha748_cook@web.de", "1I4LBnc8IU%D8"],
    ["ruth_collins157@web.de", "b31@Lh6T!ikH"],
    ["austin45_torres@web.de", "jPhhfG6b2JQ!"],
    ["lisa_green714@web.de", "g4FSr%ErrXxT"],
    ["jonathan147_reed@web.de", "75ppCVGn!t3E"],
    ["deborah398_rogers@web.de", "Nk$LGwbFb34G"],
    ["joshua_thompson225@web.de", "sp3H6fsCF#MN"],
    ["jessica240_sanders@web.de", "6ksCDA5Z@FEi$"],
    ["owen_gray843@web.de", "t@IvWIwtY6i3"],
    ["laura_sullivan57@web.de", "hKWb0uWt^wG1N"],
    ["hunter812_barnes@web.de", "!cha6qO!E62%"],
    ["patricia365_webb@web.de", "KLy9%NF8#EBkd"]
  ];

  const existingWalmartEmails =
    new Set();

  for (const account of managedAccounts) {
    try {
      if (!account.credentials) {
        continue;
      }

      const credentials =
        decryptJson(
          account.credentials
        );

      const walmartEmail =
        String(
          credentials?.walmart?.username ||
          ""
        )
          .trim()
          .toLowerCase();

      if (walmartEmail) {
        existingWalmartEmails.add(
          walmartEmail
        );
      }
    } catch {
      // Ignore unreadable records
      // during duplicate checking.
    }
  }

  const now =
    new Date().toISOString();

  let added = 0;

  for (const [email, password] of accounts) {
    const normalizedEmail =
      email.trim().toLowerCase();

    if (
      existingWalmartEmails.has(
        normalizedEmail
      )
    ) {
      continue;
    }

    const credentials =
      emptyRetailerCredentials();

    credentials.walmart = {
      username: email,
      password
    };

    managedAccounts.push({
      id:
        crypto.randomUUID(),

      profileName:
        "MANAGED WALMART ACCOUNT",

      accountEmail:
        "",

      notes:
        "",

      credentials:
        encryptJson(
          credentials
        ),

      source:
        "walmart-import",

      createdAt:
        now,

      updatedAt:
        now
    });

    existingWalmartEmails.add(
      normalizedEmail
    );

    added += 1;
  }

  if (added > 0) {
    await saveManagedAccounts(
      managedAccounts
    );
  }

  console.log(
    `Walmart managed import: ${added} account(s) added.`
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

  const inUseAccountIds =
    new Set();

  for (const assignment of freeAssignments) {
    if (
      !freeAssignmentIsActive(
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
      !rentalAssignmentIsActive(
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

  const availability = {
    target: {
      total: 0,
      available: 0,
      inUse: 0
    },

    walmart: {
      total: 0,
      available: 0,
      inUse: 0
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
      "walmart"
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
  retailer
) {
  const normalizedRetailer =
    normalizeRentalRetailer(
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

  const inUseAccountIds =
    new Set();

  for (const assignment of freeAssignments) {
    if (!freeAssignmentIsActive(assignment)) {
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

  for (const assignment of rentalAssignments) {
    if (!rentalAssignmentIsActive(assignment)) {
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

  const available = [];

  for (const account of managedAccounts) {
    if (
      inUseAccountIds.has(
        String(account.id)
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
            ?.username || ""
        ).trim()
      ) {
        available.push(account);
      }
    } catch {
      // Skip accounts that cannot be decrypted.
    }
  }

  return available;
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
      hostConfigured:
        Boolean(
          config.host
        )
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
    "walmart"
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
      assignment.active === true
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
          freeAssignmentIsActive(
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
          rentalAssignmentIsActive(
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

  const inUseIds =
    new Set();

  for (const assignment of freeAssignments) {
    if (!freeAssignmentIsActive(assignment)) {
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
    if (!rentalAssignmentIsActive(assignment)) {
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

  return managedAccounts
    .filter(
      account =>
        !inUseIds.has(
          String(account.id)
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

      const displayEmail =
        clean(
          account.accountEmail,
          254
        ) ||
        targetEmail ||
        walmartEmail ||
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

      if (
        currentFreeAssignment(
          freeAssignments,
          id
        ) ||
        currentRentalAssignment(
          rentalAssignments,
          id
        )
      ) {
        return res
          .status(409)
          .json({
            error:
              "This membership is currently assigned and cannot be deleted from Available Memberships."
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
        normalizeRentalRetailer(
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

      const paidRecord =
        paidRecords.find(
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
        );

      if (!paidRecord) {
        return res
          .status(403)
          .json({
            error:
              "Available memberships can only be assigned to an active paid customer."
          });
      }

      const available =
        await getAvailableManagedAccountsForRetailer(
          retailer
        );

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

      const paidSecrets =
        await loadEncryptedPackage(
          paidRecord.id
        );

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
          assignment.active =
            false;

          assignment.activationStatus =
            "expired";

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
        memberships
          .filter(
            membership =>
              Boolean(
                currentFreeAssignment(
                  assignments,
                  membership.id
                )
              )
          )
          .map(
          membership => {
            const assignment =
              currentFreeAssignment(
                assignments,
                membership.id
              );

            const otherAssignment =
              currentRentalAssignment(
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

customerSecrets
            };
          }
        );

      const availableMemberships =
        await getAvailableManagedMembershipRecords();

      return res.json({
        ok: true,

        memberships:
          result,

        paidCustomers,

        availableMemberships
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
      }

      await saveFreeAssignments(
        assignments
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
          assignment.active =
            false;

          assignment.activationStatus =
            "expired";

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
        memberships
          .filter(
            membership =>
              Boolean(
                currentRentalAssignment(
                  assignments,
                  membership.id
                )
              )
          )
          .map(
          membership => {
            const assignment =
              currentRentalAssignment(
                assignments,
                membership.id
              );

            const otherAssignment =
              currentFreeAssignment(
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

customerSecrets
            };
          }
        );

      const availableMemberships =
        await getAvailableManagedMembershipRecords();

      return res.json({
        ok: true,

        memberships:
          result,

        paidCustomers,

        availableMemberships
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
      }

      await saveRentalAssignments(
        assignments
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

      const active = [];

      for (const assignment of freeAssignments) {
        if (
          assignment.customerAccountId !==
            customerAccountId ||
          !freeAssignmentIsActive(
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
            null
        });
      }

      for (const assignment of rentalAssignments) {
        if (
          assignment.customerAccountId !==
            customerAccountId ||
          !rentalAssignmentIsActive(
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
            null
        });
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
        slot > 50
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
            if (
              assignment.active !==
              true
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
                assignment.activationStatus =
                  "expired";

                assignment.expiredAt =
                  new Date()
                    .toISOString();

                assignment.endReason =
                  "expired";

                assignment.updatedAt =
                  assignment.expiredAt;

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

            const status =
              normalizeProfileActivationStatus(
                assignment.activationStatus,
                false
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

      if (
        action ===
          "activate" &&
        !readiness.ready
      ) {
        return res
          .status(400)
          .json({
            error:
              "This profile is still missing shipping or payment information."
          });
      }

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
        discordMessageId &&
        action !==
          "activating"
      ) {
        try {
          await deleteDiscordAdminProfileWorkflowNotification(
            discordMessageId
          );
        } catch (error) {
          console.error(
            "Managed profile Discord message delete failed:",
            error.message
          );
        }
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
          null
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
   CUSTOMER SAVED SHIPPING / PAYMENT METHODS
------------------------------------------------------- */

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
   CREATE RENTAL CHECKOUT SESSION
------------------------------------------------------- */

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
        rentalPriceFor(
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
        ![5, 10, 15].includes(
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

      if (!paidRecord) {
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
              `Only ${availableAccounts.length} ${retailer === "walmart" ? "Walmart" : "Target"} rental account(s) are currently available.`
          });
      }

      const retailerLabel =
        retailer === "walmart"
          ? "Walmart"
          : "Target";

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
                  paidRecord.id
                )
            },

            customer_email:
              req.customerAccount.email ||
              paidRecord.profile?.email ||
              undefined,

            allow_promotion_codes:
              false
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


async function recordSuccessCheckout(
  record
) {
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

  const duplicate =
    records.some(
      item =>
        String(item.id) ===
        String(safeRecord.id)
    );

  if (duplicate) {
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

  try {
    await sendDiscordSuccessNotification(
      storedRecord
    );
  } catch (error) {
    console.error(
      "Discord success notification failed:",
      error.message
    );
  }

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


async function sendDiscordSuccessNotification(
  record
) {
  const webhookUrl =
    String(
      process.env
        .DISCORD_SUCCESS_WEBHOOK_URL ||
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
            ""
          ).trim()
        );

      if (!configured) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "DISCORD_SUCCESS_WEBHOOK_URL is not configured."
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
      5 * 60 * 1000
    )
  );

const LIVE_SUCCESS_MIN_ACCOUNT_INTERVAL_MS =
  Math.max(
    30 * 1000,
    Number(
      process.env
        .SUCCESS_ACCOUNT_SYNC_THROTTLE_MS ||
      2 * 60 * 1000
    )
  );

const liveSuccessLastSyncByAccount =
  new Map();

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
  maxMessages = 60
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

      const startSequence =
        Math.max(
          1,
          totalMessages -
            safeMax +
            1
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
        Process oldest -> newest so Success history
        remains naturally ordered.
      */
      const orders = [];

      for (
        const candidate of
        candidates
      ) {
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
          !/order/i.test(
            subject
          )
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

  const mailboxes = [];

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

    for (
      const mailbox of
      mailboxes
    ) {
      try {
        const result =
          await readRecentRetailerOrders(
            mailbox.email,
            mailbox.password,
            60
          );

        for (
          const order of
          result.orders
        ) {
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

      } catch (error) {
        /*
          Do not expose mailbox credentials or raw
          provider responses in production logs.
        */
        console.error(
          "Live retailer Success mailbox sync failed:",
          error?.code ||
          error?.name ||
          "target_success_sync_error"
        );
      }
    }

    liveSuccessLastSyncByAccount
      .set(
        accountId,
        Date.now()
      );

    return {
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


async function readRecentManagedWorkMailboxOrders(
  maxMessages = 120
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
    new ImapFlow({
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
          config.password
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
    });

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

      const safeMax =
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

      const start =
        Math.max(
          1,
          total -
            safeMax +
            1
        );

      const candidates =
        await client.fetchAll(
          `${start}:*`,
          {
            uid: true,
            envelope: true,
            internalDate: true
          }
        );

      const orders = [];

      for (
        const candidate of
        candidates
      ) {
        const subject =
          String(
            candidate
              .envelope
              ?.subject ||
            ""
          );

        if (
          !/order/i.test(
            subject
          )
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
      }

      return {
        configured:
          true,
        orders
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
      180
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

  let saved = 0;
  let unmatched = 0;

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

    const wasSaved =
      await recordSuccessCheckout(
        successRecord
      );

    if (wasSaved) {
      saved += 1;
    }
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

    /*
      Managed Gifted/Rented profiles are routed from the
      business work mailbox using the managed account email
      plus the assignment time window. Historical Success
      stays permanently attached to the customer who owned
      the profile when the checkout happened.
    */
    await syncManagedProfileSuccessMailbox();

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
        Pull in any newly detected Target order
        confirmations before building the dashboard.
        This uses the same production record writer
        that sends the privacy-safe Discord webhook.
      */
      await syncCustomerTargetSuccess(
        accountId
      );

      await syncManagedProfileSuccessMailbox();

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
          customerHasOgMemberStatus(
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
  SUCCESS_CHECKOUTS_FILE
);

    
    app.listen(
      PORT,
      () => {
        console.log(
          `SLABSNGRABSACO server running on port ${PORT}`
        );

        startLiveSuccessScheduler();
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
