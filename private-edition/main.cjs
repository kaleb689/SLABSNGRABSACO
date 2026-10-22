"use strict";
const {app,BrowserWindow,ipcMain,dialog,shell}=require("electron");
const fs=require("node:fs/promises");
const path=require("node:path");
const crypto=require("node:crypto");
const Vault=require("./vault.cjs");
const Formats=require("./formats.cjs");
const Jigs=require("./jigs.cjs");
const LICENSE_URL="https://slabsngrabsaco.com/api/studio-private/license/verify";
const JIG_POLICY_URL="https://slabsngrabsaco.com/api/studio-private/jig-permissions";
const JIG_EVENTS_URL=JIG_POLICY_URL+"/events";
const jigKeys=Object.keys(Jigs.defaults());
let jigPolicy=null,permissionVersion=0,watchingJigs=false;
app.setName("ACO STUDIO");
app.setPath("userData",path.join(app.getPath("appData"),"aco-studio-private-edition"));
let win=null,document=null,authorizedUntil=0,verifyPending=null,queue=Promise.resolve();
function transact(fn){const task=queue.then(fn,fn);queue=task.catch(()=>{});return task;}
const addActivity=(state,action)=>{state.activity.unshift({id:crypto.randomUUID(),action,at:new Date().toISOString()});state.activity=state.activity.slice(0,80);};
function validate(kind,value){if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Missing record.");const cleaned={};for(const [key,part] of Object.entries(value)){
  if(typeof part!=="string"||part.length>500)throw Error("A field is too long.");
  cleaned[String(key).slice(0,80)]=part.trim();
}
if(!Object.values(cleaned).some(Boolean))throw Error("Enter a record first.");
return {id:crypto.randomUUID(),createdAt:new Date().toISOString(),...cleaned};
}
async function confirmLicense(key){
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),12000);
  try{
    const response=await fetch(LICENSE_URL,{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json"},
      body:JSON.stringify({licenseKey:key}),signal:controller.signal,cache:"no-store"});
    if(!response.ok)return false;
    const body=await response.json();
    return body.active===true&&body.edition==="private";
  }finally{clearTimeout(timeout);}
}
async function licenseStatus(force=false){
  if(!force&&Date.now()<authorizedUntil)return true;
  if(verifyPending)return verifyPending;
  verifyPending=(async()=>{
    try{const state=await Vault.load();
      if(!state.licenseKey)return false;
      if(!await confirmLicense(state.licenseKey)){authorizedUntil=0;return false;}
      authorizedUntil=Date.now()+10*60_000;return true;
    }catch{authorizedUntil=0;return false;}
  })();
  try{return await verifyPending;}finally{verifyPending=null;}
}
async function allowed(){if(!await licenseStatus())throw Error("License is inactive. Sign in with your ACO STUDIO key.");}
function acceptJigPolicy(input){
  if(!input||typeof input!=="object"||!input.allowed||
    jigKeys.some(key=>typeof input.allowed[key]!=="boolean")||
    Object.keys(input.allowed).some(key=>!jigKeys.includes(key)))throw Error("Jig permissions response is invalid.");
  if(Number(input.version)<permissionVersion)return jigPolicy;
  permissionVersion=Number(input.version)||permissionVersion;
  jigPolicy=Object.fromEntries(jigKeys.map(key=>[key,input.allowed[key]]));
  if(win&&!win.isDestroyed())win.webContents.send("jigs:permissions",jigPolicy);
  return jigPolicy;
}
async function requestJigPolicy(url,licenseKey,signal){
  return fetch(url,{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json, text/event-stream"},
    body:JSON.stringify({licenseKey}),signal,cache:"no-store"});
}
async function loadJigPolicy(){
  const state=await Vault.load();
  if(!state.licenseKey)throw Error("Activate your ACO STUDIO license.");
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
  try{
    const response=await requestJigPolicy(JIG_POLICY_URL,state.licenseKey,controller.signal);
    if(!response.ok){if(response.status===401||response.status===403)jigPolicy=null;throw Error("Could not retrieve current jig permissions.");}
    return acceptJigPolicy(await response.json());
  }finally{clearTimeout(timer);}
}
async function watchJigPolicy(){
  const state=await Vault.load();
  if(!state.licenseKey)return;
  const response=await requestJigPolicy(JIG_EVENTS_URL,state.licenseKey);
  if(!response.ok||!response.body)throw Error("Jig permission updates unavailable.");
  const reader=response.body.getReader(),decoder=new TextDecoder();
  let buffer="";
  try{
    while(true){
      const {value,done}=await reader.read();if(done)break;
      buffer+=decoder.decode(value,{stream:true});
      if(buffer.length>16384)throw Error("Jig permission stream exceeded the allowed size.");
      while(buffer.includes("\n\n")){
        const index=buffer.indexOf("\n\n"),event=buffer.slice(0,index);
        buffer=buffer.slice(index+2);
        if(!event.includes("event: jig-permissions"))continue;
        const data=event.split("\n").find(line=>line.startsWith("data: "));
        if(data)acceptJigPolicy(JSON.parse(data.slice(6)));
      }
    }
  }finally{await reader.cancel().catch(()=>{});}
}
function startJigPolicySync(){
  if(watchingJigs)return;watchingJigs=true;
  void(async()=>{
    while(watchingJigs){
      try{
        if(!await licenseStatus(true)){jigPolicy=null;watchingJigs=false;break;}
        await loadJigPolicy();
        await watchJigPolicy();
      }catch(error){
        console.warn("Customer Jig policy connection interrupted:",error?.name||"network_error");
      }
      if(watchingJigs)await new Promise(resolve=>setTimeout(resolve,5000));
    }
  })();
}
async function edit(fn){return transact(async()=>{await allowed();const v=await Vault.load();const result=await fn(v);await Vault.save(v);return result;});}
function displayState(v){
  return {sources:v.sources.map(s=>({id:s.id,retailer:s.retailer,...Formats.profileSummary(s.file)})),
    cards:v.cards.map(c=>({id:c.id,label:c.label,holder:c.holder,number:c.number,securityCode:c.securityCode||"",last4:String(c.number||"").slice(-4),expiry:c.expiry})),
    addresses:v.addresses,activity:v.activity.slice(0,30),rules:v.rules};
}
async function openWindow(){
  win=new BrowserWindow({width:1480,height:940,minWidth:1100,minHeight:730,show:false,
    title:"ACO STUDIO",backgroundColor:"#090e22",
    webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,
      preload:path.join(__dirname,"preload.cjs"),webSecurity:true,webviewTag:false}});
  win.webContents.setWindowOpenHandler(()=>({action:"deny"}));
  win.webContents.on("will-navigate",event=>event.preventDefault());
  await win.loadFile(path.join(__dirname,"index.html"));
  win.once("ready-to-show",()=>win.show());
}
ipcMain.handle("license:status",()=>licenseStatus());
ipcMain.handle("license:activate",async (_e,value)=>{
  const key=String(value||"").trim().toUpperCase();
  if(!/^ACOP-(?:[A-F0-9]{16}-){3}[A-F0-9]{16}$/.test(key))throw Error("Enter a valid license key.");
  if(!await confirmLicense(key))throw Error("This subscription license is not active.");
  await transact(async()=>{const state=await Vault.load();state.licenseKey=key;await Vault.save(state);});
  authorizedUntil=Date.now()+10*60_000;startJigPolicySync();return {active:true};
});
ipcMain.handle("vault:overview",async()=>{await allowed();return displayState(await Vault.load());});
ipcMain.handle("jigs:permissions",async()=>{await allowed();return jigPolicy||await loadJigPolicy();});
ipcMain.handle("vault:addCard",(_e,p)=>edit(v=>{const card=validate("card",{label:String(p?.label||""),holder:String(p?.holder||""),
    number:String(p?.number||"").replace(/[\s-]/g,""),expiry:String(p?.expiry||""),securityCode:String(p?.securityCode||"")});
  if(!/^\d{12,19}$/.test(card.number))throw Error("Card number must contain 12-19 digits.");
  if(v.cards.some(c=>c.number===card.number))throw Error("Card already saved in this private bank.");
  v.cards.push(card);addActivity(v,"Added card ending "+card.number.slice(-4));return {saved:true};}));
