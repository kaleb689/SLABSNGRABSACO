import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const b64 = bytes => Buffer.from(bytes).toString("base64url");
const unb64 = value => Buffer.from(String(value || ""), "base64url");
const pending = new Map();
const MAX_AGE = 5 * 60 * 1000;
const MAX_KEYS = 5;
function readCbor(buffer, start = 0) {
  let i = start;
  function item() {
    if (i >= buffer.length) throw Error("Invalid CBOR");
    const head = buffer[i++], major = head >> 5, ai = head & 31;
    let n;
    if (ai < 24) n = ai;
    else if (ai === 24) n = buffer[i++];
    else if (ai === 25) { n = buffer.readUInt16BE(i); i += 2; }
    else if (ai === 26) { n = buffer.readUInt32BE(i); i += 4; }
    else if (ai === 27) { n = Number(buffer.readBigUInt64BE(i)); i += 8; }
    else throw Error("Unsupported CBOR length");
    if (!Number.isSafeInteger(n) || n > 1048576) throw Error("CBOR size limit");
    if (major === 0) return n;
    if (major === 1) return -1 - n;
    if (major === 2 || major === 3) {
      if (i + n > buffer.length) throw Error("Truncated CBOR");
      const raw = buffer.subarray(i, i + n); i += n;
      return major === 2 ? raw : raw.toString("utf8");
    }
    if (major === 4) return Array.from({length:n}, () => item());
    if (major === 5) { const m = new Map(); for(let k=0;k<n;k++) m.set(item(),item()); return m; }
    if (major === 6) return item();
    if (major === 7 && ai === 20) return false;
    if (major === 7 && ai === 21) return true;
    if (major === 7 && ai === 22) return null;
    throw Error("Unsupported CBOR");
  }
  const value = item();
  return {value, offset:i};
}
function authData(buffer, rpId) {
  if(buffer.length < 37) throw Error("Authenticator data missing");
  const hash = crypto.createHash("sha256").update(rpId).digest();
  if(!crypto.timingSafeEqual(buffer.subarray(0,32),hash)) throw Error("Invalid relying party");
  const flags=buffer[32], counter=buffer.readUInt32BE(33);
  if(!(flags & 1)) throw Error("User presence required");
  if(!(flags & 4)) throw Error("User verification required");
  return {flags,counter};
}
function clientData(raw, type, challenge, origin) {
  const data=JSON.parse(raw.toString("utf8"));
  if(data.type!==type || data.challenge!==challenge || data.origin!==origin || data.crossOrigin===true) throw Error("Invalid passkey challenge or origin");
}
function publicKey(cose) {
  if(!(cose instanceof Map)) throw Error("Invalid credential key");
  const alg=cose.get(3);
  if(cose.get(1)===2 && alg===-7 && cose.get(-1)===1) {
    const x=cose.get(-2), y=cose.get(-3);
    if(!Buffer.isBuffer(x)||x.length!==32||!Buffer.isBuffer(y)||y.length!==32) throw Error("Invalid P-256 key");
    return {alg, jwk:{kty:"EC",crv:"P-256",x:b64(x),y:b64(y)}};
  }
  if(cose.get(1)===3 && alg===-257) {
    const n=cose.get(-1),e=cose.get(-2);
    if(!Buffer.isBuffer(n)||!Buffer.isBuffer(e)||n.length<256) throw Error("Invalid RSA key");
    return {alg,jwk:{kty:"RSA",n:b64(n),e:b64(e)}};
  }
  throw Error("Unsupported passkey algorithm");
}
function sessionCookie(req, token) {
  return `sng_admin=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800; Priority=High${req.secure || req.headers["x-forwarded-proto"]==="https" ? "; Secure" : ""}`;
}
export function attachAdminPasskeys(app, {dataDir,baseUrl,requireAdmin,adminSessions,adminSessionKey,adminUserAgentHash,sessionIdleMs,sessionMaxAgeMs}) {
  const file=path.join(dataDir,"admin-passkeys.json");
  const origin=new URL(baseUrl).origin;
  const rpId=new URL(baseUrl).hostname;
  const sendError=(res,error)=>res.status(400).json({error:error?.message||"Passkey verification failed"});
  async function read(){try{const x=JSON.parse(await fs.readFile(file,"utf8"));return Array.isArray(x)?x:[]}catch{return [];}}
  async function write(keys){await fs.mkdir(dataDir,{recursive:true,mode:0o700});const tmp=file+"."+crypto.randomBytes(8).toString("hex");await fs.writeFile(tmp,JSON.stringify(keys,null,2),{mode:0o600});await fs.rename(tmp,file);}
  function challenge(req,kind) {
    const id=crypto.randomUUID(),value=b64(crypto.randomBytes(32));
    for(const [key,item] of pending) if(item.expires<Date.now()) pending.delete(key);
    pending.set(id,{value,kind,expires:Date.now()+MAX_AGE,ua:adminUserAgentHash(req),session:req.adminSession?.key||null});
    return {id,value};
  }
  function take(req,id,kind) {
    const p=pending.get(String(id));pending.delete(String(id));
    if(!p||p.kind!==kind||p.expires<Date.now()||p.ua!==adminUserAgentHash(req)||(kind==="register"&&p.session!==req.adminSession?.key)) throw Error("Passkey request expired. Try again.");
    return p;
  }
  app.get("/api/admin/passkeys",requireAdmin,async(_req,res)=>{const keys=await read();res.set("Cache-Control","no-store");res.json({count:keys.length,credentials:keys.map(x=>({id:x.id,createdAt:x.createdAt,lastUsedAt:x.lastUsedAt||null}))});});
  app.post("/api/admin/passkeys/register/options",requireAdmin,async(req,res)=>{
    const keys=await read();if(keys.length>=MAX_KEYS)return res.status(400).json({error:"Maximum registered devices reached."});
    const c=challenge(req,"register");
    res.json({requestId:c.id,publicKey:{challenge:c.value,rp:{name:"SLABSNGRABSACO Admin",id:rpId},user:{id:b64(Buffer.from("slabsngrabsaco-admin")),name:"Admin",displayName:"Admin"},pubKeyCredParams:[{type:"public-key",alg:-7},{type:"public-key",alg:-257}],authenticatorSelection:{residentKey:"required",userVerification:"required"},attestation:"none",timeout:300000,excludeCredentials:keys.map(x=>({type:"public-key",id:x.id}))}});
  });
  app.post("/api/admin/passkeys/register/verify",requireAdmin,async(req,res)=>{
    try {
      const p=take(req,req.body?.requestId,"register"),c=req.body?.credential;
      if(c?.type!=="public-key"||!c?.response?.clientDataJSON||!c?.response?.attestationObject)throw Error("Missing passkey registration data");
      const client=unb64(c.response.clientDataJSON);
      clientData(client,"webauthn.create",p.value,origin);
      const att=readCbor(unb64(c.response.attestationObject)).value;
      if(!(att instanceof Map)||att.get("fmt")!=="none")throw Error("Unsupported attestation format");
      const raw=att.get("authData");if(!Buffer.isBuffer(raw))throw Error("Missing authenticator data");
      const ad=authData(raw,rpId);
      if(!(ad.flags&64))throw Error("Attested credential missing");
      const len=raw.readUInt16BE(53),id=raw.subarray(55,55+len);
      if(id.length!==len||len<16||len>1024)throw Error("Invalid credential ID");
      const cose=readCbor(raw,55+len).value;
      const key=publicKey(cose);
      if(b64(id)!==c.id)throw Error("Credential ID mismatch");
      const keys=await read();if(keys.some(x=>x.id===c.id)||keys.length>=MAX_KEYS)throw Error("Credential already registered or limit reached");
      keys.push({id:c.id,alg:key.alg,jwk:key.jwk,counter:ad.counter,createdAt:new Date().toISOString()});
      await write(keys);
      res.json({ok:true});
    }catch(e){sendError(res,e);}
  });
  app.post("/api/admin/passkeys/login/options",async(req,res)=>{
    const keys=await read();if(!keys.length)return res.status(404).json({error:"No Face ID passkey registered. Sign in with Google Authenticator first."});
    const c=challenge(req,"login");
    res.json({requestId:c.id,publicKey:{challenge:c.value,rpId,allowCredentials:keys.map(x=>({type:"public-key",id:x.id})),userVerification:"required",timeout:300000}});
  });
  app.post("/api/admin/passkeys/login/verify",async(req,res)=>{
    try {
      const p=take(req,req.body?.requestId,"login"),c=req.body?.credential;
      if(c?.type!=="public-key"||!c?.response?.authenticatorData||!c?.response?.clientDataJSON||!c?.response?.signature)throw Error("Missing passkey login data");
      const keys=await read(),record=keys.find(x=>x.id===c.id);
      if(!record)throw Error("Unknown passkey");
      const client=unb64(c.response.clientDataJSON);
      clientData(client,"webauthn.get",p.value,origin);
      const raw=unb64(c.response.authenticatorData),ad=authData(raw,rpId);
      const signed=Buffer.concat([raw,crypto.createHash("sha256").update(client).digest()]);
      const key=crypto.createPublicKey({key:record.jwk,format:"jwk"});
      const ok=crypto.verify(record.alg===-257?"RSA-SHA256":"sha256",signed,key,unb64(c.response.signature));
      if(!ok)throw Error("Invalid passkey signature");
      if(record.counter>0&&ad.counter>0&&ad.counter<=record.counter)throw Error("Passkey counter verification failed");
      record.counter=ad.counter;record.lastUsedAt=new Date().toISOString();await write(keys);
      const token=crypto.randomBytes(32).toString("hex"),now=Date.now(),absoluteExpires=now+sessionMaxAgeMs;
      adminSessions.set(adminSessionKey(token),{createdAt:now,absoluteExpires,idleExpires:Math.min(now+sessionIdleMs,absoluteExpires),userAgentHash:adminUserAgentHash(req)});
      res.setHeader("Set-Cookie",sessionCookie(req,token));
      res.json({ok:true});
    }catch(e){sendError(res,e);}
  });
  app.post("/api/admin/passkeys/remove",requireAdmin,async(req,res)=>{
    const keys=await read();const next=keys.filter(x=>x.id!==req.body?.id);
    if(next.length===keys.length)return res.status(404).json({error:"Passkey not found"});
    await write(next);res.json({ok:true});
  });
}
