// Export the fields of each selected retailer profile into its target import format.
// This module is used only by the existing authenticated Admin download endpoint.
// Never log or persist generated payment-bearing files on the server.
import { randomUUID } from "node:crypto";

export const TARGET_CSV_COLUMNS = [
  "profile_name","first_name","last_name","email","phone_num",
  "cc_number","cc_exp_month","cc_exp_year","cc_cvv",
  "shipping_street","shipping_street_2","shipping_city","shipping_state",
  "shipping_zip_code","shipping_country","billing_first_name",
  "billing_last_name","billing_street","billing_street_2","billing_city",
  "billing_state","billing_zip_code","billing_country"
];
const STATE_NAMES = {
  AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",
  CO:"Colorado",CT:"Connecticut",DE:"Delaware",FL:"Florida",GA:"Georgia",
  HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",
  KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",
  MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",
  MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",
  NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",
  OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",
  SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",
  VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming",
  DC:"District of Columbia"
};
const countryCode = value => /^(us|usa|united states|united states of america)$/i.test(String(value || "US")) ? "US" : String(value).toUpperCase();
const stateName = value => STATE_NAMES[String(value || "").toUpperCase()] || String(value || "");
const stateCode = value => Object.entries(STATE_NAMES).find(([,name]) => name.toLowerCase() === String(value || "").toLowerCase())?.[0] || String(value || "").toUpperCase();
const digits = value => String(value ?? "").replace(/\D/g, "");
const detectCardType = number => {
  if (/^3[47]/.test(number)) return "amex";
  if (/^(5[1-5]|2[2-7])/.test(number)) return "mastercard";
  if (/^4/.test(number)) return "visa";
  if (/^(6011|65|64[4-9])/.test(number)) return "discover";
  return "";
};
function paymentFromProfile(profile) {
  const details = profile?.cardInfo || {};
  const number = digits(details.cardNumber);
  const holder = String(details.holder || "").trim();
  const expMonth = String(details.expMonth ?? "").trim().padStart(2, "0");
  const expYear = String(details.expYear ?? "").trim();
  const cvv = String(details.cvv ?? "").trim();
  if (!/^\d{12,19}$/.test(number) || !holder ||
      !/^(0[1-9]|1[0-2])$/.test(expMonth) || !/^\d{4}$/.test(expYear) ||
      !/^\d{3,4}$/.test(cvv)) {
    // Avoid logging PAN/CVV or identifying a customer in error messages.
    throw new Error("A selected profile has incomplete payment details; export stopped.");
  }
  return { number, holder, expMonth, expYear, cvv, type: detectCardType(number) };
}
const csv = value => {
  let s = String(value ?? "");
  if (/^\s*[=+@-]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
};

/**
 * Profiles were validated by the authenticated Admin endpoint. The payloads
 * contain payment credentials; only return them as an attachment with no-store.
 * No retailer password is included.
 */
export function buildSafeRetailerProfileExport(retailer, profiles) {
  if (!Array.isArray(profiles)) throw new TypeError("Invalid profile collection.");
  if (retailer === "target") {
    const lines = profiles.map(item => {
      const s = item.shipping || {}, card = paymentFromProfile(item);
      return [item.name, s.firstName, s.lastName, s.email,
        digits(s.phone), card.number, Number(card.expMonth), card.expYear, card.cvv,
        s.address, s.address2, s.city, stateCode(s.state), s.zipCode,
        countryCode(s.country), "", "", "", "", "", "", "", ""].map(csv).join(",");
    });
    return { extension: ".csv", contentType: "text/csv; charset=utf-8",
      body: TARGET_CSV_COLUMNS.join(",") + "\r\n" + lines.join("\r\n") + (lines.length ? "\r\n" : ""),
      excludesPaymentDetails: false };
  }
  if (!["walmart", "pkc"].includes(retailer)) throw new Error("Unsupported retailer.");
  const data = {};
  for (const item of profiles) {
    const s = item.shipping || {}, card = paymentFromProfile(item);
    const id = randomUUID();
    const country = countryCode(s.country);
    const address = {
      firstName: String(s.firstName || ""), lastName: String(s.lastName || ""),
      addressLine1: String(s.address || ""), addressLine2: String(s.address2 || ""),
      city: String(s.city || ""), countryName: country === "US" ? "United States" : String(s.country || ""),
      countryCode: country, state: stateName(s.state), zipCode: String(s.zipCode || "")
    };
    data[id] = {
      name: String(item.name || ""), email: String(s.email || ""),
      phoneNumber: String(s.phone || ""), billingSameAsShipping: true,
      oneCheckout: false, quickTask: false,
      card: { holder: card.holder, number: card.number,
        expiration: `${card.expMonth}/${card.expYear.slice(-2)}`,
        cvv: card.cvv, type: card.type },
      shipping: address, billing: { ...address }, id, totalSpent: 0
    };
  }
  return { extension: ".json", contentType: "application/json; charset=utf-8",
    body: JSON.stringify(data, null, 2), excludesPaymentDetails: false };
}
