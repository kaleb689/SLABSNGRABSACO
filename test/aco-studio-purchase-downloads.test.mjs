import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const source=readFileSync(new URL("../private-studio-license.js",import.meta.url),"utf8");
const html=readFileSync(new URL("../public/aco-studio-downloads.html",import.meta.url),"utf8");
const client=readFileSync(new URL("../public/aco-studio-downloads.js",import.meta.url),"utf8");
test("successful subscriptions redirect to the dedicated download page",()=>{
 assert.match(source,/success_url: baseUrl \+ "\/aco-studio-downloads\.html\?session_id=\{CHECKOUT_SESSION_ID\}"/);
 assert.match(source,/Download the Mac or Windows app from " \+ baseUrl \+ "\/aco-studio-downloads\.html"/);
 assert.match(source,/client_reference_id: String\(account\.id\)/);
 assert.match(source,/requireCustomer, async \(req, res\) =>/);
 assert.match(source,/subscriptionEntitled\(verified\)/);
});
test("downloads are gated by verified account license, not a payment query string",()=>{
 assert.match(client,/\/api\/account\/studio-private\/claim/);
 assert.match(client,/\/api\/account\/studio-private\/license/);
 assert.match(client,/\.find\(x=>x\.active&&x\.licenseKey\)/);
 assert.match(client,/ready\.hidden=false/);
 assert.match(client,/if\(!row\)/);
 assert.doesNotMatch(html,/ACO\.STUDIO-1\.0\.3.*\.exe/);
 assert.match(html,/aco-studio-downloads\.js/);
});
test("installer links are separate and point to published customer release, never owner version",()=>{
 for(const f of ["ACO.STUDIO-1.0.4-arm64.dmg","ACO.STUDIO-1.0.4.dmg","ACO.STUDIO.Setup.1.0.4.exe"])assert.ok(client.includes(f),f);
 assert.match(client,/aco-studio-v1\.0\.4-preview/);
 assert.doesNotMatch(client,/aco-studio-v4/);
});
