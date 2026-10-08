// Match retailer import templates without disclosing payment account data.
// Payment numbers and security codes are intentionally NOT placed in exports.
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
const csv = value => {
  let s = String(value ?? "");
  if (/^\s*[=+@-]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
};

/**
 * Profiles are already validated by the existing authenticated Admin endpoint.
 * Never include account PAN, expiry, CVV, or stored login passwords in downloads.
 */
export function buildSafeRetailerProfileExport(retailer, profiles) {
  if (!Array.isArray(profiles)) throw new TypeError("Invalid profile collection.");
  if (retailer === "target") {
    const lines = profiles.map(item => {
      const s = item.shipping || {};
      return [item.name, s.firstName, s.lastName, s.email,
        String(s.phone || "").replace(/\D/g, ""), "", "", "", "",
        s.address, s.address2, s.city, stateCode(s.state), s.zipCode,
        countryCode(s.country), "", "", "", "", "", "", "", ""].map(csv).join(",");
    });
    return { extension: ".csv", contentType: "text/csv; charset=utf-8",
      body: TARGET_CSV_COLUMNS.join(",") + "\r\n" + lines.join("\r\n") + (lines.length ? "\r\n" : ""),
      excludesPaymentDetails: true };
  }
  if (!["walmart", "pkc"].includes(retailer)) throw new Error("Unsupported retailer.");
  const data = {};
  for (const item of profiles) {
    const s = item.shipping || {};
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
      card: { holder: "", number: "", expiration: "", cvv: "", type: "" },
      shipping: address, billing: { ...address }, id, totalSpent: 0
    };
  }
  return { extension: ".json", contentType: "application/json; charset=utf-8",
    body: JSON.stringify(data, null, 2), excludesPaymentDetails: true };
}
