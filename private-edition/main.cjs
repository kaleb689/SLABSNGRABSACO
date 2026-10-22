"use strict";
const {app,BrowserWindow,ipcMain,dialog,shell}=require("electron");
const fs=require("node:fs/promises");
const path=require("node:path");
const crypto=require("node:crypto");
const Vault=require("./vault.cjs");
const Formats=require("./formats.cjs");
const Jigs=require("./jigs.cjs");
const LICENSE_URL="https://slabsngrabsaco.com/api/studio-private/license/verify";
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
async function edit(fn){return transact(async()=>{await allowed();const v=await Vault.load();const result=await fn(v);await Vault.save(v);return result;});}
function displayState(v){
  return {sources:v.sources.map(s=>({id:s.id,retailer:s.retailer,...Formats.profileSummary(s.file)})),
    cards:v.cards.map(c=>({id:c.id,label:c.label,holder:c.holder,last4:String(c.number||"").slice(-4),expiry:c.expiry})),
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
  authorizedUntil=Date.now()+10*60_000;return {active:true};
});
ipcMain.handle("vault:overview",async()=>{await allowed();return displayState(await Vault.load());});
ipcMain.handle("vault:addCard",(_e,p)=>edit(v=>{const card=validate("card",{label:String(p?.label||""),holder:String(p?.holder||""),
    number:String(p?.number||"").replace(/[\s-]/g,""),expiry:String(p?.expiry||"")});
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
    fields:Object.fromEntries(Object.entries(row||{}).filter(([k])=>!/pass|card|cvv|security|pin/i.test(k)).slice(0,50))}))};
});
ipcMain.handle("vault:jig",(_e,p)=>edit(v=>{
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
      const applied=Formats.changeRow(source.file,index,{cardNumber:card.number||"",cardExpiry:card.expiry||"",cardholder:card.holder||""});
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
app.whenReady().then(openWindow).catch(()=>app.quit());
app.on("window-all-closed",()=>app.quit());
