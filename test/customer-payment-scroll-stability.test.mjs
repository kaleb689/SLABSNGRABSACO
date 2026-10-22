import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const app=readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
const start=app.indexOf('document.getElementById("saved-payment-form")\n  ?.addEventListener("submit"');
const end=app.indexOf('document.getElementById("delete-saved-address")',start);
const handler=app.slice(start,end);
test("customer payment submit retains the form position and clears sensitive inputs after a confirmed save",()=>{
 assert.ok(start>0&&end>start);
 assert.doesNotMatch(handler,/form\.hidden\s*=\s*true/);
 assert.match(handler,/await loadSavedDetails\(\)/);
 assert.match(handler,/fillSavedPaymentForm\(savedPaymentById\(savedId\)\)/);
 assert.match(app,/form\.elements\.acoCardNumber\.value = ""/);
 assert.match(app,/form\.elements\.securityCode\.value = ""/);
});
test("stale revisions preserve the form rather than silently replacing inputs",()=>{
 assert.match(handler,/response\.status === 409 \|\| response\.status === 428/);
 assert.match(handler,/unsaved fields have not been discarded/);
 assert.match(handler,/body\.expectedRevision = form\.dataset\.expectedRevision/);
 assert.doesNotMatch(handler,/await loadSavedDetails\(\);\s*throw new Error/);
});
test("customer payment save never calls scrollTo or scrollIntoView",()=>{
 assert.doesNotMatch(handler,/scrollIntoView\(|scrollTo\(|location\.reload\(/);
 assert.match(handler,/method: id \? "PUT" : "POST"/);
 assert.match(handler,/if \(!response\.ok\)/);
});
