import express from "express";
import Stripe from "stripe";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use((req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
  if (req.path === '/admin' || req.path.startsWith('/api/admin/')) res.setHeader('Cache-Control','no-store');
  next();
});

const PORT = process.env.PORT || 4242;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const DATA_DIR = process.env.DATA_DIR || "/var/data/slabsngrabsaco";
const PENDING_FILE = path.join(DATA_DIR, "pending-submissions.json");
const PAID_FILE = path.join(DATA_DIR, "paid-submissions.json");
const SECRET_DIR = path.join(DATA_DIR, "secure-packages");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_missing");

const PLANS = {
  1:{name:"Tier 1",profiles:1,amount:30,priceId:process.env.STRIPE_TIER1_PRICE_ID},
  2:{name:"Tier 2",profiles:2,amount:50,priceId:process.env.STRIPE_TIER2_PRICE_ID},
  3:{name:"Tier 3",profiles:3,amount:80,priceId:process.env.STRIPE_TIER3_PRICE_ID}
};

async function readJson(file,fallback){try{return JSON.parse(await fs.readFile(file,"utf8"))}catch{return fallback}}
async function writeJson(file,value){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value,null,2),"utf8")}
const clean=(v,max=300)=>String(v??"").trim().slice(0,max);

function sanitizeProfile(b){
  return {profileName:clean(b.profileName),firstName:clean(b.firstName,100),lastName:clean(b.lastName,100),
    email:clean(b.email,200),phone:clean(b.phone,50),address:clean(b.address),address2:clean(b.address2),
    country:clean(b.country,100),state:clean(b.state,100),city:clean(b.city,100),zip:clean(b.zip,30)};
}
function sanitizeSecrets(b){
  return {acoEmail:clean(b.acoEmail,200),acoPassword:clean(b.acoPassword,300),cardLabel:clean(b.cardLabel,100),
    cardholder:clean(b.cardholder,150),acoCardNumber:clean(b.acoCardNumber,30).replace(/[^\d]/g,""),
    expMonth:clean(b.expMonth,2),expYear:clean(b.expYear,4)};
}
function validProfile(p){return ["profileName","firstName","lastName","email","phone","address","country","state","city","zip"].every(k=>p[k])&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)}
function validSecrets(s){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.acoEmail)&&s.acoPassword.length>=6&&/^\d{12,19}$/.test(s.acoCardNumber)&&s.cardholder&&s.cardLabel&&s.expMonth&&s.expYear}

function encryptionKey(){
  const raw=process.env.SUBMISSION_ENCRYPTION_KEY||"";
  if(!raw) throw new Error("SUBMISSION_ENCRYPTION_KEY is not configured");
  return crypto.createHash("sha256").update(raw).digest();
}
function encryptJson(obj){
  const iv=crypto.randomBytes(12), key=encryptionKey(), cipher=crypto.createCipheriv("aes-256-gcm",key,iv);
  const plaintext=Buffer.from(JSON.stringify(obj),"utf8");
  const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
  return {version:1,alg:"AES-256-GCM",iv:iv.toString("base64"),tag:cipher.getAuthTag().toString("base64"),data:ciphertext.toString("base64")};
}
async function saveEncryptedPackage(id,obj){await fs.mkdir(SECRET_DIR,{recursive:true});await writeJson(path.join(SECRET_DIR,`${id}.encrypted.json`),encryptJson(obj))}
async function sendNotification(record){
  if(!process.env.RESEND_API_KEY||!process.env.BUSINESS_EMAIL)return false;
  const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{"Authorization":`Bearer ${process.env.RESEND_API_KEY}`,"Content-Type":"application/json"},
    body:JSON.stringify({from:process.env.FROM_EMAIL||"SLABSNGRABSACO <onboarding@resend.dev>",to:[process.env.BUSINESS_EMAIL],
      subject:`Secure paid profile ready — ${record.plan.name}`,
      text:`A paid SLABSNGRABSACO profile is ready.\n\nSubmission ID: ${record.id}\nCustomer: ${record.profile.firstName} ${record.profile.lastName}\nContact email: ${record.profile.email}\nPlan: ${record.plan.name} — $${record.plan.amount}/month\n\nSensitive ACO email/password and ACO card details are NOT included in this email. Retrieve the encrypted package through your secured server/admin workflow.`})});
  return response.ok;
}