ipcMain.handle("vault:addAddress",(_e,p)=>edit(v=>{const a=validate("address",{
  label:String(p?.label||""),address:String(p?.address||""),unit:String(p?.unit||""),
  city:String(p?.city||""),state:String(p?.state||""),zip:String(p?.zip||"")});
  v.addresses.push(a);addActivity(v,"Added local address");return {saved:true};}));
ipcMain.handle("vault:addAccount",(_e,p)=>edit(v=>{
  const retailer=String(p?.retailer||"");if(!["target","walmart","pokemoncenter","costco","sams"].includes(retailer))throw Error("Choose a retailer.");
  const account=validate("account",{email:String(p?.email||""),first_name:String(p?.first||""),last_name:String(p?.last||""),address:String(p?.address||""),address2:"",city:String(p?.city||""),state:String(p?.state||""),zip:String(p?.zip||""),phone:String(p?.phone||""),billing_address:"",billing_city:"",billing_state:"",billing_zip:"",card_number:"",card_expiry:"",cardholder:""});
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email))throw Error("Enter a valid email.");
  const file=Formats.readSource("created-"+retailer+".json",JSON.stringify([account],null,2));
  v.sources.push({id:crypto.randomUUID(),retailer,file});addActivity(v,"Created "+retailer+" profile");
  return {saved:true};
}));
ipcMain.handle("vault:import",async (_e,retailer)=>{
  await allowed();if(!["target","walmart","pokemoncenter","costco","sams"].includes(retailer))throw Error("Choose a retailer.");
  const select=await dialog.showOpenDialog(win,{properties:["openFile","multiSelections"],
    filters:[{name:"Profiles",extensions:["csv","tsv","json","txt"]},{name:"All files",extensions:["*"]}]});
  if(select.canceled)return {imported:0};
  const files=[];
  for(const filename of select.filePaths){const info=await fs.stat(filename);if(info.size>24*1024*1024)throw Error("Files must be under 24 MB each.");
    const content=await fs.readFile(filename,"utf8");const parsed=Formats.readSource(path.basename(filename),content);
    files.push({id:crypto.randomUUID(),retailer,file:parsed});
  }
  return edit(v=>{v.sources.push(...files);addActivity(v,"Imported "+files.length+" "+retailer+" file(s)");
    return {imported:files.length,profiles:files.reduce((total,item)=>total+item.file.rows.length,0)};});
});
ipcMain.handle("vault:export",async (_e,id)=>{
  await allowed();const v=await Vault.load(),source=v.sources.find(s=>s.id===id);
  if(!source)throw Error("Choose an imported source file.");
  const target=await dialog.showSaveDialog(win,{defaultPath:source.file.filename,
    buttonLabel:"Export original format"});
  if(target.canceled||!target.filePath)return {saved:false};
  // User chooses the location. Never send exports to the website or a remote service.
  await fs.writeFile(target.filePath,Formats.exportSource(source.file),{mode:0o600});
  return {saved:true,filename:path.basename(target.filePath)};
});
ipcMain.handle("vault:rows",async (_e,id)=>{
  await allowed();const source=(await Vault.load()).sources.find(s=>s.id===id);
  if(!source)throw Error("File unavailable.");
  return {id,filename:source.file.filename,rows:source.file.rows.slice(0,250).map((row,index)=>({index,
    fields:Object.fromEntries(Object.entries(row||{}).slice(0,50))}))};
});
ipcMain.handle("vault:jig",(_e,p)=>edit(async v=>{
  if(!jigPolicy)await loadJigPolicy();
  const forbidden=jigKeys.filter(key=>p?.options?.[key]===true&&jigPolicy?.[key]!==true);
  if(forbidden.length)throw Error("A selected jig type has been disabled by your ACO Studio administrator: "+forbidden.join(", "));
  const source=v.sources.find(s=>s.id===p?.fileId);if(!source)throw Error("Choose an imported file.");
  const selected=Array.isArray(p?.indices)?p.indices:[];
  if(!selected.length||selected.length>2500||selected.some(i=>!Number.isInteger(i)||i<0||i>=source.file.rows.length))
    throw Error("Select the profiles to jig.");
  const options=Object.fromEntries(Object.keys(Jigs.defaults()).map(k=>[k,p?.options?.[k]===true]));
  const useAddresses=p?.options?.useAddressBank===true;
  const useCards=p?.options?.useCardBank===true;
  if(useAddresses&&!v.addresses.length)throw Error("Add addresses to your private address bank first.");
  if(useCards&&!v.cards.length)throw Error("Add cards to your private card bank first.");
  let edited=0,assignedAddresses=0,assignedCards=0;
  for(const [position,index] of [...new Set(selected)].entries()){
    let changed=Jigs.jigProfile(source.file,index,options).count;
    if(useAddresses){
      const a=v.addresses[position%v.addresses.length];
      const change={address:a.address||"",unit:a.unit||"",city:a.city||"",state:a.state||"",zip:a.zip||""};
      if(p?.options?.billingSameAsShipping===true)Object.assign(change,{billingAddress:a.address||"",billingCity:a.city||"",billingState:a.state||"",billingZip:a.zip||""});
      const applied=Formats.changeRow(source.file,index,change);
      if(applied){assignedAddresses++;changed+=applied;}
    }
    if(useCards){
      const card=v.cards[position%v.cards.length];
      const applied=Formats.changeRow(source.file,index,{cardNumber:card.number||"",cardExpiry:card.expiry||"",cardholder:card.holder||"",cardSecurityCode:card.securityCode||""});
      if(applied){assignedCards++;changed+=applied;}
    }
    if(changed)edited++;
  }
  if(edited)addActivity(v,"Prepared "+edited+" "+source.retailer+" profiles using private jigs/banks");
  return {edited,assignedAddresses,assignedCards,filename:source.file.filename};
}));
ipcMain.handle("vault:remove",(_e,p)=>edit(v=>{
  if(p?.kind==="source")v.sources=v.sources.filter(s=>s.id!==p.id);
  else if(p?.kind==="card")v.cards=v.cards.filter(s=>s.id!==p.id);
  else if(p?.kind==="address")v.addresses=v.addresses.filter(s=>s.id!==p.id);
  else throw Error("Invalid bank.");
  addActivity(v,"Removed local "+p.kind+" record");
  return {removed:true};
}));
app.whenReady().then(async()=>{await openWindow();if(await licenseStatus().catch(()=>false))startJigPolicySync();}).catch(()=>app.quit());
app.on("window-all-closed",()=>app.quit());
