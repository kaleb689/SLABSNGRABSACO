// Operator-approved shipping inboxes only. Never discover customer mailboxes.
export const MAX_OPERATOR_IMAP_INBOXES = 25;
export const OPERATOR_IMAP_HOSTS = Object.freeze({
  google: Object.freeze({host:"imap.gmail.com",port:993,label:"Google / Gmail"}),
  microsoft: Object.freeze({host:"outlook.office365.com",port:993,label:"Microsoft"}),
  yahoo: Object.freeze({host:"imap.mail.yahoo.com",port:993,label:"Yahoo"})
});
const autoProvider = Object.freeze({
  "gmail.com":"google","googlemail.com":"google",
  "outlook.com":"microsoft","hotmail.com":"microsoft","live.com":"microsoft",
  "yahoo.com":"yahoo","ymail.com":"yahoo"
});
export function operatorImapEmail(value) {
  return String(value||"").trim().toLowerCase();
}
export function operatorImapProvider(email, choice="auto") {
  const provider=String(choice||"auto").trim().toLowerCase();
  const chosen=provider==="auto" ? autoProvider[operatorImapEmail(email).split("@")[1]||""] : provider;
  return chosen && OPERATOR_IMAP_HOSTS[chosen] ? chosen : null;
}
export function validateOperatorImapEntry(input, {existingPassword=false}={}) {
  const email=operatorImapEmail(input?.email);
  if(email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("Enter a valid inbox email address.");
  const provider=operatorImapProvider(email,input?.provider);
  if(!provider)throw new Error("Choose Google, Microsoft or Yahoo IMAP for this inbox.");
  const supplied=String(input?.password||"");
  if(!existingPassword && (supplied.length<6||supplied.length>512))
    throw new Error("Enter an IMAP app password (6 to 512 characters).");
  if(existingPassword && supplied && (supplied.length<6||supplied.length>512))
    throw new Error("Enter an IMAP app password (6 to 512 characters).");
  const label=String(input?.label||"").trim();
  if(label.length>80)throw new Error("Inbox name must be 80 characters or shorter.");
  return {email,provider,label,enabled:input?.enabled!==false,...(supplied?{password:supplied}:{})};
}
export function combineOperatorImapSources(environment=[],stored=[]) {
  const seen=new Set(),combined=[];
  for(const item of [...environment,...stored]){
    const email=operatorImapEmail(item?.email);
    if(!email||seen.has(email))continue;
    seen.add(email);
    combined.push({...item,email,enabled:item.enabled!==false});
  }
  return combined;
}
export function publicOperatorImapEntry(item, health=null, now=Date.now()) {
  const h=health||{};
  const configured=Boolean(item.password && (item.managedHost || OPERATOR_IMAP_HOSTS[item.provider]));
  const lastScan=Date.parse(h.lastScanAt||"");
  const healthy=Number.isFinite(lastScan)&&lastScan<=now&&now-lastScan<=15*60*1000;
  const state=!item.enabled?"paused":!configured?"not_configured":h.lastError?"error":
    healthy?"healthy":h.lastConnectedAt?"stale":"pending";
  return {
    id:String(item.id),email:operatorImapEmail(item.email),
    label:String(item.label||"").slice(0,80),provider:item.provider||"custom",
    source:item.source==="environment"?"environment":"admin",
    enabled:item.enabled!==false,passwordConfigured:Boolean(item.password),configured,
    createdAt:item.createdAt||null,updatedAt:item.updatedAt||null,
    status:state,lastAttemptAt:h.lastAttemptAt||null,lastConnectedAt:h.lastConnectedAt||null,
    lastScanAt:h.lastScanAt||null,lastError:h.lastError||null,
    lastTestAt:h.lastTestAt||null,
    messagesExamined:Number(h.messagesExamined||0),
    matchedMessages:Number(h.matchedMessages||0),
    candidateUpdates:Number(h.candidateUpdates||0)
  };
}