const adminSessions=new Map();
const loginAttempts=new Map();
function parseCookies(req){return Object.fromEntries(String(req.headers.cookie||"").split(";").filter(Boolean).map(x=>{const i=x.indexOf("=");return [x.slice(0,i).trim(),decodeURIComponent(x.slice(i+1))]}))}
function safeEqual(a,b){const A=Buffer.from(String(a)),B=Buffer.from(String(b));return A.length===B.length&&crypto.timingSafeEqual(A,B)}
function requireAdmin(req,res,next){const token=parseCookies(req).sng_admin,session=token&&adminSessions.get(token);if(!session||session.expires<Date.now()){if(token)adminSessions.delete(token);return res.status(401).json({error:"Unauthorized"})}session.expires=Date.now()+30*60*1000;next()}
function decryptJson(payload){const key=encryptionKey(),iv=Buffer.from(payload.iv,"base64"),tag=Buffer.from(payload.tag,"base64"),decipher=crypto.createDecipheriv("aes-256-gcm",key,iv);decipher.setAuthTag(tag);return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data,"base64")),decipher.final()]).toString("utf8"))}
/* TEMPORARY ADMIN-ONLY STORAGE TEST — remove after testing */
app.post("/api/admin/test-storage", requireAdmin, async (req,res)=>{
  try{
    const id=crypto.randomUUID();
    const createdAt=new Date().toISOString();

    const profile={
      profileName:"STORAGE TEST",
      firstName:"Test",
      lastName:"Customer",
      email:"test@example.com",
      phone:"000-000-0000",
      address:"Test Address",
      address2:"",
      country:"US",
      state:"FL",
      city:"Test City",
      zip:"00000"
    };

    const secrets={
      acoEmail:"test@example.com",
      acoPassword:"TEST-ONLY-NOT-REAL",
      cardLabel:"TEST CARD",
      cardholder:"TEST CUSTOMER",
      acoCardNumber:"4111111111111111",
      expMonth:"12",
      expYear:"2030"
    };

    await saveEncryptedPackage(id,{
      submissionId:id,
      profile,
      secrets,
      cvvConfirmed:true,
      createdAt
    });

    const paid=await readJson(PAID_FILE,[]);
    paid.push({
      id,
      plan:{name:"STORAGE TEST",profiles:1,amount:0},
      profile,
      cvvConfirmed:true,
      createdAt,
      paidAt:createdAt,
      stripeSessionId:"TEST-NO-PAYMENT",
      stripeCustomerId:null
    });

    await writeJson(PAID_FILE,paid);

    res.json({ok:true,message:"Persistent storage test created."});
  }catch(err){
    console.error("Storage test failed:",err.message);
    res.status(500).json({error:"Storage test failed."});
  }
});
/* Stripe webhook must be raw and registered before JSON middleware. */
app.post("/api/stripe-webhook",express.raw({type:"application/json"}),async(req,res)=>{
  let event;
  try{event=stripe.webhooks.constructEvent(req.body,req.headers["stripe-signature"],process.env.STRIPE_WEBHOOK_SECRET)}
  catch(err){return res.status(400).send(`Webhook signature verification failed: ${err.message}`)}
  if(event.type==="checkout.session.completed"){
    const session=event.data.object, id=session.metadata?.submission_id;
    if(id){
      const pending=await readJson(PENDING_FILE,{}), entry=pending[id];
      if(entry){
        const record={id,plan:entry.plan,profile:entry.profile,cvvConfirmed:entry.cvvConfirmed===true,createdAt:entry.createdAt,paidAt:new Date().toISOString(),stripeSessionId:session.id,stripeCustomerId:session.customer||null};
        const paid=await readJson(PAID_FILE,[]); paid.push(record); await writeJson(PAID_FILE,paid);
        delete pending[id]; await writeJson(PENDING_FILE,pending);
        try{await sendNotification(record)}catch(e){console.error("Notification failed:",e.message)}
      }
    }
  }
  res.json({received:true});
});

