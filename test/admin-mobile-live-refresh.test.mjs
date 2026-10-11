import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const mobileSource = fs.readFileSync(
  new URL("../public/admin-mobile.js", import.meta.url), "utf8"
);

function createMobileHarness() {
  const elements = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const streams = [];
  const pendingTimers = new Map();
  const requests = [];
  const scrolls = [];
  let nextTimer = 0;

  function node(id) {
    if (!elements.has(id)) {
      const listeners = new Map();
      elements.set(id, {
        id, hidden: false, textContent: "", innerHTML: "", value: "", disabled: false,
        style: {}, dataset: {}, listeners,
        classList: { toggle: () => {} },
        addEventListener(name, callback) { listeners.set(name, callback); },
        querySelectorAll() { return []; },
        querySelector() { return null; },
        closest(selector) { return selector === "#workspace" ? node("workspace") : null; },
        matches(selector) { return selector.includes("input"); }
      });
    }
    return elements.get(id);
  }

  const document = {
    hidden: false, activeElement: null,
    getElementById: node,
    querySelectorAll: () => [],
    addEventListener(name, callback) { documentListeners.set(name, callback); }
  };
  const window = {
    scrollX: 14, scrollY: 44,
    addEventListener(name, callback) { windowListeners.set(name, callback); },
    scrollTo(x, y) { scrolls.push([x, y]); }
  };
  const fixtures = {
    "/api/admin/submissions": { submissions: [
      { id: "order1", customerAccountId: "user1", profile: { firstName: "Amy", email: "amy@example.test" } }
    ] },
    "/api/admin/free-submissions": [],
    "/api/admin/profile-activation-tracker": { customers: [] },
    "/api/managed-availability": {},
    "/api/admin/app-usage": {}
  };
  class EventSource {
    constructor(url) { this.url = url; this.callbacks = new Map(); streams.push(this); }
    addEventListener(name, callback) { this.callbacks.set(name, callback); }
    close() { this.closed = true; }
    emit(name) { this.callbacks.get(name)?.(); }
  }
  const sandbox = {
    document, window, navigator: {}, EventSource,
    fetch: async path => {
      requests.push(path);
      return { status: 200, ok: true, json: async () => fixtures[path] || {} };
    },
    setTimeout: callback => {
      const id = ++nextTimer;
      pendingTimers.set(id, callback);
      return id;
    },
    clearTimeout: id => pendingTimers.delete(id),
    setInterval: () => 99,
    requestAnimationFrame: callback => callback(),
    console,
    alert: () => {},
    confirm: () => true
  };
  vm.runInNewContext(mobileSource, sandbox, { filename: "admin-mobile.js" });

  async function settle() {
    for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  }
  async function flushTimers() {
    const callbacks = [...pendingTimers.values()];
    pendingTimers.clear();
    for (const callback of callbacks) callback();
    await settle();
  }
  return { node, document, window, fixtures, streams, requests, scrolls, settle, flushTimers,
    onDocument(name) { return documentListeners.get(name); } };
}

test("mobile Admin automatically syncs without interrupting a focused customer search", async () => {
  const h = createMobileHarness();
  await h.settle();
  assert.equal(h.requests.length, 7, "initial dashboard fetched paid and registered customers plus management sources");
  assert.equal(h.streams.length, 1, "one live connection established");
  assert.equal(h.streams[0].url, "/api/admin/live/events");

  h.node("tabs").listeners.get("click")({
    target: { closest: () => ({ dataset: { tab: "customers" } }) }
  });
  const search = h.node("customer-search");
  search.value = "amy@example";
  search.listeners.get("input")();
  assert.match(h.node("customer-results").innerHTML, /Amy/);

  h.document.activeElement = search;
  h.streams[0].emit("data-change");
  await h.flushTimers();
  assert.equal(h.requests.length, 7, "live event cannot overwrite focused form");

  h.document.activeElement = null;
  h.onDocument("focusout")();
  await h.flushTimers();
  assert.equal(h.requests.length, 14, "pending event reloads when input loses focus");
  assert.equal(search.value, "amy@example", "customer search text survives rerender");
  assert.match(h.node("customer-results").innerHTML, /Amy/);
  assert.ok(h.scrolls.some(([x,y]) => x === 14 && y === 44), "scroll restored");
});

