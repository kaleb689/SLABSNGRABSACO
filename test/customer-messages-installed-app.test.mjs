import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const dashboard=readFileSync(new URL("../public/app-dashboard.js",import.meta.url),"utf8");
const css=readFileSync(new URL("../public/app-dashboard.css",import.meta.url),"utf8");
const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const ui=readFileSync(new URL("../public/customer-messages-ui.js",import.meta.url),"utf8");
const worker=readFileSync(new URL("../public/sw.js",import.meta.url),"utf8");
const backend=readFileSync(new URL("../server.js",import.meta.url),"utf8");

test("Installed standalone app has a seventh Messages nav item and correct deep link",()=>{
 assert.match(dashboard,/messages:\s*'Messages'/);
 assert.match(dashboard,/concat\('messages'\)\.map\(/);
 assert.match(dashboard,/messages:\s*'messages'/);
 assert.match(dashboard,/data-app-view/);
 assert.match(dashboard,/view === 'messages'/);
 assert.match(dashboard,/setView\(next/);
 assert.match(dashboard,/document\.querySelector\('button\[data-account-tab="messages"\]'\)\?\.click\(\)/);
 assert.match(dashboard,/sng-app-message-unread/);
 assert.match(worker,/"messages"/);
});

test("Installed app reveals existing private account-scoped message panel, not a second inbox",()=>{
 assert.match(css,/not\(\[data-app-view="messages"\]\)/);
 assert.match(css,/\[data-app-view="messages"\] #customer-dashboard > :not\(#account-tab-messages\)/);
 assert.match(css,/\[data-app-view="messages"\] #account-tab-messages:not\(\[hidden\]\)/);
 assert.match(css,/grid-template-columns:repeat\(7,minmax\(0,1fr\)\)/);
 assert.match(html,/id="account-tab-messages"/);
 assert.match(html,/id="customer-message-form"/);
 assert.match(html,/data-account-tab="messages"/);
 assert.match(ui,/const active=\(\)=>signedIn\(\)&&!panel\.hidden/);
 assert.match(ui,/\/api\/account\/messages/);
 assert.doesNotMatch(dashboard,/\/api\/account\/support\/messages/);
 assert.match(backend,/registerCustomerMessages\(app/);
});

test("Unread counter and deep-linked reply route reach Messages rather than other accounts",()=>{
 assert.match(dashboard,/customer-message-unread-changed/);
 assert.match(dashboard,/account-messages-unread/);
 assert.match(dashboard,/view === 'messages'\)\s*document\.querySelector/);
 assert.match(html,/app-dashboard\.js\?v=20261115-messages-installed-1/);
 assert.match(html,/app-dashboard\.css\?v=20261115-messages-installed-1/);
 assert.match(worker,/appTab=\$\{tab\}/);
});
