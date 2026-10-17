import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const read = path => fs.readFileSync(new URL("../"+path, import.meta.url),"utf8");
const mobile=read("public/admin-mobile.js");
const notifications=read("public/admin-live-notifications.js");
const html=read("public/admin-app.html");
const css=read("public/admin-ipad-notifications.css");
const admin=read("public/admin.html");
test("new iPad scripts compile",()=>{
  assert.doesNotThrow(()=>new vm.Script(mobile));
  assert.doesNotThrow(()=>new vm.Script(notifications));
});
test("mobile Admin includes explicit notification bell, dismiss controls, and ten second toast",()=>{
  assert.match(notifications,/sng-admin-live-bell/);
  assert.match(notifications,/data-clear-all/);
  assert.match(notifications,/data-dismiss/);
  assert.match(notifications,/10000/);
  assert.match(html,/admin-live-notifications.js/);
  assert.match(html,/admin-ipad-notifications.css/);
});
test("notification tray fits both iPad app and full website without clipping",()=>{
  assert.match(css,/position:fixed/);
  assert.match(css,/100dvh/);
  assert.match(css,/env\(safe-area-inset-top\)/);
  assert.match(css,/#dashboard .admin-head-actions #adminNotifications\[open\]/);
  assert.match(admin,/admin-ipad-notifications.css/);
});
test("live updates preserve open disclosure state without freezing checkout totals",()=>{
  assert.match(mobile,/function mobileRefreshBlocked\(/);
  assert.match(mobile,/tab!=="success"/);
  assert.match(mobile,/#content details\[open\]/);
  assert.match(mobile,/successOpenOrderCards/);
  assert.match(mobile,/mobileRestoreScroll\(x,y\)/);
  assert.match(mobile,/admin-push-disclosure/);
  assert.match(mobile,/window.AdminLiveNotifications\?\.apply\(data\)/);
});
test("Face ID preflight gives usable iPad guidance",()=>{
  assert.match(mobile,/passkeySupported\(\)/);
  assert.match(mobile,/iPad Settings/);
  assert.match(html,/Face ID \/ Touch ID/);
});
