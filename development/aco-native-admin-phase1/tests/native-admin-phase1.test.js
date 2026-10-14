'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');const fs=require('node:fs');const path=require('node:path');
const {makeBrowserBridge}=require('../site-bridge');
const root=path.resolve(__dirname,'..');const source=file=>fs.readFileSync(path.join(root,file),'utf8');
class MockContents extends EventEmitter{
 constructor(){super();this.session={setPermissionRequestHandler:fn=>this.permissionHandler=fn};this.scripts=[];this.url='';this.dead=false;}
 isDestroyed(){return this.dead;}
 loadURL(url){this.url=url;this.emit('did-finish-load');return Promise.resolve();}
 setWindowOpenHandler(fn){this.popupPolicy=fn;}
 executeJavaScript(script){this.scripts.push(script);if(script.includes('EventSource('))return Promise.resolve(true);
  return Promise.resolve({status:200,ok:true,body:{options:[]}});
 }
 close(){this.dead=true;this.emit('destroyed');}
 }
 class AuthWindow extends EventEmitter{
 static windows=[];
 constructor(options){super();this.options=options;this.webContents=new MockContents();this.shown=Boolean(options.show);this.dead=false;AuthWindow.windows.push(this);}
 show(){this.shown=true;}
 hide(){this.shown=false;}
 isVisible(){return this.shown;}
 focus(){this.focused=true;}
 isDestroyed(){return this.dead;}
 loadURL(url){return this.webContents.loadURL(url);}
 close(){this.dead=true;this.webContents.close();this.emit('closed');}
 }
 class EmbedView{
 static created=0;
 constructor(){EmbedView.created++;this.webContents=new MockContents();}
 setBounds(){}
 }
 function mockBridge(){
  AuthWindow.windows=[];EmbedView.created=0;
  const sent=[],ipcMain=new EventEmitter();let cleared=false;
  const main={isDestroyed:()=>false,webContents:{id:1,isDestroyed:()=>false,send:msg=>sent.push(msg)},
   contentView:{addChildView:()=>{},removeChildView:()=>{}},getContentBounds:()=>({width:1500,height:850}),show:()=>{},focus:()=>{}};
  const result=makeBrowserBridge({BrowserWindow:AuthWindow,WebContentsView:EmbedView,
   session:{fromPartition:()=>({clearStorageData:async()=>{cleared=true;}})},ipcMain,
   shell:{openExternal:async()=>{}},mainWindow:()=>main});
  return {result,ipcMain,sent,get cleared(){return cleared;}};
 }
 test('native Admin sign-in creates a separate sandboxed browser, not an embedded website frame',async()=>{
  const f=mockBridge();assert.equal(f.result.signIn(),true);
  assert.equal(EmbedView.created,0);
  assert.equal(AuthWindow.windows.length,1);
  const w=AuthWindow.windows[0];
  assert.equal(w.webContents.url,'https://slabsngrabsaco.com/admin.html');
  assert.equal(w.options.webPreferences.partition,'persist:sng-jig-admin');
  assert.equal(w.options.webPreferences.nodeIntegration,false);
  assert.equal(w.options.webPreferences.contextIsolation,true);
  assert.equal(w.options.webPreferences.sandbox,true);
  assert.equal(w.webContents.popupPolicy({url:'https://untrusted.example/'}).action,'deny');
  assert.deepEqual(await f.result.read('jigOptions'),{options:[]});
  assert.ok(w.webContents.scripts.some(s=>s.includes('/api/admin/jig-options')));
  assert.ok(w.webContents.scripts.some(s=>s.includes('/api/admin/live/events')));
  f.ipcMain.emit('site:remote-change',{sender:w.webContents});
  assert.ok(f.sent.includes('site:change'));
  assert.equal(f.result.signIn(),true);assert.equal(AuthWindow.windows.length,1,'do not create a second sign-in session');
  await f.result.logout();assert.equal(f.cleared,true);
 });
 test('ACO Studio starts on local native Admin; complete original website Admin remains accessible',()=>{
  const html=source('index.html'),shell=source('desktop-native.js');
  assert.match(html,/<button[^>]*class="tabButton on"[^>]*data-tab="site"[^>]*>[^<]*<span/);
  assert.match(html,/<main[^>]*id="sitePage" aria-label="ACO Studio native Admin">/);
  assert.match(html,/<main[^>]*id="adminPage"[^>]*hidden>/);
  assert.match(html,/data-tab="admin"[^>]*>.*?Full Website Admin/);
  assert.match(shell,/site:'Admin · Desktop'/);
  assert.match(shell,/admin:'Full Website Admin'/);
 });
 test('native Admin calls authenticated website bridge and retains live website change events',()=>{
  const ui=source('site-ui.js'),bridge=source('site-bridge.js'),main=source('main.js'),preload=source('preload.js');
  assert.match(ui,/api\.signIn\?\.\(\)\|\|api\.open\(\)/);
  assert.doesNotMatch(ui,/async function startLogin\(\)\{\s*if\(!document\.querySelector\('\.tabButton\[data-tab="admin"\]/);
  assert.match(ui,/api\.onChange\(/);
  assert.match(main,/ipcMain\.handle\('site:signIn'/);
  assert.match(preload,/signIn:\(\)=>ipcRenderer\.invoke\('site:signIn'\)/);
  assert.match(bridge,/credentials:'same-origin'/);
  assert.match(bridge,/EventSource\('\/api\/admin\/live\/events'\)/);
  assert.doesNotMatch(ui,/localStorage\.setItem\(['"](?:card|address|customer|payment)/);
 });
