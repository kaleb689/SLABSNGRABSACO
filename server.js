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
    amount: 450,
    priceId: process.env.STRIPE_TIER6_PRICE_ID
  },

  7: {
    name: "Elite",
    profiles: 50,
    amount: 950,
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

                record.subscriptionStatus =
                  subscription.status;

                if (
                  subscription
                    .current_period_end
                ) {
                  record.currentPeriodEnd =
                    new Date(
                      subscription
                        .current_period_end *
                      1000
                    ).toISOString();
                }
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
            record.subscriptionStatus =
              subscription.status;

            if (
              subscription
                .current_period_end
            ) {
              record.currentPeriodEnd =
                new Date(
                  subscription
                    .current_period_end *
                  1000
                ).toISOString();
            }

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
  (req, res) => {
    res.set(
      "Cache-Control",
      "no-store"
    );

    return res
      .status(401)
      .json({
        error:
          "Customer authentication required."
      });
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
