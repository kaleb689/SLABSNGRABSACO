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
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDiscordCommunity, createDiscordLinkCode } from "./discord-community.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

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
      "rawtoken",jÇºã
âµç«®ŠÁ®‰ž˜©x¢'6V7&WB"À¢'vV&†öö²"À¢&7&VFVçF–Ç2 ¢Ò“° ¢f÷"€¢6öç7B°¢¶W’À¢—FVÐ¢Òöbö&¦V7BæVçG&–W2‡fÇVR¢’°¢6öç7Bæ÷&ÖÆ—¦VBÐ¢7G&–ær†¶W’¢çFôÆ÷vW$66R‚¢ç&WÆ6R€¢õµæ×£Ó•ÒörÀ¢" ¢“° ¢÷WGWE¶¶W•ÒÐ¢6Vç6—F—fT¶W—2æ†2€¢æ÷&ÖÆ—¦V@¢¢ò%µ$TD5DTEÒ ¢¢&VF7DÆöufÇVR€¢—FVÒÀ¢FWF‚²¢“°¢Ð ¢&WGW&â÷WGWC°§Ð  ¢ò ¢W†—7F–ær6öFR†2Öç’FVfVç6—fRW'&÷"Æöw2â6æ—F—¦RF†÷6RÆöw0¢6VçG&ÆÇ’6òF‡&÷vâ&÷f–FW"õ7G&—RöÖ–ÂW'&÷"6ææ÷B66–FVçFÆÇ¢Æ6R7&VFVçF–Ç2Â6öö¶–W2÷"gVÆÂ–ÖVçBfÇVW2–çFò&VæFW"Æöw2à¢¢ð¦6öç7B÷&–v–æÄ6öç6öÆTW'&÷"Ð¢6öç6öÆRæW'&÷"æ&–æB€¢6öç6öÆP¢“° ¦6öç6öÆRæW'&÷"Ò€¢ââæ&w0¢’Óâ°¢÷&–v–æÄ6öç6öÆTW'&÷"€¢ââæ&w2æÖ€¢fÇVRÓà¢&VF7DÆöufÇVR€¢fÇVP¢¢¢“°§Ó°  ¦gVæ7F–öâæ÷&ÖÆ—¦TFG&W75Fö¶VåFW‡B€¢fÇVRÒ" ¢’°¢&WGW&â7G&–ær‡fÇVRÇÂ""¢ç&WÆ6R‚õÇ2²örÂ""¢çG&–Ò‚“°§Ð  ¦gVæ7F–öâ6fTFG&W75f&–çG2€¢FG&W72Ò·Ð¢’°¢6öç7B7G&VWBÐ¢æ÷&ÖÆ—¦TFG&W75Fö¶VåFW‡B€¢FG&W72æFG&W72ÇÀ¢" ¢“° ¢6öç7BFG&W73"Ð¢æ÷&ÖÆ—¦TFG&W75Fö¶VåFW‡B€¢FG&W72æFG&W73"ÇÀ¢" ¢“° ¢6öç7B6—G’Ð¢æ÷&ÖÆ—¦TFG&W75Fö¶VåFW‡B€¢FG&W72æ6—G’ÇÀ¢" ¢“° ¢6öç7B7FFRÐ¢æ÷&ÖÆ—¦TFG&W75Fö¶VåFW‡B€¢FG&W72ç7FFRÇÀ¢" ¢“° ¢6öç7B¦—Ð¢æ÷&ÖÆ—¦TFG&W75Fö¶VåFW‡B€¢FG&W72ç¦—ÇÀ¢" ¢“° ¢6öç7B6÷VçG'’Ð¢æ÷&ÖÆ—¦TFG&W75Fö¶VåFW‡B€¢FG&W72æ6÷VçG'’ÇÀ¢" ¢“° ¢–b‚7G&VWB’°¢&WGW&âµÓ°¢Ð ¢ò ¢6fR¤”r&÷VæF'“ ¢vRöæÇ’7&VFRG'WF†gVÂf÷&ÖGF–ærf&–çG2öbF†RW†7BFG&W70¢F†R7W7FöÖW"7WÆ–VBâæWfW"6†ævR†÷W6RçVÖ&W"ÂVæ—BçVÖ&W"À¢6—G’Â7FFRÂ¤•Â6÷VçG'’Â÷"F†R7GVÂ7G&VWBÖæÖRv÷&G2à ¢U52V&Æ–6F–öâ#‚7W÷'G27FæF&F—¦VBF—&V7F–öæÂ÷7Vff—‚÷Væ—@¢&'&Wf–F–öç2æBöÖ—76–öâöbæöæW76VçF–ÂVæ7GVF–öââvRW6P¢F†÷6Rf÷&ÖGF–ærWV—fÆVæ6W2öæÇ’à¢¢ð¢6öç7BF—&V7F–öæÇ2Ò°¢²$äõ%D…tU5B"Â$år%ÒÀ¢²%4õUD…tU5B"Â%5r%ÒÀ¢²$äõ%D„T5B"Â$äR%ÒÀ¢²%4õUD„T5B"Â%4R%ÒÀ¢²$äõ%D‚"Â$â%ÒÀ¢²%4õUD‚"Â%2%ÒÀ¢²$T5B"Â$R%ÒÀ¢²%tU5B"Â%r%Ð¢Ó° ¢6öç7B7Vff—†W2Ò°¢²$ÄÄU’"Â$Å’%ÒÀ¢²$ääU‚"Â$å‚%ÒÀ¢²$$4DR"Â$$2%ÒÀ¢²$dTåTR"Â$dR%ÒÀ¢²$$”õR"Â$%•R%ÒÀ¢²$$T4‚"Â$$4‚%ÒÀ¢²$$TäB"Â$$äB%ÒÀ¢²$$ÅTdb"Â$$Äb%ÒÀ¢²$$ÅTde2"Â$$Äe2%ÒÀ¢²$$õEDôÒ"Â$%DÒ%ÒÀ¢²$$õTÄUd$B"Â$$ÅdB%ÒÀ¢²$%$ä4‚"Â$%"%ÒÀ¢²$%$”DtR"Â$%$r%ÒÀ¢²$%$ôô²"Â$%$²%ÒÀ¢²$%$ôôµ2"Â$%$µ2%ÒÀ¢²$%U$r"Â$$r%ÒÀ¢²$%U$u2"Â$$u2%ÒÀ¢²$%•52"Â$%•%ÒÀ¢²$4Õ"Â$5%ÒÀ¢²$4å”ôâ"Â$5”â%ÒÀ¢²$4R"Â$5R%ÒÀ¢²$4U4Ut’"Â$55u’%ÒÀ¢²$4TåDU""Â$5E"%ÒÀ¢²$4TåDU%2"Â$5E%2%ÒÀ¢²$4•$4ÄR"Â$4•"%ÒÀ¢²$4•$4ÄU2"Â$4•%2%ÒÀ¢²$4Ä”db"Â$4Äb%ÒÀ¢²$4Ä”de2"Â$4Äe2%ÒÀ¢²$4ÅT""Â$4Ä"%ÒÀ¢²$4ôÔÔôâ"Â$4Ôâ%ÒÀ¢²$4ôÔÔôå2"Â$4Ôå2%ÒÀ¢²$4õ$äU""Â$4õ"%ÒÀ¢²$4õ$äU%2"Â$4õ%2%ÒÀ¢²$4õU%4R"Â$5%4R%ÒÀ¢²$4õU%B"Â$5B%ÒÀ¢²$4õU%E2"Â$5E2%ÒÀ¢²$4õdR"Â$5b%ÒÀ¢²$5$TT²"Â$5$²%ÒÀ¢²$5$U44TåB"Â$5$U2%ÒÀ¢²$5$U5B"Â$5%5B%ÒÀ¢²$5$õ54”är"Â%„”är%ÒÀ¢²$5$õ55$ôB"Â%…$B%ÒÀ¢²$5U%dR"Â$5U%b%ÒÀ¢²$DÄR"Â$DÂ%ÒÀ¢²$DÒ"Â$DÒ%ÒÀ¢²$D•d”DR"Â$Eb%ÒÀ¢²$E$•dR"Â$E"%ÒÀ¢²$E$•dU2"Â$E%2%ÒÀ¢²$U5DDR"Â$U5B%ÒÀ¢²$U5DDU2"Â$U5E2%ÒÀ¢²$U…$U55t’"Â$U…’%ÒÀ¢²$U…DTå4”ôâ"Â$U…B%ÒÀ¢²$U…DTå4”ôå2"Â$U…E2%ÒÀ¢²$dÄÅ2"Â$dÅ2%ÒÀ¢²$dU%%’"Â$e%’%ÒÀ¢²$d”TÄB"Â$dÄB%ÒÀ¢²$d”TÄE2"Â$dÄE2%ÒÀ¢²$dÄB"Â$dÅB%ÒÀ¢²$dÄE2"Â$dÅE2%ÒÀ¢²$dõ$B"Â$e$B%ÒÀ¢²$dõ$E2"Â$e$E2%ÒÀ¢²$dõ$U5B"Â$e%5B%ÒÀ¢²$dõ$tR"Â$e$r%ÒÀ¢²$dõ$tU2"Â$e$u2%ÒÀ¢²$dõ$²"Â$e$²%ÒÀ¢²$dõ$µ2"Â$e$µ2%ÒÀ¢²$dõ%B"Â$eB%ÒÀ¢²$e$TUt’"Â$eu’%ÒÀ¢²$t$DTâ"Â$tDâ%ÒÀ¢²$t$DTå2"Â$tDå2%ÒÀ¢²$tDUt’"Â$uEu’%ÒÀ¢²$tÄTâ"Â$tÄâ%ÒÀ¢²$tÄTå2"Â$tÄå2%ÒÀ¢²$u$TTâ"Â$u$â%ÒÀ¢²$u$TTå2"Â$u$å2%ÒÀ¢²$u$õdR"Â$u%b%ÒÀ¢²$u$õdU2"Â$u%e2%ÒÀ¢²$„$$õ""Â$„%"%ÒÀ¢²$„$$õ%2"Â$„%%2%ÒÀ¢²$„dTâ"Â$…dâ%ÒÀ¢²$„T”t…E2"Â$…E2%ÒÀ¢²$„”t…t’"Â$…u’%ÒÀ¢²$„”ÄÂ"Â$„Â%ÒÀ¢²$„”ÄÅ2"Â$„Å2%ÒÀ¢²$„ôÄÄõr"Â$„ôÅr%ÒÀ¢²$”äÄUB"Â$”äÅB%ÒÀ¢²$•4ÄäB"Â$•2%ÒÀ¢²$•4ÄäE2"Â$•52%ÒÀ¢²$¥Tä5D”ôâ"Â$¤5B%ÒÀ¢²$¥Tä5D”ôå2"Â$¤5E2%ÒÀ¢²$´U’"Â$µ’%ÒÀ¢²$´U•2"Â$µ•2%ÒÀ¢²$´äôÄÂ"Â$´äÂ%ÒÀ¢²$´äôÄÅ2"Â$´äÅ2%ÒÀ¢²$Ä´R"Â$Ä²%ÒÀ¢²$Ä´U2"Â$Äµ2%ÒÀ¢²$ÄäD”är"Â$ÄäDr%ÒÀ¢²$ÄäR"Â$Äâ%ÒÀ¢²$Ä”t…B"Â$ÄuB%ÒÀ¢²$Ä”t…E2"Â$ÄuE2%ÒÀ¢²$Äô4²"Â$Ä4²%ÒÀ¢²$Äô4µ2"Â$Ä4µ2%ÒÀ¢²$ÄôDtR"Â$ÄDr%ÒÀ¢²$Ôäõ""Â$Ôå"%ÒÀ¢²$Ôäõ%2"Â$Ôå%2%ÒÀ¢²$ÔTDõr"Â$ÔEr%ÒÀ¢²$ÔTDõu2"Â$ÔEu2%ÒÀ¢²$Ô”ÄÂ"Â$ÔÂ%ÒÀ¢²$Ô”ÄÅ2"Â$ÔÅ2%ÒÀ¢²$Ô•54”ôâ"Â$Õ4â%ÒÀ¢²$ÔõDõ%t’"Â$ÕEu’%ÒÀ¢²$ÔõTåB"Â$ÕB%ÒÀ¢²$ÔõTåD”â"Â$ÕDâ%ÒÀ¢²$ÔõTåD”å2"Â$ÕDå2%ÒÀ¢²$äT4²"Â$ä4²%ÒÀ¢²$õ$4„$B"Â$õ$4‚%ÒÀ¢²$õdU%52"Â$õ2%ÒÀ¢²%$µt’"Â%µu’%ÒÀ¢²%54tR"Â%4tR%ÒÀ¢²%”äR"Â%äR%ÒÀ¢²%”äU2"Â%äU2%ÒÀ¢²%Ä4R"Â%Â%ÒÀ¢²%Ä”â"Â%Äâ%ÒÀ¢²%Ä”å2"Â%Äå2%ÒÀ¢²%Ä¤"Â%Å¢%ÒÀ¢²%ô”åB"Â%B%ÒÀ¢²%ô”åE2"Â%E2%ÒÀ¢²%õ%B"Â%%B%ÒÀ¢²%õ%E2"Â%%E2%ÒÀ¢²%$•$”R"Â%"%ÒÀ¢²%$”B"Â%%B%ÒÀ¢²%$”E2"Â%%E2%ÒÀ¢²%$U5B"Â%%5B%ÒÀ¢²%$”DtR"Â%$Dr%ÒÀ¢²%$”DtU2"Â%$Du2%ÒÀ¢²%$•dU""Â%$•b%ÒÀ¢²%$ôB"Â%$B%ÒÀ¢²%$ôE2"Â%$E2%ÒÀ¢²%$õUDR"Â%%DR%ÒÀ¢²%4„ôÂ"Â%4„Â%ÒÀ¢²%4„ôÅ2"Â%4„Å2%ÒÀ¢²%4„õ$R"Â%4…"%ÒÀ¢²%4„õ$U2"Â%4…%2%ÒÀ¢²%4µ•t’"Â%4µu’%ÒÀ¢²%5$”är"Â%5r%ÒÀ¢²%5$”äu2"Â%5u2%ÒÀ¢²%5T$R"Â%5%ÒÀ¢²%5T$U2"Â%52%ÒÀ¢²%5DD”ôâ"Â%5D%ÒÀ¢²%5E$TÒ"Â%5E$Ò%ÒÀ¢²%5E$TUB"Â%5B%ÒÀ¢²%5E$TUE2"Â%5E2%ÒÀ¢²%5TÔÔ•B"Â%4ÕB%ÒÀ¢²%DU%$4R"Â%DU"%ÒÀ¢²%D…$õTt…t’"Â%E%u’%ÒÀ¢²%E$4R"Â%E$4R%ÒÀ¢²%E$4²"Â%E$²%ÒÀ¢²%E$dd”5t’"Â%E$e’%ÒÀ¢²%E$”Â"Â%E$Â%ÒÀ¢²%E$”ÄU""Â%E$Å"%ÒÀ¢²%ETääTÂ"Â%ETäÂ%ÒÀ¢²%EU$å”´R"Â%E´R%ÒÀ¢²%TäDU%52"Â%U2%ÒÀ¢²%Tä”ôâ"Â%Tâ%ÒÀ¢²%Tä”ôå2"Â%Tå2%ÒÀ¢²%dÄÄU’"Â%dÅ’%ÒÀ¢²%dÄÄU•2"Â%dÅ•2%ÒÀ¢²%d”ET5B"Â%d”%ÒÀ¢²%d”Ur"Â%er%ÒÀ¢²%d”Uu2"Â%eu2%ÒÀ¢²%d”ÄÄtR"Â%dÄr%ÒÀ¢²%d”ÄÄtU2"Â%dÄu2%ÒÀ¢²%d”ÄÄR"Â%dÂ%ÒÀ¢²%d•5D"Â%d•2%ÒÀ¢²%tTÄÂ"Â%tÂ%ÒÀ¢²%tTÄÅ2"Â%tÅ2%Ð¢Ó° ¢6öç7BVæ—DFW6–væF÷'2Ò°¢²$%DÔTåB"Â$B%ÒÀ¢²$%T”ÄD”är"Â$$ÄDr%ÒÀ¢²$dÄôõ""Â$dÂ%ÒÀ¢²%5T•DR"Â%5DR%ÒÀ¢²%$ôôÒ"Â%$Ò%ÒÀ¢²$DU%DÔTåB"Â$DUB%Ð¢Ó° ¢6öç7B7G&VWEf&–çG2Ð¢æWr6WB…°¢7G&VW@¢Ò“° ¢6öç7BFE7G&VWBÐ¢fÇVRÓâ°¢6öç7Bæ÷&ÖÆ—¦VBÐ¢æ÷&ÖÆ—¦TFG&W75Fö¶VåFW‡B€¢fÇVP¢“° ¢–b†æ÷&ÖÆ—¦VB’°¢7G&VWEf&–çG2æFB€¢æ÷&ÖÆ—¦V@¢“°¢Ð¢Ó° ¢ò ¢&VF—&V7F–öæÃ¢–ÖÖVF–FVÇ’gFW"F†R&–Ö'’†÷W6RçVÖ&W"à¢÷7FF—&V7F–öæÃ¢f–æÂFö¶Vâà¢¢ð¢f÷"€¢6öç7B°¢gVÆÂÀ¢&' ¢ÒöbF—&V7F–öæÇ0¢’°¢6öç7BW66VDgVÆÂÐ¢gVÆÂç&WÆ6R€¢õ²â¢³õâG·Ò‚—ÅµÅÕÅÅÒörÀ¢%ÅÂBb ¢“° ¢6öç7BW66VD&'"Ð¢&'"ç&WÆ6R€¢õ²â¢³õâG·Ò‚—ÅµÅÕÅÅÒörÀ¢%ÅÂBb ¢“° ¢f÷"€¢6öç7B&6Rö`¢'&’æg&öÒ€¢7G&VWEf&–çG0¢¢’°¢FE7G&VWB€¢&6Rç&WÆ6R€¢æWr&VtW‡€¢â…ÅÇ2¥ÅÆBµ´Õ£Ó•ÅÂÒõÒ¥ÅÇ2²’G¶W66VDgVÆÇÕÅÆ&À¢&’ ¢’À¢CG¶&''Ö ¢¢“° ¢FE7G&VWB€¢&6Rç&WÆ6R€¢æWr&VtW‡€¢â…ÅÇ2¥ÅÆBµ´Õ£Ó•ÅÂÒõÒ¥ÅÇ2²’G¶W66VD&''ÕÅÆ&À¢&’ ¢’À¢CG¶gVÆÇÖ ¢¢“° ¢FE7G&VWB€¢&6Rç&WÆ6R€¢æWr&VtW‡€¢ÅÆ"G¶W66VDgVÆÇÒFÀ¢&’ ¢’À¢&' ¢¢“° ¢FE7G&VWB€¢&6Rç&WÆ6R€¢æWr&VtW‡€¢ÅÆ"G¶W66VD&''ÒFÀ¢&’ ¢’À¢gVÆÀ¢¢“°¢Ð¢Ð ¢ò ¢7G&VWB7Vff—ƒ¢öæÇ’G&ç6f÷&ÒF†Rf–æÂ7Vff—‚Fö¶VâÂ÷"F†RFö¶Và¢F—&V7FÇ’&Vf÷&RfÆ–B÷7FF—&V7F–öæÂâF†—2fö–G2&Ww&—F–ær¢7G&VWBÖæÖRv÷&BF†BÖW&VÇ’†Vç2FòÆöö²Æ–¶R7Vff—‚à¢¢ð¢f÷"€¢6öç7B°¢gVÆÂÀ¢&' ¢Òöb7Vff—†W0¢’°¢6öç7BgVÆÅGFW&âÐ¢gVÆÂç&WÆ6R€¢õ²â¢³õâG·Ò‚—ÅµÅÕÅÅÒörÀ¢%ÅÂBb ¢“° ¢6öç7B&'%GFW&âÐ¢&'"ç&WÆ6R€¢õ²â¢³õâG·Ò‚—ÅµÅÕÅÅÒörÀ¢%ÅÂBb ¢“° ¢6öç7B÷7DF—&V7F–öæÂÐ¢"ƒó¤çÅ7ÄWÅwÄäWÄåwÅ4WÅ5wÄäõ%D‡Å4õUD‡ÄT5GÅtU5GÄäõ%D„T5GÄäõ%D…tU5GÅ4õUD„T5GÅ4õUD…tU5B’#° ¢f÷"€¢6öç7B&6Rö`¢'&’æg&öÒ€¢7G&VWEf&–çG0¢¢’°¢FE7G&VWB€¢&6Rç&WÆ6R€¢æWr&VtW‡€¢ÅÆ"G¶gVÆÅGFW&çÕÅÆ"ƒóÒƒó¥ÅÇ2²G·÷7DF—&V7F–öæÇÒ“òB–À¢&’ ¢’À¢&' ¢¢“° ¢FE7G&VWB€¢&6Rç&WÆ6R€¢æWr&VtW‡€¢ÅÆ"G¶&'%GFW&çÕÅÆ"ƒóÒƒó¥ÅÇ2²G·÷7DF—&V7F–öæÇÒ“òB–À¢&’ ¢’À¢gVÆÀ¢¢“°¢Ð¢Ð ¢ò ¢¶VWVæ7GVF–öâF†B6â&R6–væ–f–6çBFòFVÆ—fW'’Â–æ6ÇVF–æp¢W&–öG2Â6Æ6†W2Â‡—†Vç2ÂæB÷7G&÷†W2âöæÇ’öÖ—B6öÖÖÀ¢v†–6‚FöW2æ÷B6†ævRF†RFVÆ—fW'’ÖFG&W726ö×öæVçG2à¢¢ð¢f÷"€¢6öç7B&6Rö`¢'&’æg&öÒ€¢7G&VWEf&–çG0¢¢’°¢FE7G&VWB€¢&6Rç&WÆ6R€¢òÂörÀ¢" ¢¢“°¢Ð ¢6öç7BVæ—Ef&–çG2Ð¢æWr6WB…°¢FG&W73 ¢Ò“° ¢6öç7BFEVæ—BÐ¢fÇVRÓâ°¢6öç7Bæ÷&ÖÆ—¦VBÐ¢æ÷&ÖÆ—¦TFG&W75Fö¶VåFW‡B€¢fÇVP¢“° ¢Væ—Ef&–çG2æFB€¢æ÷&ÖÆ—¦V@¢“°¢Ó° ¢–b†FG&W73"’°¢f÷"€¢6öç7B°¢gVÆÂÀ¢&' ¢ÒöbVæ—DFW6–væF÷'0¢’°¢6öç7BgVÆÅGFW&âÐ¢gVÆÂç&WÆ6R€¢õ²â¢³õâG·Ò‚—ÅµÅÕÅÅÒörÀ¢%ÅÂBb ¢“° ¢6öç7B&'%GFW&âÐ¢&'"ç&WÆ6R€¢õ²â¢³õâG·Ò‚—ÅµÅÕÅÅÒörÀ¢%ÅÂBb ¢“° ¢f÷"€¢6öç7B&6Rö`¢'&’æg&öÒ€¢Væ—Ef&–çG0¢¢’°¢FEVæ—B€¢&6Rç&WÆ6R€¢æWr&VtW‡€¢âG¶gVÆÅGFW&çÕÅÆ&À¢&’ ¢’À¢&' ¢¢“° ¢FEVæ—B€¢&6Rç&WÆ6R€¢æWr&VtW‡€¢âG¶&'%GFW&çÕÅÆ&À¢&’ ¢’À¢gVÆÀ¢¢“° ¢FEVæ—B€¢&6Rç&WÆ6R€¢òÂörÀ¢" ¢¢“°¢Ð¢Ð¢Ð ¢6öç7B6VVâÐ¢æWr6WB‚“° ¢6öç7Bf&–çG2Ð¢µÓ° ¢f÷"€¢6öç7Bf&–çE7G&VWBö`¢7G&VWEf&–çG0¢’°¢f÷"€¢6öç7Bf&–çEVæ—Bö`¢Væ—Ef&–çG0¢’°¢6öç7B—FVÒÒ°¢FG&W73 ¢f&–çE7G&VWBÀ ¢FG&W73# ¢f&–çEVæ—BÀ ¢6—G’À ¢7FFRÀ ¢¦—À ¢6÷VçG'¢Ó° ¢6öç7B¶W’Ð¢¥4ôâç7G&–æv–g’€¢—FVÐ¢¢çFõWW$66R‚“° ¢–b€¢6VVâæ†2€¢¶W¢¢’°¢6öçF–çVS°¢Ð ¢6VVâæFB€¢¶W¢“° ¢f&–çG2çW6‚€¢—FVÐ¢“° ¢–b€¢f&–çG2æÆVæwF‚ãÐ¢# ¢’°¢&WGW&âf&–çG3°¢Ð¢Ð¢Ð ¢&WGW&âf&–çG3°§Ð  ¦gVæ7F–öâ6fTFG&W75f&–çD¶W’€¢FG&W72Ò·Ð¢’°¢&WGW&â¥4ôâç7G&–æv–g’‡°¢FG&W73 ¢æ÷&ÖÆ—¦TFG&W75Fö¶VåFW‡B€¢FG&W72æFG&W72ÇÀ¢" ¢’çFõWW$66R‚’À ¢FG&W73# ¢æ÷&ÖÆ—¦TFG&W75Fö¶VåFW‡B€¢FG&W72æFG&W73"ÇÀ¢" ¢’çFõWW$66R‚’À ¢6—G“ ¢æ÷&ÖÆ—¦TFG&W75Fö¶VåFW‡B€¢FG&W72æ6—G’ÇÀ¢" ¢’çFõWW$66R‚’À ¢7FFS ¢æ÷&ÖÆ—¦TFG&W75Fö¶VåFW‡B€¢FG&W72ç7FFRÇÀ¢" ¢’çFõWW$66R‚’À ¢¦— ¢æ÷&ÖÆ—¦TFG&W75Fö¶VåFW‡B€¢FG&W72ç¦—ÇÀ¢" ¢’çFõWW$66R‚’À ¢6÷VçG'“ ¢æ÷&ÖÆ—¦TFG&W75Fö¶VåFW‡B€¢FG&W72æ6÷VçG'’ÇÀ¢" ¢’çFõWW$66R‚¢Ò“°§Ð  ¦6öç7B6ÆVâÒ‡fÇVRÂÖ‚Ò3’Óà¢7G&–ær‡fÇVRóò""¢çG&–Ò‚¢ç6Æ–6RƒÂÖ‚“° ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢5E$•R5T%45$•D”ôâ„TÅU%0¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦gVæ7F–öâ7G&—UF–ÖW7F×Fô—6ò‡fÇVR’°¢6öç7BF–ÖW7F×ÒçVÖ&W"‡fÇVR“° ¢–b€¢çVÖ&W"æ—4f–æ—FR‡F–ÖW7F×’ÇÀ¢F–ÖW7F×ÃÒ ¢’°¢&WGW&âçVÆÃ°¢Ð ¢&WGW&âæWrFFR€¢F–ÖW7F×¢ ¢’çFô•4õ7G&–ær‚“°§Ð ¦7–æ2gVæ7F–öâvWE7V'67&—F–öåW&–öDVæB‡7V'67&—F–öâ’°¢–b‡7V'67&—F–öãòæ7W'&VçE÷W&–öEöVæB’°¢&WGW&â7G&—UF–ÖW7F×Fô—6ò€¢7V'67&—F–öâæ7W'&VçE÷W&–öEöVæ@¢“°¢Ð ¢ÆWB—FV×2Ð¢7V'67&—F–öãòæ—FV×3òæFFÇÂµÓ° ¢ò ¢–b7G&—Rw27V'67&—F–öâ&W7öç6RFöW6âw@¢6öçF–âF†R&–ÆÆ–ær×W&–öBf–VÆG2Â&WG&–WfP¢F†R7V'67&—F–öâ—FV×2F—&V7FÇ’à¢¢ð ¢–b€¢7V'67&—F–öãòæ–Bb`¢—FV×2ç6öÖR€¢—FVÒÓâ—FVÓòæ7W'&VçE÷W&–öEöVæ@¢¢’°¢6öç7B—FVÔÆ—7BÐ¢v—B7G&—Rç7V'67&—F–öä—FV×2æÆ—7B‡°¢7V'67&—F–öã¢7V'67&—F–öâæ–BÀ¢Æ–Ö—C¢ ¢Ò“° ¢—FV×2Ð¢—FVÔÆ—7CòæFFÇÂµÓ°¢Ð ¢6öç7BW&–öDVæG2Ð¢—FV×0¢æÖ†—FVÒÓà¢çVÖ&W"€¢—FVÓòæ7W'&VçE÷W&–öEöVæ@¢¢¢æf–ÇFW"‡fÇVRÓà¢çVÖ&W"æ—4f–æ—FR‡fÇVR’b`¢fÇVRâ ¢“° ¢–b‚W&–öDVæG2æÆVæwF‚’°¢&WGW&âçVÆÃ°¢Ð ¢&WGW&â7G&—UF–ÖW7F×Fô—6ò€¢ÖF‚æÖ‚‚ââçW&–öDVæG2¢“°§Ð ¦7–æ2gVæ7F–öâvWE7V'67&—F–öåW&–öE7F'B‡7V'67&—F–öâ’°¢–b‡7V'67&—F–öãòæ7W'&VçE÷W&–öE÷7F'B’°¢&WGW&â7G&—UF–ÖW7F×Fô—6ò€¢7V'67&—F–öâæ7W'&VçE÷W&–öE÷7F'@¢“°¢Ð ¢ÆWB—FV×2Ð¢7V'67&—F–öãòæ—FV×3òæFFÇÂµÓ° ¢–b€¢7V'67&—F–öãòæ–Bb`¢—FV×2ç6öÖR€¢—FVÒÓâ—FVÓòæ7W'&VçE÷W&–öE÷7F'@¢¢’°¢6öç7B—FVÔÆ—7BÐ¢v—B7G&—Rç7V'67&—F–öä—FV×2æÆ—7B‡°¢7V'67&—F–öã¢7V'67&—F–öâæ–BÀ¢Æ–Ö—C¢ ¢Ò“° ¢—FV×2Ð¢—FVÔÆ—7CòæFFÇÂµÓ°¢Ð ¢6öç7BW&–öE7F'G2Ð¢—FV×0¢æÖ†—FVÒÓà¢çVÖ&W"€¢—FVÓòæ7W'&VçE÷W&–öE÷7F'@¢¢¢æf–ÇFW"‡fÇVRÓà¢çVÖ&W"æ—4f–æ—FR‡fÇVR’b`¢fÇVRâ ¢“° ¢–b‚W&–öE7F'G2æÆVæwF‚’°¢&WGW&âçVÆÃ°¢Ð ¢&WGW&â7G&—UF–ÖW7F×Fô—6ò€¢ÖF‚æÖ–â‚ââçW&–öE7F'G2¢“°§Ð ¦gVæ7F–öâ7G&—U&–6T–Dg&öÕ7V'67&—F–öâ€¢7V'67&—F–öà¢’°¢6öç7B—FV×2Ð¢7V'67&—F–öà¢òæ—FV×0¢òæFFÇÂµÓ° ¢6öç7B—FVÒÐ¢—FV×2æf–æB€¢VçG'’Óà¢VçG'“òç&–6P¢“° ¢–b‚—FVÒ’°¢&WGW&â"#°¢Ð ¢–b€¢G—Vöb—FVÒç&–6RÓÓÐ¢'7G&–ær ¢’°¢&WGW&â—FVÒç&–6S°¢Ð ¢&WGW&â7G&–ær€¢—FVÒç&–6Sòæ–BÇÀ¢" ¢“°§Ð  ¦gVæ7F–öâÆäf÷%7G&—U&–6T–B€¢&–6T–@¢’°¢6öç7Bæ÷&ÖÆ—¦VE&–6T–BÐ¢7G&–ær€¢&–6T–BÇÂ" ¢“° ¢–b‚æ÷&ÖÆ—¦VE&–6T–B’°¢&WGW&âçVÆÃ°¢Ð ¢f÷"€¢6öç7B°¢F–W%fÇVRÀ¢Æà¢Òöbö&¦V7BæVçG&–W2€¢Äå0¢¢’°¢–b€¢Æâç&–6T–Bb`¢7G&–ær€¢Æâç&–6T–@¢’ÓÓÐ¢æ÷&ÖÆ—¦VE&–6T–@¢’°¢&WGW&â°¢F–W# ¢çVÖ&W"€¢F–W%fÇVP¢’À ¢æÖS ¢ÆâææÖRÀ ¢&öf–ÆW3 ¢Æâç&öf–ÆW2À ¢Ö÷VçC ¢ÆâæÖ÷VçBÀ ¢&–6T–C ¢Æâç&–6T–@¢Ó°¢Ð¢Ð ¢&WGW&âçVÆÃ°§Ð  ¦gVæ7F–öâ7–æ5&V6÷&EÆäg&öÕ7V'67&—F–öâ€¢&V6÷&BÀ¢7V'67&—F–öà¢’°¢–b€¢&V6÷&BÇÀ¢7V'67&—F–öà¢’°¢&WGW&âçVÆÃ°¢Ð ¢6öç7B&–6T–BÐ¢7G&—U&–6T–Dg&öÕ7V'67&—F–öâ€¢7V'67&—F–öà¢“° ¢6öç7BÖF6†VEÆâÐ¢Æäf÷%7G&—U&–6T–B€¢&–6T–@¢“° ¢–b‚ÖF6†VEÆâ’°¢&WGW&âçVÆÃ°¢Ð ¢&V6÷&BçÆâÒ°¢F–W# ¢ÖF6†VEÆâçF–W"À ¢æÖS ¢ÖF6†VEÆâææÖRÀ ¢&öf–ÆW3 ¢ÖF6†VEÆâç&öf–ÆW2À ¢Ö÷VçC ¢ÖF6†VEÆâæÖ÷Vç@¢Ó° ¢&WGW&âÖF6†VEÆã°§Ð  ¦7–æ2gVæ7F–öâÇ•7V'67&—F–öä–æfò€¢&V6÷&BÀ¢7V'67&—F–öà¢’°¢–b€¢&V6÷&BÇÀ¢7V'67&—F–öà¢’°¢&WGW&â&V6÷&C°¢Ð ¢ò ¢7–æ6‡&öæ—¦RF†RÆö6ÂÖVÖ&W'6†—F–W ¢g&öÒF†R7GVÂ7G&—R7V'67&—F–öâ&–6Rà ¢F†—2ÆÆ÷w2Ww&FW2ÖFRF‡&÷Vv‚F†—26—FP¢÷"F—&V7FÇ’–â7G&—RFòWFFRF†R7W7FöÖW"w0¢Æö6ÂÖVÖ&W'6†—&V6÷&B6÷'&V7FÇ’à¢¢ð ¢7–æ5&V6÷&EÆäg&öÕ7V'67&—F–öâ€¢&V6÷&BÀ¢7V'67&—F–öà¢“° ¢&V6÷&Bç7V'67&—F–öå7FGW2Ð¢7V'67&—F–öâç7FGW2ÇÀ¢&V6÷&Bç7V'67&—F–öå7FGW2ÇÀ¢'Væ¶æ÷vâ#° ¢&V6÷&Bæ7W'&VçEW&–öE7F'BÐ¢v—BvWE7V'67&—F–öåW&–öE7F'B€¢7V'67&—F–öà¢“° ¢&V6÷&Bæ7W'&VçEW&–öDVæBÐ¢v—BvWE7V'67&—F–öåW&–öDVæB€¢7V'67&—F–öà¢“° ¢&V6÷&Bæ6æ6VÄEW&–öDVæBÐ¢7V'67&—F–öà¢æ6æ6VÅöE÷W&–öEöVæBÓÓÐ¢G'VS° ¢&V6÷&Bæ6æ6VÄBÐ¢7G&—UF–ÖW7F×Fô—6ò€¢7V'67&—F–öâæ6æ6VÅö@¢“° ¢&V6÷&Bæ6æ6VÆVDBÐ¢7G&—UF–ÖW7F×Fô—6ò€¢7V'67&—F–öâæ6æ6VÆVEö@¢“° ¢&V6÷&BæVæFVDBÐ¢7G&—UF–ÖW7F×Fô—6ò€¢7V'67&—F–öâæVæFVEö@¢“° ¢&V6÷&Bç7V'67&—F–öäVæDFFRÐ¢&V6÷&Bæ6æ6VÄBÇÀ¢&V6÷&Bæ7W'&VçEW&–öDVæBÇÀ¢&V6÷&BæVæFVDBÇÀ¢çVÆÃ° ¢&WGW&â&V6÷&C°§Ð  ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢$ôd”ÄRdÄ”DD”ôà¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦gVæ7F–öâ6æ—F—¦U&öf–ÆR†&öG’’°¢&WGW&â°¢&öf–ÆTæÖS¢6ÆVâ†&öG’ç&öf–ÆTæÖR’À¢f—'7DæÖS¢6ÆVâ†&öG’æf—'7DæÖRÂ’À¢Æ7DæÖS¢6ÆVâ†&öG’æÆ7DæÖRÂ’À¢VÖ–Ã¢6ÆVâ†&öG’æVÖ–ÂÂ#’À¢†öæS¢6ÆVâ†&öG’ç†öæRÂS’À¢FG&W73¢6ÆVâ†&öG’æFG&W72’À¢FG&W73#¢6ÆVâ†&öG’æFG&W73"’À¢6÷VçG'“¢6ÆVâ†&öG’æ6÷VçG'’Â’À¢7FFS¢6ÆVâ†&öG’ç7FFRÂ’À¢6—G“¢6ÆVâ†&öG’æ6—G’Â’À¢¦—¢6ÆVâ†&öG’ç¦—Â3¢Ó°§Ð ¦gVæ7F–öâ6æ—F—¦U6V7&WG2†&öG’’°¢&WGW&â°¢6ôVÖ–Ã¢6ÆVâ†&öG’æ6ôVÖ–ÂÂ#’À¢6õ77v÷&C¢6ÆVâ†&öG’æ6õ77v÷&BÂ3’À¢6&DÆ&VÃ¢6ÆVâ†&öG’æ6&DÆ&VÂÂ’À¢6&F†öÆFW#¢6ÆVâ†&öG’æ6&F†öÆFW"ÂS’À ¢6ô6&DçVÖ&W#¢6ÆVâ€¢&öG’æ6ô6&DçVÖ&W"À¢3 ¢’ç&WÆ6R‚õµåÆEÒörÂ""’À ¢W‡ÖöçFƒ¢6ÆVâ†&öG’æW‡ÖöçF‚Â"’À¢W‡–V#¢6ÆVâ†&öG’æW‡–V"ÂB’À ¢6V7W&—G”6öFS¢6ÆVâ€¢&öG’ç6V7W&—G”6öFRÀ¢3 ¢¢Ó°§Ð ¦gVæ7F–öâfÆ–E&öf–ÆR‡&öf–ÆR’°¢6öç7B&WV—&VBÒ°¢'&öf–ÆTæÖR"À¢&f—'7DæÖR"À¢&Æ7DæÖR"À¢&VÖ–Â"À¢'†öæR"À¢&FG&W72"À¢&6÷VçG'’"À¢'7FFR"À¢&6—G’"À¢'¦— ¢Ó° ¢&WGW&â€¢&WV—&VBæWfW'’†¶W’Óâ&öf–ÆU¶¶W•Ò’b`¢õåµåÇ4Ò´µåÇ4ÒµÂåµåÇ4Ò²BòçFW7B€¢&öf–ÆRæVÖ–À¢¢“°§Ð ¦gVæ7F–öâfÆ–E6V7&WG2‡6V7&WG2’°¢&WGW&â€¢õåµåÇ4Ò´µåÇ4ÒµÂåµåÇ4Ò²BòçFW7B€¢6V7&WG2æ6ôVÖ–À¢’b`¢6V7&WG2æ6õ77v÷&BæÆVæwF‚ãÒbb`¢õåÆG³"Ã—ÒBòçFW7B€¢6V7&WG2æ6ô6&DçVÖ&W ¢’b`¢6V7&WG2æ6&F†öÆFW"b`¢6V7&WG2æ6&DÆ&VÂb`¢6V7&WG2æW‡ÖöçF‚b`¢6V7&WG2æW‡–V"b`¢6V7&WG2ç6V7W&—G”6öFP¢“°§Ð ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢Tä5%•D”ôà¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦gVæ7F–öâVæ7'—F–öä¶W’‚’°¢6öç7B&rÐ¢&ö6W72æVçbå5T$Ô•54”ôåôTä5%•D”ôåô´U’ÇÂ"#° ¢–b‚&r’°¢F‡&÷ræWrW'&÷"€¢%5T$Ô•54”ôåôTä5%•D”ôåô´U’—2æ÷B6öæf–wW&VB ¢“°¢Ð ¢&WGW&â7'—Fð¢æ7&VFT†6‚‚'6†#Sb"¢çWFFR‡&r¢æF–vW7B‚“°§Ð ¦gVæ7F–öâVæ7'—D§6öâ†ö&¦V7B’°¢6öç7B—bÒ7'—Fòç&æFöÔ'—FW2ƒ"“°¢6öç7B¶W’ÒVæ7'—F–öä¶W’‚“° ¢6öç7B6—†W"Ð¢7'—Fòæ7&VFT6—†W&—b€¢&W2Ó#SbÖv6Ò"À¢¶W’À¢—`¢“° ¢6öç7BÆ–çFW‡BÐ¢'VffW"æg&öÒ€¢¥4ôâç7G&–æv–g’†ö&¦V7B’À¢'WFc‚ ¢“° ¢6öç7B6—†W'FW‡BÐ¢'VffW"æ6öæ6B…°¢6—†W"çWFFR‡Æ–çFW‡B’À¢6—†W"æf–æÂ‚¢Ò“° ¢&WGW&â°¢fW'6–öã¢À¢Æs¢$U2Ó#SbÔt4Ò"À¢—c¢—bçFõ7G&–ær‚&&6ScB"’À¢Fs¢6—†W ¢ævWDWF…Fr‚¢çFõ7G&–ær‚&&6ScB"’À¢FF¢6—†W'FW‡BçFõ7G&–ær‚&&6ScB"¢Ó°§Ð ¦gVæ7F–öâFV7'—D§6öâ‡–ÆöB’°¢6öç7B¶W’ÒVæ7'—F–öä¶W’‚“° ¢6öç7B—bÐ¢'VffW"æg&öÒ€¢–ÆöBæ—bÀ¢&&6ScB ¢“° ¢6öç7BFrÐ¢'VffW"æg&öÒ€¢–ÆöBçFrÀ¢&&6ScB ¢“° ¢6öç7BFV6—†W"Ð¢7'—Fòæ7&VFTFV6—†W&—b€¢&W2Ó#SbÖv6Ò"À¢¶W’À¢—`¢“° ¢FV6—†W"ç6WDWF…Fr‡Fr“° ¢&WGW&â¥4ôâç'6R€¢'VffW"æ6öæ6B…°¢FV6—†W"çWFFR€¢'VffW"æg&öÒ€¢–ÆöBæFFÀ¢&&6ScB ¢¢’À¢FV6—†W"æf–æÂ‚¢Ò’çFõ7G&–ær‚'WFc‚"¢“°§Ð ¦7–æ2gVæ7F–öâ6fTVæ7'—FVE6¶vR€¢–BÀ¢ö&¦V7@¢’°¢v—Bg2æÖ¶F—"€¢4T5$UEôD•"À¢²&V7W'6—fS¢G'VRÐ¢“° ¢v—Bw&—FT§6öâ€¢F‚æ¦ö–â€¢4T5$UEôD•"À¢G¶–GÒæVæ7'—FVBæ§6öæ ¢’À¢Væ7'—D§6öâ†ö&¦V7B¢“°§Ð ¦7–æ2gVæ7F–öâÆöDVæ7'—FVE6¶vR€¢–@¢’°¢–b‚–B’°¢&WGW&âçVÆÃ°¢Ð ¢G'’°¢6öç7B–ÆöBÐ¢v—B&VD§6öâ€¢F‚æ¦ö–â€¢4T5$UEôD•"À¢G¶–GÒæVæ7'—FVBæ§6öæ ¢’À¢çVÆÀ¢“° ¢–b‚–ÆöB’°¢&WGW&âçVÆÃ°¢Ð ¢&WGW&âFV7'—D§6öâ€¢–Æö@¢“° ¢Ò6F6‚°¢&WGW&âçVÆÃ°¢Ð§Ð ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢TÔ”ÂäõD”d”4D”ôà¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦7–æ2gVæ7F–öâ6VæDæ÷F–f–6F–öâ‡&V6÷&B’°¢–b€¢&ö6W72æVçbå$U4TäEô•ô´U’ÇÀ¢&ö6W72æVçbä%U4”äU55ôTÔ”À¢’°¢&WGW&âfÇ6S°¢Ð ¢6öç7B&W7öç6RÒv—BfWF6‚€¢&‡GG3¢òö’ç&W6VæBæ6öÒöVÖ–Ç2"À¢°¢ÖWF†öC¢%õ5B"À ¢†VFW'3¢°¢WF†÷&—¦F–öã ¢&V&W"G·&ö6W72æVçbå$U4TäEô•ô´U—ÖÀ ¢$6öçFVçBÕG—R# ¢&Æ–6F–öâö§6öâ ¢ÒÀ ¢&öG“¢¥4ôâç7G&–æv–g’‡°¢g&öÓ ¢&ö6W72æVçbäe$ôÕôTÔ”ÂÇÀ¢%4Ä%4äu$%44òÆöæ&ö&F–æt&W6VæBæFWcâ"À ¢Fó¢°¢&ö6W72æVçbä%U4”äU55ôTÔ”À¢ÒÀ ¢7V&¦V7C ¢6V7W&R–B&öf–ÆR&VG’(	BG·&V6÷&BçÆâææÖWÖÀ ¢FW‡C ¦–B4Ä%4äu$%44ò&öf–ÆR—2&VG’à ¥7V&Ö—76–öâ”C¢G·&V6÷&Bæ–GÐ¤7W7FöÖW#¢G·&V6÷&Bç&öf–ÆRæf—'7DæÖWÒG·&V6÷&Bç&öf–ÆRæÆ7DæÖWÐ¤6öçF7BVÖ–Ã¢G·&V6÷&Bç&öf–ÆRæVÖ–ÇÐ¥Æã¢G·&V6÷&BçÆâææÖWÒ(	BBG·&V6÷&BçÆâæÖ÷VçGÒöÖöçF€ ¥6Vç6—F—fR4ò7&VFVçF–Ç2æB6&FÚ±î¸Â¸­yêë¢°k¢G§¦*^ details are NOT included in this email.

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
                  "ðŸ’° PAYMENT RECEIVED",

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
                    "Private admin payment notification â€¢ No card data included"
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
                    "Admin profile workflow â€¢ No sensitive credentials included"
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
          "ðŸŸ¡ PAID PROFILE ACTIVATING",
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
            ? `ðŸ”´ ${profileType.toUpperCase()} EXPIRED`
            : `ðŸŸ¡ ${profileType.toUpperCase()} ACTIVATING`,

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

 m«ëŒ+Š×ž®º+º$zzb¥â6öç7B7V'67&—F–öä–BÐ¢G—Vöb–çfö–6Sòç7V'67&—F–öâÓÓÐ¢'7G&–ær ¢ò–çfö–6Rç7V'67&—F–öà¢¢€¢–çfö–6Sòç7V'67&—F–öãòæ–BÇÀ¢–çfö–6Sòç&Vç@¢òç7V'67&—F–öåöFWF–Ç0¢òç7V'67&—F–öâÇÀ¢çVÆÀ¢“° ¢6öç7B7W7FöÖW$–BÐ¢G—Vöb–çfö–6Sòæ7W7FöÖW"ÓÓÐ¢'7G&–ær ¢ò–çfö–6Ræ7W7FöÖW ¢¢€¢–çfö–6Sòæ7W7FöÖW#òæ–BÇÀ¢çVÆÀ¢“° ¢–b€¢&–ÆÆ–æu&V6öâÓÓÐ¢'7V'67&—F–öå÷WFFR"b`¢7V'67&—F–öä–Bb`¢FÖ–åWw&FTæ÷F–f–6F–öä–å&öw&W72æ†2€¢7G&–ær€¢7V'67&—F–öä–@¢¢¢’°¢&WGW&âfÇ6S°¢Ð ¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7B–E&V6÷&G2Ð¢'&’æ—4'&’‡–B¢ò–@¢¢µÓ° ¢ÆWB&V6÷&BÐ¢–E&V6÷&G2æf–æB€¢—FVÒÓà¢7V'67&—F–öä–Bb`¢7G&–ær€¢—FVÒç7G&—U7V'67&—F–öä–BÇÀ¢" ¢’ÓÓÐ¢7G&–ær€¢7V'67&—F–öä–@¢¢“° ¢–b€¢&V6÷&Bb`¢7W7FöÖW$–@¢’°¢&V6÷&BÐ¢–E&V6÷&G2æf–æB€¢—FVÒÓà¢7G&–ær€¢—FVÒç7G&—T7W7FöÖW$–BÇÀ¢" ¢’ÓÓÐ¢7G&–ær€¢7W7FöÖW$–@¢¢“°¢Ð ¢ÆWBÆ—fUÆâÐ¢çVÆÃ° ¢–b€¢7V'67&—F–öä–@¢’°¢G'’°¢6öç7B7V'67&—F–öâÐ¢v—B7G&—P¢ç7V'67&—F–öç0¢ç&WG&–WfR€¢7V'67&—F–öä–@¢“° ¢6öç7B&–6T–BÐ¢7V'67&—F–öà¢òæ—FV×0¢òæFF¢òå³Ð¢òç&–6P¢òæ–BÇÀ¢"#° ¢Æ—fUÆâÐ¢ÖVÖ&W'6†—Æäg&öÕ7G&—U&–6T–B€¢&–6T–@¢“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$FÖ–â–ÖVçBæ÷F–f–6F–öâ7V'67&—F–öâÆöö·Wf–ÆVC¢"À¢W'&÷"æÖW76vP¢“°¢Ð¢Ð ¢6öç7BÆâÐ¢Æ—fUÆâÇÀ¢&V6÷&CòçÆâÇÀ¢çVÆÃ° ¢6öç7B—5Ww&FRÐ¢&–ÆÆ–æu&V6öâÓÓÐ¢'7V'67&—F–öå÷WFFR#° ¢–b€¢—5Ww&FRb`¢&V6÷&CòæFÖ–åWw&FTF—66÷&Dæ÷F–f–VDBb`¢çVÖ&W"€¢&V6÷&CòæFÖ–åWw&FTF—66÷&EF–W"ÇÀ¢ ¢’ÓÓÐ¢çVÖ&W"€¢ÆãòçF–W"ÇÀ¢ ¢¢’°¢6öç7Bæ÷F–f–VDBÐ¢æWrFFR€¢&V6÷&BæFÖ–åWw&FTF—66÷&Dæ÷F–f–VD@¢’ævWEF–ÖR‚“° ¢–b€¢çVÖ&W"æ—4f–æ—FR€¢æ÷F–f–VD@¢’b`¢FFRææ÷r‚’Ð¢æ÷F–f–VDBÀ¢c¢c¢ ¢’°¢&WGW&âfÇ6S°¢Ð¢Ð ¢6öç7B–ÖVçEG—RÐ¢—5Ww&FP¢ò$ÖVÖ&W'6†—Ww&FRò&÷&F–öâ ¢¢$ÖVÖ&W'6†—&VæWvÂ#° ¢6öç7BW&6†6U7VÖÖ'’Ð¢Æà¢òG·ÆâææÖRÇÂ$ÖVÖ&W'6†—'Ò(	BG´çVÖ&W"€¢Æâç&öf–ÆW2ÇÀ¢ ¢—Ò&öf–ÆR‡2– ¢¢$ÖVÖ&W'6†—–ÖVçB#° ¢v—B6VæDF—66÷&DFÖ–å–ÖVçDæ÷F–f–6F–öâ‡°¢–ÖVçEG—RÀ ¢†VFÆ–æS ¢—5Ww&FP¢ò$ÖVÖ&W'6†—Ww&FR–ÖVçBv2&V6V—fVBâ ¢¢$&V7W'&–ærÖVÖ&W'6†—–ÖVçBv2&V6V—fVBâ"À ¢Ö÷VçC ¢ÖöæW”g&öÕ7G&—T6VçG2€¢–çfö–6SòæÖ÷VçE÷–@¢’À ¢&öf–ÆS ¢&V6÷&Còç&öf–ÆRÇÀ¢·ÒÀ ¢7W7FöÖW$VÖ–Ã ¢–çfö–6P¢òæ7W7FöÖW%öVÖ–ÂÇÀ¢&V6÷&@¢òç&öf–ÆP¢òæVÖ–ÂÇÀ¢""À ¢W&6†6U7VÖÖ'’À ¢÷&FW$–C ¢&V6÷&Còæ–BÇÀ¢çVÆÂÀ ¢&öf–ÆW3 ¢Æãòç&öf–ÆW2óð¢çVÆÂÀ ¢–DC ¢–çfö–6P¢òç7FGW5÷G&ç6—F–öç0¢òç–Eö@¢òæWrFFR€¢–çfö–6P¢ç7FGW5÷G&ç6—F–öç0¢ç–EöB ¢ ¢’çFô•4õ7G&–ær‚¢¢æWrFFR‚¢çFô•4õ7G&–ær‚¢Ò“° ¢&WGW&âG'VS°§Ð   ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢DÔ”âÔTÔ$U%4„•4ä4TÄÄD”ôâäõD”d”4D”ôå0 ¢W6W2F†R6ÖR&—fFRFÖ–âvV&†öö²2–ÖVçBÆW'G3 ¢D•44õ$EôDÔ”åõ”ÔTåEõtT$„ôôµõU$À ¢Gvò7FvW26â&R&W÷'FVC ¢â6æ6VÆÆF–öâ66†VGVÆVB'’F†RÖVÖ&W"à¢"âÖVÖ&W'6†—7GVÆÇ’VæFVBv†VâF†RW&–öBÆ6W0¢÷"7G&—R&W÷'G2F†R7V'67&—F–öâFVÆWFVBö6æ6VÆVBà ¢7F÷&VBæ÷F–f–6F–öâF–ÖW7F×2&WfVçBGWÆ–6FW2à¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦gVæ7F–öâ7V'67&—F–öäVæD—6ò€¢&V6÷&BÀ¢7V'67&—F–öâÒçVÆÀ¢’°¢6öç7B&rÐ¢7V'67&—F–öãòæ6æ6VÅöBÇÀ¢7V'67&—F–öãòæ7W'&VçE÷W&–öEöVæBÇÀ¢&V6÷&Còæ6æ6VÄBÇÀ¢&V6÷&Còç7V'67&—F–öäVæDFFRÇÀ¢&V6÷&Còæ7W'&VçEW&–öDVæBÇÀ¢çVÆÃ° ¢–b‚&r’°¢&WGW&âçVÆÃ°¢Ð ¢–b€¢G—Vöb&rÓÓÐ¢&çVÖ&W" ¢’°¢&WGW&âæWrFFR€¢&r¢ ¢’çFô•4õ7G&–ær‚“°¢Ð ¢6öç7B'6VBÐ¢æWrFFR‡&r“° ¢&WGW&âçVÖ&W"æ—4æâ€¢'6VBævWEF–ÖR‚¢¢òçVÆÀ¢¢'6VBçFô•4õ7G&–ær‚“°§Ð  ¦gVæ7F–öâFÖ–äÖVÖ&W'6†—W&6†6U7VÖÖ'’€¢&V6÷&@¢’°¢&WGW&âG·&V6÷&CòçÆãòææÖRÇÂ$ÖVÖ&W'6†—'Ò(	BG´çVÖ&W"€¢&V6÷&CòçÆãòç&öf–ÆW2ÇÀ¢ ¢—Ò&öf–ÆR‡2–°§Ð  ¦7–æ2gVæ7F–öâ6VæDF—66÷&DFÖ–äÖVÖ&W'6†—6æ6VÆÆF–öäæ÷F–f–6F–öâ€¢&V6÷&BÀ¢°¢7FvRÒ&VæFVB"À¢&V6öâÒ""À¢VæDBÒçVÆÀ¢ÒÒ·Ð¢’°¢6öç7BvV&†ööµW&ÂÐ¢7G&–ær€¢&ö6W72æVç`¢äD•44õ$EôDÔ”åõ”ÔTåEõtT$„ôôµõU$ÂÇÀ¢" ¢’çG&–Ò‚“° ¢–b‚vV&†ööµW&Â’°¢&WGW&âfÇ6S°¢Ð ¢6öç7B7W7FöÖW"Ð¢FÖ–å–ÖVçD7W7FöÖW$Æ&VÂ€¢&V6÷&Còç&öf–ÆRÇÀ¢·ÒÀ¢&V6÷&Còç&öf–ÆSòæVÖ–ÂÇÀ¢" ¢“° ¢6öç7B66†VGVÆVBÐ¢7FvRÓÓÐ¢'66†VGVÆVB#° ¢6öç7Bf–VÆG2Ò°¢°¢æÖS ¢$7W7FöÖW""À¢fÇVS ¢6ÆVâ€¢7W7FöÖW"ææÖRÀ¢S ¢’À¢–æÆ–æS ¢fÇ6P¢ÒÀ ¢°¢æÖS ¢$7W7FöÖW"VÖ–Â"À¢fÇVS ¢6ÆVâ€¢7W7FöÖW"æVÖ–ÂÀ¢# ¢’À¢–æÆ–æS ¢fÇ6P¢ÒÀ ¢°¢æÖS ¢$ÖVÖ&W'6†—"À¢fÇVS ¢6ÆVâ€¢FÖ–äÖVÖ&W'6†—W&6†6U7VÖÖ'’€¢&V6÷&@¢’À¢S ¢’À¢–æÆ–æS ¢fÇ6P¢ÒÀ ¢°¢æÖS ¢66†VGVÆV@¢ò%66†VGVÆVBVæB ¢¢$VæFVB"À¢fÇVS ¢VæD@¢òæWrFFR€¢VæD@¢’çFôÆö6ÆU7G&–ær€¢&VâÕU2"À¢°¢F–ÖU¦öæS ¢$ÖW&–6ôæWuõ–÷&²"À¢FFU7G–ÆS ¢&ÖVF—VÒ"À¢F–ÖU7G–ÆS ¢'6†÷'B ¢Ð¢¢¢$æ÷Bf–Æ&ÆR"À¢–æÆ–æS ¢G'VP¢ÒÀ ¢°¢æÖS ¢%&V6öâ"À¢fÇVS ¢6ÆVâ€¢&V6öâÇÀ¢€¢66†VGVÆV@¢ò$ÖVÖ&W"66†VGVÆVB6æ6VÆÆF–öâ ¢¢$ÖVÖ&W'6†—W&–öBVæFVBò7V'67&—F–öâ6æ6VÆVB ¢’À¢3 ¢’À¢–æÆ–æS ¢G'VP¢Ð¢Ó° ¢–b€¢&V6÷&Còæ–@¢’°¢f–VÆG2çW6‚‡°¢æÖS ¢$÷&FW"ò7V&Ö—76–öâ"À¢fÇVS ¢6ÆVâ€¢&V6÷&Bæ–BÀ¢S ¢’À¢–æÆ–æS ¢G'VP¢Ò“°¢Ð ¢6öç7B&W7öç6RÐ¢v—BfWF6‚€¢vV&†ööµW&ÂÀ¢°¢ÖWF†öC ¢%õ5B"À ¢†VFW'3¢°¢$6öçFVçBÕG—R# ¢&Æ–6F–öâö§6öâ ¢ÒÀ ¢&öG“ ¢¥4ôâç7G&–æv–g’‡°¢W6W&æÖS ¢%4Ä%2âu$%24òFÖ–â"À ¢ÆÆ÷vVEöÖVçF–öç3¢°¢'6S¢µÐ¢ÒÀ ¢VÖ&VG3¢°¢°¢F—FÆS ¢66†VGVÆV@¢ò.)ªûˆòÔTÔ$U%4„•4ä4TÄÄD”ôâ44„TETÄTB ¢¢.)ØÂÔTÔ$U%4„•TäDTB"À ¢FW67&—F–öã ¢66†VGVÆV@¢ò$ÖVÖ&W"†266†VGVÆVBF†V—"–BÖVÖ&W'6†—Fò6æ6VÂBF†RVæBöbF†R7W'&VçB&–ÆÆ–ærW&–öBâ ¢¢$–BÖVÖ&W'6†—†2VæFVBæB6†÷VÆBæòÆöævW"&RG&VFVB27F—fRâ"À ¢f–VÆG2À ¢F–ÖW7F× ¢æWrFFR‚¢çFô•4õ7G&–ær‚’À ¢fö÷FW#¢°¢FW‡C ¢%&—fFRFÖ–âÖVÖ&W'6†—æ÷F–f–6F–öâ ¢Ð¢Ð¢Ð¢Ò¢Ð¢“° ¢–b‚&W7öç6Ræö²’°¢F‡&÷ræWrW'&÷"€¢FÖ–â6æ6VÆÆF–öâF—66÷&BvV&†öö²&WGW&æVBG·&W7öç6Rç7FGW7Òæ ¢“°¢Ð ¢&WGW&âG'VS°§Ð  ¦7–æ2gVæ7F–öâæ÷F–g•66†VGVÆVDÖVÖ&W'6†—6æ6VÆÆF–öâ€¢&V6÷&BÀ¢7V'67&—F–öà¢’°¢6öç7BVæDBÐ¢7V'67&—F–öäVæD—6ò€¢&V6÷&BÀ¢7V'67&—F–öà¢“° ¢6öç7Bæ÷F–6T¶W’Ð¢VæDBÇÀ¢7G&–ær€¢7V'67&—F–öãòæ–BÇÀ¢&V6÷&Còç7G&—U7V'67&—F–öä–BÇÀ¢'66†VGVÆVB ¢“° ¢–b€¢&V6÷&@¢òæFÖ–ä6æ6VÆÆF–öå66†VGVÆVD¶W’ÓÓÐ¢æ÷F–6T¶W¢’°¢&WGW&âfÇ6S°¢Ð ¢v—B6VæDF—66÷&DFÖ–äÖVÖ&W'6†—6æ6VÆÆF–öäæ÷F–f–6F–öâ€¢&V6÷&BÀ¢°¢7FvS ¢'66†VGVÆVB"À ¢&V6öã ¢$ÖVÖ&W"66†VGVÆVB6æ6VÆÆF–öâBF†RVæBöbF†R&–ÆÆ–ærW&–öBâ"À ¢VæD@¢Ð¢“° ¢&V6÷&@¢æFÖ–ä6æ6VÆÆF–öå66†VGVÆVD¶W’Ð¢æ÷F–6T¶W“° ¢&V6÷&@¢æFÖ–ä6æ6VÆÆF–öå66†VGVÆVDæ÷F–f–VDBÐ¢æWrFFR‚¢çFô•4õ7G&–ær‚“° ¢&WGW&âG'VS°§Ð  ¦7–æ2gVæ7F–öâæ÷F–g”VæFVDÖVÖ&W'6†—€¢&V6÷&BÀ¢°¢7V'67&—F–öâÒçVÆÂÀ¢&V6öâÒ" ¢ÒÒ·Ð¢’°¢6öç7BVæDBÐ¢7V'67&—F–öäVæD—6ò€¢&V6÷&BÀ¢7V'67&—F–öà¢’ÇÀ¢æWrFFR‚¢çFô•4õ7G&–ær‚“° ¢6öç7Bæ÷F–6T¶W’Ð¢Gµ7G&–ær€¢7V'67&—F–öãòæ–BÇÀ¢&V6÷&Còç7G&—U7V'67&—F–öä–BÇÀ¢&V6÷&Còæ–BÇÀ¢" ¢—Ó¢Gµ7G&–ær€¢7V'67&—F–öãòç7FGW2ÇÀ¢&V6÷&Còç7V'67&—F–öå7FGW2ÇÀ¢&VæFVB ¢—Ó¢G¶VæDGÖ° ¢–b€¢&V6÷&@¢òæFÖ–äÖVÖ&W'6†—VæFVD¶W’ÓÓÐ¢æ÷F–6T¶W¢’°¢&WGW&âfÇ6S°¢Ð ¢v—B6VæDF—66÷&DFÖ–äÖVÖ&W'6†—6æ6VÆÆF–öäæ÷F–f–6F–öâ€¢&V6÷&BÀ¢°¢7FvS ¢&VæFVB"À ¢&V6öã ¢&V6öâÇÀ¢$ÖVÖ&W'6†—W&–öBVæFVBò7V'67&—F–öâ6æ6VÆVBâ"À ¢VæD@¢Ð¢“° ¢&V6÷&@¢æFÖ–äÖVÖ&W'6†—VæFVD¶W’Ð¢æ÷F–6T¶W“° ¢&V6÷&@¢æFÖ–äÖVÖ&W'6†—VæFVDæ÷F–f–VDBÐ¢æWrFFR‚¢çFô•4õ7G&–ær‚“° ¢&WGW&âG'VS°§Ð  ¢ò ¢fÆÆ&6²&V6öæ6–Æ–F–öã ¢–b6æ6VÆÆF–öâÖB×W&–öBÖVæB&V6÷&B&V6†W0¢—G27F÷&VBVæBFFR&Vf÷&R7G&—RFVÆWFVBWfVç@¢—2&ö6W76VBÂ6VæBF†R&—fFRFÖ–âÆW'Böæ6Rà¢¢ð¦7–æ2gVæ7F–öâ&V6öæ6–ÆTÆ6VDÖVÖ&W'6†—æ÷F–f–6F–öç2‚’°¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7B&V6÷&G2Ð¢'&’æ—4'&’‡–B¢ò–@¢¢µÓ° ¢ÆWB6†ævVBÐ¢fÇ6S° ¢6öç7Bæ÷rÐ¢FFRææ÷r‚“° ¢f÷"€¢6öç7B&V6÷&Bö`¢&V6÷&G0¢’°¢–b€¢&V6÷&Còæ6æ6VÄEW&–öDVæBÓÐ¢G'VP¢’°¢6öçF–çVS°¢Ð ¢6öç7BVæDBÐ¢7V'67&—F–öäVæD—6ò€¢&V6÷&@¢“° ¢–b‚VæDB’°¢6öçF–çVS°¢Ð ¢6öç7BVæEF–ÖRÐ¢æWrFFR€¢VæD@¢’ævWEF–ÖR‚“° ¢–b€¢çVÖ&W"æ—4f–æ—FR€¢VæEF–ÖP¢’ÇÀ¢VæEF–ÖRà¢æ÷p¢’°¢6öçF–çVS°¢Ð ¢6öç7BÇ&VG”VæFVBÐ¢°¢&6æ6VÆVB"À¢&6æ6VÆÆVB"À¢'Vç–B"À¢&–æ6ö×ÆWFUöW‡—&VB ¢Òæ–æ6ÇVFW2€¢7G&–ær€¢&V6÷&@¢ç7V'67&—F–öå7FGW2ÇÀ¢" ¢’çFôÆ÷vW$66R‚¢“° ¢G'’°¢6öç7B6VçBÐ¢v—Bæ÷F–g”VæFVDÖVÖ&W'6†—€¢&V6÷&BÀ¢°¢&V6öã ¢Ç&VG”VæFV@¢ò%7G&—R&W÷'G2F†RÖVÖ&W'6†—VæFVBâ ¢¢%F†R66†VGVÆVBÖVÖ&W'6†—W&–öBVÆ6VBâ ¢Ð¢“° ¢–b‡6VçB’°¢6†ævVBÐ¢G'VS°¢Ð ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$Æ6VBÖVÖ&W'6†—F—66÷&Bæ÷F–f–6F–öâf–ÆVC¢"À¢W'&÷"æÖW76vP¢“°¢Ð¢Ð ¢–b†6†ævVB’°¢v—Bw&—FT§6öâ€¢”Eôd”ÄRÀ¢&V6÷&G0¢“°¢Ð§Ð  ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢DÔ”â4U54”ôå0¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦6öç7BFÖ–å6W76–öç2ÒæWrÖ‚“°¦6öç7BÆöv–äGFV×G2ÒæWrÖ‚“°¦6öç7B7W7FöÖW$WF„GFV×G2Ð¢æWrÖ‚“°¦6öç7B”'W6TGFV×G2Ð¢æWrÖ‚“°  ¦gVæ7F–öâFÖ–å6W76–öä¶W’€¢Fö¶Và¢’°¢&WGW&â7'—Fð¢æ7&VFT†6‚‚'6†#Sb"¢çWFFR€¢7G&–ær€¢Fö¶VâÇÀ¢" ¢¢¢æF–vW7B‚&†W‚"“°§Ð  ¦gVæ7F–öâFÖ–åW6W$vVçD†6‚€¢&W¢’°¢&WGW&âVF—D†6‚€¢&Wæ†VFW'5°¢'W6W"ÖvVçB ¢ÒÇÀ¢" ¢“°§Ð ¦gVæ7F–öâ7W7FöÖW$WF…&FTÆ–Ö—B€¢&WÀ¢&W2À¢æW‡@¢’°¢6öç7B—Ð¢&Wæ—ÇÂ'Væ¶æ÷vâ#° ¢6öç7Bæ÷rÐ¢FFRææ÷r‚“° ¢6öç7Bv–æF÷t×2Ð¢R¢c¢° ¢6öç7BÖ„GFV×G2Ð¢° ¢ÆWBGFV×BÐ¢7W7FöÖW$WF„GFV×G2ævWB€¢— ¢“° ¢–b€¢GFV×BÇÀ¢æ÷râGFV×Bç&W6W@¢’°¢GFV×BÒ°¢6÷VçC¢À¢&W6WC ¢æ÷r²v–æF÷t×0¢Ó°¢Ð ¢–b€¢GFV×Bæ6÷VçBãÐ¢Ö„GFV×G0¢’°¢6öç7B&WG'”gFW"Ð¢ÖF‚æÖ‚€¢À¢ÖF‚æ6V–Â€¢€¢GFV×Bç&W6WBÐ¢æ÷p¢’ò ¢¢“° ¢&W2ç6WD†VFW"€¢%&WG'’ÔgFW""À¢7G&–ær‡&WG'”gFW"¢“° ¢&WGW&â&W0¢ç7FGW2ƒC#’¢æ§6öâ‡°¢W'&÷# ¢%FöòÖç’&WVW7G2âÆV6RG'’v–âÆFW"â ¢Ò“°¢Ð ¢GFV×Bæ6÷VçB³Ò° ¢7W7FöÖW$WF„GFV×G2ç6WB€¢—À¢GFV×@¢“° ¢æW‡B‚“°§Ð  ¦gVæ7F–öâ”'W6U&FTÆ–Ö—B€¢&WÀ¢&W2À¢æW‡@¢’°¢ò ¢†–v‚6V–Æ–ærf÷"æ÷&ÖÂFÖ–âF6†&ö&G2Â'WB7F–ÆÂ&÷VæG0¢WFöÖFVB67&–ærò''WFRÖf÷&6R&WVW7BfÆööG2g&öÒöæR•à¢¢ð¢6öç7B—Ð¢&Wæ—ÇÀ¢'Væ¶æ÷vâ#° ¢6öç7Bæ÷rÐ¢FFRææ÷r‚“° ¢6öç7Bv–æF÷t×2Ð¢R¢c¢° ¢6öç7B×WFF–ærÐ¢°¢$tUB"À¢$„TB"À¢$õD”ôå2 ¢Òæ–æ6ÇVFW2€¢&WæÖWF†ö@¢“° ¢6öç7BÖ…&WVW7G2Ð¢×WFF–æp¢ò3 ¢¢S° ¢6öç7B¶W’Ð¢G¶—Ó¢G¶×WFF–ærò'w&—FR"¢'&VB'Ö° ¢ÆWB&V6÷&BÐ¢”'W6TGFV×G2ævWB€¢¶W¢“° ¢–b€¢&V6÷&BÇÀ¢æ÷rà¢&V6÷&Bç&W6W@¢’°¢&V6÷&BÒ°¢6÷VçC¢À¢&W6WC ¢æ÷r°¢v–æF÷t×0¢Ó°¢Ð ¢–b€¢&V6÷&Bæ6÷VçBãÐ¢Ö…&WVW7G0¢’°¢6öç7B&WG'”gFW"Ð¢ÖF‚æÖ‚€¢À¢ÖF‚æ6V–Â€¢€¢&V6÷&Bç&W6WBÐ¢æ÷p¢’ð¢ ¢¢“° ¢&W2ç6WD†VFW"€¢%&WG'’ÔgFW""À¢7G&–ær€¢&WG'”gFW ¢¢“° ¢&WGW&â&W0¢ç7FGW2ƒC#’¢æ§6öâ‡°¢W'&÷# ¢%FöòÖç’&WVW7G2âÆV6RG'’v–â6†÷'FÇ’â ¢Ò“°¢Ð ¢&V6÷&Bæ6÷VçB³Ð¢° ¢”'W6TGFV×G2ç6WB€¢¶W’À¢&V6÷&@¢“° ¢æW‡B‚“°§Ð  ¦gVæ7F–öâ'VæU&FTÆ–Ö—DÖ2‚’°¢6öç7Bæ÷rÐ¢FFRææ÷r‚“° ¢f÷"€¢6öç7BÖöb°¢Æöv–äGFV×G2À¢7W7FöÖW$WF„GFV×G2À¢”'W6TGFV×G0¢Ð¢’°¢f÷"€¢6öç7B°¢¶W’À¢&V6÷&@¢ÒöbÖæVçG&–W2‚¢’°¢–b€¢çVÖ&W"€¢&V6÷&Còç&W6WBÇÀ¢ ¢’ÃÐ¢æ÷p¢’°¢ÖæFVÆWFR€¢¶W¢“°¢Ð¢Ð¢Ð ¢f÷"€¢6öç7B°¢¶W’À¢6W76–öà¢ÒöbFÖ–å6W76–öç2æVçG&–W2‚¢’°¢–b€¢çVÖ&W"€¢6W76–öãòæ'6öÇWFTW‡—&W2ÇÀ¢ ¢’ÃÐ¢æ÷p¢’°¢FÖ–å6W76–öç2æFVÆWFR€¢¶W¢“°¢Ð¢Ð§Ð  ¦6öç7B&FTÆ–Ö—E'VæUF–ÖW"Ð¢6WD–çFW'fÂ€¢'VæU&FTÆ–Ö—DÖ2À¢¢c¢ ¢“° ¦–b€¢G—Vöb&FTÆ–Ö—E'VæUF–ÖW ¢çVç&VbÓÓÐ¢&gVæ7F–öâ ¢’°¢&FTÆ–Ö—E'VæUF–ÖW ¢çVç&Vb‚“°§Ð  ¦gVæ7F–öâ&WVW7DW‡V7FVD÷&–v–ç2€¢&W¢’°¢6öç7B÷&–v–ç2Ð¢æWr6WB‚“° ¢G'’°¢÷&–v–ç2æFB€¢æWrU$Â€¢$4UõU$À¢’æ÷&–v–à¢“°¢Ò6F6‚°¢òò–væ÷&RÖÆf÷&ÖVB$4UõU$Â†W&S²7F'GWfÆ–FF–öâ†æFÆW2—Bà¢Ð ¢6öç7B†÷7BÐ¢7G&–ær€¢&Wæ†VFW'2æ†÷7BÇÀ¢" ¢’çG&–Ò‚“° ¢–b††÷7B’°¢6öç7B&÷Fö6öÂÐ¢&WVW7D—4‡GG2€¢&W¢¢ò&‡GG2 ¢¢&‡GG#° ¢÷&–v–ç2æFB€¢G·&÷Fö6öÇÓ¢òòG¶†÷7GÖ ¢“°¢Ð ¢&WGW&â÷&–v–ç3°§Ð  ¦gVæ7F–öâ&WV—&U6ÖT÷&–v–ä×WFF–öâ€¢&WÀ¢&W2À¢æW‡@¢’°¢–b€¢°¢$tUB"À¢$„TB"À¢$õD”ôå2 ¢Òæ–æ6ÇVFW2€¢&WæÖWF†ö@¢¢’°¢&WGW&âæW‡B‚“°¢Ð ¢6öç7BW‡V7FVD÷&–v–ç2Ð¢&WVW7DW‡V7FVD÷&–v–ç2€¢&W¢“° ¢6öç7B÷&–v–âÐ¢7G&–ær€¢&Wæ†VFW'2æ÷&–v–âÇÀ¢" ¢’çG&–Ò‚“° ¢6öç7B&VfW&W"Ð¢7G&–ær€¢&Wæ†VFW'2ç&VfW&W"ÇÀ¢" ¢’çG&–Ò‚“° ¢6öç7BfWF6…6—FRÐ¢7G&–ær€¢&Wæ†VFW'5°¢'6V2ÖfWF6‚×6—FR ¢ÒÇÀ¢" ¢¢çG&–Ò‚¢çFôÆ÷vW$66R‚“° ¢ò ¢'&÷w6W"F†BW‡Æ–6—FÇ’6—2F†—2&WVW7B—27&÷72×6—FP¢—2æWfW"ÆÆ÷vVBFò×WFFRÆ–6F–öâ7FFRà¢¢ð¢–b€¢fWF6…6—FRb`¢°¢'6ÖRÖ÷&–v–â"À¢&æöæR ¢Òæ–æ6ÇVFW2€¢fWF6…6—FP¢¢’°¢&WGW&â&W0¢ç7FGW2ƒC2¢æ§6öâ‡°¢W'&÷# ¢$7&÷72×6—FR&WVW7B&Æö6¶VBâ ¢Ò“°¢Ð ¢–b€¢÷&–v–âb`¢W‡V7FVD÷&–v–ç2æ†2€¢÷&–v–à¢¢’°¢&WGW&â&W0¢ç7FGW2ƒC2¢æ§6öâ‡°¢W'&÷# ¢%&WVW7B÷&–v–â—2æ÷BÆÆ÷vVBâ ¢Ò“°¢Ð ¢–b€¢÷&–v–âb`¢&VfW&W ¢’°¢ÆWB&VfW&W$÷&–v–âÐ¢"#° ¢G'’°¢&VfW&W$÷&–v–âÐ¢æWrU$Â€¢&VfW&W ¢’æ÷&–v–ã°¢Ò6F6‚°¢&VfW&W$m«ëŒ+Š×ž®º+º$zzb¥ïrigin =
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
        ? `â€¢â€¢â€¢â€¢ â€¢â€¢â€¢â€¢ â€¢â€¢â€¢â€¢ ${last4}`
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
      package rather tham«ëŒ+Š×ž®º+º$zzb¥æâF†R7W7FöÖW"fVÇBâ–æ6ÇVFR—B6òF†RFÖ–à¢¤”rö6&B&÷FF–öâG'VÇ’6VW2WfW'’6&BF†R7W7FöÖW"&÷f–FVBà¢¢ð¢6öç7B6†V6¶÷WE6V7&WG2Ð¢v—BÆöDVæ7'—FVE6¶vR€¢&V6÷&Bæ–@¢“° ¢FE–ÖVçB€¢6†V6¶÷WE6V7&WG2ÇÀ¢·ÒÀ¢6†V6¶÷WB6&BG¶–æFW‚²ÖÀ¢–BÖ÷&FW"Ö6&C¢G·&V6÷&Bæ–BÇÂ–æFW‚²ÖÀ¢'–Eö÷&FW" ¢“°¢Ð ¢6öç7B&WF–ÆW%&öf–ÆW2Ð¢v—BvWE&WF–ÆW%&öf–ÆW2‚“° ¢6öç7B–E&öf–ÆW2Ð¢&WF–ÆW%&öf–ÆW0¢æf–ÇFW"€¢&V6÷&BÓà¢7G&–ær€¢&V6÷&Bæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢’ÓÓÐ¢7G&–ær€¢66÷VçBæ–@¢¢¢ç6÷'B€¢€¢À¢ ¢’Óà¢çVÖ&W"€¢ç6Æ÷BÇÀ¢ ¢’Ð¢çVÖ&W"€¢"ç6Æ÷BÇÀ¢ ¢¢“° ¢f÷"€¢6öç7B&V6÷&Bö`¢–E&öf–ÆW0¢’°¢6öç7BÆ&VÂÐ¢&V6÷&Bç&öf–ÆTæÖRÇÀ¢–B&öf–ÆRG·&V6÷&Bç6Æ÷BÇÂ"'Ö° ¢FDFG&W72€¢&V6÷&Bæ7W7FöÖW%&öf–ÆRÇÀ¢·ÒÀ¢G¶Æ&VÇÒ6†—–ævÀ¢–B×&öf–ÆRÖFG&W73¢G·&V6÷&Bæ–GÖÀ¢'–E÷&öf–ÆR ¢“° ¢ÆWB6V7&WG2Ò·Ó° ¢G'’°¢–b€¢&V6÷&Bæ7W7FöÖW%6V7&WG0¢’°¢6V7&WG2Ð¢FV7'—D§6öâ€¢&V6÷&Bæ7W7FöÖW%6V7&WG0¢’ÇÂ·Ó°¢Ð¢Ò6F6‚°¢6V7&WG2Ò·Ó°¢Ð ¢FE–ÖVçB€¢6V7&WG2À¢G¶Æ&VÇÒ6&FÀ¢–B×&öf–ÆRÖ6&C¢G·&V6÷&Bæ–GÖÀ¢'–E÷&öf–ÆR ¢“°¢Ð ¢&WGW&â°¢FG&W76W2À ¢–ÖVçDÖWF†öG3 ¢–ÖVçG2æÖ€¢€¢—FVÒÀ¢–æFW€¢’Óà¢FÖ–à¢òFÖ–å6fVE–ÖVçDÖWF†öB€¢—FVÒÀ¢–æFW€¢¢¢V&Æ–56fVE–ÖVçDÖWF†öB€¢—FVÒÀ¢–æFW€¢¢¢Ó°§Ð  ¦7–æ2gVæ7F–öâ7W7FöÖW%6fVDFWF–Ç5–ÆöB€¢66÷Vç@¢’°¢&WGW&âÆÄ7W7FöÖW%6fVDFWF–Ç2€¢66÷VçBÀ¢°¢FÖ–ã¢fÇ6P¢Ð¢“°§Ð  ¦7–æ2gVæ7F–öâFÖ–ä7W7FöÖW%6fVDFWF–Ç5–ÆöB€¢66÷Vç@¢’°¢&WGW&âÆÄ7W7FöÖW%6fVDFWF–Ç2€¢66÷VçBÀ¢°¢FÖ–ã¢G'VP¢Ð¢“°§Ð    ¦gVæ7F–öâæ÷&ÖÆ—¦U&öf–ÆT7F—fF–öå7FGW2€¢fÇVRÀ¢&VG’ÒfÇ6P¢’°¢6öç7B7FGW2Ð¢7G&–ær€¢fÇVRÇÀ¢" ¢¢çG&–Ò‚¢çFôÆ÷vW$66R‚“° ¢–b€¢°¢&–æ6ö×ÆWFR"À¢&v—F–æuö7F—fF–öâ"À¢&7F—fFVB"À¢&FV7F—fFVB"À¢&W‡—&VB ¢Òæ–æ6ÇVFW2‡7FGW2¢’°¢&WGW&â7FGW3°¢Ð ¢&WGW&â&VG¢ò&v—F–æuö7F—fF–öâ ¢¢&–æ6ö×ÆWFR#°§Ð  ¦gVæ7F–öâ&öf–ÆT7F—fF–öäÆ&VÂ€¢7FGW0¢’°¢6öç7BfÇVRÐ¢æ÷&ÖÆ—¦U&öf–ÆT7F—fF–öå7FGW2€¢7FGW0¢“° ¢–b€¢fÇVRÓÓÐ¢&7F—fFVB ¢’°¢&WGW&â$7F—fFVB#°¢Ð ¢–b€¢fÇVRÓÓÐ¢&FV7F—fFVB ¢’°¢&WGW&â$FV7F—fFVB#°¢Ð ¢–b€¢fÇVRÓÓÐ¢&W‡—&VB ¢’°¢&WGW&â$W‡—&VB#°¢Ð ¢–b€¢fÇVRÓÓÐ¢&v—F–æuö7F—fF–öâ ¢’°¢&WGW&â$v—F–ær7F—fF–öâ#°¢Ð ¢&WGW&â$–æ6ö×ÆWFR#°§Ð   ¦gVæ7F–öâW†7DÖævVDFG&W74¶W’€¢&öf–ÆRÒ·Ð¢’°¢6öç7B&WV—&VBÒ°¢&FG&W72"À¢&6—G’"À¢'7FFR"À¢'¦—"À¢&6÷VçG'’ ¢Ó° ¢–b€¢&WV—&VBæWfW'’€¢¶W’Óà¢7G&–ær€¢&öf–ÆSòå¶¶W•ÒÇÀ¢" ¢’çG&–Ò‚¢¢’°¢&WGW&â"#°¢Ð ¢&WGW&â¥4ôâç7G&–æv–g’‡°¢FG&W73 ¢7G&–ær€¢&öf–ÆRæFG&W72ÇÀ¢" ¢’çG&–Ò‚’À ¢FG&W73# ¢7G&–ær€¢&öf–ÆRæFG&W73"ÇÀ¢" ¢’çG&–Ò‚’À ¢6—G“ ¢7G&–ær€¢&öf–ÆRæ6—G’ÇÀ¢" ¢’çG&–Ò‚’À ¢7FFS ¢7G&–ær€¢&öf–ÆRç7FFRÇÀ¢" ¢’çG&–Ò‚’À ¢¦— ¢7G&–ær€¢&öf–ÆRç¦—ÇÀ¢" ¢’çG&–Ò‚’À ¢6÷VçG'“ ¢7G&–ær€¢&öf–ÆRæ6÷VçG'’ÇÀ¢" ¢’çG&–Ò‚¢Ò“°§Ð  ¦gVæ7F–öâÖævVD76–væÖVçDÖVÖ&W'6†—–B€¢76–væÖVçBÒ·Ð¢’°¢&WGW&â7G&–ær€¢76–væÖVçBæÖævVD66÷VçD–BÇÀ¢76–væÖVçBæg&VTÖVÖ&W'6†—–BÇÀ¢76–væÖVçBç&VçFVDÖVÖ&W'6†—–BÇÀ¢76–væÖVçBæÖVÖ&W'6†—–BÇÀ¢" ¢“°§Ð  ¦gVæ7F–öâÖævVD66÷VçD6æöæ–6ÄVÖ–Â€¢ÖVÖ&W'6†—À¢7WÆ–VD7&VFVçF–Ç2ÒçVÆÀ¢’°¢–b‚ÖVÖ&W'6†—’°¢&WGW&â"#°¢Ð ¢ÆWB7&VFVçF–Ç2Ð¢7WÆ–VD7&VFVçF–Ç3° ¢–b‚7&VFVçF–Ç2’°¢G'’°¢7&VFVçF–Ç2Ð¢ÖVÖ&W'6†—æ7&VFVçF–Ç0¢òæ÷&ÖÆ—¦U&WF–ÆW$7&VFVçF–Ç2€¢FV7'—D§6öâ€¢ÖVÖ&W'6†—æ7&VFVçF–Ç0¢¢¢¢V×G•&WF–ÆW$7&VFVçF–Ç2‚“°¢Ò6F6‚°¢7&VFVçF–Ç2Ð¢V×G•&WF–ÆW$7&VFVçF–Ç2‚“°¢Ð¢Ð ¢&WGW&â7G&–ær€¢ÖVÖ&W'6†—æ66÷VçDVÖ–ÂÇÀ¢ÖVÖ&W'6†—æF—7Æ”VÖ–ÂÇÀ¢7&VFVçF–Ç3òçF&vWCòçW6W&æÖRÇÀ¢7&VFVçF–Ç3òçvÆÖ'CòçW6W&æÖRÇÀ¢7&VFVçF–Ç3òç¶3òçW6W&æÖRÇÀ¢7&VFVçF–Ç3òç6×46ÇV#òçW6W&æÖRÇÀ¢7&VFVçF–Ç3òæ6÷7F6óòçW6W&æÖRÇÀ¢" ¢’çG&–Ò‚“°§Ð  ¦gVæ7F–öâW†7DÖævVDFG&W74ÖF6†W2€¢&öf–ÆRÀ¢7W'&VçDÖVÖ&W'6†—–BÀ¢ÖVÖ&W'6†—2À¢g&VT76–væÖVçG2À¢&VçFÄ76–væÖVçG0¢’°¢6öç7B¶W’Ð¢W†7DÖævVDFG&W74¶W’€¢&öf–ÆP¢“° ¢–b‚¶W’’°¢&WGW&âµÓ°¢Ð ¢6öç7BÖF6†W2ÒµÓ° ¢6öç7B–ç7V7BÐ¢€¢76–væÖVçBÀ¢G—RÀ¢7F—fTfà¢’Óâ°¢–b€¢76–væÖVçBÇÀ¢ÖævVD76–væÖVçD—4Æ–æ¶VB€¢76–væÖVç@¢’ÇÀ¢W†7DÖævVDFG&W74¶W’€¢76–væÖVçBæ7W7FöÖW%&öf–ÆRÇÀ¢·Ð¢’ÓÐ¢¶W¢’°¢&WGW&ã°¢Ð ¢6öç7BÖVÖ&W'6†—–BÐ¢ÖævVD76–væÖVçDÖVÖ&W'6†—–B€¢76–væÖVç@¢“° ¢–b€¢ÖVÖ&W'6†—–BÇÀ¢7G&–ær€¢ÖVÖ&W'6†—–@¢’ÓÓÐ¢7G&–ær€¢7W'&VçDÖVÖ&W'6†—–BÇÀ¢" ¢¢’°¢&WGW&ã°¢Ð ¢6öç7BÖVÖ&W'6†—Ð¢ÖVÖ&W'6†—2æf–æB€¢—FVÒÓà¢7G&–ær†—FVÒæ–B’ÓÓÐ¢7G&–ær†ÖVÖ&W'6†—–B¢“° ¢ÖF6†W2çW6‚‡°¢–C ¢ÖVÖ&W'6†—–BÀ ¢G—RÀ ¢&öf–ÆTæÖS ¢ÖVÖ&W'6†—òç&öf–ÆTæÖRÇÀ¢€¢G—RÓÓÒ&g&VR ¢ò$v–gFVB&öf–ÆR ¢¢%&VçFVB&öf–ÆR ¢’À ¢66÷VçDVÖ–Ã ¢ÖVÖ&W'6†—òæ66÷VçDVÖ–ÂÇÀ¢" ¢Ò“°¢Ó° ¢f÷"€¢6öç7B76–væÖVçBö`¢g&VT76–væÖVçG2ÇÂµÐ¢’°¢–ç7V7B€¢76–væÖVçBÀ¢&g&VR"À¢g&VT76–væÖVçD—47F—fP¢“°¢Ð ¢f÷"€¢6öç7B76–væÖVçBö`¢&VçFÄ76–væÖVçG2ÇÂµÐ¢’°¢–ç7V7B€¢76–væÖVçBÀ¢'&VçFVB"À¢&VçFÄ76–væÖVçD—47F—fP¢“°¢Ð ¢&WGW&âÖF6†W3°§Ð  ¦gVæ7F–öâÖævVE&öf–ÆU&VF–æW72€¢&öf–ÆRÀ¢6V7&WG0¢’°¢6öç7B6†—–æu&WV—&VBÒ°¢&f—'7DæÖR"À¢&Æ7DæÖR"À¢&FG&W72"À¢&6—G’"À¢'7FFR"À¢'¦—"À¢&6÷VçG'’ ¢Ó° ¢6öç7B6†—–æu&VG’Ð¢6†—–æu&WV—&VBæWfW'’€¢¶W’Óà¢&ööÆVâ€¢7G&–ær€¢&öf–ÆSòå¶¶W•ÒÇÀ¢" ¢’çG&–Ò‚¢¢“° ¢6öç7BF–v—G2Ð¢7G&–ær€¢6V7&WG3òæ6ô6&DçVÖ&W"ÇÀ¢" ¢’ç&WÆ6R€¢õÄBörÀ¢" ¢“° ¢6öç7B6&E&VG’Ð¢&ööÆVâ€¢7G&–ær€¢6V7&WG3òæ6&F†öÆFW"ÇÀ¢" ¢’çG&–Ò‚¢’b`¢õåÆG³"Ã—ÒBòçFW7B€¢F–v—G0¢’b`¢Ú±î¸Â¸­yêë¢°k¢G§¦*^   /^(0[1-9]|1[0-2])$/.test(
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
        ? `â€¢â€¢â€¢â€¢ â€¢â€¢â€¢â€¢ â€¢â€¢â€¢â€¢ ${digits.slice(-4)}`
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
        ? `â€¢â€¢â€¢â€¢ â€¢â€¢â€¢â€¢ â€¢â€¢â€¢â€¢ ${digits.slice(-4)}`
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
                    String(paidRecord.id).startsWith("gift:")
                      ? null
                      : await loadEncryptedPackage(paidRecord.id);

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
                        `${quantity} ${retailerLabel} rental account(s) â€” ${durationLabel}`,

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

       m«ëŒ+Š×ž®º+º$zzb¥â7W7FöÖW$Æ–æ¶VDC ¢VçG'’æ7W7FöÖW$66÷VçD–@¢òæWrFFR‚’çFô•4õ7G&–ær‚¢¢çVÆÂÀ ¢7&VFVDC ¢VçG'’æ7&VFVDBÀ ¢–DC ¢æWrFFR‚¢çFô•4õ7G&–ær‚’À ¢ötÖVÖ&W# ¢fÇ6RÀ ¢7G&—U6W76–öä–C ¢6W76–öâæ–BÀ ¢7G&—T7W7FöÖW$–C ¢6W76–öâæ7W7FöÖW"ÇÂçVÆÂÀ ¢7G&—U7V'67&—F–öä–C ¢6W76–öâç7V'67&—F–öâÇÂçVÆÂÀ ¢7V'67&—F–öå7FGW3 ¢&7F—fR"À ¢7W'&VçEW&–öDVæC ¢çVÆÀ¢Ó° ¢ò ¢W&ÖæVçFÇ’Ö&²VÆ–g––ærÆVæ6€¢ÖVÖ&W'2âVÆ–f–6F–öâ—2&6VBöà¢F†R7W7FöÖW"w2f—'7B–BÖVÖ&W'6†—à¢¢ð ¢–b€¢&V6÷&Bæ7W7FöÖW$66÷VçD–@¢’°¢6öç7BW†—7F–æu–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7B7W7FöÖW%–E&V6÷&G2Ð¢€¢'&’æ—4'&’€¢W†—7F–æu–@¢¢òW†—7F–æu–@¢¢µÐ¢¢æf–ÇFW"€¢—FVÒÓà¢7G&–ær€¢—FVÒæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢’ÓÓÐ¢7G&–ær€¢&V6÷&Bæ7W7FöÖW$66÷VçD–@¢¢“° ¢&V6÷&BæötÖVÖ&W"Ð¢7W7FöÖW$†4ötÖVÖ&W%7FGW2€¢°¢ââæ7W7FöÖW%–E&V6÷&G2À¢&V6÷&@¢Ð¢“°¢ÒVÇ6R°¢&V6÷&BæötÖVÖ&W"Ð¢FFTfÆÇ4–äötÖVÖ&W%v–æF÷r€¢&V6÷&Bç–D@¢“°¢Ð  ¢ò ¢&WG&–WfRF†R7V'67&—F–öâ6òF†P¢7GVÂ7G&—R&–ÆÆ–ærW&–öB6à¢&R7F÷&VBà¢¢ð ¢–b€¢&V6÷&Bç7G&—U7V'67&—F–öä–@¢’°¢G'’°¢6öç7B7V'67&—F–öâÐ¢v—B7G&—P¢ç7V'67&—F–öç0¢ç&WG&–WfR€¢&V6÷&@¢ç7G&—U7V'67&—F–öä–@¢“° ¢v—BÇ•7V'67&—F–öä–æfò€¢&V6÷&BÀ¢7V'67&—F–öà¢“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢%7V'67&—F–öâÆöö·Wf–ÆVC¢"À¢W'&÷"æÖW76vP¢“°¢Ð¢Ð ¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢ò ¢fö–BGWÆ–6FR&V6÷&G2–b7G&—P¢&WG&–W2F†RvV&†öö²à¢¢ð ¢6öç7BW†—7F–æt–æFW‚Ð¢–Bæf–æD–æFW‚€¢—FVÒÓà¢—FVÒæ–BÓÓÒ–@¢“° ¢–b€¢W†—7F–æt–æFW‚ãÒ ¢’°¢–E¶W†—7F–æt–æFW…ÒÐ¢&V6÷&C°¢ÒVÇ6R°¢–BçW6‚‡&V6÷&B“°¢Ð ¢v—Bw&—FT§6öâ€¢”Eôd”ÄRÀ¢–@¢“° ¢FVÆWFRVæF–æu¶–EÓ° ¢v—Bw&—FT§6öâ€¢TäD”äuôd”ÄRÀ¢VæF–æp¢“° ¢G'’°¢v—B6VæDæ÷F–f–6F–öâ€¢&V6÷&@¢“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$æ÷F–f–6F–öâf–ÆVC¢"À¢W'&÷"æÖW76vP¢“°¢Ð ¢G'’°¢6öç7B–E–ÖVçDÖW76vT–BÐ¢v—B6VæDF—66÷&DFÖ–å–ÖVçDæ÷F–f–6F–öâ‡°¢–ÖVçEG—S ¢$æWr–BÖVÖ&W'6†—"À ¢†VFÆ–æS ¢$æWr–BÖVÖ&W'6†—v2W&6†6VBâ"À ¢Ö÷VçC ¢ÖöæW”g&öÕ7G&—T6VçG2€¢6W76–öâæÖ÷VçE÷F÷FÀ¢’ÇÀ¢çVÖ&W"€¢&V6÷&@¢òçÆà¢òæÖ÷VçBÇÀ¢ ¢’À ¢&öf–ÆS ¢&V6÷&Bç&öf–ÆRÇÀ¢·ÒÀ ¢7W7FöÖW$VÖ–Ã ¢6W76–öà¢òæ7W7FöÖW%öFWF–Ç0¢òæVÖ–ÂÇÀ¢&V6÷&@¢òç&öf–ÆP¢òæVÖ–ÂÇÀ¢""À ¢W&6†6U7VÖÖ'“ ¢G·&V6÷&BçÆãòææÖRÇÂ$ÖVÖ&W'6†—'Ò(	BG´çVÖ&W"€¢&V6÷&BçÆãòç&öf–ÆW2ÇÀ¢ ¢—Ò&öf–ÆR‡2’òÖöçF†À ¢÷&FW$–C ¢&V6÷&Bæ–BÀ ¢&öf–ÆW3 ¢&V6÷&BçÆà¢òç&öf–ÆW2óð¢çVÆÂÀ ¢–DC ¢&V6÷&Bç–D@¢Ò“° ¢–b€¢–E–ÖVçDÖW76vT–Bb`¢–E–ÖVçDÖW76vT–BÓÒG'VP¢’°¢&V6÷&BæFÖ–å–ÖVçDF—66÷&DÖW76vT–BÐ¢–E–ÖVçDÖW76vT–C° ¢6öç7BÆFW7E–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7BÆFW7D–æFW‚Ð¢'&’æ—4'&’€¢ÆFW7E–@¢¢òÆFW7E–Bæf–æD–æFW‚€¢—FVÒÓà¢7G&–ær€¢—FVÒæ–@¢’ÓÓÐ¢7G&–ær€¢&V6÷&Bæ–@¢¢¢¢Ó° ¢–b€¢ÆFW7D–æFW‚ãÒ ¢’°¢ÆFW7E–E°¢ÆFW7D–æFW€¢ÒÒ&V6÷&C° ¢v—Bw&—FT§6öâ€¢”Eôd”ÄRÀ¢ÆFW7E–@¢“°¢Ð¢Ð ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$FÖ–âÖVÖ&W'6†—–ÖVçBF—66÷&Bæ÷F–f–6F–öâf–ÆVC¢"À¢W'&÷"æÖW76vP¢“°¢Ð¢Ð¢Ð¢Ð ¢ò ¢5T%45$•D”ôâ”ådô”4R”@¢6÷fW'2&V7W'&–ær&VæWvÇ2æB–ÖÖVF–FP¢Ww&FR÷&÷&F–öâ–çfö–6W2à¢¢ð ¢–b€¢WfVçBçG—RÓÓÐ¢&–çfö–6Rç–ÖVçE÷7V66VVFVB ¢’°¢G'’°¢v—B6VæDFÖ–å7V'67&—F–öä–çfö–6Tæ÷F–f–6F–öâ€¢WfVçBæFFæö&¦V7@¢“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$FÖ–â&V7W'&–ær–ÖVçBF—66÷&Bæ÷F–f–6F–öâf–ÆVC¢"À¢W'&÷"æÖW76vP¢“°¢Ð¢Ð ¢ò¢5T%45$•D”ôâUDDTBò4ä4TÄTB¢ð ¢–b€¢WfVçBçG—RÓÓÐ¢&7W7FöÖW"ç7V'67&—F–öâçWFFVB"ÇÀ¢WfVçBçG—RÓÓÐ¢&7W7FöÖW"ç7V'67&—F–öâæFVÆWFVB ¢’°¢6öç7B7V'67&—F–öâÐ¢WfVçBæFFæö&¦V7C° ¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢ÆWB6†ævVBÐ¢fÇ6S° ¢f÷"€¢6öç7B&V6÷&Bö`¢–@¢’°¢–b€¢7G&–ær€¢&V6÷&@¢ç7G&—U7V'67&—F–öä–BÇÀ¢" ¢’ÓÐ¢7G&–ær€¢7V'67&—F–öâæ–@¢¢’°¢6öçF–çVS°¢Ð ¢6öç7B&Wf–÷W57FGW2Ð¢7G&–ær€¢&V6÷&@¢ç7V'67&—F–öå7FGW2ÇÀ¢" ¢’çFôÆ÷vW$66R‚“° ¢6öç7B&Wf–÷W46æ6VÄEW&–öDVæBÐ¢&V6÷&@¢æ6æ6VÄEW&–öDVæBÓÓÐ¢G'VS° ¢v—BÇ•7V'67&—F–öä–æfò€¢&V6÷&BÀ¢7V'67&—F–öà¢“° ¢&V6÷&Bç7V'67&—F–öåWFFVDBÐ¢æWrFFR‚¢çFô•4õ7G&–ær‚“° ¢6öç7B7W'&VçE7FGW2Ð¢7G&–ær€¢&V6÷&@¢ç7V'67&—F–öå7FGW2ÇÀ¢7V'67&—F–öãòç7FGW2ÇÀ¢" ¢’çFôÆ÷vW$66R‚“° ¢6öç7B7W'&VçD6æ6VÄEW&–öDVæBÐ¢&V6÷&@¢æ6æ6VÄEW&–öDVæBÓÓÐ¢G'VRÇÀ¢7V'67&—F–öà¢òæ6æ6VÅöE÷W&–öEöVæBÓÓÐ¢G'VS° ¢ò ¢æ÷F–g’–ÖÖVF–FVÇ’v†VâF†RÖVÖ&W"f—'7@¢66†VGVÆW26æ6VÆÆF–öâf÷"W&–öBVæBà¢¢ð¢–b€¢7W'&VçD6æ6VÄEW&–öDVæBb`¢&Wf–÷W46æ6VÄEW&–öDVæ@¢’°¢G'’°¢v—Bæ÷F–g•66†VGVÆVDÖVÖ&W'6†—6æ6VÆÆF–öâ€¢&V6÷&BÀ¢7V'67&—F–öà¢“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢%66†VGVÆVB6æ6VÆÆF–öâF—66÷&Bæ÷F–f–6F–öâf–ÆVC¢"À¢W'&÷"æÖW76vP¢“°¢Ð¢Ð ¢ò ¢æ÷F–g’v†Vâ7G&—R&W÷'G2F†R7V'67&—F–öà¢7GVÆÇ’VæFVBâ7W7FöÖW"ç7V'67&—F–öâæFVÆWFV@¢6÷fW'2F†Ræ÷&ÖÂVæBÖöb×W&–öBÆ6RFöòà¢¢ð¢6öç7BVæFVDæ÷rÐ¢WfVçBçG—RÓÓÐ¢&7W7FöÖW"ç7V'67&—F–öâæFVÆWFVB"ÇÀ¢€¢°¢&6æ6VÆVB"À¢&6æ6VÆÆVB"À¢'Vç–B"À¢&–æ6ö×ÆWFUöW‡—&VB ¢Òæ–æ6ÇVFW2€¢7W'&VçE7FGW0¢’b`¢°¢&6æ6VÆVB"À¢&6æ6VÆÆVB"À¢'Vç–B"À¢&–æ6ö×ÆWFUöW‡—&VB ¢Òæ–æ6ÇVFW2€¢&Wf–÷W57FGW0¢¢“° ¢–b†VæFVDæ÷r’°¢G'’°¢v—Bæ÷F–g”VæFVDÖVÖ&W'6†—€¢&V6÷&BÀ¢°¢7V'67&—F–öâÀ ¢&V6öã ¢WfVçBçG—RÓÓÐ¢&7W7FöÖW"ç7V'67&—F–öâæFVÆWFVB ¢ò€¢7W'&VçD6æ6VÄEW&–öDVæBÇÀ¢&Wf–÷W46æ6VÄEW&–öDVæ@¢ò%66†VGVÆVB6æ6VÆÆF–öâ&V6†VBF†RVæBöbF†R&–ÆÆ–ærW&–öBâ ¢¢%7V'67&—F–öâv26æ6VÆVBâ ¢¢¢7V'67&—F–öâ7FGW26†ævVBFòG¶7W'&VçE7FGW2ÇÂ&VæFVB'Òæ ¢Ð¢“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$ÖVÖ&W'6†—VæFVBF—66÷&Bæ÷F–f–6F–öâf–ÆVC¢"À¢W'&÷"æÖW76vP¢“°¢Ð¢Ð ¢6†ævVBÐ¢G'VS°¢Ð ¢–b†6†ævVB’°¢v—Bw&—FT§6öâ€¢”Eôd”ÄRÀ¢–@¢“°¢Ð¢Ð ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢%vV&†öö²&ö6W76–ærW'&÷#¢"À¢W'&÷ ¢“° ¢ò ¢&WGW&âS6ò7G&—R6â&WG'¢&ö6W76–ærF†—2WfVçBà¢¢ð ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%vV&†öö²&ö6W76–ærf–ÆVB ¢Ò“°¢Ð ¢&W2æ§6öâ‡°¢&V6V—fVC¢G'VP¢Ò“°¢Ð¢“° ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢äõ$ÔÂ¥4ôâÔ”DDÄUt$P¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦çW6R€¢W‡&W72æ§6öâ‡°¢Æ–Ö—C¢#S¶""À¢7G&–7C¢G'VP¢Ò¢“° ¢ò ¢F†R7G&—RvV&†öö²&÷WFR—2–çFVçF–öæÆÇ’FV6Æ&VB&Vf÷&RF†—0¢6V7F–öâ6ò—G26–væVB&r&öG’'—76W2¥4ôâô55$bÖ–FFÆWv&Rà¢¢ð¦çW6R€¢"ö’"À¢”'W6U&FTÆ–Ö—@¢“° ¦çW6R€¢"ö’"À¢&WV—&U6ÖT÷&–v–ä×WFF–öà¢“° ¦çW6R€¢"ö’"À¢&WV—&T§6öäf÷$×WFF–öà¢“° ¦çW6R€¢"ö’"À¢&V¦V7EVç6fT§6öä¶W—0¢“°  ¢ò ¢6V7W&—G’VF—BVçG&–W2æWfW"–æ6ÇVFR&WVW7B&öF–W2÷"7&VFVçF–Ç2à¢F†RWF†VçF–6FVB7V&¦V7B—2FWFV7FVBgFW"&÷WFRÖ–FFÆWv&R'Vç2à¢¢ð¦çW6R€¢"ö’öFÖ–â"À¢‡&WÂ&W2ÂæW‡B’Óâ°¢–b€¢°¢$tUB"À¢$„TB"À¢$õD”ôå2 ¢Òæ–æ6ÇVFW2€¢&WæÖWF†ö@¢¢’°¢&W2æöâ€¢&f–æ—6‚"À¢‚’Óâ°¢–b€¢&WæFÖ–å6W76–öâb`¢&WçF‚ÓÐ¢"öÆöv–â"b`¢&WçF‚ÓÐ¢"öÆöv÷WB ¢’°¢VæE6V7W&—G”VF—B‡°¢WfVçC ¢&FÖ–åö×WFF–öâ"À ¢&WVW7D–C ¢&Wç6V7W&—G•&WVW7D–BÀ ¢ÖWF†öC ¢&WæÖWF†öBÀ ¢Fƒ ¢&WçF‚À ¢7FGW3 ¢&W2ç7FGW46öFRÀ ¢— ¢&Wæ—À ¢W6W$vVçC ¢&Wæ†VFW'5°¢'W6W"ÖvVçB ¢Ð¢Ò“°¢Ð¢Ð¢“°¢Ð ¢æW‡B‚“°¢Ð¢“°  ¦çW6R€¢"ö’ö66÷VçB"À¢‡&WÂ&W2ÂæW‡B’Óâ°¢–b€¢°¢$tUB"À¢$„TB"À¢$õD”ôå2 ¢Òæ–æ6ÇVFW2€¢&WæÖWF†ö@¢¢’°¢&W2æöâ€¢&f–æ—6‚"À¢‚’Óâ°¢–b€¢&Wæ7W7FöÖW$66÷Vç@¢’°¢VæE6V7W&—G”VF—B‡°¢WfVçC ¢&7W7FöÖW%ö×WFF–öâ"À ¢&WVW7D–C ¢&Wç6V7W&—G•&WVW7D–BÀ ¢ÖWF†öC ¢&WæÖWF†öBÀ ¢Fƒ ¢&WçF‚À ¢7FGW3 ¢&W2ç7FGW46öFRÀ ¢— ¢&Wæ—À ¢W6W$vVçC ¢&Wæ†VFW'5°¢'W6W"ÖvVçB ¢ÒÀ ¢7V&¦V7C ¢&Wæ7W7FöÖW$66÷Vç@¢æ–@¢Ò“°¢Ð¢Ð¢“°¢Ð ¢æW‡B‚“°¢Ð¢“°  ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢DÔ”âtP¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦ævWB€¢"öFÖ–â"À¢‡&WÂ&W2’Óâ°¢&W2ç6WB€¢$66†RÔ6öçG&öÂ"À¢&æò×7F÷&RÂ&—fFRÂÖ‚ÖvSÓ ¢“° ¢&W2ç6WB€¢%‚Õ&ö&÷G2ÕFr"À¢&æö–æFW‚ÂæöföÆÆ÷rÂæö&6†—fR ¢“° ¢&W2ç6VæDf–ÆR€¢F‚æ¦ö–â€¢õöF—&æÖRÀ¢'V&Æ–2"À¢&FÖ–âæ‡FÖÂ ¢¢“°¢Ð¢“°  ¦ævWB€¢"öFÖ–âæ‡FÖÂ"À¢‡&WÂ&W2’Óâ°¢&WGW&â&W2ç&VF—&V7B€¢3"À¢"öFÖ–â ¢“°¢Ð¢“°  ¦çW6R€¢W‡&W72ç7FF–2€¢F‚æ¦ö–â€¢õöF—&æÖRÀ¢'V&Æ–2 ¢’À¢°¢F÷Ff–ÆW3 ¢&FVç’"À ¢fÆÇF‡&÷Vvƒ ¢G'VRÀ ¢–æFWƒ ¢&–æFW‚æ‡FÖÂ"À ¢6WD†VFW'3 ¢€¢&W2À¢f–ÆUF€¢’Óâ°¢–b€¢f–ÆUF‚æVæG5v—F‚€¢"æ‡FÖÂ ¢¢’°¢&W2ç6WD†VFW"€¢$66†RÔ6öçG&öÂ"À¢&æòÖ66†R ¢“°¢Ð¢Ð¢Ð¢¢“° ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢5U5DôÔU"44õTåB$õUDU0¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦6öç7BF—66÷&DôWF…7FFW2ÒæWrÖ‚“°¦6öç7BF—66÷&EVæF–æt–FVçF—F–W2ÒæWrÖ‚“°¦6öç7BF—66÷&E&VF—&V7EW&’ÒG´$4UõU$Âç&WÆ6R‚õÂòBòÂ""—Òö’öF—66÷&BööWF‚ö6ÆÆ&6¶°¦ÆWBF—66÷&DôWF„6Æ–VçD–C° ¦ævWB‚"ö’öF—66÷&BööWF‚÷7F'B"Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢–b‚&ö6W72æVçbäD•44õ$Eô$õEõDô´TâÇÂ&ö6W72æVçbäD•44õ$Eô4Ä”TåEõ4T5$UB’°¢&WGW&â&W2ç7FGW2ƒS2’ç6VæB‚$F—66÷&BWF†÷&—¦F–öâ—2æ÷B6öæf–wW&VB–WBâ"“°¢Ð¢6öç7B6öçFW‡BÒ&WçVW'’æ6öçFW‡BÓÓÒ&66÷VçB"ò&66÷VçB"¢'6–vçW#°¢6öç7B66÷VçBÒ6öçFW‡BÓÓÒ&66÷VçB"òv—BvWDWF†VçF–6FVD7W7FöÖW"‡&W’¢çVÆÃ°¢–b†6öçFW‡BÓÓÒ&66÷VçB"bb66÷VçB’&WGW&â&W2ç7FGW2ƒC’ç6VæB‚%6–vâ–â&Vf÷&R6öææV7F–ærF—66÷&Bâ"“°¢–b‚F—66÷&DôWF„6Æ–VçD–B’°¢6öç7B&W7öç6RÒv—BfWF6‚‚&‡GG3¢òöF—66÷&Bæ6öÒö’÷c÷W6W'2ôÖR"Â°¢†VFW'3¢²WF†÷&—¦F–öã¢&÷BG·&ö6W72æVçbäD•44õ$Eô$õEõDô´TçÖÒÂ6–væÃ¢&÷'E6–væÂçF–ÖV÷WBƒ¢Ò“°¢–b‚&W7öç6Ræö²’F‡&÷ræWrW'&÷"†F—66÷&B&÷B–FVçF—G’…EEG·&W7öç6Rç7FGW7Ö“°¢F—66÷&DôWF„6Æ–VçD–BÒ†v—B&W7öç6Ræ§6öâ‚’’æ–C°¢Ð¢6öç7B7FFRÒ7'—Fòç&æFöÔ'—FW2ƒ#B’çFõ7G&–ær‚&†W‚"“°¢F—66÷&DôWF…7FFW2ç6WB‡7FFRÂ²6öçFW‡BÂ66÷VçD–C¢66÷VçCòæ–BÂW‡—&W4C¢FFRææ÷r‚’²cÒ“°¢6öç7BW&ÂÒæWrU$Â‚&‡GG3¢òöF—66÷&Bæ6öÒööWFƒ"öWF†÷&—¦R"“°¢W&Âç6V&6‚ÒæWrU$Å6V&6…&×2‡²6Æ–VçEö–C¢F—66÷&DôWF„6Æ–VçD–BÂ&W7öç6U÷G—S¢&6öFR"Â&VF—&V7E÷W&“¢F—66÷&E&VF—&V7EW&’Â66÷S¢&–FVçF–g’"Â7FFRÒ’çFõ7G&–ær‚“°¢&W2ç&VF—&V7B‡W&ÂçFõ7G&–ær‚’“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚$F—66÷&BWF†÷&—¦F–öâ7F'C¢"ÂW'&÷"æÖW76vR“°¢&W2ç7FGW2ƒS"’ç6VæB‚%Væ&ÆRFò7F'BF—66÷&BWF†÷&—¦F–öââ"“°¢Ð§Ò“° ¦ævWB‚"ö’öF—66÷&BööWF‚ö6ÆÆ&6²"Â7–æ2‡&WÂ&W2’Óâ°¢6öç7B7FFRÒ7G&–ær‡&WçVW'’ç7FFRÇÂ""“°¢6öç7BVæF–ærÒF—66÷&DôWF…7FFW2ævWB‡7FFR“°¢F—66÷&DôWF…7FFW2æFVÆWFR‡7FFR“°¢ÆWB–ÆöBÒ²G—S¢'6Æ'6æw&'66òÖF—66÷&B"ÂW'&÷#¢$F—66÷&BWF†÷&—¦F–öâv26æ6VÆVB÷"W‡—&VBâ"Ó°¢G'’°¢–b‚VæF–ærÇÂVæF–æræW‡—&W4BÂFFRææ÷r‚’ÇÂG—Vöb&WçVW'’æ6öFRÓÒ'7G&–ær"’F‡&÷ræWrW'&÷"‚$ôWF‚7FFR–çfÆ–B÷"W‡—&VB"“°¢6öç7BFö¶Vå&W7öç6RÒv—BfWF6‚‚&‡GG3¢òöF—66÷&Bæ6öÒö’÷cööWFƒ"÷Fö¶Vâ"Â°¢ÖWF†öC¢%õ5B"Â†VFW'3¢²$6öçFVçBÕG—R#¢&Æ–6F–öâ÷‚×wwrÖf÷&Ò×W&ÆVæ6öFVB"ÒÀ¢&öG“¢æWrU$Å6V&6…&×2‡²6Æ–VçEö–C¢F—66÷&DôWF„6Æ–VçD–BÂ6Æ–VçE÷6V7&WC¢&ö6W72æVçbäD•44õ$Eô4Ä”TåEõ4T5$UBÇÂ""Âw&çE÷G—S¢&WF†÷&—¦F–öåö6öFR"Â6öFS¢&WçVW'’æ6öFRÂ&VF—&V7E÷W&“¢F—66÷&E&VF—&V7EW&’Ò’À¢6–væÃ¢&÷'E6–væÂçF–ÖV÷WBƒ¢Ò“°¢–b‚Fö¶Vå&W7öç6Ræö²’F‡&÷ræWrW'&÷"†F—66÷&BôWF‚Fö¶Vâ…EEG·Fö¶Vå&W7öç6Rç7FGW7Ö“°¢6öç7B66W75Fö¶VâÒ†v—BFö¶Vå&W7öç6Ræ§6öâ‚’’æ66W75÷Fö¶Vã°¢6öç7B–FVçF—G•&W7öç6RÒv—BfWF6‚‚&‡GG3¢òöF—66÷&Bæ6öÒö’÷c÷W6W'2ôÖR"Â°¢†VFW'3¢²WF†÷&—¦F–öã¢&VÚ±î¸Â¸­yêë¢°k¢G§¦*^arer ${accessToken}` }, signal: AbortSignal.timeout(10000)
    });
    if (!identityResponse.ok) throw new Error(`Discord identity HTTP ${identityResponse.status}`);
    const identity = await identityResponse.json();
    if (!/^\d{17,22}$/.test(identity.id) || !identity.username) throw new Error("Invalid Discord identity");
    const accounts = await getCustomerAccounts();
    if (accounts.some(item => String(item.discordUserId || "") === identity.id && item.id !== pending.accountId)) {
      payload.error = "This Discord account is already linked to another website account.";
    } else if (pending.context === "account") {
      const signedIn = await getAuthenticatedCustomer(req);
      if (!signedIn || signedIn.id !== pending.accountId) throw new Error("Customer session changed");
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
  const origin = new URL(BASE_URL).origin;
  const safePayload = JSON.stringify(payload).replace(/</g, "\\u003c");
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Discord connection</title><p>You can close this window and return to SLABSNGRABSACO.</p><script>if(window.opener){window.opener.postMessage(${safePayload},${JSON.stringify(origin)});window.close()}</script>`);
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

      const now =
        new Date().toISOString();

      const account = {
        id:
          crypto.randomUUID(),

        email,

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

      account.discordUsername =
        clean(
          req.body?.discordUsername,
          100
        );

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
    if (!process.env.DISCORD_BOT_TOKEN) return res.status(503).json({ error: "Discord linking is not configured yet." });
    const code = await createDiscordLinkCode(DATA_DIR, req.customerAccount.id);
    res.json({ code, expiresInSeconds: 600 });
  } catch (error) {
    console.error("Discord link code error:", error);
    res.status(500).json({ error: "Unable to create a Discord link code." });
  }
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
        notifications
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
     &Ú±î¸Â¸­yêë¢°k¢G§¦*^%Væ&ÆRFòÆöBæ÷F–f–6F–öç2â ¢Ò“°¢Ð¢Ð¢“°  ¦æFVÆWFR€¢"ö’ö66÷VçBöæ÷F–f–6F–öç2"À¢&WV—&T7W7FöÖW"À¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B66÷VçG2Ð¢v—BvWD7W7FöÖW$66÷VçG2‚“° ¢6öç7B66÷VçBÐ¢66÷VçG2æf–æB€¢—FVÒÓà¢7G&–ær†—FVÒæ–B’ÓÓÐ¢7G&–ær€¢&Wæ7W7FöÖW$66÷VçBæ–@¢¢“° ¢–b‚66÷VçB’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢$7W7FöÖW"66÷VçB6÷VÆBæ÷B&Rf÷VæBâ ¢Ò“°¢Ð ¢6öç7Bæ÷F–f–6F–öç2Ð¢7W7FöÖW$æ÷F–f–6F–öç2€¢66÷Vç@¢“° ¢f÷"€¢6öç7Bæ÷F–f–6F–öâö`¢æ÷F–f–6F–öç0¢’°¢–b€¢æ÷F–f–6F–öâæF—66÷&DÖW76vT–@¢’°¢v—BFVÆWFT7F–öäæVVFVDF—66÷&DÖW76vR€¢æ÷F–f–6F–öâæF—66÷&DÖW76vT–@¢“°¢Ð¢Ð ¢66÷VçBææ÷F–f–6F–öç2ÒµÓ°¢66÷VçBçWFFVDBÐ¢æWrFFR‚¢çFô•4õ7G&–ær‚“° ¢v—B6fT7W7FöÖW$66÷VçG2€¢66÷VçG0¢“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VP¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$7W7FöÖW"æ÷F–f–6F–öç26ÆV"W'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFò6ÆV"æ÷F–f–6F–öç2â ¢Ò“°¢Ð¢Ð¢“°  ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢5U5DôÔU"TÔ”ÂdU$”d”4D”ôà¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦ç÷7B€¢"ö’ö66÷VçB÷&W6VæB×fW&–f–6F–öâ"À¢7W7FöÖW$WF…&FTÆ–Ö—BÀ¢&WV—&T7W7FöÖW"À¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢–b€¢&Wæ7W7FöÖW$66÷Vç@¢æVÖ–ÅfW&–f–VD@¢’°¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢Ç&VG•fW&–f–VC¢G'VRÀ¢ÖW76vS ¢%–÷W"VÖ–ÂFG&W72—2Ç&VG’fW&–f–VBâ ¢Ò“°¢Ð ¢v—B7&VFTVÖ–ÅfW&–f–6F–öâ€¢&Wæ7W7FöÖW$66÷Vç@¢“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢ÖW76vS ¢$æWrfW&–f–6F–öâVÖ–Â†2&VVâ6VçBâ ¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢%&W6VæBfW&–f–6F–öâW'&÷#¢"À¢W'&÷"æÖW76vP¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFò6VæBF†RfW&–f–6F–öâVÖ–Ââ ¢Ò“°¢Ð¢Ð¢“° ¦ç÷7B€¢"ö’ö66÷VçB÷fW&–g’ÖVÖ–Â"À¢&WV—&T7W7FöÖW"À¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B&uFö¶VâÐ¢7G&–ær€¢&Wæ&öG’çFö¶VâÇÂ" ¢’çG&–Ò‚“° ¢–b‚&uFö¶Vâ’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢%fW&–f–6F–öâÆ–æ²—2–çfÆ–Bâ ¢Ò“°¢Ð ¢6öç7BFö¶Vä†6‚Ð¢†6…6V7W&UFö¶Vâ€¢&uFö¶Và¢“° ¢6öç7B&V6÷&G2Ð¢v—B&VD§6öâ€¢TÔ”ÅõdU$”e•ôd”ÄRÀ¢µÐ¢“° ¢6öç7Bæ÷rÐ¢FFRææ÷r‚“° ¢6öç7BfW&–f–6F–öâÐ¢€¢'&’æ—4'&’‡&V6÷&G2¢ò&V6÷&G0¢¢µÐ¢’æf–æB€¢—FVÒÓà¢—FVÒæ66÷VçD–BÓÓÐ¢&Wæ7W7FöÖW$66÷VçBæ–Bb`¢çVÖ&W"€¢—FVÒæW‡—&W4@¢’âæ÷rb`¢6fTWVÂ€¢—FVÒçFö¶Vä†6‚ÇÂ""À¢Fö¶Vä†6€¢¢“° ¢–b‚fW&–f–6F–öâ’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢%F†—2fW&–f–6F–öâÆ–æ²—2–çfÆ–B÷"†2W‡—&VBâ ¢Ò“°¢Ð ¢6öç7B66÷VçG2Ð¢v—BvWD7W7FöÖW$66÷VçG2‚“° ¢6öç7B66÷VçBÐ¢66÷VçG2æf–æB€¢—FVÒÓà¢—FVÒæ–BÓÓÐ¢&Wæ7W7FöÖW$66÷VçBæ–@¢“° ¢–b‚66÷VçB’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢$7W7FöÖW"66÷VçB6÷VÆBæ÷B&Rf÷VæBâ ¢Ò“°¢Ð ¢6öç7BfW&–f–VDBÐ¢æWrFFR‚¢çFô•4õ7G&–ær‚“° ¢66÷VçBæVÖ–ÅfW&–f–VDBÐ¢fW&–f–VDC° ¢66÷VçBçWFFVDBÐ¢fW&–f–VDC° ¢v—B6fT7W7FöÖW$66÷VçG2€¢66÷VçG0¢“° ¦6öç7BWFôÆ–æµ&W7VÇBÐ¢v—BWFôÆ–æµfW&–f–VD7W7FöÖW$÷&FW'2€¢66÷Vç@¢“° ¦6öç7B&VÖ–æ–ærÐ¢€¢'&’æ—4'&’‡&V6÷&G2¢ò&V6÷&G0¢¢µÐ¢’æf–ÇFW"€¢—FVÒÓà¢—FVÒæ66÷VçD–BÓÐ¢66÷VçBæ–Bb`¢çVÖ&W"€¢—FVÒæW‡—&W4@¢’âæ÷p¢“° ¢v—Bw&—FT§6öâ€¢TÔ”ÅõdU$”e•ôd”ÄRÀ¢&VÖ–æ–æp¢“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ ¢ÖW76vS ¢WFôÆ–æµ&W7VÇBæÆ–æ¶VBâ ¢ò–÷W"VÖ–ÂFG&W72†2&VVâfW&–f–VBæBG¶WFôÆ–æµ&W7VÇBæÆ–æ¶VGÒW†—7F–ær÷&FW"G¶WFôÆ–æµ&W7VÇBæÆ–æ¶VBÓÓÒò""¢'2'ÒG¶WFôÆ–æµ&W7VÇBæÆ–æ¶VBÓÓÒò&†2"¢&†fR'Ò&VVâ6öææV7FVBFò–÷W"66÷VçBæ ¢¢%–÷W"VÖ–ÂFG&W72†2&VVâfW&–f–VBâ"À ¢Æ–æ¶VD÷&FW'3 ¢WFôÆ–æµ&W7VÇBæÆ–æ¶VBÀ ¢66÷VçC ¢V&Æ–47W7FöÖW$66÷VçB€¢66÷Vç@¢§Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$VÖ–ÂfW&–f–6F–öâW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFòfW&–g’–÷W"VÖ–ÂFG&W72â ¢Ò“°¢Ð¢Ð¢“° ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢5U5DôÔU"55tõ$B$U4U@¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦ç÷7B€¢"ö’ö66÷VçB÷&WVW7B×77v÷&B×&W6WB"À¢7W7FöÖW$WF…&FTÆ–Ö—BÀ¢7–æ2‡&WÂ&W2’Óâ°¢6öç7BvVæW&–5&W7öç6RÒ°¢ö³¢G'VRÀ¢ÖW76vS ¢$–bâ66÷VçBW†—7G2f÷"F†BVÖ–ÂFG&W72Â77v÷&B&W6WBÆ–æ²v–ÆÂ&R6VçBâ ¢Ó° ¢G'’°¢6öç7BVÖ–ÂÐ¢æ÷&ÖÆ—¦TVÖ–Â€¢&Wæ&öG’æVÖ–À¢“° ¢–b€¢õåµåÇ4Ò´µåÇ4ÒµÂåµåÇ4Ò²BòçFW7B€¢VÖ–À¢¢’°¢&WGW&â&W2æ§6öâ€¢vVæW&–5&W7öç6P¢“°¢Ð ¢6öç7B66÷VçG2Ð¢v—BvWD7W7FöÖW$66÷VçG2‚“° ¢6öç7B66÷VçBÐ¢66÷VçG2æf–æB€¢—FVÒÓà¢æ÷&ÖÆ—¦TVÖ–Â€¢—FVÒæVÖ–À¢’ÓÓÒVÖ–Âb`¢—FVÒæF—6&ÆVBÓÒG'VP¢“° ¢–b‚66÷VçB’°¢&WGW&â&W2æ§6öâ€¢vVæW&–5&W7öç6P¢“°¢Ð ¢6öç7B&uFö¶VâÐ¢7&VFU6V7W&UFö¶Vâ‚“° ¢6öç7B&V6÷&G2Ð¢v—B&VD§6öâ€¢55tõ$Eõ$U4UEôd”ÄRÀ¢µÐ¢“° ¢6öç7Bæ÷rÐ¢FFRææ÷r‚“° ¢6öç7B7F—fU&V6÷&G2Ð¢€¢'&’æ—4'&’‡&V6÷&G2¢ò&V6÷&G0¢¢µÐ¢’æf–ÇFW"€¢—FVÒÓà¢çVÖ&W"€¢—FVÒæW‡—&W4@¢’âæ÷rb`¢—FVÒæ66÷VçD–BÓÐ¢66÷VçBæ–@¢“° ¢7F—fU&V6÷&G2çW6‚‡°¢–C ¢7'—Fòç&æFöÕUT”B‚’À ¢66÷VçD–C ¢66÷VçBæ–BÀ ¢Fö¶Vä†6ƒ ¢†6…6V7W&UFö¶Vâ€¢&uFö¶Và¢’À ¢7&VFVDC ¢æWrFFR†æ÷r¢çFô•4õ7G&–ær‚’À ¢W‡—&W4C ¢æ÷r°¢R¢c¢ ¢Ò“° ¢v—Bw&—FT§6öâ€¢55tõ$Eõ$U4UEôd”ÄRÀ¢7F—fU&V6÷&G0¢“° ¢G'’°¢v—B6VæE77v÷&E&W6WDVÖ–Â€¢66÷VçBæVÖ–ÂÀ¢&uFö¶Và¢“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢%77v÷&B&W6WBVÖ–Â6VæBf–ÆVC¢"À¢W'&÷"æÖW76vP¢“°¢Ð ¢&WGW&â&W2æ§6öâ€¢vVæW&–5&W7öç6P¢“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢%77v÷&B&W6WB&WVW7BW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W2æ§6öâ€¢vVæW&–5&W7öç6P¢“°¢Ð¢Ð¢“° ¦ç÷7B€¢"ö’ö66÷VçB÷&W6WB×77v÷&B"À¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B&uFö¶VâÐ¢7G&–ær€¢&Wæ&öG’çFö¶VâÇÂ" ¢’çG&–Ò‚“° ¢6öç7BæWu77v÷&BÐ¢7G&–ær€¢&Wæ&öG’ç77v÷&BÇÂ" ¢“° ¢–b‚&uFö¶Vâ’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢%F†—277v÷&B&W6WBÆ–æ²—2–çfÆ–B÷"†2W‡—&VBâ ¢Ò“°¢Ð ¢–b€¢æWu77v÷&BæÆVæwF‚Â"ÇÀ¢æWu77v÷&BæÆVæwF‚â# ¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢%77v÷&B×W7B&RBÆV7B"6†&7FW'2â ¢Ò“°¢Ð ¢6öç7BFö¶Vä†6‚Ð¢†6…6V7W&UFö¶Vâ€¢&uFö¶Và¢“° ¢6öç7B&V6÷&G2Ð¢v—B&VD§6öâ€¢55tõ$Eõ$U4UEôd”ÄRÀ¢µÐ¢“° ¢6öç7Bæ÷rÐ¢FFRææ÷r‚“° ¢6öç7B&W6WE&V6÷&BÐ¢€¢'&’æ—4'&’‡&V6÷&G2¢ò&V6÷&G0¢¢µÐ¢’æf–æB€¢—FVÒÓà¢çVÖ&W"€¢—FVÒæW‡—&W4@¢’âæ÷rb`¢6fTWVÂ€¢—FVÒçFö¶Vä†6‚ÇÂ""À¢Fö¶Vä†6€¢¢“° ¢–b‚&W6WE&V6÷&B’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢%F†—277v÷&B&W6WBÆ–æ²—2–çfÆ–B÷"†2W‡—&VBâ ¢Ò“°¢Ð ¢6öç7B66÷VçG2Ð¢v—BvWD7W7FöÖW$66÷VçG2‚“° ¢6öç7B66÷VçBÐ¢66÷VçG2æf–æB€¢—FVÒÓà¢—FVÒæ–BÓÓÐ¢&W6WE&V6÷&Bæ66÷VçD–Bb`¢—FVÒæF—6&ÆVBÓÒG'VP¢“° ¢–b‚66÷VçB’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢%F†—277v÷&B&W6WBÆ–æ²—2–çfÆ–B÷"†2W‡—&VBâ ¢Ò“°¢Ð ¢6öç7B77v÷&DFFÐ¢v—B†6„7W7FöÖW%77v÷&B€¢æWu77v÷&@¢“° ¢6öç7BWFFVDBÐ¢æWrFFR‚¢çFô•4õ7G&–ær‚“° ¢66÷VçBç77v÷&E6ÇBÐ¢77v÷&DFFç6ÇC° ¢66÷VçBç77v÷&D†6‚Ð¢77v÷&DFFæ†6ƒ° ¢ò ¢&Wfö¶RWfW'’&Wf–÷W6Ç’—77VVB7W7FöÖW"6W76–öâgFW"¢77v÷&B&W6WBâ7FöÆVâöÆB6öö¶–R6âæòÆöævW"&R&WW6VBà¢¢ð¢66÷VçBç6W76–öåfW'6–öâÐ¢7W7FöÖW%6W76–öåfW'6–öâ€¢66÷Vç@¢’²° ¢66÷VçBçWFFVDBÐ¢WFFVDC° ¢v—B6fT7W7FöÖW$66÷VçG2€¢66÷VçG0¢“° ¢6öç7B&VÖ–æ–ærÐ¢€¢'&’æ—4'&’‡&V6÷&G2¢ò&V6÷&G0¢¢µÐ¢’æf–ÇFW"€¢—FVÒÓà¢—FVÒæ66÷VçD–BÓÐ¢66÷VçBæ–Bb`¢çVÖ&W"€¢—FVÒæW‡—&W4@¢’âæ÷p¢“° ¢v—Bw&—FT§6öâ€¢55tõ$Eõ$U4UEôd”ÄRÀ¢&VÖ–æ–æp¢“° ¢6WD7W7FöÖW%6W76–öâ€¢&W2À¢66÷Vç@¢“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢ÖW76vS ¢%–÷W"77v÷&B†2&VVâ&W6WB7V66W76gVÆÇ’â ¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢%77v÷&B&W6WBW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFò&W6WB–÷W"77v÷&Bâ ¢Ò“°¢Ð¢Ð¢“° ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢U„•5D”ärõ$DU"4Ä”Ð¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦gVæ7F–öâæ÷&ÖÆ—¦U†öæR‡fÇVR’°¢&WGW&â7G&–ær‡fÇVRÇÂ""¢ç&WÆ6R‚õÄBörÂ""¢ç6Æ–6R‚Ó“°§Ð ¦gVæ7F–öâ7W7FöÖW$÷&FW$çVÖ&W"€¢&V6÷&@¢’°¢&WGW&â7G&–ær€¢&V6÷&Còæ÷&FW$çVÖ&W"ÇÀ¢&V6÷&Còæ–BÇÀ¢" ¢’çG&–Ò‚“°§Ð ¦7–æ2gVæ7F–öâ6VæD÷&FW$6Æ–ÔVÖ–Â€¢VÖ–ÂÀ¢Fö¶VâÀ¢÷&FW$çVÖ&W ¢’°¢–b€¢&ö6W72æVçbå$U4TäEô•ô´U¢’°¢F‡&÷ræWrW'&÷"€¢$VÖ–Â6W'f–6R—2æ÷B6öæf–wW&VBâ ¢“°¢Ð ¢6öç7BfW&–g•W&ÂÐ¢G´$4UõU$ÇÒóö6Æ–ÓÒG¶Væ6öFUU$”6ö×öæVçB€¢Fö¶Và¢—Ò6×’×&öf–ÆV° ¢6öç7B&W7öç6RÐ¢v—BfWF6‚€¢&‡GG3¢òö’ç&W6VæBæ6öÒöVÖ–Ç2"À¢°¢ÖWF†öC¢%õ5B"À ¢†VFW'3¢°¢WF†÷&—¦F–öã ¢&V&W"G·&ö6W72æVçbå$U4TäEô•ô´U—ÖÀ ¢$6öçFVçBÕG—R# ¢&Æ–6F–öâö§6öâ ¢ÒÀ ¢&öG“¢¥4ôâç7G&–æv–g’‡°¢g&öÓ ¢&ö6W72æVçbäe$ôÕôTÔ”ÂÇÀ¢%4Ä%4äu$%44òÆöæ&ö&F–æt&W6VæBæFWcâ"À ¢Fó¢¶VÖ–ÅÒÀ ¢7V&¦V7C ¢%fW&–g’–÷W"4Ä%2âu$%24ò÷&FW""À ¢FW‡C ¦&WVW7Bv2ÖFRFò6öææV7BâW†—7F–ær4Ä%2âu$%24ò÷&FW"Fò7W7FöÖW"66÷VçBà ¤÷&FW#¢G¶÷&FW$çVÖ&W'Ð ¥FòfW&–g’÷væW'6†—æB6öææV7BF†R÷&FW"Â÷VâF†—26V7W&RÆ–æ³  ¢G·fW&–g•W&ÇÐ ¥F†—2Æ–æ²W‡—&W2–âRÖ–çWFW2à ¤–b–÷RF–Bæ÷B&WVW7BF†—2Â–÷R6â–væ÷&RF†—2VÖ–Âæ ¢Ò¢Ð¢“° ¢–b‚&W7öç6Ræö²’°¢F‡&÷ræWrW'&÷"€¢%fW&–f–6F–öâVÖ–Â6÷VÆBæ÷B&R6VçBâ ¢“°¢Ð§Ð ¦ç÷7B€¢"ö’ö66÷VçBö6Æ–ÒÖ÷&FW""À¢7W7FöÖW$WF…&FTÆ–Ö—BÀ¢&WV—&T7W7FöÖW"À¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B÷&FW$çVÖ&W"Ð¢6ÆVâ€¢&Wæ&öG’æ÷&FW$çVÖ&W"À¢S ¢“° ¢6öç7B7WÆ–VDVÖ–ÂÐ¢æ÷&ÖÆ—¦TVÖ–Â€¢&Wæ&öG’æVÖ–À¢“° ¢6öç7B7WÆ–VE†öæRÐ¢æ÷&ÖÆ—¦U†öæR€¢&Wæ&öG’ç†öæP¢“° ¢–b€¢÷&FW$çVÖ&W"ÇÀ¢€¢7WÆ–VDVÖ–Âb`¢7WÆ–VE†öæP¢¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$VçFW"F†R÷&FW"çVÖ&W"æBF†RVÖ–Â÷"†öæRçVÖ&W"W6VBf÷"F†RW&6†6Râ ¢Ò“°¢Ð ¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7B&V6÷&BÐ¢–Bæf–æB†—FVÒÓà¢7W7FöÖW$÷&FW$çVÖ&W"€¢—FVÐ¢’çFôÆ÷vW$66R‚’ÓÓÐ¢÷&FW$çVÖ&W"çFôÆ÷vW$66R‚¢“° ¢6öç7BvVæW&–5&W7öç6RÒ°¢ö³¢G'VRÀ¢ÖW76vS ¢$–bF†R÷&FW"–æf÷&ÖF–öâÖF6†W2÷W"&V6÷&G2ÂfW&–f–6F–öâVÖ–Âv–ÆÂ&R6VçBFòF†RVÖ–ÂFG&W72W6VBf÷"F†BW&6†6Râ ¢Ó° ¢–b‚&V6÷&B’°¢&WGW&â&W2æ§6öâ€¢vVæW&–5&W7öç6P¢“°¢Ð ¢–b€¢&V6÷&Bæ7W7FöÖW$66÷VçD–Bb`¢&V6÷&Bæ7W7FöÖW$66÷VçD–BÓÐ¢&Wæ7W7FöÖW$66÷VçBæ–@¢’°¢&WGW&â&W2æ§6öâ€¢vVæW&–5&W7öç6P¢“°¢Ð ¢–b€¢&V6÷&Bæ7W7FöÖW$66÷VçD–BÓÓÐ¢&Wæ7W7FöÖW$66÷VçBæ–@¢’°¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢Ç&VG”Æ–æ¶VC¢G'VRÀ¢ÖW76vS ¢%F†—2÷&FW"—2Ç&VG’6öææV7FVBFò–÷W"66÷VçBâ ¢Ò“°¢Ð ¢6öç7B÷&FW$VÖ–ÂÐ¢æ÷&ÖÆ—¦TVÖ–Â€¢&V6÷&Bç&öf–ÆSòæVÖ–À¢“° ¢6öç7B÷&FW%†öæRÐ¢æ÷&ÖÆ—¦U†öæR€¢&V6÷&Bç&öf–ÆSòç†öæP¢“° ¢6öç7BVÖ–ÄÖF6†W2Ð¢7WÆ–VDVÖ–Âb`¢÷&FW$VÖ–Âb`¢7WÆ–VDVÖ–ÂÓÓÐ¢÷&FW$VÖ–Ã° ¢6öç7B†öæTÖF6†W2Ð¢7WÆ–VE†öæRb`¢÷&FW%†öæRb`¢7WÆ–VE†öæRÓÓÐ¢÷&FW%†öæS° ¢–b€¢VÖ–ÄÖF6†W2b`¢†öæTÖF6†W0¢’°¢&WGW&â&W2æ§6öâ€¢vVæW&–5&W7öç6P¢“°¢Ð ¢–b‚÷&FW$VÖ–Â’°¢&WGW&â&W2æ§6öâ€¢vVæW&–5&W7öç6P¢“°¢Ð ¢6öç7B&uFö¶VâÐ¢7&VFU6V7W&UFö¶Vâ‚“° ¢6öç7B6Æ–Õ&V6÷&G2Ð¢v—B&VD§6öâ€¢õ$DU%ô4Ä”Õôd”ÄRÀ¢µÐ¢“° ¢6öç7Bæ÷rÐ¢FFRææ÷r‚“° ¢6öç7Bf–ÇFW&VD6Æ–×2Ð¢'&’æ—4'&’€¢6Æ–Õ&V6÷&G0¢¢ò6Æ–Õ&V6÷&G2æf–ÇFW"€¢6Æ–ÒÓà¢çVÖ&W"€¢6Æ–ÒæW‡—&W4@¢’âæ÷p¢¢¢µÓ° ¢6öç7B7F—fT6Æ–×2Ð¢f–ÇFW&VD6Æ–×2æf–ÇFW"€¢6Æ–ÒÓà¢€¢6Æ–Òæ66÷VçD–BÓÓÐ¢&Wæ7W7FöÖW$66÷VçBæ–Bb`¢6Æ–Òæ÷&FW$–BÓÓÐ¢&V6÷&Bæ–@¢¢“° ¢7F—fT6Æ–×2çW6‚‡°¢–C ¢7'—Fòç&æFöÕUT”B‚’À ¢Fö¶Vä†6ƒ ¢†6…6V7W&UFö¶Vâ€¢&uFö¶Và¢’À ¢66÷VçD–C ¢&Wæ7W7FöÖW$66÷VçBæ–BÀ ¢÷&FW$–C ¢&V6÷&Bæ–BÀ ¢7&VFVDC ¢æWrFFR€¢æ÷p¢’çFô•4õ7G&–ær‚’À ¢W‡—&W4C ¢æ÷r°¢R¢c¢ ¢Ò“° ¢v—Bw&—FT§6öâ€¢õ$DU%ô4Ä”Õôd”ÄRÀ¢7F—fT6Æ–×0¢“° ¢v—B6VæD÷&FW$6Æ–ÔVÖ–Â€¢÷&FW$VÖ–ÂÀ¢&uFö¶VâÀ¢7W7FöÖW$÷&FW$çVÖ&W"€¢&V6÷&@¢¢“° ¢&WGW&â&W2æ§6öâ€¢vVæW&–5&W7öç6P¢“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$÷&FW"6Æ–Ò&WVW7BW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFò7F'B÷&FW"fW&–f–6F–öââ ¢Ò“°¢Ð¢Ð¢“° ¦ç÷7B€¢"ö’ö66÷VçB÷fW&–g’Ö÷&FW"Ö6Æ–Ò"À¢&WV—&T7W7FöÖW"À¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B&uFö¶VâÐ¢7G&–ær€¢&Wæ&öG’çFö¶VâÇÂ" ¢’çG&–Ò‚“° ¢–b‚&uFö¶Vâ’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢%fW&–f–6F–öâÆ–æ²—2–çfÆ–Bâ ¢Ò“°¢Ð ¢6öç7BFö¶Vä†6‚Ð¢†6…6V7W&UFö¶Vâ€¢&uFö¶Và¢“° ¢6öç7B6Æ–×2Ð¢v—B&VD§6öâ€¢õ$DU%ô4Ä”Õôd”ÄRÀ¢µÐ¢“° ¢6öç7Bæ÷rÐ¢FFRææ÷r‚“° ¢6öç7B6Æ–ÒÐ¢€¢'&’æ—4'&’†6Æ–×2¢ò6Æ–×0¢¢µÐ¢’æf–æB€¢—FVÒÓà¢6fTWVÂ€¢—FVÒçFö¶Vä†6‚ÇÂ""À¢Fö¶Vä†6€¢’b`¢—FVÒæ66÷VçD–BÓÓÐ¢&Wæ7W7FöÖW$66÷VçBæ–Bb`¢çVÖ&W"€¢—FVÒæW‡—&W4@¢’âæ÷p¢“° ¢–b‚6Æ–Ò’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢%F†—2fW&–f–6F–öâÆ–æ²—2–çfÆ–B÷"†2W‡—&VBâ ¢Ò“°¢Ð ¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7B&V6÷&BÐ¢–Bæf–æB€¢—FVÒÓà¢—FVÒæ–BÓÓÐ¢6Æ–Òæ÷&FW$–@¢“° ¢–b€¢&V6÷&BÇÀ¢€¢&V6÷&Bæ7W7FöÖW$66÷VçD–Bb`¢&V6÷&Bæ7W7FöÖW$66÷VçD–BÓÐ¢&Wæ7W7FöÖW$66÷VçBæ–@¢¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢%F†—2÷&FW"6âæòÆöævW"&R6öææV7FVBâ ¢Ò“°¢Ð ¢6öç7BÆ–æ¶VDBÐ¢æWrFFR‚’çFô•4õ7G&–ær‚“° ¢&V6÷&Bæ7W7FöÖW$66÷VçD–BÐ¢&Wæ7W7FöÖW$66÷VçBæ–C° ¢&V6÷&Bæ7W7FöÖW$Æ–æ¶VDBÐ¢Æ–æ¶VDC° ¢v—Bw&—FT§6öâ€¢”Eôd”ÄRÀ¢–@¢“° ¢6öç7B&VÖ–æ–æt6Æ–×2Ð¢€¢'&’æ—4'&’†6Æ–×2¢ò6Æ–×0¢¢µÐ¢’æf–ÇFW"€¢—FVÒÓà¢—FVÒæ÷&FW$–BÓÐ¢&V6÷&Bæ–Bb`¢çVÖ&W"€¢—FVÒæW‡—&W4@¢’âæ÷p¢“° ¢v—Bw&—FT§6öâ€¢õ$DU%ô4Ä”Õôd”ÄRÀ¢&VÖ–æ–æt6Æ–×0¢“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢ÖW76vS ¢%–÷W"÷&FW"†2&VVâ6öææV7FVBFò–÷W"66÷VçBâ ¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$÷&FW"6Æ–ÒfW&–f–6F–öâW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFò6öææV7BF†—2÷&FW"â ¢Ò“°¢Ð¢Ð¢“° ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢$UD”ÄU"$ôd”ÄR„TÅU%0¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦6öç7B$UD”ÄU%ô´U•2Ò°¢'F&vWB"À¢'vÆÖ'B"À¢'¶2"À¢'6×46ÇV""À¢&6÷7F6ò ¥Ó° ¦gVæ7F–öâV×G•&WF–ÆW$7&VFVçF–Ç2‚’°¢&WGW&â°¢F&vWC¢°¢W6W&æÖS¢""À¢77v÷&C¢" ¢ÒÀ ¢vÆÖ'C¢°¢W6W&æÖS¢""À¢77v÷&C¢" ¢ÒÀ ¢¶3¢°¢W6W&æÖS¢""À¢77v÷&C¢" ¢ÒÀ ¢6×46ÇV#¢°¢W6W&æÖS¢""À¢77v÷&C¢" ¢ÒÀ ¢6÷7F6ó¢°¢W6W&æÖS¢""À¢77v÷&C¢" ¢Ð¢Ó°§Ð ¦gVæ7F–öâæ÷&ÖÆ—¦U&WF–ÆW$7&VFVçF–Ç2€¢fÇVP¢’°¢6öç7Bæ÷&ÖÆ—¦VBÐ¢V×G•&WF–ÆW$7&VFVçF–Ç2‚“° ¢6öç7B6÷W&6RÐ¢fÇVRb`¢G—VöbfÇVRÓÓÒ&ö&¦V7B ¢òfÇVP¢¢·Ó° ¢f÷"€¢6öç7B&WF–ÆW"ö`¢$UD”ÄU%ô´U•0¢’°¢6öç7B—FVÒÐ¢6÷W&6U·&WF–ÆW%Òb`¢G—Vöb6÷W&6U·&WF–ÆW%ÒÓÓÐ¢&ö&¦V7B ¢ò6÷W&6U·&WF–ÆW%Ð¢¢·Ó° ¢æ÷&ÖÆ—¦VE·&WF–ÆW%ÒÒ°¢W6W&æÖS ¢6ÆVâ€¢—FVÒçW6W&æÖRÀ¢#S@¢’À ¢77v÷&C ¢7G&–ær€¢—FVÒç77v÷&BÇÂ" ¢’ç6Æ–6RƒÂS"¢Ó°¢Ð ¢æ÷&ÖÆ—¦VBç¶2Ò°¢âââ€¢æ÷&ÖÆ—¦VBç¶2ÇÀ¢·Ð¢’À¢77v÷&C¢" ¢Ó° ¢&WGW&âæ÷&ÖÆ—¦VC°§Ð ¢òòöæR&WF–ÆW"Æöv–â6ææ÷B&RöffW&VBFòGvòF–ffW&VçBÖævVB&öf–ÆW2à¢òò6ö×&R6ö×ÆWFRW6W&æÖR÷77v÷&B—'3²V×G’7&VFVçF–Ç2Fòæ÷B–FVçF–g’â66÷VçBà¦gVæ7F–öâÖævVD7&VFVçF–Å—'2†7&VFVçF–Ç2’°¢6öç7B—'2ÒµÓ°¢6öç7Bæ÷&ÖÆ—¦VBÒæ÷&ÖÆ—¦U&WF–ÆW$7&VFVçF–Ç2†7&VFVçF–Ç2“°¢f÷"†6öç7B&WF–ÆW"öb$UD”ÄU%ô´U•2’°¢6öç7BW6W&æÖRÒ7G&–ær†æ÷&ÖÆ—¦VE·&WF–ÆW%ÓòçW6W&æÖRÇÂ""’çG&–Ò‚’çFôÆ÷vW$66R‚“°¢6öç7B77v÷&BÒ7G&–ær†æ÷&ÖÆ—¦VE·&WF–ÆW%Óòç77v÷&BÇÂ""“°¢–b‡W6W&æÖRbb77v÷&B’—'2çW6‚‡²&WF–ÆW"Â¶W“¢¥4ôâç7G&–æv–g’…·&WF–ÆW"ÂW6W&æÖRÂ77v÷&EÒ’Ò“°¢Ð¢&WGW&â—'3°§Ð ¦gVæ7F–öâÖævVD7&VFVçF–Ä6öæfÆ–7B†66÷VçG2Â7&VFVçF–Ç2ÂW†6ÇVFT–BÒ""’°¢6öç7B&÷÷6VBÒæWrÖ†ÖævVD7&VFVçF–Å—'2†7&VFVçF–Ç2’æÖ‡—"Óâ·—"æ¶W’Â—"ç&WF–ÆW%Ò’“°¢f÷"†6öç7B66÷VçBöb66÷VçG2ÇÂµÒ’°¢–b…7G&–ær†66÷VçBæ–B’ÓÓÒ7G&–ær†W†6ÇVFT–B’ÇÂ66÷VçBæ7&VFVçF–Ç2’6öçF–çVS°¢ÆWBW†—7F–æs°¢G'’²W†—7F–ærÒFV7'—D§6öâ†66÷VçBæ7&VFVçF–Ç2“²Ò6F6‚²6öçF–çVS²Ð¢f÷"†6öç7B—"öbÖævVD7&VFVçF–Å—'2†W†—7F–ær’’°¢–b‡&÷÷6VBæ†2‡—"æ¶W’’’&WGW&â²&WF–ÆW#¢—"ç&WF–ÆW"Ó°¢Ð¢Ð¢&WGW&âçVÆÃ°§Ð ¦gVæ7F–öâÖævVDGWÆ–6FT7&VFVçF–Å7FFR†66÷VçG2Â–åW6T–G2ÒæWr6WB‚’’°¢6öç7Bw&÷W2ÒæWrÖ‚“°¢6öç7BGWÆ–6FT–G2ÒæWr6WB‚“°¢f÷"†6öç7B66÷VçBöb66÷VçG2ÇÂµÒ’°¢–b‚66÷VçBæ7&VFVçF–Ç2’6öçF–çVS°¢ÆWB7&VFVçF–Ç3°¢G'’²7&VFVçF–Ç2ÒFV7'—D§6öâ†66÷VçBæ7&VFVçF–Ç2“²Ò6F6‚²6öçF–çVS²Ð¢f÷"†6öç7B—"öbÖævVD7&VFVçF–Å—'2†7&VFVçF–Ç2’’°¢6öç7B–G2Òw&÷W2ævWB‡—"æ¶W’’ÇÂµÓ°¢–G2çW6‚…7G&–ær†66÷VçBæ–B’“°¢w&÷W2ç6WB‡—"æ¶W’Â–G2“°¢Ð¢Ð¢f÷"†6öç7B–G2öbw&÷W2çfÇVW2‚’’°¢–b†–G2æÆVæwF‚Â"’6öçF–çVS°¢6öç7B76–væVBÒ–G2æf–ÇFW"†–BÓâ–åW6T–G2æ†2†–B’“°¢6öç7B¶VWW"Ò76–væVBæÆVæwF‚ÓÓÒò76–væVE³Ò¢76–væVBæÆVæwF‚òçVÆÂ¢–G5³Ó°¢f÷"†6öç7B–Böb–G2’–b†–BÓÒ¶VWW"’GWÆ–6FT–G2æFB†–B“°¢Ð¢&WGW&â²GWÆ–6FT–G2Ó°§Ð ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢5T4”Â$ôd”ÄR„TÅU%0¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦6öç7B5T4”Åõ$ôd”ÄUõE•U2Ò°¢&g&VR"À¢'&VçFVB ¥Ó° ¦6öç7B5T4”Åõ$ôd”ÄUôEU$D”ôå2Ò°¢&–æFVf–æ—FR"À¢#öG&÷"À¢#÷vVV²"À¢#öÖöçF‚ ¥Ó°  ¦gVæ7F–öâæ÷&ÖÆ—¦U7V6–Å&öf–ÆUG—R€¢fÇVP¢’°¢6öç7BG—RÐ¢7G&–ær€¢fÇVRÇÂ" ¢¢çG&–Ò‚¢çFôÆ÷vW$66R‚“° ¢&WGW&â5T4”Åõ$ôd”ÄUõE•U2æ–æ6ÇVFW2€¢G—P¢¢òG—P¢¢çVÆÃ°§Ð  ¦gVæ7F–öâæ÷&ÖÆ—¦U7V6–Å&öf–ÆTGW&F–öâ€¢fÇVP¢’°¢6öç7BGW&F–öâÐ¢7G&–ær€¢fÇVRÇÂ" ¢¢çG&–Ò‚¢Ú±î¸Â¸­yêë¢°k¢G§¦*^   .toLowerCase();

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
          `ðŸ”´ ${count} ${typeLabel.toUpperCase()} ACCOUNT${count === 1 ? "" : "S"} EXPIRED`,

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
        `ðŸŸ¢ ${restoredManagedAccountIds.length} ${typeLabel.toUpperCase()} ACCOUNT${restoredManagedAccountIds.length === 1 ? "" : "S"} RESTORED`,

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
      e¶¬{®0®+^zºè¬è‘ééŠ—¦÷"€¢6öç7B°¢7W7FöÖW$66÷VçD–BÀ¢7W7FöÖW$76–væÖVçG0¢Òö`¢w&÷WV@¢’°¢ÆWB†öÆBÐ¢7F—fU&W7F÷&T†öÆG4f÷"€¢†öÆG2À¢°¢7W7FöÖW$66÷VçD–BÀ¢G—P¢Ð¢•³ÒÇÀ¢çVÆÃ° ¢–b‚†öÆB’°¢†öÆBÒ°¢–C ¢7'—Fòç&æFöÕUT”B‚’À ¢7W7FöÖW$66÷VçD–BÀ ¢G—RÀ ¢7FGW3 ¢&†VÆB"À ¢†öÆE7F'FVDC ¢æ÷t—6òÀ ¢†öÆEVçF–Ã ¢æWrFFR€¢æ÷r°¢ÔätTEõ$U5Dõ$Uô„ôÄEôÕ0¢’çFô•4õ7G&–ær‚’À ¢—FV×3¢µÒÀ ¢7&VFVDC ¢æ÷t—6òÀ ¢WFFVDC ¢æ÷t—6òÀ ¢W‡—&F–öäF—66÷&E6VçDC ¢çVÆÂÀ ¢W‡—&F–öäF—66÷&DÖW76vT–C ¢çVÆÀ¢Ó° ¢†öÆG2çW6‚€¢†öÆ@¢“°¢Ð ¢6öç7BW†—7F–æt–G2Ð¢æWr6WB€¢&W7F÷&T†öÆE&VÖ–æ–æt—FV×2€¢†öÆ@¢’æÖ€¢—FVÒÓà¢7G&–ær€¢—FVÒæÖævVD66÷VçD–BÇÀ¢" ¢¢¢“° ¢ÆWBFFVBÐ¢° ¢f÷"€¢6öç7B76–væÖVçBö`¢7W7FöÖW$76–væÖVçG0¢’°¢6öç7BÖævVD66÷VçD–BÐ¢ÖævVD76–væÖVçDÖVÖ&W'6†—–B€¢76–væÖVç@¢“° ¢–b€¢ÖævVD66÷VçD–BÇÀ¢W†—7F–æt–G2æ†2€¢ÖævVD66÷VçD–@¢¢’°¢6öçF–çVS°¢Ð ¢6öç7BÖVÖ&W'6†—Ð¢ÖævVD66÷VçG2æf–æB€¢—FVÒÓà¢7G&–ær€¢—FVÒæ–@¢’ÓÓÐ¢7G&–ær€¢ÖævVD66÷VçD–@¢¢“° ¢ÆWB&WF–ÆW"Ð¢7G&–ær€¢76–væÖVçBç&VçFÅ&WF–ÆW"ÇÀ¢76–væÖVçBæ76–væÖVçE&WF–ÆW"ÇÀ¢" ¢’çG&–Ò‚“° ¢–b€¢&WF–ÆW"b`¢ÖVÖ&W'6†— ¢’°¢G'’°¢6öç7B7&VFVçF–Ç2Ð¢ÖVÖ&W'6†—æ7&VFVçF–Ç0¢òæ÷&ÖÆ—¦U&WF–ÆW$7&VFVçF–Ç2€¢FV7'—D§6öâ€¢ÖVÖ&W'6†—æ7&VFVçF–Ç0¢¢¢¢V×G•&WF–ÆW$7&VFVçF–Ç2‚“° ¢&WF–ÆW"Ð¢°¢'F&vWB"À¢'vÆÖ'B"À¢'¶2"À¢'6×46ÇV""À¢&6÷7F6ò ¢Òæf–æB€¢¶W’Óà¢7G&–ær€¢7&VFVçF–Ç3òå¶¶W•Ð¢òçW6W&æÖRÇÀ¢" ¢’çG&–Ò‚¢’ÇÂ"#°¢Ò6F6‚°¢&WF–ÆW"Ò"#°¢Ð¢Ð ¢†öÆBæ—FV×2çW6‚‡°¢ÖævVD66÷VçD–BÀ ¢&Wf–÷W476–væÖVçD–C ¢76–væÖVçBæ–BÇÀ¢çVÆÂÀ ¢GW&F–öåG—S ¢76–væÖVçBæGW&F–öåG—RÇÀ¢çVÆÂÀ ¢&WF–ÆW# ¢&WF–ÆW"ÇÀ¢çVÆÂÀ ¢†VÆDC ¢æ÷t—6òÀ ¢&W7F÷&VDC ¢çVÆÂÀ ¢&VÆV6VDC ¢çVÆÀ¢Ò“° ¢W†—7F–æt–G2æFB€¢ÖævVD66÷VçD–@¢“° ¢FFVB³Ò°¢Ð ¢–b†FFVB’°¢†öÆBç7FGW2Ð¢&†VÆB#° ¢†öÆBæ†öÆEVçF–ÂÐ¢æWrFFR€¢æ÷r°¢ÔätTEõ$U5Dõ$Uô„ôÄEôÕ0¢’çFô•4õ7G&–ær‚“° ¢†öÆBçWFFVDBÐ¢æ÷t—6ó° ¢†öÆBæW‡—&F–öäF—66÷&E6VçDBÐ¢çVÆÃ° ¢†öÆBæW‡—&F–öäF—66÷&DÖW76vT–BÐ¢çVÆÃ° ¢v—B6VæE&W7F÷&T†öÆDW‡—&F–öäF—66÷&B€¢†öÆBÀ¢ÖævVD66÷VçG0¢“°¢Ð¢Ð¢Ð¢“° ¢f÷"€¢6öç7B76–væÖVçBö`¢GVP¢’°¢6ÆV$ÖævVD76–væÖVçD7W7FöÖW$FF€¢76–væÖVçBÀ¢°¢&V6öã ¢&W‡—&VB"À¢æ÷t—6ð¢Ð¢“°¢Ð ¢&WGW&âG'VS°§Ð  ¦7–æ2gVæ7F–öâvWE&VçFÄ76–væÖVçG2‚’°¢6öç7B&V6÷&G2Ð¢v—B&VD§6öâ€¢$TåDÅô54”täÔTåE5ôd”ÄRÀ¢µÐ¢“° ¢6öç7B76–væÖVçG2Ð¢'&’æ—4'&’‡&V6÷&G2¢ò&V6÷&G0¢¢µÓ° ¢–b€¢v—B6ÆVçWW‡—&VDÖævVD76–væÖVçG2€¢76–væÖVçG2À¢'&VçFVB ¢¢’°¢v—B6fU&VçFÄ76–væÖVçG2€¢76–væÖVçG0¢“°¢Ð ¢&WGW&â76–væÖVçG3°§Ð  ¦7–æ2gVæ7F–öâ6fU&VçFÄ76–væÖVçG2€¢&V6÷&G0¢’°¢v—Bw&—FT§6öâ€¢$TåDÅô54”täÔTåE5ôd”ÄRÀ¢&V6÷&G0¢“°§Ð ¦7–æ2gVæ7F–öâvWDÖævVD66÷VçG2‚’°¢6öç7B&V6÷&G2Ð¢v—B&VD§6öâ€¢ÔätTEô44õTåE5ôd”ÄRÀ¢µÐ¢“° ¢&WGW&â'&’æ—4'&’‡&V6÷&G2¢ò&V6÷&G0¢¢µÓ°§Ð  ¦7–æ2gVæ7F–öâ6fTÖævVD66÷VçG2€¢&V6÷&G0¢’°¢v—Bw&—FT§6öâ€¢ÔätTEô44õTåE5ôd”ÄRÀ¢&V6÷&G0¢“°§Ð ¦7–æ2gVæ7F–öâvWDg&VTÖVÖ&W'6†—2‚’°¢6öç7B&V6÷&G2Ð¢v—B&VD§6öâ€¢e$TUôÔTÔ$U%4„•5ôd”ÄRÀ¢µÐ¢“° ¢&WGW&â'&’æ—4'&’‡&V6÷&G2¢ò&V6÷&G0¢¢µÓ°§Ð  ¦7–æ2gVæ7F–öâ6fTg&VTÖVÖ&W'6†—2€¢&V6÷&G0¢’°¢v—Bw&—FT§6öâ€¢e$TUôÔTÔ$U%4„•5ôd”ÄRÀ¢&V6÷&G0¢“°§Ð ¦7–æ2gVæ7F–öâvWDv–gFVDÖVÖ&W'6†—2‚’°¢6öç7B&V6÷&G2Òv—B&VD§6öâ„t”eDTEôÔTÔ$U%4„•5ôd”ÄRÂµÒ“°¢&WGW&â'&’æ—4'&’‡&V6÷&G2’ò&V6÷&G2¢µÓ°§Ð ¦7–æ2gVæ7F–öâ6fTv–gFVDÖVÖ&W'6†—2‡&V6÷&G2’°¢v—Bw&—FT§6öâ„t”eDTEôÔTÔ$U%4„•5ôd”ÄRÂ&V6÷&G2“°§Ð ¦7–æ2gVæ7F–öâ7F—fTÖVÖ&W'6†—&V6÷&Df÷$7W7FöÖW"†7W7FöÖW$66÷VçD–BÂ–E&V6÷&G2ÒµÒ’°¢6öç7B–BÒ–E&V6÷&G2æf–æB‡&V6÷&BÓà¢7G&–ær‡&V6÷&Bæ7W7FöÖW$66÷VçD–B’ÓÓÒ7G&–ær†7W7FöÖW$66÷VçD–B’b`¢7V'67&—F–öäÆÆ÷w5&öf–ÆW2‡&V6÷&B¢“°¢–b‡–B’&WGW&â–C°¢6öç7Bæ÷rÒFFRææ÷r‚“°¢6öç7Bw&çG2Òv—BvWDv–gFVDÖVÖ&W'6†—2‚“°¢6öç7Bv–gBÒw&çG2æf–ÇFW"†—FVÒÓà¢7G&–ær†—FVÒæ7W7FöÖW$66÷VçD–B’ÓÓÒ7G&–ær†7W7FöÖW$66÷VçD–B’b`¢æWrFFR†—FVÒç7F'G4B’ævWEF–ÖR‚’ÃÒæ÷rb`¢æWrFFR†—FVÒæW‡—&W4B’ævWEF–ÖR‚’âæ÷p¢’ç6÷'B‚†Â"’ÓâçVÖ&W"†"ç&öf–ÆW2’ÒçVÖ&W"†ç&öf–ÆW2’•³Ó°¢–b‚v–gB’&WGW&âçVÆÃ°¢6öç7B66÷VçBÒ†v—BvWD7W7FöÖW$66÷VçG2‚’’æf–æB†—FVÒÓâ7G&–ær†—FVÒæ–B’ÓÓÒ7G&–ær†7W7FöÖW$66÷VçD–B’“°¢–b‚66÷VçB’&WGW&âçVÆÃ°¢&WGW&â°¢–C¢v–gC¢G¶v–gBæ–GÖÀ¢7W7FöÖW$66÷VçD–BÀ¢&öf–ÆS¢²âââ†66÷VçBæFÖ–å&öf–ÆRÇÂ·Ò’ÂVÖ–Ã¢66÷VçBæVÖ–ÂÒÀ¢7V'67&—F–öå7FGW3¢&v–gFVB"À¢7W'&VçEW&–öDVæC¢v–gBæW‡—&W4@¢Ó°§Ð ¦gVæ7F–öâÖVÖ&W'6†—Væ7'—FVE6¶vR‡&V6÷&B’°¢&WGW&â7G&–ær‡&V6÷&Còæ–BÇÂ""’ç7F'G5v—F‚‚&v–gC¢"¢ò&öÖ—6Rç&W6öÇfR†çVÆÂ¢¢ÆöDVæ7'—FVE6¶vR‡&V6÷&Bæ–B“°§Ð ¦7–æ2gVæ7F–öâvWDF—66÷VçD6öFW2‚’°¢6öç7B&V6÷&G2Òv—B&VD§6öâ„D•44õTåEô4ôDU5ôd”ÄRÂµÒ“°¢&WGW&â'&’æ—4'&’‡&V6÷&G2’ò&V6÷&G2¢µÓ°§Ð ¦7–æ2gVæ7F–öâ6fTF—66÷VçD6öFW2‡&V6÷&G2’°¢v—Bw&—FT§6öâ„D•44õTåEô4ôDU5ôd”ÄRÂ&V6÷&G2“°§Ð  ¦7–æ2gVæ7F–öâvWDg&VT76–væÖVçG2‚’°¢6öç7B&V6÷&G2Ð¢v—B&VD§6öâ€¢e$TUô54”täÔTåE5ôd”ÄRÀ¢µÐ¢“° ¢6öç7B76–væÖVçG2Ð¢'&’æ—4'&’‡&V6÷&G2¢ò&V6÷&G0¢¢µÓ° ¢–b€¢v—B6ÆVçWW‡—&VDÖævVD76–væÖVçG2€¢76–væÖVçG2À¢&g&VR ¢¢’°¢v—B6fTg&VT76–væÖVçG2€¢76–væÖVçG0¢“°¢Ð ¢&WGW&â76–væÖVçG3°§Ð  ¦7–æ2gVæ7F–öâ6fTg&VT76–væÖVçG2€¢&V6÷&G0¢’°¢v—Bw&—FT§6öâ€¢e$TUô54”täÔTåE5ôd”ÄRÀ¢&V6÷&G0¢“°§Ð  ¦gVæ7F–öâg&VT76–væÖVçD—47F—fR€¢76–væÖVç@¢’°¢–b€¢76–væÖVçCòæ7F—fRÓÒG'VP¢’°¢&WGW&âfÇ6S°¢Ð ¢–b‚76–væÖVçCòæW‡—&W4B’°¢&WGW&âG'VS°¢Ð ¢6öç7BW‡—&W4BÐ¢æWrFFR€¢76–væÖVçBæW‡—&W4@¢“° ¢–b€¢çVÖ&W"æ—4æâ€¢W‡—&W4BævWEF–ÖR‚¢¢’°¢&WGW&âfÇ6S°¢Ð ¢&WGW&â€¢W‡—&W4BævWEF–ÖR‚’à¢FFRææ÷r‚¢“°§Ð  ¦gVæ7F–öâg&VT76–væÖVçDF—5&VÖ–æ–ær€¢76–væÖVç@¢’°¢–b€¢g&VT76–væÖVçD—47F—fR€¢76–væÖVç@¢¢’°¢&WGW&â°¢Ð ¢–b‚76–væÖVçCòæW‡—&W4B’°¢&WGW&âçVÆÃ°¢Ð ¢6öç7BW‡—&W4BÐ¢æWrFFR€¢76–væÖVçBæW‡—&W4@¢“° ¢6öç7B&VÖ–æ–ærÐ¢W‡—&W4BævWEF–ÖR‚’Ð¢FFRææ÷r‚“° ¢&WGW&âÖF‚æÖ‚€¢À¢ÖF‚æ6V–Â€¢&VÖ–æ–ærð¢€¢ ¢c ¢c ¢#@¢¢¢“°§Ð  ¦gVæ7F–öâ7W'&VçDg&VT76–væÖVçB€¢76–væÖVçG2À¢g&VTÖVÖ&W'6†—–@¢’°¢6öç7BvçFVD–BÐ¢7G&–ær€¢g&VTÖVÖ&W'6†—–BÇÀ¢" ¢“° ¢&WGW&â€¢76–væÖVçG2æf–æB€¢76–væÖVçBÓà¢7G&–ær€¢76–væÖVç@¢æÖævVD66÷VçD–BÇÀ¢76–væÖVç@¢æg&VTÖVÖ&W'6†—–BÇÀ¢" ¢’ÓÓÐ¢vçFVD–Bb`¢ÖævVD76–væÖVçD—4Æ–æ¶VB€¢76–væÖVç@¢¢’ÇÂçVÆÀ¢“°§Ð  ¦gVæ7F–öâ&VçFÄ76–væÖVçD—47F—fR€¢76–væÖVç@¢’°¢–b€¢76–væÖVçCòæ7F—fRÓÒG'VP¢’°¢&WGW&âfÇ6S°¢Ð ¢–b‚76–væÖVçCòæW‡—&W4B’°¢&WGW&âG'VS°¢Ð ¢6öç7BW‡—&W4BÐ¢æWrFFR€¢76–væÖVçBæW‡—&W4@¢“° ¢–b€¢çVÖ&W"æ—4æâ€¢W‡—&W4BævWEF–ÖR‚¢¢’°¢&WGW&âfÇ6S°¢Ð ¢&WGW&â€¢W‡—&W4BævWEF–ÖR‚’à¢FFRææ÷r‚¢“°§Ð  ¦gVæ7F–öâ&VçFÄ76–væÖVçDF—5&VÖ–æ–ær€¢76–væÖVç@¢’°¢–b€¢&VçFÄ76–væÖVçD—47F—fR€¢76–væÖVç@¢¢’°¢&WGW&â°¢Ð ¢–b‚76–væÖVçCòæW‡—&W4B’°¢&WGW&âçVÆÃ°¢Ð ¢6öç7BW‡—&W4BÐ¢æWrFFR€¢76–væÖVçBæW‡—&W4@¢“° ¢6öç7B&VÖ–æ–ærÐ¢W‡—&W4BævWEF–ÖR‚’Ð¢FFRææ÷r‚“° ¢&WGW&âÖF‚æÖ‚€¢À¢ÖF‚æ6V–Â€¢&VÖ–æ–ærð¢€¢ ¢c ¢c ¢#@¢¢¢“°§Ð  ¦gVæ7F–öâ7W'&VçE&VçFÄ76–væÖVçB€¢76–væÖVçG2À¢&VçFVDÖVÖ&W'6†—–@¢’°¢6öç7BvçFVD–BÐ¢7G&–ær€¢&VçFVDÖVÖ&W'6†—–BÇÀ¢" ¢“° ¢&WGW&â€¢76–væÖVçG2æf–æB€¢76–væÖVçBÓà¢7G&–ær€¢76–væÖVç@¢æÖævVD66÷VçD–BÇÀ¢76–væÖVç@¢ç&VçFVDÖVÖ&W'6†—–BÇÀ¢" ¢’ÓÓÐ¢vçFVD–Bb`¢ÖævVD76–væÖVçD—4Æ–æ¶VB€¢76–væÖVç@¢¢’ÇÂçVÆÀ¢“°§Ð  ¦gVæ7F–öâÖævVD76–væÖVçD—4Æ–æ¶VB€¢76–væÖVç@¢’°¢–b€¢76–væÖVçBÇÀ¢76–væÖVçBæ7W7FöÖW$66÷VçD–@¢’°¢&WGW&âfÇ6S°¢Ð ¢–b€¢76–væÖVçBç&WGW&æVEFõööÄBÇÀ¢7G&–ær€¢76–væÖVçBæVæE&V6öâÇÀ¢" ¢’ÓÓÒ'&WGW&æVE÷Fõ÷ööÂ ¢’°¢&WGW&âfÇ6S°¢Ð ¢–b€¢7G&–ær€¢76–væÖVçBæ7F—fF–öå7FGW2ÇÀ¢" ¢’ÓÓÒ&W‡—&VB"ÇÀ¢7G&–ær€¢76–væÖVçBæVæE&V6öâÇÀ¢" ¢’ÓÓÒ&W‡—&VB ¢’°¢&WGW&âfÇ6S°¢Ð ¢–b€¢76–væÖVçBæW‡—&W4@¢’°¢6öç7BVæBÐ¢æWrFFR€¢76–væÖVçBæW‡—&W4@¢’ævWEF–ÖR‚“° ¢–b€¢çVÖ&W"æ—4f–æ—FR†VæB’b`¢VæBÃÒFFRææ÷r‚¢’°¢&WGW&âfÇ6S°¢Ð¢Ð ¢&WGW&âG'VS°§Ð  ¦gVæ7F–öâÆ–æ¶VDg&VT76–væÖVçB€¢76–væÖVçG2À¢ÖVÖ&W'6†—–@¢’°¢&WGW&â€¢76–væÖVçG2æf–æB€¢76–væÖVçBÓà¢7G&–ær€¢76–væÖVçBæÖævVD66÷VçD–BÇÀ¢76–væÖVçBæg&VTÖVÖ&W'6†—–BÇÀ¢" ¢’ÓÓÐ¢7G&–ær†ÖVÖ&W'6†—–B’b`¢ÖævVD76–væÖVçD—4Æ–æ¶VB€¢76–væÖVç@¢¢’ÇÂçVÆÀ¢“°§Ð  ¦gVæ7F–öâÆ–æ¶VE&VçFÄ76–væÖVçB€¢76–væÖVçG2À¢ÖVÖ&W'6†—–@¢’°¢&WGW&â€¢76–væÖVçG2æf–æB€¢76–væÖVçBÓà¢7G&–ær€¢76–væÖVçBæÖævVD66÷VçD–BÇÀ¢76–væÖVçBç&VçFVDÖVÖ&W'6†—–BÇÀ¢" ¢’ÓÓÐ¢7G&–ær†ÖVÖ&W'6†—–B’b`¢ÖævVD76–væÖVçD—4Æ–æ¶VB€¢76–væÖVç@¢¢’ÇÂçVÆÀ¢“°§Ð  ¦gVæ7F–öâ7F–öäæVVFVEvV&†ööµW&Â‚’°¢&WGW&â7G&–ær€¢&ö6W72æVç`¢äD•44õ$Eô5D”ôåôäTTDTEõtT$„ôôµõU$ÂÇÀ¢" ¢’çG&–Ò‚“°§Ð  ¦gVæ7F–öâ7W7FöÖW$æ÷F–f–6F–öç2€¢66÷Vç@¢’°¢–b€¢'&’æ—4'&’€¢66÷VçBææ÷F–f–6F–öç0¢¢’°¢66÷VçBææ÷F–f–6F–öç2ÒµÓ°¢Ð ¢&WGW&â66÷VçBææ÷F–f–6F–öç3°§Ð  ¦7–æ2gVæ7F–öâFVÆWFT7F–öäæVVFVDF—66÷&DÖW76vR€¢ÖW76vT–@¢’°¢6öç7BvV&†ööµW&ÂÐ¢7F–öäæVVFVEvV&†ööµW&Â‚“° ¢–b€¢vV&†ööµW&ÂÇÀ¢ÖW76vT–@¢’°¢&WGW&âfÇ6S°¢Ð ¢G'’°¢6öç7BW&ÂÐ¢æWrU$Â€¢vV&†ööµW&À¢“° ¢W&ÂçF†æÖRÐ¢G·W&ÂçF†æÖRç&WÆ6R‚õÂòBòÂ""—ÒöÖW76vW2òG¶Væ6öFUU$”6ö×öæVçB€¢ÖW76vT–@¢—Ö° ¢6öç7B&W7öç6RÐ¢v—BfWF6‚€¢W&ÂÀ¢°¢ÖWF†öC¢$DTÄUDR ¢Ð¢“° ¢&WGW&â€¢&W7öç6Ræö²ÇÀ¢&W7öç6Rç7FGW2ÓÓÒC@¢“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$7F–öâæVVFVBF—66÷&BFVÆWFRf–ÆVC¢"À¢W'&÷"æÖW76vP¢“° ¢&WGW&âfÇ6S°¢Ð§Ð  ¦7–æ2gVæ7F–öâ6VæD7F–öäæVVFVDF—66÷&DÖW76vR€¢66÷VçBÀ¢ÖW76vP¢’°¢6öç7BvV&†ööµW&ÂÐ¢7F–öäæVVFVEvV&†ööµW&Â‚“° ¢–b‚vV&†ööµW&Â’°¢F‡&÷ræWrW'&÷"€¢$D•44õ$Eô5D”ôåôäTTDTEõtT$„ôôµõU$Â—2æ÷B6öæf–wW&VBâ ¢“°¢Ð ¢6öç7BF—66÷&EW6W&æÖRÐ¢6ÆVâ€¢66÷VçCòæF—66÷&EW6W&æÖRÀ¢ ¢“° ¢6öç7BW6W&æÖU&VfW&Væ6RÐ¢F—66÷&EW6W&æÖP¢òG¶F—66÷&EW6W&æÖWÒ ¢¢"#° ¢6öç7BvV'6—FUW&ÂÐ¢G´$4UõU$ÇÒò6×’×&öf–ÆV° ¢6öç7BW&ÂÐ¢æWrU$Â€¢vV&†ööµW&À¢“° ¢W&Âç6V&6…&×2ç6WB€¢'v—B"À¢'G'VR ¢“° ¢6öç7B&W7öç6RÐ¢v—BfWF6‚€¢W&ÂÀ¢°¢ÖWF†öC¢%õ5B"À ¢†VFW'3¢°¢$6öçFVçBÕG—R# ¢&Æ–6F–öâö§6öâ ¢ÒÀ ¢&öG“ ¢¥4ôâç7G&–æv–g’‡°¢W6W&æÖS ¢%4Ä%2âu$%24ò7F–öâæVVFVB"À ¢ÆÆ÷vVEöÖVçF–öç3¢°¢'6S¢µÐ¢ÒÀ ¢6öçFVçC ¢G·W6W&æÖU&VfW&Væ6WÔ5D”ôâäTTDTB(	BÆV6R6†V6²–÷W"&öf–ÆRvS¢G·vV'6—FUW&ÇÖÀ ¢VÖ&VG3¢°¢°¢F—FÆS ¢$7F–öâæVVFVB"À ¢FW67&—F–öã ¢6ÆVâ€¢ÖW76vRÀ¢3S ¢’ÇÀ¢%ÆV6R6†V6²–÷W"&öf–ÆRvRæB6ö×ÆWFRF†R&WVW7FVB–æf÷&ÖF–öââ"À ¢W&Ã ¢vV'6—FUW&ÂÀ ¢F–ÖW7F× ¢æWrFFR‚¢çFô•4õ7G&–ær‚¢Ð¢Ð¢Ò¢Ð¢“° ¢6öç7B&W7VÇBÐ¢v—B&W7öç6P¢æ§6öâ‚¢æ6F6‚€¢‚’Óâ‡·Ò¢“° ¢–b‚&W7öç6Ræö²’°¢F‡&÷ræWrW'&÷"€¢7F–öâÖæVVFVBF—66÷&BvV&†öö²&WGW&æVBG·&W7öç6Rç7FGW7Òæ ¢“°¢Ð ¢&WGW&â&W7VÇCòæ–BÇÀ¢çVÆÃ°§Ð  ¦gVæ7F–öâ&öf–ÆTÖ—76–ætf–VÆDÆ&VÇ2€¢&öf–ÆRÀ¢6V7&WG2À¢Æ&VÀ¢’°¢6öç7BÖ—76–ærÒµÓ° ¢6öç7B6†—–ætf–VÆG2Ò°¢²&f—'7DæÖR"Â&f—'7BæÖR%ÒÀ¢²&Æ7DæÖR"Â&Æ7BæÖR%ÒÀ¢²&FG&W72"Â'7G&VWBFG&W72%ÒÀ¢²&6—G’"Â&6—G’%ÒÀ¢²'7FFR"Â'7FFR%ÒÀ¢²'¦—"Â%¤•6öFR%ÒÀ¢²&6÷VçG'’"Â&6÷VçG'’%Ð¢Ó° ¢f÷"€¢6öç7B°¢¶W’À¢f–VÆDÆ&VÀ¢Òö`¢6†—–ætf–VÆG0¢’°¢–b€¢7G&–ær€¢&öf–ÆSòå¶¶W•ÒÇÀ¢" ¢’çG&–Ò‚¢’°¢Ö—76–ærçW6‚€¢G¶Æ&VÇÓ¢G¶f–VÆDÆ&VÇÖ ¢“°¢Ð¢Ð ¢6öç7BF–v—G2Ð¢7G&–ær€¢6V7&WG3òæ6ô6&DçVÖ&W"ÇÀ¢" ¢’ç&WÆ6R€¢õÄBörÀ¢" ¢“° ¢–b€¢7G&–ær€¢6V7&WG3òæ6&F†öÆFW"ÇÀ¢" ¢’çG&–Ò‚¢’°¢Ö—76–ærçW6‚€¢G¶Æ&VÇÓ¢6&F†öÆFW"æÖV ¢“°¢Ð ¢–b€¢õåÆG³"Ã—ÒBòçFW7B€¢F–v—G0¢¢’°¢Ö—76–ærçW6‚€¢G¶Æ&VÇÓ¢6&BçVÖ&W& ¢“°¢Ð ¢–b€¢õâƒ³Ó•×Ã³Ó%Ò’BòçFW7B€¢7G&–ær€¢6V7&WG3òæW‡ÖöçF‚ÇÀ¢" ¢¢¢’°¢Ö—76–ærçW6‚€¢G¶Æ&VÇÓ¢W‡—&F–öâÖöçF† ¢“°¢Ð ¢–b€¢õåÆG³GÒBòçFW7B€¢7G&–ær€¢6V7&WG3òæW‡–V"ÇÀ¢" ¢¢¢’°¢Ö—76–ærçW6‚€¢G¶Æ&VÇÓ¢W‡—&F–öâ–V& ¢“°¢Ð ¢&WGW&âÖ—76–æs°§Ð  ¦gVæ7F–öâ–E&öf–ÆTÖ—76–æt—FV×2€¢&V6÷&BÀ¢–æFW‚Ò¢’°¢6öç7B&öf–ÆRÐ¢&V6÷&Còæ7W7FöÖW%&öf–ÆRÇÀ¢·Ó° ¢ÆWB6V7&WG2Ò·Ó° ¢G'’°¢–b€¢&V6÷&Còæ7W7FöÖW%6V7&WG0¢’°¢6V7&WG2Ð¢FV7'—D§6öâ€¢&V6÷&Bæ7W7FöÖW%6V7&WG0¢’ÇÂ·Ó°¢Ð¢Ò6F6‚°¢6V7&WG2Ò·Ó°¢Ð ¢&WGW&â&öf–ÆTÖ—76–ætf–VÆDÆ&VÇ2€¢&öf–ÆRÀ¢6V7&WG2À¢–B&öf–ÆRG¶–æFW‡Ö ¢“°§Ð ¦7–æ2gVæ7F–öâ7W7FöÖW$Ö—76–æt–æf÷&ÖF–öâ€¢7W7FöÖW$66÷VçD–@¢’°¢6öç7B°¢&WF–ÆW%&öf–ÆW2À¢g&VT76–væÖVçG2À¢&VçFÄ76–væÖVçG0¢ÒÒv—B&öÖ—6RæÆÂ…°¢vWE&WF–ÆW%&öf–ÆW2‚’À¢vWDg&VT76–væÖVçG2‚’À¢vWE&VçFÄ76–væÖVçG2‚¢Ò“° ¢6öç7BÖ—76–ærÒµÓ° ¢6öç7B–BÐ¢&WF–ÆW%&öf–ÆW2æf–ÇFW"€¢&V6÷&BÓà¢7G&–ær€¢&V6÷&Bæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢’ÓÓÐ¢7G&–ær€¢7W7FöÖW$66÷VçD–@¢¢“° ¢–Bæf÷$V6‚€¢‡&V6÷&BÂ–æFW‚’Óâ°¢Ö—76–ærçW6‚€¢ââç–E&öf–ÆTÖ—76–æt—FV×2€¢&V6÷&BÀ¢–æFW‚²¢¢“°¢Ð¢“° ¢6öç7B–ç7V7DÖævVBÐ¢€¢76–væÖVçBÀ¢G—RÀ¢çVÖ&W ¢’Óâ°¢–b€¢7G&–ær€¢76–væÖVçBæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢’ÓÐ¢7G&–ær€¢7W7FöÖW$66÷VçD–@¢’ÇÀ¢ÖævVD76–væÖVçD—4Æ–æ¶VB€¢76–væÖVç@¢¢’°¢&WGW&ã°¢Ð ¢ÆWB6V7&WG2Ò·Ó° ¢G'’°¢–b€¢76–væÖVçBæ7W7FöÖW%6V7&WG0¢’°¢6V7&WG2Ð¢FV7'—D§6öâ€¢76–væÖVçBæ7W7FöÖW%6V7&WG0¢’ÇÂ·Ó°¢Ð¢Ò6F6‚°¢6V7&WG2Ò·Ó°¢Ð ¢6öç7BÆ&VÂÐ¢G—RÓÓÒ&g&VR ¢òv–gFVB&öf–ÆRG¶çVÖ&W'Ö ¢¢&VçFVB&öf–ÆRG¶çVÖ&W'Ö° ¢Ö—76–ærçW6‚€¢ââç&öf–ÆTÖ—76–ætf–VÆDÆ&VÇ2€¢76–væÖVçBæ7W7FöÖW%&öf–ÆRÇÀ¢·ÒÀ¢6V7&WG2À¢Æ&VÀ¢¢“°¢Ó° ¢ÆWBv–gFVDçVÖ&W"Ò° ¢f÷"€¢6öç7B76–væÖVçBö`¢g&VT76–væÖVçG0¢’°¢–b€¢7G&–ær€¢76–væÖVçBæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢’ÓÓÐ¢7G&–ær€¢7W7FöÖW$66÷VçD–@¢’b`¢ÖævVD76–væÖVçD—4Æ–æ¶VB€¢76–væÖVç@¢¢’°¢v–gFVDçVÖ&W"³Ò°¢–ç7V7DÖævVB€¢76–væÖVçBÀ¢&g&VR"À¢v–gFVDçVÖ&W ¢“°¢Ð¢Ð ¢ÆWB&VçFVDçVÖ&W"Ò° ¢f÷"€¢6öç7B76–væÖVçBö`¢&VçFÄ76–væÖVçG0¢’°¢–b€¢7G&–ær€¢76–væÖVçBæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢’ÓÓÐ¢7G&–ær€¢7W7FöÖW$66÷VçD–@¢’b`¢ÖævVD76–væÖVçD—4Æ–æ¶VB€¢76–væÖVç@¢¢’°¢&VçFVDçVÖ&W"³Ò°¢–ç7V7DÖævVB€¢76–væÖVçBÀ¢'&VçFVB"À¢&VçFVDçVÖ&W ¢“°¢Ð¢Ð ¢&WGW&âÖ—76–æs°§Ð  ¦7–æ2gVæ7F–öâ7–æ47W7FöÖW$Ö—76–ætæ÷F–f–6F–öâ€¢7W7FöÖW$66÷VçD–@¢’°¢6öç7B66÷VçG2Ð¢v—BvWD7W7FöÖW$66÷VçG2‚“° ¢6öç7B66÷VçBÐ¢66÷VçG2æf–æB€¢—FVÒÓà¢7G&–ær†—FVÒæ–B’ÓÓÐ¢7G&–ær†7W7FöÖW$66÷VçD–B¢“° ¢–b‚66÷VçB’°¢&WGW&â°¢66÷VçC¢çVÆÂÀ¢Ö—76–æs¢µÐ¢Ó°¢Ð ¢6öç7Bæ÷F–f–6F–öç2Ð¢7W7FöÖW$æ÷F–f–6F–öç2€¢66÷Vç@¢“° ¢6öç7BÖ—76–ærÐ¢v—B7W7FöÖW$Ö—76–æt–æf÷&ÖF–öâ€¢7W7FöÖW$66÷VçD–@¢“° ¢6öç7BW†—7F–ærÐ¢æ÷F–f–6F–öç2æf–æB€¢—FVÒÓà¢—FVÒæ¶–æBÓÓÐ¢&Ö—76–æuö–æfò ¢“° ¢–b‚Ö—76–æræÆVæwF‚’°¢–b†W†—7F–ær’°¢–b€¢W†—7F–æræF—66÷&DÖW76vT–@¢’°¢v—BFVÆWFT7F–öäæVVFVDF—66÷&DÖW76vR€¢W†—7F–æræF—66÷&DÖW76vT–@¢“°¢Ð ¢66÷VçBææ÷F–f–6F–öç2Ð¢æ÷F–f–6F–öç2æf–ÇFW"€¢—FVÒÓà¢—FVÒæ–BÓÐ¢W†—7F–æræ–@¢“° ¢66÷VçBçWFFVDBÐ¢æWrFFR‚¢çFô•4õ7G&–ær‚“° ¢v—B6fT7W7FöÖW$66÷VçG2€¢66÷VçG0¢“° ¢G'’°¢6öç7B&WF–ÆW%&öf–ÆW2Ð¢v—BvWE&WF–ÆW%&öf–ÆW2‚“° ¢6öç7Bf—'7E&öf–ÆRÐ¢&WF–ÆW%&öf–ÆW2æf–æB€¢&V6÷&BÓà¢7G&–ær€¢&V6÷&Bæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢’ÓÓÐ¢7G&–ær€¢7W7FöÖW$66÷VçD–@¢¢“° ¢6öç7B7W7FöÖW$æÖRÐ¢°¢f—'7E&öf–ÆP¢òæ7W7FöÖW%&öf–ÆP¢òæf—'7DæÖRÀ¢f—'7E&öf–ÆP¢òæ7W7FöÖW%&öf–ÆP¢òæÆ7DæÖP¢Ð¢æf–ÇFW"„&ööÆVâ¢æ¦ö–â‚""’ÇÀ¢66÷VçBæVÖ–ÂÇÀ¢m«ëŒ+Š×ž®º+º$zzb¥à     "Customer";

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
      missing
    };
  }

  const message =
    `Important information is missing:\\nâ€¢ ${missing.join(
      "\\nâ€¢ "
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
    missing
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
  const giftedAllowance = gifted
    .filter(item =>
      String(item.customerAccountId) === String(accountId) &&
      (!item.startsAt || new Date(item.startsAt).getTime() <= now) &&
      (!item.expiresAt || new Date(item.expiresAt).getTime() > now)
    )
    .reduce((max, item) => Math.max(max, Number(item.profiles) || 0), 0);

  return Math.max(paidAllowance, giftedAllowance);
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
          Strm«ëŒ+Š×ž®º+inA®‰ž˜©zr€¢76–væÖVçBæ7F—fF–öå7FGW2ÇÀ¢" ¢’ÓÐ¢&7F—fFVB"ÇÀ¢76–væÖVçBæW‡—&W4@¢’°¢6öçF–çVS°¢Ð ¢6öç7BW‡—&W4BÐ¢æWrFFR€¢76–væÖVçBæW‡—&W4@¢“° ¢–b€¢çVÖ&W"æ—4æâ€¢W‡—&W4BævWEF–ÖR‚¢’b`¢W‡—&W4BævWEF–ÖR‚’ÃÐ¢æ÷rævWEF–ÖR‚¢’°¢–b€¢76–væÖVçBæ7F—fF–öå7FGW2ÓÐ¢&W‡—&VB ¢’°¢6ÆV$ÖævVD76–væÖVçD7W7FöÖW$FF€¢76–væÖVçBÀ¢°¢&V6öã ¢&W‡—&VB"À¢æ÷t—6ó ¢æ÷rçFô•4õ7G&–ær‚¢Ð¢“° ¢76–væÖVçG46†ævVBÐ¢G'VS°¢Ð ¢6öç7BF—66÷&D6†ævVBÐ¢v—BVç7W&TÖævVE&öf–ÆTF—66÷&DÖW76vR€¢76–væÖVçBÀ¢&g&VR ¢“° ¢–b†F—66÷&D6†ævVB’°¢76–væÖVçG46†ævVBÐ¢G'VS°¢Ð¢Ð¢Ð ¢f÷"€¢6öç7B76–væÖVçBö`¢76–væÖVçG0¢’°¢–b€¢76–væÖVçBæ7F—fRÓÐ¢G'VRÇÀ¢76–væÖVçBæ7F—fF–öå7FGW2ÓÓÐ¢&W‡—&VB"ÇÀ¢76–væÖVçBæ7F—fF–öå7FGW2ÓÓÐ¢&7F—fFVB"ÇÀ¢76–væÖVçBæ7W7FöÖW%&öf–ÆRÇÀ¢76–væÖVçBæ7W7FöÖW%6V7&WG0¢’°¢6öçF–çVS°¢Ð ¢ÆWB6V7&WG2Ò·Ó° ¢G'’°¢6V7&WG2Ð¢FV7'—D§6öâ€¢76–væÖVçBæ7W7FöÖW%6V7&WG0¢’ÇÂ·Ó°¢Ò6F6‚°¢6V7&WG2Ò·Ó°¢Ð ¢6öç7B&VF–æW72Ð¢ÖævVE&öf–ÆU&VF–æW72€¢76–væÖVçBæ7W7FöÖW%&öf–ÆRÀ¢6V7&WG0¢“° ¢–b€¢&VF–æW72ç&VG’b`¢76–væÖVçBæ7F—fF–öå7FGW2ÓÐ¢&v—F–æuö7F—fF–öâ ¢’°¢76–væÖVçBæ7F—fF–öå7FGW2Ð¢&v—F–æuö7F—fF–öâ#° ¢76–væÖVçBæ7F—fF–öå&WVW7FVDBÐ¢76–væÖVçBæ7F—fF–öå&WVW7FVDBÇÀ¢æ÷rçFô•4õ7G&–ær‚“° ¢76–væÖVçBçWFFVDBÐ¢æ÷rçFô•4õ7G&–ær‚“° ¢76–væÖVçG46†ævVBÐ¢G'VS° ¢6öç7BF—66÷&D6†ævVBÐ¢v—BVç7W&TÖævVE&öf–ÆTF—66÷&DÖW76vR€¢76–væÖVçBÀ¢&g&VR ¢“° ¢76–væÖVçG46†ævVBÐ¢76–væÖVçG46†ævVBÇÀ¢F—66÷&D6†ævVC°¢Ð¢Ð ¢–b†76–væÖVçG46†ævVB’°¢v—B6fTg&VT76–væÖVçG2€¢76–væÖVçG0¢“°¢Ð ¢6öç7B7W7FöÖW$76–væÖVçG2Ð¢76–væÖVçG2æf–ÇFW"€¢76–væÖVçBÓà¢76–væÖVç@¢æ7W7FöÖW$66÷VçD–BÓÓÐ¢&Wæ7W7FöÖW$66÷VçBæ–Bb`¢76–væÖVçBæ7F—fRÓÓÐ¢G'VP¢“° ¢6öç7B&W7VÇBÐ¢7W7FöÖW$76–væÖVçG0¢æÖ†76–væÖVçBÓâ°¢6öç7BÖVÖ&W'6†—Ð¢ÖVÖ&W'6†—2æf–æB€¢—FVÒÓà¢—FVÒæ–BÓÓÐ¢76–væÖVç@¢æg&VTÖVÖ&W'6†—–@¢“° ¢–b‚ÖVÖ&W'6†—’°¢&WGW&âçVÆÃ°¢Ð ¢ÆWB7W7FöÖW$6&BÐ¢çVÆÃ° §G'’°¢–b€¢76–væÖVçBæ7W7FöÖW%6V7&WG0¢’°¢6öç7B7W7FöÖW%6V7&WG2Ð¢FV7'—D§6öâ€¢76–væÖVçBæ7W7FöÖW%6V7&WG0¢“° ¢7W7FöÖW$6&BÒ°¢6&DÆ&VÃ ¢7W7FöÖW%6V7&WG2æ6&DÆ&VÂÇÂ""À¢6&F†öÆFW# ¢7W7FöÖW%6V7&WG2æ6&F†öÆFW"ÇÂ""À¢6ô6&DçVÖ&W# ¢7W7FöÖW%6V7&WG2æ6ô6&DçVÖ&W"ÇÂ""À¢W‡ÖöçFƒ ¢7W7FöÖW%6V7&WG2æW‡ÖöçF‚ÇÂ""À¢W‡–V# ¢7W7FöÖW%6V7&WG2æW‡–V"ÇÂ""À¢6V7W&—G”6öFS ¢7W7FöÖW%6V7&WG2ç6V7W&—G”6öFRÇÂ" ¢Ó°¢Ð§Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$7W7FöÖW"g&VRÖVÖ&W'6†—6&BFV7'—BW'&÷#¢"À¢76–væÖVçBæ–BÀ¢W'&÷"æÖW76vP¢“°§Ð ¢&WGW&â°¢–C ¢ÖVÖ&W'6†—æ–BÀ ¢76–væÖVçD–C ¢76–væÖVçBæ–BÀ ¢&öf–ÆUG—S ¢&g&VR"À ¢&öf–ÆTæÖS ¢ÖVÖ&W'6†—ç&öf–ÆTæÖRÇÀ¢$e$TRÔTÔ$U%4„•"À ¢7FGW3 ¢76–væÖVçBæ7F—fF–öå7FGW2ÓÓÐ¢&W‡—&VB ¢ò&W‡—&VB ¢¢&7F—fR"À ¢7F—fS ¢76–væÖVçBæ7F—fF–öå7FGW2ÓÐ¢&W‡—&VB"À ¢7F—fF–öå7FGW3 ¢æ÷&ÖÆ—¦U&öf–ÆT7F—fF–öå7FGW2€¢76–væÖVçBæ7F—fF–öå7FGW2À¢fÇ6P¢’À ¢7F—fF–öäÆ&VÃ ¢&öf–ÆT7F—fF–öäÆ&VÂ€¢æ÷&ÖÆ—¦U&öf–ÆT7F—fF–öå7FGW2€¢76–væÖVçBæ7F—fF–öå7FGW2À¢fÇ6P¢¢’À ¢7F'G4C ¢76–væÖVçBç7F'G4BÇÀ¢çVÆÂÀ ¢W‡—&W4C ¢76–væÖVçBæW‡—&W4BÇÀ¢çVÆÂÀ ¢GW&F–öåG—S ¢76–væÖVçBæGW&F–öåG—RÇÀ¢çVÆÂÀ ¢GW&F–öäÆ&VÃ ¢7V6–Å&öf–ÆTGW&F–öäÆ&VÂ€¢76–væÖVçBæGW&F–öåG—P¢’À ¢F—5&VÖ–æ–æs ¢g&VT76–væÖVçDF—5&VÖ–æ–ær€¢76–væÖVç@¢’À ¢–E7V&Ö—76–öä–C ¢76–væÖVç@¢ç–E7V&Ö—76–öä–BÇÀ¢çVÆÂÀ ¢7W7FöÖW%&öf–ÆS ¢76–væÖVç@¢æ7W7FöÖW%&öf–ÆRÇÀ¢çVÆÂÀ ¢7W7FöÖW$6&BÀ ¢7&VFVDC ¢ÖVÖ&W'6†—æ7&VFVDBÇÀ¢çVÆÂÀ ¢WFFVDC ¢ÖVÖ&W'6†—çWFFVDBÇÀ¢çVÆÀ¢Ó°¢Ò¢æf–ÇFW"„&ööÆVâ“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ ¢ÖVÖ&W'6†—3 ¢&W7VÇ@¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$7W7FöÖW"g&VRÖVÖ&W'6†—2W'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFòÆöBg&VRÖVÖ&W'6†—2â ¢Ò“°¢Ð¢Ð¢“° ¦ævWB€¢"ö’ö66÷VçB÷&VçFVBÖÖVÖ&W'6†—2"À¢&WV—&T7W7FöÖW"À¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BÖVÖ&W'6†—2Ð¢v—BvWDÖævVD66÷VçG2‚“° ¢6öç7B76–væÖVçG2Ð¢v—BvWE&VçFÄ76–væÖVçG2‚“° ¢ÆWB76–væÖVçG46†ævVBÐ¢fÇ6S° ¢6öç7Bæ÷rÐ¢æWrFFR‚“° ¢ò ¢W‡—&R76–væÖVçG2WFöÖF–6ÆÇ¢&Vf÷&R&WGW&æ–ær7W7FöÖW"FFà¢¢ð ¢f÷"€¢6öç7B76–væÖVçBö`¢76–væÖVçG0¢’°¢–b€¢76–væÖVçBæ7F—fRÓÒG'VRÇÀ¢7G&–ær€¢76–væÖVçBæ7F—fF–öå7FGW2ÇÀ¢" ¢’ÓÐ¢&7F—fFVB"ÇÀ¢76–væÖVçBæW‡—&W4@¢’°¢6öçF–çVS°¢Ð ¢6öç7BW‡—&W4BÐ¢æWrFFR€¢76–væÖVçBæW‡—&W4@¢“° ¢–b€¢çVÖ&W"æ—4æâ€¢W‡—&W4BævWEF–ÖR‚¢’b`¢W‡—&W4BævWEF–ÖR‚’ÃÐ¢æ÷rævWEF–ÖR‚¢’°¢–b€¢76–væÖVçBæ7F—fF–öå7FGW2ÓÐ¢&W‡—&VB ¢’°¢6ÆV$ÖævVD76–væÖVçD7W7FöÖW$FF€¢76–væÖVçBÀ¢°¢&V6öã ¢&W‡—&VB"À¢æ÷t—6ó ¢æ÷rçFô•4õ7G&–ær‚¢Ð¢“° ¢76–væÖVçG46†ævVBÐ¢G'VS°¢Ð ¢6öç7BF—66÷&D6†ævVBÐ¢v—BVç7W&TÖævVE&öf–ÆTF—66÷&DÖW76vR€¢76–væÖVçBÀ¢'&VçFVB ¢“° ¢–b†F—66÷&D6†ævVB’°¢76–væÖVçG46†ævVBÐ¢G'VS°¢Ð¢Ð¢Ð ¢f÷"€¢6öç7B76–væÖVçBö`¢76–væÖVçG0¢’°¢–b€¢76–væÖVçBæ7F—fRÓÐ¢G'VRÇÀ¢76–væÖVçBæ7F—fF–öå7FGW2ÓÓÐ¢&W‡—&VB"ÇÀ¢76–væÖVçBæ7F—fF–öå7FGW2ÓÓÐ¢&7F—fFVB"ÇÀ¢76–væÖVçBæ7W7FöÖW%&öf–ÆRÇÀ¢76–væÖVçBæ7W7FöÖW%6V7&WG0¢’°¢6öçF–çVS°¢Ð ¢ÆWB6V7&WG2Ò·Ó° ¢G'’°¢6V7&WG2Ð¢FV7'—D§6öâ€¢76–væÖVçBæ7W7FöÖW%6V7&WG0¢’ÇÂ·Ó°¢Ò6F6‚°¢6V7&WG2Ò·Ó°¢Ð ¢6öç7B&VF–æW72Ð¢ÖævVE&öf–ÆU&VF–æW72€¢76–væÖVçBæ7W7FöÖW%&öf–ÆRÀ¢6V7&WG0¢“° ¢–b€¢&VF–æW72ç&VG’b`¢76–væÖVçBæ7F—fF–öå7FGW2ÓÐ¢&v—F–æuö7F—fF–öâ ¢’°¢76–væÖVçBæ7F—fF–öå7FGW2Ð¢&v—F–æuö7F—fF–öâ#° ¢76–væÖVçBæ7F—fF–öå&WVW7FVDBÐ¢76–væÖVçBæ7F—fF–öå&WVW7FVDBÇÀ¢æ÷rçFô•4õ7G&–ær‚“° ¢76–væÖVçBçWFFVDBÐ¢æ÷rçFô•4õ7G&–ær‚“° ¢76–væÖVçG46†ævVBÐ¢G'VS° ¢6öç7BF—66÷&D6†ævVBÐ¢v—BVç7W&TÖævVE&öf–ÆTF—66÷&DÖW76vR€¢76–væÖVçBÀ¢'&VçFVB ¢“° ¢76–væÖVçG46†ævVBÐ¢76–væÖVçG46†ævVBÇÀ¢F—66÷&D6†ævVC°¢Ð¢Ð ¢–b†76–væÖVçG46†ævVB’°¢v—B6fU&VçFÄ76–væÖVçG2€¢76–væÖVçG0¢“°¢Ð ¢6öç7B7W7FöÖW$76–væÖVçG2Ð¢76–væÖVçG2æf–ÇFW"€¢76–væÖVçBÓà¢76–væÖVç@¢æ7W7FöÖW$66÷VçD–BÓÓÐ¢&Wæ7W7FöÖW$66÷VçBæ–Bb`¢76–væÖVçBæ7F—fRÓÓÐ¢G'VP¢“° ¢6öç7B&W7VÇBÐ¢7W7FöÖW$76–væÖVçG0¢æÖ†76–væÖVçBÓâ°¢6öç7BÖVÖ&W'6†—Ð¢ÖVÖ&W'6†—2æf–æB€¢—FVÒÓà¢—FVÒæ–BÓÓÐ¢76–væÖVç@¢ç&VçFVDÖVÖ&W'6†—–@¢“° ¢–b‚ÖVÖ&W'6†—’°¢&WGW&âçVÆÃ°¢Ð ¢ÆWB7W7FöÖW$6&BÐ¢çVÆÃ° §G'’°¢–b€¢76–væÖVçBæ7W7FöÖW%6V7&WG0¢’°¢6öç7B7W7FöÖW%6V7&WG2Ð¢FV7'—D§6öâ€¢76–væÖVçBæ7W7FöÖW%6V7&WG0¢“° ¢7W7FöÖW$6&BÒ°¢6&DÆ&VÃ ¢7W7FöÖW%6V7&WG2æ6&DÆ&VÂÇÂ""À¢6&F†öÆFW# ¢7W7FöÖW%6V7&WG2æ6&F†öÆFW"ÇÂ""À¢6ô6&DçVÖ&W# ¢7W7FöÖW%6V7&WG2æ6ô6&DçVÖ&W"ÇÂ""À¢W‡ÖöçFƒ ¢7W7FöÖW%6V7&WG2æW‡ÖöçF‚ÇÂ""À¢W‡–V# ¢7W7FöÖW%6V7&WG2æW‡–V"ÇÂ""À¢6V7W&—G”6öFS ¢7W7FöÖW%6V7&WG2ç6V7W&—G”6öFRÇÂ" ¢Ó°¢Ð§Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$7W7FöÖW"&VçFVBÖVÖ&W'6†—6&BFV7'—BW'&÷#¢"À¢76–væÖVçBæ–BÀ¢W'&÷"æÖW76vP¢“°§Ð¢  ¢&WGW&â°¢–C ¢ÖVÖ&W'6†—æ–BÀ ¢76–væÖVçD–C ¢76–væÖVçBæ–BÀ ¢&öf–ÆUG—S ¢'&VçFVB"À ¢&öf–ÆTæÖS ¢ÖVÖ&W'6†—ç&öf–ÆTæÖRÇÀ¢%$TåDTBÔTÔ$U%4„•"À ¢7FGW3 ¢76–væÖVçBæ7F—fF–öå7FGW2ÓÓÐ¢&W‡—&VB ¢ò&W‡—&VB ¢¢&7F—fR"À ¢7F—fS ¢76–væÖVçBæ7F—fF–öå7FGW2ÓÐ¢&W‡—&VB"À ¢7F—fF–öå7FGW3 ¢æ÷&ÖÆ—¦U&öf–ÆT7F—fF–öå7FGW2€¢76–væÖVçBæ7F—fF–öå7FGW2À¢fÇ6P¢’À ¢7F—fF–öäÆ&VÃ ¢&öf–ÆT7F—fF–öäÆ&VÂ€¢æ÷&ÖÆ—¦U&öf–ÆT7F—fF–öå7FGW2€¢76–væÖVçBæ7F—fF–öå7FGW2À¢fÇ6P¢¢’À ¢7F'G4C ¢76–væÖVçBç7F'G4BÇÀ¢çVÆÂÀ ¢W‡—&W4C ¢76–væÖVçBæW‡—&W4BÇÀ¢çVÆÂÀ ¢GW&F–öåG—S ¢76–væÖVçBæGW&F–öåG—RÇÀ¢çVÆÂÀ ¢GW&F–öäÆ&VÃ ¢7V6–Å&öf–ÆTGW&F–öäÆ&VÂ€¢76–væÖVçBæGW&F–öåG—P¢’À ¢F—5&VÖ–æ–æs ¢&VçFÄ76–væÖVçDF—5&VÖ–æ–ær€¢76–væÖVç@¢’À ¢–E7V&Ö—76–öä–C ¢76–væÖVç@¢ç–E7V&Ö—76–öä–BÇÀ¢çVÆÂÀ ¢7G&—U7V'67&—F–öä–C ¢76–væÖVç@¢ç7G&—U7V'67&—F–öä–BÇÀ¢çVÆÂÀ ¢7&VFVDC ¢ÖVÖ&W'6†—æ7&VFVDBÇÀ¢çVÆÂÀ ¢WFFVDC ¢ÖVÖ&W'6†—çWFFVDBÇÀ¢çVÆÂÀ ¦7W7FöÖW%&öf–ÆS ¢76–væÖVçBæ7W7FöÖW%&öf–ÆRÇÀ¢çVÆÂÀ ¦7W7FöÖW$6&BÀ¢Ó°¢Ò¢æf–ÇFW"„&ööÆVâ“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ ¢ÖVÖ&W'6†—3 ¢&W7VÇ@¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$7W7FöÖW"&VçFVBÖVÖ&W'6†—2W'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFòÆöB&VçFVBÖVÖ&W'6†—2â ¢Ò“°¢Ð¢Ð¢“° ¦ævWB€¢"ö’ö66÷VçB÷&WF–ÆW"×&öf–ÆW2"À¢&WV—&T7W7FöÖW"À¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BÆÆ÷væ6RÐ¢v—BvWD7W7FöÖW%&öf–ÆTÆÆ÷væ6R€¢&Wæ7W7FöÖW$66÷VçBæ–@¢“° ¢6öç7B&V6÷&G2Ð¢v—BvWE&WF–ÆW%&öf–ÆW2‚“° ¢6öç7B÷væVE&V6÷&G2Ð¢&V6÷&G0¢æf–ÇFW"€¢&V6÷&BÓà¢&V6÷&Bæ7W7FöÖW$66÷VçD–BÓÓÐ¢&Wæ7W7FöÖW$66÷VçBæ–@¢¢ç6÷'B€¢†Â"’Óà¢çVÖ&W"†ç6Æ÷B’Ð¢çVÖ&W"†"ç6Æ÷B¢“° ¢ ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ ¢ÆÆ÷væ6RÀ ¢&öf–ÆW3 ¢÷væVE&V6÷&G2æÖ€¢&V6÷&BÓà¢6fU&WF–ÆW%&öf–ÆR€¢&V6÷&BÀ¢ÆÆ÷væ6P¢¢’À ¢7V6–Å&öf–ÆW3¢µÐ¢ §Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢%&WF–ÆW"&öf–ÆRÆ—7BW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFòÆöB&WF–ÆW"&öf–ÆW2â ¢Ò“°¢Ð¢Ð¢“° ¦çWB€¢"ö’ö66÷VçB÷&WF–ÆW"×&öf–ÆW2ó§6Æ÷B"À¢&WV—&T7W7FöÖW"À¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B6Æ÷BÐ¢çVÖ&W"€¢&Wç&×2ç6Æ÷@¢“° ¢–b€¢çVÖ&W"æ—4–çFVvW"‡6Æ÷B’ÇÀ¢6Æ÷BÂÇÀ¢6Æ÷BâS ¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$–çfÆ–B&öf–ÆR6Æ÷Bâ ¢Ò“°¢Ð ¢6öç7BÆÆ÷væ6RÐ¢v—BvWD7W7FöÖW%&öf–ÆTÆÆ÷væ6R€¢&Wæ7W7FöÖW$66÷VçBæ–@¢“° ¢–b†ÆÆ÷væ6RÃÒ’°¢&WGW&â&W0¢ç7FGW2ƒC2¢æ§6öâ‡°¢W'&÷# ¢$â7F—fRÖVÖ&W'6†——2&WV—&VB&Vf÷&R&WF–ÆW"&öf–ÆW26â&R6fVBâ ¢Ò“°¢Ð ¢–b‡6Æ÷BâÆÆ÷væ6R’°¢&WGW&â&W0¢ç7FGW2ƒC2¢æ§6öâ‡°¢W'&÷# ¢–÷W"7W'&VçBÖVÖ&W'6†—ÆÆ÷w2G¶ÆÆ÷væ6WÒ&öf–ÆRG¶ÆÆ÷væ6RÓÓÒò""¢'2'Òæ ¢Ò“°¢Ð ¢6öç7B&öf–ÆTæÖRÐ¢6ÆVâ€¢&Wæ&öG“òç&öf–ÆTæÖRÀ¢ƒ ¢“° ¢–b‚&öf–ÆTæÖR’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$VçFW"&öf–ÆRæÖRâ ¢Ò“°¢Ð ¢6öç7B7V&Ö—GFVBÐ¢&Wæ&öG“òç&WF–ÆW'2b`¢G—Vöb&Wæ&öG¢ç&WF–ÆW'2ÓÓÐ¢&ö&¦V7B ¢ò&Wæ&öG’ç&WF–ÆW'0¢¢·Ó° ¢6öç7B&V6÷&G2Ð¢v—BvWE&WF–ÆW%&öf–ÆW2‚“° ¢6öç7BW†—7F–æt–æFW‚Ð¢&V6÷&G2æf–æD–æFW‚€¢&V6÷&BÓà¢&V6÷&Bæ7W7FöÖW$66÷VçD–BÓÓÐ¢&Wæ7W7FöÖW$66÷VçBæ–Bb`¢çVÖ&W"‡&V6÷&Bç6Æ÷B’ÓÓÐ¢6Æ÷@¢“° ¢6öç7BW†—7F–æu&V6÷&BÐ¢W†—7F–æt–æFW‚ãÒ ¢ò&V6÷&G5°¢W†—7F–æt–æFW€¢Ð¢¢çVÆÃ° ¢6öç7B6VÆV7FVDFG&W74–BÐ¢6ÆVâ€¢&Wæ&öG“òç6†—–ætFG&W74–BÀ¢S ¢’ÇÀ¢W†—7F–æu&V6÷&@¢òç6VÆV7FVDFG&W74–BÇÀ¢çVÆÃ° ¢6öç7B6VÆV7FVE–ÖVçD–BÐ¢6ÆVâ€¢&Wæ&öG“òç–ÖVçDÖWF†öD–BÀ¢S ¢’ÇÀ¢W†—7F–æu&V6÷&@¢òç6VÆV7FVE–ÖVçD–BÇÀ¢çVÆÃ° ¢6öç7B6VÆV7FVE6fVDFWF–Ç2Ð¢v—B6fVD6†V6¶÷WE6VÆV7F–öâ€¢&Wæ7W7FöÖW$66÷VçBÀ¢6VÆV7FVDFG&W74–BÀ¢6VÆV7FVE–ÖVçD–@¢“° ¢–b€¢6VÆV7FVDFG&W74–Bb`¢6VÆV7FVE6fVDFWF–Ç2æFG&W70¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢%F†R6VÆV7FVB6fVB6†—–ærFG&W726÷VÆBæ÷B&Rf÷VæBâ ¢Ò“°¢Ð ¢–b€¢6VÆV7FVE–ÖVçD–Bb`¢6VÆV7FVE6fVDFWF–Ç2ç–ÖVç@¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢%F†R6VÆV7FVB6fVB–ÖVçB6&B6÷VÆBæ÷B&Rf÷VæBâ ¢Ò“°¢Ð ¢ÆWBW†—7F–æt7W7FöÖW%6V7&WG2Ò·Ó° ¢G'’°¢–b€¢W†—7F–æu&V6÷&@¢òæ7W7FöÖW%6V7&WG0¢’°¢W†—7F–æt7W7FöÖW%6V7&WG2Ð¢FV7'—D§6öâ€¢W†—7F–æu&V6÷&@¢æ7W7FöÖW%6V7&WG0¢’ÇÂ·Ó°¢Ð¢Ò6F6‚°¢W†—7F–æt7W7FöÖW%6V7&WG2Ò·Ó°¢Ð ¢6öç7B6fVE&öf–ÆT&6RÐ¢6†—–æu&öf–ÆTg&öÕ6fVDFG&W72€¢6VÆV7FVE6fVDFWF–Ç2æFG&W72À¢&Wæ7W7FöÖW$66÷VçBæVÖ–ÂÀ¢W†—7F–æu&V6÷&@¢òæ7W7FöÖW%&öf–ÆRÇÀ¢·Ð¢“° ¢6öç7B7V&Ö—GFVD7W7FöÖW%&öf–ÆRÐ¢&Wæ&öG¢òæ7W7FöÖW%&öf–ÆRb`¢G—Vöb&Wæ&öG¢æ7W7FöÖW%&öf–ÆRÓÓÐ¢&ö&¦V7B ¢ò&Wæ&öG¢æ7W7FöÖW%&öf–ÆP¢¢·Ó° ¢6öç7B7W7FöÖW%&öf–ÆRÐ¢6æ—F—¦U&öf–ÆR‡°¢ââç6fVE&öf–ÆT&6RÀ¢ââç7V&Ö—GFVD7W7FöÖW%&öf–ÆRÀ ¢&öf–ÆTæÖRÀ ¢VÖ–Ã ¢7V&Ö—GFVD7W7FöÖW%&öf–ÆP¢æVÖ–ÂÇÀ¢6fVE&öf–ÆT&6RæVÖ–ÂÇÀ¢&Wæ7W7FöÖW$66÷Vç@¢æVÖ–ÂÇÀ¢" ¢Ò“° ¢6öç7B6fVD6&D&6RÐ¢–ÖVçE6V7&WG4g&öÕ6fVE–ÖVçB€¢6VÆV7FVE6fVDFWF–Ç2ç–ÖVçBÀ¢W†—7F–æt7W7FöÖW%6V7&WG0¢“° ¢6öç7B7V&Ö—GFVD7W7FöÖW$6&BÐ¢&Wæ&öG¢òæ7W7FöÖW$6&Bb`¢G—Vöb&Wæ&öG¢æ7W7FöÖW$6&BÓÓÐ¢&ö&¦V7B ¢ò&Wæ&öG¢æ7W7FöÖW$6&@¢¢·Ó° ¢6öç7B7WÆ–VD6&DçVÖ&W"Ð¢6ÆVâ€¢7V&Ö—GFVD7W7FöÖW$6&@¢æ6ô6&DçVÖ&W"À¢3 ¢’ç&WÆ6R€¢õµåÆEÒörÀ¢" ¢“° ¢6öç7B7WÆ–VE6V7W&—G”6öFRÐ¢6ÆVâ€¢7V&Ö—GFVD7W7FöÖW$6&@¢ç6V7W&—G”6öFRÀ¢3 ¢“° ¢6öç7B7W7FöÖW%6V7&WG2Ò°¢ââç6fVD6&D&6RÀ ¢6&DÆ&VÃ ¢6ÆVâ€¢7V&Ö—GFVD7W7FöÖW$6&@¢æ6&DÆ&VÂÀ¢ ¢’ÇÀ¢6fVD6&D&6P¢æ6&DÆ&VÂÇÀ¢""À ¢6&F†öÆFW# ¢6ÆVâ€¢7V&Ö—GFVD7W7FöÖW$6&@¢æ6&F†öÆFW"À¢S ¢’ÇÀ¢6fVD6&D&6P¢æ6&F†öÆFW"ÇÀ¢""À ¢6ô6&DçVÖ&W# ¢7WÆ–VD6&DçVÖ&W"ÇÀ¢6fVD6&D&6P¢æ6ô6&DçVÖ&W"ÇÀ¢W†—7F–æt7W7FöÖW%6V7&WG0¢æ6ô6&DçVÖ&W"ÇÀ¢""À ¢W‡ÖöçFƒ ¢6ÆVâ€¢7V&Ö—GFVD7W7FöÖW$6&@¢æW‡ÖöçF‚À¢ ¢’ÇÀ¢6fVD6&D&6P¢æW‡ÖöçF‚ÇÀ¢""À ¢W‡–V# ¢6ÆVâ€¢7V&Ö—GFVD7W7FöÖW$6&@¢æW‡–V"À¢@¢’ÇÀ¢6fVD6&D&6P¢æW‡–V"ÇÀ¢""À ¢6V7W&—G”6öFS ¢7WÆ–VE6V7W&—G”6öFRÇÀ¢6fVD6&D&6P¢ç6V7W&—G”6öFRÇÀ¢W†—7F–æt7W7FöÖW%6V7&WG0¢ç6V7W&—G”6öFRÇÀ¢" ¢Ó° ¢–b€¢7W7FöÖW%6V7&WG0¢æ6ô6&DçVÖ&W"b`¢õåÆG³"Ã—ÒBòçFW7B€¢7W7FöÖW%6V7&WG0¢æ6ô6&DçVÖ&W ¢¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$VçFW"fÆ–B6&BçVÖ&W"f÷"F†—2&öf–ÆRâ ¢Ò“°¢Ð ¢–b€¢7W7FöÖW%6V7&WG0¢æW‡ÖöçF‚b`¢õâƒ³Ó•×Ã³Ó%Ò’BòçFW7B€¢7W7FöÖW%6V7&WG0¢æW‡ÖöçF€¢¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$VçFW"fÆ–BW‡—&F–öâÖöçF‚â ¢Ò“¶Ú±î¸Â¸­yêë¢°k¢G§¦*^
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
  return res.json({ memberships: recom«ëŒ+Š×ž®º+º$zzb¥ç&G2Ò“°§Ò“° ¦ævWB‚"ö’öFÖ–âöv–gF&ÆRÖ7W7FöÖW'2"Â&WV—&TFÖ–âÂ7–æ2‡&WÂ&W2’Óâ°¢6öç7B7W7FöÖW'2Òv—BvWD7W7FöÖW$66÷VçG2‚“°¢&WGW&â&W2æ§6öâ‡²7W7FöÖW'3¢7W7FöÖW'2æÖ†—FVÒÓâ‡²–C¢—FVÒæ–BÂVÖ–Ã¢—FVÒæVÖ–ÂÒ’’æf–ÇFW"†—FVÒÓâ—FVÒæ–Bbb—FVÒæVÖ–Â’Ò“°§Ò“° ¦ç÷7B‚"ö’öFÖ–âöv–gFVBÖÖVÖ&W'6†—2"Â&WV—&TFÖ–âÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B7W7FöÖW$66÷VçD–BÒ7G&–ær‡&Wæ&öG“òæ7W7FöÖW$66÷VçD–BÇÂ""’çG&–Ò‚“°¢6öç7BF–W"ÒçVÖ&W"‡&Wæ&öG“òçF–W"“°¢6öç7BÖöçF‡2ÒçVÖ&W"‡&Wæ&öG“òæÖöçF‡2“°¢–b‚7W7FöÖW$66÷VçD–BÇÂÄå5·F–W%ÒÇÂçVÖ&W"æ—4–çFVvW"†ÖöçF‡2’ÇÂÖöçF‡2ÂÇÂÖöçF‡2â"’°¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²W'&÷#¢$6†ö÷6R7W7FöÖW"ÂfÆ–BF–W"ÂæBGW&F–öâg&öÒFò"ÖöçF‡2â"Ò“°¢Ð¢6öç7B7W7FöÖW'2Òv—BvWD7W7FöÖW$66÷VçG2‚“°¢6öç7B7W7FöÖW"Ò7W7FöÖW'2æf–æB†—FVÒÓâ7G&–ær†—FVÒæ–B’ÓÓÒ7W7FöÖW$66÷VçD–B“°¢–b‚7W7FöÖW"’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²W'&÷#¢$7W7FöÖW"66÷VçBv2æ÷Bf÷VæBâ"Ò“° ¢6öç7B–BÒv—B&VD§6öâ…”Eôd”ÄRÂµÒ“°¢6öç7B7F—fU–BÒ„'&’æ—4'&’‡–B’ò–B¢µÒ¢æf–ÇFW"†—FVÒÓâ7G&–ær†—FVÒæ7W7FöÖW$66÷VçD–B’ÓÓÒ7W7FöÖW$66÷VçD–Bbb7V'67&—F–öäÆÆ÷w5&öf–ÆW2†—FVÒ’“°¢6öç7B–DVæBÒ7F—fU–@¢æÖ†—FVÒÓâ7V'67&—F–öäVæD—6ò†—FVÒ’¢æf–ÇFW"„&ööÆVâ¢æÖ‡fÇVRÓâæWrFFR‡fÇVR’ævWEF–ÖR‚’¢æf–ÇFW"„çVÖ&W"æ—4f–æ—FR¢ç&VGV6R‚†Ö‚ÂfÇVR’ÓâÖF‚æÖ‚†Ö‚ÂfÇVR’ÂFFRææ÷r‚’“°¢6öç7B&V6÷&G2Òv—BvWDv–gFVDÖVÖ&W'6†—2‚“°¢6öç7B&–÷$v–gDVæBÒ&V6÷&G0¢æf–ÇFW"†—FVÒÓâ7G&–ær†—FVÒæ7W7FöÖW$66÷VçD–B’ÓÓÒ7W7FöÖW$66÷VçD–B¢æÖ†—FVÒÓâæWrFFR†—FVÒæW‡—&W4B’ævWEF–ÖR‚’¢æf–ÇFW"„çVÖ&W"æ—4f–æ—FR¢ç&VGV6R‚†Ö‚ÂfÇVR’ÓâÖF‚æÖ‚†Ö‚ÂfÇVR’ÂFFRææ÷r‚’“°¢6öç7B7F'DFFRÒæWrFFR„ÖF‚æÖ‚„FFRææ÷r‚’Â–DVæBÂ&–÷$v–gDVæB’“°¢6öç7B7F'G4BÒ7F'DFFRçFô•4õ7G&–ær‚“°¢6öç7BVæDFFRÒæWrFFR‡7F'DFFR“°¢VæDFFRç6WEUD4ÖöçF‚†VæDFFRævWEUD4ÖöçF‚‚’²ÖöçF‡2“°¢6öç7BW‡—&W4BÒVæDFFRçFô•4õ7G&–ær‚“°¢6öç7Bw&çBÒ°¢–C¢7'—Fòç&æFöÕUT”B‚’À¢7W7FöÖW$66÷VçD–BÀ¢7W7FöÖW$VÖ–Ã¢7W7FöÖW"æVÖ–ÂÇÂ""À¢F–W"À¢F–W$æÖS¢Äå5·F–W%ÒææÖRÀ¢&öf–ÆW3¢Äå5·F–W%Òç&öf–ÆW2À¢ÖöçF‡2À¢7F'G4BÀ¢W‡—&W4BÀ¢7&VFVDC¢æWrFFR‚’çFô•4õ7G&–ær‚’À¢7&VFVD'“¢&FÖ–â ¢Ó°¢&V6÷&G2çW6‚†w&çB“°¢v—B6fTv–gFVDÖVÖ&W'6†—2‡&V6÷&G2“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²ö³¢G'VRÂÖVÖ&W'6†—¢w&çBÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚$v–gFVBÖVÖ&W'6†—7&VF–öâf–ÆVC¢"ÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²W'&÷#¢%Væ&ÆRFò7&VFRv–gFVBÖVÖ&W'6†—â"Ò“°¢Ð§Ò“° ¦æFVÆWFR‚"ö’öFÖ–âöv–gFVBÖÖVÖ&W'6†—2ó¦–B"Â&WV—&TFÖ–âÂ7–æ2‡&WÂ&W2’Óâ°¢6öç7B&V6÷&G2Òv—BvWDv–gFVDÖVÖ&W'6†—2‚“°¢6öç7BæW‡BÒ&V6÷&G2æf–ÇFW"†—FVÒÓâ7G&–ær†—FVÒæ–B’ÓÒ7G&–ær‡&Wç&×2æ–B’“°¢–b†æW‡BæÆVæwF‚ÓÓÒ&V6÷&G2æÆVæwF‚’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²W'&÷#¢$v–gFVBÖVÖ&W'6†—v2æ÷Bf÷VæBâ"Ò“°¢v—B6fTv–gFVDÖVÖ&W'6†—2†æW‡B“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÒ“°§Ò“° ¦ævWB‚"ö’öFÖ–âöF—66÷VçBÖ6öFW2"Â&WV—&TFÖ–âÂ7–æ2‡&WÂ&W2’Óâ°¢&WGW&â&W2æ§6öâ‡²6öFW3¢v—BvWDF—66÷VçD6öFW2‚’Ò“°§Ò“° ¦ç÷7B‚"ö’öFÖ–âöF—66÷VçBÖ6öFW2"Â&WV—&TFÖ–âÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B6öFRÒ7G&–ær‡&Wæ&öG“òæ6öFRÇÂ""’çG&–Ò‚’çFõWW$66R‚“°¢6öç7BW&6VçBÒçVÖ&W"‡&Wæ&öG“òçW&6VçB“°¢6öç7BF–W"Ò&Wæ&öG“òçF–W"ÓÓÒ&ÆÂ"ÇÂ&Wæ&öG“òçF–W"ÓÓÒ""ÇÂ&Wæ&öG“òçF–W"ÓÒçVÆÂò&ÆÂ"¢çVÖ&W"‡&Wæ&öG’çF–W"“°¢6öç7BÆ–W5Fõ&VçFÇ2Ò&Wæ&öG“òæÆ–W5Fõ&VçFÇ2ÓÓÒG'VS°¢6öç7BGW&F–öâÒ&Wæ&öG“òæGW&F–öâÓÓÒ&f÷&WfW""ò&f÷&WfW""¢&öæ6R#°¢6öç7BW‡—&F–öâÒ&Wæ&öG“òæW‡—&W4BòæWrFFR‡&Wæ&öG’æW‡—&W4B’¢çVÆÃ°¢–b‚õå´Õ£Ó•×³2ÃCÒBòçFW7B†6öFR’ÇÂçVÖ&W"æ—4–çFVvW"‡W&6VçB’ÇÂW&6VçBÂÇÂW&6VçBâÇÀ¢‡F–W"ÓÒ&ÆÂ"bbÄå5·F–W%Ò’ÇÂ†W‡—&F–öâbb‚çVÖ&W"æ—4f–æ—FR†W‡—&F–öâævWEF–ÖR‚’’ÇÂW‡—&F–öâævWEF–ÖR‚’ÃÒFFRææ÷r‚’’’’°¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²W'&÷#¢%&÷f–FRfÆ–B6öFRÂF—66÷VçBW&6VçFvRÂF–W"æBgWGW&RW‡—&F–öââ"Ò“°¢Ð¢–b‚&ö6W72æVçbå5E$•Uõ4T5$UEô´U’’&WGW&â&W2ç7FGW2ƒS2’æ§6öâ‡²W'&÷#¢%7G&—R—2æ÷B6öæf–wW&VBâ"Ò“°¢6öç7B&V6÷&G2Òv—BvWDF—66÷VçD6öFW2‚“°¢–b‡&V6÷&G2ç6öÖR†—FVÒÓâ—FVÒæ6öFRÓÓÒ6öFR’’&WGW&â&W2ç7FGW2ƒC’’æ§6öâ‡²W'&÷#¢%F†BF—66÷VçB6öFRÇ&VG’W†—7G2â"Ò“°¢6öç7B&–6T–G2Ò°¢âââ‡F–W"ÓÓÒ&ÆÂ"òö&¦V7BçfÇVW2…Äå2’æÖ‡ÆâÓâÆâç&–6T–B’¢µÄå5·F–W%Òç&–6T–EÒ’À¢âââ†Æ–W5Fõ&VçFÇ2òö&¦V7BçfÇVW2…$TåDÅõ4´tU2’æfÆDÖ‡6¶vW2Óâö&¦V7BçfÇVW2‡6¶vW2’æÖ‡6²Óâ6²ç&–6T–B’’¢µÒ¢Òæf–ÇFW"„&ööÆVâ“°¢–b‚&–6T–G2æÆVæwF‚’&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²W'&÷#¢$æò7G&—R&–6W2&R6öæf–wW&VBf÷"F†—26VÆV7F–öââ"Ò“°¢6öç7B&–6W2Òv—B&öÖ—6RæÆÂ…²ââææWr6WB‡&–6T–G2•ÒæÖ†–BÓâ7G&—Rç&–6W2ç&WG&–WfR†–B’’“°¢6öç7B&öGV7D–G2Ò²ââææWr6WB‡&–6W2æÖ‡&–6RÓâG—Vöb&–6Rç&öGV7BÓÓÒ'7G&–ær"ò&–6Rç&öGV7B¢&–6Rç&öGV7Còæ–B’æf–ÇFW"„&ööÆVâ’•Ó°¢6öç7B6÷WöâÒv—B7G&—Ræ6÷Wöç2æ7&VFR‡°¢W&6VçEööfc¢W&6VçBÀ¢GW&F–öâÀ¢Æ–W5÷Fó¢²&öGV7G3¢&öGV7D–G2ÒÀ¢æÖS¢4Ä%4äu$%44òG¶6öFWÖ ¢Ò“°¢6öç7B&öÖ÷F–öâÒv—B7G&—Rç&öÖ÷F–öä6öFW2æ7&VFR‡°¢6÷Wöã¢6÷Wöâæ–BÀ¢6öFRÀ¢âââ†W‡—&F–öâò²W‡—&W5öC¢ÖF‚æfÆö÷"†W‡—&F–öâævWEF–ÖR‚’ò’Ò¢·Ò¢Ò“°¢6öç7BF—66÷VçBÒ°¢–C¢7'—Fòç&æFöÕUT”B‚’Â6öFRÂW&6VçBÂF–W"ÂÆ–W5Fõ&VçFÇ2ÂGW&F–öâÀ¢W‡—&W4C¢W‡—&F–öãòçFô•4õ7G&–ær‚’ÇÂçVÆÂÀ¢7F—fS¢G'VRÂ7G&—T6÷Wöä–C¢6÷Wöâæ–BÂ7G&—U&öÖ÷F–öä6öFT–C¢&öÖ÷F–öâæ–BÀ¢7&VFVDC¢æWrFFR‚’çFô•4õ7G&–ær‚¢Ó°¢&V6÷&G2çW6‚†F—66÷VçB“°¢v—B6fTF—66÷VçD6öFW2‡&V6÷&G2“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²ö³¢G'VRÂF—66÷VçBÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚$F—66÷VçB6öFR7&VF–öâf–ÆVC¢"ÂW'&÷#òæÖW76vR“°¢&WGW&â&W2ç7FGW2ƒS"’æ§6öâ‡²W'&÷#¢$6÷VÆBæ÷B7&VFRF†—2&öÖ÷F–öâ6öFR–â7G&—Râ"Ò“°¢Ð§Ò“° ¦çF6‚‚"ö’öFÖ–âöF—66÷VçBÖ6öFW2ó¦–B"Â&WV—&TFÖ–âÂ7–æ2‡&WÂ&W2’Óâ°¢6öç7B&V6÷&G2Òv—BvWDF—66÷VçD6öFW2‚“°¢6öç7B—FVÒÒ&V6÷&G2æf–æB‡&V6÷&BÓâ7G&–ær‡&V6÷&Bæ–B’ÓÓÒ7G&–ær‡&Wç&×2æ–B’“°¢–b‚—FVÒ’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²W'&÷#¢$F—66÷VçB6öFRv2æ÷Bf÷VæBâ"Ò“°¢–b‡G—Vöb&Wæ&öG“òæ7F—fRÓÒ&&ööÆVâ"’&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²W'&÷#¢$6†ö÷6R7F—fR÷"–æ7F—fRâ"Ò“°¢G'’°¢–b†—FVÒç7G&—U&öÖ÷F–öä6öFT–B’v—B7G&—Rç&öÖ÷F–öä6öFW2çWFFR†—FVÒç7G&—U&öÖ÷F–öä6öFT–BÂ²7F—fS¢&Wæ&öG’æ7F—fRÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚%7G&—R&öÖ÷F–öâ6öFRWFFRf–ÆVC¢"ÂW'&÷#òæÖW76vR“°¢&WGW&â&W2ç7FGW2ƒS"’æ§6öâ‡²W'&÷#¢$6÷VÆBæ÷BWFFRF†—2&öÖ÷F–öâ6öFR–â7G&—Râ"Ò“°¢Ð¢—FVÒæ7F—fRÒ&Wæ&öG’æ7F—fS°¢v—B6fTF—66÷VçD6öFW2‡&V6÷&G2“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂF—66÷VçC¢—FVÒÒ“°§Ò“° ¢ò¢öæR&öÖ–æVçBææ÷Væ6VÖVçBBF–ÖRÂf—6–&ÆRF‡&÷Vv†÷WBF†RV&Æ–26—FRâ¢ð¦7–æ2gVæ7F–öâvWE6—FTæ÷F–f–6F–öâ‚’°¢6öç7B&V6÷&BÒv—B&VD§6öâ…4•DUôäõD”d”4D”ôåôd”ÄRÂçVÆÂ“°¢&WGW&â&V6÷&BbbG—Vöb&V6÷&BÓÓÒ&ö&¦V7B"bb'&’æ—4'&’‡&V6÷&B’ò&V6÷&B¢çVÆÃ°§Ð ¦6öç7B6—FTæ÷F–f–6F–öäÆ—7FVæW'2ÒæWr6WB‚“°¦ævWB‚"ö’÷V&Æ–2öæ÷F–f–6F–öâöWfVçG2"Â‡&WÂ&W2’Óâ°¢÷Vå7V66W74WfVçE7G&VÒ‡&WÂ&W2Â6—FTæ÷F–f–6F–öäÆ—7FVæW'2“°§Ò“°¦gVæ7F–öâææ÷Væ6U6—FTæ÷F–f–6F–öä6†ævVB‚’°¢f÷"†6öç7BÆ—7FVæW"öb6—FTæ÷F–f–6F–öäÆ—7FVæW'2’°¢Æ—7FVæW"çw&—FR‚&WfVçC¢æ÷F–f–6F–öåÆæFF¢·ÕÆåÆâ"“°¢Ð§Ð ¦ævWB‚"ö’÷V&Æ–2öæ÷F–f–6F–öâ"Â7–æ2‡&WÂ&W2’Óâ°¢&W2ç6WD†VFW"‚$66†RÔ6öçG&öÂ"Â&æò×7F÷&R"“°¢G'’°¢6öç7B&V6÷&BÒv—BvWE6—FTæ÷F–f–6F–öâ‚“°¢6öç7B66÷VçBÒ&V6÷&Còæ7F—fRÓÓÒG'VRòv—BvWDWF†VçF–6FVD7W7FöÖW"‡&W’¢çVÆÃ°¢6öç7BF—6Ö—76VBÒ66÷VçBbb'&’æ—4'&’†66÷VçBæF—6Ö—76VE6—FTæ÷F–f–6F–öç2¢ò66÷VçBæF—6Ö—76VE6—FTæ÷F–f–6F–öç2æ–æ6ÇVFW2‡&V6÷&Bæ–B¢¢fÇ6S°¢&WGW&â&W2æ§6öâ‡²æ÷F–f–6F–öã¢&V6÷&Còæ7F—fRÓÓÒG'VP¢ò²–C¢&V6÷&Bæ–BÂF—FÆS¢&V6÷&BçF—FÆRÂÖW76vS¢&V6÷&BæÖW76vRÂ7&VFVDC¢&V6÷&Bæ7&VFVDBÐ¢¢çVÆÂÂF—6Ö—76VBÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚%V&Æ–2æ÷F–f–6F–öâ&VBf–ÆVC¢"ÂW'&÷#òæÖW76vR“°¢&WGW&â&W2ç7FGW2ƒS2’æ§6öâ‡²W'&÷#¢$æ÷F–f–6F–öâVæf–Æ&ÆRâ"Ò“°¢Ð§Ò“° ¦ævWB‚"ö’öFÖ–â÷6—FRÖæ÷F–f–6F–öâ"Â&WV—&TFÖ–âÂ7–æ2…÷&WÂ&W2’Óâ°¢&WGW&â&W2æ§6öâ‡²æ÷F–f–6F–öã¢v—BvWE6—FTæ÷F–f–6F–öâ‚’Ò“°§Ò“° ¦ç÷7B‚"ö’öFÖ–â÷6—FRÖæ÷F–f–6F–öâ"Â&WV—&TFÖ–âÂ7–æ2‡&WÂ&W2’Óâ°¢6öç7BF—FÆRÒ6ÆVâ‡&Wæ&öG“òçF—FÆRÂƒ“°¢6öç7BÖW76vRÒ6ÆVâ‡&Wæ&öG“òæÖW76vRÂC“°¢–b‚F—FÆRÇÂÖW76vR’°¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²W'&÷#¢$FBF—FÆRæBæ÷F–f–6F–öâÖW76vRâ"Ò“°¢Ð¢G'’°¢6öç7Bæ÷F–f–6F–öâÒ°¢–C¢7'—Fòç&æFöÕUT”B‚’ÂF—FÆRÂÖW76vRÀ¢7F—fS¢G'VRÂ7&VFVDC¢æWrFFR‚’çFô•4õ7G&–ær‚¢Ó°¢v—Bw&—FT§6öâ…4•DUôäõD”d”4D”ôåôd”ÄRÂæ÷F–f–6F–öâ“°¢ææ÷Væ6U6—FTæ÷F–f–6F–öä6†ævVB‚“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²ö³¢G'VRÂæ÷F–f–6F–öâÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚%V&Æ—6‚æ÷F–f–6F–öâf–ÆVC¢"ÂW'&÷#òæÖW76vR“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²W'&÷#¢$6÷VÆBæ÷BV&Æ—6‚F†Ræ÷F–f–6F–öââ"Ò“°¢Ð§Ò“° ¦ç÷7B‚"ö’öFÖ–â÷6—FRÖæ÷F–f–6F–öâó¦–B÷&WG&7B"Â&WV—&TFÖ–âÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B&V6÷&BÒv—BvWE6—FTæ÷F–f–6F–öâ‚“°¢–b‚&V6÷&BÇÂ&V6÷&Bæ–BÓÒ&Wç&×2æ–BÇÂ&V6÷&Bæ7F—fRÓÒG'VR’°¢&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²W'&÷#¢%F†—2æ÷F–f–6F–öâ—2æòÆöævW"7F—fRâ"Ò“°¢Ð¢6öç7Bæ÷F–f–6F–öâÒ²ââç&V6÷&BÂ7F—fS¢fÇ6RÂ&WG&7FVDC¢æWrFFR‚’çFô•4õ7G&–ær‚’Ó°¢v—Bw&—FT§6öâ…4•DUôäõD”d”4D”ôåôd”ÄRÂæ÷F–f–6F–öâ“°¢ææ÷Væ6U6—FTæ÷F–f–6F–öä6†ævVB‚“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂæ÷F–f–6F–öâÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚%&WG&7Bæ÷F–f–6F–öâf–ÆVC¢"ÂW'&÷#òæÖW76vR“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²W'&÷#¢$6÷VÆBæ÷B&WG&7BF†Ræ÷F–f–6F–öââ"Ò“°¢Ð§Ò“° ¦ç÷7B‚"ö’ö66÷VçB÷6—FRÖæ÷F–f–6F–öâó¦–BöF—6Ö—72"Â&WV—&T7W7FöÖW"Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7Bæ÷F–f–6F–öâÒv—BvWE6—FTæ÷F–f–6F–öâ‚“°¢–b‚æ÷F–f–6F–öâÇÂæ÷F–f–6F–öâæ7F—fRÓÒG'VRÇÂæ÷F–f–6F–öâæ–BÓÒ&Wç&×2æ–B’°¢&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²W'&÷#¢$æ÷F–f–6F–öâ—2æòÆöævW"7F—fRâ"Ò“°¢Ð¢6öç7B66÷VçG2Òv—BvWD7W7FöÖW$66÷VçG2‚“°¢6öç7B66÷VçBÒ66÷VçG2æf–æB†—FVÒÓâ7G&–ær†—FVÒæ–B’ÓÓÒ7G&–ær‡&Wæ7W7FöÖW$66÷VçBæ–B’“°¢–b‚66÷VçB’&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²W'&÷#¢%ÆV6R6–vâ–âv–ââ"Ò“°¢6öç7BF—6Ö—76VBÒ'&’æ—4'&’†66÷VçBæF—6Ö—76VE6—FTæ÷F–f–6F–öç2’ò66÷VçBæF—6Ö—76VE6—FTæ÷F–f–6F–öç2¢µÓ°¢66÷VçBæF—6Ö—76VE6—FTæ÷F–f–6F–öç2Ò²ââææWr6WB…²ââæF—6Ö—76VBÂæ÷F–f–6F–öâæ–EÒ•Òç6Æ–6R‚ÓS“°¢v—B6fT7W7FöÖW$66÷VçG2†66÷VçG2“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚$F—6Ö—72æ÷F–f–6F–öâf–ÆVC¢"ÂW'&÷#òæÖW76vR“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²W'&÷#¢$6÷VÆBæ÷B6fRæ÷F–f–6F–öâF—6Ö—76Ââ"Ò“°¢Ð§Ò“° ¦ævWB€¢"ö’öFÖ–â÷7V&Ö—76–öç2"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7B&V6÷&G2Ð¢'&’æ—4'&’‡–B¢ò–@¢¢µÓ° ¢6öç7B&W7VÇBÒµÓ°¢6öç7B7W7FöÖW$66÷VçG2Òv—BvWD7W7FöÖW$66÷VçG2‚“°¢6öç7B7W7FöÖW$66÷VçDÖÒæWrÖ†7W7FöÖW$66÷VçG2æÖ†66÷VçBÓâµ7G&–ær†66÷VçBæ–B’Â66÷VçEÒ’“° ¢ÆWB–D6†ævVBÐ¢fÇ6S° ¢6öç7B°¢g&VT76–væÖVçG4f÷$FÖ–âÀ¢&VçFÄ76–væÖVçG4f÷$FÖ–à¢ÒÒv—B&öÖ—6RæÆÂ…°¢vWDg&VT76–væÖVçG2‚’À¢vWE&VçFÄ76–væÖVçG2‚¢Ò“° ¢f÷"€¢6öç7B&V6÷&Böb&V6÷&G0¢’° ¢ò ¢&Vg&W6‚7G&—R7V'67&—F–öâ–æf÷&ÖF–öà¢&Vf÷&R&WGW&æ–ærF†RFÖ–âF6†&ö&Bà ¢F†—2¶VW3 ¢Ò7F—fRò–æ7F—fR7FGW0¢Ò7W'&VçBW&–öB7F'@¢Ò7W'&VçBW&–öBVæ@¢Ò6æ6VÂ7FFP¢ÒWw&FVBÆà¢7–æ6‡&öæ—¦VBv—F‚7G&—Rà¢¢ð ¢–b€¢&V6÷&Bç7G&—U7V'67&—F–öä–Bb`¢&V6÷&Bç7G&—U6W76–öä–@¢’° ¢G'’° ¢6öç7B6†V6¶÷WE6W76–öâÐ¢v—B7G&—Ræ6†V6¶÷WBç6W76–öç2ç&WG&–WfR€¢&V6÷&Bç7G&—U6W76–öä–@¢“° ¢–b†6†V6¶÷WE6W76–öâç7V'67&—F–öâ’° ¢&V6÷&Bç7G&—U7V'67&—F–öä–BÐ¢G—Vöb6†V6¶÷WE6W76–öâç7V'67&—F–öâÓÓÒ'7G&–ær ¢ò6†V6¶÷WE6W76–öâç7V'67&—F–öà¢¢6†V6¶÷WE6W76–öâç7V'67&—F–öâæ–C° ¢–D6†ævVBÒG'VS°¢Ð ¢Ò6F6‚†W'&÷"’° ¢6öç6öÆRæW'&÷"€¢$FÖ–â7V'67&—F–öâ”B&V6÷fW'’f–ÆVC¢"À¢&V6÷&Bæ–BÀ¢W'&÷"æÖW76vP¢“° ¢Ð§Ð  ¦–b€¢&V6÷&Bç7G&—U7V'67&—F–öä–@¢’°  ¢G'’° ¢6öç7B7V'67&—F–öâÐ¢v—B7G&—P¢ç7V'67&—F–öç0¢ç&WG&–WfR€¢&V6÷&Bç7G&—U7V'67&—F–öä–@¢“° ¢v—BÇ•7V'67&—F–öä–æfò€¢&V6÷&BÀ¢7V'67&—F–öà¢“° ¢&V6÷&Bç7V'67&—F–öåWFFVDBÐ¢æWrFFR‚’çFô•4õ7G&–ær‚“° ¢–D6†ævVBÒG'VS° ¢Ò6F6‚†W'&÷"’° ¢6öç6öÆRæW'&÷"€¢$FÖ–â7V'67&—F–öâ&Vg&W6‚f–ÆVC¢"À¢&V6÷&Bæ–BÀ¢W'&÷"æÖW76vP¢“° ¢Ð§Ð¢ÆWB6V7&WG2Ð¢çVÆÃ°¢G'’°¢6öç7BVæ7'—FVBÐ¢v—B&VD§6öâ€¢F‚æ¦ö–â€¢4T5$UEôD•"À¢G·&V6÷&Bæ–GÒæVæ7'—FVBæ§6öæ ¢’À¢çVÆÀ¢“° ¢–b†Væ7'—FVB’°¢6V7&WG2Ð¢FV7'—D§6öâ€¢Væ7'—FV@¢“°¢Ð ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$FÖ–â6V7W&R6¶vRFV7'—BW'&÷#¢"À¢&V6÷&Bæ–BÀ¢W'&÷"æÖW76vP¢“°¢Ð  ¢6öç7BÆ–æ¶VD76–væÖVçG4f÷$7W7FöÖW"Ð¢&V6÷&Bæ7W7FöÖW$66÷VçD–@¢ò°¢ââæg&VT76–væÖVçG4f÷$FÖ–âæf–ÇFW"€¢76–væÖVçBÓà¢7G&–ær€¢76–væÖVçBæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢’ÓÓÐ¢7G&–ær€¢&V6÷&Bæ7W7FöÖW$66÷VçD–@¢’b`¢ÖævVD76–væÖVçD—4Æ–æ¶VB€¢76–væÖVç@¢¢’À ¢ââç&VçFÄ76–væÖVçG4f÷$FÖ–âæf–ÇFW"€¢76–væÖVçBÓà¢7G&–ær€¢76–væÖVçBæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢’ÓÓÐ¢7G&–ær€¢&V6÷&Bæ7W7FöÖW$66÷VçD–@¢’b`¢ÖævVD76–væÖVçD—4Æ–æ¶VB€¢76–væÖVç@¢¢¢Ð¢¢µÓ° ¢6öç7BÆ–æ¶VE&öf–ÆT6÷VçBÐ¢Æ–æ¶VD76–væÖVçG4f÷$7W7FöÖW ¢æÆVæwFƒ° ¢6öç7BÆ–æ¶VD7F—fU&öf–ÆT6÷VçBÐ¢Æ–æ¶VD76–væÖVçG4f÷$7W7FöÖW ¢æf–ÇFW"€¢76–væÖVçBÓà¢ÖævVD76–væÖVçE7FGW2€¢76–væÖVç@¢’ÓÓÐ¢&7F—fFVB ¢¢æÆVæwFƒ° ¢ò ¢Ö–â7W7FöÖW"Ö6&B&–æ7F—fR"6÷VçB–çFVçF–öæÆÇ’–æ6ÇVFW0¢&÷F‚v—F–ær7F—fF–öâæB–æ7F—fR&öf–ÆW2âF†RFWF–ÆV@¢ÖævVB&öf–ÆR&÷r7F–ÆÂF—7F–æwV—6†W2F†÷6RGvò7FGW6W2à¢¢ð¢6öç7BÆ–æ¶VD–æ7F—fU&öf–ÆT6÷VçBÐ¢ÖF‚æÖ‚€¢À¢Æ–æ¶VE&öf–ÆT6÷VçBÐ¢Æ–æ¶VD7F—fU&öf–ÆT6÷Vç@¢“° ¢6öç7B–E&öf–ÆT6÷VçBÐ¢ÖF‚æÖ‚€¢À¢çVÖ&W"€¢&V6÷&BçÆãòç&öf–ÆW2ÇÀ¢ ¢’ÇÂ ¢“° ¢6öç7B7W7FöÖW%–E&V6÷&G2Ð¢&V6÷&Bæ7W7FöÖW$66÷VçD–@¢ò&V6÷&G2æf–ÇFW"€¢—FVÒÓà¢7G&–ær€¢—FVÒæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢’ÓÓÐ¢7G&–ær€¢&V6÷&Bæ7W7FöÖW$66÷VçD–@¢¢¢¢·&V6÷&EÓ° ¢6öç7BötÖVÖ&W"Ð¢7W7FöÖW$†4ötÖVÖ&W%7FGW2€¢7W7FöÖW%–E&V6÷&G0¢“° ¢–b€¢ötÖVÖ&W"b`¢&V6÷&BæötÖVÖ&W"ÓÒG'VP¢’°¢&V6÷&BæötÖVÖ&W"Ð¢G'VS° ¢–D6†ævVBÐ¢G'VS°¢Ð ¢&W7VÇBçW6‚‡°¢ââç&V6÷&BÀ ¢7V66W74gVÆÄ†—7F÷'“ ¢7W7FöÖW$66÷VçDÖævWB…7G&–ær‡&V6÷&Bæ7W7FöÖW$66÷VçD–B’“òç7V66W74gVÆÄ†—7F÷'’ÓÓÒG'VRÀ ¢ötÖVÖ&W"À ¢Æ–æ¶VE&öf–ÆT6÷VçBÀ ¢Æ–æ¶VD7F—fU&öf–ÆT6÷VçBÀ ¢Æ–æ¶VD–æ7F—fU&öf–ÆT6÷VçBÀ ¢F÷FÅ&öf–ÆT6÷VçC ¢–E&öf–ÆT6÷VçB°¢Æ–æ¶VE&öf–ÆT6÷VçBÀ ¢6V7&WG3 ¢6V7&WG2ÇÂçVÆÀ¢Ò“°¢Ð  ¢–b€¢–D6†ævV@¢’°¢v—Bw&—FT§6öâ€¢”Eôd”ÄRÀ¢&V6÷&G0¢“°¢Ð  ¢&WGW&â&W2æ§6öâ€¢&W7VÇ@¢“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$FÖ–â7V&Ö—76–öç2W'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFòÆöB7V&Ö—76–öç2â ¢Ò“°¢Ð¢Ð¢“° ¦ævWB€¢"ö’öFÖ–âög&VR×7V&Ö—76–öç2"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B66÷VçG2Ð¢v—BvWD7W7FöÖW$66÷VçG2‚“° ¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7B–E&V6÷&G2Ð¢'&’æ—4'&’‡–B¢ò–@¢¢µÓ° ¢6öç7BÆ–æ¶VD66÷VçD–G2Ð¢æWr6WB€¢–E&V6÷&G0¢æÖ€¢&V6÷&BÓà¢&V6÷&Bæ7W7FöÖW$66÷VçD–@¢¢æf–ÇFW"„&ööÆVâ¢“° ¢6öç7B–DVÖ–Ç2Ð¢æWr6WB€¢–E&V6÷&G0¢æÖ€¢&V6÷&BÓà¢æ÷&ÖÆ—¦TVÖ–Â€¢jÇºã
âµç«®ŠÁ®‰ž˜©x           record.profile?.email
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

     m«ëŒ+Š×ž®º+º$zzb¥â6W76–öç3¢°¢FÖ–ä‡GGöæÇ“ ¢G'VRÀ ¢FÖ–å6ÖU6—FU7G&–7C ¢G'VRÀ ¢FÖ–ä'6öÇWFT†÷W'3 ¢ÖF‚ç&÷VæB€¢DÔ”åõ4U54”ôåôÔ…ôtUôÕ2ð¢3c ¢’À ¢FÖ–ä–FÆT†÷W'3 ¢ÖF‚ç&÷VæB€¢DÔ”åõ4U54”ôåô”DÄUôÕ2ð¢3c ¢’À ¢7W7FöÖW$‡GGöæÇ“ ¢G'VRÀ ¢7W7FöÖW%6ÖU6—FTÆƒ ¢G'VRÀ ¢7W7FöÖW%&Wfö6F–öåfW'6–öã ¢G'VP¢ÒÀ ¢&÷FV7F–öç3¢°¢6ÖT÷&–v–ä×WFF–öç3 ¢G'VRÀ ¢•&FTÆ–Ö—F–æs ¢G'VRÀ ¢FÖ–äÖf ¢7FGW2æFÖ–äÖf6öæf–wW&VBÀ ¢7W7FöÖW%77v÷&DÖ–æ–×VÓ ¢"À ¢Væ7'—FVE6Vç6—F—fU7F÷&vS ¢7FGW2æVæ7'—F–öä¶W”6öæf–wW&VBÀ ¢6V7W&T6öö¶–W3 ¢7FGW2ç6V7W&T6öö¶–W2À ¢VF—DÆövv–æs ¢G'VRÀ ¢6Vç6—F—fTÆöu&VF7F–öã ¢G'VP¢ÒÀ ¢6öæf–wW&F–öã¢°¢&6UW&Ä‡GG3 ¢7FGW2æ&6UW&Ä‡GG2À ¢7W7FöÖW%6W76–öå6V7&WE7G&öæs ¢7FGW2æ7W7FöÖW%6W76–öå6V7&WE7G&öærÀ ¢FÖ–å77v÷&E7G&öæs ¢7FGW2æFÖ–å77v÷&E7G&öærÀ ¢7G&—U6V7&WD6öæf–wW&VC ¢7FGW2ç7G&—U6V7&WD6öæf–wW&VBÀ ¢7G&—UvV&†ööµ6V7&WD6öæf–wW&VC ¢7FGW2ç7G&—UvV&†ööµ6V7&WD6öæf–wW&V@¢Ð¢Ò“°¢Ð¢“°  ¦ævWB€¢"ö’öÖævVBÖf–Æ&–Æ—G’"À¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7Bf–Æ&–Æ—G’Ð¢v—BvWDÖævVDf–Æ&–Æ—G’‚“° ¢&W2ç6WB€¢$66†RÔ6öçG&öÂ"À¢&æò×7F÷&R ¢“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ ¢F&vWC ¢f–Æ&–Æ—G’çF&vWBÀ ¢vÆÖ'C ¢f–Æ&–Æ—G’çvÆÖ'BÀ ¢WFFVDC ¢æWrFFR‚¢çFô•4õ7G&–ær‚¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$ÖævVBf–Æ&–Æ—G’W'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFòÆöB66÷VçBf–Æ&–Æ—G’â ¢Ò“°¢Ð¢Ð¢“°    ¦gVæ7F–öâæ÷&ÖÆ—¦TÖævVEööÅ&WF–ÆW"€¢fÇVP¢’°¢6öç7B&WF–ÆW"Ð¢7G&–ær‡fÇVRÇÂ""¢çG&–Ò‚¢çFôÆ÷vW$66R‚“° ¢&WGW&â°¢'F&vWB"À¢'vÆÖ'B ¢Òæ–æ6ÇVFW2‡&WF–ÆW"¢ò&WF–ÆW ¢¢çVÆÃ°§Ð  ¦gVæ7F–öâ'6TÖævVEööÄ66÷VçG2€¢&p¢’°¢6öç7BÆ–æW2Ð¢7G&–ær‡&rÇÂ""¢ç7Æ—B‚õÇ#õÆâò¢æÖ†Æ–æRÓâÆ–æRçG&–Ò‚’¢æf–ÇFW"„&ööÆVâ“° ¢6öç7B'6VBÒµÓ°¢6öç7B6VVâÒæWr6WB‚“° ¢f÷"€¢ÆWB–æFW‚Ò°¢–æFW‚ÂÆ–æW2æÆVæwFƒ°¢–æFW‚³Ò¢’°¢6öç7BÆ–æRÒÆ–æW5¶–æFW…Ó°¢6öç7B6W&F÷"Ð¢Æ–æRæ–æFW„öb‚#¢"“° ¢–b‡6W&F÷"ÃÒ’°¢6öç7BW'&÷"Ð¢æWrW'&÷"€¢Æ–æRG¶–æFW‚²Ò—2æ÷B–âVÖ–Ã§77v÷&Bf÷&ÖBæ ¢“°¢W'&÷"ç7FGW2ÒC°¢F‡&÷rW'&÷#°¢Ð ¢6öç7BVÖ–ÂÐ¢æ÷&ÖÆ—¦TVÖ–Â€¢Æ–æRç6Æ–6RƒÂ6W&F÷"¢“° ¢6öç7B77v÷&BÐ¢Æ–æRç6Æ–6R‡6W&F÷"²“° ¢–b€¢õåµåÇ4Ò´µåÇ4ÒµÂåµåÇ4Ò²BòçFW7B€¢VÖ–À¢¢’°¢6öç7BW'&÷"Ð¢æWrW'&÷"€¢Æ–æRG¶–æFW‚²Ò†2â–çfÆ–BVÖ–ÂFG&W72æ ¢“°¢W'&÷"ç7FGW2ÒC°¢F‡&÷rW'&÷#°¢Ð ¢–b‚77v÷&B’°¢6öç7BW'&÷"Ð¢æWrW'&÷"€¢Æ–æRG¶–æFW‚²Ò—2Ö—76–ær77v÷&Bæ ¢“°¢W'&÷"ç7FGW2ÒC°¢F‡&÷rW'&÷#°¢Ð ¢–b‡6VVâæ†2†VÖ–Â’’°¢6öç7BW'&÷"Ð¢æWrW'&÷"€¢GWÆ–6FRVÖ–Âf÷VæBöâÆ–æRG¶–æFW‚²Òæ ¢“°¢W'&÷"ç7FGW2ÒC°¢F‡&÷rW'&÷#°¢Ð ¢6VVâæFB†VÖ–Â“°¢'6VBçW6‚‡°¢VÖ–ÂÀ¢77v÷&@¢Ò“°¢Ð ¢&WGW&â'6VC°§Ð  ¦7–æ2gVæ7F–öâÖævVD76–væVD–E6WB‚’°¢6öç7B°¢g&VT76–væÖVçG2À¢&VçFÄ76–væÖVçG0¢ÒÒv—B&öÖ—6RæÆÂ…°¢vWDg&VT76–væÖVçG2‚’À¢vWE&VçFÄ76–væÖVçG2‚¢Ò“° ¢6öç7B–G2ÒæWr6WB‚“° ¢f÷"€¢6öç7B76–væÖVçBö`¢°¢ââæg&VT76–væÖVçG2À¢ââç&VçFÄ76–væÖVçG0¢Ð¢’°¢–b€¢ÖævVD76–væÖVçD—4Æ–æ¶VB€¢76–væÖVç@¢¢’°¢6öç7B–BÐ¢76–væÖVçBæÖævVD66÷VçD–BÇÀ¢76–væÖVçBæg&VTÖVÖ&W'6†—–BÇÀ¢76–væÖVçBç&VçFVDÖVÖ&W'6†—–BÇÀ¢çVÆÃ° ¢–b†–B’°¢–G2æFB…7G&–ær†–B’“°¢Ð¢Ð¢Ð ¢&WGW&â–G3°§Ð  ¦ç÷7B€¢"ö’öFÖ–âö66÷VçB×ööÂó§&WF–ÆW"öFB"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B&WF–ÆW"Ð¢æ÷&ÖÆ—¦TÖævVEööÅ&WF–ÆW"€¢&Wç&×2ç&WF–ÆW ¢“° ¢–b‚&WF–ÆW"’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$6†ö÷6RF&vWB÷"vÆÖ'Bâ ¢Ò“°¢Ð ¢6öç7B'6VBÐ¢'6TÖævVEööÄ66÷VçG2€¢&Wæ&öG“òæ66÷VçG0¢“° ¢–b‚'6VBæÆVæwF‚’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$FBBÆV7BöæR66÷VçBâ ¢Ò“°¢Ð ¢6öç7B&V6÷&G2Ð¢v—BvWDÖævVD66÷VçG2‚“° ¢6öç7BW†—7F–ætVÖ–Ç2Ð¢æWr6WB‚“° ¢f÷"€¢6öç7B&V6÷&Böb&V6÷&G0¢’°¢G'’°¢6öç7B7&VFVçF–Ç2Ð¢&V6÷&Bæ7&VFVçF–Ç0¢òæ÷&ÖÆ—¦U&WF–ÆW$7&VFVçF–Ç2€¢FV7'—D§6öâ€¢&V6÷&Bæ7&VFVçF–Ç0¢¢¢¢V×G•&WF–ÆW$7&VFVçF–Ç2‚“° ¢6öç7BVÖ–ÂÐ¢æ÷&ÖÆ—¦TVÖ–Â€¢7&VFVçF–Ç0¢òå·&WF–ÆW%Ð¢òçW6W&æÖP¢“° ¢–b†VÖ–Â’°¢W†—7F–ætVÖ–Ç2æFB€¢VÖ–À¢“°¢Ð¢Ò6F6‚°¢òò&W6W'fRVç&VF&ÆR&V6÷&G2à¢Ð¢Ð ¢6öç7BGWÆ–6FW2Ð¢'6VBæf–ÇFW"€¢—FVÒÓà¢W†—7F–ætVÖ–Ç2æ†2€¢—FVÒæVÖ–À¢¢“° ¢–b†GWÆ–6FW2æÆVæwF‚’°¢&WGW&â&W0¢ç7FGW2ƒC’¢æ§6öâ‡°¢W'&÷# ¢G¶GWÆ–6FW2æÆVæwF‡ÒG·&WF–ÆW'Ò66÷VçBG¶GWÆ–6FW2æÆVæwF‚ÓÓÒò""¢'2'ÒÇ&VG’W†—7Bæ ¢Ò“°¢Ð ¢6öç7Bæ÷rÐ¢æWrFFR‚¢çFô•4õ7G&–ær‚“° ¢f÷"€¢6öç7B—FVÒöb'6V@¢’°¢6öç7B7&VFVçF–Ç2Ð¢V×G•&WF–ÆW$7&VFVçF–Ç2‚“° ¢7&VFVçF–Ç5·&WF–ÆW%ÒÒ°¢W6W&æÖS¢—FVÒæVÖ–ÂÀ¢77v÷&C¢—FVÒç77v÷&@¢Ó° ¢&V6÷&G2çW6‚‡°¢–C ¢7'—Fòç&æFöÕUT”B‚’À¢&öf–ÆTæÖS ¢ÔätTBG·&WF–ÆW"çFõWW$66R‚—Ò44õTåFÀ¢66÷VçDVÖ–Ã¢""À¢æ÷FW3¢""À¢7&VFVçF–Ç3 ¢Væ7'—D§6öâ€¢7&VFVçF–Ç0¢’À¢6÷W&6S ¢G·&WF–ÆW'Ò×6V7W&RÖFFÀ¢7&VFVDC¢æ÷rÀ¢WFFVDC¢æ÷p¢Ò“°¢Ð ¢v—B6fTÖævVD66÷VçG2€¢&V6÷&G0¢“° ¢6öç7Bf–Æ&–Æ—G’Ð¢v—BvWDÖævVDf–Æ&–Æ—G’‚“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢FFVC ¢'6VBæÆVæwF‚À¢&WF–ÆW"À¢f–Æ&–Æ—G“ ¢f–Æ&–Æ—G•·&WF–ÆW%Ð¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$ÖævVBööÂFBW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2€¢W'&÷"ç7FGW2ÇÂS ¢¢æ§6öâ‡°¢W'&÷# ¢W'&÷"æÖW76vRÇÀ¢%Væ&ÆRFòFBÖævVB66÷VçG2â ¢Ò“°¢Ð¢Ð¢“°  ¦ç÷7B€¢"ö’öFÖ–âö66÷VçB×ööÂó§&WF–ÆW"÷&WÆ6R"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B&WF–ÆW"Ð¢æ÷&ÖÆ—¦TÖævVEööÅ&WF–ÆW"€¢&Wç&×2ç&WF–ÆW ¢“° ¢–b‚&WF–ÆW"’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$6†ö÷6RF&vWB÷"vÆÖ'Bâ ¢Ò“°¢Ð ¢6öç7B'6VBÐ¢'6TÖævVEööÄ66÷VçG2€¢&Wæ&öG“òæ66÷VçG0¢“° ¢–b‚'6VBæÆVæwF‚’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$FBBÆV7BöæR66÷VçBâ ¢Ò“°¢Ð ¢6öç7B&V6÷&G2Ð¢v—BvWDÖævVD66÷VçG2‚“° ¢6öç7B76–væVD–G2Ð¢v—BÖævVD76–væVD–E6WB‚“° ¢6öç7B&WF–æVBÒµÓ°¢ÆWB&VÖ÷fVBÒ° ¢f÷"€¢6öç7B&V6÷&Böb&V6÷&G0¢’°¢ÆWB7&VFVçF–Ç2Ð¢V×G•&WF–ÆW$7&VFVçF–Ç2‚“° ¢G'’°¢7&VFVçF–Ç2Ð¢&V6÷&Bæ7&VFVçF–Ç0¢òæ÷&ÖÆ—¦U&WF–ÆW$7&VFVçF–Ç2€¢FV7'—D§6öâ€¢&V6÷&Bæ7&VFVçF–Ç0¢¢¢¢V×G•&WF–ÆW$7&VFVçF–Ç2‚“°¢Ò6F6‚°¢&WF–æVBçW6‚‡&V6÷&B“°¢6öçF–çVS°¢Ð ¢6öç7B†5&WF–ÆW"Ð¢&ööÆVâ€¢7G&–ær€¢7&VFVçF–Ç0¢òå·&WF–ÆW%Ð¢òçW6W&æÖRÇÀ¢" ¢’çG&–Ò‚¢“° ¢–b‚†5&WF–ÆW"’°¢&WF–æVBçW6‚‡&V6÷&B“°¢6öçF–çVS°¢Ð ¢–b€¢76–væVD–G2æ†2€¢7G&–ær‡&V6÷&Bæ–B¢¢’°¢&WGW&â&W0¢ç7FGW2ƒC’¢æ§6öâ‡°¢W'&÷# ¢7W'&VçBG·&WF–ÆW'Ò66÷VçB—276–væVBFò7W7FöÖW"âf–æ—6‚÷&VÖ÷fR76–væVB66÷VçG2&Vf÷&R&WÆ6–ærF†RVçF—&RööÂæ ¢Ò“°¢Ð ¢&VÖ÷fVB³Ò° ¢7&VFVçF–Ç5·&WF–ÆW%ÒÒ°¢W6W&æÖS¢""À¢77v÷&C¢" ¢Ó° ¢6öç7B†4÷F†W"Ð¢$UD”ÄU%ô´U•2ç6öÖR€¢¶W’Óà¢¶W’ÓÒ&WF–ÆW"b`¢&ööÆVâ€¢7G&–ær€¢7&VFVçF–Ç0¢òå¶¶W•Ð¢òçW6W&æÖRÇÀ¢" ¢’çG&–Ò‚¢¢“° ¢–b††4÷F†W"’°¢&WF–æVBçW6‚‡°¢ââç&V6÷&BÀ¢7&VFVçF–Ç3 ¢Væ7'—D§6öâ€¢7&VFVçF–Ç0¢’À¢WFFVDC ¢æWrFFR‚¢çFô•4õ7G&–ær‚¢Ò“°¢Ð¢Ð ¢6öç7Bæ÷rÐ¢æWrFFR‚¢çFô•4õ7G&–ær‚“° ¢6öç7BFF—F–öç2Ð¢'6VBæÖ†—FVÒÓâ°¢6öç7B7&VFVçF–Ç2Ð¢V×G•&WF–ÆW$7&VFVçF–Ç2‚“° ¢7&VFVçF–Ç5·&WF–ÆW%ÒÒ°¢W6W&æÖS¢—FVÒæVÖ–ÂÀ¢77v÷&C¢—FVÒç77v÷&@¢Ó° ¢&WGW&â°¢–C ¢7'—Fòç&æFöÕUT”B‚’À¢&öf–ÆTæÖS ¢ÔätTBG·&WF–ÆW"çFõWW$66R‚—Ò44õTåFÀ¢66÷VçDVÖ–Ã¢""À¢æ÷FW3¢""À¢7&VFVçF–Ç3 ¢Væ7'—D§6öâ€¢7&VFVçF–Ç0¢’À¢6÷W&6S ¢G·&WF–ÆW'Ò×6V7W&R×&WÆ6VÖVçFÀ¢7&VFVDC¢æ÷rÀ¢WFFVDC¢æ÷p¢Ó°¢Ò“° ¢v—B6fTÖævVD66÷VçG2…°¢ââç&WF–æVBÀ¢ââæFF—F–öç0¢Ò“° ¢6öç7Bf–Æ&–Æ—G’Ð¢v—BvWDÖævVDf–Æ&–Æ—G’‚“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢&VÖ÷fVBÀ¢FFVC ¢FF—F–öç2æÆVæwF‚À¢&WF–ÆW"À¢f–Æ&–Æ—G“ ¢f–Æ&–Æ—G•·&WF–ÆW%Ð¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$ÖævVBööÂ&WÆ6RW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2€¢W'&÷"ç7FGW2ÇÂS ¢¢æ§6öâ‡°¢W'&÷# ¢W'&÷"æÖW76vRÇÀ¢%Væ&ÆRFò&WÆ6RÖævVBööÂâ ¢Ò“°¢Ð¢Ð¢“°  ¦ç÷7B€¢"ö’öFÖ–âö66÷VçB×ööÂó§&WF–ÆW"öFVÆWFR×6VÆV7FVB"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B&WF–ÆW"Ð¢æ÷&ÖÆ—¦TÖævVEööÅ&WF–ÆW"€¢&Wç&×2ç&WF–ÆW ¢“° ¢6öç7B–G2Ð¢'&’æ—4'&’€¢&Wæ&öG“òæ–G0¢¢ò&Wæ&öG’æ–G0¢æÖ†—FVÒÓà¢7G&–ær†—FVÒ¢¢æf–ÇFW"„&ööÆVâ¢¢µÓ° ¢–b€¢&WF–ÆW"ÇÀ¢–G2æÆVæwF€¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$6†ö÷6RBÆV7BöæR66÷VçBFòFVÆWFRâ ¢Ò“°¢Ð ¢6öç7BvçFVBÐ¢æWr6WB†–G2“° ¢6öç7B76–væVD–G2Ð¢v—BÖævVD76–væVD–E6WB‚“° ¢6öç7B&Æö6¶VBÐ¢–G2æf–ÇFW"€¢–BÓà¢76–væVD–G2æ†2†–B¢“° ¢–b†&Æö6¶VBæÆVæwF‚’°¢&WGW&â&W0¢ç7FGW2ƒC’¢æ§6öâ‡°¢W'&÷# ¢G¶&Æö6¶VBæÆVæwF‡Ò6VÆV7FVB66÷VçBG¶&Æö6¶VBæÆVæwF‚ÓÓÒò"—2"¢'2&R'Ò7F–ÆÂ76–væVBâ&VÖ÷fRF†R76–væÖVçBf—'7Bæ ¢Ò“°¢Ð ¢6öç7B&V6÷&G2Ð¢v—BvWDÖævVD66÷VçG2‚“° ¢6öç7BæW‡BÒµÓ°¢ÆWBFVÆWFVBÒ° ¢f÷"€¢6öç7B&V6÷&Böb&V6÷&G0¢’°¢–b€¢vçFVBæ†2€¢7G&–ær‡&V6÷&Bæ–B¢¢’°¢æW‡BçW6‚‡&V6÷&B“°¢6öçF–çVS°¢Ð ¢ÆWB7&VFVçF–Ç2Ð¢V×G•&WF–ÆW$7&VFVçF–Ç2‚“° ¢G'’°¢7&VFVçF–Ç2Ð¢&V6÷&Bæ7&VFVçF–Ç0¢òæ÷&ÖÆ—¦U&WF–ÆW$7&VFVçF–Ç2€¢FV7'—D§6öâ€¢&V6÷&Bæ7&VFVçF–Ç0¢¢¢¢V×G•&WF–ÆW$7&VFVçF–Ç2‚“°¢Ò6F6‚°¢æW‡BçW6‚‡&V6÷&B“°¢6öçF–çVS°¢Ð ¢–b€¢7G&–ær€¢7&VFVçF–Ç0¢òå·&WF–ÆW%Ð¢òçW6W&æÖRÇÀ¢" ¢’çG&–Ò‚¢’°¢æW‡BçW6‚‡&V6÷&B“°¢6öçF–çVS°¢Ð ¢7&VFVçF–Ç5·&WF–ÆW%ÒÒ°¢W6W&æÖS¢""À¢77v÷&C¢" ¢Ó° ¢FVÆWFVB³Ò° ¢6öç7B†4÷F†W"Ð¢$UD”ÄU%ô´U•2ç6öÖR€¢¶W’Óà¢&ööÆVâ€¢7G&–ær€¢7&VFVçF–Ç0¢òå¶¶W•Ð¢òçW6W&æÖRÇÀ¢" ¢’çG&–Ò‚¢¢“° ¢–b††4÷F†W"’°¢æW‡BçW6‚‡°¢ââç&V6÷&BÀ¢7&VFVçF–Ç3 ¢Væ7'—D§6öâ€¢7&VFVçF–Ç0¢’À¢WFFVDC ¢æWrFFR‚¢çFô•4õ7G&–ær‚¢Ò“°¢Ð¢Ð ¢v—B6fTÖævVD66÷VçG2†æW‡B“° ¢6öç7Bf–Æ&–Æ—G’Ð¢v—BvWDÖævVDf–Æ&–Æ—G’‚“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢FVÆWFVBÀ¢&WF–ÆW"À¢f–Æ&–Æ—G“ ¢f–Æ&–Æ—G•·&WF–ÆW%Ð¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$ÖævVBööÂFVÆWFR×6VÆV7FVBW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFòFVÆWFR6VÆV7FVBÖævVB66÷VçG2â ¢Ò“°¢Ð¢Ð¢“°  ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢DÔ”âD$tUBôôÂ$UÄ4TÔTå@ ¢7&VFVçF–Ç2&R7V&Ö—GFVBB'VçF–ÖRg&öÒFÖ–âæB&P¢Væ7'—FVB–ÖÖVF–FVÇ’W6–ær5T$Ô•54”ôåôTä5%•D”ôåô´U’à¢F†W’&RäõBVÖ&VFFVB–âF†R6÷W&6R&W÷6—F÷'’à ¢f÷"6fWG’Â&WÆ6VÖVçB—2&Æö6¶VBv†–ÆRç’7W'&Vç@¢F&vWBÖævVB66÷VçB—27F—fVÇ’76–væVBà¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦ç÷7B€¢"ö’öFÖ–â÷F&vWB×ööÂ÷&WÆ6R"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B&rÐ¢7G&–ær€¢&Wæ&öG“òæ66÷VçG2ÇÀ¢" ¢“° ¢6öç7BÆ–æW2Ð¢&p¢ç7Æ—B‚õÇ#õÆâò¢æÖ€¢Æ–æRÓà¢Æ–æRçG&–Ò‚¢¢æf–ÇFW"„&ööÆVâ“° ¢6öç7B'6VBÐ¢µÓ° ¢6öç7B6VVâÐ¢æWr6WB‚“° ¢f÷"€¢ÆWB–æFW‚Ò°¢–æFW‚ÂÆ–æW2æÆVæwFƒ°¢–æFW‚³Ò¢’°¢6öç7BÆ–æRÐ¢Æ–æW5¶–æFW…Ó° ¢6öç7B6W&F÷"Ð¢Æ–æRæ–æFW„öb‚#¢"“° ¢–b€¢6W&F÷"ÃÒ ¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢Æ–æRG¶–æFW‚²Ò—2æ÷B–âVÖ–Ã§77v÷&Bf÷&ÖBæ ¢Ò“°¢Ð ¢6öç7BVÖ–ÂÐ¢æ÷&ÖÆ—¦TVÖ–Â€¢Æ–æRç6Æ–6R€¢À¢6W&F÷ ¢¢“° ¢6öç7B77v÷&BÐ¢Æ–æRç6Æ–6R€¢6W&F÷"²¢“° ¢–b€¢õåµåÇ4Ò´µåÇ4ÒµÂåµåÇ4Ò²BòçFW7B€¢VÖ–À¢¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢Æ–æRG¶–æFW‚²Ò†2â–çfÆ–BVÖ–ÂFG&W72æ ¢Ò“°¢Ð ¢–b‚77v÷&B’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢Æ–æRG¶–æFW‚²Ò—2Ö—76–ær77v÷&Bæ ¢Ò“°¢Ð ¢–b€¢6VVâæ†2€¢VÖ–À¢¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢GWÆ–6FRF&vWBVÖ–Âf÷VæBöâÆ–æRG¶–æFW‚²Òæ ¢Ò“°¢Ð ¢6VVâæFB€¢VÖ–À¢“° ¢'6VBçW6‚‡°¢VÖ–ÂÀ¢77v÷&@¢Ò“°¢Ð ¢–b€¢'6VBæÆVæwF‚ÓÐ¢ ¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢F†—2&WÆ6VÖVçB&WV—&W2W†7FÇ’F&vWB66÷VçG2â&V6V—fVBG·'6VBæÆVæwF‡Òæ ¢Ò“°¢Ð ¢6öç7B°¢ÖævVD66÷VçG2À¢g&VT76–væÖVçG2À¢&VçFÄ76–væÖVçG0¢ÒÒv—B&öÖ—6RæÆÂ…°¢vWDÖævVD66÷VçG2‚’À¢vWDg&VT76–væÖVçG2‚’À¢vWE&VçFÄ76–væÖVçG2‚¢Ò“° ¢6öç7B7F—fTÖævVD–G2Ð¢æWr6WB‚“° ¢f÷"€¢6öç7B76–væÖVçBö`¢g&VT76–væÖVçG0¢’°¢–b€¢ÖævVD76–væÖVçD—4Æ–æ¶VB€¢76–væÖVç@¢¢’°¢6öç7B–BÐ¢76–væÖVç@¢æÖævVD66÷VçD–BÇÀ¢76–væÖVç@¢æg&VTÖVÖ&W'6†—–FÚ±î¸Â¸­yêë¢°k¢G§¦*^ ||
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
          req.body?.cu[jÇºã
âµç«®ŠÁ®‰ž˜©{7FöÖW$66÷VçD–BÀ¢S ¢“° ¢6öç7B&WF–ÆW"Ð¢æ÷&ÖÆ—¦U&VçFÅ&WF–ÆW"€¢&Wæ&öG“òç&WF–ÆW ¢“° ¢6öç7B76–væÖVçEG—RÐ¢7G&–ær€¢&Wæ&öG“òæ76–væÖVçEG—RÇÀ¢" ¢¢çG&–Ò‚¢çFôÆ÷vW$66R‚“° ¢6öç7BVçF—G’Ð¢ÖF‚æÖ–â€¢SÀ¢ÖF‚æÖ‚€¢À¢ÖF‚æfÆö÷"€¢çVÖ&W"€¢&Wæ&öG“òçVçF—G’ÇÀ¢¢¢¢¢“° ¢6öç7BGW&F–öåG—RÐ¢æ÷&ÖÆ—¦U7V6–Å&öf–ÆTGW&F–öâ€¢&Wæ&öG“òæGW&F–öåG—P¢“° ¢–b€¢7W7FöÖW$66÷VçD–BÇÀ¢&WF–ÆW"ÇÀ¢°¢&g&VR"À¢'&VçFVB ¢Òæ–æ6ÇVFW2€¢76–væÖVçEG—P¢’ÇÀ¢GW&F–öåG—P¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$6†ö÷6R7W7FöÖW"Â&WF–ÆW"Â76–væÖVçBG—RÂVçF—G’ÂæBGW&F–öââ ¢Ò“°¢Ð ¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7B–E&V6÷&G2Ð¢'&’æ—4'&’‡–B¢ò–@¢¢µÓ° ¢6öç7B–E&V6÷&BÒv—B7F—fTÖVÖ&W'6†—&V6÷&Df÷$7W7FöÖW"†7W7FöÖW$66÷VçD–BÂ–E&V6÷&G2“°¢–b‚–E&V6÷&B’°¢&WGW&â&W2ç7FGW2ƒC2’æ§6öâ‡°¢W'&÷#¢$â7F—fR–B÷"v–gFVBÖVÖ&W'6†——2&WV—&VBf÷"ÖævVB&öf–ÆW2â ¢Ò“°¢Ð ¢6öç7Bf–Æ&ÆRÐ¢v—BvWDf–Æ&ÆTÖævVD66÷VçG4f÷%&WF–ÆW"€¢&WF–ÆW"À¢°¢&W7F÷&T7W7FöÖW$66÷VçD–C ¢7W7FöÖW$66÷VçD–BÀ ¢&W7F÷&UG—S ¢76–væÖVçEG—P¢Ð¢“° ¢–b€¢f–Æ&ÆRæÆVæwF‚À¢VçF—G¢’°¢&WGW&â&W0¢ç7FGW2ƒC’¢æ§6öâ‡°¢W'&÷# ¢öæÇ’G¶f–Æ&ÆRæÆVæwF‡ÒG·&WF–ÆW'ÒÖVÖ&W'6†—G¶f–Æ&ÆRæÆVæwF‚ÓÓÒò""¢'2'Ò&R7W'&VçFÇ’f–Æ&ÆRæ ¢Ò“°¢Ð ¢6öç7Bæ÷rÐ¢æWrFFR‚“° ¢6öç7B7W7FöÖW%&öf–ÆRÐ¢6æ—F—¦U&öf–ÆR€¢–E&V6÷&Bç&öf–ÆRÇÀ¢·Ð¢“° ¢6öç7B–E6V7&WG2Òv—BÖVÖ&W'6†—Væ7'—FVE6¶vR‡–E&V6÷&B“° ¢–b€¢76–væÖVçEG—RÓÓÐ¢&g&VR ¢’°¢6öç7B76–væÖVçG2Ð¢v—BvWDg&VT76–væÖVçG2‚“° ¢f÷"€¢6öç7B66÷VçBö`¢f–Æ&ÆRç6Æ–6R€¢À¢VçF—G¢¢’°¢76–væÖVçG2çW6‚‡°¢–C ¢7'—Fòç&æFöÕUT”B‚’À ¢g&VTÖVÖ&W'6†—–C ¢66÷VçBæ–BÀ ¢ÖævVD66÷VçD–C ¢66÷VçBæ–BÀ ¢7W7FöÖW$66÷VçD–BÀ ¢–E7V&Ö—76–öä–C ¢–E&V6÷&Bæ–BÀ ¢7F—fS ¢G'VRÀ ¢GW&F–öåG—RÀ ¢76–væÖVçE&WF–ÆW# ¢&WF–ÆW"À ¢7F—fF–öå7FGW3 ¢&v—F–æuö7F—fF–öâ"À ¢7F—fF–öå&WVW7FVDC ¢æ÷rçFô•4õ7G&–ær‚’À ¢7F'G4C ¢çVÆÂÀ ¢W‡—&W4C ¢çVÆÂÀ ¢7W7FöÖW%&öf–ÆRÀ ¢7W7FöÖW%6V7&WG3 ¢–E6V7&WG0¢òVæ7'—D§6öâ€¢–E6V7&WG0¢¢¢çVÆÂÀ ¢7&VFVDC ¢æ÷rçFô•4õ7G&–ær‚’À ¢WFFVDC ¢æ÷rçFô•4õ7G&–ær‚’À ¢VæFVDC ¢çVÆÂÀ ¢VæE&V6öã ¢çVÆÀ¢Ò“°¢Ð ¢f÷"€¢6öç7B76–væÖVçBö`¢76–væÖVçG0¢’°¢–b€¢76–væÖVçBæ7W7FöÖW$66÷VçD–BÓÓÐ¢7W7FöÖW$66÷VçD–Bb`¢76–væÖVçBæ7F—fF–öå7FGW2ÓÓÐ¢&v—F–æuö7F—fF–öâ"b`¢76–væÖVçBæF—66÷&E&öf–ÆTÖW76vT–@¢’°¢v—BVç7W&TÖævVE&öf–ÆTF—66÷&DÖW76vR€¢76–væÖVçBÀ¢&g&VR ¢“°¢Ð¢Ð ¢v—B6fTg&VT76–væÖVçG2€¢76–væÖVçG0¢“° ¢ÒVÇ6R°¢6öç7B76–væÖVçG2Ð¢v—BvWE&VçFÄ76–væÖVçG2‚“° ¢f÷"€¢6öç7B66÷VçBö`¢f–Æ&ÆRç6Æ–6R€¢À¢VçF—G¢¢’°¢76–væÖVçG2çW6‚‡°¢–C ¢7'—Fòç&æFöÕUT”B‚’À ¢&VçFVDÖVÖ&W'6†—–C ¢66÷VçBæ–BÀ ¢ÖævVD66÷VçD–C ¢66÷VçBæ–BÀ ¢7W7FöÖW$66÷VçD–BÀ ¢–E7V&Ö—76–öä–C ¢–E&V6÷&Bæ–BÀ ¢7F—fS ¢G'VRÀ ¢GW&F–öåG—RÀ ¢7F—fF–öå7FGW3 ¢&v—F–æuö7F—fF–öâ"À ¢7F—fF–öå&WVW7FVDC ¢æ÷rçFô•4õ7G&–ær‚’À ¢7F'G4C ¢çVÆÂÀ ¢W‡—&W4C ¢çVÆÂÀ ¢7W7FöÖW%&öf–ÆRÀ ¢7W7FöÖW%6V7&WG3 ¢–E6V7&WG0¢òVæ7'—D§6öâ€¢–E6V7&WG0¢¢¢çVÆÂÀ ¢&VçFÅ&WF–ÆW# ¢&WF–ÆW"À ¢7G&—U7V'67&—F–öä–C ¢çVÆÂÀ ¢7G&—T7W7FöÖW$–C ¢–E&V6÷&@¢ç7G&—T7W7FöÖW$–BÇÀ¢çVÆÂÀ ¢7&VFVDC ¢æ÷rçFô•4õ7G&–ær‚’À ¢WFFVDC ¢æ÷rçFô•4õ7G&–ær‚’À ¢VæFVDC ¢çVÆÂÀ ¢VæE&V6öã ¢çVÆÀ¢Ò“°¢Ð ¢f÷"€¢6öç7B76–væÖVçBö`¢76–væÖVçG0¢’°¢–b€¢76–væÖVçBæ7W7FöÖW$66÷VçD–BÓÓÐ¢7W7FöÖW$66÷VçD–Bb`¢76–væÖVçBæ7F—fF–öå7FGW2ÓÓÐ¢&v—F–æuö7F—fF–öâ"b`¢76–væÖVçBæF—66÷&E&öf–ÆTÖW76vT–@¢’°¢v—BVç7W&TÖævVE&öf–ÆTF—66÷&DÖW76vR€¢76–væÖVçBÀ¢'&VçFVB ¢“°¢Ð¢Ð ¢v—B6fU&VçFÄ76–væÖVçG2€¢76–væÖVçG0¢“°¢Ð ¢v—B6öç7VÖU&W7F÷&T†öÆD—FV×2€¢7W7FöÖW$66÷VçD–BÀ¢76–væÖVçEG—RÀ¢f–Æ&ÆP¢ç6Æ–6R€¢À¢VçF—G¢¢æÖ€¢66÷VçBÓà¢66÷VçBæ–@¢¢“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ ¢76–væVC ¢VçF—G’À ¢76–væÖVçEG—RÀ¢&WF–ÆW"À ¢ÖW76vS ¢G·VçF—G—Òf–Æ&ÆRÖVÖ&W'6†—G·VçF—G’ÓÓÒò""¢'2'Ò76–væVB7V66W76gVÆÇ’æ ¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$f–Æ&ÆRÖVÖ&W'6†—76–væÖVçBW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFò76–vâf–Æ&ÆRÖVÖ&W'6†—2â ¢Ò“°¢Ð¢Ð¢“°  ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢DÔ”âe$TRÔTÔ$U%4„•0¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦ævWB€¢"ö’öFÖ–âög&VRÖÖVÖ&W'6†—2"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BÖVÖ&W'6†—2Ð¢v—BvWDÖævVD66÷VçG2‚“° ¢6öç7B76–væÖVçG2Ð¢v—BvWDg&VT76–væÖVçG2‚“° ¢6öç7B÷F†W$76–væÖVçG2Ð¢v—BvWE&VçFÄ76–væÖVçG2‚“° ¢6öç7B66÷VçG2Ð¢v—BvWD7W7FöÖW$66÷VçG2‚“° ¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7B–E&V6÷&G2Ð¢'&’æ—4'&’‡–B¢ò–@¢¢µÓ° ¢ÆWB76–væÖVçG46†ævVBÐ¢fÇ6S° ¢6öç7Bæ÷rÐ¢æWrFFR‚“° ¢f÷"€¢6öç7B76–væÖVçBö`¢76–væÖVçG0¢’°¢–b€¢76–væÖVçBæ7F—fRÓÒG'VRÇÀ¢7G&–ær€¢76–væÖVçBæ7F—fF–öå7FGW2ÇÀ¢" ¢’ÓÐ¢&7F—fFVB"ÇÀ¢76–væÖVçBæW‡—&W4@¢’°¢6öçF–çVS°¢Ð ¢6öç7BW‡—&W4BÐ¢æWrFFR€¢76–væÖVçBæW‡—&W4@¢“° ¢–b€¢çVÖ&W"æ—4æâ€¢W‡—&W4BævWEF–ÖR‚¢’b`¢W‡—&W4BævWEF–ÖR‚’ÃÐ¢æ÷rævWEF–ÖR‚¢’°¢6ÆV$ÖævVD76–væÖVçD7W7FöÖW$FF€¢76–væÖVçBÀ¢°¢&V6öã ¢&W‡—&VB"À¢æ÷t—6ó ¢æ÷rçFô•4õ7G&–ær‚¢Ð¢“° ¢76–væÖVçG46†ævVBÐ¢G'VS°¢Ð¢Ð ¢–b†76–væÖVçG46†ævVB’°¢v—B6fTg&VT76–væÖVçG2€¢76–væÖVçG0¢“°¢Ð ¢ò¢–BæB7W'&VçFÇ’7F—fRv–gFVBF–W'26âW6RÖævVB&öf–ÆW2â¢ð ¢6öç7B–D7W7FöÖW$ÖÐ¢æWrÖ‚“° ¢f÷"€¢6öç7B&V6÷&Bö`¢–E&V6÷&G0¢’°¢–b€¢&V6÷&Bæ7W7FöÖW$66÷VçD–BÇÀ¢7V'67&—F–öäÆÆ÷w5&öf–ÆW2€¢&V6÷&@¢¢’°¢6öçF–çVS°¢Ð ¢–b€¢–D7W7FöÖW$Öæ†2€¢&V6÷&Bæ7W7FöÖW$66÷VçD–@¢¢’°¢–D7W7FöÖW$Öç6WB€¢&V6÷&Bæ7W7FöÖW$66÷VçD–BÀ¢&V6÷&@¢“°¢Ð¢Ð ¢6öç7B7F—fTv–gG2Òv—BvWDv–gFVDÖVÖ&W'6†—2‚“°¢f÷"†6öç7Bv–gBöb7F—fTv–gG2’°¢–b€¢–D7W7FöÖW$Öæ†2†v–gBæ7W7FöÖW$66÷VçD–B’ÇÀ¢æWrFFR†v–gBç7F'G4B’ævWEF–ÖR‚’âæ÷rævWEF–ÖR‚’ÇÀ¢æWrFFR†v–gBæW‡—&W4B’ævWEF–ÖR‚’ÃÒæ÷rævWEF–ÖR‚¢’6öçF–çVS°¢6öç7B66÷VçBÒ66÷VçG2æf–æB†—FVÒÓâ7G&–ær†—FVÒæ–B’ÓÓÒ7G&–ær†v–gBæ7W7FöÖW$66÷VçD–B’“°¢–b‚66÷VçB’6öçF–çVS°¢–D7W7FöÖW$Öç6WB†v–gBæ7W7FöÖW$66÷VçD–BÂ°¢–C¢v–gC¢G¶v–gBæ–GÖÀ¢7W7FöÖW$66÷VçD–C¢v–gBæ7W7FöÖW$66÷VçD–BÀ¢&öf–ÆS¢²âââ†66÷VçBæFÖ–å&öf–ÆRÇÂ·Ò’ÂVÖ–Ã¢66÷VçBæVÖ–ÂÒÀ¢7V'67&—F–öå7FGW3¢&v–gFVB"À¢7W'&VçEW&–öDVæC¢v–gBæW‡—&W4@¢Ò“°¢Ð ¢6öç7B–D7W7FöÖW'2Ð¢'&’æg&öÒ€¢–D7W7FöÖW$ÖçfÇVW2‚¢’æÖ‡&V6÷&BÓâ°¢6öç7B66÷VçBÐ¢66÷VçG2æf–æB€¢—FVÒÓà¢—FVÒæ–BÓÓÐ¢&V6÷&Bæ7W7FöÖW$66÷VçD–@¢“° ¢6öç7B6fVE&öf–ÆRÐ¢66÷VçCòæFÖ–å&öf–ÆRb`¢G—Vöb66÷VçBæFÖ–å&öf–ÆRÓÓÐ¢&ö&¦V7B ¢ò66÷VçBæFÖ–å&öf–ÆP¢¢·Ó° ¢6öç7B–E&öf–ÆRÐ¢&V6÷&Bç&öf–ÆRb`¢G—Vöb&V6÷&Bç&öf–ÆRÓÓÐ¢&ö&¦V7B ¢ò&V6÷&Bç&öf–ÆP¢¢·Ó° ¢6öç7B7W7FöÖW$æÖRÐ¢°¢6fVE&öf–ÆRæf—'7DæÖRÇÀ¢–E&öf–ÆRæf—'7DæÖRÇÀ¢""À¢6fVE&öf–ÆRæÆ7DæÖRÇÀ¢–E&öf–ÆRæÆ7DæÖRÇÀ¢" ¢Ð¢æf–ÇFW"„&ööÆVâ¢æ¦ö–â‚""’ÇÀ¢6fVE&öf–ÆRç&öf–ÆTæÖRÇÀ¢–E&öf–ÆRç&öf–ÆTæÖRÇÀ¢$7W7FöÖW"#° ¢&WGW&â°¢7W7FöÖW$66÷VçD–C ¢&V6÷&Bæ7W7FöÖW$66÷VçD–BÀ ¢–E7V&Ö—76–öä–C ¢&V6÷&Bæ–BÀ ¢æÖS ¢7W7FöÖW$æÖRÀ ¢VÖ–Ã ¢66÷VçCòæVÖ–ÂÇÀ¢6fVE&öf–ÆRæVÖ–ÂÇÀ¢–E&öf–ÆRæVÖ–ÂÇÀ¢""À ¢7V'67&—F–öå7FGW3 ¢&V6÷&Bç7V'67&—F–öå7FGW2ÇÀ¢çVÆÂÀ ¢7W'&VçEW&–öDVæC ¢&V6÷&Bæ7W'&VçEW&–öDVæBÇÀ¢çVÆÀ¢Ó°¢Ò“° ¢6öç7B&W7VÇBÐ¢ÖVÖ&W'6†—0¢æf–ÇFW"€¢ÖVÖ&W'6†—Óà¢&ööÆVâ€¢Æ–æ¶VDg&VT76–væÖVçB€¢76–væÖVçG2À¢ÖVÖ&W'6†—æ–@¢¢¢¢æÖ€¢ÖVÖ&W'6†—Óâ°¢6öç7B76–væÖVçBÐ¢Æ–æ¶VDg&VT76–væÖVçB€¢76–væÖVçG2À¢ÖVÖ&W'6†—æ–@¢“° ¢6öç7B÷F†W$76–væÖVçBÐ¢Æ–æ¶VE&VçFÄ76–væÖVçB€¢÷F†W$76–væÖVçG2À¢ÖVÖ&W'6†—æ–@¢“° ¢ÆWB76–væVD7W7FöÖW"Ð¢çVÆÃ° ¢–b†76–væÖVçB’°¢6öç7B66÷VçBÐ¢66÷VçG2æf–æB€¢—FVÒÓà¢—FVÒæ–BÓÓÐ¢76–væÖVç@¢æ7W7FöÖW$66÷VçD–@¢“° ¢6öç7B–E&V6÷&BÐ¢–E&V6÷&G2æf–æB€¢—FVÒÓà¢—FVÒæ7W7FöÖW$66÷VçD–BÓÓÐ¢76–væÖVç@¢æ7W7FöÖW$66÷VçD–Bb`¢7V'67&—F–öäÆÆ÷w5&öf–ÆW2€¢—FVÐ¢¢“° ¢6öç7B6fVE&öf–ÆRÐ¢66÷VçCòæFÖ–å&öf–ÆRb`¢G—Vöb66÷VçBæFÖ–å&öf–ÆRÓÓÐ¢&ö&¦V7B ¢ò66÷VçBæFÖ–å&öf–ÆP¢¢·Ó° ¢6öç7B–E&öf–ÆRÐ¢–E&V6÷&Còç&öf–ÆRb`¢G—Vöb–E&V6÷&Bç&öf–ÆRÓÓÐ¢&ö&¦V7B ¢ò–E&V6÷&Bç&öf–ÆP¢¢·Ó° ¢76–væVD7W7FöÖW"Ò°¢7W7FöÖW$66÷VçD–C ¢76–væÖVç@¢æ7W7FöÖW$66÷VçD–BÀ ¢–E7V&Ö—76–öä–C ¢–E&V6÷&Còæ–BÇÀ¢çVÆÂÀ ¢æÖS ¢°¢6fVE&öf–ÆRæf—'7DæÖRÇÀ¢–E&öf–ÆRæf—'7DæÖRÇÀ¢""À¢6fVE&öf–ÆRæÆ7DæÖRÇÀ¢–E&öf–ÆRæÆ7DæÖRÇÀ¢" ¢Ð¢æf–ÇFW"„&ööÆVâ¢æ¦ö–â‚""’ÇÀ¢6fVE&öf–ÆRç&öf–ÆTæÖRÇÀ¢–E&öf–ÆRç&öf–ÆTæÖRÇÀ¢$7W7FöÖW""À ¢VÖ–Ã ¢66÷VçCòæVÖ–ÂÇÀ¢6fVE&öf–ÆRæVÖ–ÂÇÀ¢–E&öf–ÆRæVÖ–ÂÇÀ¢" ¢Ó°¢Ð ¢ÆWB&WF–ÆW'2Ð¢V×G•&WF–ÆW$7&VFVçF–Ç2‚“° ¢G'’°¢–b€¢ÖVÖ&W'6†—æ7&VFVçF–Ç0¢’°¢&WF–ÆW'2Ð¢æ÷&ÖÆ—¦U&WF–ÆW$7&VFVçF–Ç2€¢FV7'—D§6öâ€¢ÖVÖ&W'6†— ¢æ7&VFVçF–Ç0¢¢“°¢Ð¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$g&VRÖVÖ&W'6†—FV7'—BW'&÷#¢"À¢ÖVÖ&W'6†—æ–BÀ¢W'&÷"æÖW76vP¢“°¢Ð ¢ ¢ÆWB7W7FöÖW%6V7&WG2Ð¢çVÆÃ° §G'’°¢–b€¢76–væÖVçCòæ7W7FöÖW%6V7&WG0¢’°¢7W7FöÖW%6V7&WG2Ð¢FV7'—D§6öâ€¢76–væÖVçBæ7W7FöÖW%6V7&WG0¢“°¢Ð§Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$g&VRÖVÖ&W'6†—7W7FöÖW"FFFV7'—BW'&÷#¢"À¢ÖVÖ&W'6†—æ–BÀ¢W'&÷"æÖW76vP¢“°§Ð ¢6öç7B&VF–æW72Ð¢ÖævVE&öf–ÆU&VF–æW72€¢76–væÖVçCòæ7W7FöÖW%&öf–ÆRÇÀ¢·ÒÀ¢7W7FöÖW%6V7&WG2ÇÀ¢·Ð¢“° ¢6öç7BW†7DFG&W74ÖF6†W2Ð¢W†7DÖævVDFG&W74ÖF6†W2€¢76–væÖVçCòæ7W7FöÖW%&öf–ÆRÇÀ¢·ÒÀ¢ÖVÖ&W'6†—æ–BÀ¢ÖVÖ&W'6†—2À¢76–væÖVçG2À¢÷F†W$76–væÖVçG0¢“° ¢&WGW&â°¢–C ¢ÖVÖ&W'6†—æ–BÀ ¢&öf–ÆTæÖS ¢ÖVÖ&W'6†—ç&öf–ÆTæÖRÇÀ¢$e$TRÔTÔ$U%4„•"À ¢66÷VçDVÖ–Ã ¢ÖVÖ&W'6†—æ66÷VçDVÖ–ÂÇÀ¢""À ¢F—7Æ”VÖ–Ã ¢ÖævVD66÷VçD6æöæ–6ÄVÖ–Â€¢ÖVÖ&W'6†—À¢&WF–ÆW'0¢’À ¢æ÷FW3 ¢ÖVÖ&W'6†—ææ÷FW2ÇÀ¢""À ¢7&VFVDC ¢ÖVÖ&W'6†—æ7&VFVDBÇÀ¢çVÆÂÀ ¢WFFVDC ¢ÖVÖ&W'6†—çWFFVDBÇÀ¢çVÆÂÀ ¢7F—fS ¢&ööÆVâ€¢76–væÖVç@¢’À ¢7FGW3 ¢76–væÖVç@¢ò&7F—fR ¢¢€¢÷F†W$76–væÖVç@¢ò&ö67W–VB ¢¢&–æ7F—fR ¢’À ¢ö67W–VD'”÷F†W%G—S ¢&ööÆVâ€¢÷F†W$76–væÖVç@¢’À ¢ö67W–VEG—S ¢÷F†W$76–væÖVç@¢ò'&VçFVB ¢¢çVÆÂÀ ¢76–væÖVçC ¢76–væÖVç@¢ò°¢–C ¢76–væÖVçBæ–BÀ ¢7W7FöÖW$66÷VçD–C ¢76–væÖVç@¢æ7W7FöÖW$66÷VçD–BÀ ¢7F'G4C ¢76–væÖVçBç7F'G4BÇÀ¢çVÆÂÀ ¢W‡—&W4C ¢76–væÖVçBæW‡—&W4BÇÀ¢çVÆÂÀ ¢GW&F–öåG—S ¢76–væÖVçBæGW&F–öåG—RÇÀ¢çVÆÂÀ ¢7F—fF–öå7FGW3 ¢ÖævVD76–væÖVçE7FGW2€¢76–væÖVç@¢’À ¢7F—fF–öäÆ&VÃ ¢&öf–ÆT7F—fF–öäÆ&VÂ€¢76–væÖVçBæ7F—fF–öå7FGW0¢’À ¢F—5&VÖ–æ–æs ¢g&VT76–væÖVçDF—5&VÖ–æ–ær€¢76–væÖVç@¢¢Ð¢¢çVÆÂÀ ¢76–væVD7W7FöÖW"À ¢&WF–ÆW'2À ¢7W7FöÖW%&öf–ÆS ¢76–væÖVçCòæ7W7FöÖW%&öf–ÆRÇÀ¢çVÆÂÀ ¦7W7FöÖW%6V7&WG2À ¢&VF–æW72À ¢W†7DFG&W74ÖF6†W2À ¢¦–vvVDFG&W73 ¢76–væÖVçCòæ¦–vvVDFG&W72ÇÀ¢çVÆÂÀ ¢¦–uf&–çDçVÖ&W# ¢76–væÖVçCòæ¦–uf&–çD–æFW‚ÇÀ¢çVÆÀ¢Ó°¢Ð¢“° ¢6öç7B°¢f–Æ&ÆTÖVÖ&W'6†—2À¢&W7F÷&T†öÆG0¢ÒÒv—B&öÖ—6RæÆÂ…°¢vWDf–Æ&ÆTÖævVDÖVÖ&W'6†—&V6÷&G2‚’À¢vWE&W7F÷&T†öÆG2‚¢Ò“° ¢6öç7B7F—fU&W7F÷&T†öÆG2Ð¢7F—fU&W7F÷&T†öÆG4f÷"€¢&W7F÷&T†öÆG2À¢°¢G—S ¢&g&VR ¢Ð¢’æÖ€¢†öÆBÓâ‡°¢–C ¢†öÆBæ–BÀ ¢7W7FöÖW$66÷VçD–C ¢†öÆBæ7W7FöÖW$66÷VçD–BÀ ¢G—S ¢†öÆBçG—RÀ ¢†öÆEVçF–Ã ¢†öÆBæ†öÆEVçF–ÂÀ ¢6÷VçC ¢&W7F÷&T†öÆE&VÖ–æ–æt—FV×2€¢†öÆ@¢’æÆVæwF‚À ¢7W7FöÖW$æÖS ¢€¢–D7W7FöÖW'2æf–æB€¢Ú±î¸Â¸­yêë¢°k¢G§¦*^                 customer =>
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
        m«ëŒ+Š×ž®º+º$zzb¥ä'&’æ—4'&’‡–B¢ò–@¢¢µÓ° ¢6öç7B–E&V6÷&BÒv—B7F—fTÖVÖ&W'6†—&V6÷&Df÷$7W7FöÖW"†7W7FöÖW$66÷VçD–BÂ–E&V6÷&G2“° ¢–b‚–E&V6÷&B’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢$â7F—fR–B÷"v–gFVBF–W"6÷VÆBæ÷B&Rf÷VæBf÷"F†—27W7FöÖW"â ¢Ò“°¢Ð ¢6öç7B66÷VçG2Ð¢v—BvWD7W7FöÖW$66÷VçG2‚“° ¢6öç7B66÷VçBÐ¢66÷VçG2æf–æB€¢—FVÒÓà¢—FVÒæ–BÓÓÐ¢7W7FöÖW$66÷VçD–@¢“° ¢6öç7B6fVE&öf–ÆRÐ¢66÷VçCòæFÖ–å&öf–ÆRb`¢G—Vöb66÷VçBæFÖ–å&öf–ÆRÓÓÐ¢&ö&¦V7B ¢ò66÷VçBæFÖ–å&öf–ÆP¢¢·Ó° ¢6öç7B–E&öf–ÆRÐ¢–E&V6÷&Bç&öf–ÆRb`¢G—Vöb–E&V6÷&Bç&öf–ÆRÓÓÐ¢&ö&¦V7B ¢ò–E&V6÷&Bç&öf–ÆP¢¢·Ó° ¢ò ¢&VfW"F†R–æf÷&ÖF–öâ7V&Ö—GFV@¢v—F‚F†R–B7V'67&—F–öâà ¢fÆÂ&6²Fò6fVBFÖ–â&öf–ÆP¢–æf÷&ÖF–öâv†VâæV6W76'’à¢¢ð ¢6öç7B7W7FöÖW%&öf–ÆRÐ¢6æ—F—¦U&öf–ÆR‡°¢&öf–ÆTæÖS ¢–E&öf–ÆRç&öf–ÆTæÖRÇÀ¢6fVE&öf–ÆRç&öf–ÆTæÖRÇÀ¢""À ¢f—'7DæÖS ¢–E&öf–ÆRæf—'7DæÖRÇÀ¢6fVE&öf–ÆRæf—'7DæÖRÇÀ¢""À ¢Æ7DæÖS ¢–E&öf–ÆRæÆ7DæÖRÇÀ¢6fVE&öf–ÆRæÆ7DæÖRÇÀ¢""À ¢VÖ–Ã ¢–E&öf–ÆRæVÖ–ÂÇÀ¢6fVE&öf–ÆRæVÖ–ÂÇÀ¢66÷VçCòæVÖ–ÂÇÀ¢""À ¢†öæS ¢–E&öf–ÆRç†öæRÇÀ¢6fVE&öf–ÆRç†öæRÇÀ¢""À ¢FG&W73 ¢–E&öf–ÆRæFG&W72ÇÀ¢6fVE&öf–ÆRæFG&W72ÇÀ¢""À ¢FG&W73# ¢–E&öf–ÆRæFG&W73"ÇÀ¢6fVE&öf–ÆRæFG&W73"ÇÀ¢""À ¢6÷VçG'“ ¢–E&öf–ÆRæ6÷VçG'’ÇÀ¢6fVE&öf–ÆRæ6÷VçG'’ÇÀ¢""À ¢7FFS ¢–E&öf–ÆRç7FFRÇÀ¢6fVE&öf–ÆRç7FFRÇÀ¢""À ¢6—G“ ¢–E&öf–ÆRæ6—G’ÇÀ¢6fVE&öf–ÆRæ6—G’ÇÀ¢""À ¢¦— ¢–E&öf–ÆRç¦—ÇÀ¢6fVE&öf–ÆRç¦—ÇÀ¢" ¢Ò“° ¢ò ¢ÆöBF†R7W7FöÖW"w26Vç6—F—fP¢4òö6&B–æf÷&ÖF–öâg&öÒF†P¢Væ7'—FVB–BÖ÷&FW"6¶vRà ¢—B7F—2Væ7'—FVBv†Vâ6÷–V@¢–çFòF†RÖævVBÖVÖ&W'6†—à¢¢ð ¢6öç7B–E6V7&WG2Òv—BÖVÖ&W'6†—Væ7'—FVE6¶vR‡–E&V6÷&B“° ¢ÆWBÖVÖ&W'6†—3° ¢–b‡G—RÓÓÒ&g&VR"’°¢ÖVÖ&W'6†—2Ð¢v—BvWDÖævVD66÷VçG2‚“°¢ÒVÇ6R°¢ÖVÖ&W'6†—2Ð¢v—BvWDÖævVD66÷VçG2‚“°¢Ð ¢6öç7B–æFW‚Ð¢ÖVÖ&W'6†—2æf–æD–æFW‚€¢ÖVÖ&W'6†—Óà¢7G&–ær€¢ÖVÖ&W'6†—æ–@¢’ÓÓÒ–@¢“° ¢–b†–æFW‚Â’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢G°¢G—RÓÓÒ&g&VR ¢ò$g&VR ¢¢%&VçFVB ¢ÒÖVÖ&W'6†—6÷VÆBæ÷B&Rf÷VæBæ ¢Ò“°¢Ð ¦6öç7B76–væÖVçG2Ð¢G—RÓÓÒ&g&VR ¢òv—BvWDg&VT76–væÖVçG2‚¢¢v—BvWE&VçFÄ76–væÖVçG2‚“° ¦6öç7B76–væÖVçBÐ¢G—RÓÓÒ&g&VR ¢ò7W'&VçDg&VT76–væÖVçB€¢76–væÖVçG2À¢–@¢¢¢7W'&VçE&VçFÄ76–væÖVçB€¢76–væÖVçG2À¢–@¢“° ¦–b‚76–væÖVçB’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢7F'BF†RG°¢G—RÓÓÒ&g&VR ¢ò&g&VR ¢¢'&VçFVB ¢ÒÖVÖ&W'6†—&Vf÷&RW6–ærWFò÷VÆFRæ ¢Ò“°§Ð ¦–b€¢7G&–ær€¢76–væÖVçBæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢’ÓÐ¢7G&–ær†7W7FöÖW$66÷VçD–B¢’°¢&WGW&â&W0¢ç7FGW2ƒC’¢æ§6öâ‡°¢W'&÷# ¢%F†—2ÖVÖ&W'6†——276–væVBFòF–ffW&VçB7W7FöÖW"â ¢Ò“°§Ð ¦6öç7Bæ÷rÐ¢æWrFFR‚¢çFô•4õ7G&–ær‚“° ¦76–væÖVçBæ7W7FöÖW%&öf–ÆRÐ¢7W7FöÖW%&öf–ÆS° ¦76–væÖVçBæ7W7FöÖW%6V7&WG2Ð¢–E6V7&WG0¢òVæ7'—D§6öâ€¢–E6V7&WG0¢¢¢€¢76–væÖVçBæ7W7FöÖW%6V7&WG2ÇÀ¢çVÆÀ¢“° ¦76–væÖVçBç6÷W&6U–E7V&Ö—76–öä–BÐ¢–E&V6÷&Bæ–C° ¦76–væÖVçBæWFõ÷VÆFVDBÐ¢æ÷s° ¦76–væÖVçBçWFFVDBÐ¢æ÷s° ¦–b‡G—RÓÓÒ&g&VR"’°¢v—B6fTg&VT76–væÖVçG2€¢76–væÖVçG0¢“°§ÒVÇ6R°¢v—B6fU&VçFÄ76–væÖVçG2€¢76–væÖVçG0¢“°§Ð ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ ¢7W7FöÖW%&öf–ÆRÀ ¢ÖW76vS ¢G°¢G—RÓÓÒ&g&VR ¢ò$g&VR ¢¢%&VçFVB ¢ÒÖVÖ&W'6†—WFò÷VÆFVB7V66W76gVÆÇ’æ ¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$ÖævVBÖVÖ&W'6†—WFò÷VÆFRW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFòWFò÷VÆFRF†RÖævVBÖVÖ&W'6†—â ¢Ò“°¢Ð¢Ð¢“° ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢DÔ”â$TåDTBÔTÔ$U%4„•0¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦ævWB€¢"ö’öFÖ–â÷&VçFVBÖÖVÖ&W'6†—2"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BÖVÖ&W'6†—2Ð¢v—BvWDÖævVD66÷VçG2‚“° ¢6öç7B76–væÖVçG2Ð¢v—BvWE&VçFÄ76–væÖVçG2‚“° ¢6öç7B÷F†W$76–væÖVçG2Ð¢v—BvWDg&VT76–væÖVçG2‚“° ¢6öç7B66÷VçG2Ð¢v—BvWD7W7FöÖW$66÷VçG2‚“° ¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7B–E&V6÷&G2Ð¢'&’æ—4'&’‡–B¢ò–@¢¢µÓ° ¢ÆWB76–væÖVçG46†ævVBÐ¢fÇ6S° ¢6öç7Bæ÷rÐ¢æWrFFR‚“° ¢ò ¢WFöÖF–6ÆÇ’W‡—&R&VçFÂ76–væÖVçG0¢v†÷6RVæBFFR†276VBà¢¢ð ¢f÷"€¢6öç7B76–væÖVçBö`¢76–væÖVçG0¢’°¢–b€¢76–væÖVçBæ7F—fRÓÒG'VRÇÀ¢7G&–ær€¢76–væÖVçBæ7F—fF–öå7FGW2ÇÀ¢" ¢’ÓÐ¢&7F—fFVB"ÇÀ¢76–væÖVçBæW‡—&W4@¢’°¢6öçF–çVS°¢Ð ¢6öç7BW‡—&W4BÐ¢æWrFFR€¢76–væÖVçBæW‡—&W4@¢“° ¢–b€¢çVÖ&W"æ—4æâ€¢W‡—&W4BævWEF–ÖR‚¢’b`¢W‡—&W4BævWEF–ÖR‚’ÃÐ¢æ÷rævWEF–ÖR‚¢’°¢6ÆV$ÖævVD76–væÖVçD7W7FöÖW$FF€¢76–væÖVçBÀ¢°¢&V6öã ¢&W‡—&VB"À¢æ÷t—6ó ¢æ÷rçFô•4õ7G&–ær‚¢Ð¢“° ¢76–væÖVçG46†ævVBÐ¢G'VS°¢Ð¢Ð ¢–b†76–væÖVçG46†ævVB’°¢v—B6fU&VçFÄ76–væÖVçG2€¢76–væÖVçG0¢“°¢Ð ¢ò ¢öæÇ’5D•dR”B5T%45$•D”ôå2Ö¢&V6V—fR&VçFVBÖVÖ&W'6†—à¢¢ð ¢6öç7B–D7W7FöÖW$ÖÐ¢æWrÖ‚“° ¢f÷"€¢6öç7B&V6÷&Bö`¢–E&V6÷&G0¢’°¢–b€¢&V6÷&Bæ7W7FöÖW$66÷VçD–BÇÀ¢7V'67&—F–öäÆÆ÷w5&öf–ÆW2€¢&V6÷&@¢¢’°¢6öçF–çVS°¢Ð ¢6öç7BW†—7F–ærÐ¢–D7W7FöÖW$ÖævWB€¢&V6÷&Bæ7W7FöÖW$66÷VçD–@¢“° ¢–b‚W†—7F–ær’°¢–D7W7FöÖW$Öç6WB€¢&V6÷&Bæ7W7FöÖW$66÷VçD–BÀ¢&V6÷&@¢“°¢Ð¢Ð ¢6öç7B–D7W7FöÖW'2Ð¢'&’æg&öÒ€¢–D7W7FöÖW$ÖçfÇVW2‚¢’æÖ‡&V6÷&BÓâ°¢6öç7B66÷VçBÐ¢66÷VçG2æf–æB€¢—FVÒÓà¢—FVÒæ–BÓÓÐ¢&V6÷&Bæ7W7FöÖW$66÷VçD–@¢“° ¢6öç7B6fVE&öf–ÆRÐ¢66÷VçCòæFÖ–å&öf–ÆRb`¢G—Vöb66÷VçBæFÖ–å&öf–ÆRÓÓÐ¢&ö&¦V7B ¢ò66÷VçBæFÖ–å&öf–ÆP¢¢·Ó° ¢6öç7B–E&öf–ÆRÐ¢&V6÷&Bç&öf–ÆRb`¢G—Vöb&V6÷&Bç&öf–ÆRÓÓÐ¢&ö&¦V7B ¢ò&V6÷&Bç&öf–ÆP¢¢·Ó° ¢6öç7B7W7FöÖW$æÖRÐ¢°¢6fVE&öf–ÆRæf—'7DæÖRÇÀ¢–E&öf–ÆRæf—'7DæÖRÇÀ¢""À¢6fVE&öf–ÆRæÆ7DæÖRÇÀ¢–E&öf–ÆRæÆ7DæÖRÇÀ¢" ¢Ð¢æf–ÇFW"„&ööÆVâ¢æ¦ö–â‚""’ÇÀ¢6fVE&öf–ÆRç&öf–ÆTæÖRÇÀ¢–E&öf–ÆRç&öf–ÆTæÖRÇÀ¢$7W7FöÖW"#° ¢&WGW&â°¢7W7FöÖW$66÷VçD–C ¢&V6÷&Bæ7W7FöÖW$66÷VçD–BÀ ¢–E7V&Ö—76–öä–C ¢&V6÷&Bæ–BÀ ¢æÖS ¢7W7FöÖW$æÖRÀ ¢VÖ–Ã ¢66÷VçCòæVÖ–ÂÇÀ¢6fVE&öf–ÆRæVÖ–ÂÇÀ¢–E&öf–ÆRæVÖ–ÂÇÀ¢""À ¢7V'67&—F–öå7FGW3 ¢&V6÷&Bç7V'67&—F–öå7FGW2ÇÀ¢çVÆÂÀ ¢7W'&VçEW&–öDVæC ¢&V6÷&Bæ7W'&VçEW&–öDVæBÇÀ¢çVÆÀ¢Ó°¢Ò“° ¢6öç7B&W7VÇBÐ¢ÖVÖ&W'6†—0¢æf–ÇFW"€¢ÖVÖ&W'6†—Óà¢&ööÆVâ€¢Æ–æ¶VE&VçFÄ76–væÖVçB€¢76–væÖVçG2À¢ÖVÖ&W'6†—æ–@¢¢¢¢æÖ€¢ÖVÖ&W'6†—Óâ°¢6öç7B76–væÖVçBÐ¢Æ–æ¶VE&VçFÄ76–væÖVçB€¢76–væÖVçG2À¢ÖVÖ&W'6†—æ–@¢“° ¢6öç7B÷F†W$76–væÖVçBÐ¢Æ–æ¶VDg&VT76–væÖVçB€¢÷F†W$76–væÖVçG2À¢ÖVÖ&W'6†—æ–@¢“° ¢ÆWB76–væVD7W7FöÖW"Ð¢çVÆÃ° ¢–b†76–væÖVçB’°¢6öç7B66÷VçBÐ¢66÷VçG2æf–æB€¢—FVÒÓà¢—FVÒæ–BÓÓÐ¢76–væÖVç@¢æ7W7FöÖW$66÷VçD–@¢“° ¢6öç7B–E&V6÷&BÐ¢–E&V6÷&G2æf–æB€¢—FVÒÓà¢—FVÒæ7W7FöÖW$66÷VçD–BÓÓÐ¢76–væÖVç@¢æ7W7FöÖW$66÷VçD–Bb`¢7V'67&—F–öäÆÆ÷w5&öf–ÆW2€¢—FVÐ¢¢“° ¢6öç7B6fVE&öf–ÆRÐ¢66÷VçCòæFÖ–å&öf–ÆRb`¢G—Vöb66÷VçBæFÖ–å&öf–ÆRÓÓÐ¢&ö&¦V7B ¢ò66÷VçBæFÖ–å&öf–ÆP¢¢·Ó° ¢6öç7B–E&öf–ÆRÐ¢–E&V6÷&Còç&öf–ÆRb`¢G—Vöb–E&V6÷&Bç&öf–ÆRÓÓÐ¢&ö&¦V7B ¢ò–E&V6÷&Bç&öf–ÆP¢¢·Ó° ¢76–væVD7W7FöÖW"Ò°¢7W7FöÖW$66÷VçD–C ¢76–væÖVç@¢æ7W7FöÖW$66÷VçD–BÀ ¢–E7V&Ö—76–öä–C ¢–E&V6÷&Còæ–BÇÀ¢çVÆÂÀ ¢æÖS ¢°¢6fVE&öf–ÆRæf—'7DæÖRÇÀ¢–E&öf–ÆRæf—'7DæÖRÇÀ¢""À¢6fVE&öf–ÆRæÆ7DæÖRÇÀ¢–E&öf–ÆRæÆ7DæÖRÇÀ¢" ¢Ð¢æf–ÇFW"„&ööÆVâ¢æ¦ö–â‚""’ÇÀ¢6fVE&öf–ÆRç&öf–ÆTæÖRÇÀ¢–E&öf–ÆRç&öf–ÆTæÖRÇÀ¢$7W7FöÖW""À ¢VÖ–Ã ¢66÷VçCòæVÖ–ÂÇÀ¢6fVE&öf–ÆRæVÖ–ÂÇÀ¢–E&öf–ÆRæVÖ–ÂÇÀ¢" ¢Ó°¢Ð ¢ÆWB&WF–ÆW'2Ð¢V×G•&WF–ÆW$7&VFVçF–Ç2‚“° §G'’°¢–b€¢ÖVÖ&W'6†—æ7&VFVçF–Ç0¢’°¢&WF–ÆW'2Ð¢æ÷&ÖÆ—¦U&WF–ÆW$7&VFVçF–Ç2€¢FV7'—D§6öâ€¢ÖVÖ&W'6†—æ7&VFVçF–Ç0¢¢“°¢Ð§Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢%&VçFVBÖVÖ&W'6†—FV7'—BW'&÷#¢"À¢ÖVÖ&W'6†—æ–BÀ¢W'&÷"æÖW76vP¢“°§Ð ¦ÆWB7W7FöÖW%6V7&WG2Ð¢çVÆÃ° §G'’°¢–b€¢76–væÖVçCòæ7W7FöÖW%6V7&WG0¢’°¢7W7FöÖW%6V7&WG2Ð¢FV7'—D§6öâ€¢76–væÖVçBæ7W7FöÖW%6V7&WG0¢“°¢Ð§Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢%&VçFVBÖVÖ&W'6†—7W7FöÖW"FFFV7'—BW'&÷#¢"À¢ÖVÖ&W'6†—æ–BÀ¢W'&÷"æÖW76vP¢“°§Ð¢ ¢6öç7B&VF–æW72Ð¢ÖævVE&öf–ÆU&VF–æW72€¢76–væÖVçCòæ7W7FöÖW%&öf–ÆRÇÀ¢·ÒÀ¢7W7FöÖW%6V7&WG2ÇÀ¢·Ð¢“° ¢6öç7BW†7DFG&W74ÖF6†W2Ð¢W†7DÖævVDFG&W74ÖF6†W2€¢76–væÖVçCòæ7W7FöÖW%&öf–ÆRÇÀ¢·ÒÀ¢ÖVÖ&W'6†—æ–BÀ¢ÖVÖ&W'6†—2À¢÷F†W$76–væÖVçG2À¢76–væÖVçG0¢“° ¢&WGW&â°¢–C ¢ÖVÖ&W'6†—æ–BÀ ¢&öf–ÆTæÖS ¢ÖVÖ&W'6†—ç&öf–ÆTæÖRÇÀ¢%$TåDTBÔTÔ$U%4„•"À ¢66÷VçDVÖ–Ã ¢ÖVÖ&W'6†—æ66÷VçDVÖ–ÂÇÀ¢""À ¢F—7Æ”VÖ–Ã ¢ÖævVD66÷VçD6æöæ–6ÄVÖ–Â€¢ÖVÖ&W'6†—À¢&WF–ÆW'0¢’À ¢æ÷FW3 ¢ÖVÖ&W'6†—ææ÷FW2ÇÀ¢""À ¢7&VFVDC ¢ÖVÖ&W'6†—æ7&VFVDBÇÀ¢çVÆÂÀ ¢WFFVDC ¢ÖVÖ&W'6†—çWFFVDBÇÀ¢çVÆÂÀ ¢7F—fS ¢&ööÆVâ€¢76–væÖVç@¢’À ¢7FGW3 ¢76–væÖVç@¢ò&7F—fR ¢¢€¢÷F†W$76–væÖVç@¢ò&ö67W–VB ¢¢&–æ7F—fR ¢’À ¢ö67W–VD'”÷F†W%G—S ¢&ööÆVâ€¢÷F†W$76–væÖVç@¢’À ¢ö67W–VEG—S ¢÷F†W$76–væÖVç@¢ò&g&VR ¢¢çVÆÂÀ ¢76–væÖVçC ¢76–væÖVç@¢ò°¢–C ¢76–væÖVçBæ–BÀ ¢7W7FöÖW$66÷VçD–C ¢76–væÖVç@¢æ7W7FöÖW$66÷VçD–BÀ ¢7F'G4C ¢76–væÖVçBç7F'G4BÇÀ¢çVÆÂÀ ¢W‡—&W4C ¢76–væÖVçBæW‡—&W4BÇÀ¢çVÆÂÀ ¢GW&F–öåG—S ¢76–væÖVçBæGW&F–öåG—RÇÀ¢çVÆÂÀ ¢7F—fF–öå7FGW3 ¢ÖævVD76–væÖVçE7FGW2€¢76–væÖVç@¢’À ¢7F—fF–öäÆ&VÃ ¢&öf–ÆT7F—fF–öäÆ&VÂ€¢76–væÖVçBæ7F—fF–öå7FGW0¢’À ¢F—5&VÖ–æ–æs ¢&VçFÄ76–væÖVçDF—5&VÖ–æ–ær€¢76–væÖVç@¢’À ¢7G&—U7V'67&—F–öä–C ¢76–væÖVç@¢ç7G&—U7V'67&—F–öä–BÇÀ¢çVÆÀ¢Ð¢¢çVÆÂÀ ¢76–væVD7W7FöÖW"À §&WF–ÆW'2À ¦7W7FöÖW%&öf–ÆS ¢76–væÖVçCòæ7W7FöÖW%&öf–ÆRÇÀ¢çVÆÂÀ ¦7W7FöÖW%6V7&WG2À ¢&VF–æW72À ¢W†7DFG&W74ÖF6†W2À ¢¦–vvVDFG&W73 ¢76–væÖVçCòæ¦–vvVDFG&W72ÇÀ¢çVÆÂÀ ¢¦–uf&–çDçVÖ&W# ¢76–væÖVçCòæ¦–uf&–çD–æFW‚ÇÀ¢çVÆÀ¢Ó°¢Ð¢“° ¢6öç7B°¢f–Æ&ÆTÖVÖ&W'6†—2À¢&W7F÷&T†öÆG0¢ÒÒv—B&öÖ—6RæÆÂ…°¢vWDf–Æ&ÆTÖævVDÖVÖ&W'6†—&V6÷&G2‚’À¢vWE&W7F÷&T†öÆG2‚¢Ò“° ¢6öç7B7F—fU&W7F÷&T†öÆG2Ð¢7F—fU&W7F÷&T†öÆG4f÷"€¢&W7F÷&T†öÆG2À¢°¢G—S ¢'&VçFVB ¢Ð¢’æÖ€¢†öÆBÓâ‡°¢–C ¢†öÆBæ–BÀ ¢7W7FöÖW$66÷VçD–C ¢†öÆBæ7W7FöÖW$66÷VçD–BÀ ¢G—S ¢†öÆBçG—RÀ ¢†öÆEVçF–Ã ¢†öÆBæ†öÆEVçF–ÂÀ ¢6÷VçC ¢&W7F÷&T†öÆE&VÖ–æ–æt—FV×2€¢†öÆ@¢’æÆVæwF‚À ¢7W7FöÖW$æÖS ¢€¢–D7W7FöÖW'2æf–æB€¢7W7FöÖW"Óà¢7G&–ær€¢7W7FöÖW"æ7W7FöÖW$66÷VçD–BÇÀ¢" ¢’ÓÓÐ¢7G&–ær€¢†öÆBæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢¢“òææÖP¢’ÇÀ¢€¢66÷VçG2æf–æB€¢66÷VçBÓà¢7G&–ær€¢66÷VçBæ–@¢’ÓÓÐ¢7G&–ær€¢†öÆBæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢¢“òæVÖ–À¢’ÇÀ¢$7W7FöÖW""À ¢7W7FöÖW$VÖ–Ã ¢€¢–D7W7FöÖW'2æf–æB€¢7W7FöÖW"Óà¢7G&–ær€¢7W7FöÖW"æ7W7FöÖW$66÷VçD–BÇÀ¢" ¢’ÓÓÐ¢7G&–ær€¢†öÆBæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢¢“òæVÖ–À¢’ÇÀ¢€¢66÷VçG2æf–æB€¢66÷VçBÓà¢7G&–ær€¢66÷VçBæ–@¢’ÓÓÐ¢7G&–ær€¢†öÆBæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢¢“òæVÖ–À¢’ÇÀ¢""À ¢6å&W7F÷&S ¢–Ú±î¸Â¸­yêë¢°k¢G§¦*^dCustomers.some(
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
   !¶¬{®0®+^zºè¬è‘ééŠ—‚v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7B–E&V6÷&G2Ð¢'&’æ—4'&’‡–B¢ò–@¢¢µÓ° ¢6öç7B–E&V6÷&BÐ¢–E&V6÷&G2æf–æB€¢&V6÷&BÓà¢7G&–ær‡&V6÷&Bæ–B’ÓÓÐ¢7G&–ær‡7V&Ö—76–öä–B¢“° ¢–b‚–E&V6÷&B’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢$7W7FöÖW"7V&Ö—76–öâ6÷VÆBæ÷B&Rf÷VæBâ ¢Ò“°¢Ð ¢6öç7B76–væÖVçG2Ð¢G—RÓÓÒ&g&VR ¢òv—BvWDg&VT76–væÖVçG2‚¢¢v—BvWE&VçFÄ76–væÖVçG2‚“° ¢6öç7B76–væÖVçBÐ¢G—RÓÓÒ&g&VR ¢òÆ–æ¶VDg&VT76–væÖVçB€¢76–væÖVçG2À¢–@¢¢¢Æ–æ¶VE&VçFÄ76–væÖVçB€¢76–væÖVçG2À¢–@¢“° ¢–b‚76–væÖVçB’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢%F†—2Æ–æ¶VB&öf–ÆR—2æòÆöævW"76–væVBFòF†—27W7FöÖW"â ¢Ò“°¢Ð ¢–b€¢7G&–ær€¢76–væÖVçBæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢’ÓÐ¢7G&–ær€¢–E&V6÷&Bæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢¢’°¢&WGW&â&W0¢ç7FGW2ƒC2¢æ§6öâ‡°¢W'&÷# ¢%F†—2Æ–æ¶VB&öf–ÆRFöW2æ÷B&VÆöærFòF†—27W7FöÖW"â ¢Ò“°¢Ð ¢6öç7B7W7FöÖW%&öf–ÆRÐ¢6æ—F—¦U&öf–ÆR‡°¢&öf–ÆTæÖS ¢6ÆVâ€¢&Wæ&öG“òç&öf–ÆTæÖRÇÀ¢76–væÖVçBæ7W7FöÖW%&öf–ÆP¢òç&öf–ÆTæÖRÇÀ¢""À¢S ¢’À ¢f—'7DæÖS ¢&Wæ&öG“òæf—'7DæÖRÀ ¢Æ7DæÖS ¢&Wæ&öG“òæÆ7DæÖRÀ ¢VÖ–Ã ¢&Wæ&öG“òæVÖ–ÂÀ ¢†öæS ¢&Wæ&öG“òç†öæRÀ ¢FG&W73 ¢&Wæ&öG“òæFG&W72À ¢FG&W73# ¢&Wæ&öG“òæFG&W73"À ¢6÷VçG'“ ¢&Wæ&öG“òæ6÷VçG'’À ¢7FFS ¢&Wæ&öG“òç7FFRÀ ¢6—G“ ¢&Wæ&öG“òæ6—G’À ¢¦— ¢&Wæ&öG“òç¦— ¢Ò“° ¢6öç7B7W7FöÖW%6V7&WG2Ð¢6æ—F—¦U6V7&WG2‡°¢6ôVÖ–Ã ¢&Wæ&öG“òæ6ôVÖ–ÂÀ ¢6õ77v÷&C ¢&Wæ&öG“òæ6õ77v÷&BÀ ¢6&DÆ&VÃ ¢&Wæ&öG“òæ6&DÆ&VÂÀ ¢6&F†öÆFW# ¢&Wæ&öG“òæ6&F†öÆFW"À ¢6ô6&DçVÖ&W# ¢&Wæ&öG“òæ6ô6&DçVÖ&W"À ¢W‡ÖöçFƒ ¢&Wæ&öG“òæW‡ÖöçF‚À ¢W‡–V# ¢&Wæ&öG“òæW‡–V"À ¢6V7W&—G”6öFS ¢&Wæ&öG“òç6V7W&—G”6öFP¢Ò“° ¢76–væÖVçBæ7W7FöÖW%&öf–ÆRÐ¢7W7FöÖW%&öf–ÆS° ¢76–væÖVçBæ7W7FöÖW%6V7&WG2Ð¢Væ7'—D§6öâ€¢7W7FöÖW%6V7&WG0¢“° ¢76–væÖVçBçWFFVDBÐ¢æWrFFR‚¢çFô•4õ7G&–ær‚“° ¢ò ¢–bFÖ–âÖçVÆÇ’VF—G2F†RFG&W72gFW"¤”rÂF†RÖçVÀ¢VF—B&V6öÖW2WF†÷&—FF—fRæBF†RöÆB¤”rÖWFFF—26ÆV&VBà¢¢ð¢FVÆWFR76–væÖVçBæ¦–vvVDFG&W73°¢FVÆWFR76–væÖVçBæ¦–uf&–çD–æFWƒ°¢FVÆWFR76–væÖVçBæ¦–u6÷W&6T¶W“°¢FVÆWFR76–væÖVçBæ¦–u6÷W&6TFG&W73° ¢ò ¢¶VW¦–t†—7F÷'”¶W—26ò&Wf–÷W6Ç’vVæW&FVBW†7B¤”w0¢7F’Væf–Æ&ÆRWfVâgFW"ÖçVÂVF—F–ærà¢¢ð ¢–b‡G—RÓÓÒ&g&VR"’°¢v—B6fTg&VT76–væÖVçG2€¢76–væÖVçG0¢“°¢ÒVÇ6R°¢v—B6fU&VçFÄ76–væÖVçG2€¢76–væÖVçG0¢“°¢Ð ¢–b€¢76–væÖVçBæ7W7FöÖW$66÷VçD–@¢’°¢v—B7–æ47W7FöÖW$Ö—76–ætæ÷F–f–6F–öâ€¢76–væÖVçBæ7W7FöÖW$66÷VçD–@¢“°¢Ð ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢7W7FöÖW%&öf–ÆRÀ ¢7W7FöÖW$6&C¢°¢6&DÆ&VÃ ¢7W7FöÖW%6V7&WG2æ6&DÆ&VÂÇÀ¢""À ¢6&F†öÆFW# ¢7W7FöÖW%6V7&WG2æ6&F†öÆFW"ÇÀ¢""À ¢6&DçVÖ&W# ¢7W7FöÖW%6V7&WG2æ6ô6&DçVÖ&W"ÇÀ¢""À ¢Ö6¶VDçVÖ&W# ¢7W7FöÖW%6V7&WG2æ6ô6&DçVÖ&W ¢ò(
.(
.(
.(
"(
.(
.(
.(
"(
.(
.(
.(
"G¶7W7FöÖW%6V7&WG2æ6ô6&DçVÖ&W"ç6Æ–6R‚ÓB—Ö ¢¢""À ¢W‡ÖöçFƒ ¢7W7FöÖW%6V7&WG2æW‡ÖöçF‚ÇÀ¢""À ¢W‡–V# ¢7W7FöÖW%6V7&WG2æW‡–V"ÇÀ¢""À ¢6V7W&—G”6öFS ¢7W7FöÖW%6V7&WG2ç6V7W&—G”6öFRÇÀ¢" ¢Ð¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$Æ–æ¶VB&öf–ÆRWFFRW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFòWFFRÆ–æ¶VB&öf–ÆR–æf÷&ÖF–öââ ¢Ò“°¢Ð¢Ð¢“°    ¦7–æ2gVæ7F–öâ&W7F÷&T†VÆDÖævVD66÷VçG4f÷$7W7FöÖW"€¢7W7FöÖW$66÷VçD–BÀ¢G—P¢’°¢–b€¢7W7FöÖW$66÷VçD–BÇÀ¢°¢&g&VR"À¢'&VçFVB ¢Òæ–æ6ÇVFW2‡G—R¢’°¢F‡&÷ræWrW'&÷"€¢$–çfÆ–B&W7F÷&R†öÆB&WVW7Bâ ¢“°¢Ð ¢6öç7B†öÆG2Ð¢v—BvWE&W7F÷&T†öÆG2‚“° ¢6öç7B6æF–FFT—FV×2Ð¢7F—fU&W7F÷&T†öÆG4f÷"€¢†öÆG2À¢°¢7W7FöÖW$66÷VçD–BÀ¢G—P¢Ð¢’æfÆDÖ€¢†öÆBÓà¢&W7F÷&T†öÆE&VÖ–æ–æt—FV×2€¢†öÆ@¢¢“° ¢–b‚6æF–FFT—FV×2æÆVæwF‚’°¢&WGW&â°¢&W7F÷&VC ¢À¢ÖævVD66÷VçD–G3 ¢µÐ¢Ó°¢Ð ¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7B–E&V6÷&G2Ð¢'&’æ—4'&’‡–B¢ò–@¢¢µÓ° ¢6öç7B–E&V6÷&BÒv—B7F—fTÖVÖ&W'6†—&V6÷&Df÷$7W7FöÖW"†7W7FöÖW$66÷VçD–BÂ–E&V6÷&G2“° ¢–b‚–E&V6÷&B’°¢F‡&÷ræWrW'&÷"€¢%F†—27W7FöÖW"FöW2æ÷B7W'&VçFÇ’†fRâ7F—fR–B÷"v–gFVBF–W"â ¢“°¢Ð ¢6öç7B°¢ÖævVD66÷VçG2À¢g&VT76–væÖVçG2À¢&VçFÄ76–væÖVçG0¢ÒÒv—B&öÖ—6RæÆÂ…°¢vWDÖævVD66÷VçG2‚’À¢vWDg&VT76–væÖVçG2‚’À¢vWE&VçFÄ76–væÖVçG2‚¢Ò“° ¢6öç7BW6VD–G2Ð¢æWr6WB‚“° ¢f÷"€¢6öç7B76–væÖVçBö`¢°¢ââæg&VT76–væÖVçG2À¢ââç&VçFÄ76–væÖVçG0¢Ð¢’°¢–b€¢ÖævVD76–væÖVçD—4Æ–æ¶VB€¢76–væÖVç@¢¢’°¢W6VD–G2æFB€¢ÖævVD76–væÖVçDÖVÖ&W'6†—–B€¢76–væÖVç@¢¢“°¢Ð¢Ð ¢6öç7BGWÆ–6FU7FFRÐ¢ÖævVDGWÆ–6FT7&VFVçF–Å7FFR€¢ÖævVD66÷VçG2À¢W6VD–G0¢“° ¢6öç7B7W'&VçDÖævVD–G2Ð¢æWr6WB€¢ÖævVD66÷VçG2æÖ€¢—FVÒÓà¢7G&–ær€¢—FVÒæ–@¢¢¢“° ¢6öç7B7W7FöÖW%&öf–ÆRÐ¢6æ—F—¦U&öf–ÆR€¢–E&V6÷&Bç&öf–ÆRÇÀ¢·Ð¢“° ¢6öç7B–E6V7&WG2Òv—BÖVÖ&W'6†—Væ7'—FVE6¶vR‡–E&V6÷&B“° ¢6öç7Bæ÷rÐ¢æWrFFR‚“° ¢6öç7BF&vWD76–væÖVçG2Ð¢G—RÓÓÒ&g&VR ¢òg&VT76–væÖVçG0¢¢&VçFÄ76–væÖVçG3° ¢6öç7B&W7F÷&VD–G2ÒµÓ° ¢f÷"€¢6öç7B—FVÒö`¢6æF–FFT—FV×0¢’°¢6öç7BÖævVD66÷VçD–BÐ¢7G&–ær€¢—FVÒæÖævVD66÷VçD–BÇÀ¢" ¢“° ¢–b€¢ÖævVD66÷VçD–BÇÀ¢7W'&VçDÖævVD–G2æ†2€¢ÖævVD66÷VçD–@¢’ÇÀ¢W6VD–G2æ†2€¢ÖævVD66÷VçD–@¢’ÇÀ¢GWÆ–6FU7FFP¢æGWÆ–6FT–G0¢æ†2€¢ÖævVD66÷VçD–@¢¢’°¢6öçF–çVS°¢Ð ¢6öç7BGW&F–öåG—RÐ¢æ÷&ÖÆ—¦U7V6–Å&öf–ÆTGW&F–öâ€¢—FVÒæGW&F–öåG—P¢’ÇÀ¢#÷vVV²#° ¢6öç7B76–væÖVçBÒ°¢–C ¢7'—Fòç&æFöÕUT”B‚’À ¢ÖævVD66÷VçD–BÀ ¢7W7FöÖW$66÷VçD–BÀ ¢–E7V&Ö—76–öä–C ¢–E&V6÷&Bæ–BÀ ¢7F—fS ¢G'VRÀ ¢GW&F–öåG—RÀ ¢7F—fF–öå7FGW3 ¢&v—F–æuö7F—fF–öâ"À ¢7F—fF–öå&WVW7FVDC ¢æ÷rçFô•4õ7G&–ær‚’À ¢7F'G4C ¢çVÆÂÀ ¢W‡—&W4C ¢çVÆÂÀ ¢7W7FöÖW%&öf–ÆRÀ ¢7W7FöÖW%6V7&WG3 ¢–E6V7&WG0¢òVæ7'—D§6öâ€¢–E6V7&WG0¢¢¢çVÆÂÀ ¢7&VFVDC ¢æ÷rçFô•4õ7G&–ær‚’À ¢WFFVDC ¢æ÷rçFô•4õ7G&–ær‚’À ¢VæFVDC ¢çVÆÂÀ ¢VæE&V6öã ¢çVÆÀ¢Ó° ¢–b€¢G—RÓÓÒ&g&VR ¢’°¢76–væÖVçBæg&VTÖVÖ&W'6†—–BÐ¢ÖævVD66÷VçD–C° ¢76–væÖVçBæ76–væÖVçE&WF–ÆW"Ð¢—FVÒç&WF–ÆW"ÇÀ¢çVÆÃ° ¢ÒVÇ6R°¢76–væÖVçBç&VçFVDÖVÖ&W'6†—–BÐ¢ÖævVD66÷VçD–C° ¢76–væÖVçBç&VçFÅ&WF–ÆW"Ð¢—FVÒç&WF–ÆW"ÇÀ¢çVÆÃ° ¢76–væÖVçBç7G&—U7V'67&—F–öä–BÐ¢çVÆÃ° ¢76–væÖVçBç7G&—T7W7FöÖW$–BÐ¢–E&V6÷&Bç7G&—T7W7FöÖW$–BÇÀ¢çVÆÃ°¢Ð ¢F&vWD76–væÖVçG2çW6‚€¢76–væÖVç@¢“° ¢W6VD–G2æFB€¢ÖævVD66÷VçD–@¢“° ¢&W7F÷&VD–G2çW6‚€¢ÖævVD66÷VçD–@¢“°¢Ð ¢–b€¢G—RÓÓÒ&g&VR ¢’°¢v—B6fTg&VT76–væÖVçG2€¢g&VT76–væÖVçG0¢“°¢ÒVÇ6R°¢v—B6fU&VçFÄ76–væÖVçG2€¢&VçFÄ76–væÖVçG0¢“°¢Ð ¢f÷"€¢6öç7B76–væÖVçBö`¢F&vWD76–væÖVçG0¢’°¢–b€¢&W7F÷&VD–G2æ–æ6ÇVFW2€¢ÖævVD76–væÖVçDÖVÖ&W'6†—–B€¢76–væÖVç@¢¢’b`¢76–væÖVçBæ7F—fF–öå7FGW2ÓÓÐ¢&v—F–æuö7F—fF–öâ ¢’°¢v—BVç7W&TÖævVE&öf–ÆTF—66÷&DÖW76vR€¢76–væÖVçBÀ¢G—P¢“°¢Ð¢Ð ¢–b€¢G—RÓÓÒ&g&VR ¢’°¢v—B6fTg&VT76–væÖVçG2€¢g&VT76–væÖVçG0¢“°¢ÒVÇ6R°¢v—B6fU&VçFÄ76–væÖVçG2€¢&VçFÄ76–væÖVçG0¢“°¢Ð ¢v—B6öç7VÖU&W7F÷&T†öÆD—FV×2€¢7W7FöÖW$66÷VçD–BÀ¢G—RÀ¢&W7F÷&VD–G0¢“° ¢&WGW&â°¢&W7F÷&VC ¢&W7F÷&VD–G2æÆVæwF‚À ¢ÖævVD66÷VçD–G3 ¢&W7F÷&VD–G0¢Ó°§Ð  ¦ç÷7B€¢"ö’öFÖ–â÷&W7F÷&RÖ†öÆG2ó§G—Ró¦7W7FöÖW$66÷VçD–B÷&W7F÷&R"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BG—RÐ¢6ÆVâ€¢&Wç&×2çG—RÀ¢# ¢“° ¢6öç7B7W7FöÖW$66÷VçD–BÐ¢6ÆVâ€¢&Wç&×2æ7W7FöÖW$66÷VçD–BÀ¢S ¢“° ¢–b€¢°¢&g&VR"À¢'&VçFVB ¢Òæ–æ6ÇVFW2‡G—R’ÇÀ¢7W7FöÖW$66÷VçD–@¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$–çfÆ–B&W7F÷&R†öÆB&WVW7Bâ ¢Ò“°¢Ð ¢6öç7B&W7VÇBÐ¢v—B&W7F÷&T†VÆDÖævVD66÷VçG4f÷$7W7FöÖW"€¢7W7FöÖW$66÷VçD–BÀ¢G—P¢“° ¢–b€¢&W7VÇBç&W7F÷&V@¢’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢$æò&W7F÷&&ÆRÖævVB66÷VçG2&R7W'&VçFÇ’öâ†öÆBf÷"F†—27W7FöÖW"â ¢Ò“°¢Ð ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ ¢&W7F÷&VC ¢&W7VÇBç&W7F÷&VBÀ ¢ÖW76vS ¢G·&W7VÇBç&W7F÷&VGÒG·G—RÓÓÒ&g&VR"ò&v–gFVB"¢'&VçFVB'Ò66÷VçBG·&W7VÇBç&W7F÷&VBÓÓÒò""¢'2'Ò&W7F÷&VBFòÆ–æ¶VB&öf–ÆW2æ ¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢%&W7F÷&R†öÆB&W7F÷&RW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢W'&÷"æÖW76vRÇÀ¢%Væ&ÆRFò&W7F÷&RÖævVB66÷VçG2â ¢Ò“°¢Ð¢Ð¢“°  ¦ç÷7B€¢"ö’öFÖ–â÷&W7F÷&RÖ†öÆG2ó§G—Ró¦7W7FöÖW$66÷VçD–B÷&VÆV6R"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BG—RÐ¢6ÆVâ€¢&Wç&×2çG—RÀ¢# ¢“° ¢6öç7B7W7FöÖW$66÷VçD–BÐ¢6ÆVâ€¢&Wç&×2æ7W7FöÖW$66÷VçD–BÀ¢S ¢“° ¢–b€¢°¢&g&VR"À¢'&VçFVB ¢Òæ–æ6ÇVFW2‡G—R’ÇÀ¢7W7FöÖW$66÷VçD–@¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$–çfÆ–B&W7F÷&R†öÆB&WVW7Bâ ¢Ò“°¢Ð ¢6öç7B&VÆV6VBÐ¢v—B×WFFU&W7F÷&T†öÆG2€¢7–æ2†öÆG2Óâ°¢6öç7B7F—fRÐ¢7F—fU&W7F÷&T†öÆG4f÷"€¢†öÆG2À¢°¢7W7FöÖW$66÷VçD–BÀ¢G—P¢Ð¢“° ¢6öç7Bæ÷t—6òÐ¢æWrFFR‚¢çFô•4õ7G&–ær‚“° ¢ÆWB6÷VçBÐ¢° ¢f÷"€¢6öç7B†öÆBö`¢7F—fP¢’°¢f÷"€¢6öç7B—FVÒö`¢&W7F÷&T†öÆE&VÖ–æ–æt—FV×2€¢†öÆ@¢¢’°¢—FVÒç&VÆV6VDBÐ¢æ÷t—6ó° ¢6÷VçB³Ò°¢Ð ¢†öÆBç7FGW2Ð¢'&VÆV6VB#° ¢†öÆBç&VÆV6VDBÐ¢æ÷t—6ó° ¢†öÆBç&VÆV6U&V6öâÐ¢&FÖ–å÷&VÆV6VB#° ¢†öÆBçWFFVDBÐ¢æ÷t—6ó°¢Ð ¢&WGW&â6÷VçC°¢Ð¢“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ ¢&VÆV6VBÀ ¢ÖW76vS ¢G·&VÆV6VGÒ†VÆBÖævVB66÷VçBG·&VÆV6VBÓÓÒò""¢'2'Ò&VÆV6VBFòF†Ræ÷&ÖÂf–Æ&ÆRööÂæ ¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢%&W7F÷&R†öÆB&VÆV6RW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFò&VÆV6R&W7F÷&R†öÆBâ ¢Ò“°¢Ð¢Ð¢“°  ¦ç÷7B€¢"ö’öFÖ–âöÆ–æ¶VBÖÖVÖ&W'6†—2ög&VRó¦–BöW‡FVæB"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B–BÐ¢6ÆVâ€¢&Wç&×2æ–BÀ¢S ¢“° ¢6öç7BW‡FVç6–öâÐ¢6ÆVâ€¢&Wæ&öG“òæW‡FVç6–öâÀ¢3 ¢¢çG&–Ò‚¢çFôÆ÷vW$66R‚“° ¢–b€¢°¢#÷vVV²"À¢#öÖöçF‚"À¢&–æFVf–æ—FR ¢Òæ–æ6ÇVFW2€¢W‡FVç6–öà¢¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$6†ö÷6RvVV²ÂÖöçF‚Â÷"–æFVf–æ—FVÇ’â ¢Ò“°¢Ð ¢6öç7B76–væÖVçG2Ð¢v—BvWDg&VT76–væÖVçG2‚“° ¢6öç7B76–væÖVçBÐ¢Æ–æ¶VDg&VT76–væÖVçB€¢76–væÖVçG2À¢–@¢“° ¢–b‚76–væÖVçB’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢$v–gFVB&öf–ÆR76–væÖVçB6÷VÆBæ÷B&Rf÷VæBâ ¢Ò“°¢Ð ¢6öç7Bæ÷rÐ¢æWrFFR‚“° ¢6öç7B&6RÐ¢76–væÖVçBæW‡—&W4Bb`¢æWrFFR€¢76–væÖVçBæW‡—&W4@¢’ævWEF–ÖR‚’à¢æ÷rævWEF–ÖR‚¢òæWrFFR€¢76–væÖVçBæW‡—&W4@¢¢¢æ÷s° ¢–b€¢W‡FVç6–öâÓÓÐ¢&–æFVf–æ—FR ¢’°¢76–væÖVçBæW‡—&W4BÐ¢çVÆÃ° ¢76–væÖVçBæGW&F–öåG—RÐ¢&–æFVf–æ—FR#° ¢ÒVÇ6R–b€¢W‡FVç6–öâÓÓÐ¢#÷vVV² ¢’°¢&6Rç6WDFFR€¢&6RævWDFFR‚’²p¢“° ¢76–væÖVçBæW‡—&W4BÐ¢&6RçFô•4õ7G&–ær‚“° ¢76–væÖVçBæGW&F–öåG—RÐ¢#÷vVV²#° ¢ÒVÇ6R°¢&6Rç6WDÖöçF‚€¢&6RævWDÖöçF‚‚’²¢“° ¢76–væÖVçBæW‡—&W4BÐ¢&6RçFô•4õ7G&–ær‚“° ¢76–væÖVçBæGW&F–öåG—RÐ¢#öÖöçF‚#°¢Ð ¢76–væÖVçBæ7F—fRÐ¢G'VS° ¢–b€¢7G&–ær€¢76–væÖVçBæ7F—fF–öå7FGW2ÇÀ¢" ¢’ÓÓÒ&W‡—&VB ¢’°¢76–væÖVçBæ7F—fF–öå7FGW2Ð¢&7F—fFVB#°¢Ð ¢76–væÖVçBçWFFVDBÐ¢æ÷rçFô•4õ7G&–ær‚“° ¢v—B6fTg&VT76–væÖVçG2€¢76–væÖVçG0¢“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢W‡—&W4C ¢76–væÖVçBæW‡—&W4BÇÀ¢çVÆÂÀ¢GW&F–öåG—S ¢76–væÖVçBæGW&F–öåG—P¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$W‡FVæBv–gFVB&öf–ÆRW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFòW‡FVæBv–gFVB&öf–ÆRâ ¢Ò“°¢Ð¢Ð¢“°  ¦ç÷7B€¢"ö’öFÖ–âöÆ–æ¶VBÖÖVÖ&W'6†—2ó§G—Ró¦–BöW‡FVæB"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BG—RÐ¢6ÆVâ€¢&Wç&×2çG—RÀ¢# ¢“° ¢6öç7B–BÐ¢6ÆVâ€¢&Wç&×2æ–BÀ¢S ¢“° ¢6öç7BW‡FVç6–öâÐ¢6ÆVâ€¢&Wæ&öG“òæW‡FVç6–öâÀ¢3 ¢¢çG&–Ò‚¢çFôÆ÷vW$66R‚“° ¢–b€¢°¢&g&VR"À¢'&VçFVB ¢Òæ–æ6ÇVFW2€¢G—P¢¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$–çfÆ–BÖævVB&öf–ÆRG—Râ ¢Ò“°¢Ð ¢6öç7BÆÆ÷vVBÐ¢G—RÓÓÒ&g&VR ¢ò°¢#÷vVV²"À¢#öÖöçF‚"À¢&–æFVf–æ—FR ¢Ð¢¢°¢#÷vVV²"À¢#öÖöçF‚ ¢Ó° ¢–b€¢ÆÆ÷vVBæ–æ6ÇVFW2€¢W‡FVç6–öà¢¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢G—RÓÓÒ&g&VR ¢ò$6†ö÷6RvVV²ÂÖöçF‚Â÷"–æFVf–æ—FVÇ’â ¢¢$6†ö÷6RvVV²÷"ÖöçF‚â ¢Ò“°¢Ð ¢6öç7B76–væÖVçG2Ð¢G—RÓÓÒ&g&VR ¢òv—BvWDg&VT76–væÖVçG2‚¢¢v—BvWE&VçFÄ76–væÖVçG2‚“° ¢6öç7B76–væÖVçBÐ¢G—RÓÓÒ&g&VR ¢òÆ–æ¶VDg&VT76–væÖVçB€¢76–væÖVçG2À¢–@¢¢¢Æ–æ¶VE&VçFÄ76–væÖVçB€¢76–væÖVçG2À¢–@¢“° ¢–b‚76–væÖVçB’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢G·G—RÓÓÒ&g&VR"ò$v–gFVB"¢%&VçFVB'Ò&öf–ÆR76–væÖVçB6÷VÆBæ÷B&Rf÷VæBæ ¢Ò“°¢Ð ¢6öç7Bæ÷rÐ¢æWrFFR‚“° ¢6öç7B&6RÐ¢76–væÖVçBæW‡—&W4Bb`¢æWrFFR€¢76–væÖVçBæW‡—&W4@¢’ævWEF–ÖR‚’à¢æ÷rævWEF–ÖR‚¢òæWrFFR€¢76–væÖVçBæW‡—&W4@¢¢¢æ÷s° ¢–b€¢W‡FVç6–öâÓÓÐ¢&–æFVf–æ—FR ¢’°¢76–væÖVçBæW‡—&W4BÐ¢çVÆÃ° ¢76–væÖVçBæGW&F–öåG—RÐ¢&–æFVf–æ—FR#° ¢ÒVÇ6R–b€¢W‡FVç6–öâÓÓÐ¢#÷vVV² ¢’°¢&6Rç6WDFFR€¢&6RævWDFFR‚’²p¢“° ¢76–væÖVçBæW‡—&W4BÐ¢&6RçFô•4õ7G&–ær‚“° ¢76–væÖVçBæGW&F–öåG—RÐ¢#÷vVV²#° ¢ÒVÇ6R°¢&6Rç6WDÖöçF‚€¢&6RævWDÖöçF‚‚’²¢Ú±î¸Â¸­yêë¢°k¢G§¦*^    );

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
            `${customerName} Paid Profile ${paidNumber}`,

          accountEmail:
            record.customerProfile
              ?.email ||
            "",

          exportReady:
            status.exportReady,

          missingFields:
            status.missingFields
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
              type === "free"
                ? `${customerName} Gifted ${number}`
                : `${customerName} Rented ${number}`,

            accountEmail:
              membership?.accountEmail ||
              "",

            exportReady:
              status.exportReady,

            missingFields:
              status.missingFields
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
       m«ëŒ+Š×ž®º+º$zzb¥â$W‡÷'B÷F–öç2W'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFòÆöBW‡÷'B&öf–ÆR÷F–öç2â ¢Ò“°¢Ð¢Ð¢“°  ¦ç÷7B€¢"ö’öFÖ–â÷7V&Ö—76–öç2ó¦–BöW‡÷'B×&öf–ÆW2"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B–BÐ¢6ÆVâ€¢&Wç&×2æ–BÀ¢S ¢“° ¢6öç7B&WF–ÆW"Ð¢6ÆVâ€¢&Wæ&öG“òç&WF–ÆW"À¢3 ¢“° ¢–b€¢&WF–ÆW"ÇÀ¢$UD”ÄU%ô´U•2æ–æ6ÇVFW2€¢&WF–ÆW ¢¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$6†ö÷6R7W÷'FVB&WF–ÆW"&Vf÷&RW‡÷'F–ærâ ¢Ò“°¢Ð ¢6öç7B6VÆV7FVBÐ¢'&’æ—4'&’€¢&Wæ&öG“òç6VÆV7FV@¢¢ò&Wæ&öG’ç6VÆV7FVBæÖ€¢—FVÒÓà¢7G&–ær†—FVÒ¢¢¢µÓ° ¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7B÷&FW"Ð¢€¢'&’æ—4'&’‡–B¢ò–@¢¢µÐ¢’æf–æB€¢—FVÒÓà¢7G&–ær†—FVÒæ–B’ÓÓÐ¢7G&–ær†–B¢“° ¢–b€¢÷&FW#òæ7W7FöÖW$66÷VçD–@¢’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢$7W7FöÖW"÷&FW"6÷VÆBæ÷B&Rf÷VæBâ ¢Ò“°¢Ð ¢6öç7B66÷VçBÐ¢€¢v—BvWD7W7FöÖW$66÷VçG2‚¢’æf–æB€¢—FVÒÓà¢7G&–ær†—FVÒæ–B’ÓÓÐ¢7G&–ær€¢÷&FW"æ7W7FöÖW$66÷VçD–@¢¢“° ¢6öç7B7W7FöÖW$æÖRÐ¢°¢÷&FW#òç&öf–ÆSòæf—'7DæÖRÀ¢÷&FW#òç&öf–ÆSòæÆ7DæÖP¢Ð¢æf–ÇFW"„&ööÆVâ¢æ¦ö–â‚""’ÇÀ¢÷&FW#òç&öf–ÆSòç&öf–ÆTæÖRÇÀ¢66÷VçCòæVÖ–ÂÇÀ¢$7W7FöÖW"#° ¢6öç7B°¢–E&öf–ÆW2À¢ÖVÖ&W'6†—2À¢g&VT76–væÖVçG2À¢&VçFÄ76–væÖVçG0¢ÒÒv—B&öÖ—6RæÆÂ…°¢vWE&WF–ÆW%&öf–ÆW2‚’À¢vWDÖævVD66÷VçG2‚’À¢vWDg&VT76–væÖVçG2‚’À¢vWE&VçFÄ76–væÖVçG2‚¢Ò“° ¢6öç7BÆ–æ¶VD–G4f÷$GWÆ–6FT6†V6²Ð¢æWr6WB€¢°¢ââæg&VT76–væÖVçG2À¢ââç&VçFÄ76–væÖVçG0¢Ð¢æf–ÇFW"€¢76–væÖVçBÓà¢ÖævVD76–væÖVçD—4Æ–æ¶VB€¢76–væÖVç@¢¢¢æÖ€¢76–væÖVçBÓà¢7G&–ær€¢ÖævVD76–væÖVçDÖVÖ&W'6†—–B€¢76–væÖVç@¢’ÇÀ¢" ¢¢¢æf–ÇFW"„&ööÆVâ¢“° ¢6öç7BGWÆ–6FT7&VFVçF–Å7FFRÐ¢ÖævVDGWÆ–6FT7&VFVçF–Å7FFR€¢ÖVÖ&W'6†—2À¢Æ–æ¶VD–G4f÷$GWÆ–6FT6†V6°¢“° ¢6öç7Bw&÷W–BÐ¢7'—Fòç&æFöÕUT”B‚“° ¢6öç7B6æF–FFW2ÒµÓ° ¢ÆWB–DçVÖ&W"Ò° ¢f÷"€¢6öç7B&V6÷&Bö`¢–E&öf–ÆW2æf–ÇFW"€¢—FVÒÓà¢7G&–ær€¢—FVÒæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢’ÓÓÐ¢7G&–ær€¢÷&FW"æ7W7FöÖW$66÷VçD–@¢¢¢’°¢–b€¢&V6÷&E&WF–ÆW$¶W—2€¢&V6÷&@¢’æ–æ6ÇVFW2€¢&WF–ÆW ¢¢’°¢6öçF–çVS°¢Ð ¢–DçVÖ&W"³Ò° ¢ÆWB6V7&WG2Ò·Ó° ¢G'’°¢6V7&WG2Ð¢&V6÷&Bæ7W7FöÖW%6V7&WG0¢ò€¢FV7'—D§6öâ€¢&V6÷&Bæ7W7FöÖW%6V7&WG0¢’ÇÀ¢·Ð¢¢¢·Ó°¢Ò6F6‚°¢6V7&WG2Ò·Ó°¢Ð ¢6öç7BÖ—76–ætf–VÆG2Ð¢W‡÷'E&öf–ÆTÖ—76–ætf–VÆG2€¢&V6÷&Bæ7W7FöÖW%&öf–ÆRÇÀ¢·ÒÀ¢6V7&WG0¢“° ¢6æF–FFW2çW6‚‡°¢¶W“ ¢–C¢G·&V6÷&Bæ–GÖÀ ¢W‡÷'E&VG“ ¢Ö—76–ætf–VÆG2æÆVæwF‚ÓÓÐ¢À ¢Ö—76–ætf–VÆG2À ¢—FVÓ ¢†–†&öf–ÆTö&¦V7B€¢G¶7W7FöÖW$æÖWÒ–B&öf–ÆRG·–DçVÖ&W'ÖÀ¢&V6÷&Bæ7W7FöÖW%&öf–ÆRÇÀ¢·ÒÀ¢6V7&WG2À¢w&÷W–@¢¢Ò“°¢Ð ¢6öç7BFDÆ–æ¶VD6æF–FFRÐ¢€¢76–væÖVçBÀ¢G—RÀ¢çVÖ&W ¢’Óâ°¢–b€¢Æ–æ¶VD76–væÖVçE&WF–ÆW$¶W—2€¢76–væÖVçBÀ¢ÖVÖ&W'6†—0¢’æ–æ6ÇVFW2€¢&WF–ÆW ¢¢’°¢&WGW&ã°¢Ð ¢6öç7BÖVÖ&W'6†—–BÐ¢76–væÖVçBæÖævVD66÷VçD–BÇÀ¢76–væÖVçBæg&VTÖVÖ&W'6†—–BÇÀ¢76–væÖVçBç&VçFVDÖVÖ&W'6†—–BÇÀ¢76–væÖVçBæ–C° ¢6öç7B6V7&WG2Ð¢FV7'—D76–væÖVçE6V7&WG2€¢76–væÖVç@¢“° ¢6öç7BÖ—76–ætf–VÆG2Ð¢W‡÷'E&öf–ÆTÖ—76–ætf–VÆG2€¢76–væÖVçBæ7W7FöÖW%&öf–ÆRÇÀ¢·ÒÀ¢6V7&WG0¢“° ¢–b€¢GWÆ–6FT7&VFVçF–Å7FFP¢æGWÆ–6FT–G0¢æ†2€¢7G&–ær€¢ÖVÖ&W'6†—–@¢¢¢’°¢Ö—76–ætf–VÆG2çW6‚€¢&GWÆ–6FRÖævVBÆöv–â ¢“°¢Ð ¢6æF–FFW2çW6‚‡°¢¶W“ ¢G·G—WÓ¢G¶ÖVÖ&W'6†—–GÖÀ ¢W‡÷'E&VG“ ¢Ö—76–ætf–VÆG2æÆVæwF‚ÓÓÐ¢À ¢Ö—76–ætf–VÆG2À ¢—FVÓ ¢†–†&öf–ÆTö&¦V7B€¢G—RÓÓÒ&g&VR ¢òG¶7W7FöÖW$æÖWÒv–gFVBG¶çVÖ&W'Ö ¢¢G¶7W7FöÖW$æÖWÒ&VçFVBG¶çVÖ&W'ÖÀ¢76–væÖVçBæ7W7FöÖW%&öf–ÆRÇÀ¢·ÒÀ¢6V7&WG2À¢w&÷W–@¢¢Ò“°¢Ó° ¢ÆWBv–gFVDçVÖ&W"Ò° ¢f÷"€¢6öç7B76–væÖVçBö`¢g&VT76–væÖVçG0¢’°¢–b€¢7G&–ær€¢76–væÖVçBæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢’ÓÐ¢7G&–ær€¢÷&FW"æ7W7FöÖW$66÷VçD–@¢’ÇÀ¢ÖævVD76–væÖVçD—4Æ–æ¶VB€¢76–væÖVç@¢’ÇÀ¢Æ–æ¶VD76–væÖVçE&WF–ÆW$¶W—2€¢76–væÖVçBÀ¢ÖVÖ&W'6†—0¢’æ–æ6ÇVFW2€¢&WF–ÆW ¢¢’°¢6öçF–çVS°¢Ð ¢v–gFVDçVÖ&W"³Ò° ¢FDÆ–æ¶VD6æF–FFR€¢76–væÖVçBÀ¢&g&VR"À¢v–gFVDçVÖ&W ¢“°¢Ð ¢ÆWB&VçFVDçVÖ&W"Ò° ¢f÷"€¢6öç7B76–væÖVçBö`¢&VçFÄ76–væÖVçG0¢’°¢–b€¢7G&–ær€¢76–væÖVçBæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢’ÓÐ¢7G&–ær€¢÷&FW"æ7W7FöÖW$66÷VçD–@¢’ÇÀ¢ÖævVD76–væÖVçD—4Æ–æ¶VB€¢76–væÖVç@¢’ÇÀ¢Æ–æ¶VD76–væÖVçE&WF–ÆW$¶W—2€¢76–væÖVçBÀ¢ÖVÖ&W'6†—0¢’æ–æ6ÇVFW2€¢&WF–ÆW ¢¢’°¢6öçF–çVS°¢Ð ¢&VçFVDçVÖ&W"³Ò° ¢FDÆ–æ¶VD6æF–FFR€¢76–væÖVçBÀ¢'&VçFVB"À¢&VçFVDçVÖ&W ¢“°¢Ð ¢6öç7B6†÷6VâÐ¢6æF–FFW2æf–ÇFW"€¢6æF–FFRÓà¢€¢6VÆV7FVBæÆVæwF‚ÇÀ¢6VÆV7FVBæ–æ6ÇVFW2€¢6æF–FFRæ¶W¢¢’b`¢6æF–FFRæW‡÷'E&VG¢“° ¢–b‚6†÷6VâæÆVæwF‚’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢æòG·&WF–ÆW$F—7Æ”æÖR€¢&WF–ÆW ¢—Ò&öf–ÆW2&R7W'&VçFÇ’W‡÷'B&VG’æ ¢Ò“°¢Ð ¢6öç7B÷WGWBÐ¢6†÷6VâæÖ€¢6æF–FFRÓà¢6æF–FFRæ—FVÐ¢“° ¢ò ¢æWfW"6VæBâW‡÷'BVæÆW72WfW'’&öf–ÆRW†7FÇ’ÖF6†W0¢F†Ræ†–†ö&¦V7B7G'V7GW&R7WÆ–VB'’F†RW6W"à¢¢ð¢–b€¢'&’æ—4'&’€¢÷WGW@¢’ÇÀ¢÷WGWBæWfW'’€¢†–†&öf–ÆT†4W†7E6†P¢¢’°¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢$W‡÷'B7F÷VB&V6W6RF†RvVæW&FVBf–ÆRF–Bæ÷BÖF6‚F†R&WV—&VBæ†–†&öf–ÆRf÷&ÖBâ ¢Ò“°¢Ð ¢6öç7Bf–ÆTæÖRÐ¢G·6fTW‡÷'Df–ÆU'B€¢7W7FöÖW$æÖP¢—ÒG·6fTW‡÷'Df–ÆU'B€¢&WF–ÆW$F—7Æ”æÖR€¢&WF–ÆW ¢¢—Ò&öf–ÆW2æ†–†° ¢&W2ç6WD†VFW"€¢$6öçFVçBÕG—R"À¢&Æ–6F–öâö§6öã²6†'6WC×WFbÓ‚ ¢“° ¢&W2ç6WD†VFW"€¢%‚ÔW‡÷'BÕ&öf–ÆRÔ6÷VçB"À¢7G&–ær€¢÷WGWBæÆVæwF€¢¢“° ¢&W2ç6WD†VFW"€¢$6öçFVçBÔF—7÷6—F–öâ"À¢GF6†ÖVçC²f–ÆVæÖSÒ"G¶f–ÆTæÖRç&WÆ6R‚ò"örÂ""—Ò& ¢“° ¢&WGW&â&W2ç6VæB€¢¥4ôâç7G&–æv–g’€¢÷WGWBÀ¢çVÆÂÀ¢ ¢¢“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢%&öf–ÆRW‡÷'BW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢W'&÷"æÖW76vRÇÀ¢%Væ&ÆRFòW‡÷'B&öf–ÆW2â ¢Ò“°¢Ð¢Ð¢“°    ¦ç÷7B€¢"ö’öFÖ–â÷7V&Ö—76–öç2ó¦–Böæ÷F–g’ÖÖ—76–ærÖ–æfò"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B–BÐ¢6ÆVâ€¢&Wç&×2æ–BÀ¢S ¢“° ¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7B÷&FW"Ð¢€¢'&’æ—4'&’‡–B¢ò–@¢¢µÐ¢’æf–æB€¢—FVÒÓà¢7G&–ær†—FVÒæ–B’ÓÓÐ¢7G&–ær†–B¢“° ¢–b€¢÷&FW#òæ7W7FöÖW$66÷VçD–@¢’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢$7W7FöÖW"66÷VçB—2æ÷BÆ–æ¶VBFòF†—2÷&FW"â ¢Ò“°¢Ð ¢6öç7B7–æ2Ð¢v—B7–æ47W7FöÖW$Ö—76–ætæ÷F–f–6F–öâ€¢÷&FW"æ7W7FöÖW$66÷VçD–@¢“° ¢–b‚7–æ2æÖ—76–æræÆVæwF‚’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢%F†—27W7FöÖW"7W'&VçFÇ’†2æòÖ—76–ær&öf–ÆR–æf÷&ÖF–öââ ¢Ò“°¢Ð ¢6öç7B66÷VçG2Ð¢v—BvWD7W7FöÖW$66÷VçG2‚“° ¢6öç7B66÷VçBÐ¢66÷VçG2æf–æB€¢—FVÒÓà¢7G&–ær†—FVÒæ–B’ÓÓÐ¢7G&–ær€¢÷&FW"æ7W7FöÖW$66÷VçD–@¢¢“° ¢6öç7Bæ÷F–f–6F–öâÐ¢7W7FöÖW$æ÷F–f–6F–öç2€¢66÷Vç@¢’æf–æB€¢—FVÒÓà¢—FVÒæ¶–æBÓÓÐ¢&Ö—76–æuö–æfò ¢“° ¢–b€¢æ÷F–f–6F–öà¢òæF—66÷&DÖW76vT–@¢’°¢v—BFVÆWFT7F–öäæVVFVDF—66÷&DÖW76vR€¢æ÷F–f–6F–öâæF—66÷&DÖW76vT–@¢“°¢Ð ¢ÆWBÖW76vT–BÐ¢çVÆÃ° ¢ÆWBF—66÷&DW'&÷"Ð¢"#° ¢G'’°¢ÖW76vT–BÐ¢v—B6VæD7F–öäæVVFVDF—66÷&DÖW76vR€¢66÷VçBÀ¢æ÷F–f–6F–öãòæÖW76vRÇÀ¢–×÷'FçB–æf÷&ÖF–öâ—2Ö—76–æs¥ÅÆî(
"G·7–æ2æÖ—76–æræ¦ö–â€¢%ÅÆî(
" ¢—Ö ¢“° ¢–b†æ÷F–f–6F–öâ’°¢æ÷F–f–6F–öâæF—66÷&DÖW76vT–BÐ¢ÖW76vT–C° ¢æ÷F–f–6F–öâæF—66÷&E6VçDBÐ¢æWrFFR‚¢çFô•4õ7G&–ær‚“°¢Ð ¢v—B6fT7W7FöÖW$66÷VçG2€¢66÷VçG0¢“° ¢Ò6F6‚†W'&÷"’°¢F—66÷&DW'&÷"Ð¢W'&÷"æÖW76vRÇÀ¢$F—66÷&Bæ÷F–f–6F–öâ6÷VÆBæ÷B&R6VçBâ#°¢Ð ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ ¢F—66÷&EW6W&æÖT6öæf–wW&VC ¢&ööÆVâ€¢66÷VçBæF—66÷&EW6W&æÖP¢’À ¢F—66÷&E6VçC ¢&ööÆVâ€¢ÖW76vT–@¢’À ¢F—66÷&DW'&÷ ¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$æ÷F–g’Ö—76–ær–æfòW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢W'&÷"æÖW76vRÇÀ¢%Væ&ÆRFòæ÷F–g’7W7FöÖW"â ¢Ò“°¢Ð¢Ð¢“°  ¦ç÷7B€¢"ö’öFÖ–â÷7V&Ö—76–öç2ó¦–BöÖW76vRÖ7W7FöÖW""À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B–BÐ¢6ÆVâ€¢&Wç&×2æ–BÀ¢S ¢“° ¢6öç7BÖW76vRÐ¢6ÆVâ€¢&Wæ&öG“òæÖW76vRÀ¢3S ¢“° ¢–b‚ÖW76vR’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$VçFW"ÖW76vRf÷"F†R7W7FöÖW"â ¢Ò“°¢Ð ¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7B÷&FW"Ð¢€¢'&’æ—4'&’‡–B¢ò–@¢¢µÐ¢’æf–æB€¢—FVÒÓà¢7G&–ær†—FVÒæ–B’ÓÓÐ¢7G&–ær†–B¢“° ¢–b€¢÷&FW#òæ7W7FöÖW$66÷VçD–@¢’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢$7W7FöÖW"66÷VçB—2æ÷BÆ–æ¶VBFòF†—2÷&FW"â ¢Ò“°¢Ð ¢6öç7B66÷VçG2Ð¢v—BvWD7W7FöÖW$66÷VçG2‚“° ¢6öç7B66÷VçBÐ¢66÷VçG2æf–æB€¢—FVÒÓà¢7G&–ær†—FVÒæ–B’ÓÓÐ¢7G&–ær€¢÷&FW"æ7W7FöÖW$66÷VçD–@¢¢“° ¢–b‚66÷VçB’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢$7W7FöÖW"66÷VçB6÷VÆBæ÷B&Rf÷VæBâ ¢Ò“°¢Ð ¢6öç7Bæ÷F–f–6F–öç2Ð¢7W7FöÖW$æ÷F–f–6F–öç2€¢66÷Vç@¢“° ¢6öç7Bæ÷F–f–6F–öâÒ°¢–C ¢7'—Fòç&æFöÕUT”B‚’À ¢¶–æC ¢&FÖ–åöÖW76vR"À ¢F—FÆS ¢$ÖW76vRg&öÒ4Ä%2âu$%24ò"À ¢ÖW76vRÀ ¢7&VFVDC ¢æWrFFR‚¢çFô•4õ7G&–ær‚’À ¢WFFVDC ¢æWrFFR‚¢çFô•4õ7G&–ær‚’À ¢F—66÷&DÖW76vT–C ¢çVÆÀ¢Ó° ¢æ÷F–f–6F–öç2çW6‚€¢æ÷F–f–6F–öà¢“° ¢66÷VçBçWFFVDBÐ¢æWrFFR‚¢çFô•4õ7G&–ær‚“° ¢v—B6fT7W7FöÖW$66÷VçG2€¢66÷VçG0¢“° ¢ÆWBF—66÷&DÖW76vT–BÐ¢çVÆÃ° ¢ÆWBF—66÷&DW'&÷"Ð¢"#° ¢G'’°¢F—66÷&DÖW76vT–BÐ¢v—B6VæD7F–öäæVVFVDF—66÷&DÖW76vR€¢66÷VçBÀ¢ÖW76vP¢“° ¢æ÷F–f–6F–öâæF—66÷&DÖW76vT–BÐ¢F—66÷&DÖW76vT–C° ¢v—B6fT7W7FöÖW$66÷VçG2€¢66÷VçG0¢“° ¢Ò6F6‚†W'&÷"’°¢F—66÷&DW'&÷"Ð¢W'&÷"æÖW76vRÇÀ¢$F—66÷&Bæ÷F–f–6F–öâ6÷VÆBæ÷B&R6VçBâ#°¢Ð ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ ¢F—66÷&EW6W&æÖT6öæf–wW&VC ¢&ööÆVâ€¢66÷VçBæF—66÷&EW6W&æÖP¢’À ¢F—66÷&E6VçC ¢&ööÆVâ€¢F—66÷&DÖW76vT–@¢’À ¢F—66÷&DW'&÷ ¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$ÖW76vR7W7FöÖW"W'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢W'&÷"æÖW76vRÇÀ¢%Væ&ÆRFòÖW76vR7W7FöÖW"â ¢Ò“°¢Ð¢Ð¢“°   ¦ç÷7B€¢"ö’öFÖ–â÷7V&Ö—76–öç2ó¦–Bö¦–rÖGF6‚×–ÖVçB"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B–BÐ¢6ÆVâ€¢&Wç&×2æ–BÀ¢S ¢“° ¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7B÷&FW"Ð¢€¢'&’æ—4'&’‡–B¢ò–@¢¢µÐ¢’æf–æB€¢—FVÒÓà¢7G&–ær†—FVÒæ–B’ÓÓÐ¢7G&–ær†–B¢“° ¢–b€¢÷&FW#òæ7W7FöÖW$66÷VçD–@¢’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢$7W7FöÖW"66÷VçB6÷VÆBæ÷B&Rf÷VæBâ ¢Ò“°¢Ð ¢6öç7B66÷VçG2Ð¢v—BvWD7W7FöÖW$66÷VçG2‚“° ¢6öç7B66÷VçBÐ¢66÷VçG2æf–æB€¢—FVÒÓà¢7G&–ær†—FVÒæ–B’ÓÓÐ¢7G&–ær€¢÷&FW"æ7W7FöÖW$66÷VçD–@¢¢“° ¢–b‚66÷VçB’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢$7W7FöÖW"66÷VçB6÷VÆBæ÷B&Rf÷VæBâ ¢Ò“°¢Ð ¢6öç7B°¢FWF–Ç2À¢&WF–ÆW%&öf–ÆW2À¢ÖVÖ&W'6†—2À¢g&VT76–væÖVçG2À¢&VçFÄ76–væÖVçG0¢ÒÒv—B&öÖ—6RæÆÂ…°¢FÖ–ä7W7FöÖW%6fVDFWF–Ç5–ÆöB€¢66÷Vç@¢’À¢vWE&WF–ÆW%&öf–ÆW2‚’À¢vWDÖævVD66÷VçG2‚’À¢vWDg&VT76–væÖVçG2‚’À¢vWE&VçFÄ76–væÖVçG2‚¢Ò“° ¢ò ¢5$õ52Õ$UD”ÄU"DE$U52ò”ÔTåBôôÀ ¢6†—–ærFG&W76W2æB–ÖVçB6&G2&VÆöærFòF†R7W7FöÖW"À¢æ÷BFò7V6–f–2&WF–ÆW"ââFG&W72ö6&B÷&–v–æÆÇ’VçFW&V@¢öâF&vWB–B&öf–ÆRÖ’F†W&Vf÷&Rf–ÆÂvÆÖ'Bõ´2ð¢6Òw26ÇV"ô6÷7F6ò&öf–ÆRÂæBf–6RfW'6à ¢&WF–ÆW"Æöv–â7&VFVçF–Ç2&RäUdU"6÷–VB†W&RâF†—2&÷WFP¢FöW2æ÷BVF—B–B&V6÷&Bæ7&VFVçF–Ç2÷"ÖævVBÖ66÷VçBööÀ¢Æöv–â7&VFVçF–Ç2Â6ò&WF–ÆW"W6W&æÖW2öVÖ–Ç2÷77v÷&G27F¢v—F‚F†V—"÷&–v–æÂ&WF–ÆW"66÷VçBà¢¢ð¢6öç7BFG&W76W2Ð¢€¢FWF–Ç2æFG&W76W2ÇÀ¢µÐ¢’æf–ÇFW"€¢—FVÒÓà¢7G&–ær€¢—FVÒæFG&W72ÇÀ¢" ¢’çG&–Ò‚’b`¢7G&–ær€¢—FVÒæ6—G’ÇÀ¢" ¢’çG&–Ò‚’b`¢7G&–ær€¢—FVÒç7FFRÇÀ¢" ¢’çG&–Ò‚’b`¢7G&–ær€¢—FVÒç¦—ÇÀ¢" ¢’çG&–Ò‚¢“° ¢6öç7B6&G2Ð¢€¢FWF–Ç2ç–ÖVçDÖÚ±î¸Â¸­yêë¢°k¢G§¦*^ethods ||
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
        const variants =
          safeAddressVariants(
            source
          );

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

      let variantCursor = 0;
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
        const shouldAssignShipping =
          isLinkedProfile ||
          !shippingReady ||
          duplicateShipping;

        if (
          shouldAssignShipping
        ) {
          const entry =
            variantQueue[
              variantCursor
            ];

          if (entry) {
            variantCursor += 1;

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
                account.email ||
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

            record.jiggedAddress = {
              ...entry.variant
            };

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

          } else if (
            !shippingReady
          ) {
            profilesStillMissingShipping.push(
              index + 1
            );
          }
        }

        if (
          isLinkedProfile &&
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
              card.accountSecurity[jÇºã
âµç«®ŠÁ®‰ž˜©x6öFRÇÀ¢" ¢Ó° ¢&V6÷&Bç6VÆV7FVE–ÖVçD–BÐ¢6&Bæ–BÇÀ¢&V6÷&Bç6VÆV7FVE–ÖVçD–BÇÀ¢çVÆÃ° ¢&V6÷&Bç6fVE–ÖVçDÖWF†öD–BÐ¢6&Bæ–BÇÀ¢&V6÷&Bç6fVE–ÖVçDÖWF†öD–BÇÀ¢çVÆÃ° ¢6&G4f–ÆÆVB³Ò° ¢ÒVÇ6R–b€¢6&E&VG¢’°¢&öf–ÆW57F–ÆÄÖ—76–æt6&BçW6‚€¢–æFW‚²¢“°¢Ð ¢&V6÷&Bæ7W7FöÖW%&öf–ÆRÐ¢&öf–ÆS° ¢&V6÷&Bæ7W7FöÖW%6V7&WG2Ð¢Væ7'—D§6öâ€¢6V7&WG0¢“° ¢&V6÷&BçWFFVDBÐ¢æWrFFR‚¢çFô•4õ7G&–ær‚“°¢Ð ¢v—B&öÖ—6RæÆÂ…°¢6fU&WF–ÆW%&öf–ÆW2€¢&WF–ÆW%&öf–ÆW0¢’À¢6fTg&VT76–væÖVçG2€¢g&VT76–væÖVçG0¢’À¢6fU&VçFÄ76–væÖVçG2€¢&VçFÄ76–væÖVçG0¢¢Ò“° ¢v—B7–æ47W7FöÖW$Ö—76–ætæ÷F–f–6F–öâ€¢÷&FW"æ7W7FöÖW$66÷VçD–@¢“° ¢6öç7BW‡÷'E&VG”6÷VçBÐ¢&öf–ÆUF&vWG2æf–ÇFW"€¢F&vWBÓâ°¢6öç7B&V6÷&BÐ¢F&vWBç&V6÷&C° ¢ÆWB6V7&WG2Ò·Ó° ¢G'’°¢6V7&WG2Ð¢&V6÷&Bæ7W7FöÖW%6V7&WG0¢ò€¢FV7'—D§6öâ€¢&V6÷&Bæ7W7FöÖW%6V7&WG0¢’ÇÀ¢·Ð¢¢¢·Ó°¢Ò6F6‚°¢6V7&WG2Ò·Ó°¢Ð ¢&WGW&â€¢W‡÷'E&öf–ÆTÖ—76–ætf–VÆG2€¢&V6÷&Bæ7W7FöÖW%&öf–ÆRÇÀ¢·ÒÀ¢6V7&WG0¢’æÆVæwF‚ÓÓÐ¢ ¢“°¢Ð¢’æÆVæwFƒ° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ ¢&öf–ÆT6÷VçC ¢&öf–ÆUF&vWG2æÆVæwF‚À ¢6†—–ætf–ÆÆVBÀ ¢6&G4f–ÆÆVBÀ ¢W‡÷'E&VG”6÷VçBÀ ¢7F–ÆÄÖ—76–æu6†—–æt6÷VçC ¢&öf–ÆW57F–ÆÄÖ—76–æu6†—–æræÆVæwF‚À ¢GWÆ–6FTFG&W76W5&W—&VBÀ ¢GWÆ–6FTFG&W76W5&VÖ–æ–æt6÷VçC ¢GWÆ–6FTFG&W76W5&VÖ–æ–æræÆVæwF‚À ¢7F–ÆÄÖ—76–æt6&D6÷VçC ¢&öf–ÆW57F–ÆÄÖ—76–æt6&BæÆVæwF‚À ¢7&÷75&WF–ÆW$FG&W74æE–ÖVçEööÃ ¢G'VRÀ ¢&WF–ÆW$7&VFVçF–Ç5&W6W'fVC ¢G'VRÀ ¢FG&W756÷W&6T6÷VçC ¢FG&W76W2æÆVæwF‚À ¢6&E6÷W&6T6÷VçC ¢6&G2æÆVæwF‚À ¢Æ–æ¶VE&öf–ÆT6÷VçC ¢Æ–æ¶VE&÷FF–öä–æFW‚À ¢ÖW76vS ¢6fVBWFFW2W6–ærG¶FG&W76W2æÆVæwF‡ÒVæ—VR7W7FöÖW"FG&W726÷W&6R‡2’æBG¶6&G2æÆVæwF‡ÒVæ—VR7W7FöÖW"6&B‡2’âG·6†—–ætf–ÆÆVGÒ&öf–ÆR‡2’&V6V—fVBVæ—VR6fRFG&W72f÷&ÖGF–ærf&–çBÂG¶6&G4f–ÆÆVGÒ&öf–ÆR‡2’&V6V—fVB&÷VæB×&ö&–â6&B–æf÷&ÖF–öâÂG¶W‡÷'E&VG”6÷VçGÒ&öf–ÆR‡2’&RW‡÷'B&VG’ÂæBG¶GWÆ–6FTFG&W76W5&VÖ–æ–æræÆVæwF‡ÒGWÆ–6FRFG&W72†W2’6÷VÆBæ÷B&R&WÆ6VB&V6W6RæòVçW6VB6fRf&–çB&VÖ–æVBæ ¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$¤”rbGF6‚–ÖVçBW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢W'&÷"æÖW76vRÇÀ¢%Væ&ÆRFò¤”rFG&W76W2æBGF6‚–ÖVçB–æf÷&ÖF–öââ ¢Ò“°¢Ð¢Ð¢“° ¦ævWB€¢"ö’öFÖ–â÷7V&Ö—76–öç2ó¦–BöÆ–æ¶VBÖÖVÖ&W'6†—2"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B–BÐ¢6ÆVâ€¢&Wç&×2æ–BÀ¢S ¢“° ¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7B÷&FW"Ð¢€¢'&’æ—4'&’‡–B¢ò–@¢¢µÐ¢’æf–æB€¢—FVÒÓà¢7G&–ær†—FVÒæ–B’ÓÓÐ¢–@¢“° ¢6öç7B7W7FöÖW$66÷VçD–BÐ¢÷&FW#òæ7W7FöÖW$66÷VçD–BÇÀ¢çVÆÃ° ¢–b‚7W7FöÖW$66÷VçD–B’°¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢ÖVÖ&W'6†—3¢µÐ¢Ò“°¢Ð ¢6öç7B°¢ÖVÖ&W'6†—2À¢g&VT76–væÖVçG2À¢&VçFÄ76–væÖVçG0¢ÒÒv—B&öÖ—6RæÆÂ…°¢vWDÖævVD66÷VçG2‚’À¢vWDg&VT76–væÖVçG2‚’À¢vWE&VçFÄ76–væÖVçG2‚¢Ò“° ¢6öç7BÆ–æ¶VDÖævVD–G2Ð¢æWr6WB€¢°¢ââæg&VT76–væÖVçG2À¢ââç&VçFÄ76–væÖVçG0¢Ð¢æf–ÇFW"€¢76–væÖVçBÓà¢ÖævVD76–væÖVçD—4Æ–æ¶VB€¢76–væÖVç@¢¢¢æÖ€¢76–væÖVçBÓà¢7G&–ær€¢76–væÖVçBæÖævVD66÷VçD–BÇÀ¢76–væÖVçBæg&VTÖVÖ&W'6†—–BÇÀ¢76–væÖVçBç&VçFVDÖVÖ&W'6†—–BÇÀ¢" ¢¢¢æf–ÇFW"„&ööÆVâ¢“° ¢6öç7BGWÆ–6FT7&VFVçF–Å7FFRÐ¢ÖævVDGWÆ–6FT7&VFVçF–Å7FFR€¢ÖVÖ&W'6†—2À¢Æ–æ¶VDÖævVD–G0¢“° ¢6öç7B7F—fRÒµÓ° ¢f÷"†6öç7B76–væÖVçBöbg&VT76–væÖVçG2’°¢–b€¢76–væÖVçBæ7W7FöÖW$66÷VçD–BÓÐ¢7W7FöÖW$66÷VçD–BÇÀ¢ÖævVD76–væÖVçD—4Æ–æ¶VB€¢76–væÖVç@¢¢’°¢6öçF–çVS°¢Ð ¢6öç7BÖVÖ&W'6†—Ð¢ÖVÖ&W'6†—2æf–æB€¢—FVÒÓà¢7G&–ær†—FVÒæ–B’ÓÓÐ¢7G&–ær€¢76–væÖVçBæÖævVD66÷VçD–BÇÀ¢76–væÖVçBæg&VTÖVÖ&W'6†—–BÇÀ¢" ¢¢“° ¢–b‚ÖVÖ&W'6†—’°¢6öçF–çVS°¢Ð ¢7F—fRçW6‚‡°¢–C ¢ÖVÖ&W'6†—æ–BÀ ¢76–væÖVçD–C ¢76–væÖVçBæ–BÀ ¢G—S ¢&g&VR"À ¢&öf–ÆTæÖS ¢ÖVÖ&W'6†—ç&öf–ÆTæÖRÇÀ¢$g&VRÖVÖ&W'6†—"À ¢66÷VçDVÖ–Ã ¢ÖVÖ&W'6†—æ66÷VçDVÖ–ÂÇÀ¢""À ¢&WF–ÆW'3 ¢ÖævVE&WF–ÆW$7&VFVçF–Ç4f÷$FÖ–â€¢ÖVÖ&W'6†— ¢’À ¢7F'G4C ¢76–væÖVçBç7F'G4BÇÀ¢çVÆÂÀ ¢W‡—&W4C ¢76–væÖVçBæW‡—&W4BÇÀ¢çVÆÂÀ ¢GW&F–öåG—S ¢76–væÖVçBæGW&F–öåG—RÇÀ¢çVÆÂÀ ¢7F—fF–öå7FGW3 ¢ÖævVD76–væÖVçE7FGW2€¢76–væÖVç@¢’À ¢7F—fS ¢76–væÖVçBæ7F—fRÓÓÒG'VRÀ ¢GWÆ–6FTÖævVDÆöv–ã ¢GWÆ–6FT7&VFVçF–Å7FFP¢æGWÆ–6FT–G0¢æ†2€¢7G&–ær€¢ÖVÖ&W'6†—æ–@¢¢’À ¢GWÆ–6FTödÖævVD66÷VçD–C ¢GWÆ–6FT7&VFVçF–Å7FFP¢æGWÆ–6FTö`¢ævWB€¢7G&–ær€¢ÖVÖ&W'6†—æ–@¢¢’ÇÀ¢çVÆÂÀ ¢7W7FöÖW%&öf–ÆS ¢76–væÖVçBæ7W7FöÖW%&öf–ÆRÇÀ¢·ÒÀ ¢7W7FöÖW$6&C ¢‚‚’Óâ°¢ÆWB6V7&WG2Ò·Ó° ¢G'’°¢–b€¢76–væÖVçBæ7W7FöÖW%6V7&WG0¢’°¢6V7&WG2Ð¢FV7'—D§6öâ€¢76–væÖVçBæ7W7FöÖW%6V7&WG0¢“°¢Ð¢Ò6F6‚°¢6V7&WG2Ò·Ó°¢Ð ¢6öç7BF–v—G2Ð¢7G&–ær€¢6V7&WG2æ6ô6&DçVÖ&W"ÇÀ¢" ¢’ç&WÆ6R€¢õÄBörÀ¢" ¢“° ¢&WGW&â°¢6&DÆ&VÃ ¢6V7&WG2æ6&DÆ&VÂÇÀ¢""À ¢6&F†öÆFW# ¢6V7&WG2æ6&F†öÆFW"ÇÀ¢""À ¢6&DçVÖ&W# ¢F–v—G2À ¢Ö6¶VDçVÖ&W# ¢F–v—G0¢ò(
.(
.(
.(
"(
.(
.(
.(
"(
.(
.(
.(
"G¶F–v—G2ç6Æ–6R‚ÓB—Ö ¢¢""À ¢W‡ÖöçFƒ ¢6V7&WG2æW‡ÖöçF‚ÇÀ¢""À ¢W‡–V# ¢6V7&WG2æW‡–V"ÇÀ¢""À ¢6V7W&—G”6öFS ¢6V7&WG2ç6V7W&—G”6öFRÇÀ¢" ¢Ó°¢Ò’‚¢Ò“°¢Ð ¢f÷"†6öç7B76–væÖVçBöb&VçFÄ76–væÖVçG2’°¢–b€¢76–væÖVçBæ7W7FöÖW$66÷VçD–BÓÐ¢7W7FöÖW$66÷VçD–BÇÀ¢ÖævVD76–væÖVçD—4Æ–æ¶VB€¢76–væÖVç@¢¢’°¢6öçF–çVS°¢Ð ¢6öç7BÖVÖ&W'6†—Ð¢ÖVÖ&W'6†—2æf–æB€¢—FVÒÓà¢7G&–ær†—FVÒæ–B’ÓÓÐ¢7G&–ær€¢76–væÖVçBæÖævVD66÷VçD–BÇÀ¢76–væÖVçBç&VçFVDÖVÖ&W'6†—–BÇÀ¢" ¢¢“° ¢–b‚ÖVÖ&W'6†—’°¢6öçF–çVS°¢Ð ¢7F—fRçW6‚‡°¢–C ¢ÖVÖ&W'6†—æ–BÀ ¢76–væÖVçD–C ¢76–væÖVçBæ–BÀ ¢G—S ¢'&VçFVB"À ¢&öf–ÆTæÖS ¢ÖVÖ&W'6†—ç&öf–ÆTæÖRÇÀ¢%&VçFVBÖVÖ&W'6†—"À ¢66÷VçDVÖ–Ã ¢ÖVÖ&W'6†—æ66÷VçDVÖ–ÂÇÀ¢""À ¢&WF–ÆW'3 ¢ÖævVE&WF–ÆW$7&VFVçF–Ç4f÷$FÖ–â€¢ÖVÖ&W'6†— ¢’À ¢7F'G4C ¢76–væÖVçBç7F'G4BÇÀ¢çVÆÂÀ ¢W‡—&W4C ¢76–væÖVçBæW‡—&W4BÇÀ¢çVÆÂÀ ¢GW&F–öåG—S ¢76–væÖVçBæGW&F–öåG—RÇÀ¢çVÆÂÀ ¢7F—fF–öå7FGW3 ¢ÖævVD76–væÖVçE7FGW2€¢76–væÖVç@¢’À ¢7F—fS ¢76–væÖVçBæ7F—fRÓÓÒG'VRÀ ¢GWÆ–6FTÖævVDÆöv–ã ¢GWÆ–6FT7&VFVçF–Å7FFP¢æGWÆ–6FT–G0¢æ†2€¢7G&–ær€¢ÖVÖ&W'6†—æ–@¢¢’À ¢GWÆ–6FTödÖævVD66÷VçD–C ¢GWÆ–6FT7&VFVçF–Å7FFP¢æGWÆ–6FTö`¢ævWB€¢7G&–ær€¢ÖVÖ&W'6†—æ–@¢¢’ÇÀ¢çVÆÂÀ ¢7W7FöÖW%&öf–ÆS ¢76–væÖVçBæ7W7FöÖW%&öf–ÆRÇÀ¢·ÒÀ ¢7W7FöÖW$6&C ¢‚‚’Óâ°¢ÆWB6V7&WG2Ò·Ó° ¢G'’°¢–b€¢76–væÖVçBæ7W7FöÖW%6V7&WG0¢’°¢6V7&WG2Ð¢FV7'—D§6öâ€¢76–væÖVçBæ7W7FöÖW%6V7&WG0¢“°¢Ð¢Ò6F6‚°¢6V7&WG2Ò·Ó°¢Ð ¢6öç7BF–v—G2Ð¢7G&–ær€¢6V7&WG2æ6ô6&DçVÖ&W"ÇÀ¢" ¢’ç&WÆ6R€¢õÄBörÀ¢" ¢“° ¢&WGW&â°¢6&DÆ&VÃ ¢6V7&WG2æ6&DÆ&VÂÇÀ¢""À ¢6&F†öÆFW# ¢6V7&WG2æ6&F†öÆFW"ÇÀ¢""À ¢6&DçVÖ&W# ¢F–v—G2À ¢Ö6¶VDçVÖ&W# ¢F–v—G0¢ò(
.(
.(
.(
"(
.(
.(
.(
"(
.(
.(
.(
"G¶F–v—G2ç6Æ–6R‚ÓB—Ö ¢¢""À ¢W‡ÖöçFƒ ¢6V7&WG2æW‡ÖöçF‚ÇÀ¢""À ¢W‡–V# ¢6V7&WG2æW‡–V"ÇÀ¢""À ¢6V7W&—G”6öFS ¢6V7&WG2ç6V7W&—G”6öFRÇÀ¢" ¢Ó°¢Ò’‚¢Ò“°¢Ð ¢f÷"€¢6öç7B—FVÒö`¢7F—fP¢’°¢6öç7BW‡÷'E6V7&WG2Ò°¢6&F†öÆFW# ¢—FVÒæ7W7FöÖW$6&Còæ6&F†öÆFW"ÇÀ¢""À ¢6ô6&DçVÖ&W# ¢—FVÒæ7W7FöÖW$6&Còæ6&DçVÖ&W"ÇÀ¢""À ¢W‡ÖöçFƒ ¢—FVÒæ7W7FöÖW$6&CòæW‡ÖöçF‚ÇÀ¢""À ¢W‡–V# ¢—FVÒæ7W7FöÖW$6&CòæW‡–V"ÇÀ¢""À ¢6V7W&—G”6öFS ¢—FVÒæ7W7FöÖW$6&Còç6V7W&—G”6öFRÇÀ¢" ¢Ó° ¢—FVÒç&VF–æW72Ð¢ÖævVE&öf–ÆU&VF–æW72€¢—FVÒæ7W7FöÖW%&öf–ÆRÇÀ¢·ÒÀ¢W‡÷'E6V7&WG0¢“° ¢6öç7BW‡÷'E7FGW2Ð¢W‡÷'E&VF–æW75–ÆöB€¢—FVÒæ7W7FöÖW%&öf–ÆRÇÀ¢·ÒÀ¢W‡÷'E6V7&WG0¢“° ¢–b€¢—FVÒæGWÆ–6FTÖævVDÆöv–à¢’°¢W‡÷'E7FGW2æW‡÷'E&VG’Ð¢fÇ6S° ¢W‡÷'E7FGW2æÖ—76–ætf–VÆG2Ò°¢âââ€¢'&’æ—4'&’€¢W‡÷'E7FGW2æÖ—76–ætf–VÆG0¢¢òW‡÷'E7FGW2æÖ—76–ætf–VÆG0¢¢µÐ¢’À¢&GWÆ–6FRÖævVBÆöv–â ¢Ó°¢Ð ¢—FVÒæW‡÷'E&VG’Ð¢W‡÷'E7FGW2æW‡÷'E&VG“° ¢—FVÒæÖ—76–ætf–VÆG2Ð¢W‡÷'E7FGW2æÖ—76–ætf–VÆG3° ¢6öç7B¶W’Ð¢W†7DÖævVDFG&W74¶W’€¢—FVÒæ7W7FöÖW%&öf–ÆRÇÀ¢·Ð¢“° ¢—FVÒæW†7DFG&W74ÖF6†W2Ð¢¶W¢ò7F—fP¢æf–ÇFW"€¢÷F†W"Óà¢7G&–ær†÷F†W"æ–B’ÓÐ¢7G&–ær†—FVÒæ–B’b`¢W†7DÖævVDFG&W74¶W’€¢÷F†W"æ7W7FöÖW%&öf–ÆRÇÀ¢·Ð¢’ÓÓÐ¢¶W¢¢æÖ†÷F†W"Óâ‡°¢–C ¢÷F†W"æ–BÀ ¢G—S ¢÷F†W"çG—RÀ ¢&öf–ÆTæÖS ¢÷F†W"ç&öf–ÆTæÖRÀ ¢66÷VçDVÖ–Ã ¢÷F†W"æ66÷VçDVÖ–À¢Ò’¢¢µÓ°¢Ð ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢ÖVÖ&W'6†—3 ¢7F—fP¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$FÖ–âÆ–æ¶VBÖVÖ&W'6†—2W'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFòÆöBÆ–æ¶VB&öf–ÆW2â ¢Ò“°¢Ð¢Ð¢“° ¦7–æ2gVæ7F–öâFÖ–ä÷&FW$7W7FöÖW$66÷VçB€¢÷&FW$–@¢’°¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7B÷&FW"Ð¢€¢'&’æ—4'&’‡–B¢ò–@¢¢µÐ¢’æf–æB€¢—FVÒÓà¢7G&–ær†—FVÒæ–B’ÓÓÐ¢7G&–ær†÷&FW$–B¢“° ¢–b€¢÷&FW#òæ7W7FöÖW$66÷VçD–@¢’°¢&WGW&âçVÆÃ°¢Ð ¢6öç7B66÷VçG2Ð¢v—BvWD7W7FöÖW$66÷VçG2‚“° ¢&WGW&â€¢66÷VçG2æf–æB€¢66÷VçBÓà¢66÷VçBæ–BÓÓÐ¢÷&FW"æ7W7FöÖW$66÷VçD–@¢’ÇÀ¢çVÆÀ¢“°§Ð ¦ævWB€¢"ö’öFÖ–â÷7V&Ö—76–öç2ó¦–B÷6fVBÖFWF–Ç2"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B66÷VçBÐ¢v—BFÖ–ä÷&FW$7W7FöÖW$66÷VçB€¢&Wç&×2æ–@¢“° ¢–b‚66÷VçB’°¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢FG&W76W3¢µÒÀ¢–ÖVçDÖWF†öG3¢µÐ¢Ò“°¢Ð ¢6öç7B–ÆöBÐ¢v—BFÖ–ä7W7FöÖW%6fVDFWF–Ç5–ÆöB€¢66÷Vç@¢“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢ââç–Æö@¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$FÖ–â6fVBFWF–Ç2ÆöBW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFòÆöB6fVB7W7FöÖW"FWF–Ç2â ¢Ò“°¢Ð¢Ð¢“°   ¦çWB€¢"ö’öFÖ–â÷7V&Ö—76–öç2ó¦–B÷6fVB×–ÖVçBó§–ÖVçD–B"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B÷&FW$–BÐ¢6ÆVâ€¢&Wç&×2æ–BÀ¢S ¢“° ¢6öç7B–ÖVçD–BÐ¢6ÆVâ€¢&Wç&×2ç–ÖVçD–BÀ¢## ¢“° ¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7B÷&FW"Ð¢€¢'&’æ—4'&’‡–B¢ò–@¢¢µÐ¢’æf–æB€¢—FVÒÓà¢7G&–ær†—FVÒæ–B’ÓÓÐ¢7G&–ær†÷&FW$–B¢“° ¢–b€¢÷&FW#òæ7W7FöÖW$66÷VçD–@¢’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢$7W7FöÖW"66÷VçB6÷VÆBæ÷B&Rf÷VæBâ ¢Ò“°¢Ð ¢6öç7B–ÆöBÒ°¢6&DÆ&VÃ ¢6ÆVâ€¢&Wæ&öG“òæ6&DÆ&VÂÀ¢ ¢’À ¢6&F†öÆFW# ¢6ÆVâ€¢&Wæ&öG“òæ6&F†öÆFW"À¢S ¢’À ¢6ô6&DçVÖ&W# ¢6ÆVâ€¢&Wæ&öG“òæ6ô6&DçVÖ&W"À¢3 ¢’ç&WÆ6R€¢õÄBörÀ¢" ¢’À ¢W‡ÖöçFƒ ¢6ÆVâ€¢&Wæ&öG“òæW‡ÖöçF‚À¢ ¢’À ¢W‡–V# ¢6ÆVâ€¢&Wæ&öG“òæW‡–V"À¢@¢’À ¢6V7W&—G”6öFS ¢6ÆVâ€¢&Wæ&öG“òç6V7W&—G”6öFRÀ¢3 ¢¢Ó° ¢–b€¢õåÆG³"Ã—ÒBòçFW7B€¢–ÆöBæ6ô6&DçVÖ&W ¢¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$VçFW"fÆ–B6&BçVÖ&W"â ¢Ò“°¢Ð ¢–b€¢õâƒ³Ó•×Ã³Ó%Ò’BòçFW7B€¢–ÆöBæW‡ÖöçF€¢¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$VçFW"fÆ–BW‡—&F–öâÖöçF‚â ¢Ò“°¢Ð ¢–b€¢õåÆG³GÒBòçFW7B€¢–ÆöBæW‡–V ¢¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$VçFW"fÆ–BW‡—&F–öâ–V"â ¢Ò“°¢Ð ¢6öç7Bæ÷rÐ¢æWrFFR‚¢çFô•4õ7G&–ær‚“° ¢–b€¢–ÖVçD–Bç7F'G5v—F‚€¢'–B×&öf–ÆRÖ6&C¢ ¢¢’°¢6öç7B&öf–ÆT–BÐ¢–ÖVçD–Bç6Æ–6R€¢'–B×&öf–ÆRÖ6&C¢ ¢æÆVæwF€¢“° ¢6öç7B&öf–ÆW2Ð¢v—BvWE&WF–ÆW%&öf–ÆW2‚“° ¢6öç7B&V6÷&BÐ¢&öf–ÆW2æf–æB€¢—FVÒÓà¢7G&–ær†—FVÒæ–B’ÓÓÐ¢7G&–ær‡&öf–ÆT–B’b`¢7G&–ær€¢—FVÒæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢’ÓÓÐ¢7G&–ær€¢÷&FW"æ7W7FöÖW$66÷VçD–@¢¢“° ¢–b‚&V6÷&B’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢%–B&öf–ÆR6&B6÷VÆBæ÷B&Rf÷VæBâ ¢Ò“°¢Ð ¢ÆWB6V7&WG2Ò·Ó° ¢G'’°¢6V7&WG2Ð¢&V6÷&Bæ7W7FöÖW%6V7&WG0¢ò€¢FV7'—D§6öâ€¢&V6÷&Bæ7W7FöÖW%6V7&WG0¢’ÇÀ¢·Ð¢¢¢·Ó°¢Ò6F6‚°¢6V7&WG2Ò·Ó°¢Ð ¢&V6÷&Bæ7W7FöÖW%6V7&WG2Ð¢Væ7'—D§6öâ‡°¢ââç6V7&WG2À¢ââç–Æö@¢Ò“° ¢&V6÷&BçWFFVDBÐ¢æ÷s° ¢v—B6fU&WF–ÆW%&öf–ÆW2€¢&öf–ÆW0¢“° ¢ÒVÇ6R°¢6öç7B66÷VçG2Ð¢v—BvWD7W7FöÖW$66÷VçG2‚“° ¢6öç7B66÷VçBÐ¢66÷VçG2æf–æB€¢—FVÒÓà¢7G&–ær†—FVÒæ–B’ÓÓÐ¢7G&–ær€¢÷&FW"æ7W7FöÖW$66÷VçD–@¢¢“° ¢–b‚66÷VçB’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢$7W7FöÖW"66÷VçB6÷VÆBæ÷B&Rf÷VæBâ ¢Ò“°¢Ð ¢6öç7BfVÇBÐ¢v—BvWD7W7FöÖW%fVÇB€¢66÷VçBæ–@¢“° ¢6öç7BÖWF†öBÐ¢fVÇBç–ÖVçDÖWF†öG2æf–æB€¢—FVÒÓà¢7G&–ær†—FVÒæ–B’ÓÓÐ¢7G&–ær‡–ÖVçD–B¢“° ¢–b‚ÖWF†öB’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢%6fVB–ÖVçB6&B6÷VÆBæ÷B&Rf÷VæBâ ¢Ò“°¢Ð ¢öÚ±î¸Â¸­yêë¢°k¢G§¦*^bject.assign(
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
                [jÇºã
âµç«®ŠÁ®‰ž˜©zÖævVD7&VFVçF–Ç0¢“° ¢6öç7B7W7FöÖW$VÖ–ÂÐ¢66÷VçCòæVÖ–ÂÇÀ¢76–væÖVç@¢òæ7W7FöÖW%&öf–ÆP¢òæVÖ–ÂÇÀ¢"#° ¢6öç7B6V&6†&ÆRÒ°¢°¢Æ&VÃ ¢$7W7FöÖW"VÖ–Â"À¢fÇVS ¢7W7FöÖW$VÖ–À¢ÒÀ¢°¢Æ&VÃ ¢$Æ–æ¶VB&öf–ÆRVÖ–Â"À¢fÇVS ¢Æ–æ¶VDVÖ–À¢ÒÀ¢°¢Æ&VÃ ¢%F&vWBVÖ–ÂòW6W&æÖR"À¢fÇVS ¢ÖævVD7&VFVçF–Ç0¢òçF&vW@¢òçW6W&æÖP¢ÒÀ¢°¢Æ&VÃ ¢%vÆÖ'BVÖ–ÂòW6W&æÖR"À¢fÇVS ¢ÖævVD7&VFVçF–Ç0¢òçvÆÖ'@¢òçW6W&æÖP¢ÒÀ¢°¢Æ&VÃ ¢%´2VÖ–Â"À¢fÇVS ¢ÖævVD7&VFVçF–Ç0¢òç¶0¢òçW6W&æÖP¢ÒÀ¢°¢Æ&VÃ ¢%6Òw26ÇV"VÖ–ÂòW6W&æÖR"À¢fÇVS ¢ÖævVD7&VFVçF–Ç0¢òç6×46ÇV ¢òçW6W&æÖP¢ÒÀ¢°¢Æ&VÃ ¢$6÷7F6òVÖ–ÂòW6W&æÖR"À¢fÇVS ¢ÖævVD7&VFVçF–Ç0¢òæ6÷7F6ð¢òçW6W&æÖP¢ÒÀ¢°¢Æ&VÃ ¢$f—'7BæÖR"À¢fÇVS ¢76–væÖVç@¢òæ7W7FöÖW%&öf–ÆP¢òæf—'7DæÖP¢ÒÀ¢°¢Æ&VÃ ¢$Æ7BæÖR"À¢fÇVS ¢76–væÖVç@¢òæ7W7FöÖW%&öf–ÆP¢òæÆ7DæÖP¢ÒÀ¢°¢Æ&VÃ ¢%†öæR"À¢fÇVS ¢76–væÖVç@¢òæ7W7FöÖW%&öf–ÆP¢òç†öæP¢ÒÀ¢°¢Æ&VÃ ¢%6†—–ærFG&W72"À¢fÇVS ¢76–væÖVç@¢òæ7W7FöÖW%&öf–ÆP¢òæFG&W70¢ÒÀ¢°¢Æ&VÃ ¢$FG&W72Æ–æR""À¢fÇVS ¢76–væÖVç@¢òæ7W7FöÖW%&öf–ÆP¢òæFG&W73 ¢ÒÀ¢°¢Æ&VÃ ¢$6—G’"À¢fÇVS ¢76–væÖVç@¢òæ7W7FöÖW%&öf–ÆP¢òæ6—G¢ÒÀ¢°¢Æ&VÃ ¢%7FFR"À¢fÇVS ¢76–væÖVç@¢òæ7W7FöÖW%&öf–ÆP¢òç7FFP¢ÒÀ¢°¢Æ&VÃ ¢%¤•"À¢fÇVS ¢76–væÖVç@¢òæ7W7FöÖW%&öf–ÆP¢òç¦— ¢ÒÀ¢°¢Æ&VÃ ¢$6&F†öÆFW""À¢fÇVS ¢6V7&WG2æ6&F†öÆFW ¢ÒÀ¢°¢Æ&VÃ ¢$6&BÆ&VÂ"À¢fÇVS ¢6V7&WG2æ6&DÆ&VÀ¢ÒÀ¢°¢Æ&VÃ ¢$6&BçVÖ&W""À¢fÇVS ¢6&DF–v—G2À¢F—7Æ“ ¢6&DF–v—G0¢ò6&BVæF–ærG¶6&DF–v—G2ç6Æ–6R‚ÓB—Ö ¢¢" ¢Ð¢Ó° ¢6öç7BÖF6†VBÐ¢&Vf—„ÖF6‚€¢6V&6†&ÆP¢“° ¢–b‚ÖF6†VB’°¢6öçF–çVS°¢Ð ¢W6‚‡°¢f–Ws ¢G—RÓÓÒ&g&VR ¢ò&g&VR×&öf–ÆR ¢¢'&VçFVB×&öf–ÆR"À ¢÷&FW$–C ¢""À ¢7W7FöÖW$66÷VçD–C ¢76–væÖVçBæ7W7FöÖW$66÷VçD–BÇÀ¢""À ¢&öf–ÆT–C ¢ÖVÖ&W'6†—–BÀ ¢7W7FöÖW$VÖ–ÂÀ ¢Æ–æ¶VDVÖ–ÂÀ ¢ÖF6†VDÆ&VÃ ¢ÖF6†VBæÆ&VÂÀ ¢ÖF6†VEfÇVS ¢ÖF6†VBçfÇVRÀ ¢Æ&VÃ ¢Æ–æ¶VDVÖ–ÂÇÀ¢7W7FöÖW$VÖ–ÂÇÀ¢$Æ–æ¶VB&öf–ÆR ¢Ò“°¢Ð¢Ó° ¢FDÖævVB€¢g&VT76–væÖVçG2À¢&g&VR ¢“° ¢FDÖævVB€¢&VçFÄ76–væÖVçG2À¢'&VçFVB ¢“° ¢ò ¢7W7FöÖW"ÖÆWfVÂ–B÷&FW"fÇVW2&VÖ–â6V&6†&ÆRWfVâ–`¢F†R7W7FöÖW"FöW2æ÷B–WB†fR6fVB&WF–ÆW"&öf–ÆRà¢¢ð¢f÷"€¢6öç7B66÷VçBö`¢66÷VçG0¢’°¢6öç7B÷&FW"Ð¢–D÷&FW$f÷$66÷VçB€¢66÷VçBæ–@¢“° ¢–b‚÷&FW"’°¢6öçF–çVS°¢Ð ¢6öç7B6V&6†&ÆRÒ°¢°¢Æ&VÃ ¢$7W7FöÖW"VÖ–Â"À¢fÇVS ¢66÷VçBæVÖ–À¢ÒÀ¢°¢Æ&VÃ ¢%&öf–ÆRVÖ–Â"À¢fÇVS ¢÷&FW#òç&öf–ÆSòæVÖ–À¢ÒÀ¢°¢Æ&VÃ ¢$f—'7BæÖR"À¢fÇVS ¢÷&FW#òç&öf–ÆSòæf—'7DæÖP¢ÒÀ¢°¢Æ&VÃ ¢$Æ7BæÖR"À¢fÇVS ¢÷&FW#òç&öf–ÆSòæÆ7DæÖP¢ÒÀ¢°¢Æ&VÃ ¢%†öæR"À¢fÇVS ¢÷&FW#òç&öf–ÆSòç†öæP¢ÒÀ¢°¢Æ&VÃ ¢%6†—–ærFG&W72"À¢fÇVS ¢÷&FW#òç&öf–ÆSòæFG&W70¢ÒÀ¢°¢Æ&VÃ ¢$FG&W72Æ–æR""À¢fÇVS ¢÷&FW#òç&öf–ÆSòæFG&W73 ¢ÒÀ¢°¢Æ&VÃ ¢$6—G’"À¢fÇVS ¢÷&FW#òç&öf–ÆSòæ6—G¢ÒÀ¢°¢Æ&VÃ ¢%7FFR"À¢fÇVS ¢÷&FW#òç&öf–ÆSòç7FFP¢ÒÀ¢°¢Æ&VÃ ¢%¤•"À¢fÇVS ¢÷&FW#òç&öf–ÆSòç¦— ¢Ð¢Ó° ¢6öç7BÖF6†VBÐ¢&Vf—„ÖF6‚€¢6V&6†&ÆP¢“° ¢–b‚ÖF6†VB’°¢6öçF–çVS°¢Ð ¢W6‚‡°¢f–Ws ¢'–B"À ¢÷&FW$–C ¢÷&FW"æ–BÀ ¢7W7FöÖW$66÷VçD–C ¢66÷VçBæ–BÀ ¢&öf–ÆT–C ¢""À ¢7W7FöÖW$VÖ–Ã ¢66÷VçBæVÖ–ÂÇÀ¢÷&FW#òç&öf–ÆSòæVÖ–ÂÇÀ¢""À ¢Æ–æ¶VDVÖ–Ã ¢""À ¢ÖF6†VDÆ&VÃ ¢ÖF6†VBæÆ&VÂÀ ¢ÖF6†VEfÇVS ¢ÖF6†VBçfÇVRÀ ¢Æ&VÃ ¢66÷VçBæVÖ–ÂÇÀ¢÷&FW#òç&öf–ÆSòæVÖ–ÂÇÀ¢$7W7FöÖW" ¢Ò“°¢Ð ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ ¢&W7VÇG3 ¢&W7VÇG2ç6Æ–6R€¢À¢3 ¢¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$FÖ–â&öf–ÆR6V&6‚W'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFò6V&6‚&öf–ÆW2â ¢Ò“°¢Ð¢Ð¢“°  ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢DÔ”â$UD”ÄU"$ôd”ÄU0¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦ævWB€¢"ö’öFÖ–â÷7V&Ö—76–öç2ó¦–B÷&WF–ÆW"×&öf–ÆW2"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B–BÐ¢6ÆVâ€¢&Wç&×2æ–BÀ¢S ¢“° ¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7B–E&V6÷&G2Ð¢'&’æ—4'&’‡–B¢ò–@¢¢µÓ° ¢6öç7B÷&FW"Ð¢–E&V6÷&G2æf–æB€¢—FVÒÓà¢7G&–ær€¢—FVÒæ–@¢’ÓÓÒ–@¢“° ¢ÆWB7W7FöÖW$66÷VçD–BÐ¢÷&FW#òæ7W7FöÖW$66÷VçD–BÇÀ¢çVÆÃ° ¢ò ¢g&VR7V&Ö—76–öç2W6RF†R7W7FöÖW ¢66÷VçB”BF—&V7FÇ’–ç7FVBöb¢–B÷&FW"”Bà¢¢ð ¢–b‚7W7FöÖW$66÷VçD–B’°¢6öç7B66÷VçG2Ð¢v—BvWD7W7FöÖW$66÷VçG2‚“° ¢6öç7B66÷VçBÐ¢66÷VçG2æf–æB€¢—FVÒÓà¢7G&–ær€¢—FVÒæ–@¢’ÓÓÒ–@¢“° ¢–b†66÷VçB’°¢7W7FöÖW$66÷VçD–BÐ¢66÷VçBæ–C°¢Ð¢Ð ¢–b‚7W7FöÖW$66÷VçD–B’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢$7W7FöÖW"66÷VçB6÷VÆBæ÷B&Rf÷VæBâ ¢Ò“°¢Ð ¢6öç7BÆÆ÷væ6RÐ¢v—BvWD7W7FöÖW%&öf–ÆTÆÆ÷væ6R€¢7W7FöÖW$66÷VçD–@¢“° ¢6öç7B&WF–ÆW%&V6÷&G2Ð¢v—BvWE&WF–ÆW%&öf–ÆW2‚“° ¢6öç7B÷væVBÐ¢&WF–ÆW%&V6÷&G0¢æf–ÇFW"€¢&V6÷&BÓà¢&V6÷&Bæ7W7FöÖW$66÷VçD–BÓÓÐ¢7W7FöÖW$66÷VçD–@¢¢ç6÷'B€¢†Â"’Óà¢çVÖ&W"†ç6Æ÷B’Ð¢çVÖ&W"†"ç6Æ÷B¢“° ¢6öç7B7V6–Å&V6÷&G2Ð¢v—BvWE7V6–Å&öf–ÆW2‚“° ¢6öç7B÷væVE7V6–Å&öf–ÆW2Ð¢7V6–Å&V6÷&G0¢æf–ÇFW"€¢&V6÷&BÓà¢&V6÷&Bæ7W7FöÖW$66÷VçD–BÓÓÐ¢7W7FöÖW$66÷VçD–@¢¢ç6÷'B€¢†Â"’Óâ°¢6öç7BG—T÷&FW"Ò°¢g&VS¢À¢&VçFVC¢ ¢Ó° ¢&WGW&â€¢€¢G—T÷&FW%°¢æ÷&ÖÆ—¦U7V6–Å&öf–ÆUG—R€¢ç&öf–ÆUG—P¢¢ÒÇÂ“¢’Ð¢€¢G—T÷&FW%°¢æ÷&ÖÆ—¦U7V6–Å&öf–ÆUG—R€¢"ç&öf–ÆUG—P¢¢ÒÇÂ“¢¢“°¢Ð¢“° ¢6öç7B&öf–ÆW2Ð¢÷væVBæÖ€¢&V6÷&BÓà¢FÖ–å&WF–ÆW%&öf–ÆR€¢&V6÷&BÀ¢ÆÆ÷væ6P¢¢“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ ¢ÆÆ÷væ6RÀ ¢&öf–ÆW2À ¢7V6–Å&öf–ÆW3 ¢÷væVE7V6–Å&öf–ÆW2æÖ€¢&V6÷&BÓà¢FÖ–å7V6–Å&öf–ÆR€¢&V6÷&@¢¢¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$FÖ–â&WF–ÆW"&öf–ÆRÆ—7BW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFòÆöB&WF–ÆW"&öf–ÆW2â ¢Ò“°¢Ð¢Ð¢“° ¢   ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢ÔätTBÔTÔ$U%4„•5U5DôÔU"DUD”Å0¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦gVæ7F–öâÖævVD7W7FöÖW$6&Dg&öÕ6V7&WG2€¢6V7&WG0¢’°¢&WGW&â°¢6&DÆ&VÃ ¢6ÆVâ€¢6V7&WG3òæ6&DÆ&VÂÀ¢ ¢’À ¢6&F†öÆFW# ¢6ÆVâ€¢6V7&WG3òæ6&F†öÆFW"À¢S ¢’À ¢6ô6&DçVÖ&W# ¢6ÆVâ€¢6V7&WG3òæ6ô6&DçVÖ&W"À¢3 ¢’ç&WÆ6R€¢õµåÆEÒörÀ¢" ¢’À ¢W‡ÖöçFƒ ¢6ÆVâ€¢6V7&WG3òæW‡ÖöçF‚À¢ ¢’À ¢W‡–V# ¢6ÆVâ€¢6V7&WG3òæW‡–V"À¢@¢’À ¢6V7W&—G”6öFS ¢6ÆVâ€¢6V7&WG3òç6V7W&—G”6öFRÀ¢3 ¢¢Ó°§Ð  ¦gVæ7F–öâÖW&vTÖævVD7W7FöÖW%&öf–ÆR€¢W†—7F–æu&öf–ÆRÀ¢7V&Ö—GFVE&öf–ÆRÀ¢fÆÆ&6´VÖ–ÂÒ" ¢’°¢6öç7BW†—7F–ærÐ¢W†—7F–æu&öf–ÆRb`¢G—VöbW†—7F–æu&öf–ÆRÓÓÐ¢&ö&¦V7B ¢òW†—7F–æu&öf–ÆP¢¢·Ó° ¢6öç7B7V&Ö—GFVBÐ¢7V&Ö—GFVE&öf–ÆRb`¢G—Vöb7V&Ö—GFVE&öf–ÆRÓÓÐ¢&ö&¦V7B ¢ò7V&Ö—GFVE&öf–ÆP¢¢·Ó° ¢&WGW&â6æ—F—¦U&öf–ÆR‡°¢ââæW†—7F–ærÀ¢ââç7V&Ö—GFVBÀ ¢&öf–ÆTæÖS ¢7V&Ö—GFVBç&öf–ÆTæÖRÇÀ¢W†—7F–ærç&öf–ÆTæÖRÇÀ¢$ÖævVBÖVÖ&W'6†—"À ¢VÖ–Ã ¢7V&Ö—GFVBæVÖ–ÂÇÀ¢W†—7F–æræVÖ–ÂÇÀ¢fÆÆ&6´VÖ–ÂÇÀ¢" ¢Ò“°§Ð  ¦gVæ7F–öâÖW&vTÖævVD7W7FöÖW%6V7&WG2€¢W†—7F–æu6V7&WG2À¢7V&Ö—GFVD6&@¢’°¢6öç7BW†—7F–ærÐ¢W†—7F–æu6V7&WG2b`¢G—VöbW†—7F–æu6V7&WG2ÓÓÐ¢&ö&¦V7B ¢òW†—7F–æu6V7&WG0¢¢·Ó° ¢6öç7B7V&Ö—GFVBÐ¢7V&Ö—GFVD6&Bb`¢G—Vöb7V&Ö—GFVD6&BÓÓÐ¢&ö&¦V7B ¢ò7V&Ö—GFVD6&@¢¢·Ó° ¢&WGW&â°¢ââæW†—7F–ærÀ ¢6&DÆ&VÃ ¢6ÆVâ€¢7V&Ö—GFVBæ6&DÆ&VÂÀ¢ ¢’À ¢6&F†öÆFW# ¢6ÆVâ€¢7V&Ö—GFVBæ6&F†öÆFW"À¢S ¢’À ¢6ô6&DçVÖ&W# ¢6ÆVâ€¢7V&Ö—GFVBæ6ô6&DçVÖ&W"À¢3 ¢’ç&WÆ6R€¢õµåÆEÒörÀ¢" ¢’À ¢W‡ÖöçFƒ ¢6ÆVâ€¢7V&Ö—GFVBæW‡ÖöçF‚À¢ ¢’À ¢W‡–V# ¢6ÆVâ€¢7V&Ö—GFVBæW‡–V"À¢@¢’À ¢6V7W&—G”6öFS ¢6ÆVâ€¢7V&Ö—GFVBç6V7W&—G”6öFRÀ¢3 ¢¢Ó°§Ð   ¦ç÷7B€¢"ö’ö66÷VçBöÖævVBÖÖVÖ&W'6†—2ó§G—Ró¦76–væÖVçD–BöWFöf–ÆÂ"À¢&WV—&T7W7FöÖW"À¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BG—RÐ¢6ÆVâ€¢&Wç&×2çG—RÀ¢# ¢“° ¢6öç7B76–væÖVçD–BÐ¢6ÆVâ€¢&Wç&×2æ76–væÖVçD–BÀ¢S ¢“° ¢–b€¢G—RÓÒ&g&VR"b`¢G—RÓÒ'&VçFVB ¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$–çfÆ–BÖævVBÖVÖ&W'6†—G—Râ ¢Ò“°¢Ð ¢6öç7B76–væÖVçG2Ð¢G—RÓÓÒ&g&VR ¢òv—BvWDg&VT76–væÖVçG2‚¢¢v—BvWE&VçFÄ76–væÖVçG2‚“° ¢6öç7B—47F—fRÐ¢G—RÓÓÒ&g&VR ¢òg&VT76–væÖVçD—47F—fP¢¢&VçFÄ76–væÖVçD—47F—fS° ¢6öç7B76–væÖVçBÐ¢76–væÖVçG2æf–æB€¢—FVÒÓà¢7G&–ær€¢—FVÒæ–@¢’ÓÓÐ¢7G&–ær€¢76–væÖVçD–@¢’b`¢7G&–ær€¢—FVÒæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢’ÓÓÐ¢7G&–ær€¢&Wæ7W7FöÖW$66÷VçBæ–@¢’b`¢—47F—fR†—FVÒ¢“° ¢–b‚76–væÖVçB’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢$ÖævVBÖVÖ&W'6†—76–væÖVçB6÷VÆBæ÷B&Rf÷VæBâ ¢Ò“°¢Ð ¢6öç7BFG&W74–BÐ¢6ÆVâ€¢&Wæ&öG“òç6†—–ætFG&W74–BÀ¢S ¢“° ¢6öç7B–ÖVçD–BÐ¢6ÆVâ€¢&Wæ&öG“òç–ÖVçDÖWF†öD–BÀ¢S ¢“° ¢–b€¢FG&W74–Bb`¢–ÖVçD–@¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$6†ö÷6R6fVB6†—–ærFG&W72÷"–ÖVçB6&Bâ ¢Ò“°¢Ð ¢6öç7B6VÆV7FVBÐ¢v—B6fVD6†V6¶÷WE6VÆV7F–öâ€¢&Wæ7W7FöÖW$66÷VçBÀ¢FG&W74–BÀ¢–ÖVçD–@¢“° ¢–b€¢FG&W74–Bb`¢6VÆV7FVBæFG&W70¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢%F†R6VÆV7FVB6†—–ærFG&W726÷VÆBæ÷B&Rf÷VæBâ ¢Ò“°¢Ð ¢–b€¢–ÖVçD–Bb`¢6VÆV7FVBç–ÖVç@¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢%F†R6VÆV7FVB–ÖVçB6&B6÷VÆBæ÷B&Rf÷VæBâ ¢Ò“°¢Ð ¢ÆWBW†—7F–æu6V7&WG2Ò·Ó° ¢G'’°¢–b€¢76–væÖVçBæ7W7FöÖW%6V7&WG0¢’°¢W†—7F–æu6V7&WG2Ð¢FV7'—D§6öâ€¢76–væÖVçBæ7W7FöÖW%6V7&WG0¢’ÇÂ·Ó°¢Ð¢Ò6F6‚°¢W†—7F–æu6V7&WG2Ò·Ó°¢Ð ¢76–væÖVçBæ7W7FöÖW%&öf–ÆRÐ¢6†—–æu&öf–ÆTg&öÕ6fVDFG&W72€¢6VÆV7FVBæFG&W72À¢&Wæ7W7FöÖW$66÷VçBæVÖ–ÂÀ¢76–væÖVçBæ7W7FöÖW%&öf–ÆRÇÀ¢·Ð¢“° ¢6öç7BæW‡E6V7&WG2Ð¢–ÖVçE6V7&WG4g&öÕ6fVE–ÖVçB€¢6VÆV7FVBç–ÖVçBÀ¢W†—7F–æu6V7&WG0¢“° ¢76–væÖVçBæ7W7FöÖW%6V7&WG2Ð¢Væ7'—D§6öâ€¢æW‡E6V7&WG0¢“° ¢76–væÖVçBç6VÆV7FVDFG&W74–BÐ¢FG&W74–BÇÀ¢76–væÖVçBç6VÆV7FVDFG&W74–BÇÀ¢çVÆÃ° ¢76–væÖVçBç6VÆV7FVE–ÖVçD–BÐ¢–ÖVçD–BÇÀ¢76–væÖVçBç6VÆV7FVE–ÖVçD–BÇÀ¢çVÆÃ° ¢76–væÖVçBæ7W7FöÖW%WFFVDBÐ¢æWrFFR‚¢çFô•4õ7G&–ær‚“° ¢76–væÖVçBçWFFVDBÐ¢76–væÖVçBæ7W7FöÖW%WFFVDC° ¢6öç7B&VF–æW72Ð¢ÖævVE&öf–ÆU&VF–æW72€¢76–væÖVçBæ7W7FöÖW%&öf–ÆRÀ¢æW‡E6V7&WG0¢“° ¢6öç7B&Wf–÷W57FGW2Ð¢æ÷&ÖÆ—¦U&öf–ÆT7F—fF–öå7FGW2€¢76–væÖVçBæ7F—fF–öå7FGW2À¢fÇ6P¢“° ¢76–væÖVçBæ7F—fF–öå7FGW2Ð¢&VF–æW72ç&VG¢ò€¢&Wf–÷W57FGW2ÓÓÐ¢&7F—fFVB ¢ò&7F—fFVB ¢¢&v—F–æuö7F—fF–öâ ¢¢¢&–æ6ö×ÆWFR#° ¢–b€¢76–væÖVçBæ7F—fF–öå7FGW2ÓÓÐ¢&v—F–æuö7F—fF–öâ ¢’°¢76–væÖVçBæ7F—fF–öå&WVW7FVDBÐ¢76–væÖVçBæ7F—fF–öå&WVW7FVDBÇÀ¢76–væÖVçBæ7W7FöÖW%WFFVDC°¢Ð ¢–b‡G—RÓÓÒ&g&VR"’°¢v—B6fTg&VT76–væÖVçG2€¢76–væÖVçG0¢“°¢ÒVÇ6R°¢v—B6fU&VçFÄ76–væÖVçG2€¢76–væÖVçG0¢“°¢Ð ¢–b€¢76–væÖVçBæ7F—fF–öå7FGW2ÓÓÐ¢&v—F–æuö7F—fF–öâ ¢’°¢6öç7BF—66÷&D6†ævVBÐ¢v—BVç7W&TÖævVE&öf–ÆTF—66÷&DÖW76vR€¢76–væÖVçBÀ¢G—P¢“° ¢–b†F—66÷&D6†ævVB’°¢–b‡G—RÓÓÒ&g&VR"’°¢v—B6fTg&VT76–væÖVçG2€¢76–væÖVçG0¢“°¢ÒVÇ6R°¢v—B6fU&VçFÄ76–væÖVçG2€¢76–væÖVçG0¢“°¢Ð¢Ð¢Ð ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢&VF–æW72À¢7F—fF–öå7FGW3 ¢76–væÖVçBæ7F—fF–öå7FGW2À¢ÖW76vS ¢&VF–æW72ç&VG¢ò%6fVB–æf÷&ÖF–öâÆ–VBâF†—2&öf–ÆR—2æ÷r5D•dD”äræB—2v—F–ærFÖ–â7F—fF–öââ ¢¢%6fVB–æf÷&ÖF–öâÆ–VBâFF—F–öæÂ&öf–ÆR–æf÷&ÖF–öâ—27F–ÆÂ&WV—&VBâ ¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$ÖævVBÖVÖ&W'6†—WFöf–ÆÂW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFòÇ’6fVB&öf–ÆR–æf÷&ÖF–öââ ¢Ò“°¢Ð¢Ð¢“°  ¦çWB€¢"ö’ö66÷VçBöÖævVBÖÖVÖ&W'6†—2ó§G—Ró¦76–væÖVçD–B"À¢&WV—&T7W7FöÖW"À¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BG—RÐ¢6ÆVâ€¢&Wç&×2çG—RÀ¢# ¢“° ¢6öç7B76–væÖVçD–BÐ¢6ÆVâ€¢&Wç&×2æ76–væÖVçD–BÀ¢S ¢“° ¢–b€¢G—RÓÒ&g&VR"b`¢G—RÓÒ'&VçFVB ¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$–çfÆ–BÖævVBÖVÖ&W'6†—G—Râ ¢Ò“°¢Ð ¢6öç7B76–væÖVçG2Ð¢G—RÓÓÒ&g&VR ¢òv—BvWDg&VT76–væÖVçG2‚¢¢v—BvWE&VçFÄ76–væÖVçG2‚“° ¢6öç7B—47F—fRÐ¢G—RÓÓÒ&g&VR ¢òg&VT76–væÖVçD—47F—fP¢¢&VçFÄ76–væÖVçD—47F—fS° ¢6öç7B76–væÖVçBÐ¢76–væÖVçG2æf–æB€¢—FVÒÓà¢7G&–ær€¢—FVÒæ–@¢’ÓÓÒ76–væÖVçD–Bb`¢7G&–ær€¢—FVÒæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢’ÓÓÐ¢7G&–ær€¢&Wæ7W7FöÖW$66÷VçBæ–@¢’b`¢—47F—fR†—FVÒ¢“° ¢–b‚76–væÖVçB’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢$ÖævVBÖVÖ&W'6†—76–væÖVçB6÷VÆBæ÷B&Rf÷VæBâ ¢Ò“°¢Ð ¢ÆWBW†—7F–æu6V7&WG2Ò·Ó° ¢G'’°¢–b€¢76–væÖVçBæ7W7FöÖW%6V7&WG0¢’°¢W†—7F–æu6V7&WG2Ð¢FV7'—D§6öâ€¢76–væÖVçBæ7W7FöÖW%6V7&WG0¢“°¢Ð¢Ò6F6‚°¢W†—7F–æu6V7&WG2Ò·Ó°¢Ð ¢6öç7B7W7FöÖW%&öf–ÆRÐ¢ÖW&vTÖævVD7W7FöÖW%&öf–ÆR€¢76–væÖVçBæ7W7FöÖW%&öf–ÆRÀ¢&Wæ&öG“òæ7W7FöÖW%&öf–ÆRÀ¢&Wæ7W7FöÖW$66÷VçBæVÖ–À¢“° ¢6öç7B7W7FöÖW%6V7&WG2Ð¢ÖW&vTÖævVD7W7FöÖW%6V7&WG2€¢W†—7F–æu6V7&WG2À¢&Wæ&öG“òæ7W7FöÖW$6&@¢“° ¢76–væÖVçBæ7W7FöÖW%&öf–ÆRÐ¢7W7FöÖW%&öf–ÆS° ¢76–væÖVçBæ7W7FöÖW%6V7&WG2Ð¢Væ7'—D§6öâ€¢7W7FöÖW%6V7&WG0¢“° ¢76–væÖVçBæ7W7FöÖW%WFFVDBÐ¢æWrFFR‚¢çFô•4õ7G&–ær‚“° ¢76–væÖVçBçWFFVDBÐ¢76–væÖVçBæ7W7FöÖW%WFFVDC° ¢6öç7B&VF–æW72Ð¢ÖævVE&öf–ÆU&VF–æW72€¢7W7FöÖW%&öf–ÆRÀ¢7W7FöÖW%6V7&WG0¢“° ¢6öç7B&Wf–÷W57FGW2Ð¢æ÷&ÖÆ—¦U&öf–ÆT7F—fF–öå7FGW2€¢76–væÖVçBæ7F—fF–öå7FGW2À¢fÇ6P¢“° ¢76–væÖVçBæ7F—fF–öå7FGW2Ð¢&VF–æW72ç&VG¢ò€¢&Wf–÷W57FGW2ÓÓÐ¢&7F—fFVB ¢ò&7F—fFVB ¢¢&v—F–æuö7F—fF–öâ ¢¢¢&–æ6ö×ÆWFR#° ¢–b€¢76–væÖVçBæ7F—fF–öå7FGW2ÓÓÐ¢&v—F–æuö7F—fF–öâ ¢’°¢76–væÖVçBæ7F—fF–öå&WVW7FVDBÐ¢76–væÖVçBæ7F—fF–öå&WVW7FVDBÇÀ¢76–væÖVçBæ7W7FöÖW%WFFVDC°¢Ð ¢–b‡G—RÓÓÒ&g&VR"’°¢v—B6fTg&VT76–væÖVçG2€¢76–væÖVçG0¢“°¢ÒVÇ6R°¢v—B6fU&VçFÄ76–væÖVçG2€¢76–væÖVçG0¢“°¢Ð ¢–b€¢76–væÖVçBæ7F—fF–öå7FGW2ÓÓÐ¢&v—F–æuö7F—fF–öâ ¢’°¢6öç7BF—66÷&D6†ævVBÐ¢v—BVç7W&TÖævVE&öf–ÆTF—66÷&DÖW76vR€¢76–væÖVçBÀ¢G—P¢“° ¢–b†F—66÷&D6†ævVB’°¢–b‡G—RÓÓÒ&g&VR"’°¢v—B6fTg&VT76–væÖVçG2€¢76–væÖVçG0¢“°¢ÒVÇ6R°¢v—B6fU&VçFÄ76–væÖVçG2€¢76–væÖVçG0¢“°¢Ð¢Ð¢Ð ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ ¢7F—fF–öå7FGW3 ¢76–væÖVçBæ7F—fF–öå7FGW2À ¢7W7FöÖW%&öf–ÆRÀ ¢7W7FöÖW$6&C ¢ÖævVD7W7FöÖW$6&Dg&öÕ6V7&WG2€¢7W7FöÖW%6V7&WG0¢’À ¢WFFVDC ¢76–væÖVçBæ7W7FöÖW%WFFVDBÀ ¢ÖW76vS ¢$ÖævVBÖVÖ&W'6†—FWF–Ç26fVB7V66W76gVÆÇ’â ¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$7W7FöÖW"ÖævVBÖVÖ&W'6†—WFFRW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFò6fRÖævVBÖVÖ&W'6†—FWF–Ç2â ¢Ò“°¢Ð¢Ð¢“°    ¦ç÷7B€¢"ö’öFÖ–âöÖævVBÖÖVÖ&W'6†—2ó§G—Ró¦–Bö¦–rÖFG&W72"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BG—RÐ¢6ÆVâ€¢&Wç&×2çG—RÀ¢# ¢“° ¢6öç7B–BÐ¢6ÆVâ€¢&Wç&×2æ–BÀ¢S ¢“° ¢–b€¢G—RÓÒ&g&VR"b`¢G—RÓÒ'&VçFVB ¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$–çfÆ–BÖævVBÖVÖ&W'6†—G—Râ ¢Ò“°¢Ð ¢6öç7B6fVDFG&W74–BÐ¢6ÆVâ€¢&Wæ&öG“òç6fVDFG&W74–BÀ¢S ¢“° ¢6öç7BÖçVÅ&rÐ¢&Wæ&öG“òæÖçVÄFG&W72b`¢G—Vöb&Wæ&öG’æÖçVÄFG&W72ÓÓÐ¢&ö&¦V7B ¢ò&Wæ&öG’æÖçVÄFG&W70¢¢çVÆÃ° ¢6öç7BÖçVÄFG&W72Ð¢ÖçVÅ&p¢ò°¢–C ¢&ÖçVÂÖFG&W72"À ¢Æ&VÃ ¢$ÖçVÂFG&W72"À ¢f—'7DæÖS ¢6ÆVâ€¢ÖçVÅ&ræf—'7DæÖRÀ¢# ¢’À ¢Æ7DæÖS ¢6ÆVâ€¢ÖçVÅ&ræÆ7DæÖRÀ¢# ¢’À ¢†öæS ¢6ÆVâ€¢ÖçVÅ&rç†öæRÀ¢ƒ ¢’À ¢FG&W73 ¢6ÆVâ€¢ÖçVÅ&ræFG&W72À¢#C ¢’À ¢FG&W73# ¢6ÆVâ€¢ÖçVÅ&ræFG&W73"À¢c ¢’À ¢6—G“ ¢6ÆVâ€¢ÖçVÅ&ræ6—G’À¢# ¢’À ¢7FFS ¢6ÆVâ€¢ÖçVÅ&rç7FFRÀ¢ƒ ¢’À ¢¦— ¢6ÆVâ€¢ÖçVÅ&rç¦—À¢C ¢’À ¢6÷VçG'“ ¢6ÆVâ€¢ÖçVÅ&ræ6÷VçG'’ÇÀ¢%U2"À¢ƒ ¢¢Ð¢¢çVÆÃ° ¢6öç7BW6–ætÖçVÄFG&W72Ð¢&ööÆVâ€¢ÖçVÄFG&W73òæFG&W72b`¢ÖçVÄFG&W73òæ6—G’b`¢ÖçVÄFG&W73òç7FFRb`¢ÖçVÄFG&W73òç¦— ¢“° ¢–b€¢6fVDFG&W74–Bm«ëŒ+Š×ž®º+º$zzb¥æ&
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

      const variants =
        safeAddressVariants(
          sourceAddress
        );

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

      const assigm«ëŒ+Š×ž®º+º$zzb¥ææÖVçG2Ð¢G—RÓÓÒ&g&VR ¢òv—BvWDg&VT76–væÖVçG2‚¢¢v—BvWE&VçFÄ76–væÖVçG2‚“° ¢6öç7B76–væÖVçBÐ¢G—RÓÓÒ&g&VR ¢òÆ–æ¶VDg&VT76–væÖVçB€¢76–væÖVçG2À¢–@¢¢¢Æ–æ¶VE&VçFÄ76–væÖVçB€¢76–væÖVçG2À¢–@¢“° ¢–b‚76–væÖVçB’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢%F†—2ÖævVB66÷VçB—2æ÷B7W'&VçFÇ’76–væVBâ ¢Ò“°¢Ð ¢ÆWBW†—7F–æu6V7&WG2Ò·Ó° ¢G'’°¢–b€¢76–væÖVçBæ7W7FöÖW%6V7&WG0¢’°¢W†—7F–æu6V7&WG2Ð¢FV7'—D§6öâ€¢76–væÖVçBæ7W7FöÖW%6V7&WG0¢“°¢Ð¢Ò6F6‚°¢W†—7F–æu6V7&WG2Ò·Ó°¢Ð ¢6öç7B7W7FöÖW%&öf–ÆRÐ¢ÖW&vTÖævVD7W7FöÖW%&öf–ÆR€¢76–væÖVçBæ7W7FöÖW%&öf–ÆRÀ¢&Wæ&öG“òæ7W7FöÖW%&öf–ÆP¢“° ¢6öç7B7W7FöÖW%6V7&WG2Ð¢ÖW&vTÖævVD7W7FöÖW%6V7&WG2€¢W†—7F–æu6V7&WG2À¢&Wæ&öG“òæ7W7FöÖW$6&@¢“° ¢76–væÖVçBæ7W7FöÖW%&öf–ÆRÐ¢7W7FöÖW%&öf–ÆS° ¢76–væÖVçBæ7W7FöÖW%6V7&WG2Ð¢Væ7'—D§6öâ€¢7W7FöÖW%6V7&WG0¢“° ¢–b€¢ö&¦V7Bç&÷F÷G—Ræ†4÷vå&÷W'G’æ6ÆÂ€¢&Wæ&öG’ÇÂ·ÒÀ¢'6fVDFG&W74–B ¢¢’°¢76–væÖVçBç6fVDFG&W74–BÐ¢6ÆVâ€¢&Wæ&öG“òç6fVDFG&W74–BÀ¢S ¢“°¢Ð ¢–b€¢ö&¦V7Bç&÷F÷G—Ræ†4÷vå&÷W'G’æ6ÆÂ€¢&Wæ&öG’ÇÂ·ÒÀ¢'6fVE–ÖVçDÖWF†öD–B ¢¢’°¢76–væÖVçBç6fVE–ÖVçDÖWF†öD–BÐ¢6ÆVâ€¢&Wæ&öG“òç6fVE–ÖVçDÖWF†öD–BÀ¢S ¢“°¢Ð ¢76–væÖVçBæ7W7FöÖW%WFFVDBÐ¢æWrFFR‚¢çFô•4õ7G&–ær‚“° ¢76–væÖVçBçWFFVDBÐ¢76–væÖVçBæ7W7FöÖW%WFFVDC° ¢–b‡G—RÓÓÒ&g&VR"’°¢v—B6fTg&VT76–væÖVçG2€¢76–væÖVçG0¢“°¢ÒVÇ6R°¢v—B6fU&VçFÄ76–væÖVçG2€¢76–væÖVçG0¢“°¢Ð ¢–b€¢76–væÖVçBæ7W7FöÖW$66÷VçD–@¢’°¢v—B7–æ47W7FöÖW$Ö—76–ætæ÷F–f–6F–öâ€¢76–væÖVçBæ7W7FöÖW$66÷VçD–@¢“°¢Ð ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ ¢7W7FöÖW%&öf–ÆRÀ ¢7W7FöÖW$6&C ¢ÖævVD7W7FöÖW$6&Dg&öÕ6V7&WG2€¢7W7FöÖW%6V7&WG0¢’À ¢ÖW76vS ¢$ÖævVB7W7FöÖW"FWF–Ç26fVB7V66W76gVÆÇ’â ¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$FÖ–âÖævVB7W7FöÖW"FWF–Ç2WFFRW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFò6fRÖævVB7W7FöÖW"FWF–Ç2â ¢Ò“°¢Ð¢Ð¢“°  ¦æFVÆWFR€¢"ö’öFÖ–âöÖævVBÖÖVÖ&W'6†—2ó§G—Ró¦–B"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BG—RÐ¢6ÆVâ€¢&Wç&×2çG—RÀ¢# ¢“° ¢6öç7B–BÐ¢6ÆVâ€¢&Wç&×2æ–BÀ¢S ¢“° ¢–b€¢G—RÓÒ&g&VR"b`¢G—RÓÒ'&VçFVB ¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$–çfÆ–BÖævVBÖVÖ&W'6†—G—Râ ¢Ò“°¢Ð ¢6öç7BÖævVD66÷VçG2Ð¢v—BvWDÖævVD66÷VçG2‚“° ¢6öç7B–æFW‚Ð¢ÖævVD66÷VçG2æf–æD–æFW‚€¢—FVÒÓà¢7G&–ær€¢—FVÒæ–@¢’ÓÓÒ–@¢“° ¢–b†–æFW‚Â’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢$ÖævVBÖVÖ&W'6†—6÷VÆBæ÷B&Rf÷VæBâ ¢Ò“°¢Ð ¢ÖævVD66÷VçG2ç7Æ–6R€¢–æFW‚À¢¢“° ¢6öç7Bg&VT76–væÖVçG2Ð¢v—BvWDg&VT76–væÖVçG2‚“° ¢6öç7B&VçFÄ76–væÖVçG2Ð¢v—BvWE&VçFÄ76–væÖVçG2‚“° ¢6öç7B&VÖ–æ–ætg&VT76–væÖVçG2Ð¢g&VT76–væÖVçG2æf–ÇFW"€¢76–væÖVçBÓà¢7G&–ær€¢76–væÖVçBæg&VTÖVÖ&W'6†—–BÇÀ¢" ¢’ÓÒ–@¢“° ¢6öç7B&VÖ–æ–æu&VçFÄ76–væÖVçG2Ð¢&VçFÄ76–væÖVçG2æf–ÇFW"€¢76–væÖVçBÓà¢7G&–ær€¢76–væÖVçBç&VçFVDÖVÖ&W'6†—–BÇÀ¢" ¢’ÓÒ–@¢“° ¢v—B&öÖ—6RæÆÂ…°¢6fTÖævVD66÷VçG2€¢ÖævVD66÷VçG0¢’À ¢6fTg&VT76–væÖVçG2€¢&VÖ–æ–ætg&VT76–væÖVçG0¢’À ¢6fU&VçFÄ76–væÖVçG2€¢&VÖ–æ–æu&VçFÄ76–væÖVçG0¢¢Ò“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ ¢ÖW76vS ¢$ÖævVBÖVÖ&W'6†—W&ÖæVçFÇ’FVÆWFVBâ ¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$ÖævVBÖVÖ&W'6†—FVÆWFRW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFòFVÆWFRÖævVBÖVÖ&W'6†—â ¢Ò“°¢Ð¢Ð¢“°    ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢DÔ”âDU5B5U5DôÔU"$ôd”ÄRtõ$´dÄõp¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð  ¦ævWB€¢"ö’öFÖ–â÷FW7BÖÖævVB×&öf–ÆR×v÷&¶fÆ÷r"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B°¢g&VT76–væÖVçG2À¢&VçFÄ76–væÖVçG0¢ÒÒv—B&öÖ—6RæÆÂ…°¢vWDg&VT76–væÖVçG2‚’À¢vWE&VçFÄ76–væÖVçG2‚¢Ò“° ¢6öç7B&öf–ÆW2Ò°¢ââæg&VT76–væÖVçG0¢æf–ÇFW"€¢—FVÒÓà¢7G&–ær€¢—FVÒæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢’ÓÓÐ¢$DÔ”âÕ$Ud”Ur"b`¢—FVÒçFW7E&Wf–WrÓÓÐ¢G'VP¢¢æÖ€¢—FVÒÓâ‡°¢76–væÖVçD–C ¢—FVÒæ–BÀ¢G—S ¢&g&VR"À¢7F—fF–öå7FGW3 ¢æ÷&ÖÆ—¦U&öf–ÆT7F—fF–öå7FGW2€¢—FVÒæ7F—fF–öå7FGW2À¢fÇ6P¢’À¢7F—fF–öäÆ&VÃ ¢&öf–ÆT7F—fF–öäÆ&VÂ€¢—FVÒæ7F—fF–öå7FGW0¢¢Ò¢’À ¢ââç&VçFÄ76–væÖVçG0¢æf–ÇFW"€¢—FVÒÓà¢7G&–ær€¢—FVÒæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢’ÓÓÐ¢$DÔ”âÕ$Ud”Ur"b`¢—FVÒçFW7E&Wf–WrÓÓÐ¢G'VP¢¢æÖ€¢—FVÒÓâ‡°¢76–væÖVçD–C ¢—FVÒæ–BÀ¢G—S ¢'&VçFVB"À¢7F—fF–öå7FGW3 ¢æ÷&ÖÆ—¦U&öf–ÆT7F—fF–öå7FGW2€¢—FVÒæ7F—fF–öå7FGW2À¢fÇ6P¢’À¢7F—fF–öäÆ&VÃ ¢&öf–ÆT7F—fF–öäÆ&VÂ€¢—FVÒæ7F—fF–öå7FGW0¢¢Ò¢¢Ó° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢&öf–ÆW0¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$FÖ–âFW7BÖævVBv÷&¶fÆ÷rÆöBW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFòÆöBFW7BÖævVB&öf–ÆRv÷&¶fÆ÷râ ¢Ò“°¢Ð¢Ð¢“°  ¦çWB€¢"ö’öFÖ–â÷FW7BÖÖævVB×&öf–ÆR×v÷&¶fÆ÷r"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BG—RÐ¢6ÆVâ€¢&Wæ&öG“òçG—RÀ¢# ¢“° ¢6öç7B76–væÖVçD–BÐ¢6ÆVâ€¢&Wæ&öG“òæ76–væÖVçD–BÀ¢S ¢“° ¢–b€¢°¢&g&VR"À¢'&VçFVB ¢Òæ–æ6ÇVFW2‡G—R’ÇÀ¢76–væÖVçD–@¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$–çfÆ–BFW7BÖævVB&öf–ÆRâ ¢Ò“°¢Ð ¢6öç7B76–væÖVçG2Ð¢G—RÓÓÒ&g&VR ¢òv—BvWDg&VT76–væÖVçG2‚¢¢v—BvWE&VçFÄ76–væÖVçG2‚“° ¢ÆWB76–væÖVçBÐ¢76–væÖVçG2æf–æB€¢—FVÒÓà¢7G&–ær€¢—FVÒæ–@¢’ÓÓÐ¢7G&–ær€¢76–væÖVçD–@¢’b`¢7G&–ær€¢—FVÒæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢’ÓÓÐ¢$DÔ”âÕ$Ud”Ur ¢“° ¢6öç7B7W7FöÖW%&öf–ÆRÐ¢6æ—F—¦U&öf–ÆR‡°¢âââ‡&Wæ&öG¢òæ7W7FöÖW%&öf–ÆRÇÀ¢·Ò’À¢&öf–ÆTæÖS ¢G—RÓÓÒ&g&VR ¢ò$v–gFVB&öf–ÆR ¢¢%&VçFVB&öf–ÆR"À¢VÖ–Ã ¢&Wæ&öG¢òæ7W7FöÖW%&öf–ÆP¢òæVÖ–ÂÇÀ¢&FÖ–â×&Wf–Wt6Æ'6æw&'66òæ6öÒ ¢Ò“° ¢6öç7B6&BÐ¢&Wæ&öG¢òæ7W7FöÖW$6&Bb`¢G—Vöb&Wæ&öG¢æ7W7FöÖW$6&BÓÓÐ¢&ö&¦V7B ¢ò&Wæ&öG¢æ7W7FöÖW$6&@¢¢·Ó° ¢6öç7B7W7FöÖW%6V7&WG2Ò°¢6&DÆ&VÃ ¢6ÆVâ€¢6&Bæ6&DÆ&VÂÀ¢ ¢’À¢6&F†öÆFW# ¢6ÆVâ€¢6&Bæ6&F†öÆFW"À¢S ¢’À¢6ô6&DçVÖ&W# ¢6ÆVâ€¢6&Bæ6ô6&DçVÖ&W"À¢3 ¢’ç&WÆ6R€¢õµåÆEÒörÀ¢" ¢’À¢W‡ÖöçFƒ ¢6ÆVâ€¢6&BæW‡ÖöçF‚À¢ ¢’À¢W‡–V# ¢6ÆVâ€¢6&BæW‡–V"À¢@¢’À¢6V7W&—G”6öFS ¢6ÆVâ€¢6&Bç6V7W&—G”6öFRÀ¢3 ¢¢Ó° ¢6öç7B&VF–æW72Ð¢ÖævVE&öf–ÆU&VF–æW72€¢7W7FöÖW%&öf–ÆRÀ¢7W7FöÖW%6V7&WG0¢“° ¢6öç7B&Wf–÷W57FGW2Ð¢7G&–ær€¢76–væÖVç@¢òæ7F—fF–öå7FGW2ÇÀ¢" ¢¢çG&–Ò‚¢çFôÆ÷vW$66R‚“° ¢6öç7B7F—fF–öå7FGW2Ð¢&VF–æW72ç&VG¢ò€¢&Wf–÷W57FGW2ÓÓÐ¢&7F—fFVB ¢ò&7F—fFVB ¢¢&v—F–æuö7F—fF–öâ ¢¢¢&–æ6ö×ÆWFR#° ¢6öç7Bæ÷rÐ¢æWrFFR‚¢çFô•4õ7G&–ær‚“° ¢–b‚76–væÖVçB’°¢76–væÖVçBÒ°¢–C ¢76–væÖVçD–BÀ¢7W7FöÖW$66÷VçD–C ¢$DÔ”âÕ$Ud”Ur"À¢7F—fS ¢G'VRÀ¢FW7E&Wf–Ws ¢G'VRÀ¢7&VFVDC ¢æ÷p¢Ó° ¢–b€¢G—RÓÓÒ&g&VR ¢’°¢76–væÖVçBæg&VTÖVÖ&W'6†—–BÐ¢DU5BÒG¶76–væÖVçD–GÖ°¢ÒVÇ6R°¢76–væÖVçBç&VçFVDÖVÖ&W'6†—–BÐ¢DU5BÒG¶76–væÖVçD–GÖ°¢Ð ¢76–væÖVçG2çW6‚€¢76–væÖVç@¢“°¢Ð ¢76–væÖVçBæ7W7FöÖW%&öf–ÆRÐ¢7W7FöÖW%&öf–ÆS° ¢76–væÖVçBæ7W7FöÖW%6V7&WG2Ð¢Væ7'—D§6öâ€¢7W7FöÖW%6V7&WG0¢“° ¢76–væÖVçBæ7F—fF–öå7FGW2Ð¢7F—fF–öå7FGW3° ¢76–væÖVçBæ7F—fF–öå&WVW7FVDBÐ¢7F—fF–öå7FGW2ÓÓÐ¢&v—F–æuö7F—fF–öâ ¢ò€¢76–væÖVçBæ7F—fF–öå&WVW7FVDBÇÀ¢æ÷p¢¢¢çVÆÃ° ¢76–væÖVçBæW‡—&W4BÐ¢6ÆVâ€¢&Wæ&öG“òæW‡—&W4BÀ¢ ¢’ÇÀ¢76–væÖVçBæW‡—&W4BÇÀ¢çVÆÃ° ¢76–væÖVçBæGW&F–öåG—RÐ¢6ÆVâ€¢&Wæ&öG“òæGW&F–öåG—RÀ¢3 ¢’ÇÀ¢76–væÖVçBæGW&F–öåG—RÇÀ¢çVÆÃ° ¢76–væÖVçBçWFFVDBÐ¢æ÷s° ¢–b€¢G—RÓÓÒ&g&VR ¢’°¢v—B6fTg&VT76–væÖVçG2€¢76–væÖVçG0¢“°¢ÒVÇ6R°¢v—B6fU&VçFÄ76–væÖVçG2€¢76–væÖVçG0¢“°¢Ð ¢–b€¢7F—fF–öå7FGW2ÓÓÐ¢&v—F–æuö7F—fF–öâ ¢’°¢6öç7BF—66÷&D6†ævVBÐ¢v—BVç7W&TÖævVE&öf–ÆTF—66÷&DÖW76vR€¢76–væÖVçBÀ¢G—P¢“° ¢–b†F—66÷&D6†ævVB’°¢–b€¢G—RÓÓÒ&g&VR ¢’°¢v—B6fTg&VT76–væÖVçG2€¢76–væÖVçG0¢“°¢ÒVÇ6R°¢v—B6fU&VçFÄ76–væÖVçG2€¢76–væÖVçG0¢“°¢Ð¢Ð¢Ð ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢7F—fF–öå7FGW2À¢7F—fF–öäÆ&VÃ ¢&öf–ÆT7F—fF–öäÆ&VÂ€¢7F—fF–öå7FGW0¢¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$FÖ–âFW7BÖævVBv÷&¶fÆ÷r6fRW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFò6fRFW7BÖævVB&öf–ÆRv÷&¶fÆ÷râ ¢Ò“°¢Ð¢Ð¢“°  ¦ævWB€¢"ö’öFÖ–â÷FW7B×&öf–ÆR×v÷&¶fÆ÷r"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B&V6÷&G2Ð¢v—BvWE&WF–ÆW%&öf–ÆW2‚“° ¢6öç7B&öf–ÆW2Ð¢&V6÷&G0¢æf–ÇFW"€¢&V6÷&BÓà¢7G&–ær€¢&V6÷&Bæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢’ÓÓÐ¢$DÔ”âÕ$Ud”Ur ¢¢ç6÷'B€¢†Â"’Óà¢çVÖ&W"†ç6Æ÷B’Ð¢çVÖ&W"†"ç6Æ÷B¢¢æÖ€¢&V6÷&BÓà¢6fU&WF–ÆW%&öf–ÆR€¢&V6÷&BÀ¢S ¢¢“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢&öf–ÆW0¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$FÖ–âFW7B7W7FöÖW"&öf–ÆRÆöBW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFòÆöBFÖ–âFW7B7W7FöÖW"&öf–ÆW2â ¢Ò“°¢Ð¢Ð¢“°  ¦çWB€¢"ö’öFÖ–â÷FW7B×&öf–ÆR×v÷&¶fÆ÷r"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B6Æ÷BÐ¢çVÖ&W"€¢&Wæ&öG“òç6Æ÷@¢“° ¢–b€¢çVÖ&W"æ—4–çFVvW"‡6Æ÷B’ÇÀ¢6Æ÷BÂÇÀ¢6Æ÷BâS ¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$–çfÆ–BFW7B&öf–ÆR6Æ÷Bâ ¢Ò“°¢Ð ¢6öç7B&öf–ÆTæÖRÐ¢6ÆVâ€¢&Wæ&öG“òç&öf–ÆTæÖRÀ¢ƒ ¢’ÇÀ¢&öf–ÆRG·6Æ÷GÖ° ¢6öç7B7V&Ö—GFVE&öf–ÆRÐ¢&Wæ&öG“òæ7W7FöÖW%&öf–ÆRb`¢G—Vöb&Wæ&öG’æ7W7FöÖW%&öf–ÆRÓÓÐ¢&ö&¦V7B ¢ò&Wæ&öG’æ7W7FöÖW%&öf–ÆP¢¢·Ó° ¢6öç7B7W7FöÖW%&öf–ÆRÐ¢6æ—F—¦U&öf–ÆR‡°¢ââç7V&Ö—GFVE&öf–ÆRÀ¢&öf–ÆTæÖRÀ¢VÖ–Ã ¢7V&Ö—GFVE&öf–ÆRæVÖ–ÂÇÀ¢&FÖ–â×&Wf–Wt6Æ'6æw&'66òæ6öÒ ¢Ò“° ¢6öç7B7V&Ö—GFVD6&BÐ¢&Wæ&öG“òæ7W7FöÖW$6&Bb`¢G—Vöb&Wæ&öG’æ7W7FöÖW$6&BÓÓÐ¢&ö&¦V7B ¢ò&Wæ&öG’æ7W7FöÖW$6&@¢¢·Ó° ¢6öç7B7W7FöÖW%6V7&WG2Ò°¢6&DÆ&VÃ ¢6ÆVâ€¢7V&Ö—GFVD6&Bæ6&DÆ&VÂÀ¢ ¢’À ¢6&F†öÆFW# ¢6ÆVâ€¢7V&Ö—GFVD6&Bæ6&F†öÆFW"À¢S ¢’À ¢6ô6&DçVÖ&W# ¢6ÆVâ€¢7V&Ö—GFVD6&Bæ6ô6&DçVÖ&W"À¢3 ¢’ç&WÆ6R€¢õµåÆEÒörÀ¢" ¢’À ¢W‡ÖöçFƒ ¢6ÆVâ€¢7V&Ö—GFVD6&BæW‡ÖöçF‚À¢ ¢’À ¢W‡–V# ¢6ÆVâ€¢7V&Ö—GFVD6&BæW‡–V"À¢@¢’À ¢6V7W&—G”6öFS ¢6ÆVâ€¢7V&Ö—GFVD6&Bç6V7W&—G”6öFRÀ¢3 ¢¢Ó° ¢6öç7B&VF–æW72Ð¢ÖævVE&öf–ÆU&VF–æW72€¢7W7FöÖW%&öf–ÆRÀ¢7W7FöÖW%6V7&WG0¢“° ¢6öç7B&V6÷&G2Ð¢v—BvWE&WF–ÆW%&öf–ÆW2‚“° ¢6öç7BW†—7F–æt–æFW‚Ð¢&V6÷&G2æf–æD–æFW‚€¢&V6÷&BÓà¢7G&–ær€¢&V6÷&Bæ7W7FöÖW$66÷VçD–BÇÀ¢" ¢’ÓÓÐ¢$DÔ”âÕ$Ud”Ur"b`¢çVÖ&W"€¢&V6÷&Bç6Æ÷@¢’ÓÓÐ¢6Æ÷@¢“° ¢6öç7BW†—7F–æu&V6÷&BÐ¢W†—7F–æt–æFW‚ãÒ ¢ò&V6÷&G5°¢W†—7F–æt–æFW€¢Ð¢¢çVÆÃ° ¢6öç7B&–÷%7FGW2Ð¢7G&–ær€¢W†—7F–æu&V6÷&Còæ7F—fF–öå7FGW2ÇÀ¢" ¢¢çG&–Ò‚¢çFôÆ÷vW$66R‚“° ¢6öç7B7F—fF–öå7FGW2Ð¢&VF–æW72ç&VG¢ò€¢&–÷%7FGW2ÓÓÐ¢&7F—fFVB ¢ò&7F—fFVB ¢¢&v—F–æuö7F—fF–öâ ¢¢¢&–æ6ö×ÆWFR#° ¢6öå¶¬{®0®+^zºè¬è‘ééŠ—³t submittedRetailers =
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
          const discordCfÚ±î¸Â¸­yêë¢°k¢G§¦*^†ævVBÐ¢v—BVç7W&TÖævVE&öf–ÆTF—66÷&DÖW76vR€¢76–væÖVçBÀ¢G—P¢“° ¢–b†F—66÷&D6†ævVB’°¢–b‡G—RÓÓÒ&g&VR"’°¢v—B6fTg&VT76–væÖVçG2€¢76–væÖVçG0¢“°¢ÒVÇ6R°¢v—B6fU&VçFÄ76–væÖVçG2€¢76–væÖVçG0¢“°¢Ð¢Ð¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$ÖævVB7F—fF–ærF—66÷&Bæ÷F–f–6F–öâf–ÆVC¢"À¢W'&÷"æÖW76vP¢“°¢Ð¢Ð ¢–b€¢G—RÓÓÒ'&VçFVB ¢’°¢G'’°¢6öç7B–ÖVçD6ÆV&VBÐ¢v—BÖ–&T6ÆV%&VçFÅW&6†6TF—66÷&B€¢76–væÖVçG2À¢76–væÖVç@¢“° ¢–b‡–ÖVçD6ÆV&VB’°¢v—B6fU&VçFÄ76–væÖVçG2€¢76–væÖVçG0¢“°¢Ð¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢%&VçFÂW&6†6R6ö×ÆWF–öâ6ÆVçWf–ÆVC¢"À¢W'&÷"æÖW76vP¢“°¢Ð¢Ð ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢7FGW3 ¢76–væÖVçBæ7F—fF–öå7FGW2À¢7F'G4C ¢76–væÖVçBç7F'G4BÇÀ¢çVÆÂÀ¢W‡—&W4C ¢76–væÖVçBæW‡—&W4BÇÀ¢çVÆÂÀ ¢–æfô6ö×ÆWFS ¢&VF–æW72ç&VG’À ¢7F—fFVEv—F„Ö—76–æt–æfð¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$ÖævVB&öf–ÆR7F—fF–öâWFFRW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFòWFFR&öf–ÆR7F—fF–öââ ¢Ò“°¢Ð¢Ð¢“°  ¦ç÷7B€¢"ö’öFÖ–â÷&öf–ÆRÖ7F—fF–öâó¦–B"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B–BÐ¢6ÆVâ€¢&Wç&×2æ–BÀ¢S ¢“° ¢6öç7B7F–öâÐ¢6ÆVâ€¢&Wæ&öG“òæ7F–öâÀ¢3 ¢¢çG&–Ò‚¢çFôÆ÷vW$66R‚“° ¢–b€¢°¢&7F—fFR"À¢&FV7F—fFR ¢Òæ–æ6ÇVFW2†7F–öâ¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$6†ö÷6R7F—fFR÷"FV7F—fFRâ ¢Ò“°¢Ð ¢6öç7B&V6÷&G2Ð¢v—BvWE&WF–ÆW%&öf–ÆW2‚“° ¢6öç7B&V6÷&BÐ¢&V6÷&G2æf–æB€¢—FVÒÓà¢7G&–ær€¢—FVÒæ–@¢’ÓÓÐ¢7G&–ær†–B¢“° ¢–b‚&V6÷&B’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢%–B&öf–ÆR6÷VÆBæ÷B&Rf÷VæBâ ¢Ò“°¢Ð ¢ÆWB6V7&WG2Ò·Ó° ¢G'’°¢–b€¢&V6÷&Bæ7W7FöÖW%6V7&WG0¢’°¢6V7&WG2Ð¢FV7'—D§6öâ€¢&V6÷&Bæ7W7FöÖW%6V7&WG0¢’ÇÂ·Ó°¢Ð¢Ò6F6‚°¢6V7&WG2Ò·Ó°¢Ð ¢6öç7B&VF–æW72Ð¢ÖævVE&öf–ÆU&VF–æW72€¢&V6÷&Bæ7W7FöÖW%&öf–ÆRÀ¢6V7&WG0¢“° ¢–b€¢7F–öâÓÓÐ¢&7F—fFR"b`¢&VF–æW72ç&VG¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢%F†—2&öf–ÆR7F–ÆÂ†2Ö—76–ær6†—–ær÷"6&B–æf÷&ÖF–öââ ¢Ò“°¢Ð ¢6öç7Bæ÷rÐ¢æWrFFR‚¢çFô•4õ7G&–ær‚“° ¢6öç7BF—66÷&DÖW76vT–BÐ¢&V6÷&BæF—66÷&E&öf–ÆTÖW76vT–BÇÀ¢çVÆÃ° ¢–b€¢7F–öâÓÓÐ¢&7F—fFR ¢’°¢&V6÷&Bæ7F—fF–öå7FGW2Ð¢&7F—fFVB#° ¢&V6÷&Bæ7F—fFVDBÐ¢æ÷s° ¢&V6÷&BæFV7F—fFVDBÐ¢çVÆÃ°¢ÒVÇ6R°¢&V6÷&Bæ7F—fF–öå7FGW2Ð¢&FV7F—fFVB#° ¢&V6÷&BæFV7F—fFVDBÐ¢æ÷s°¢Ð ¢&V6÷&BçWFFVDBÐ¢æ÷s° ¢&V6÷&BæF—66÷&E&öf–ÆTÖW76vT–BÐ¢çVÆÃ° ¢&V6÷&BæF—66÷&E&öf–ÆTÖW76vUG—RÐ¢çVÆÃ° ¢v—B6fU&WF–ÆW%&öf–ÆW2€¢&V6÷&G0¢“° ¢–b†F—66÷&DÖW76vT–B’°¢G'’°¢v—BFVÆWFTF—66÷&DFÖ–å&öf–ÆUv÷&¶fÆ÷tæ÷F–f–6F–öâ€¢F—66÷&DÖW76vT–@¢“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢%–B&öf–ÆRF—66÷&BÖW76vRFVÆWFRf–ÆVC¢"À¢W'&÷"æÖW76vP¢“°¢Ð¢Ð ¢–b€¢7F–öâÓÓÐ¢&7F—fFR ¢’°¢G'’°¢v—BÖ–&T6ÆV%–EW&6†6TF—66÷&B€¢&V6÷&Bæ7W7FöÖW$66÷VçD–@¢“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢%–BW&6†6R6ö×ÆWF–öâ6ÆVçWf–ÆVC¢"À¢W'&÷"æÖW76vP¢“°¢Ð¢Ð ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢7FGW3 ¢&V6÷&Bæ7F—fF–öå7FGW0¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$FÖ–â&öf–ÆR7F—fF–öâWFFRW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFòWFFR&öf–ÆR7F—fF–öââ ¢Ò“°¢Ð¢Ð¢“°  ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢DÔ”â5T4”Â$ôd”ÄU0¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦çWB€¢"ö’öFÖ–â÷7V&Ö—76–öç2ó¦–B÷7V6–Â×&öf–ÆW2ó§&öf–ÆUG—R"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B–BÐ¢6ÆVâ€¢&Wç&×2æ–BÀ¢S ¢“° ¢6öç7B&öf–ÆUG—RÐ¢æ÷&ÖÆ—¦U7V6–Å&öf–ÆUG—R€¢&Wç&×2ç&öf–ÆUG—P¢“° ¢–b‚&öf–ÆUG—R’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$–çfÆ–B7V6–Â&öf–ÆRG—Râ ¢Ò“°¢Ð ¢6öç7BGW&F–öåG—RÐ¢æ÷&ÖÆ—¦U7V6–Å&öf–ÆTGW&F–öâ€¢&Wæ&öG“òæGW&F–öåG—P¢“° ¢–b‚GW&F–öåG—R’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$6†ö÷6RfÆ–B&öf–ÆRGW&F–öââ ¢Ò“°¢Ð ¢6öç7B7F—fRÐ¢&Wæ&öG“òæ7F—fRÓÒfÇ6S° ¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7B–E&V6÷&G2Ð¢'&’æ—4'&’‡–B¢ò–@¢¢µÓ° ¦6öç7B÷&FW"Ð¢–E&V6÷&G2æf–æB€¢—FVÒÓà¢7G&–ær€¢—FVÒæ–@¢’ÓÓÒ–@¢“° ¦ÆWB7W7FöÖW$66÷VçD–BÐ¢÷&FW#òæ7W7FöÖW$66÷VçD–BÇÀ¢çVÆÃ° ¦–b‚7W7FöÖW$66÷VçD–B’°¢6öç7B66÷VçG2Ð¢v—BvWD7W7FöÖW$66÷VçG2‚“° ¢6öç7B66÷VçBÐ¢66÷VçG2æf–æB€¢—FVÒÓà¢7G&–ær€¢—FVÒæ–@¢’ÓÓÒ–@¢“° ¢–b†66÷VçB’°¢7W7FöÖW$66÷VçD–BÐ¢66÷VçBæ–C°¢Ð§Ð ¦–b‚7W7FöÖW$66÷VçD–B’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢$7W7FöÖW"66÷VçB6÷VÆBæ÷B&Rf÷VæBâ ¢Ò“°§Ð  ¢6öç7B7V&Ö—GFVBÐ¢&Wæ&öG“òç&WF–ÆW'2b`¢G—Vöb&Wæ&öG’ç&WF–ÆW'2ÓÓÐ¢&ö&¦V7B ¢ò&Wæ&öG’ç&WF–ÆW'0¢¢·Ó° ¢6öç7B&V6÷&G2Ð¢v—BvWE7V6–Å&öf–ÆW2‚“° ¢6öç7BW†—7F–æt–æFW‚Ð¢&V6÷&G2æf–æD–æFW‚€¢&V6÷&BÓà¢&V6÷&Bæ7W7FöÖW$66÷VçD–BÓÓÐ¢7W7FöÖW$66÷VçD–Bb`¢æ÷&ÖÆ—¦U7V6–Å&öf–ÆUG—R€¢&V6÷&Bç&öf–ÆUG—P¢’ÓÓÒ&öf–ÆUG—P¢“° ¢6öç7BW†—7F–æu&V6÷&BÐ¢W†—7F–æt–æFW‚ãÒ ¢ò&V6÷&G5°¢W†—7F–æt–æFW€¢Ð¢¢çVÆÃ° ¢ÆWBW†—7F–æt7&VFVçF–Ç2Ð¢V×G•&WF–ÆW$7&VFVçF–Ç2‚“° ¢–b€¢W†—7F–æu&V6÷&@¢òæ7&VFVçF–Ç0¢’°¢W†—7F–æt7&VFVçF–Ç2Ð¢æ÷&ÖÆ—¦U&WF–ÆW$7&VFVçF–Ç2€¢FV7'—D§6öâ€¢W†—7F–æu&V6÷&@¢æ7&VFVçF–Ç0¢¢“°¢Ð ¢6öç7BWFFVD7&VFVçF–Ç2Ð¢V×G•&WF–ÆW$7&VFVçF–Ç2‚“° ¢f÷"€¢6öç7B&WF–ÆW"ö`¢$UD”ÄU%ô´U•0¢’°¢6öç7B7V&Ö—GFVE&WF–ÆW"Ð¢7V&Ö—GFVE·&WF–ÆW%Òb`¢G—Vöb7V&Ö—GFVE°¢&WF–ÆW ¢ÒÓÓÒ&ö&¦V7B ¢ò7V&Ö—GFVE°¢&WF–ÆW ¢Ð¢¢·Ó° ¢6öç7BW6W&æÖRÐ¢6ÆVâ€¢7V&Ö—GFVE&WF–ÆW ¢çW6W&æÖRÀ¢#S@¢“° ¢6öç7B77v÷&BÐ¢7G&–ær€¢7V&Ö—GFVE&WF–ÆW ¢ç77v÷&BÇÂ" ¢“° ¢–b€¢77v÷&BæÆVæwF‚âS ¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$&WF–ÆW"77v÷&B—2FöòÆöærâ ¢Ò“°¢Ð ¢WFFVD7&VFVçF–Ç5°¢&WF–ÆW ¢ÒÒ°¢W6W&æÖRÀ ¢77v÷&C ¢77v÷&BÇÀ¢W†—7F–æt7&VFVçF–Ç5°¢&WF–ÆW ¢Òç77v÷&BÇÀ¢" ¢Ó°¢Ð ¢WFFVD7&VFVçF–Ç2ç¶2Ò°¢âââ€¢WFFVD7&VFVçF–Ç2ç¶2ÇÀ¢·Ð¢’À¢77v÷&C¢" ¢Ó° ¢6öç7Bæ÷rÐ¢æWrFFR‚“° ¦6öç7BW†—7F–ætGW&F–öâÐ¢æ÷&ÖÆ—¦U7V6–Å&öf–ÆTGW&F–öâ€¢W†—7F–æu&V6÷&@¢òæGW&F–öåG—P¢“° ¦6öç7Bv47F—fRÐ¢W†—7F–æu&V6÷&@¢ò7V6–Å&öf–ÆT—47F—fR€¢W†—7F–æu&V6÷&@¢¢¢fÇ6S° ¦6öç7B&W7F'EF–ÖW"Ð¢7F—fRb`¢€¢W†—7F–æu&V6÷&BÇÀ¢v47F—fRÇÀ¢W†—7F–ætGW&F–öâÓÐ¢GW&F–öåG—P¢“° ¦6öç7B7F'G4BÐ¢7F—fP¢ò€¢&W7F'EF–ÖW ¢òæ÷rçFô•4õ7G&–ær‚¢¢€¢W†—7F–æu&V6÷&@¢òç7F'G4BÇÀ¢æ÷rçFô•4õ7G&–ær‚¢¢¢¢€¢W†—7F–æu&V6÷&@¢òç7F'G4BÇÀ¢çVÆÀ¢“° ¦6öç7BW‡—&W4BÐ¢7F—fP¢ò€¢&W7F'EF–ÖW ¢ò7V6–Å&öf–ÆTW‡—&W4B€¢GW&F–öåG—RÀ¢æ÷p¢¢¢€¢W†—7F–æu&V6÷&@¢òæW‡—&W4Bóð¢7V6–Å&öf–ÆTW‡—&W4B€¢GW&F–öåG—RÀ¢W†—7F–æu&V6÷&@¢òç7F'G4BÇÀ¢æ÷p¢¢¢¢¢€¢W†—7F–æu&V6÷&@¢òæW‡—&W4BÇÀ¢çVÆÀ¢“° ¢6öç7B&V6÷&BÒ°¢–C ¢W†—7F–æu&V6÷&Còæ–BÇÀ¢7'—Fòç&æFöÕUT”B‚’À ¢7W7FöÖW$66÷VçD–C ¢7W7FöÖW$66÷VçD–BÀ ¢&öf–ÆUG—RÀ ¢&öf–ÆTæÖS ¢7V6–Å&öf–ÆTÆ&VÂ€¢&öf–ÆUG—P¢’À ¢7F—fRÀ ¢GW&F–öåG—RÀ ¢7F'G4BÀ ¢W‡—&W4BÀ ¢7&VFVçF–Ç3 ¢Væ7'—D§6öâ€¢WFFVD7&VFVçF–Ç0¢’À ¢7&VFVDC ¢W†—7F–æu&V6÷&@¢òæ7&VFVDBÇÀ¢æ÷rçFô•4õ7G&–ær‚’À ¢WFFVDC ¢æ÷rçFô•4õ7G&–ær‚’À ¢FÖ–åWFFVDC ¢æ÷rçFô•4õ7G&–ær‚¢Ó° ¢–b€¢W†—7F–æt–æFW‚ãÒ ¢’°¢&V6÷&G5°¢W†—7F–æt–æFW€¢ÒÒ&V6÷&C° ¢ÒVÇ6R°¢&V6÷&G2çW6‚€¢&V6÷&@¢“°¢Ð ¢v—B6fU7V6–Å&öf–ÆW2€¢&V6÷&G0¢“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ ¢ÖW76vS ¢G·7V6–Å&öf–ÆTÆ&VÂ€¢&öf–ÆUG—P¢—ÒWFFVB7V66W76gVÆÇ’æÀ ¢&öf–ÆS ¢FÖ–å7V6–Å&öf–ÆR€¢&V6÷&@¢¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$FÖ–â7V6–Â&öf–ÆRWFFRW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFòWFFRF†R7V6–Â&öf–ÆRâ ¢Ò“°¢Ð¢Ð¢“°  ¦çWB€¢"ö’öFÖ–â÷7V&Ö—76–öç2ó¦–B÷&WF–ÆW"×&öf–ÆW2ó§6Æ÷B"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B–BÐ¢6ÆVâ€¢&Wç&×2æ–BÀ¢S ¢“° ¢6öç7B6Æ÷BÐ¢çVÖ&W"€¢&Wç&×2ç6Æ÷@¢“° ¢–b€¢çVÖ&W"æ—4–çFVvW"‡6Æ÷B’ÇÀ¢6Æ÷BÂÇÀ¢6Æ÷BâS ¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$–çfÆ–B&WF–ÆW"&öf–ÆR6Æ÷Bâ ¢Ò“°¢Ð ¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7B–E&V6÷&G2Ð¢'&’æ—4'&’‡–B¢ò–@¢¢µÓ° ¢6öç7B÷&FW"Ð¢–E&V6÷&G2æf–æB€¢—FVÒÓà¢7G&–ær€¢—FVÒæ–@¢’ÓÓÒ–@¢“° ¢–b€¢÷&FW"ÇÀ¢÷&FW"æ7W7FöÖW$66÷VçD–@¢’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢$Æ–æ¶VB7W7FöÖW"66÷VçB6÷VÆBæ÷B&Rf÷VæBâ ¢Ò“°¢Ð ¢6öç7BÆÆ÷væ6RÐ¢v—BvWD7W7FöÖW%&öf–ÆTÆÆ÷væ6R€¢÷&FW"æ7W7FöÖW$66÷VçD–@¢“° ¢–b€¢6Æ÷BâÆÆ÷væ6P¢’°¢&WGW&â&W0¢ç7FGW2ƒC2¢æ§6öâ‡°¢W'&÷# ¢F†—2ÖVÖ&W'6†—7W'&VçFÇ’ÆÆ÷w2G¶ÆÆ÷væ6WÒ&öf–ÆRG¶ÆÆ÷væ6RÓÓÒò""¢'2'Òæ ¢Ò“°¢Ð ¢6öç7B&öf–ÆTæÖRÐ¢6ÆVâ€¢&Wæ&öG“òç&öf–ÆTæÖRÀ¢ƒ ¢“° ¢–b‚&öf–ÆTæÖR’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$VçFW"&WF–ÆW"&öf–ÆRæÖRâ ¢Ò“°¢Ð ¢6öç7B7V&Ö—GFVBÐ¢&Wæ&öG“òç&WF–ÆW'2b`¢G—Vöb&Wæ&öG’ç&WF–ÆW'2ÓÓÐ¢&ö&¦V7B ¢ò&Wæ&öG’ç&WF–ÆW'0¢¢·Ó° ¢6öç7B&V6÷&G2Ð¢v—BvWE&WF–ÆW%&öf–ÆW2‚“° ¢6öç7BW†—7F–æt–æFW‚Ð¢&V6÷&G2æf–æD–æFW‚€¢&V6÷&BÓà¢&V6÷&Bæ7W7FöÖW$66÷VçD–BÓÓÐ¢÷&FW"æ7W7FöÖW$66÷VçD–Bb`¢çVÖ&W"‡&V6÷&Bç6Æ÷B’ÓÓÐ¢6Æ÷@¢“° ¢6öç7BW†—7F–æu&V6÷&BÐ¢W†—7F–æt–æFW‚ãÒ ¢ò&V6÷&G5°¢W†—7F–æt–æFW€¢Ð¢¢çVÆÃ° ¢ÆWBW†—7F–æt7&VFVçF–Ç2Ð¢V×G•&WF–ÆW$7&VFVçF–Ç2‚“° ¢–b€¢W†—7F–æu&V6÷&@¢òæ7&VFVçF–Ç0¢’°¢W†—7F–æt7&VFVçF–Ç2Ð¢æ÷&ÖÆ—¦U&WF–ÆW$7&VFVçF–Ç2€¢FV7'—D§6öâ€¢W†—7F–æu&V6÷&@¢æ7&VFVçF–Ç0¢¢“°¢Ð ¢6öç7BWFFVD7&VFVçF–Ç2Ð¢V×G•&WF–ÆW$7&VFVçF–Ç2‚“° ¢f÷"€¢6öç7B&WF–ÆW"ö`¢$UD”ÄU%ô´U•0¢’°¢6öç7B7V&Ö—GFVE&WF–ÆW"Ð¢7V&Ö—GFVE·&WF–ÆW%Òb`¢G—Vöb7V&Ö—GFVE°¢&WF–ÆW ¢ÒÓÓÒ&ö&¦V7B ¢ò7V&Ö—GFVE°¢&WF–ÆW ¢Ð¢¢·Ó° ¢6öç7BW6W&æÖRÐ¢6ÆVâ€¢7V&Ö—GFVE&WF–ÆW ¢çW6W&æÖRÀ¢#S@¢“° ¢6öç7B77v÷&BÐ¢7G&–ær€¢7V&Ö—GFVE&WF–ÆW ¢ç77v÷&BÇÂ" ¢“° ¢–b€¢77v÷&BæÆVæwF‚à¢S ¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$&WF–ÆW"77v÷&B—2FöòÆöærâ ¢Ò“°¢Ð ¢WFFVD7&VFVçF–Ç5°¢&WF–ÆW ¢ÒÒ°¢W6W&æÖRÀ ¢77v÷&C ¢77v÷&BÇÀ¢W†—7F–æt7&VFVçF–Ç5°¢&WF–ÆW ¢Òç77v÷&BÇÀ¢" ¢Ó°¢Ð ¢ÆWBW†—7F–æt7W7FöÖW%6V7&WG2Ò·Ó° ¢G'’°¢–b€¢W†—7F–æu&V6÷&@¢òæ7W7FöÖW%6V7&WG0¢’°¢W†—7F–æt7W7FöÖW%6V7&WG2Ð¢FV7'—D§6öâ€¢W†—7F–æu&V6÷&Bæ7W7FöÖW%6V7&WG0¢’ÇÂ·Ó°¢Ð¢Ò6F6‚°¢W†—7F–æt7W7FöÖW%6V7&WG2Ò·Ó°¢Ð ¢6öç7B7V&Ö—GFVD7W7FöÖW%&öf–ÆRÐ¢&Wæ&öG“òæ7W7FöÖW%&öf–ÆRb`¢G—Vöb&Wæ&öG’æ7W7FöÖW%&öf–ÆRÓÓÐ¢&ö&¦V7B ¢ò&Wæ&öG’æ7W7FöÖW%&öf–ÆP¢¢çVÆÃ° ¢6öç7B7V&Ö—GFVD7W7FöÖW$6&BÐ¢&Wæ&öG“òæ7W7FöÖW$6&Bb`¢G—Vöb&Wæ&öG’æ7W7FöÖW$6&BÓÓÐ¢&ö&¦V7B ¢ò&Wæ&öG’æ7W7FöÖW$6&@¢¢çVÆÃ° ¢6öç7B7W7FöÖW%&öf–ÆRÐ¢7V&Ö—GFVD7W7FöÖW%&öf–ÆP¢ò6æ—F—¦U&öf–ÆR‡°¢âââ€¢W†—7F–æu&V6÷&Còæ7W7FöÖW%&öf–ÆRÇÀ¢·Ð¢’À¢ââç7V&Ö—GFVD7W7FöÖW%&öf–ÆRÀ ¢&öf–ÆTæÖS ¢&öf–ÆTæÖRÀ ¢VÖ–Ã ¢7V&Ö—GFVD7W7FöÖW%&öf–ÆRæVÖ–ÂÇÀ¢W†—7F–æu&V6÷&Còæ7W7FöÖW%&öf–ÆSòæVÖ–ÂÇÀ¢" ¢Ò¢¢€¢W†—7F–æu&V6÷&Còæ7W7FöÖW%&öf–ÆRÇÀ¢çVÆÀ¢“° ¢6öç7B7W7FöÖW%6V7&WG2Ò°¢ââæW†—7F–æt7W7FöÖW%6V7&WG0¢Ó° ¢–b‡7V&Ö—GFVD7W7FöÖW$6&B’°¢–b€¢ö&¦V7Bç&÷F÷G—Ræ†4÷vå&÷W'G’æ6ÆÂ€¢7V&Ö—GFVD7W7FöÖW$6&BÀ¢&6&DÆ&VÂ ¢¢’°¢7W7FöÖW%6V7&WG2æ6&DÆ&VÂÐ¢6ÆVâ€¢7V&Ö—GFVD7W7FöÖW$6&Bæ6&DÆ&VÂÀ¢ ¢“°¢Ð ¢–b€¢ö&¦V7Bç&÷F÷G—Ræ†4÷vå&÷W'G’æ6ÆÂ€¢7V&Ö—GFVD7W7FöÖW$6&BÀ¢&6&F†öÆFW" ¢¢’°¢7W7FöÖW%6V7&WG2æ6&F†öÆFW"Ð¢6ÆVâ€¢7V&Ö—GFVD7W7FöÖW$6&Bæ6&F†öÆFW"À¢S ¢“°¢Ð ¢6öç7B7V&Ö—GFVDçVÖ&W"Ð¢6ÆVâ€¢7V&Ö—GFVD7W7FöÖW$6&Bæ6ô6&DçVÖ&W"À¢3 ¢’ç&WÆ6R€¢õµåÆEÒörÀ¢" ¢“° ¢–b‡7V&Ö—GFVDçVÖ&W"’°¢7WjÇºã
âµç«®ŠÁ®‰ž˜©{tomerSecrets.acoCardNumber =
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
              "m«ëŒ+Š×ž®º+º$zzb¥å6†—–ærFG&W72æ÷Bf÷VæBâ ¢Ò“°¢Ð ¢66÷VçG5°¢66÷VçD–æFW€¢Òç6†—–ætFG&W76W2Ð¢gFW#° ¢66÷VçG5°¢66÷VçD–æFW€¢ÒçWFFVDBÐ¢æWrFFR‚¢çFô•4õ7G&–ær‚“° ¢v—B6fT7W7FöÖW$66÷VçG2€¢66÷VçG0¢“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢ÖW76vS ¢%6†—–ærFG&W72FVÆWFVBâ ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$FVÆWFR6†—–ærFG&W72W'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFòFVÆWFR6†—–ærFG&W72â ¢Ò“°¢Ð¢Ð¢“° ¦ç÷7B€¢"ö’ö66÷VçB÷–ÖVçBÖÖWF†öG2"À¢&WV—&T7W7FöÖW"À¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BfVÇBÐ¢v—BvWD7W7FöÖW%fVÇB€¢&Wæ7W7FöÖW$66÷VçBæ–@¢“° ¢–b€¢fVÇBç–ÖVçDÖWF†öG0¢æÆVæwF‚ãÒ# ¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢%–÷R6â6fRWFò#–ÖVçB6&G2â ¢Ò“°¢Ð ¢6öç7BÖWF†öBÐ¢6æ—F—¦U6fVE–ÖVçDÖWF†öB€¢&Wæ&öG¢“° ¢–b€¢fÆ–E6fVE–ÖVçDÖWF†öB€¢ÖWF†ö@¢¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$VçFW"6&BÆ&VÂÂ6&F†öÆFW"ÂfÆ–B6&BçVÖ&W"ÂW‡—&F–öâÖöçF‚ÂæBW‡—&F–öâ–V"â ¢Ò“°¢Ð ¢fVÇBç–ÖVçDÖWF†öG2çW6‚€¢ÖWF†ö@¢“° ¢v—B6fT7W7FöÖW%fVÇB€¢&Wæ7W7FöÖW$66÷VçBæ–BÀ¢fVÇ@¢“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢–C ¢ÖWF†öBæ–BÀ¢ÖW76vS ¢%–ÖVçB6&B6fVBâ ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢%6fR–ÖVçBÖWF†öBW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFò6fR–ÖVçB6&Bâ ¢Ò“°¢Ð¢Ð¢“° ¦çWB€¢"ö’ö66÷VçB÷–ÖVçBÖÖWF†öG2ó¦–B"À¢&WV—&T7W7FöÖW"À¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B–BÐ¢6ÆVâ€¢&Wç&×2æ–BÀ¢# ¢“° ¢6öç7BfVÇBÐ¢v—BvWD7W7FöÖW%fVÇB€¢&Wæ7W7FöÖW$66÷VçBæ–@¢“° ¢6öç7B–æFW‚Ð¢fVÇBç–ÖVçDÖWF†öG0¢æf–æD–æFW‚€¢—FVÒÓà¢7G&–ær†—FVÒæ–B’ÓÓÐ¢–@¢“° ¢–b†–æFW‚Â’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢%–ÖVçB6&Bæ÷Bf÷VæBâ ¢Ò“°¢Ð ¢6öç7BæW‡BÐ¢6æ—F—¦U6fVE–ÖVçDÖWF†öB€¢&Wæ&öG’À¢fVÇBç–ÖVçDÖWF†öG5°¢–æFW€¢Ð¢“° ¢–b€¢fÆ–E6fVE–ÖVçDÖWF†öB€¢æW‡@¢¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$VçFW"6&BÆ&VÂÂ6&F†öÆFW"ÂfÆ–B6&BçVÖ&W"ÂW‡—&F–öâÖöçF‚ÂæBW‡—&F–öâ–V"â ¢Ò“°¢Ð ¢fVÇBç–ÖVçDÖWF†öG5°¢–æFW€¢ÒÒæW‡C° ¢v—B6fT7W7FöÖW%fVÇB€¢&Wæ7W7FöÖW$66÷VçBæ–BÀ¢fVÇ@¢“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢ÖW76vS ¢%–ÖVçB6&BWFFVBâ ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢%WFFR–ÖVçBÖWF†öBW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFòWFFR–ÖVçB6&Bâ ¢Ò“°¢Ð¢Ð¢“° ¦æFVÆWFR€¢"ö’ö66÷VçB÷–ÖVçBÖÖWF†öG2ó¦–B"À¢&WV—&T7W7FöÖW"À¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B–BÐ¢6ÆVâ€¢&Wç&×2æ–BÀ¢# ¢“° ¢6öç7BfVÇBÐ¢v—BvWD7W7FöÖW%fVÇB€¢&Wæ7W7FöÖW$66÷VçBæ–@¢“° ¢6öç7B&Vf÷&RÐ¢fVÇBç–ÖVçDÖWF†öG3° ¢6öç7BgFW"Ð¢&Vf÷&Ræf–ÇFW"€¢—FVÒÓà¢7G&–ær†—FVÒæ–B’ÓÐ¢–@¢“° ¢–b€¢gFW"æÆVæwF‚ÓÓÐ¢&Vf÷&RæÆVæwF€¢’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢%–ÖVçB6&Bæ÷Bf÷VæBâ ¢Ò“°¢Ð ¢fVÇBç–ÖVçDÖWF†öG2Ð¢gFW#° ¢v—B6fT7W7FöÖW%fVÇB€¢&Wæ7W7FöÖW$66÷VçBæ–BÀ¢fVÇ@¢“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢ÖW76vS ¢%–ÖVçB6&BFVÆWFVBâ ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$FVÆWFR–ÖVçBÖWF†öBW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFòFVÆWFR–ÖVçB6&Bâ ¢Ò“°¢Ð¢Ð¢“°  ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢5U5DôÔU"$ôd”ÄRòõ$DU"„TÅU%0¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦gVæ7F–öâ6fT7W7FöÖW$÷&FW"€¢&V6÷&@¢’°¢&WGW&â°¢–C ¢&V6÷&Bæ–BÀ ¢÷&FW$çVÖ&W# ¢7W7FöÖW$÷&FW$çVÖ&W"€¢&V6÷&@¢’À ¢Æã ¢&V6÷&BçÆâÇÂçVÆÂÀ ¢&öf–ÆS ¢&V6÷&Bç&öf–ÆRÇÂçVÆÂÀ ¢7&VFVDC ¢&V6÷&Bæ7&VFVDBÇÀ¢çVÆÂÀ ¢–DC ¢&V6÷&Bç–DBÇÀ¢çVÆÂÀ ¢7V'67&—F–öå7FGW3 ¢&V6÷&Bç7V'67&—F–öå7FGW2ÇÀ¢çVÆÂÀ ¢7W'&VçEW&–öE7F'C ¢&V6÷&Bæ7W'&VçEW&–öE7F'BÇÀ¢çVÆÂÀ ¢7W'&VçEW&–öDVæC ¢&V6÷&Bæ7W'&VçEW&–öDVæBÇÀ¢çVÆÂÀ ¢7V'67&—F–öäVæDFFS ¢&V6÷&Bç7V'67&—F–öäVæDFFRÇÀ¢çVÆÂÀ ¢6æ6VÄEW&–öDVæC ¢&V6÷&Bæ6æ6VÄEW&–öDVæBÓÓÐ¢G'VRÀ ¢6æ6VÆVDC ¢&V6÷&Bæ6æ6VÆVDBÇÀ¢çVÆÂÀ ¢VæFVDC ¢&V6÷&BæVæFVDBÇÀ¢çVÆÂÀ ¢7W7FöÖW$Æ–æ¶VDC ¢&V6÷&Bæ7W7FöÖW$Æ–æ¶VDBÇÀ¢çVÆÂÀ ¢WFFVDC ¢&V6÷&BçWFFVDBÇÀ¢&V6÷&Bç7V'67&—F–öåWFFVDBÇÀ¢çVÆÀ¢Ó°§Ð ¦7–æ2gVæ7F–öâvWD7W7FöÖW$÷væVD÷&FW'2€¢66÷VçD–@¢’°¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢&WGW&â€¢'&’æ—4'&’‡–B¢ò–@¢¢µÐ¢’æf–ÇFW"€¢&V6÷&BÓà¢&V6÷&Bæ7W7FöÖW$66÷VçD–BÓÓÐ¢66÷VçD–@¢“°§Ð ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢UDòÔÄ”ä²dU$”d”TB5U5DôÔU"õ$DU%0¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦7–æ2gVæ7F–öâWFôÆ–æµfW&–f–VD7W7FöÖW$÷&FW'2€¢66÷Vç@¢’°¢–b€¢66÷VçCòæ–BÇÀ¢66÷VçCòæVÖ–ÅfW&–f–VD@¢’°¢&WGW&â°¢Æ–æ¶VC¢ ¢Ó°¢Ð ¢6öç7B66÷VçDVÖ–ÂÐ¢æ÷&ÖÆ—¦TVÖ–Â€¢66÷VçBæVÖ–À¢“° ¢–b‚66÷VçDVÖ–Â’°¢&WGW&â°¢Æ–æ¶VC¢ ¢Ó°¢Ð ¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7B&V6÷&G2Ð¢'&’æ—4'&’‡–B¢ò–@¢¢µÓ° ¢ÆWBÆ–æ¶VBÒ° ¢6öç7BÆ–æ¶VDBÐ¢æWrFFR‚¢çFô•4õ7G&–ær‚“° ¢f÷"€¢6öç7B&V6÷&Böb&V6÷&G0¢’°¢ò ¢æWfW"Ö÷fRâ÷&FW"F†B—2Ç&VG¢6öææV7FVBFòæ÷F†W"66÷VçBà¢¢ð¢–b€¢&V6÷&Bæ7W7FöÖW$66÷VçD–@¢’°¢6öçF–çVS°¢Ð ¢6öç7B÷&FW$VÖ–ÂÐ¢æ÷&ÖÆ—¦TVÖ–Â€¢&V6÷&Còç&öf–ÆSòæVÖ–À¢“° ¢–b€¢÷&FW$VÖ–ÂÇÀ¢÷&FW$VÖ–ÂÓÐ¢66÷VçDVÖ–À¢’°¢6öçF–çVS°¢Ð ¢&V6÷&Bæ7W7FöÖW$66÷VçD–BÐ¢66÷VçBæ–C° ¢&V6÷&Bæ7W7FöÖW$Æ–æ¶VDBÐ¢Æ–æ¶VDC° ¢&V6÷&Bæ7W7FöÖW$Æ–æ¶VD'’Ð¢'fW&–f–VBÖVÖ–Â#° ¢Æ–æ¶VB³Ò°¢Ð ¢–b†Æ–æ¶VBâ’°¢v—Bw&—FT§6öâ€¢”Eôd”ÄRÀ¢&V6÷&G0¢“°¢Ð ¢&WGW&â°¢Æ–æ¶V@¢Ó°§Ð ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢UDDR5U5DôÔU"õ$DU"ò4ò”ädõ$ÔD”ôà¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦çWB€¢"ö’ö66÷VçBö÷&FW'2ó¦÷&FW$çVÖ&W""À¢&WV—&T7W7FöÖW"À¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B&WVW7FVD÷&FW$çVÖ&W"Ð¢6ÆVâ€¢&Wç&×2æ÷&FW$çVÖ&W"À¢S ¢“° ¢–b‚&WVW7FVD÷&FW$çVÖ&W"’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$÷&FW"çVÖ&W"—2&WV—&VBâ ¢Ò“°¢Ð ¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7B&V6÷&G2Ð¢'&’æ—4'&’‡–B¢ò–@¢¢µÓ° ¢6öç7B&V6÷&BÐ¢&V6÷&G2æf–æB€¢—FVÒÓà¢7W7FöÖW$÷&FW$çVÖ&W"€¢—FVÐ¢’çFôÆ÷vW$66R‚’ÓÓÐ¢&WVW7FVD÷&FW$çVÖ&W ¢çFôÆ÷vW$66R‚’b`¢—FVÒæ7W7FöÖW$66÷VçD–BÓÓÐ¢&Wæ7W7FöÖW$66÷VçBæ–@¢“° ¢–b‚&V6÷&B’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢W'&÷# ¢$÷&FW"6÷VÆBæ÷B&Rf÷VæBâ ¢Ò“°¢Ð ¢6öç7B&öf–ÆT&öG’Ð¢&Wæ&öG“òç&öf–ÆRb`¢G—Vöb&Wæ&öG’ç&öf–ÆRÓÓÐ¢&ö&¦V7B ¢ò&Wæ&öG’ç&öf–ÆP¢¢·Ó° ¢6öç7BæW‡E&öf–ÆRÒ°¢âââ‡&V6÷&Bç&öf–ÆRÇÂ·Ò¢Ó° ¢6öç7BVF—F&ÆU&öf–ÆTf–VÆG2Ò°¢²'&öf–ÆTæÖR"Â3ÒÀ¢²&f—'7DæÖR"ÂÒÀ¢²&Æ7DæÖR"ÂÒÀ¢²&VÖ–Â"Â#ÒÀ¢²'†öæR"ÂSÒÀ¢²&FG&W72"Â3ÒÀ¢²&FG&W73""Â3ÒÀ¢²&6÷VçG'’"ÂÒÀ¢²'7FFR"ÂÒÀ¢²&6—G’"ÂÒÀ¢²'¦—"Â3Ð¢Ó° ¢f÷"€¢6öç7B°¢¶W’À¢Ö€¢Òö`¢VF—F&ÆU&öf–ÆTf–VÆG0¢’°¢–b€¢ö&¦V7Bç&÷F÷G—P¢æ†4÷vå&÷W'G’æ6ÆÂ€¢&öf–ÆT&öG’À¢¶W¢¢’°¢æW‡E&öf–ÆU¶¶W•ÒÐ¢6ÆVâ€¢&öf–ÆT&öG•¶¶W•ÒÀ¢Ö€¢“°¢Ð¢Ð ¢–b‚fÆ–E&öf–ÆR€¢æW‡E&öf–ÆP¢’’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢%ÆV6R6ö×ÆWFRÆÂ&WV—&VB7W7FöÖW"æB6†—–ær–æf÷&ÖF–öââ ¢Ò“°¢Ð ¢ÆWBW†—7F–æu6V7&WG2Ò·Ó° ¢G'’°¢6öç7BVæ7'—FVBÐ¢v—B&VD§6öâ€¢F‚æ¦ö–â€¢4T5$UEôD•"À¢G·&V6÷&Bæ–GÒæVæ7'—FVBæ§6öæ ¢’À¢çVÆÀ¢“° ¢–b†Væ7'—FVB’°¢W†—7F–æu6V7&WG2Ð¢FV7'—D§6öâ€¢Væ7'—FV@¢“°¢Ð¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$7W7FöÖW"6V7W&R6¶vRFV7'—BW'&÷#¢"À¢W'&÷"æÖW76vP¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFò6V7W&VÇ’ÆöBF†R6fVB4ò–æf÷&ÖF–öââ ¢Ò“°¢Ð ¢6öç7B6V7&WG4&öG’Ð¢&Wæ&öG“òç6V7&WG2b`¢G—Vöb&Wæ&öG’ç6V7&WG2ÓÓÐ¢&ö&¦V7B ¢ò&Wæ&öG’ç6V7&WG0¢¢·Ó° ¢6öç7BæW‡E6V7&WG2Ò°¢ââæW†—7F–æu6V7&WG0¢Ó° ¢–b€¢ö&¦V7Bç&÷F÷G—P¢æ†4÷vå&÷W'G’æ6ÆÂ€¢6V7&WG4&öG’À¢&6ôVÖ–Â ¢¢’°¢6öç7BfÇVRÐ¢6ÆVâ€¢6V7&WG4&öG’æ6ôVÖ–ÂÀ¢# ¢“° ¢–b‡fÇVR’°¢æW‡E6V7&WG2æ6ôVÖ–ÂÐ¢fÇVS°¢Ð¢Ð ¢6öç7B&WÆ6VÖVçD6õ77v÷&BÐ¢7G&–ær€¢6V7&WG4&öG¢æ6õ77v÷&BÇÂ" ¢“° ¢–b€¢&WÆ6VÖVçD6õ77v÷&@¢’°¢–b€¢&WÆ6VÖVçD6õ77v÷&@¢æÆVæwF‚â3 ¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$4ò77v÷&B—2FöòÆöærâ ¢Ò“°¢Ð ¢æW‡E6V7&WG2æ6õ77v÷&BÐ¢&WÆ6VÖVçD6õ77v÷&C°¢Ð ¢–b€¢ö&¦V7Bç&÷F÷G—P¢æ†4÷vå&÷W'G’æ6ÆÂ€¢6V7&WG4&öG’À¢&6&DÆ&VÂ ¢¢’°¢6öç7BfÇVRÐ¢6ÆVâ€¢6V7&WG4&öG’æ6&DÆ&VÂÀ¢ ¢“° ¢–b‡fÇVR’°¢æW‡E6V7&WG2æ6&DÆ&VÂÐ¢fÇVS°¢Ð¢Ð ¢–b€¢ö&¦V7Bç&÷F÷G—P¢æ†4÷vå&÷W'G’æ6ÆÂ€¢6V7&WG4&öG’À¢&6&F†öÆFW" ¢¢’°¢6öç7BfÇVRÐ¢6ÆVâ€¢6V7&WG4&öG’æ6&F†öÆFW"À¢S ¢“° ¢–b‡fÇVR’°¢æW‡E6V7&WG2æ6&F†öÆFW"Ð¢fÇVS°¢Ð¢Ð ¢6öç7B&WÆ6VÖVçD6&DçVÖ&W"Ð¢6ÆVâ€¢6V7&WG4&öG¢æ6ô6&DçVÖ&W"À¢3 ¢’ç&WÆ6R€¢õµåÆEÒörÀ¢" ¢“° ¢–b€¢&WÆ6VÖVçD6&DçVÖ&W ¢’°¢–b€¢õåÆG³"Ã—ÒBòçFW7B€¢&WÆ6VÖVçD6&DçVÖ&W ¢¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$VçFW"fÆ–B&WÆ6VÖVçB6&BçVÖ&W"â ¢Ò“°¢Ð ¢æW‡E6V7&WG2æ6ô6&DçVÖ&W"Ð¢&WÆ6VÖVçD6&DçVÖ&W#°¢Ð ¢6öç7B&WÆ6VÖVçDÖöçF‚Ð¢6ÆVâ€¢6V7&WG4&öG’æW‡ÖöçF‚À¢ ¢“° ¢6öç7B&WÆ6VÖVçE–V"Ð¢6ÆVâ€¢6V7&WG4&öG’æW‡–V"À¢@¢“° ¢–b€¢&WÆ6VÖVçDÖöçF‚ÇÀ¢&WÆ6VÖVçE–V ¢’°¢–b€¢&WÆ6VÖVçDÖöçF‚ÇÀ¢&WÆ6VÖVçE–V ¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$VçFW"&÷F‚F†R&WÆ6VÖVçBW‡—&F–öâÖöçF‚æB–V"â ¢Ò“°¢Ð ¢æW‡E6V7&WG2æW‡ÖöçF‚Ð¢&WÆ6VÖVçDÖöçFƒ° ¢æW‡E6V7&WG2æW‡–V"Ð¢&WÆ6VÖVçE–V#°¢Ð ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢4T5U$•E’4ôDR$UÄ4TÔTå@¢&Ææ²Ò¶VWF†RW†—7F–ær6fVBfÇVP¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦6öç7B&WÆ6VÖVçE6V7W&—G”6öFRÐ¢6ÆVâ€¢6V7&WG4&öG’ç6V7W&—G”6öFRÀ¢3 ¢“° ¦–b‡&WÆ6VÖVçE6V7W&—G”6öFR’°¢æW‡E6V7&WG2ç6V7W&—G”6öFRÐ¢&WÆ6VÖVçE6V7W&—G”6öFS°§Ð  ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢5U5DôÔU"UDDRTD•@¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦6öç7BWFFVDBÐ¢æWrFFR‚¢çFô•4õ7G&–ær‚“° §&V6÷&Bç&öf–ÆRÐ¢æW‡E&öf–ÆS° ¢ò ¢vVæW&ÂÆ7BÖÖöF–f–VBF–ÖW7F×à¢¢ð§&V6÷&BçWFFVDBÐ¢WFFVDC° ¢ò ¢7V6–f–6ÆÇ’–FVçF–f–W2âVF—BÖFP¢g&öÒF†R7W7FöÖW"w2×’&öf–ÆRvRà¢¢ð§&V6÷&Bæ7W7FöÖW%WFFVDBÐ¢WFFVDC° §&V6÷&BçWFFVD'’Ð¢&7W7FöÖW"#°  ¢ò¢6fRWFFVBVæ7'—FVB4ò–æf÷&ÖF–öâ¢ð ¦v—B6fTVæ7'—FVE6¶vR€¢&V6÷&Bæ–BÀ¢æW‡E6V7&WG0¢“°  ¢ò¢6fRWFFVB7W7FöÖW"ö÷&FW"&V6÷&B¢ð ¦v—Bw&—FT§6öâ€¢”Eôd”ÄRÀ¢&V6÷&G0¢“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ ¢ÖW76vS ¢%–÷W"&öf–ÆR–æf÷&ÖF–öâ†2&VVâWFFVBâ"À ¢÷&FW# ¢6fT7W7FöÖW$÷&FW"€¢&V6÷&@¢¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$7W7FöÖW"÷&FW"WFFRW'&÷#¢"À¢W'&÷ ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%Væ&ÆRFòWFFR–÷W"&öf–ÆR–æf÷&ÖF–öââ ¢Ò“°¢Ð¢Ð¢“° ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢5$TDR$TåDÂ4„T4´õUB4U54”ôà¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦ç÷7B€¢"ö’ö7&VFR×&VçFÂÖ6†V6¶÷WB×6W76–öâ"À¢&WV—&T7W7FöÖW"À¢7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B&WF–ÆW"Ð¢æ÷&ÖÆ—¦U&VçFÅ&WF–ÆW"€¢&Wæ&öG“òç&WF–ÆW ¢“° ¢6öç7BVçF—G’Ð¢çVÖ&W"€¢&Wæ&öG“òçVçF—G¢“° ¢6öç7BGW&F–öåG—RÐ¢æ÷&ÖÆ—¦U7V6–Å&öf–ÆTGW&F–öâ€¢&Wæ&öG“òæGW&F–öåG—P¢“° ¢6öç7B&–6RÐ¢&VçFÅ&–6Tf÷"€¢VçF—G’À¢GW&F–öåG—P¢“° ¢6öç7B&VçFÅ&–6T–BÐ¢&VçFÅ&–6T–Df÷"€¢VçF—G’À¢GW&F–öåG—P¢“° ¢–b€¢&WF–ÆW"ÇÀ¢³RÂÂUÒæ–æ6ÇVFW2€¢VçF—G¢’ÇÀ¢°¢#öG&÷"À¢#÷vVV²"À¢#öÖöçF‚ ¢Òæ–æ6ÇVFW2†GW&F–öåG—R’ÇÀ¢&–6RÓÒçVÆÀ¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢W'&÷# ¢$6†ö÷6RfÆ–B&VçFÂ6¶vRâ ¢Ò“°¢Ð ¢–b‚&VçFÅ&–6T–B’°¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢W'&÷# ¢%F†—2&VçFÂ6¶vR—2æ÷B6öæf–wW&VBf÷"7G&—R6†V6¶÷WB–WBâ ¢Ò“°¢Ð ¢6öç7B7W7FöÖW$66÷VçD–BÐ¢&Wæ7W7FöÖW$66÷VçBæ–C° ¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7B–E&V6÷&G2Ð¢'&’æ—4'&’‡–B¢ò–@¢¢µÓ° ¢6öç7B–E&V6÷&BÐ¢–E&V6÷&G2æf–æB€¢&V6÷&BÓà¢&V6÷&Bæ7W7FöÖW$66÷VçD–BÓÓÐ¢7W7FöÖW$66÷VçD–Bb`¢7V'67&—F–öäÆÆ÷w5&öf–ÆW2€¢&V6÷&@¢¢“° ¢6öç7B7F—fTv–gBÒ–E&V6÷&@¢ò†v—BvWDv–gFVDÖVÖ&W'6†—2‚’’æf–æB†—FVÒÓà¢7G&–ær†—FVÒæ7W7FöÖW$66÷VçD–B’ÓÓÒ7G&–ær†7W7FöÖW$66÷VçD–B’b`¢æWrFFR†—FVÒç7F'G4B’ævWEF–ÖR‚’ÃÒFFRææ÷r‚’b`¢æWrFFR†—FVÒæW‡—&W4B’ævWEF–ÖR‚’âFFRææ÷r‚¢¢¢çVÆÃ°¢–b‚–E&V6÷&Bbb7F—fTv–gB’°¢&WGW&â&W0¢ç7FGW2ƒC2¢æ§6öâ‡°¢W'&÷# ¢$â7F—fRÖVÖ&W'6†——2&WV—&VB&Vf÷&R&VçF–ærFF—F–öæÂ66÷VçG2â ¢Ò“°¢Ð ¢6öç7Bf–Æ&ÆT66÷VçG2Ð¢v—BvWDf–Æ&ÆTÖævVD66÷VçG4f÷%&WF–ÆW"€¢&WF–ÆW ¢“° ¢–b€¢f–Æ&ÆT66÷VçG2æÆVæwF‚À¢VçF›jÇºã
âµç«®ŠÁ®‰ž˜©yty
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
            `${targetPlan.name} â€” ${targetPlan.profiles} profile(s)`,

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
    m«ëŒ+Š×ž®º+º$zzb¥âæÖS¢%–†öò"À¢†÷7C¢&–ÖæÖ–Âç–†öòæ6öÒ"À¢÷'C¢““0¢ÒÀ ¢&÷WFÆöö²æ6öÒ#¢°¢æÖS¢$Ö–7&÷6ögB"À¢†÷7C¢&÷WFÆöö²æöff–6S3cRæ6öÒ"À¢÷'C¢““0¢ÒÀ ¢&†÷FÖ–Âæ6öÒ#¢°¢æÖS¢$Ö–7&÷6ögB"À¢†÷7C¢&÷WFÆöö²æöff–6S3cRæ6öÒ"À¢÷'C¢““0¢ÒÀ ¢&Æ—fRæ6öÒ#¢°¢æÖS¢$Ö–7&÷6ögB"À¢†÷7C¢&÷WFÆöö²æöff–6S3cRæ6öÒ"À¢÷'C¢““0¢Ð¢Ó° ¢&WGW&â€¢&÷f–FW'5¶FöÖ–åÒÇÀ¢çVÆÀ¢“°§Ð  ¦gVæ7F–öâ7&VFT7W7FöÖW$–Ö6Æ–VçB€¢VÖ–ÂÀ¢77v÷&@¢’°¢6öç7B&÷f–FW"Ð¢vWD–Ö&÷f–FW"†VÖ–Â“° ¢–b‚&÷f–FW"’°¢6öç7BW'&÷"Ð¢æWrW'&÷"€¢%Vç7W÷'FVBÖ–Æ&÷‚&÷f–FW"â ¢“° ¢W'&÷"æ6öFRÐ¢%Tå5Uõ%DTEõ$õd”DU"#° ¢F‡&÷rW'&÷#°¢Ð ¢&WGW&â°¢&÷f–FW"À ¢6Æ–VçC ¢æWr–ÖfÆ÷r‡°¢†÷7C ¢&÷f–FW"æ†÷7BÀ ¢÷'C ¢&÷f–FW"ç÷'BÀ ¢6V7W&S ¢G'VRÀ ¢WFƒ¢°¢W6W# ¢æ÷&ÖÆ—¦TVÖ–Â†VÖ–Â’À ¢73 ¢7G&–ær‡77v÷&BÇÂ""¢ÒÀ ¢ò ¢æWfW"ÆÆ÷r”Ô7&VFVçF–Ç2À¢6öÖÖæG2÷"Ö–Æ&÷‚6öçFVç@¢–çFòÆ–6F–öâÆöw2à¢¢ð¢ÆövvW# ¢fÇ6RÀ ¢6öææV7F–öåF–ÖV÷WC ¢SÀ ¢w&VWF–æuF–ÖV÷WC ¢À ¢6ö6¶WEF–ÖV÷WC ¢3À ¢F—6&ÆTWFô–FÆS ¢G'VP¢Ò¢Ó°§Ð  ¦7–æ2gVæ7F–öâfW&–g”7W7FöÖW$–Ö€¢VÖ–ÂÀ¢77v÷&@¢’°¢6öç7B°¢&÷f–FW"À¢6Æ–Vç@¢ÒÐ¢7&VFT7W7FöÖW$–Ö6Æ–VçB€¢VÖ–ÂÀ¢77v÷&@¢“° ¢G'’°¢v—B6Æ–VçBæ6öææV7B‚“° ¢&WGW&â°¢6öææV7FVC¢G'VRÀ¢&÷f–FW# ¢&÷f–FW"ææÖP¢Ó° ¢Òf–æÆÇ’°¢–b†6Æ–VçBçW6&ÆR’°¢G'’°¢v—B6Æ–VçBæÆöv÷WB‚“°¢Ò6F6‚°¢6Æ–VçBæ6Æ÷6R‚“°¢Ð¢ÒVÇ6R°¢6Æ–VçBæ6Æ÷6R‚“°¢Ð¢Ð§Ð ¦7–æ2gVæ7F–öâvWE7V66W746†V6¶÷WG2‚’°¢6öç7B&V6÷&G2Ð¢v—B&VD§6öâ€¢5T44U55ô4„T4´õUE5ôd”ÄRÀ¢µÐ¢“° ¢&WGW&â'&’æ—4'&’‡&V6÷&G2¢ò&V6÷&G0¢¢µÓ°§Ð ¢òò&VBÖöæÇ’F—66÷&B6†ææVÂ–×÷'BâÖW76vRWF†÷'2&RæWfW"GF6†VBFð¢òò7W7FöÖW"66÷VçG3²F†R6†ææVÂ6öçG&–'WFW2æöç–Ö÷W26öÖ×Væ—G’F÷FÇ2à¦6öç7BF—66÷&E7V66W7566âÒ²'Vææ–æs¢fÇ6RÂ6†V6¶VDC¢çVÆÂÂFFVC¢Â6¶—VC¢ÂW'&÷#¢çVÆÂÂæWvW7DÖW76vT–C¢çVÆÂÓ°¦gVæ7F–öâF—66÷&E7V66W746öæf–r‚’°¢&WGW&â°¢Fö¶Vã¢7G&–ær‡&ö6W72æVçbäD•44õ$Eô$õEõDô´TâÇÂ""’çG&–Ò‚’À¢6†ææVÄ–C¢7G&–ær‡&ö6W72æVçbäD•44õ$Eõ5T44U55ô4„ääTÅô”BÇÂ""’çG&–Ò‚¢Ó°§Ð ¦ÆWBF—66÷&E7V66W746†ææVÄÆöö·WÒçVÆÃ°¦7–æ2gVæ7F–öâ&W6öÇfVDF—66÷&E7V66W746öæf–r‚’°¢6öç7B6öæf–rÒF—66÷&E7V66W746öæf–r‚“°¢–b‚õåÆG³rÃ#'ÒBòçFW7B†6öæf–ræ6†ææVÄ–B’’&WGW&â6öæf–s°¢ÆWBvV&†ööµW&Ã°¢G'’²vV&†ööµW&ÂÒæWrU$Â†6öæf–ræ6†ææVÄ–B“²Ò6F6‚²&WGW&â6öæf–s²Ð¢–b‡vV&†ööµW&Âç&÷Fö6öÂÓÒ&‡GG3¢"ÇÀ¢²&F—66÷&Bæ6öÒ"Â&F—66÷&Fæ6öÒ%Òæ–æ6ÇVFW2‡vV&†ööµW&Âæ†÷7FæÖR’ÇÀ¢vV&†ööµW&Âç÷'BÇÂvV&†ööµW&Âç6V&6‚ÇÂvV&†ööµW&Âæ†6‚’&WGW&â6öæf–s°¢6öç7BÖF6‚ÒvV&†ööµW&ÂçF†æÖRæÖF6‚‚õåÂö’ƒó¥Â÷eÆB²“õÂ÷vV&†öö·5Âò…ÆG³rÃ#'Ò•Âò…´Õ¦×£Ó’åòÕÒ²•ÂóòBò“°¢–b‚ÖF6‚’&WGW&â6öæf–s°¢–b‚F—66÷&E7V66W746†ææVÄÆöö·W’°¢F—66÷&E7V66W746†ææVÄÆöö·WÒ†7–æ2‚’Óâ°¢6öç7B&W7öç6RÒv—BfWF6‚†‡GG3¢òöF—66÷&Bæ6öÒö’÷c÷vV&†öö·2òG¶ÖF6…³×ÒòG¶ÖF6…³%×ÖÂ°¢6–væÃ¢&÷'E6–væÂçF–ÖV÷WBƒ¢Ò“°¢–b‚&W7öç6Ræö²’F‡&÷ræWrW'&÷"†F—66÷&BvV&†öö²Æöö·Wf–ÆVB„…EEG·&W7öç6Rç7FGW7Ò’æ“°¢6öç7BvV&†öö²Òv—B&W7öç6Ræ§6öâ‚“°¢–b‚õåÆG³rÃ#'ÒBòçFW7B…7G&–ær‡vV&†öö²æ6†ææVÅö–BÇÂ""’’’°¢F‡&÷ræWrW'&÷"‚%F†R6öæf–wW&VBF—66÷&BvV&†öö²†2æòFW‡B6†ææVÂ”Bâ"“°¢Ð¢&WGW&â7G&–ær‡vV&†öö²æ6†ææVÅö–B“°¢Ò’‚“°¢Ð¢G'’°¢&WGW&â²ââæ6öæf–rÂ6†ææVÄ–C¢v—BF—66÷&E7V66W746†ææVÄÆöö·WÂ6÷W&6S¢'vV&†öö²"Ó°¢Ò6F6‚†W'&÷"’°¢&WGW&â²ââæ6öæf–rÂÆöö·WW'&÷#¢W'&÷"æÖW76vRÓ°¢Ð§Ð ¦gVæ7F–öâF—66÷&D6†V6¶÷WDg&öÔÖW76vR†ÖW76vRÂ6†ææVÄ–B’°¢6öç7BVÖ&VBÒ†ÖW76vRæVÖ&VG2ÇÂµÒ’æf–æB†—FVÒÓâ÷7V66W77Æ6†V6¶÷WGÆ÷&FW"6öæf—&Òö’çFW7B…¶—FVÒçF—FÆRÂ—FVÒæFW67&—F–öåÒæ¦ö–â‚""’’’ÇÂçVÆÃ°¢6öç7BÖW76vUFW‡BÒ7G&–ær†ÖW76vRæ6öçFVçBÇÂ""“°¢–b‚VÖ&VBbb÷7V66W77Æ6†V6¶÷WGÆ÷&FW"6öæf—&Òö’çFW7B†ÖW76vUFW‡B’’&WGW&âçVÆÃ°¢–b‚ôäUr4„T4´õUB5T44U52ö’çFW7B†VÖ&VCòçF—FÆRÇÂ""’’&WGW&âçVÆÃ²òòÇ&VG’6fVB'’F†—26—FRw2÷vâvV&†öö²à¢6öç7B&öG’Ò¶ÖW76vUFW‡BÂVÖ&VCòæFW67&—F–öâÇÂ""Ââââ†VÖ&VCòæf–VÆG2ÇÂµÒ’æÖ†f–VÆBÓâG¶f–VÆBææÖWÓ¢G¶f–VÆBçfÇVWÖ•Òæ¦ö–â‚%Æâ"“°¢6öç7B—FV×2ÒµÓ°¢f÷"†6öç7BÆ–æRöb&öG’ç7Æ—B‚õÆâ²ò’’°¢6öç7BÖF6‚ÒÆ–æRæÖF6‚‚õåÇ2¢ƒó¥¾(
"¥ÂÕÕÇ2¢“ò‚ç³RÃ#Óò•Ç2¢ƒó¥¼9w……ÕÇ2¢…ÆB²—ÅÂ…Ç2¢…ÆB²•Ç2¥Â’•Ç2¢Bò“°¢–b‚ÖF6‚’6öçF–çVS°¢6öç7BæÖRÒV&Æ–57V66W75&öGV7DæÖR†ÖF6…³Ò“°¢–b†—5V&Æ–57V66W75&öGV7B†æÖR’bbôÅÆ"ƒó¦FG&W77ÆVÖ–ÇÇ†öæWÆ66÷VçGÇ6†—Fò•Æ"ö’çFW7B†æÖR’’°¢—FV×2çW6‚‡²æÖRÂVçF—G“¢ÖF‚æÖ–âƒ““’ÂçVÖ&W"†ÖF6…³%ÒÇÂÖF6…³5Ò’’Â–ÖvUW&Ã¢V&Æ–57V66W74–ÖvUW&Â†VÖ&VCòçF‡VÖ&æ–ÃòçW&ÂÇÂVÖ&VCòæ–ÖvSòçW&Â’Ò“°¢Ð¢Ð¢–b‚—FV×2æÆVæwF‚’&WGW&âçVÆÃ°¢6öç7B&WF–ÆW"Ò†VÖ&VCòæf–VÆG2ÇÂµÒ’æf–æB†f–VÆBÓâ÷&WF–ÆW'Ç7F÷&Rö’çFW7B†f–VÆBææÖRÇÂ""’“òçfÇVRÇÂ"#°¢6öç7BF÷FÄf–VÆBÒ†VÖ&VCòæf–VÆG2ÇÂµÒ’æf–æB†f–VÆBÓâ÷F÷FÇÇ7VçGÆÖ÷VçBö’çFW7B†f–VÆBææÖRÇÂ""’“òçfÇVRÇÀ¢&öG’æÖF6‚‚òƒó§F÷FÇÇ7VçGÆÖ÷VçB•Ç2¥³¢EÕÇ2¥ÂCò…µÆBÂåÒ²’ö’“òå³ÒÇÂ"#°¢6öç7BF÷FÄÖF6‚Ò7G&–ær‡F÷FÄf–VÆB’æÖF6‚‚õÂCò…µÆBÅÒµÂåÆG³'Ò’ò“°¢&WGW&â°¢–C¢F—66÷&C¢G¶6†ææVÄ–GÓ¢G¶ÖW76vRæ–GÖÀ¢7W7FöÖW$66÷VçD–C¢çVÆÂÀ¢&WF–ÆW#¢æ÷&ÖÆ—¦U7V66W75&WF–ÆW"‡&WF–ÆW"’À¢6†V6¶÷WDC¢ÖW76vRçF–ÖW7F×ÇÂæWrFFR‚’çFô•4õ7G&–ær‚’À¢÷&FW%F÷FÃ¢F÷FÄÖF6‚òçVÖ&W"‡F÷FÄÖF6…³Òç&WÆ6R‚òÂörÂ""’’¢À¢—FVÔ6÷VçC¢—FV×2ç&VGV6R‚‡7VÒÂ—FVÒ’Óâ7VÒ²—FVÒçVçF—G’Â’À¢—FV×2Â7FGW3¢&6öæf—&ÖVB ¢Ó°§Ð ¦7–æ2gVæ7F–öâ66äF—66÷&E7V66W746†ææVÂ‚’°¢6öç7B²Fö¶VâÂ6†ææVÄ–BÒÒv—B&W6öÇfVDF—66÷&E7V66W746öæf–r‚“°¢–b‚Fö¶VâÇÂõåÆG³rÃ#'ÒBòçFW7B†6†ææVÄ–B’ÇÂF—66÷&E7V66W7566âç'Vææ–ær’&WGW&âfÇ6S°¢F—66÷&E7V66W7566âç'Vææ–ærÒG'VS°¢F—66÷&E7V66W7566âæW'&÷"ÒçVÆÃ°¢ÆWBFFVBÒÂ6¶—VBÒÂ&Vf÷&RÒ""Â&V6†VE&–÷%66âÒfÇ6RÂæWvW7BÒF—66÷&E7V66W7566âææWvW7DÖW76vT–C°¢G'’°¢6öç7BW†—7F–ærÒv—BvWE7V66W746†V6¶÷WG2‚“°¢6öç7B6VVâÒæWr6WB†W†—7F–æræÖ†—FVÒÓâ7G&–ær†—FVÒæ–B’’“°¢f÷"†ÆWBvRÒ²vRÂ²vR²²’°¢6öç7BW&ÂÒ‡GG3¢òöF—66÷&Bæ6öÒö’÷cö6†ææVÇ2òG¶6†ææVÄ–GÒöÖW76vW3öÆ–Ö—CÓG¶&Vf÷&Ròf&Vf÷&SÒG¶&Vf÷&WÖ¢"'Ö°¢6öç7B&W7öç6RÒv—BfWF6‚‡W&ÂÂ²†VFW'3¢²WF†÷&—¦F–öã¢&÷BG·Fö¶VçÖÒÂ6–væÃ¢&÷'E6–væÂçF–ÖV÷WBƒS’Ò“°¢–b‚&W7öç6Ræö²’F‡&÷ræWrW'&÷"†F—66÷&B6†ææVÂ&VBf–ÆVB„…EEG·&W7öç6Rç7FGW7Ò’æ“°¢6öç7BÖW76vW2Òv—B&W7öç6Ræ§6öâ‚“°¢–b‚'&’æ—4'&’†ÖW76vW2’ÇÂÖW76vW2æÆVæwF‚’'&V³°¢–b‚æWvW7B’æWvW7BÒ7G&–ær†ÖW76vW5³Òæ–B“°¢f÷"†6öç7BÖW76vRöbÖW76vW2’°¢–b†F—66÷&E7V66W7566âææWvW7DÖW76vT–Bbb&–t–çB†ÖW76vRæ–B’ÃÒ&–t–çB†F—66÷&E7V66W7566âææWvW7DÖW76vT–B’’°¢&V6†VE&–÷%66âÒG'VS°¢'&V³°¢Ð¢6öç7B÷&FW"ÒF—66÷&D6†V6¶÷WDg&öÔÖW76vR†ÖW76vRÂ6†ææVÄ–B“°¢–b‚÷&FW"ÇÂ6VVâæ†2†÷&FW"æ–B’’²6¶—VB²³²6öçF–çVS²Ð¢W†—7F–ærçW6‚†÷&FW"“°¢6VVâæFB†÷&FW"æ–B“°¢FFVB²³°¢Ð¢–b‡&V6†VE&–÷%66âÇÂÖW76vW2æÆVæwF‚Â’'&V³°¢&Vf÷&RÒÖW76vW5¶ÖW76vW2æÆVæwF‚ÒÒæ–C°¢Ð¢–b†FFVB’°¢v—B6fU7V66W746†V6¶÷WG2†W†—7F–ær“°¢f÷"†6öç7BÆ—7FVæW"öbV&Æ–57V66W74Æ—7FVæW'2’Æ—7FVæW"çw&—FR‚&WfVçC¢6†V6¶÷WEÆæFF¢·ÕÆåÆâ"“°¢Ð¢F—66÷&E7V66W7566âæFFVBÒFFVC°¢F—66÷&E7V66W7566âç6¶—VBÒ6¶—VC°¢F—66÷&E7V66W7566âæ6†V6¶VDBÒæWrFFR‚’çFô•4õ7G&–ær‚“°¢F—66÷&E7V66W7566âææWvW7DÖW76vT–BÒæWvW7C°¢&WGW&âG'VS°¢Ò6F6‚†W'&÷"’°¢F—66÷&E7V66W7566âæW'&÷"ÒW'&÷"æÖW76vS°¢F—66÷&E7V66W7566âæ6†V6¶VDBÒæWrFFR‚’çFô•4õ7G&–ær‚“°¢&WGW&âfÇ6S°¢Òf–æÆÇ’°¢F—66÷&E7V66W7566âç'Vææ–ærÒfÇ6S°¢Ð§Ð ¦ævWB‚"ö’öFÖ–âöF—66÷&B×7V66W72×7FGW2"Â&WV—&TFÖ–âÂ7–æ2…÷&WÂ&W2’Óâ°¢6öç7B6öæf–rÒv—B&W6öÇfVDF—66÷&E7V66W746öæf–r‚“°¢6öç7BfÆ–D6†ææVÄ–BÒõåÆG³rÃ#'ÒBòçFW7B†6öæf–ræ6†ææVÄ–B“°¢&W2æ§6öâ‡°¢6öæf–wW&VC¢&ööÆVâ†6öæf–rçFö¶VâbbfÆ–D6†ææVÄ–B’À¢6÷W&6S¢6öæf–rç6÷W&6RÇÂçVÆÂÀ¢6öæf–wW&F–öäW'&÷#¢6öæf–ræ6†ææVÄ–BbbfÆ–D6†ææVÄ–@¢ò6öæf–ræÆöö·WW'&÷"ÇÂ$D•44õ$Eõ5T44U55ô4„ääTÅô”B×W7B&RçVÖW&–26†ææVÂ”B÷"fÆ–BF—66÷&BvV&†öö²U$Ââ ¢¢çVÆÂÀ¢6†ææVÄ–C¢fÆ–D6†ææVÄ–Bò6öæf–ræ6†ææVÄ–B¢çVÆÂÀ¢ââæF—66÷&E7V66W7566à¢Ò“°§Ò“°¦ç÷7B‚"ö’öFÖ–âöF—66÷&B×7V66W72×66â"Â&WV—&TFÖ–âÂ7–æ2…÷&WÂ&W2’Óâ°¢6öç7B²Fö¶VâÂ6†ææVÄ–BÒÒv—B&W6öÇfVDF—66÷&E7V66W746öæf–r‚“°¢–b‚Fö¶VâÇÂõåÆG³rÃ#'ÒBòçFW7B†6†ææVÄ–B’’°¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²W'&÷#¢%6WBD•44õ$Eô$õEõDô´TâæBçVÖW&–26†ææVÂ”B÷"fÆ–BF—66÷&BvV&†öö²U$Â–â&VæFW"f—'7Bâ"Ò“°¢Ð¢–b†F—66÷&E7V66W7566âç'Vææ–ær’&WGW&â&W2ç7FGW2ƒC’’æ§6öâ‡²W'&÷#¢$F—66÷&B66â—2Ç&VG’'Vææ–ærâ"Ò“°¢6öç7Bö²Òv—B66äF—66÷&E7V66W746†ææVÂ‚“°¢&W2ç7FGW2†ö²ò#¢S"’æ§6öâ‡²ö²ÂââæF—66÷&E7V66W7566âÒ“°§Ò“° ¢òòæ÷F–g’÷VâF6†&ö&G2–ÖÖVF–FVÇ’gFW"6öæf—&ÖVB6†V6¶÷WB—26fVBà¦6öç7BV&Æ–57V66W74Æ—7FVæW'2ÒæWr6WB‚“°¦6öç7B7W7FöÖW%7V66W74Æ—7FVæW'2ÒæWrÖ‚“° ¦gVæ7F–öâ÷Vå7V66W74WfVçE7G&VÒ‡&WÂ&W2ÂÆ—7FVæW'2’°¢&W2ç6WD†VFW"‚$6öçFVçBÕG—R"Â'FW‡BöWfVçB×7G&VÓ²6†'6WC×WFbÓ‚"“°¢&W2ç6WD†VFW"‚$66†RÔ6öçG&öÂ"Â&æòÖ66†RÂæò×G&ç6f÷&Ò"“°¢&W2ç6WD†VFW"‚$6öææV7F–öâ"Â&¶VWÖÆ—fR"“°¢&W2ç6WD†VFW"‚%‚Ô66VÂÔ'VffW&–ær"Â&æò"“°¢&W2æfÇW6„†VFW'2‚“°¢&W2çw&—FR‚#¢6öææV7FVEÆåÆâ"“°¢Æ—7FVæW'2æFB‡&W2“°¢6öç7B†V'F&VBÒ6WD–çFW'fÂ‚‚’Óâ&W2çw&—FR‚#¢†V'F&VEÆåÆâ"’Â#S“°¢&Wæöâ‚&6Æ÷6R"Â‚’Óâ°¢6ÆV$–çFW'fÂ††V'F&VB“°¢Æ—7FVæW'2æFVÆWFR‡&W2“°¢Ò“°§Ð ¦gVæ7F–öâææ÷Væ6U7V66W746†V6¶÷WB†66÷VçD–B’°¢f÷"†6öç7B&W2öbV&Æ–57V66W74Æ—7FVæW'2’&W2çw&—FR‚&WfVçC¢6†V6¶÷WEÆæFF¢·ÕÆåÆâ"“°¢f÷"†6öç7B&W2öb7W7FöÖW%7V66W74Æ—7FVæW'2ævWB…7G&–ær†66÷VçD–B’’ÇÂµÒ’°¢&W2çw&—FR‚&WfVçC¢6†V6¶÷WEÆæFF¢·ÕÆåÆâ"“°¢Ð§Ð ¦ævWB‚"ö’÷V&Æ–2÷7V66W72öWfVçG2"Â‡&WÂ&W2’Óâ°¢÷Vå7V66W74WfVçE7G&VÒ‡&WÂ&W2ÂV&Æ–57V66W74Æ—7FVæW'2“°§Ò“° ¦ævWB‚"ö’ö66÷VçB÷7V66W72öWfVçG2"Â&WV—&T7W7FöÖW"Â‡&WÂ&W2’Óâ°¢6öç7B66÷VçD–BÒ7G&–ær‡&Wæ7W7FöÖW$66÷VçBæ–B“°¢–b‚7W7FöÖW%7V66W74Æ—7FVæW'2æ†2†66÷VçD–B’’7W7FöÖW%7V66W74Æ—7FVæW'2ç6WB†66÷VçD–BÂæWr6WB‚’“°¢6öç7BÆ—7FVæW'2Ò7W7FöÖW%7V66W74Æ—7FVæW'2ævWB†66÷VçD–B“°¢÷Vå7V66W74WfVçE7G&VÒ‡&WÂ&W2ÂÆ—7FVæW'2“°¢&Wæöâ‚&6Æ÷6R"Â‚’Óâ°¢–b‚Æ—7FVæW'2ç6—¦R’7W7FöÖW%7V66W74Æ—7FVæW'2æFVÆWFR†66÷VçD–B“°¢Ò“°§Ò“° ¦gVæ7F–öâ—5V&Æ–57V66W75&öGV7B†æÖR’°¢&WGW&â÷öµ¶\:•ÖÖöçÆÆ÷&6æÆÖv–5Ç2¥³¥ÂÕÓõÇ2§F†UÇ2¦vF†W&–æwÅÆ&×FuÆ'ÆæVUµÇ2ÕÓöFö‡ÇG&F–æuÇ2¦6&GÅÆ'F6uÆ'Ç—UµÇ2ÕÓöv•µÇ2ÕÓöö‡ÆöæUÇ2§–V6UÇ2¢ƒó¦6&GÇF6r—ÆF–v–ÖöçÆfÆW6…Ç2¦æEÇ2¦&ÆööGÆG&vöåÇ2¦&ÆÅÇ2¢ƒó¦6&GÇF6r’ö’çFW7B†æÖR“°§Ð ¦gVæ7F–öâV&Æ–57V66W75&öGV7DæÖR‡fÇVR’°¢&WGW&â6ÆVâ‡fÇVRÂ#¢ç&WÆ6R‚òb2‡…³Ó–ÖeÒ·ÅÆB²“²öv’Â…öÖF6‚Â6öFR’Óâ°¢6öç7Bö–çBÒ6öFU³ÒçFôÆ÷vW$66R‚’ÓÓÒ'‚"ò'6T–çB†6öFRç6Æ–6Rƒ’Âb’¢çVÖ&W"†6öFR“°¢&WGW&âö–çBâ3bbö–çBÃÒƒfffbò7G&–æræg&öÔ6öFUö–çB‡ö–çB’¢"#°¢Ò¢ç&WÆ6R‚òf×²öv’Â"b"¢ç&WÆ6R‚õÇ2²örÂ""’çG&–Ò‚“°§Ð ¦6öç7BfW&–f–VEV&Æ–5&öGV7D–ÖvW2Ò°¢°¢ÖF6ƒ¢ö66VæFVB†W&öW2F–ââ¦ÖVvÖVvæ—VÒW‚ö’À¢&WF–ÆW#¢%F&vWB"À¢–ÖvUW&Ã¢&‡GG3¢ò÷F&vWBç66VæSræ6öÒö—2ö–ÖvRõF&vWBôuTU5EöCCƒ33#RÓsC†bÓCS"Ö3RÖcƒs#“63vCv2 ¢Ð¥Ó° ¦gVæ7F–öâV&Æ–57V66W75&öGV7D–ÖvR†æÖRÂ&WF–ÆW"ÂfÇVR’°¢6öç7BfW&–f–VBÒfW&–f–VEV&Æ–5&öGV7D–ÖvW2æf–æB†—FVÒÓà¢—FVÒç&WF–ÆW"çFôÆ÷vW$66R‚’ÓÓÒ7G&–ær‡&WF–ÆW"ÇÂ""’çFôÆ÷vW$66R‚’bb—FVÒæÖF6‚çFW7B†æÖR¢“°¢–b‡fW&–f–VB’&WGW&âfW&–f–VBæ–ÖvUW&Ã°¢6öç7BW&ÂÒV&Æ–57V66W74–ÖvUW&Â‡fÇVR“°¢&WGW&âW&ÂbbõÂöw&’Ö&rƒó¥³òò5×ÂB—ÅÂöæõ²ÕõÓö–ÖvRƒó¥³òò5×ÂB’ö’çFW7B‡W&Â’òW&Â¢çVÆÃ°§Ð ¦gVæ7F–öâV&Æ–57V66W74–ÖvUW&Â‡fÇVR’°¢6öç7B6fRÒ6fU7V66W74–ÖvUW&Â‡fÇVR“°¢–b‚6fR’&WGW&âçVÆÃ°¢6öç7BW&ÂÒæWrU$Â‡6fR“°¢–b‡W&ÂçW6W&æÖRÇÂW&Âç77v÷&B’&WGW&âçVÆÃ°¢W&Âç6V&6‚Ò"#°¢W&Âæ†6‚Ò"#°¢&WGW&âW&ÂçFõ7G&–ær‚“°§Ð ¢ò¢V&Æ–2F÷FÇ26öçF–âöæÇ’vw&VvFRfÇVW2æB&öGV7B6÷VçG2â¢ð¦ævWB€¢"ö’÷V&Æ–2÷7V66W72"À¢7–æ2…÷&WÂ&W2’Óâ°¢&W2ç6WD†VFW"‚$66†RÔ6öçG&öÂ"Â&æò×7F÷&R"“° ¢G'’°¢6öç7B&V6÷&G2Òv—BvWE7V66W746†V6¶÷WG2‚“°¢6öç7B&öGV7G2ÒæWrÖ‚“°¢ÆWBF÷FÅ7VçBÒ°¢ÆWBF÷FÄ6†V6¶÷WG2Ò° ¢f÷"†6öç7B&V6÷&Böb&V6÷&G2’°¢–b‚õâ†6öæf—&ÖVGÇ7V66W77Æ6ö×ÆWFVB’Bö’çFW7B…7G&–ær‡&V6÷&Bç7FGW2ÇÂ&6öæf—&ÖVB"’’’6öçF–çVS°¢6öç7BVÆ–v–&ÆT—FV×2Ò„'&’æ—4'&’‡&V6÷&Bæ—FV×2’ò&V6÷&Bæ—FV×2¢µÒ’æf–ÇFW"†—FVÒÓâ°¢6öç7BæÖRÒV&Æ–57V66W75&öGV7DæÖR†—FVÓòææÖR“°¢&WGW&âæÖRbb—5V&Æ–57V66W75&öGV7B†æÖR’bbôÅÆ"ƒó¦÷&FW'ÆFG&W77Ç†öæWÆVÖ–ÇÆ66÷VçGÇ6†—ƒó§–ær“òFò•Æ'ÅÆ%ÆG³7Õ²ÒâÕÆG³7Õ²ÒâÕÆG³GÕÆ"ö’çFW7B†æÖR’bbçVÖ&W"†—FVÓòçVçF—G’’â°¢Ò“°¢F÷FÄ6†V6¶÷WG2³Ò°¢6öç7BF÷FÂÒçVÖ&W"‡&V6÷&Bæ÷&FW%F÷FÂ“°¢–b„çVÖ&W"æ—4f–æ—FR‡F÷FÂ’bbF÷FÂâ’F÷FÅ7VçB³ÒF÷FÃ° ¢f÷"†6öç7B—FVÒöbVÆ–v–&ÆT—FV×2’°¢6öç7BæÖRÒV&Æ–57V66W75&öGV7DæÖR†—FVÓòææÖR“°¢6öç7BVçF—G’ÒÖF‚æÖ‚ƒÂÖF‚æfÆö÷"„çVÖ&W"†—FVÓòçVçF—G’’ÇÂ’“°¢–b‚VçF—G’’6öçF–çVS°¢6öç7B¶W’ÒæÖRçFôÆ÷vW$66R‚“°¢6öç7B&–÷"Ò&öGV7G2ævWB†¶W’“°¢&öGV7G2ç6WB†¶W’Â°¢æÖS¢&–÷#òææÖRÇÂæÖRÀ¢VçF—G“¢‡&–÷#òçVçF—G’ÇÂ’²VçF—G’À¢–ÖvUW&Ã¢&–÷#òæ–ÖvUW&ÂÇÂV&Æ–57V66W75&öGV7D–ÖvR†æÖRÂ&V6÷&Bç&WF–ÆW"Â—FVÓòæ–ÖvUW&Â¢Ò“°¢Ð¢Ð ¢&W2æ§6öâ‡°¢F÷FÄ6†V6¶÷WG2À¢F÷FÅ7VçC¢ÖF‚ç&÷VæB‡F÷FÅ7VçB¢’òÀ¢&öGV7G3¢²ââç&öGV7G2çfÇVW2‚•Òç6÷'B‚†Â"’Óâ"çVçF—G’ÒçVçF—G’ÇÂææÖRæÆö6ÆT6ö×&R†"ææÖR’¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚%V&Æ–27V66W72F÷FÇ2f–ÆVC¢"ÂW'&÷#òæ6öFRÇÂW'&÷#òææÖRÇÂ'7V66W75÷F÷FÇ5öW'&÷""“°¢&W2ç7FGW2ƒS2’æ§6öâ‡²W'&÷#¢$6†V6¶÷WBF÷FÇ2&RFV×÷&&–Ç’Væf–Æ&ÆRâ"Ò“°¢Ð¢Ð¢“° ¦7–æ2gVæ7F–öâ6fU7V66W746†V6¶÷WG2€¢&V6÷&G0¢’°¢v—Bw&—FT§6öâ€¢5T44U55ô4„T4´õUE5ôd”ÄRÀ¢&V6÷&G0¢“°§Ð  ¦7–æ2gVæ7F–öâ&V6÷&E7V66W746†V6¶÷WB€¢&V6÷&BÀ¢²æ÷F–g”F—66÷&BÒG'VRÒÒ·Ð¢’°¢6öç7B6fU&V6÷&BÐ¢6fU7V66W746†V6¶÷WB€¢&V6÷&@¢“° ¢–b€¢6fU&V6÷&Bæ–BÇÀ¢&V6÷&Còæ7W7FöÖW$66÷VçD–@¢’°¢F‡&÷ræWrW'&÷"€¢%7V66W726†V6¶÷WB&V6÷&B—2Ö—76–ær—G2”B÷"7W7FöÖW"66÷VçBâ ¢“°¢Ð ¢6öç7B&V6÷&G2Ð¢v—BvWE7V66W746†V6¶÷WG2‚“° ¢6öç7BGWÆ–6FRÐ¢&V6÷&G2ç6öÖR€¢—FVÒÓà¢7G&–ær†—FVÒæ–B’ÓÓÐ¢7G&–ær‡6fU&V6÷&Bæ–B¢“° ¢–b†GWÆ–6FR’°¢&WGW&âfÇ6S°¢Ð ¢6öç7B7F÷&VE&V6÷&BÒ°¢ââç6fU&V6÷&BÀ ¢7W7FöÖW$66÷VçD–C ¢7G&–ær€¢&V6÷&Bæ7W7FöÖW$66÷VçD–@¢’À ¢ò ¢–Ö×WF&ÆRGG&–'WF–öâ6æ6†÷Bà¢öæ6Râ÷&FW"—2w&—GFVâFò7V66W72Â&V76–væ–ærF†P¢ÖævVB&öf–ÆRÆFW"æWfW"Ö÷fW2F†—2öÆB6†V6¶÷WBà¢¢ð¢ÖævVD66÷VçD–C ¢&V6÷&BæÖævVD66÷VçD–@¢ò7G&–ær€¢&V6÷&BæÖævVDjÇºãcountId
   Â¸­yêë¢°k¢G§¦*^       )
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
  if (records.some(record => record.id === id || (
    order.orderNumber && record.orderNumber === order.orderNumber &&
    record.retailer === normalizeSuccessRetailer(order.retailer)
  ))) return false;

  records.push({
    id,
    customerAccountId: null,
    retailer: normalizeSuccessRetailer(order.retailer),
    checkoutAt: order.checkoutAt || order.date || null,
    orderTotal: Math.max(0, Number(order.orderTotal) || 0),
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    items,
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
              `â€¢ ${item.name} Ã—${item.quantity}`
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
        "SLABS N GRABS ACO â€¢ Personal customer information hidden"
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
          "Pro Membership â€” 5 profile(s) / month",

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

      if (m«ëŒ+Š×ž®º+º$zzb¥à¢FW7DVÖ–ÂÇÀ¢FW7E77v÷&@¢’°¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢ö³¢fÇ6RÀ ¢W'&÷# ¢%FW7BÖ–Æ&÷‚Vçf—&öæÖVçBf&–&ÆW2&Ræ÷B6öæf–wW&VBâ ¢Ò“°¢Ð ¢6öç7B&W7VÇBÐ¢v—B&VE&V6VçEFW7DÖ–Æ&÷„ÖW76vW2€¢FW7DVÖ–ÂÀ¢FW7E77v÷&BÀ¢# ¢“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ ¢&÷f–FW# ¢&W7VÇBç&÷f–FW"À ¢F÷FÄÖW76vW3 ¢&W7VÇBçF÷FÄÖW76vW2À ¢&WGW&æVC ¢&W7VÇBæÖW76vW2æÆVæwF‚À ¢ÖW76vW3 ¢&W7VÇBæÖW76vW0¢Ò“° ¢Ò6F6‚†W'&÷"’°¢ò ¢æWfW"&WGW&â&r&÷f–FW"W'&÷'2à¢&÷f–FW"&W7öç6W26â6öçF–à¢Ö–Æ&÷‚–æf÷&ÖF–öâà¢¢ð ¢–b€¢W'&÷#òæ6öFRÓÓÐ¢%Tå5Uõ%DTEõ$õd”DU" ¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢ö³¢fÇ6RÀ ¢W'&÷# ¢%F†—2FW7BÖ–Æ&÷‚&÷f–FW"—2æ÷B7W÷'FVBâ ¢Ò“°¢Ð ¢–b€¢W'&÷"–ç7Fæ6Vö`¢WF†VçF–6F–öäf–ÇW&RÇÀ¢W'&÷#òæWF†VçF–6F–öäf–ÆVBÓÓÐ¢G'VRÇÀ¢W'&÷#òæ6öFRÓÓÐ¢$UD„TåD”4D”ôäd”ÄTB ¢’°¢&WGW&â&W0¢ç7FGW2ƒC¢æ§6öâ‡°¢ö³¢fÇ6RÀ ¢W'&÷# ¢%FW7BÖ–Æ&÷‚WF†VçF–6F–öâf–ÆVBâ ¢Ò“°¢Ð ¢6öç6öÆRæW'&÷"€¢$FÖ–âÖ–Æ&÷‚&VFW"f–ÆVC¢"À¢W'&÷#òæ6öFRÇÀ¢W'&÷#òææÖRÇÀ¢&Ö–Æ&÷…÷&VFW%öW'&÷" ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS"¢æ§6öâ‡°¢ö³¢fÇ6RÀ ¢W'&÷# ¢%F†RFW7BÖ–Æ&÷‚6÷VÆBæ÷B&R&VB&–v‡Bæ÷râ ¢Ò“°¢Ð¢Ð¢“° ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢DTÕõ$%’$TÂD$tUBTÔ”ÂD”täõ5D”0¢&VG2ôäÅ’T”B#Bg&öÒF†RFW7BÖ–Æ&÷‚à¢FöW2äõB6fRç—F†–ærà¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦ævWB€¢"ö’öFÖ–â÷FW7B×F&vWB×&VÂÖVÖ–Â"À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢&W2ç6WD†VFW"€¢$66†RÔ6öçG&öÂ"À¢&æò×7F÷&R ¢“° ¢6öç7BFW7DVÖ–ÂÐ¢æ÷&ÖÆ—¦TVÖ–Â€¢&ö6W72æVçbä”ÔõDU5EôTÔ”À¢“° ¢6öç7BFW7E77v÷&BÐ¢7G&–ær€¢&ö6W72æVçbä”ÔõDU5Eõ55tõ$BÇÀ¢" ¢“° ¢–b€¢FW7DVÖ–ÂÇÀ¢FW7E77v÷&@¢’°¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢ö³¢fÇ6RÀ¢W'&÷# ¢%FW7BÖ–Æ&÷‚Vçf—&öæÖVçBf&–&ÆW2&Ræ÷B6öæf–wW&VBâ ¢Ò“°¢Ð ¢6öç7B°¢&÷f–FW"À¢6Æ–Vç@¢ÒÐ¢7&VFT7W7FöÖW$–Ö6Æ–VçB€¢FW7DVÖ–ÂÀ¢FW7E77v÷&@¢“° ¢G'’°¢v—B6Æ–VçBæ6öææV7B‚“° ¢6öç7BÆö6²Ð¢v—B6Æ–VçBævWDÖ–Æ&÷„Æö6²€¢$”ä$õ‚"À¢°¢&VDöæÇ“¢G'VP¢Ð¢“° ¢G'’°¢ò ¢T”B#B—2F†R&VÂF&vWB÷&FW ¢f÷'v&FVB–çFòF†RFW7BÖ–Æ&÷‚à¢¢ð ¢6öç7BÖW76vRÐ¢v—B6Æ–VçBæfWF6„öæR€¢#BÀ¢°¢V–C¢G'VRÀ¢VçfVÆ÷S¢G'VRÀ¢–çFW&æÄFFS¢G'VRÀ¢6÷W&6S¢G'VP¢ÒÀ¢°¢V–C¢G'VP¢Ð¢“° ¢–b€¢ÖW76vRÇÀ¢ÖW76vRç6÷W&6P¢’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢ö³¢fÇ6RÀ¢W'&÷# ¢%T”B#B6÷VÆBæ÷B&R&VBâ ¢Ò“°¢Ð ¢ò ¢FV6öFRF†R&VÂf÷'v&FVBÔ”ÔRVÖ–Âà¢¢ð ¢6öç7B'6VBÐ¢v—B6–×ÆU'6W"€¢ÖW76vRç6÷W&6RÀ¢°¢6¶—‡FÖÅFõFW‡C¢G'VRÀ¢6¶—FW‡EFô‡FÖÃ¢G'VP¢Ð¢“° ¢6öç7BFW‡BÐ¢7G&–ær€¢'6VCòçFW‡BÇÂ" ¢“° ¢6öç7B‡FÖÂÐ¢G—Vöb'6VCòæ‡FÖÂÓÓÐ¢'7G&–ær ¢ò'6VBæ‡FÖÀ¢¢"#° ¢ò ¢W6R÷W"W†—7F–ær–ÖvRW‡G&7F÷"v–ç7@¢F†RFV6öFVB…DÔÂà¢¢ð ¢6öç7B–ÖvW2Ð¢W‡G&7DVÖ–Ä–ÖvUW&Ç2€¢‡FÖÀ¢“° ¢ò ¢F–væ÷7F–2öæÇ’à ¢vRFVÆ–&W&FVÇ’&WGW&â6†÷'B&Wf–Ww2À¢æ÷BF†RVçF—&R&VÂVÖ–Âà¢¢ð ¢6öç7B÷&FW$çVÖ&W$ÖF6†W2Ð¢°¢âââ€¢G¶ÖW76vRæVçfVÆ÷Sòç7V&¦V7BÇÂ"'ÕÆâG·FW‡GÖ ¢’æÖF6„ÆÂ€¢òƒó¦÷&FW'Æ÷&FW%Ç2¢7Æ÷&FW%Ç2¦çVÖ&W"•µäÕ£Ó•×³Ã#Ò…´Õ£Ó’Õ×³bÃCÒ’öv¢¢Ð¢æÖ€¢ÖF6‚Óà¢6ÆVâ€¢ÖF6ƒòå³ÒÀ¢ ¢¢¢æf–ÇFW"„&ööÆVâ¢ç6Æ–6RƒÂ“° ¢6öç7BVæ—VT÷&FW$çVÖ&W'2Ð¢°¢ââææWr6WB€¢÷&FW$çVÖ&W$ÖF6†W0¢¢Ó° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ ¢&÷f–FW# ¢&÷f–FW"ææÖRÀ ¢V–C ¢ÖW76vRçV–BÀ ¢7V&¦V7C ¢ÖW76vRæVçfVÆ÷P¢òç7V&¦V7BÇÀ¢""À ¢FFS ¢€¢ÖW76vRæVçfVÆ÷SòæFFRÇÀ¢ÖW76vRæ–çFW&æÄFFP¢¢òæWrFFR€¢ÖW76vRæVçfVÆ÷SòæFFRÇÀ¢ÖW76vRæ–çFW&æÄFFP¢’çFô•4õ7G&–ær‚¢¢çVÆÂÀ ¢'6VE7V&¦V7C ¢'6VCòç7V&¦V7BÇÀ¢çVÆÂÀ ¢FW‡DÆVæwFƒ ¢FW‡BæÆVæwF‚À ¢‡FÖÄÆVæwFƒ ¢‡FÖÂæÆVæwF‚À ¢†5FW‡C ¢FW‡BæÆVæwF‚âÀ ¢†4‡FÖÃ ¢‡FÖÂæÆVæwF‚âÀ ¢FWFV7FVD÷&FW$çVÖ&W'3 ¢Væ—VT÷&FW$çVÖ&W'2À ¢W‡V7FVD÷&FW$FWFV7FVC ¢Væ—VT÷&FW$çVÖ&W'2æ–æ6ÇVFW2€¢#“#3c“C#3#2 ¢’À ¢–ÖvT6÷VçC ¢–ÖvW2æÆVæwF‚À ¢–ÖvW3 ¢–ÖvW0¢ç6Æ–6RƒÂ3¢æÖ€¢–ÖvRÓâ‡°¢–ÖvUW&Ã ¢–ÖvRæ–ÖvUW&ÂÀ ¢ÇC ¢–ÖvRæÇBÀ ¢F—FÆS ¢–ÖvRçF—FÆRÀ ¢v–GFƒ ¢–ÖvRçv–GF‚À ¢†V–v‡C ¢–ÖvRæ†V–v‡@¢Ò¢’À ¢FW‡E&Wf–Ws ¢FW‡@¢ç6Æ–6R€¢À¢S ¢’À ¢‡FÖÅ&Wf–Ws ¢‡FÖÀ¢ç6Æ–6R€¢À¢3 ¢¢Ò“° ¢Òf–æÆÇ’°¢Æö6²ç&VÆV6R‚“°¢Ð ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢%&VÂF&vWBF–væ÷7F–2f–ÆVC¢"À¢W'&÷#òæ6öFRÇÀ¢W'&÷#òææÖRÇÀ¢'F&vWE÷&VÅöVÖ–ÅöW'&÷" ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS"¢æ§6öâ‡°¢ö³¢fÇ6RÀ¢W'&÷# ¢%F†R&VÂF&vWBFW7BVÖ–Â6÷VÆBæ÷B&R–ç7V7FVBâ ¢Ò“° ¢Òf–æÆÇ’°¢–b†6Æ–VçBçW6&ÆR’°¢G'’°¢v—B6Æ–VçBæÆöv÷WB‚“°¢Ò6F6‚°¢6Æ–VçBæ6Æ÷6R‚“°¢Ð¢ÒVÇ6R°¢6Æ–VçBæ6Æ÷6R‚“°¢Ð¢Ð¢Ð¢“° ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢DTÕõ$%’D$tUBõ$DU"%4U"DU5@¢&VG2öæÇ’Æ–¶VÇ’F&vWB÷&FW"ÖW76vW2à¢FöW2äõB6fRç—F†–ærFò7V66W72–WBà¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦gVæ7F–öâ‡FÖÅFõÆ–åFW‡B‡fÇVR’°¢&WGW&â7G&–ær‡fÇVRÇÂ""¢ç&WÆ6R‚óÇ7G–ÆUµÇ5Å5Ò£óÅÂ÷7G–ÆSâöv’Â""¢ç&WÆ6R‚óÇ67&—EµÇ5Å5Ò£óÅÂ÷67&—Câöv’Â""¢ç&WÆ6R‚óÆ'%Ç2¥Âóóâöv’Â%Æâ"¢ç&WÆ6R‚óÅÂ÷âöv’Â%Æâ"¢ç&WÆ6R‚óÅÂöF—câöv’Â%Æâ"¢ç&WÆ6R‚óÅÂöÆ“âöv’Â%Æâ"¢ç&WÆ6R‚óÅµãåÒ³âörÂ""¢ç&WÆ6R‚òfæ'7²öv’Â""¢ç&WÆ6R‚òf×²öv’Â"b"¢ç&WÆ6R‚ògV÷C²öv’Â%Â""¢ç&WÆ6R‚òb33“²öv’Â"r"¢ç&WÆ6R‚òfÇC²öv’Â#Â"¢ç&WÆ6R‚òfwC²öv’Â#â"¢ç&WÆ6R‚õÇ"örÂ""¢ç&WÆ6R‚õ²ÇEÒ²örÂ""¢ç&WÆ6R‚õÆå²ÇEÒ²örÂ%Æâ"¢ç&WÆ6R‚õÆç³2ÇÒörÂ%ÆåÆâ"¢çG&–Ò‚“°§Ð  ¦gVæ7F–öâW‡G&7DVÖ–ÅFW‡B‡6÷W&6R’°¢6öç7B&rÐ¢'VffW"æ—4'VffW"‡6÷W&6R¢ò6÷W&6RçFõ7G&–ær‚'WFc‚"¢¢7G&–ær‡6÷W&6RÇÂ""“° ¢ò ¢f÷"F†—26öçG&öÆÆVB'6W"FW7BvRöæÇ’æVV@¢&VF&ÆRFW‡Bg&öÒF†RÖW76vR6÷W&6Rà ¢vR&VÖ÷fR6öÖÖöâÔ”ÔRô…DÔÂæö—6R'WBFòæ÷@¢W&ÖæVçFÇ’7F÷&RF†R&rÖW76vRà¢¢ð ¢&WGW&â‡FÖÅFõÆ–åFW‡B€¢&p¢ç&WÆ6R€¢õä6öçFVçBÕµåÆåÒ¢Böv–ÒÀ¢" ¢¢ç&WÆ6R€¢õäÔ”ÔRÕfW'6–öã¥µåÆåÒ¢Böv–ÒÀ¢" ¢¢“°§Ð ¦gVæ7F–öâFV6öFTVÖ–Ä‡FÖÅfÇVR€¢fÇVP¢’°¢&WGW&â7G&–ær‡fÇVRÇÂ""¢ç&WÆ6R‚òf×²öv’Â"b"¢ç&WÆ6R‚ògV÷C²öv’Â%Â""¢ç&WÆ6R‚òb33“²öv’Â"r"¢ç&WÆ6R‚òfÇC²öv’Â#Â"¢ç&WÆ6R‚òfwC²öv’Â#â"¢ç&WÆ6R‚òfæ'7²öv’Â""¢çG&–Ò‚“°§Ð  ¦gVæ7F–öâW‡G&7DVÖ–Ä–ÖvUW&Ç2€¢6÷W&6P¢’°¢6öç7B&rÐ¢'VffW"æ—4'VffW"‡6÷W&6R¢ò6÷W&6RçFõ7G&–ær‚'WFc‚"¢¢7G&–ær‡6÷W&6RÇÂ""“° ¢6öç7B–ÖvW2ÒµÓ° ¢6öç7B–ÖvUGFW&âÐ¢óÆ–ÖuÆ"…µãåÒ¢“âöv“° ¢ÆWBÖF6ƒ° ¢v†–ÆR€¢€¢ÖF6‚Ð¢–ÖvUGFW&âæW†V2‡&r¢’ÓÒçVÆÀ¢’°¢6öç7BGG&–'WFW2Ð¢ÖF6…³ÒÇÂ"#° ¢6öç7B7&4ÖF6‚Ð¢GG&–'WFW2æÖF6‚€¢õÆ'7&5Ç2£ÕÇ2¥²"uÒ…µâ"uÒ²•²"uÒö¢“° ¢–b‚7&4ÖF6ƒòå³Ò’°¢6öçF–çVS°¢Ð ¢6öç7B&uW&ÂÐ¢FV6öFTVÖ–Ä‡FÖÅfÇVR€¢7&4ÖF6…³Ð¢“° ¢–b€¢&uW&ÂÇÀ¢õæ6–C¢ö’çFW7B‡&uW&Â’ÇÀ¢õæFF¢ö’çFW7B‡&uW&Â¢’°¢6öçF–çVS°¢Ð ¢6öç7B–ÖvUW&ÂÐ¢6fU7V66W74–ÖvUW&Â€¢&uW&À¢“° ¢–b‚–ÖvUW&Â’°¢6öçF–çVS°¢Ð  ¢6öç7BÇDÖF6‚Ð¢GG&–'WFW2æÖF6‚€¢õÆ&ÇEÇ2£ÕÇ2¥²"uÒ…µâ"uÒ¢•²"uÒö¢“°  ¢6öç7BF—FÆTÖF6‚Ð¢GG&–'WFW2æÖF6‚€¢õÆ'F—FÆUÇ2£ÕÇ2¥²"uÒ…µâ"uÒ¢•²"uÒö¢“°  ¢6öç7Bv–GF„ÖF6‚Ð¢GG&–'WFW2æÖF6‚€¢õÆ'v–GF…Ç2£ÕÇ2¥²"uÓò…ÆG³ÃWÒ’ö¢“°  ¢6öç7B†V–v‡DÖF6‚Ð¢GG&–'WFW2æÖF6‚€¢õÆ&†V–v‡EÇ2£ÕÇ2¥²"uÓò…ÆG³ÃWÒ’ö¢“°  ¢6öç7BÇBÐ¢FV6öFTVÖ–Ä‡FÖÅfÇVR€¢ÇDÖF6ƒòå³Ð¢“°  ¢6öç7BF—FÆRÐ¢FV6öFTVÖ–Ä‡FÖÅfÇVR€¢F—FÆTÖF6ƒòå³Ð¢“°  ¢6öç7Bv–GF‚Ð¢çVÖ&W"€¢v–GF„ÖF6ƒòå³ÒÇÂ ¢“°  ¢6öç7B†V–v‡BÐ¢çVÖ&W"€¢†V–v‡DÖF6ƒòå³ÒÇÂ ¢“°  ¢ò ¢–væ÷&Rö'f–÷W2G&6¶–ær—†VÇ2à ¢vR–çFVçF–öæÆÇ’FòäõB&WV—&RF–ÖVç6–öç0¢&V6W6RÖç’&WF–ÆW"VÖ–Ç2öÖ—Bv–GF‚ö†V–v‡@¢GG&–'WFW2VçF—&VÇ’à¢¢ð ¢–b€¢€¢v–GF‚âb`¢v–GF‚ÃÒP¢’ÇÀ¢€¢†V–v‡Bâb`¢†V–v‡BÃÒP¢¢’°¢6öçF–çVS°¢Ð  ¢–b€¢–ÖvW2ç6öÖR€¢–ÖvRÓà¢–ÖvRæ–ÖvUW&ÂÓÓÐ¢–ÖvUW&À¢¢’°¢6öçF–çVS°¢Ð  ¢–ÖvW2çW6‚‡°¢–ÖvUW&ÂÀ ¢ÇC ¢6ÆVâ€¢ÇBÀ¢S ¢’À ¢F—FÆS ¢6ÆVâ€¢F—FÆRÀ¢S ¢’À ¢v–GFƒ ¢v–GF‚ÇÂçVÆÂÀ ¢†V–v‡C ¢†V–v‡BÇÂçVÆÀ¢Ò“°¢Ð ¢&WGW&â–ÖvW3°§Ð ¦gVæ7F–öâæ÷&ÖÆ—¦UF&vWE&öGV7EFW‡B€¢fÇVP¢’°¢&WGW&â7G&–ær‡fÇVRÇÂ""¢çFôÆ÷vW$66R‚¢ç&WÆ6R€¢õµæ×£Ó•Ò²örÀ¢" ¢¢ç&WÆ6R€¢õÇ2²örÀ¢" ¢¢çG&–Ò‚“°§Ð  ¦gVæ7F–öâf–æEF&vWE&öGV7D–ÖvR€¢&öGV7DæÖRÀ¢–ÖvW0¢’°¢6öç7Bæ÷&ÖÆ—¦VDæÖRÐ¢æ÷&ÖÆ—¦UF&vWE&öGV7EFW‡B€¢&öGV7DæÖP¢“° ¢–b‚æ÷&ÖÆ—¦VDæÖR’°¢&WGW&âçVÆÃ°¢Ð ¢6öç7B6æF–FFW2Ð¢'&’æ—4'&’†–ÖvW2¢ò–ÖvW0¢¢µÓ°  ¢ò ¢f—'7B6†ö–6S ¢W†7BÅB÷"D•DÄRÖF6‚à¢¢ð ¢f÷"€¢6öç7B–ÖvRöb6æF–FFW0¢’°¢6öç7BÇBÐ¢æ÷&ÖÆ—¦UF&vWE&öGV7EFW‡B€¢–ÖvSòæÇ@¢“° ¢6öç7BF—FÆRÐ¢æ÷&ÖÆ—¦UF&vWE&öGV7EFW‡B€¢–ÖvSòçF—FÆP¢“° ¢–b€¢ÇBÓÓÒæ÷&ÖÆ—¦VDæÖRÇÀ¢F—FÆRÓÓÒæ÷&ÖÆ—¦VDæÖP¢’°¢&WGW&â€¢6fU7V66W74–ÖvUW&Â€¢–ÖvSòæ–ÖvUW&À¢’ÇÂçVÆÀ¢“°¢Ð¢Ð  ¢ò ¢6V6öæB6†ö–6S ¢öæRæ÷&ÖÆ—¦VBæÖR6öçF–ç0¢F†R÷F†W"à ¢&WV—&RÖVæ–ævgVÂÖ÷VçBö`¢FW‡B6ò6†÷'B&WF–ÆW"Æ&VÇ27V6€¢2%F&vWB"6ææ÷BÖF6‚&öGV7Bà¢¢ð ¢f÷"€¢6öç7B–ÖvRöb6æF–FFW0¢’°¢6öç7BÆ&VÇ2Ò°¢æ÷&ÖÆ—¦UF&vWE&öGV7EFW‡B€¢–ÖvSòæÇ@¢’À ¢æ÷&ÖÆ—¦UF&vWE&öGV7EFW‡B€¢–ÖvSòçF—FÆP¢¢Òæf–ÇFW"€¢Æ&VÂÓà¢Æ&VÂæÆVæwF‚ãÒ ¢“°  ¢6öç7BÖF6†VBÐ¢Æ&VÇ2ç6öÖR€¢Æ&VÂÓà¢Æ&VÂæ–æ6ÇVFW2€¢æ÷&ÖÆ—¦VDæÖP¢’ÇÀ¢æ÷&ÖÆ—¦VDæÖRæ–æ6ÇVFW2€¢Æ&VÀ¢¢“°  ¢–b†ÖF6†VB’°¢&WGW&â€¢6fU7V66W74–ÖvUW&Â€¢–ÖvSòæ–ÖvUW&À¢’ÇÂçVÆÀ¢“°¢Ð¢Ð  ¢&WGW&âçVÆÃ°§Ð ¦6öç7BF&vWE&öGV7D–ÖvTÆöö·W66†RÒæWrÖ‚“°¦7–æ2gVæ7F–öâF&vWE&öGV7D–ÖvTg&öÔVÖ–ÄÆ–æ·2‡&öGV7DæÖRÂ‡FÖÂ’°¢6öç7B–G2Ò²ââå7G&–ær†‡FÖÂÇÂ""’æÖF6„ÆÂ‚÷F&vWEÂæ6öÕÂ÷Âõµâ"sÃåÇ5Ò£õÂôÒ…ÆG³rÃ'Ò’öv’•Ð¢æÖ†ÖF6‚ÓâÖF6…³Ò“°¢6öç7BVæ—VT–G2Ò²ââææWr6WB†–G2•Òç6Æ–6RƒÂR“°¢–b‚Væ—VT–G2æÆVæwF‚’&WGW&âçVÆÃ°¢6öç7BvçFVBÒæ÷&ÖÆ—¦UF&vWE&öGV7EFW‡B‡V&Æ–57V66W75&öGV7DæÖR‡&öGV7DæÖR’“°¢f÷"†6öç7B–BöbVæ—VT–G2’°¢–b‚F&vWE&öGV7D–ÖvTÆöö·W66†Ræ†2†–B’’°¢F&vWE&öGV7D–ÖvTÆöö·W66†Rç6WB†–BÂ†7–æ2‚’Óâ°¢G'’°¢6öç7B&W7öç6RÒv—BfWF6‚†‡GG3¢ò÷wwrçF&vWBæ6öÒ÷òÒôÒG¶–GÖÂ°¢6–væÃ¢&÷'E6–væÂçF–ÖV÷WBƒS’À¢†VFW'3¢²%W6W"ÔvVçB#¢$Ö÷¦–ÆÆóRã†6ö×F–&ÆS²4Ä%4äu$%44òóã’"Ð¢Ò“°¢–b‚&W7öç6Ræö²’&WGW&âçVÆÃ°¢6öç7BvRÒ†v—B&W7öç6RçFW‡B‚’’ç6Æ–6RƒÂC“°¢6öç7BÖWF6öçFVçBÒ¶W’Óâ°¢6öç7BFrÒvRæÖF6‚†æWr&VtW‡†ÆÖWFÅÆ%µãåÒ§&÷W'G“Õ²"uÒG¶¶W—Õ²"uÕµãåÒ£æÂ&’"’“òå³ÒÇÂ"#°¢&WGW&âFræÖF6‚‚ö6öçFVçCÕ²"uÒ…µâ"uÒ²’ö’“òå³ÒÇÂ"#°¢Ó°¢6öç7BF—FÆRÒÖWF6öçFVçB‚&ös§F—FÆR"“°¢6öç7B–ÖvRÒÖWF6öçFVçB‚&ös¦–ÖvR"“°¢&WGW&â²F—FÆS¢V&Æ–57V66W75&öGV7DæÖR‡F—FÆR’Â–ÖvUW&Ã¢6fU7V66W74–ÖvUW&Â†–ÖvR’Ó°¢Ò6F6‚²&WGW&âçVÆÃ²Ð¢Ò’‚’“°¢Ð¢6öç7Bf÷VæBÒv—BF&vWE&öGV7D–ÖvTÆöö·W66†RævWB†–B“°¢6öç7BF—FÆRÒæ÷&ÖÆ—¦UF&vWE&öGV7EFW‡B†f÷VæCòçF—FÆR“°¢–b‡F—FÆRbbvçFVBbb‡F—FÆRæ–æ6ÇVFW2‡vçFVB’ÇÂvçFVBæ–æ6ÇVFW2‡F—FÆR’’b`¢f÷VæCòæ–ÖvUW&ÂbbõÂöw&’Ö&rƒó¥³òò5×ÂB’ö’çFW7B†f÷VæBæ–ÖvUW&Â’’°¢&WGW&âf÷VæBæ–ÖvUW&Ã°¢Ð¢Ð¢&WGW&âçVÆÃ°§Ð ¦gVæ7F–öâ'6TÖöæW’‡fÇVR’°¢6öç7BÖ÷VçBÐ¢çVÖ&W"€¢7G&–ær‡fÇVRÇÂ""¢ç&WÆ6R‚õ²BÅÇ5ÒörÂ""¢“° ¢&WGW&âçVÖ&W"æ—4f–æ—FR†Ö÷VçB¢òÖF‚ç&÷VæB†Ö÷VçB¢’ò ¢¢çVÆÃ°§Ð ¦7–æ2gVæ7F–öâFV6öFT–ÖÖW76vR€¢6÷W&6P¢’°¢6öç7B'6VBÐ¢v—B6–×ÆU'6W"€¢6÷W&6RÀ¢°¢6¶—‡FÖÅFõFW‡C¢G'VRÀ¢6¶—FW‡EFô‡FÖÃ¢G'VP¢Ð¢“° ¢6öç7BFW‡BÐ¢7G&–ær€¢'6VCòçFW‡BÇÂ" ¢“° ¢6öç7B‡FÖÂÐ¢G—Vöb'6VCòæ‡FÖÂÓÓÒ'7G&–ær ¢ò'6VBæ‡FÖÀ¢¢"#° ¢&WGW&â°¢FW‡BÀ¢‡FÖÀ¢Ó°§Ð ¦7–æ2gVæ7F–öâ'6UF&vWEFW7D÷&FW"‡°¢7V&¦V7BÀ¢6÷W&6RÀ¢V–BÀ¢ÖW76vT–BÀ¢FFP§Ò’°¢6öç7BFV6öFVBÐ¢v—BFV6öFT–ÖÖW76vR€¢6÷W&6P¢“° ¢6öç7BFW‡BÐ¢FV6öFVBçFW‡BÇÀ¢W‡G&7DVÖ–ÅFW‡B€¢6÷W&6P¢“° ¢6öç7BVÖ–Ä–ÖvW2Ð¢W‡G&7DVÖ–Ä–ÖvUW&Ç2€¢FV6öFVBæ‡FÖÀ¢“° ¢6öç7B6öÖ&–æVBÐ¢G·7V&¦V7BÇÂ"'ÕÆâG·FW‡GÖ° ¢ò ¢66WB&÷Fƒ ¢ÒF—&V7BF&vWBVÖ–Ç0¢Òf÷'v&FVBF&vWBVÖ–Ç0 ¢vR&WV—&RF&vWB²÷&FW"ÆæwVvR6öÖWv†W&P¢–âF†RFV6öFVBÖW76vRà¢¢ð ¢–b€¢÷F&vWBö’çFW7B†6öÖ&–æVB’ÇÀ¢ö÷&FW"ö’çFW7B†6öÖ&–æVB¢’°¢&WGW&âçVÆÃ°¢Ð  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¢õ$DU"åTÔ$U ¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ð ¢6öç7B÷&FW$ÖF6‚Ð¢6öÖ&–æVBæÖF6‚€¢ö÷&FW%Ç2¢ƒó¦çVÖ&W'Â7ÆæõÂãò“õÇ2££õÇ2¢3õÇ2¢…³Ó•×³bÃCÒ’ö¢“° ¢6öç7B÷&FW$çVÖ&W"Ð¢÷&FW$ÖF6ƒòå³Ð¢ò6ÆVâ€¢÷&FW$ÖF6…³ÒÀ¢ ¢¢¢çVÆÃ°  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¢õ$DU"DõDÀ¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ð ¢6öç7BF÷FÄÖF6‚Ð¢6öÖ&–æVBæÖF6‚€¢ö÷&FW%Ç2·F÷FÅÇ2££õÇ2¥ÂCõÇ2¢…µÆBÅÒ²ƒó¥ÂåÆG³'Ò“ò’ö¢“° ¢6öç7B÷&FW%F÷FÂÐ¢F÷FÄÖF6ƒòå³Ð¢ò'6TÖöæW’€¢F÷FÄÖF6…³Ð¢¢¢çVÆÃ° ¢–b€¢÷&FW$çVÖ&W"ÇÀ¢÷&FW%F÷FÂÓÓÒçVÆÀ¢’°¢&WGW&âçVÆÃ°¢Ð  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¢$TÔõdRD$tUB$T4ôÔÔTäDD”ôâòÔ$´UD”är4T5D”ôà ¢&VÂF&vWBVÖ–Ç26â6öçF–âVç&VÆFVB&öGV7G0¢VæFW"%WæW‡BÂ§W7Bf÷"–÷R"âF†÷6R×W7BæWfW ¢&V6öÖR6†V6¶÷WB—FV×2à¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ð ¢ÆWB÷&FW%FW‡BÐ¢6öÖ&–æVC° ¢6öç7B&V6öÖÖVæFF–öä–æFW‚Ð¢÷&FW%FW‡Bç6V&6‚€¢÷WÇ2¶æW‡BÅÇ2¦§W7EÇ2¶f÷%Ç2·–÷UÇ2£¢ö¢“° ¢–b€¢&V6öÖÖVæFF–öä–æFW‚ãÒ ¢’°¢÷&FW%FW‡BÐ¢÷&FW%FW‡Bç6Æ–6R€¢À¢&V6öÖÖVæFF–öä–æFW€¢“°¢Ð  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¢$ôET5B%4U%0 ¢7W÷'G26öçG&öÆÆVBf—‡GW&Rf÷&ÖC  ¢&öGV7BæÖP¢VçF—G“¢@¢C3’ã“’V6€ ¢7W÷'G2&VÂF&vWBf÷&ÖC  ¢¶–ÖvS¢&öGV7BæÖUÐ¢G&6¶–ær÷&öGV7BÆ–æ·0¢&öGV7BæÖP¢G&6¶–ær÷&öGV7BÆ–æ·0¢G“¢ ¢Cc’ã“’òV ¢F†RG’÷&–6R—"—2F†Ræ6†÷"âf÷"&VÂF&vW@¢VÖ–Ç2ÂvRÆöö²&6·v&B–ç6–FRF†B—FVÒw2Æö6À¢&Æö6²f÷"F†RæV&W7BG'W7Gv÷'F‡’&öGV7B–ÖvP¢Ö&¶W"æBÖF6‚—BFòâ7GVÂVÖ–Â–ÖvRà¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ð ¢6öç7B—FV×2ÒµÓ° ¢ò ¢ÖF6‚F†RVçF—G’²Væ—B&–6Rf—'7Bà ¢F†—2fö–G2G&VF–ærF&vWBG&6¶–ærU$Ç22F†P¢&öGV7BæÖRà¢¢ð ¢6öç7BVçF—G•&–6UFÚ±î¸Â¸­yêë¢°k¢G§¦*^tern =
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

    PokÃ©mon TCG: 30th Celebration Booster Bundle (6 Packs)
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
    combinedm«ëŒ+Š×ž®º+º$zzb¥âæÖF6‚€¢ö÷&FW%Ç2·F÷FÅÇ2££õÇ2¥ÂEÇ2¢…µÆBÅÒ²ƒó¥ÂåÆG³'Ò’’ö¢’ÇÀ¢6öÖ&–æVBæÖF6‚€¢ö÷&FW%Ç2·F÷FÅµÇ5Å5×³Ã#ÓõÂEÇ2¢…µÆBÅÒ²ƒó¥ÂåÆG³'Ò’’ö¢“° ¢6öç7B÷&FW%F÷FÂÐ¢F÷FÄÖF6ƒòå³Ð¢ò'6TÖöæW’€¢F÷FÄÖF6…³Ð¢¢¢çVÆÃ°  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¢õD”ôäÂ$ôET5B”ÔtU0 ¢ÖF6‚ÅBõD•DÄRÆ&VÇ2Fò¶æ÷vâ&öGV7BæÖW2v†Và¢F†RVÖ–Â…DÔÂW‡÷6W2F†VÒà¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ð ¢6öç7B–ÖvW2Ð¢W‡G&7DVÖ–Ä–ÖvUW&Ç2€¢FV6öFVBæ‡FÖÀ¢“° ¢f÷"€¢6öç7B—FVÒö`¢—FV×0¢’°¢6öç7B¶W’Ð¢æ÷&ÖÆ—¦UvÆÖ'E&öGV7EFW‡B€¢—FVÒææÖP¢“° ¢6öç7B–ÖvRÐ¢–ÖvW2æf–æB†–ÖvRÓâ°¢6öç7BÇBÐ¢æ÷&ÖÆ—¦UvÆÖ'E&öGV7EFW‡B€¢–ÖvSòæÇ@¢“° ¢6öç7BF—FÆRÐ¢æ÷&ÖÆ—¦UvÆÖ'E&öGV7EFW‡B€¢–ÖvSòçF—FÆP¢“° ¢&WGW&â€¢ÇBÓÓÒ¶W’ÇÀ¢F—FÆRÓÓÒ¶W’ÇÀ¢€¢ÇBæÆVæwF‚ãÒ"b`¢€¢ÇBæ–æ6ÇVFW2†¶W’’ÇÀ¢¶W’æ–æ6ÇVFW2†ÇB¢¢’ÇÀ¢€¢F—FÆRæÆVæwF‚ãÒ"b`¢€¢F—FÆRæ–æ6ÇVFW2†¶W’’ÇÀ¢¶W’æ–æ6ÇVFW2‡F—FÆR¢¢¢“°¢Ò“° ¢–b†–ÖvSòæ–ÖvUW&Â’°¢—FVÒæ–ÖvUW&ÂÐ¢–ÖvRæ–ÖvUW&Ã°¢Ð¢Ð  ¢–b€¢÷&FW$çVÖ&W"ÇÀ¢÷&FW%F÷FÂÓÓÒçVÆÀ¢’°¢&WGW&âçVÆÃ°¢Ð ¢&WGW&â°¢&WF–ÆW# ¢%´2"À ¢÷&FW$çVÖ&W"À ¢6†V6¶÷WDBÀ ¢—FVÔ6÷VçBÀ ¢÷&FW%F÷FÂÀ ¢—FV×2À ¢6÷W&6S ¢&–ÖÖÆ—fR×¶2"À ¢Ö–Æ&÷…V–C ¢7G&–ær€¢V–BÇÀ¢" ¢’À ¢ÖW76vT–C ¢6ÆVâ€¢ÖW76vT–BÀ¢S ¢¢Ó°§Ð  ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢tÄÔ%Bõ$DU"%4U  ¢'V–ÇB&÷VæBvÆÖ'Bw2Æ—fR6öæf—&ÖF–öâf÷&ÖC ¢Ò7V&¦V7C¢%F†æ·2f÷"–÷W"÷&FW"ÂÆæÖSâ ¢Ò6VæFW"öFöÖ–ã¢vÆÖ'BòvÆÖ'Bæ6öÐ¢Ò$÷&FW"çVÖ&W#¢3#C‚Ó“#s3c3#2 ¢ÒgVÆf–ÆÆÖVçB6V7F–öç2v—F‚#—FVÒ"ò#B—FV×2 ¢Ò$÷&FW"F÷FÂ"föÆÆ÷vVB'’F†Rf–æÂ÷&FW"Ö÷Vç@¢Ò6W&FR–ÖVçBÖWF†öBòFV×÷&'’†öÆBÖ÷Vç@ ¢”Õõ%DåC ¢vR–çFVçF–öæÆÇ’'6Rõ$DU"DõDÂæB–væ÷&RF†P¢FV×÷&'’WF†÷&—¦F–öâ†öÆBÖ÷VçBà¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦gVæ7F–öâæ÷&ÖÆ—¦UvÆÖ'E&öGV7EFW‡B€¢fÇVP¢’°¢&WGW&â7G&–ær‡fÇVRÇÂ""¢çFôÆ÷vW$66R‚¢ç&WÆ6R€¢õµæ×£Ó•Ò²örÀ¢" ¢¢ç&WÆ6R€¢õÇ2²örÀ¢" ¢¢çG&–Ò‚“°§Ð  ¦gVæ7F–öâ—5vÆÖ'Dæöå&öGV7D–ÖvTÆ&VÂ€¢fÇVP¢’°¢6öç7BÆ&VÂÐ¢æ÷&ÖÆ—¦UvÆÖ'E&öGV7EFW‡B€¢fÇVP¢“° ¢–b‚Æ&VÂ’°¢&WGW&âG'VS°¢Ð ¢6öç7B&Æö6¶VBÒ°¢'vÆÖ'B"À¢'vÆÖ'BÆövò"À¢'vÆÖ'BÇW2"À¢&vöövÆRÆ’"À¢&7F÷&R"À¢&F÷væÆöBöâF†R7F÷&R"À¢&vWB—BöâvöövÆRÆ’"À¢'6†÷ç—v†W&R"À¢&7W&'6–FR–6·W"À¢&FVÆ—fW'’"À¢'f–Wr÷&FW""À¢'6VR—FVÒ"À¢'6VRÆÂ"À¢'VW7F–öç2"À¢&†VÇ6VçFW""À¢&f6V&öö²"À¢&–ç7Fw&Ò"À¢'–çFW&W7B"À¢'–÷WGV&R ¢Ó° ¢&WGW&â&Æö6¶VBç6öÖR€¢FW‡BÓà¢Æ&VÂÓÓÒFW‡BÇÀ¢Æ&VÂç7F'G5v—F‚€¢G·FW‡GÒ ¢¢“°§Ð  ¦gVæ7F–öâvÆÖ'E&öGV7D6æF–FFW2€¢FW‡BÀ¢–ÖvW0¢’°¢6öç7B6æF–FFW2Ð¢µÓ° ¢6öç7B6VVâÐ¢æWr6WB‚“° ¢ò ¢FV6öFVB…DÔÂ÷Æ–â×FW‡B6öÖÖöæÇ’W‡÷6W2W6VgVÀ¢–ÖvRÅBFW‡B2%¶–ÖvS¢&öGV7BæÖUÒ"à¢¢ð¢6öç7BÖ&¶W%GFW&âÐ¢õÅ¶–ÖvS¥Ç2¢…µåÅÕÇ%Æå×³BÃSÒ•ÅÒöv“° ¢ÆWBÖ&¶W#° ¢v†–ÆR€¢€¢Ö&¶W"Ð¢Ö&¶W%GFW&âæW†V2€¢7G&–ær‡FW‡BÇÂ""¢¢’ÓÒçVÆÀ¢’°¢6öç7BæÖRÐ¢6ÆVâ€¢Ö&¶W%³ÒÀ¢3 ¢“° ¢6öç7B¶W’Ð¢æ÷&ÖÆ—¦UvÆÖ'E&öGV7EFW‡B€¢æÖP¢“° ¢–b€¢¶W’ÇÀ¢—5vÆÖ'Dæöå&öGV7D–ÖvTÆ&VÂ€¢æÖP¢’ÇÀ¢6VVâæ†2†¶W’¢’°¢6öçF–çVS°¢Ð ¢6öç7B–ÖvRÐ¢€¢'&’æ—4'&’†–ÖvW2¢ò–ÖvW0¢¢µÐ¢’æf–æB†—FVÒÓâ°¢6öç7BÇBÐ¢æ÷&ÖÆ—¦UvÆÖ'E&öGV7EFW‡B€¢—FVÓòæÇ@¢“° ¢6öç7BF—FÆRÐ¢æ÷&ÖÆ—¦UvÆÖ'E&öGV7EFW‡B€¢—FVÓòçF—FÆP¢“° ¢&WGW&â€¢ÇBÓÓÒ¶W’ÇÀ¢F—FÆRÓÓÒ¶W’ÇÀ¢€¢ÇBæÆVæwF‚ãÒ"b`¢€¢ÇBæ–æ6ÇVFW2†¶W’’ÇÀ¢¶W’æ–æ6ÇVFW2†ÇB¢¢’ÇÀ¢€¢F—FÆRæÆVæwF‚ãÒ"b`¢€¢F—FÆRæ–æ6ÇVFW2†¶W’’ÇÀ¢¶W’æ–æ6ÇVFW2‡F—FÆR¢¢¢“°¢Ò“° ¢6VVâæFB†¶W’“° ¢6æF–FFW2çW6‚‡°¢æÖRÀ¢VçF—G“ ¢À¢&–6S ¢À¢–ÖvUW&Ã ¢–ÖvSòæ–ÖvUW&ÂÇÀ¢çVÆÀ¢Ò“°¢Ð ¢ò ¢–bÆ–â×FW‡B6öçfW'6–öâF–Bæ÷BW‡÷6R¶–ÖvS¥Ð¢Ö&¶W'2ÂW6RÖVæ–ævgVÂÅBõD•DÄRÆ&VÇ2g&öÒF†P¢VÖ–Âw2&öGV7B–ÖvW2à¢¢ð¢f÷"€¢6öç7B–ÖvRö`¢€¢'&’æ—4'&’†–ÖvW2¢ò–ÖvW0¢¢µÐ¢¢’°¢6öç7BÆ&VÇ2Ò°¢–ÖvSòæÇBÀ¢–ÖvSòçF—FÆP¢Ð¢æÖ‡fÇVRÓà¢6ÆVâ€¢fÇVRÀ¢3 ¢¢¢æf–ÇFW"„&ööÆVâ“° ¢6öç7BæÖRÐ¢Æ&VÇ2æf–æB€¢Æ&VÂÓà¢Æ&VÂæÆVæwF‚ãÒ‚b`¢—5vÆÖ'Dæöå&öGV7D–ÖvTÆ&VÂ€¢Æ&VÀ¢¢“° ¢–b‚æÖR’°¢6öçF–çVS°¢Ð ¢6öç7B¶W’Ð¢æ÷&ÖÆ—¦UvÆÖ'E&öGV7EFW‡B€¢æÖP¢“° ¢–b€¢¶W’ÇÀ¢6VVâæ†2†¶W’¢’°¢6öçF–çVS°¢Ð ¢6VVâæFB†¶W’“° ¢6æF–FFW2çW6‚‡°¢æÖRÀ¢VçF—G“ ¢À¢&–6S ¢À¢–ÖvUW&Ã ¢–ÖvSòæ–ÖvUW&ÂÇÀ¢çVÆÀ¢Ò“°¢Ð ¢&WGW&â6æF–FFW0¢ç6Æ–6R€¢À¢# ¢“°§Ð  ¦7–æ2gVæ7F–öâ'6UvÆÖ'D÷&FW"‡°¢7V&¦V7BÀ¢6VæFW"À¢6÷W&6RÀ¢V–BÀ¢ÖW76vT–BÀ¢FFP§Ò’°¢6öç7BFV6öFVBÐ¢v—BFV6öFT–ÖÖW76vR€¢6÷W&6P¢“° ¢6öç7BFW‡BÐ¢FV6öFVBçFW‡BÇÀ¢W‡G&7DVÖ–ÅFW‡B€¢6÷W&6P¢“° ¢6öç7B‡FÖÅFW‡BÐ¢‡FÖÅFõÆ–åFW‡B€¢FV6öFVBæ‡FÖÀ¢“° ¢6öç7B6öÖ&–æVBÐ¢G·7V&¦V7BÇÂ"'ÕÆâG·6VæFW"ÇÂ"'ÕÆâG·FW‡GÕÆâG¶‡FÖÅFW‡GÖ° ¢ò ¢vÆÖ'B6öæf—&ÖF–öâ7V&¦V7G2Fòæ÷BæV6W76&–Ç¢6’%vÆÖ'B#²F†R6VæFW"öFöÖ–âFöW2âf÷'v&FV@¢6öæf—&ÖF–öç26â7F–ÆÂ&R&V6övæ—¦VB'’&öG’FW‡Bà¢¢ð¢–b€¢ö÷&FW"ö’çFW7B€¢6öÖ&–æV@¢’ÇÀ¢€¢÷vÆÖ'Bö’çFW7B€¢6öÖ&–æV@¢’ÇÀ¢ôvÆÖ'EÂæ6öÕÆ"ö’çFW7B€¢6VæFW"ÇÂ" ¢¢¢’°¢&WGW&âçVÆÃ°¢Ð  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¢õ$DU"åTÔ$U ¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ð ¢6öç7B÷&FW$ÖF6‚Ð¢6öÖ&–æVBæÖF6‚€¢ö÷&FW%Ç2¢ƒó¦çVÖ&W'Â7ÆæõÂãò“õÇ2££õÇ2¢3õÇ2¢…³Ó•×³BÃ'ÒÕ³Ó•×³RÃ#GÒ’ö¢’ÇÀ¢6öÖ&–æVBæÖF6‚€¢ö÷&FW%Ç2¢ƒó¦çVÖ&W'Â7ÆæõÂãò“õÇ2££õÇ2¢3õÇ2¢…´Õ£Ó’Õ×³‚ÃCÒ’ö¢“° ¢6öç7B÷&FW$çVÖ&W"Ð¢÷&FW$ÖF6ƒòå³Ð¢ò6ÆVâ€¢÷&FW$ÖF6…³ÒÀ¢ ¢¢¢çVÆÃ°  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¢õ$DU"DõDÀ ¢6V&6‚öæÇ’F†R6†÷'B&V–ÖÖVF–FVÇ’föÆÆ÷v–æp¢$÷&FW"F÷FÂ"âF†—2&WfVçG2vÆÖ'Bw26W&FP¢%FV×÷&'’†öÆB"Ö÷VçBg&öÒ&V6öÖ–ærF†R7V66W70¢6†V6¶÷WBfÇVRà¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ð ¢6öç7BF÷FÅ6V7F–öäÖF6‚Ð¢6öÖ&–æVBæÖF6‚€¢ö÷&FW%Ç2·F÷FÅÆ"…µÇ5Å5×³Ã3SÒ’ö¢“° ¢6öç7BF÷FÄÖöæW”ÖF6‚Ð¢F÷FÅ6V7F–öäÖF6ƒòå³Ð¢òæÖF6‚€¢õÂEÇ2¢…µÆBÅÒ²ƒó¥ÂåÆG³'Ò’’ö¢“° ¢6öç7B÷&FW%F÷FÂÐ¢F÷FÄÖöæW”ÖF6ƒòå³Ð¢ò'6TÖöæW’€¢F÷FÄÖöæW”ÖF6…³Ð¢¢¢çVÆÃ° ¢–b€¢÷&FW$çVÖ&W"ÇÀ¢÷&FW%F÷FÂÓÓÒçVÆÀ¢’°¢&WGW&âçVÆÃ°¢Ð  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¢•DTÒ4õTå@ ¢vÆÖ'BÖ’7Æ—BöæR÷&FW"&WGvVVâ7W&'6–FR–6·W ¢æBFVÆ—fW'’â7VÒF†Rf—6–&ÆR$â—FVÒ‡2’"6÷VçG0¢&Vf÷&RF†R÷&FW"F÷FÂ6V7F–öâà¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ð ¢6öç7B&Vf÷&UF÷FÂÐ¢6öÖ&–æV@¢ç7Æ—B€¢ö÷&FW%Ç2·F÷FÅÆ"ö¢•³ÒÇÀ¢6öÖ&–æVC° ¢6öç7B—FVÔ6÷VçDÖF6†W2Ð¢°¢ââæ&Vf÷&UF÷FÂæÖF6„ÆÂ€¢õÆ"…ÆG³Ã7Ò•Ç2¶—FV×3õÆ"öv¢¢Ð¢æÖ€¢ÖF6‚Óà¢çVÖ&W"€¢ÖF6…³Ð¢¢¢æf–ÇFW"€¢fÇVRÓà¢çVÖ&W"æ—4–çFVvW"€¢fÇVP¢’b`¢fÇVRâb`¢fÇVRÃÒ ¢“° ¢ÆWB—FVÔ6÷VçBÐ¢—FVÔ6÷VçDÖF6†W2ç&VGV6R€¢‡7VÒÂfÇVR’Óà¢7VÒ²fÇVRÀ¢ ¢“°  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¢$ôET5BäÔU2²”ÔtU0 ¢vÆÖ'Bw26öæf—&ÖF–öâ6â7VÖÖ&—¦R&öGV7G2'¢–ÖvRôÅBFW‡B&F†W"F†â6†÷v–ær&–6R&÷rf÷ ¢WfW'’—FVÒâ7V66W72FöW2æ÷B&WV—&RW"Ö—FVÒ&–6W3°¢F†RWF†÷&—FF—fR6†V6¶÷WBfÇVR—2÷&FW"F÷FÂà¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ð ¢6öç7BÆÄ–ÖvW2Ð¢W‡G&7DVÖ–Ä–ÖvUW&Ç2€¢FV6öFVBæ‡FÖÀ¢“° ¢6öç7B—FV×2Ð¢vÆÖ'E&öGV7D6æF–FFW2€¢&Vf÷&UF÷FÂÀ¢ÆÄ–ÖvW0¢“° ¢–b€¢—FVÔ6÷VçBÃÒ ¢’°¢—FVÔ6÷VçBÐ¢—FV×2ç&VGV6R€¢‡7VÒÂ—FVÒ’Óà¢7VÒ°¢çVÖ&W"€¢—FVÒçVçF—G’ÇÀ¢¢’À¢ ¢“°¢Ð  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¢$UEU$âäõ$ÔÄ•¤TBtÄÔ%B4„T4´õU@¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ð ¢&WGW&â°¢&WF–ÆW# ¢%vÆÖ'B"À ¢÷&FW$çVÖ&W"À ¢6†V6¶÷WDC ¢FFRÇÀ¢çVÆÂÀ ¢—FVÔ6÷VçBÀ ¢÷&FW%F÷FÂÀ ¢—FV×2À ¢6÷W&6S ¢&–ÖÖÆ—fR×vÆÖ'B"À ¢Ö–Æ&÷…V–C ¢7G&–ær€¢V–BÇÀ¢" ¢’À ¢ÖW76vT–C ¢6ÆVâ€¢ÖW76vT–BÀ¢S ¢¢Ó°§Ð  ¦7–æ2gVæ7F–öâ&VDÆFW7EF&vWEFW7D÷&FW"€¢VÖ–ÂÀ¢77v÷&@¢’°¢6öç7B°¢&÷f–FW"À¢6Æ–Vç@¢ÒÐ¢7&VFT7W7FöÖW$–Ö6Æ–VçB€¢VÖ–ÂÀ¢77v÷&@¢“° ¢G'’°¢v—B6Æ–VçBæ6öææV7B‚“° ¢6öç7BÆö6²Ð¢v—B6Æ–VçBævWDÖ–Æ&÷„Æö6²€¢$”ä$õ‚"À¢°¢&VDöæÇ“¢G'VP¢Ð¢“° ¢G'’°¢6öç7BF÷FÄÖW76vW2Ð¢çVÖ&W"€¢6Æ–VçBæÖ–Æ&÷ƒòæW†—7G2ÇÂ ¢“° ¢–b‚F÷FÄÖW76vW2’°¢&WGW&â°¢&÷f–FW# ¢&÷f–FW"ææÖRÀ ¢ÖF6†VC ¢fÇ6RÀ ¢÷&FW# ¢çVÆÀ¢Ó°¢Ð ¢ò ¢öæÇ’–ç7V7BF†RæWvW7B#RÖW76vW2à¢f—'7BfWF6‚VçfVÆ÷RÖWFFFà¢¢ð ¢6öç7B7F'E6WVVæ6RÐ¢ÖF‚æÖ‚€¢À¢F÷FÄÖW76vW2Ò#@¢“° ¢6öç7B6æF–FFW2Ð¢v—B6Æ–VçBæfWF6„ÆÂ€¢G·7F'E6WVVæ6WÓ¢¦À¢°¢V–C¢G'VRÀ¢VçfVÆ÷S¢G'VRÀ¢–çFW&æÄFFS¢G'VP¢Ð¢“° ¢ò ¢æWvW7Bf—'7Bà¢¢ð ¢6æF–FFW2ç&WfW'6R‚“° ¢f÷"€¢6öç7B6æF–FFRöb6æF–FFW0¢’°¢6öç7B7V&¦V7BÐ¢7G&–ær€¢6æF–FFP¢æVçfVÆ÷P¢òç7V&¦V7BÇÀ¢" ¢“° ¢ò ¢Fòæ÷BfWF6‚ÖW76vR6öçFVçBVæÆW70¢F†R7V&¦V7BÆöö·2Æ–¶RF&vWB÷&FW"à¢¢ð ¢–b€¢÷F&vWBö’çFW7B‡7V&¦V7B’ÇÀ¢ö÷&FW"ö’çFW7B‡7V&¦V7B¢’°¢6öçF–çVS°¢Ð ¢6öç7BÖW76vRÐ¢v—B6Æ–VçBæfWF6„öæR€¢6æF–FFRçV–BÀ¢°¢V–C¢G'VRÀ¢VçfVÆ÷S¢G'VRÀ¢–çFW&æÄFFS¢G'VRÀ¢6÷W&6S¢G'VP¢ÒÀ¢°¢V–C¢G'VP¢Ð¢“° ¢–b‚ÖW76vR’°¢6öçF–çVS°¢Ð ¢6öç7B'6VBÐ¢v—B'6UF&vWEFW7D÷&FW"‡°¢7V&¦V7C ¢ÖW76vRæVçfVÆ÷P¢òç7V&¦V7BÇÀ¢7V&¦V7BÀ ¢6÷W&6S ¢ÖW76vRç6÷W&6RÀ ¢V–C ¢ÖW76vRçV–BÀ ¢ÖW76vT–C ¢ÖW76vRæVçfVÆ÷P¢òæÖW76vT–BÇÀ¢""À ¢FFS ¢€¢ÖW76vRæVçfVÆ÷SòæFFRÇÀ¢ÖW76vRæ–çFW&æÄFFP¢¢òæWrFFR€¢ÖW76vRæVçfVÆ÷SòæFFRÇÀ¢ÖW76vRæ–çFW&æÄFFP¢’çFô•4õ7G&–ær‚¢¢çVÆÀ¢Ò“° ¢–b‡'6VB’°¢&WGW&â°¢&÷f–FW# ¢&÷f–FW"ææÖRÀ ¢ÖF6†VC ¢G'VRÀ ¢÷&FW# ¢'6V@¢Ó°¢Ð¢Ð ¢&WGW&â°¢&÷f–FW# ¢&÷f–FW"ææÖRÀ ¢ÖF6†VC ¢fÇ6RÀ ¢÷&FW# ¢çVÆÀ¢Ó° ¢Òf–æÆÇ’°¢Æö6²ç&VÆV6R‚“°¢Ð ¢Òf–æÆÇ’°¢–b†6Æ–VçBçW6&ÆR’°¢G'’°¢v—B6Æ–VçBæÆöv÷WB‚“°¢Ò6F6‚°¢6Æ–VçBæ6Æ÷6R‚“°¢Ð¢ÒVÇ6R°¢6Æ–VçBæ6Æ÷6R‚“°¢Ð¢Ð§Ð  ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢Ä•dRD$tUB²tÄÔ%B²´2²4õ5D4ò5T44U525”ä0¢W6W2V6‚7F—fR7W7FöÖW"w2Væ7'—FVB4òÖ–Æ&÷€¢7&VFVçF–Ç2Â6fW2æWrF&vWB÷&FW"6öæf—&ÖF–öç2Fð¢F†R&VÂ7V66W727F÷&RÂF†Vâ&V6÷&E7V66W746†V6¶÷WB‚¢6VæG2F†R&—f7’×6fRF—66÷&Bæ÷F–f–6F–öâà¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦6öç7BÄ•dUõ5T44U55õ5”ä5ô”åDU%dÅôÕ2Ð¢ÖF‚æÖ‚€¢c¢À¢çVÖ&W"€¢&ö6W72æVç`¢å5T44U55õ5”ä5ô”åDU%dÅôÕ2ÇÀ¢c¢ ¢¢“° ¦6öç7BÄ•dUõ5T44U55ôÔ”åô44õTåEô”åDU%dÅôÕ2Ð¢ÖF‚æÖ‚€¢3¢À¢çVÖ&W"€¢&ö6W72æVç`¢å5T44U55ô44õTåEõ5”ä5õD…$õEDÄUôÕ2ÇÀ¢c¢ ¢¢“° ¦6öç7BÆ—fU7V66W74Æ7E7–æ4'”66÷VçBÐ¢æWrÖ‚“° ¦6öç7BÆ—fU7V66W74Ö–Æ&÷…66å6–æ6RÒæWrÖ‚“° ¦6öç7BÆ—fU7V66W7466÷VçDÆö6·2Ð¢æWr6WB‚“° ¦ÆWBÆ—fU7V66W747–6ÆU'Vææ–ærÐ¢fÇ6S°   ¦gVæ7F–öâW‡G&7E&÷WF–ætVÖ–Ç4g&öÕ6÷W&6R€¢6÷W&6P¢’°¢6öç7B&rÐ¢'VffW"æ—4'VffW"€¢6÷W&6P¢¢ò6÷W&6RçFõ7G&–ær€¢'WFc‚ ¢¢¢7G&–ær€¢6÷W&6RÇÀ¢" ¢“° ¢ò ¢f÷'v&FVB÷&VF—&V7FVBÖ–Â6â&W6W'fRF†R÷&–v–æÀ¢&V6—–VçB–â†VFW'2õ"–âF†Rf÷'v&FVBÖW76vR&öG’à¢vRöæÇ’¶VW7–çF7F–6ÆÇ’fÆ–BVÖ–ÂFG&W76W2à¢¢ð¢6öç7BÖF6†W2Ð¢&p¢ç6Æ–6R€¢À¢# ¢¢æÖF6‚€¢õ´Õ£Ó’åòR²ÕÒ´´Õ£Ó’âÕÒµÂå´Õ¥×³"ÇÒöv¢’ÇÀ¢µÓ° ¢&WGW&â°¢ââææWr6WB€¢ÖF6†W0¢æÖ€¢æ÷&ÖÆ—¦TVÖ–À¢¢æf–ÇFW"„&ööÆVâ¢¢Ó°§Ð  ¦7–æ2gVæ7F–öâ&VE&V6VçE&WF–ÆW$÷&FW'2€¢VÖ–ÂÀ¢77v÷&BÀ¢Ö„ÖW76vW2ÒcÀ¢6–æ6TBÒçVÆÀ¢’°¢6öç7B°¢&÷f–FW"À¢6Æ–Vç@¢ÒÐ¢7&VFT7W7FöÖW$–Ö6Æ–VçB€¢VÖ–ÂÀ¢77v÷&@¢“° ¢G'’°¢v—B6Æ–VçBæ6öææV7B‚“° ¢6öç7BÆö6²Ð¢v—B6Æ–VçBævWDÖ–Æ&÷„Æö6²€¢$”ä$õ‚"À¢°¢&VDöæÇ“¢G'VP¢Ð¢“° ¢G'’°¢6öç7BF÷FÄÖW76vW2Ð¢çVÖ&W"€¢6Æ–VçBæÖ–Æ&÷ƒòæW†—7G2ÇÀ¢ ¢“° ¢–b‚F÷FÄÖW76vW2’°¢&WGW&â°¢&÷f–FW# ¢&÷f–FW"ææÖRÀ¢÷&FW'3¢µÐ¢Ó°¢Ð ¢6öç7B6fTÖ‚Ð¢ÖF‚æÖ–â€¢#À¢ÖF‚æÖ‚€¢#À¢çVÖ&W"†Ö„ÖW76vW2’ÇÀ¢c ¢¢“° ¢òò6V&6‚'’6–vçWFFR6òâÇ&VG’6öææV7FVBÖ–Æ&÷‚6â&6¶f–ÆÀ¢òò6öæf—&ÖF–öç2gFW"&Vv—7G&F–öâÂWfVâ–bF†R–æ&÷‚†2w&÷vâà¢6öç7B6–vçWF–ÖRÒæWrFFR‡6–æ6TBÇÂ’ævWEF–ÖR‚“°¢6öç7B6–vçWFFRÒçVÖ&W"æ—4f–æ—FR‡6–vçWF–ÖR’bb6–vçWF–ÖRâ ¢òæWrFFR‡6–vçWF–ÖR¢¢çVÆÃ°¢6öç7B6öæf—&ÖF–öå7V&¦V7G2Ò²÷#¢°¢²7V&¦V7C¢&÷&FW""ÒÂ²7V&¦V7C¢'W&6†6R"ÒÀ¢²7V&¦V7C¢'&V6V—B"ÒÂ²7V&¦V7C¢&6öæf—&ÖF–öâ"Ð¢ÒÓ°¢6öç7BÖF6†–æuV–G2Òv—B6Æ–VçBç6V&6‚€¢6–vçWFFRò²ââæ6öæf—&ÖF–öå7V&¦V7G2Â6–æ6S¢6–vçWFFRÒ¢6öæf—&ÖF–öå7V&¦V7G2À¢²V–C¢G'VRÐ¢“° ¢6öç7B6æF–FFW2ÒµÓ°¢f÷"†ÆWBöfg6WBÒ²öfg6WBÂÖF6†–æuV–G2æÆVæwFƒ²öfg6WB³Ò6fTÖ‚’°¢6æF–FFW2çW6‚‚ââæv—B6Æ–VçBæfWF6„ÆÂ€¢ÖF6†–æuV–G2ç6Æ–6R†öfg6WBÂöfg6WB²6fTÖ‚’À¢²V–C¢G'VRÂVçfVÆ÷S¢G'VRÂ–çFW&æÄFFS¢G'VRÒÀ¢²V–C¢G'VRÐ¢’“°¢Ð ¢ò ¢&ö6W72öÆFW7BÓâæWvW7B6ò7V66W72†—7F÷'¢&VÖ–ç2æGW&ÆÇ’÷&FW&VBà¢¢ð¢6öç7B÷&FW'2ÒµÓ° ¢f÷"€¢6öç7B6æF–FFRö`¢6æF–FFW0¢’°¢6öç7B&V6V—fVDBÒæWrFFR†6æF–FFRæ–çFW&æÄFFRÇÂ6æF–FFRæVçfVÆ÷SòæFFRÇÂ’ævWEF–ÖR‚“°¢–b‡6–vçWFFRbb‚çVÖ&W"æ—4f–æ—FR‡&V6V—fVDB’ÇÂ&V6V—fVDBÂ6–vçWF–ÖR’’6öçF–çVS°¢6öç7B7V&¦V7BÐ¢7G&–ær€¢6æF–FFP¢æVçfVÆ÷P¢òç7V&¦V7BÇÀ¢" ¢“° ¢6öç7B6VæFW"Ð¢€¢6æF–FFP¢æVçfVÆ÷P¢òæg&öÒÇÀ¢µÐ¢¢æÖ†FG&W72Óà¢G¶FG&W73òææÖRÇÂ"'ÒÂG¶FG&W73òæFG&W72ÇÂ"'Óæ ¢¢æ¦ö–â‚""“° ¢ò ¢F&vWBÂvÆÖ'BæBö¶VÖöâ6VçFW"6öæf—&ÖF–öç26öçF–à¢÷&FW"ÆæwVvRâvÆÖ'Bw27V&¦V7B—2G—–6ÆÇ¢%F†æ·2f÷"–÷W"÷&FW"ÂÆæÖSâ"æBÖ’æ÷@¢6öçF–âF†R&WF–ÆW"æÖRà¢¢ð¢–b€¢ö÷&FW'ÇW&6†6WÇ&V6V—GÆ6öæf—&ÖF–öâö’çFW7B€¢7V&¦V7@¢¢’°¢6öçF–çVS°¢Ð ¢6öç7BÖW76vRÐ¢v—B6Æ–VçBæfWF6„öæR€¢6æF–FFRçV–BÀ¢°¢V–C¢G'VRÀ¢VçfVÆ÷S¢G'VRÀ¢–çFW&æÄFFS¢G'VRÀ¢6÷W&6S¢G'VP¢ÒÀ¢°¢V–C¢G'VP¢Ð¢“° ¢–b€¢ÖW76vRÇÀ¢ÖW76vRç6÷W&6P¢’°¢Ú±î¸Â¸­yêë¢°k¢G§¦*^    continue;
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

        const message =
          await client.fetchOne(
            candidate.uid,
            {
              uid: true,
              envelope: true,
              internalDate: true,
              soum«ëŒ+Š×ž®º+º$zzb¥ç&6S¢G'VP¢ÒÀ¢°¢V–C¢G'VP¢Ð¢“° ¢–b€¢ÖW76vSòç6÷W&6P¢’°¢6öçF–çVS°¢Ð ¢6öç7B6öÖÖöâÒ°¢7V&¦V7C ¢ÖW76vRæVçfVÆ÷P¢òç7V&¦V7BÇÀ¢7V&¦V7BÀ ¢6VæFW# ¢€¢ÖW76vRæVçfVÆ÷P¢òæg&öÒÇÀ¢µÐ¢¢æÖ€¢FG&W72Óà¢G¶FG&W73òææÖRÇÂ"'ÒÂG¶FG&W73òæFG&W72ÇÂ"'Óæ ¢¢æ¦ö–â‚""’À ¢6÷W&6S ¢ÖW76vRç6÷W&6RÀ ¢V–C ¢ÖW76vRçV–BÀ ¢ÖW76vT–C ¢ÖW76vRæVçfVÆ÷P¢òæÖW76vT–BÇÀ¢""À ¢FFS ¢€¢ÖW76vRæVçfVÆ÷SòæFFRÇÀ¢ÖW76vRæ–çFW&æÄFFP¢¢òæWrFFR€¢ÖW76vRæVçfVÆ÷SòæFFRÇÀ¢ÖW76vRæ–çFW&æÄFFP¢’çFô•4õ7G&–ær‚¢¢çVÆÀ¢Ó° ¢ÆWB'6VBÐ¢çVÆÃ° ¢–b‚'6VB’°¢'6VBÐ¢v—B'6T6÷7F6ô÷&FW"€¢6öÖÖöà¢“°¢Ð ¢–b‚'6VB’°¢'6VBÐ¢v—B'6Uö¶VÖöä6VçFW$÷&FW"€¢6öÖÖöà¢“°¢Ð ¢–b‚'6VB’°¢'6VBÐ¢v—B'6UvÆÖ'D÷&FW"€¢6öÖÖöà¢“°¢Ð ¢–b‚'6VB’°¢'6VBÐ¢v—B'6UF&vWEFW7D÷&FW"€¢6öÖÖöà¢“°¢Ð ¢–b‡'6VB’°¢÷&FW'2çW6‚‡°¢ââç'6VBÀ ¢ÖW76vT–C ¢'6VBæÖW76vT–BÇÀ¢6öÖÖöâæÖW76vT–BÇÀ¢""À ¢Ö–Æ&÷…V–C ¢'6VBæÖ–Æ&÷…V–BÇÀ¢6öÖÖöâçV–BÇÀ¢çVÆÂÀ ¢&÷WF–ætVÖ–Ç3 ¢W‡G&7E&÷WF–ætVÖ–Ç4g&öÕ6÷W&6R€¢ÖW76vRç6÷W&6P¢¢Ò“°¢Ð¢öå&öw&W72‡²†6S¢&6†V6¶–ær"ÂW&6VçC¢#²ÖF‚æfÆö÷"ƒc¢&ö6W76VBòÖF‚æÖ‚ƒÂ6æF–FFW2æÆVæwF‚’’Â&ö6W76VBÂF÷FÃ¢6æF–FFW2æÆVæwF‚Â&V6övæ—¦VC¢÷&FW'2æÆVæwF‚Â6fVC¢Ò“°¢Ð ¢&WGW&â°¢6öæf–wW&VC ¢G'VRÀ¢÷&FW'2À¢Æ7EV–C¢VæF–æuV–G2æÆVæwF‚òçVÖ&W"‡VæF–æuV–G2æB‚Ó’’¢ ¢Ó° ¢Òf–æÆÇ’°¢Æö6²ç&VÆV6R‚“°¢Ð ¢Òf–æÆÇ’°¢–b†6Æ–VçBçW6&ÆR’°¢G'’°¢v—B6Æ–VçBæÆöv÷WB‚“°¢Ò6F6‚°¢6Æ–VçBæ6Æ÷6R‚“°¢Ð¢ÒVÇ6R°¢6Æ–VçBæ6Æ÷6R‚“°¢Ð¢Ð§Ð  ¦7–æ2gVæ7F–öâÖævVD66÷VçDVÖ–ÄÖ‚’°¢6öç7B66÷VçG2Ð¢v—BvWDÖævVD66÷VçG2‚“° ¢6öç7BÖÐ¢æWrÖ‚“° ¢f÷"€¢6öç7B66÷VçBö`¢66÷VçG0¢’°¢ÆWB7&VFVçF–Ç2Ð¢V×G•&WF–ÆW$7&VFVçF–Ç2‚“° ¢G'’°¢–b€¢66÷VçBæ7&VFVçF–Ç0¢’°¢7&VFVçF–Ç2Ð¢æ÷&ÖÆ—¦U&WF–ÆW$7&VFVçF–Ç2€¢FV7'—D§6öâ€¢66÷VçBæ7&VFVçF–Ç0¢¢“°¢Ð¢Ò6F6‚°¢6öçF–çVS°¢Ð ¢f÷"€¢6öç7B&WF–ÆW"ö`¢$UD”ÄU%ô´U•0¢’°¢6öç7BVÖ–ÂÐ¢æ÷&ÖÆ—¦TVÖ–Â€¢7&VFVçF–Ç0¢òå·&WF–ÆW%Ð¢òçW6W&æÖP¢“° ¢–b€¢VÖ–ÂÇÀ¢VÖ–Âæ–æ6ÇVFW2€¢$ ¢¢’°¢6öçF–çVS°¢Ð ¢Öç6WB€¢VÖ–ÂÀ¢°¢ÖævVD66÷VçD–C ¢7G&–ær€¢66÷VçBæ–@¢’À¢&WF–ÆW ¢Ð¢“°¢Ð¢Ð ¢&WGW&âÖ°§Ð  ¦gVæ7F–öâ76–væÖVçEF–ÖT6öçF–ç46†V6¶÷WB€¢76–væÖVçBÀ¢6†V6¶÷WD@¢’°¢6öç7B6†V6¶÷WBÐ¢æWrFFR€¢6†V6¶÷WDBÇÀ¢ ¢’ævWEF–ÖR‚“° ¢–b€¢çVÖ&W"æ—4f–æ—FR€¢6†V6¶÷W@¢¢’°¢&WGW&âfÇ6S°¢Ð ¢6öç7B7F'BÐ¢æWrFFR€¢76–væÖVçBç7F'G4BÇÀ¢76–væÖVçBæ7&VFVDBÇÀ¢ ¢’ævWEF–ÖR‚“° ¢–b€¢çVÖ&W"æ—4f–æ—FR‡7F'B’b`¢6†V6¶÷WBÂ7F'@¢’°¢&WGW&âfÇ6S°¢Ð ¢6öç7BVæEfÇVRÐ¢76–væÖVçBæVæFVDBÇÀ¢76–væÖVçBæW‡—&W4BÇÀ¢çVÆÃ° ¢–b†VæEfÇVR’°¢6öç7BVæBÐ¢æWrFFR€¢VæEfÇVP¢’ævWEF–ÖR‚“° ¢–b€¢çVÖ&W"æ—4f–æ—FR†VæB’b`¢6†V6¶÷WBâVæ@¢’°¢&WGW&âfÇ6S°¢Ð¢Ð ¢&WGW&âG'VS°§Ð  ¦7–æ2gVæ7F–öâÖævVD76–væÖVçD†—7F÷'’‚’°¢6öç7B°¢g&VT76–væÖVçG2À¢&VçFÄ76–væÖVçG0¢ÒÒv—B&öÖ—6RæÆÂ…°¢vWDg&VT76–væÖVçG2‚’À¢vWE&VçFÄ76–væÖVçG2‚¢Ò“° ¢&WGW&â°¢ââæg&VT76–væÖVçG2æÖ€¢—FVÒÓâ‡°¢ââæ—FVÒÀ¢76–væÖVçEG—S ¢&v–gFVB"À¢ÖævVD66÷VçD–C ¢—FVÒæÖævVD66÷VçD–BÇÀ¢—FVÒæg&VTÖVÖ&W'6†—–BÇÀ¢çVÆÀ¢Ò¢’À ¢ââç&VçFÄ76–væÖVçG2æÖ€¢—FVÒÓâ‡°¢ââæ—FVÒÀ¢76–væÖVçEG—S ¢'&VçFVB"À¢ÖævVD66÷VçD–C ¢—FVÒæÖævVD66÷VçD–BÇÀ¢—FVÒç&VçFVDÖVÖ&W'6†—–BÇÀ¢çVÆÀ¢Ò¢¢Ó°§Ð  ¦7–æ2gVæ7F–öâ7–æ4ÖævVE&öf–ÆU7V66W74Ö–Æ&÷‚‚’°¢6öç7B&W7VÇBÐ¢v—B&VE&V6VçDÖævVEv÷&´Ö–Æ&÷„÷&FW'2€¢ƒÀ¢&öw&W72Óâ²ÖævVE7V66W7566å7FGW2ç&öw&W72Ò&öw&W73²Ð¢“° ¢–b€¢&W7VÇBæ6öæf–wW&V@¢’°¢&WGW&â°¢6öæf–wW&VC ¢fÇ6RÀ¢6fVC ¢À¢VæÖF6†VC ¢ ¢Ó°¢Ð ¢6öç7BVÖ–ÄÖÐ¢v—BÖævVD66÷VçDVÖ–ÄÖ‚“° ¢6öç7B76–væÖVçG2Ð¢v—BÖævVD76–væÖVçD†—7F÷'’‚“° ¢6öç7BF÷FÄ÷&FW'2Ò&W7VÇBæ÷&FW'2æÆVæwFƒ°¢ÖævVE7V66W7566å7FGW2ç&öw&W72Ò²†6S¢'6f–ær"ÂW&6VçC¢ƒÂ&ö6W76VC¢ÂF÷FÃ¢F÷FÄ÷&FW'2Â&V6övæ—¦VC¢F÷FÄ÷&FW'2Â6fVC¢Ó° ¢ÆWB6fVBÒ°¢ÆWBVæÖF6†VBÒ°¢ÆWB&ö6W76VD÷&FW'2Ò°¢6öç7BWFFU6fU&öw&W72Ò‚’Óâ°¢&ö6W76VD÷&FW'2³Ò°¢ÖævVE7V66W7566å7FGW2ç&öw&W72Ò²†6S¢'6f–ær"ÂW&6VçC¢ƒ²ÖF‚æfÆö÷"ƒ’¢&ö6W76VD÷&FW'2òÖF‚æÖ‚ƒÂF÷FÄ÷&FW'2’’Â&ö6W76VC¢&ö6W76VD÷&FW'2ÂF÷FÃ¢F÷FÄ÷&FW'2Â&V6övæ—¦VC¢F÷FÄ÷&FW'2Â6fVBÓ°¢Ó° ¢f÷"€¢6öç7B÷&FW"ö`¢&W7VÇBæ÷&FW'0¢’°¢6öç7B&÷WF–ætVÖ–Ç2Ð¢'&’æ—4'&’€¢÷&FW"ç&÷WF–ætVÖ–Ç0¢¢ò÷&FW"ç&÷WF–ætVÖ–Ç0¢¢µÓ° ¢ÆWB66÷VçDÖF6‚Ð¢çVÆÃ° ¢f÷"€¢6öç7BVÖ–Âö`¢&÷WF–ætVÖ–Ç0¢’°¢6öç7B6æF–FFRÐ¢VÖ–ÄÖævWB€¢æ÷&ÖÆ—¦TVÖ–Â€¢VÖ–À¢¢“° ¢–b†6æF–FFR’°¢66÷VçDÖF6‚Ð¢6æF–FFS°¢'&V³°¢Ð¢Ð ¢–b‚66÷VçDÖF6‚’°¢VæÖF6†VB³Ò°¢–b†v—B&V6÷&D6öÖ×Væ—G•7V66W746†V6¶÷WB†÷&FW"’’6fVB³Ò°¢WFFU6fU&öw&W72‚“°¢6öçF–çVS°¢Ð ¢6öç7B6†V6¶÷WDBÐ¢÷&FW"æ6†V6¶÷WDBÇÀ¢÷&FW"æFFRÇÀ¢æWrFFR‚¢çFô•4õ7G&–ær‚“° ¢6öç7B76–væÖVçBÐ¢76–væÖVçG0¢æf–ÇFW"€¢—FVÒÓà¢7G&–ær€¢—FVÒæÖævVD66÷VçD–BÇÀ¢" ¢’ÓÓÐ¢7G&–ær€¢66÷VçDÖF6€¢æÖævVD66÷VçD–@¢’b`¢—FVÒæ7W7FöÖW$66÷VçD–Bb`¢76–væÖVçEF–ÖT6öçF–ç46†V6¶÷WB€¢—FVÒÀ¢6†V6¶÷WD@¢¢¢ç6÷'B€¢†Æ"’Óà¢æWrFFR€¢"ç7F'G4BÇÀ¢"æ7&VFVDBÇÀ¢ ¢’ævWEF–ÖR‚’Ð¢æWrFFR€¢ç7F'G4BÇÀ¢æ7&VFVDBÇÀ¢ ¢’ævWEF–ÖR‚¢•³ÒÇÀ¢çVÆÃ° ¢–b‚76–væÖVçB’°¢VæÖF6†VB³Ò°¢–b†v—B&V6÷&D6öÖ×Væ—G•7V66W746†V6¶÷WB†÷&FW"’’6fVB³Ò°¢WFFU6fU&öw&W72‚“°¢6öçF–çVS°¢Ð ¢6öç7B&WF–ÆW$¶W’Ð¢7G&–ær€¢÷&FW"ç&WF–ÆW"ÇÀ¢66÷VçDÖF6‚ç&WF–ÆW"ÇÀ¢'&WF–ÆW" ¢¢çG&–Ò‚¢çFôÆ÷vW$66R‚¢ç&WÆ6R€¢õµæ×£Ó•Ò²örÀ¢"Ò ¢“° ¢6öç7B÷&FW$¶W’Ð¢7G&–ær€¢÷&FW"æ÷&FW$çVÖ&W"ÇÀ¢÷&FW"æÖW76vT–BÇÀ¢÷&FW"æÖ–Æ&÷…V–BÇÀ¢" ¢“° ¢–b‚÷&FW$¶W’’°¢VæÖF6†VB³Ò°¢WFFU6fU&öw&W72‚“°¢6öçF–çVS°¢Ð ¢6öç7B7F&ÆT–BÐ¢G·&WF–ÆW$¶W—Ó¦ÖævVC¢G¶66÷VçDÖF6‚æÖævVD66÷VçD–GÓ¢G¶÷&FW$¶W—Ö° ¢6öç7B7V66W75&V6÷&BÒ°¢–C ¢7F&ÆT–BÀ ¢7W7FöÖW$66÷VçD–C ¢7G&–ær€¢76–væÖVç@¢æ7W7FöÖW$66÷VçD–@¢’À ¢ÖævVD66÷VçD–C ¢7G&–ær€¢66÷VçDÖF6€¢æÖævVD66÷VçD–@¢’À ¢ÖævVD76–væÖVçD–C ¢7G&–ær€¢76–væÖVçBæ–@¢’À ¢ÖævVD76–væÖVçEG—S ¢76–væÖVç@¢æ76–væÖVçEG—RÀ ¢&öf–ÆTæÖS ¢76–væÖVç@¢æ76–væÖVçEG—RÓÓÐ¢&v–gFVB ¢ò$v–gFVB&öf–ÆR ¢¢%&VçFVB&öf–ÆR"À ¢&WF–ÆW# ¢÷&FW"ç&WF–ÆW"ÇÀ¢66÷VçDÖF6‚ç&WF–ÆW"ÇÀ¢%&WF–ÆW""À ¢÷&FW$çVÖ&W# ¢÷&FW"æ÷&FW$çVÖ&W"À ¢6†V6¶÷WDBÀ ¢÷&FW%F÷FÃ ¢÷&FW"æ÷&FW%F÷FÂÀ ¢—FVÔ6÷VçC ¢÷&FW"æ—FVÔ6÷VçBÀ ¢—FV×3 ¢÷&FW"æ—FV×2À ¢7FGW3 ¢&6öæf—&ÖVB"À ¢6÷W&6S ¢ÖævVB×v÷&²ÖÖ–Æ&÷‚ÒG·&WF–ÆW$¶W—Ö ¢Ó° ¢6öç7B6†V6¶÷WDvRÒFFRææ÷r‚’ÒæWrFFR†6†V6¶÷WDB’ævWEF–ÖR‚“°¢6öç7Bv56fVBÒv—B&V6÷&E7V66W746†V6¶÷WB‡7V66W75&V6÷&BÂ°¢æ÷F–g”F—66÷&C¢çVÖ&W"æ—4f–æ—FR†6†V6¶÷WDvR’bb6†V6¶÷WDvRãÒbb6†V6¶÷WDvRÂ¢c¢ ¢Ò“° ¢–b‡v56fVB’°¢6fVB³Ò°¢Ð¢WFFU6fU&öw&W72‚“°¢Ð ¢–b‡&W7VÇBæÆ7EV–B’°¢ÖævVE7V66W74Æ7E66ææVEV–BÒÖF‚æÖ‚†ÖævVE7V66W74Æ7E66ææVEV–BÂ&W7VÇBæÆ7EV–B“°¢Ð ¢&WGW&â°¢6öæf–wW&VC ¢G'VRÀ¢6fVBÀ¢VæÖF6†VBÀ¢66ææVC ¢&W7VÇBæ÷&FW'2æÆVæwF€¢Ó°§Ð  ¦7–æ2gVæ7F–öâ7–æ4ÆÄ7F—fT7W7FöÖW%7V66W72‚’°¢–b€¢Æ—fU7V66W747–6ÆU'Vææ–æp¢’°¢&WGW&ã°¢Ð ¢Æ—fU7V66W747–6ÆU'Vææ–ærÐ¢G'VS° ¢G'’°¢6öç7B–BÐ¢v—B&VD§6öâ€¢”Eôd”ÄRÀ¢µÐ¢“° ¢6öç7B–E&V6÷&G2Ð¢'&’æ—4'&’‡–B¢ò–@¢¢µÓ° ¢6öç7B66÷VçD–G2Ð¢°¢ââææWr6WB€¢–E&V6÷&G0¢æf–ÇFW"€¢&V6÷&BÓà¢&V6÷&Bæ7W7FöÖW$66÷VçD–Bb`¢7V'67&—F–öäÆÆ÷w5&öf–ÆW2€¢&V6÷&@¢¢¢æÖ€¢&V6÷&BÓà¢7G&–ær€¢&V6÷&Bæ7W7FöÖW$66÷VçD–@¢¢¢¢Ó° ¢ò ¢6WVVçF–ÂÖ–Æ&÷‚6öææV7F–öç2&R–çFVçF–öæÂà¢F†W’fö–B7&VF–ærÆ&vR'W'7Böb6–×VÇFæV÷W0¢”ÔÆöv–ç2v†VâF†R6—FR†2Öç’7W7FöÖW'2à¢¢ð¢f÷"€¢6öç7B66÷VçD–Bö`¢66÷VçD–G0¢’°¢v—B7–æ47W7FöÖW%F&vWE7V66W72€¢66÷VçD–@¢“°¢Ð ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$Æ—fR7V66W727–æ27–6ÆRf–ÆVC¢"À¢W'&÷#òæ6öFRÇÀ¢W'&÷#òææÖRÇÀ¢'7V66W75÷7–æ5ö7–6ÆUöW'&÷" ¢“° ¢Òf–æÆÇ’°¢Æ—fU7V66W747–6ÆU'Vææ–ærÐ¢fÇ6S°¢Ð§Ð ¢ò¢¶VWF†RÖævVBÖ–Æ&÷‚öâ—G2÷vâ66†VGVÆR6ò7W7FöÖW"–æ&÷‚66ç0¢6ææ÷BFVÆ’—G2f—'7B'Vââ6öæ7W'&VçBÖçVÂæB66†VGVÆVB66ç26†&P¢öæR6öææV7F–öâæBöæR–×÷'B72â¢ð¦gVæ7F–öâ'VäÖævVE7V66W7566â‚’°¢–b†ÖævVE7V66W7566å&öÖ—6R’&WGW&âÖævVE7V66W7566å&öÖ—6S°¢ÖævVE7V66W7566å7FGW2æÆ7DGFV×DBÒæWrFFR‚’çFô•4õ7G&–ær‚“°¢ÖævVE7V66W7566å7FGW2æÆ7DW'&÷"ÒçVÆÃ°¢ÖævVE7V66W7566å7FGW2ç&öw&W72Ò²†6S¢&6öææV7F–ær"ÂW&6VçC¢Â&ö6W76VC¢ÂF÷FÃ¢Â&V6övæ—¦VC¢Â6fVC¢Ó°¢ÖævVE7V66W7566å&öÖ—6RÒ†7–æ2‚’Óâ°¢G'’°¢6öç7B&W7VÇBÒv—B7–æ4ÖævVE&öf–ÆU7V66W74Ö–Æ&÷‚‚“°¢ÖævVE7V66W7566å7FGW2æÆ7D6ö×ÆWFVDBÒæWrFFR‚’çFô•4õ7G&–ær‚“°¢ÖævVE7V66W7566å7FGW2ç'6VD÷&FW'2Ò&W7VÇBç66ææVBÇÂ°¢ÖævVE7V66W7566å7FGW2ç6fVD÷&FW'2Ò&W7VÇBç6fVBÇÂ°¢ÖævVE7V66W7566å7FGW2çVæÖF6†VD÷&FW'2Ò&W7VÇBçVæÖF6†VBÇÂ°¢ÖævVE7V66W7566å7FGW2ç&öw&W72Ò²†6S¢&6ö×ÆWFR"ÂW&6VçC¢Â&ö6W76VC¢&W7VÇBç66ææVBÇÂÂF÷FÃ¢&W7VÇBç66ææVBÇÂÂ&V6övæ—¦VC¢&W7VÇBç66ææVBÇÂÂ6fVC¢&W7VÇBç6fVBÇÂÓ°¢&WGW&â&W7VÇC°¢Ò6F6‚†W'&÷"’°¢ÖævVE7V66W7566å7FGW2æÆ7DW'&÷"ÒW'&÷#òæWF†VçF–6F–öäf–ÆVBÇÀ¢W'&÷#òæ6öFRÓÓÒ$UD„TåD”4D”ôäd”ÄTB"ò&WF†VçF–6F–öåöf–ÆVB"¢'66åöf–ÆVB#°¢ÖævVE7V66W7566å7FGW2ç&öw&W72Ò²ââæÖævVE7V66W7566å7FGW2ç&öw&W72Â†6S¢&f–ÆVB"ÂW&6VçC¢çVÆÂÓ°¢6öç6öÆRæW'&÷"‚$ÖævVB7V66W72Ö–Æ&÷‚66âf–ÆVC¢"ÂW'&÷#òæ6öFRÇÂW'&÷#òææÖRÇÂ'66åöW'&÷""“°¢F‡&÷rW'&÷#°¢Òf–æÆÇ’°¢ÖævVE7V66W7566å&öÖ—6RÒçVÆÃ°¢Ð¢Ò’‚“°¢&WGW&âÖævVE7V66W7566å&öÖ—6S°§Ð  ¦gVæ7F–öâ7F'DÆ—fU7V66W7566†VGVÆW"‚’°¢ò ¢7F'B6†÷'FÇ’gFW"&ö÷B6ò–æ—F–Æ—¦F–öâf–æ—6†W0¢f—'7BÂF†Vâ66âWfW'’6öæf–wW&VB–çFW'fÂà¢¢ð¢6öç7Bf—'7E'VâÐ¢6WEF–ÖV÷WB€¢‚’Óâ°¢7–æ4ÆÄ7F—fT7W7FöÖW%7V66W72‚¢æ6F6‚‚‚’Óâ·Ò“°¢'VäÖævVE7V66W7566â‚’æ6F6‚‚‚’Óâ·Ò“° ¢&V6öæ6–ÆTÆ6VDÖVÖ&W'6†—æ÷F–f–6F–öç2‚¢æ6F6‚‚‚’Óâ·Ò“°¢ÒÀ¢#¢ ¢“° ¢–b€¢G—Vöbf—'7E'VâçVç&VbÓÓÐ¢&gVæ7F–öâ ¢’°¢f—'7E'VâçVç&Vb‚“°¢Ð ¢6öç7B–çFW'fÂÐ¢6WD–çFW'fÂ€¢‚’Óâ°¢7–æ4ÆÄ7F—fT7W7FöÖW%7V66W72‚¢æ6F6‚‚‚’Óâ·Ò“°¢'VäÖævVE7V66W7566â‚’æ6F6‚‚‚’Óâ·Ò“° ¢&V6öæ6–ÆTÆ6VDÖVÖ&W'6†—æ÷F–f–6F–öç2‚¢æ6F6‚‚‚’Óâ·Ò“°¢ÒÀ¢Ä•dUõ5T44U55õ5”ä5ô”åDU%dÅôÕ0¢“° ¢–b€¢G—Vöb–çFW'fÂçVç&VbÓÓÐ¢&gVæ7F–öâ ¢’°¢–çFW'fÂçVç&Vb‚“°¢Ð§Ð     ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢DÔ”â4õ5D4ò%4U"DU5@¢F–væ÷7F–2öæÇ“¢&VG2F†RÆFW7B6÷7F6ò6öæf—&ÖF–öà¢g&öÒ”ÔõDU5EôTÔ”ÂæBFöW2æ÷B6fR&öGV7F–öâFFà¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒ¢ð ¦ævWB€¢"ö’öFÖ–â÷FW7BÖ–Öö6÷7F6òÖ÷&FW""À¢&WV—&TFÖ–âÀ¢7–æ2‡&WÂ&W2’Óâ°¢&W2ç6WD†VFW"€¢$66†RÔ6öçG&öÂ"À¢&æò×7F÷&R ¢“° ¢G'’°¢6öç7BVÖ–ÂÐ¢æ÷&ÖÆ—¦TVÖ–Â€¢&ö6W72æVç`¢ä”ÔõDU5EôTÔ”À¢“° ¢6öç7B77v÷&BÐ¢7G&–ær€¢&ö6W72æVç`¢ä”ÔõDU5Eõ55tõ$BÇÀ¢" ¢“° ¢–b€¢VÖ–ÂÇÀ¢77v÷&@¢’°¢&WGW&â&W0¢ç7FGW2ƒS¢æ§6öâ‡°¢ö³¢fÇ6RÀ¢W'&÷# ¢$”ÔFW7B7&VFVçF–Ç2&Ræ÷B6öæf–wW&VBâ ¢Ò“°¢Ð ¢6öç7B&W7VÇBÐ¢v—B&VE&V6VçE&WF–ÆW$÷&FW'2€¢VÖ–ÂÀ¢77v÷&BÀ¢# ¢“° ¢6öç7B6÷7F6ô÷&FW'2Ð¢&W7VÇBæ÷&FW'0¢æf–ÇFW"€¢÷&FW"Óà¢7G&–ær€¢÷&FW#òç&WF–ÆW"ÇÀ¢" ¢’çFôÆ÷vW$66R‚’ÓÓÐ¢&6÷7F6ò ¢“° ¢6öç7B÷&FW"Ð¢6÷7F6ô÷&FW'2æB‚Ó’ÇÀ¢çVÆÃ° ¢–b‚÷&FW"’°¢&WGW&â&W0¢ç7FGW2ƒCB¢æ§6öâ‡°¢ö³¢fÇ6RÀ¢ÖF6†VC ¢fÇ6RÀ¢W'&÷# ¢$æò6÷7F6ò÷&FW"6öæf—&ÖF–öâv2f÷VæB–âF†R&V6VçBFW7BÖ–Æ&÷‚ÖW76vW2â ¢Ò“°¢Ð ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢ÖF6†VC ¢G'VRÀ¢&÷f–FW# ¢&W7VÇBç&÷f–FW"À ¢÷&FW#¢°¢&WF–ÆW# ¢÷&FW"ç&WF–ÆW"À¢÷&FW$çVÖ&W# ¢÷&FW"æ÷&FW$çVÖ&W"À¢6†V6¶÷WDC ¢÷&FW"æ6†V6¶÷WDBÀ¢—FVÔ6÷VçC ¢÷&FW"æ—FVÔ6÷VçBÀ¢÷&FW%F÷FÃ ¢÷&FW"æ÷&FW%F÷FÂÀ¢—FV×3 ¢÷&FW"æ—FV×0¢Ð¢Ò“° ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$6÷7F6ò'6W"F–væ÷7F–2f–ÆVC¢"À¢W'&÷#òæ6öFRÇÀ¢W'&÷#òææÖRÇÀ¢&6÷7F6õ÷'6W%öW'&÷" ¢“° ¢&WGW&â&W0¢ç7FGW2ƒS"¢æ§6öâ‡°¢ö³¢fÇ6RÀ¢W'&÷# ¢%F†R6÷7F6òFW7B÷&FW"6÷VÆBæ÷B&R'6VBâ ¢Ò“°¢Ð¢Ð¢“°  ¢ò¢ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢DÔ”â´2%4U"DU5@¢F–vÛjÇºã
âµç«®ŠÁ®‰ž˜©zostic only: reads the latest Pokemon Center
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

          <!-- RETAILER LOGO â€” SHOULD NOT MATCH PRODUCT -->

          <img
            src="https://placehold.co/600x150.png?text=TARGET"
            alt="Target"
            width="600"
            height="150"
          >


          <!-- TRACKING PIXEL â€” SHOULD BE REMOVED -->

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
          dataDir: DATA_DIR,
          aiKey: String(process.env.OPENAI_API_KEY || "").trim()
        });
        if (discordSuccessConfig().token && discordSuccessConfig().channelId) {
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