test("mobile Admin reconnects and retains same tab, with periodic catchup and forced refresh", async () => {
  const h = createMobileHarness();
  await h.settle();
  const stream = h.streams[0];
  stream.emit("open");
  await h.flushTimers();
  assert.equal(h.requests.length, 14, "stream reconnection refreshes data");
  h.node("refresh").onclick();
  await h.settle();
  assert.equal(h.requests.length, 21, "manual refresh runs immediately");
  assert.match(mobileSource, /setInterval\(\(\)=>\{if\(authenticated&&!document\.hidden\)scheduleMobileRefresh\(\);\},60000\)/);
  assert.match(mobileSource, /window\.addEventListener\("pagehide",\(\)=>\{stream\?\.close\(\);stream=null;\}\)/);
  assert.match(mobileSource, /mobileRefreshRunning=false/);
  assert.match(mobileSource, /mobileRefreshPending=true/);
});

test("new website signup updates mobile Admin across Success, Home, Customers and Profiles without refresh", async () => {
  const h = createMobileHarness();
  await h.settle();
  assert.equal(h.node("content").innerHTML.includes("jill@example.test"), false);
  assert.match(h.node("content").innerHTML, /Registered customers/);
  const click = h.node("tabs").listeners.get("click");
  click({target: {closest: () => ({dataset: {tab: "success"}})}});
  // A newly created account is initially in /free-submissions, not paid orders.
  h.fixtures["/api/admin/free-submissions"] = [{
    id: "new-account", customerAccountId: "new-account", accountOnly: true,
    createdAt: "2026-10-10T12:30:00.000Z",
    profile: {firstName: "Jill", lastName: "New", email: "jill@example.test"},
    plan: {name: "No Paid Membership", profiles: 0}
  }];
  const requestsBeforeSignup = h.requests.length;
  h.streams[0].emit("data-change");
  await h.flushTimers();
  assert.equal(h.requests.length, requestsBeforeSignup + 7,
    "all seven sources fetched even while viewing Success");
  click({target: {closest: () => ({dataset: {tab: "overview"}})}});
  assert.doesNotMatch(h.node("content").innerHTML, /Latest website signups/);
  assert.match(h.node("content").innerHTML, /Registered customers<\/small><strong>2<\/strong>/);
  click({target: {closest: () => ({dataset: {tab: "customers"}})}});
  assert.match(h.node("customer-results").innerHTML, /Jill New/);
  assert.match(h.node("customer-results").innerHTML, /No paid membership/);
  click({target: {closest: () => ({dataset: {tab: "profiles"}})}});
  assert.match(h.node("content").innerHTML, /Registered customers/);
  assert.ok(h.requests.includes("/api/admin/free-submissions"));
});

test("newly paid website accounts are not double-counted when snapshots overlap", async () => {
  const h = createMobileHarness();
  h.fixtures["/api/admin/free-submissions"] = [{
    id:"order1", customerAccountId:"user1", accountOnly:true,
    profile:{firstName:"Amy",email:"amy@example.test"}
  }];
  await h.settle();
  // Same customer exists in both API responses temporarily. The paid state wins.
  assert.match(h.node("content").innerHTML, /Registered customers/);
  assert.doesNotMatch(h.node("content").innerHTML, /New signups · no plan<\/small><strong>1<\/strong>/);
  assert.doesNotMatch(h.node("content").innerHTML, /Paid customers<\/small>/);
});