app.use(express.json({limit:"50kb"}));

app.get('/admin', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use(express.static(path.join(__dirname,"public")));

app.post("/api/admin/login",(req,res)=>{
  const ip=req.ip||"unknown",now=Date.now(),attempt=loginAttempts.get(ip)||{count:0,reset:now+15*60*1000};
  if(now>attempt.reset){attempt.count=0;attempt.reset=now+15*60*1000}
  if(attempt.count>=8)return res.status(429).json({error:"Too many attempts"});
  if(!process.env.ADMIN_PASSWORD||!safeEqual(req.body.password||"",process.env.ADMIN_PASSWORD)){attempt.count++;loginAttempts.set(ip,attempt);return res.status(401).json({error:"Invalid credentials"})}
  loginAttempts.delete(ip);const token=crypto.randomBytes(32).toString("hex");adminSessions.set(token,{expires:now+30*60*1000});
  res.setHeader("Set-Cookie",`sng_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800${BASE_URL.startsWith("https://")?"; Secure":""}`);res.json({ok:true});
});
app.post("/api/admin/logout",(req,res)=>{const token=parseCookies(req).sng_admin;if(token)adminSessions.delete(token);res.setHeader("Set-Cookie","sng_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");res.json({ok:true})});
app.get("/api/admin/submissions",requireAdmin,async(req,res)=>{
  const paid=await readJson(PAID_FILE,[]),out=[];
  for(const record of paid){try{const enc=await readJson(path.join(SECRET_DIR,`${record.id}.encrypted.json`),null);if(!enc)continue;const pkg=decryptJson(enc);out.push({...record,secrets:pkg.secrets,cvvConfirmed:pkg.cvvConfirmed===true||record.cvvConfirmed===true})}catch(e){console.error("Admin decrypt failed",record.id,e.message)}}
  res.json(out.sort((a,b)=>String(b.paidAt).localeCompare(String(a.paidAt))));
});
app.delete("/api/admin/submissions/:id",requireAdmin,async(req,res)=>{
  const id=String(req.params.id||"");
  if(!/^[a-f0-9-]{30,40}$/i.test(id)){
    return res.status(400).json({error:"Bad id"});
  }

  try{
    await fs.unlink(path.join(SECRET_DIR,`${id}.encrypted.json`));
  }catch{}

  const paid=await readJson(PAID_FILE,[]);
  await writeJson(PAID_FILE,paid.filter(record=>record.id!==id));

  res.json({ok:true});
});


app.post("/api/create-checkout-session",async(req,res)=>{
  try{
    const tier=Number(req.body.tier),plan=PLANS[tier],profile=sanitizeProfile(req.body.profile||{}),secrets=sanitizeSecrets(req.body.secrets||{}),cvvConfirmed=req.body.cvvConfirmed===true;
    if(!plan||!plan.priceId||!validProfile(profile)||!validSecrets(secrets)||!cvvConfirmed)return res.status(400).json({error:"Please complete all required profile and ACO setup fields."});
    const id=crypto.randomUUID();
    await saveEncryptedPackage(id,{submissionId:id,profile,secrets,cvvConfirmed,createdAt:new Date().toISOString()});
    const pending=await readJson(PENDING_FILE,{});
    pending[id]={id,plan:{name:plan.name,profiles:plan.profiles,amount:plan.amount},profile,cvvConfirmed,createdAt:new Date().toISOString()};
    await writeJson(PENDING_FILE,pending);
    const session=await stripe.checkout.sessions.create({mode:"subscription",line_items:[{price:plan.priceId,quantity:1}],customer_email:profile.email,
      client_reference_id:id,metadata:{submission_id:id,tier:String(tier)},subscription_data:{metadata:{submission_id:id,tier:String(tier)}},
      success_url:`${BASE_URL}/?payment=success`,cancel_url:`${BASE_URL}/?payment=cancelled`,billing_address_collection:"auto",allow_promotion_codes:true});
    res.json({url:session.url});
  }catch(err){console.error(err);res.status(500).json({error:"Unable to create checkout session. Check the secure server and Stripe configuration."})}
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`SLABSNGRABSACO running at ${BASE_URL}`));
