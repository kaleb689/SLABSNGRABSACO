import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = filename => fs.readFileSync(new URL("../" + filename, import.meta.url), "utf8");
test("age declaration is required before signup and submitted to server", () => {
 const html=read("public/index.html"),app=read("public/app.js"),server=read("server.js");
 assert.match(html,/<input type="checkbox" name="age18Confirmed" required\s*\/>/);
 assert.match(html,/I confirm I am 18 or older\./);
 assert.match(app,/age18Confirmed:\s*data\.age18Confirmed === "on"/);
 assert.match(server,/req\.body\?\.age18Confirmed !== true/);
 assert.match(server,/age18ConfirmedAt: now/);
 assert.match(server,/age18ConfirmationVersion: SIGNUP_AGE_CONFIRMATION_VERSION/);
});
test("owner can search the permanent age declaration and find its membership checkout",()=>{
 const html=read("public/admin.html"),server=read("server.js");
 assert.match(html,/id="signupConsentSearch"/);
 assert.match(html,/item\.age18Confirmed === true/);
 assert.match(html,/item\.signupAgeConfirmation\?\.consentRecordId/);
 assert.match(server,/signupAgeConfirmation: \{/);
 assert.match(server,/signupAgeConsentRecordId:/);
 assert.match(server,/const search = String\(req\.query\.search \|\| ""\)/);
});