test("internal fake admin and kalebmatthews04 are excluded from customer counts and directory", async () => {
  const h = createMobileHarness();
  h.fixtures["/api/admin/free-submissions"] = [
    { id: "internal-test", customerAccountId: "internal-test", accountOnly: true,
      profile: { firstName: "Fake", lastName: "Admin", email: "testing@example.test" } },
    { id: "owner-test", customerAccountId: "owner-test", accountOnly: true,
      profile: { firstName: "Owner", email: "kalebmatthews04@example.test" } },
    { id: "real-signup", customerAccountId: "real-signup", accountOnly: true,
      profile: { firstName: "Jill", lastName: "Real", email: "jill.real@example.test" } }
  ];
  await h.settle();
  const home = h.node("content").innerHTML;
  assert.ok(home.includes("Registered customers</small><strong>2</strong>"),
    "Home registration card should count only Amy and Jill");
  assert.ok(home.includes("<small>CUSTOMERS</small><b>2</b>"),
    "all-time customer figure should use the same count");
  const click = h.node("tabs").listeners.get("click");
  click({ target: { closest: () => ({ dataset: { tab: "customers" } }) } });
  assert.ok(h.node("content").innerHTML.includes("2 registered customers · 1 without a paid membership"));
  const rows = h.node("customer-results").innerHTML;
  assert.doesNotMatch(rows, /Fake Admin/, "internal account stays out of the customer directory");
  assert.doesNotMatch(rows, /kalebmatthews04@example.test/, "owner test account stays out of the customer directory");
  assert.match(rows, /Jill Real/, "real customers remain visible");
  click({ target: { closest: () => ({ dataset: { tab: "profiles" } }) } });
  assert.ok(h.node("content").innerHTML.includes("Registered customers</small><strong>2</strong>"),
    "Profiles card uses filtered registration count");
});

test("Admin Customers always renders cards with irregular Stripe membership data",async()=>{
  const h=createMobileHarness();
  h.fixtures["/api/admin/membership-revenue"]={
    memberships:{unexpected:"shape"},monthlyRecurringCents:null
  };
  h.fixtures["/api/admin/submissions"]={submissions:[
    {id:"paid1",customerAccountId:"customer1",stripeSubscriptionId:"sub_one",
      profile:{firstName:"Alice",lastName:"Real",email:"alice@example.test"},
      plan:{name:"10 ACO",profiles:10,status:"active"}}
  ]};
  await h.settle();
  h.node("tabs").listeners.get("click")({
    target:{closest:()=>({dataset:{tab:"customers"}})}
  });
  assert.match(h.node("customer-results").innerHTML,/Alice Real/);
  assert.match(h.node("customer-results").innerHTML,/VIEW CUSTOMER PAGE/);
  assert.match(h.node("customer-results").innerHTML,/Stripe billing details unavailable/);
});
test("registered counts deduplicate signup and paid records while excluding both internal profiles",async()=>{
  const h=createMobileHarness();
  h.fixtures["/api/admin/submissions"]={submissions:[
    {id:"order1",customerAccountId:"user1",profile:{firstName:"Amy",email:"amy@example.test"}},
    {id:"order2",customerAccountId:"user2",profile:{firstName:"Bri",email:"bri@example.test"}},
    {id:"order3",customerAccountId:"user3",profile:{firstName:"Cam",email:"cam@example.test"}},
    {id:"order4",customerAccountId:"user4",profile:{firstName:"Dan",email:"dan@example.test"}},
    {id:"order5",customerAccountId:"not-test-id",profile:{firstName:"Fake",lastName:"Admin Profile",email:"ops@example.test"}},
    {id:"order6",customerAccountId:"owner-test-id",profile:{firstName:"Kaleb",lastName:"Matthews",username:"kalebmatthews04",email:"site-owner@example.test"}}
  ]};
  h.fixtures["/api/admin/free-submissions"]=[
    {id:"temporary-signup-id",customerAccountId:"old-user1-id",accountOnly:true,
      profile:{firstName:"Amy",email:"amy@example.test"}}
  ];
  await h.settle();
  assert.match(h.node("content").innerHTML,/Registered customers<\/small><strong>4<\/strong>/);
  assert.match(h.node("content").innerHTML,/<small>CUSTOMERS<\/small><b>4<\/b>/);
  h.node("tabs").listeners.get("click")({
    target:{closest:()=>({dataset:{tab:"customers"}})}
  });
  assert.match(h.node("content").innerHTML,/4 registered customers/);
  assert.doesNotMatch(h.node("customer-results").innerHTML,/Fake Admin Profile/);
  assert.doesNotMatch(h.node("customer-results").innerHTML,/Kaleb Matthews/);
  assert.match(h.node("customer-results").innerHTML,/Alice Real|Amy/);
  h.node("tabs").listeners.get("click")({
    target:{closest:()=>({dataset:{tab:"profiles"}})}
  });
  assert.match(h.node("content").innerHTML,/Registered customers<\/small><strong>4<\/strong>/);
});

