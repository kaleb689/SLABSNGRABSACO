import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
const read = path => readFileSync(new URL("../"+path, import.meta.url),"utf8");
const admin=read("public/admin.html");
const mobile=read("public/admin-mobile.js");
const app=read("public/admin-app.html");
const passkeys=read("public/admin-passkey-controls.js");
const workspace=read("public/admin-workspace-tabs.js");
const css=read("public/admin-ipad-passkeys.css");

test("the full Admin iPad page exposes biometric sign-in AND authenticated setup",()=>{
  assert.match(admin, /id="adminPasskeyLogin"/);
  assert.match(admin, /id="adminPasskeySetup"/);
  assert.match(admin, /id="adminPasskeyLoginStatus"/);
  assert.match(admin, /admin-passkey-controls\.js\?v=20261013-1/);
  assert.match(admin, /admin-ipad-passkeys\.css\?v=20261013-1/);
  assert.match(workspace, /item\.id !== "adminPasskeyControls"/);
  assert.match(css, /admin-passkey-login-button/);
  assert.match(css, /#dashboard \.admin-passkey-setup/);
});
test("installed Admin iPad app has a visible post-login biometric setup button",()=>{
  assert.match(app, /id="mobile-biometric-setup" hidden/);
  assert.match(mobile, /\$\("mobile-biometric-setup"\)\.hidden=!value/);
  assert.match(mobile, /quickFaceSetup\.onclick/);
  assert.match(app, /admin-mobile\.js\?v=20261018-cross-retailer-products-1/);
  assert.match(mobile, /panel\("Face ID \/ Touch ID"/);
});
test("WebAuthn controls compile and use the existing verified passkey endpoints",()=>{
  assert.doesNotThrow(()=>new vm.Script(passkeys));
  assert.doesNotThrow(()=>new vm.Script(mobile));
  assert.match(passkeys, /\/api\/admin\/passkeys\/register\/options/);
  assert.match(passkeys, /\/api\/admin\/passkeys\/register\/verify/);
  assert.match(passkeys, /\/api\/admin\/passkeys\/login\/options/);
  assert.match(passkeys, /\/api\/admin\/passkeys\/login\/verify/);
  assert.match(passkeys, /authenticatorAttachment:"platform"/);
  assert.match(passkeys, /credentials:"same-origin"/);
});
test("iPad live refresh does not rebuild unchanged content or repeatedly restore scroll",()=>{
  assert.match(mobile, /mobileRenderedFingerprint===mobileVisibleFingerprint\(\)/);
  assert.match(mobile, /const changed=mobileRenderedFingerprint!==mobileVisibleFingerprint\(\)/);
  assert.match(mobile, /if\(!force\)mobileRestoreScroll\(x,y\)/);
  assert.match(mobile, /Math\.abs\(window\.scrollY-y\)>2/);
  assert.match(admin, /15-second full rebuild/);
  assert.doesNotMatch(admin,/window\.setInterval\(\s*\(\) => \{\s*if\s*\(\s*!dashboard\.hidden\s*\)\s*\{\s*loadProfileActivationTracker\(\)/);
  assert.match(admin,/document\.querySelector\("#rows \.customer-order\[open\]"\)/);
  assert.match(admin,/sessionStorage\.removeItem\(storageKey\);/);
});
