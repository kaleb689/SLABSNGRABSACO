import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../public/pwa.js', import.meta.url), 'utf8');
function surface({ installed = true, frame = false, signedIn = true, search = '', hash = '#my-profile' } = {}) {
  const timers = [], observers = [];
  const classes = () => { const values = new Set(); return { add: value => values.add(value), contains: value => values.has(value), toggle: (value, yes) => yes ? values.add(value) : values.delete(value) }; };
  function element(tag) {
    return { tag, hidden: false, dataset: {}, children: [], attributes: {}, events: {}, classList: classes(),
      setAttribute(k,v) { this.attributes[k]=v; }, removeAttribute(k) { delete this.attributes[k]; },
      append(...children) { this.children.push(...children); }, addEventListener(k,f) { this.events[k]=f; },
      querySelectorAll() { return this.children.filter(child=>child.tag==='a'); },
      focus() {}, showModal() {}, close() { this.events.close?.(); }, remove() { this.removed=true; } };
  }
  const tabs = Object.fromEntries(['membership','success','orders','edit-profile','notifications','security'].map(id => [id, { classList: classes(), click() {
    for (const [name,tab] of Object.entries(tabs)) tab.classList.toggle('active', name===id);
  }}]));
  tabs.membership.click();
  const body = element('body'), dashboard = element('div'), installButton = element('button');
  dashboard.hidden = !signedIn;
  const location = { search, hash };
  const window = { matchMedia: () => ({ matches: installed }), self: {}, top: {}, events: {}, addEventListener(k,f) { this.events[k]=f; } };
  if (!frame) window.top=window.self;
  const document = { body, events: {}, createElement: element, createTextNode: text => ({text}), addEventListener(k,f) { this.events[k]=f; },
    getElementById(id) { return { 'customer-dashboard': dashboard, 'account-install-app': installButton }[id] || null; },
    querySelector(selector) { return tabs[selector.match(/data-account-tab="([^"]+)"/)?.[1]]; } };
  vm.runInNewContext(source,{ window,document,location,navigator:{userAgent:'Browser'},URLSearchParams,
    MutationObserver: class { constructor(callback) { observers.push(callback); } observe() {} }, setTimeout: f=>timers.push(f) });
  return {body,window,document,location,tabs,installButton,dashboard,observe:()=>observers.forEach(f=>f()),flush:()=>{while(timers.length)timers.shift()();}};
}
test('public website has no app navigation or visible install button',()=>{
 const s=surface({installed:false,signedIn:false});assert.equal(s.body.children.length,0);assert.equal(s.installButton.hidden,true);
});
test('embedded previews do not gain app chrome',()=>assert.equal(surface({frame:true}).body.children.length,0));
test('installed app opens Profile and offers all six account destinations',()=>{
 const s=surface({hash:'#home'});assert.equal(s.location.hash,'#my-profile');
 const links=s.body.children[0].children;assert.equal(links.length,6);
 for(let i=0;i<links.length;i++){links[i].events.click();s.flush();assert.equal(links[i].attributes['aria-current'],'page');assert.equal(s.tabs[links[i].dataset.appTab].classList.contains('active'),true);}
});
test('app bottom buttons disappear on logout and installation is account-only',()=>{
 const s=surface({signedIn:false});assert.equal(s.body.children[0].hidden,true);
 s.dashboard.hidden=false;s.observe();assert.equal(s.body.children[0].hidden,false);assert.equal(s.installButton.hidden,true);
 const web=surface({installed:false,signedIn:false});web.dashboard.hidden=false;web.observe();assert.equal(web.installButton.hidden,false);
 web.dashboard.hidden=true;web.observe();assert.equal(web.installButton.hidden,true);
});
test('install choice can be dismissed and reopened later from Profile',()=>{
 const s=surface({installed:false});s.installButton.events.click();
 const dialog=s.body.children[0];assert.equal(dialog.children[0].textContent,'Add app');
 assert.equal(dialog.children[2].children[0].textContent,'Add to Home Screen');
 dialog.children[2].children[1].events.click();assert.equal(dialog.removed,true);
 s.installButton.events.click();assert.equal(s.body.children.length,2);
});
test('stored native install prompt is triggered by Add button and only once',async()=>{
 const s=surface({installed:false});let prompted=0;
 s.window.events.beforeinstallprompt({preventDefault(){},prompt:async()=>{prompted++;},userChoice:Promise.resolve({outcome:'accepted'})});
 s.installButton.events.click();await s.body.children[0].children[2].children[0].events.click();assert.equal(prompted,1);assert.equal(s.body.children[0].removed,true);
});
test('notification deep links select the correct account tab',()=>{
 const s=surface({search:'?appTab=notifications'});s.flush();assert.equal(s.tabs.notifications.classList.contains('active'),true);
});