test("Paid membership cards retain tier color, payment breakdown, expiration bar and controls",async()=>{
  const h=createMobileHarness();
  const expires=new Date(Date.now()+14*86400000).toISOString();
  h.fixtures["/api/admin/submissions"]={submissions:[
    {id:"paid20",customerAccountId:"member20",stripeSubscriptionId:"sub_20",
      profile:{firstName:"Member",lastName:"Twenty",email:"twenty@example.test"},
      plan:{tier:6,profiles:20,name:"20 ACO",status:"active"},currentPeriodEnd:expires},
    {id:"paid2",customerAccountId:"member2",stripeSubscriptionId:"sub_2",
      profile:{firstName:"Member",lastName:"Two",email:"two@example.test"},
      plan:{tier:2,status:"active"},currentPeriodEnd:expires}
  ]};
  h.fixtures["/api/admin/membership-revenue"]={memberships:[
    {subscriptionId:"sub_20",currentAmountCents:4500,lastPaidCents:3000,
      nextInvoiceCents:4500,regularAmountCents:5000,nextBillingAt:expires,
      lastPaidAt:"2026-10-01T13:30:00Z",lastPaymentKind:"subscription_update"},
    {subscriptionId:"sub_2",currentAmountCents:2500,lastPaidCents:2500,
      nextInvoiceCents:2500,regularAmountCents:2500,nextBillingAt:expires}
  ]};
  await h.settle();
  h.node("tabs").listeners.get("click")({target:{closest:()=>({dataset:{tab:"customers"}})}});
  const rows=h.node("customer-results").innerHTML;
  assert.match(rows,/Member Twenty/);
  assert.match(rows,/Member Two/);
  assert.match(rows,/admin-customer-tier-20/);
  assert.match(rows,/admin-customer-tier-2/);
  assert.match(rows,/admin-customer-tier-badge/);
  assert.match(rows,/Membership time remaining/);
  assert.match(rows,/Membership days remaining/);
  assert.match(rows,/Last paid:/);
  assert.ok(rows.includes("$30.00"));
  assert.match(rows,/Current monthly charge:/);
  assert.ok(rows.includes("$45.00"));
  assert.match(rows,/Next scheduled renewal:/);
  assert.match(rows,/Regular tier rate:/);
  assert.ok(rows.includes("upgrade/proration"));
  assert.match(rows,/Send Notification/);
  assert.match(rows,/Customer details &amp; actions/);
  assert.doesNotMatch(rows,/Membership details are temporarily unavailable/);
  assert.doesNotMatch(rows,/Unable to display membership details/);
});
test("Internal test customers are omitted from list without deleting their backing records",async()=>{
  const h=createMobileHarness();
  h.fixtures["/api/admin/free-submissions"]=[
    {id:"owner",customerAccountId:"alias-owner",accountOnly:true,profile:{email:"kalebmatthews04@gmail.com"}},
    {id:"fake",customerAccountId:"fake-123",accountOnly:true,profile:{firstName:"Fake",lastName:"Admin"}},
    {id:"real",customerAccountId:"new-real",accountOnly:true,profile:{firstName:"Real",email:"registered@example.test"}}
  ];
  await h.settle();
  h.node("tabs").listeners.get("click")({target:{closest:()=>({dataset:{tab:"customers"}})}});
  const rows=h.node("customer-results").innerHTML;
  assert.match(rows,/registered@example.test/);
  assert.doesNotMatch(rows,/kalebmatthews04/i);
  assert.doesNotMatch(rows,/Fake Admin/);
  assert.match(h.node("content").innerHTML,/2 registered customers/);
});
