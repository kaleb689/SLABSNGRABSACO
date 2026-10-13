import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const admin = fs.readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
const mobile = fs.readFileSync(new URL("../public/admin-mobile.js", import.meta.url), "utf8");
const reset = fs.readFileSync(new URL("../public/nested-details-reset.js", import.meta.url), "utf8");

test("Admin customer dropdowns use one customer-scoped state manager", () => {
  assert.match(admin, /sng-details-v3:/);
  assert.doesNotMatch(admin, /sng-admin-details:/);
  assert.doesNotMatch(admin, /sng-details-v2:/);
  assert.match(admin, /customerId, part\(parent\)/);
  assert.match(admin, /if \(!detail\.open\) resetChildren\(detail\)/);
  assert.match(admin, /detail\.parentElement\?\.closest\("details:not\(\[open\]\)"\)/);
  assert.match(admin, /if \(customerChild\(detail\)\) continue/);
});

test("Closing parent immediately closes all nested details and saved keys", () => {
  const start = admin.indexOf("(function setupStableDetailsState()");
  const end = admin.lastIndexOf("/* =========================================", admin.indexOf("CUSTOMER ACTION CENTER / EXPORT", start));
  assert.ok(start > 0 && end > start);
  const source = admin.slice(start,end);
  const events = new Map();
  const store = new Map();
  const child = {tagName:"DETAILS",open:true,dataset:{inlineAdminSection:"imap"},
    querySelector(){return {textContent:"IMAP / Host Email"};},
    parentElement:null,closest(selector){return selector===".customer-order"?parent:null;},
    matches(){return false;}};
  const parent = {tagName:"DETAILS",open:true,dataset:{id:"customer-a"},
    querySelectorAll(selector){return selector==="details"?[child]:[];},
    querySelector(){return {textContent:"Customer A"};},
    closest(){return null;},matches(selector){return selector==="details[open]";}};
  child.parentElement={children:[child],closest(){return parent;}};
  parent.parentElement={children:[parent],closest(){return null;}};
  const document = {documentElement:{},addEventListener(name,listener){events.set(name,listener);},
    querySelectorAll(){return [];},querySelector(){return null;}};
  const storage={setItem(k,v){store.set(k,v);},getItem(k){return store.get(k)||null;}};
  vm.runInNewContext(source,{
    document,sessionStorage:storage,location:{pathname:"/admin.html",hash:""},
    MutationObserver:class{observe(){}}
  });
  events.get("click")({target:{closest(){return {parentElement:parent};}}});
  assert.equal(child.open,false,"child closes before parent toggle fires");
  parent.open=false;
  events.get("toggle")({target:parent});
  assert.equal(child.open,false);
  assert.ok([...store.entries()].some(([key,value])=>key.includes("customer-a")&&value==="closed"));
});

test("Live Admin does not redraw unchanged lists, and iPad blocks redraw while details are open",()=>{
  assert.match(admin,/adminPaidRowsFingerprint === nextPaidFingerprint/);
  assert.match(admin,/adminLastActivationFingerprint/);
  assert.match(admin,/await load\(\{ background: true \}\)/);
  assert.match(mobile,/#content details\[open\]/);
  assert.match(reset,/parent\.querySelectorAll\("details\[open\]"\)/);
});
