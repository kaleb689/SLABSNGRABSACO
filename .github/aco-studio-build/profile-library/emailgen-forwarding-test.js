'use strict';
// Real end-to-end SMTP -> Cloudflare alias -> verified destination IMAP tests.
// Credentials are passed once over owner-only Electron IPC; never persisted or logged.
const crypto=require('node:crypto');
const VALID_ALIAS=/^[a-z0-9][a-z0-9._-]{0,63}@sng\.sarl$/i;
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST=/^[a-z0-9](?:[a-z0-9.-]{1,248})[a-z0-9]$/i;
function validate(input){
 if(!input||typeof input!=='object')throw Error('Mail test settings are required.');
 const mailbox=String(input.mailbox||'').trim().toLowerCase();
 const pass=String(input.password||'');
 const smtpHost=String(input.smtpHost||'').trim().toLowerCase();
 const imapHost=String(input.imapHost||'').trim().toLowerCase();
 const aliases=input.aliases;
 if(!EMAIL.test(mailbox)||!pass||pass.length>256)throw Error('Enter your verified inbox and its mail app password for a one-time test.');
 if(!HOST.test(smtpHost)||!smtpHost.includes('.')||!HOST.test(imapHost)||!imapHost.includes('.')||
    /(?:^|\.)(?:localhost|local|internal|invalid|test)$/i.test(smtpHost)||/(?:^|\.)(?:localhost|local|internal|invalid|test)$/i.test(imapHost))
  throw Error('Use valid public SMTP and IMAP hostnames.');
 if(!Array.isArray(aliases)||aliases.length<1||aliases.length>100)throw Error('Choose 1–100 live aliases to test.');
 const seen=new Set(),addresses=[];
 for(const item of aliases){
  const alias=String(item||'').trim().toLowerCase();
  if(!VALID_ALIAS.test(alias)||alias.includes('..')||seen.has(alias))throw Error('Aliases must be unique addresses on the verified business domain.');
  seen.add(alias);addresses.push(alias);
 }
 return {mailbox,pass,smtpHost,imapHost,aliases:addresses};
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function testForwarding(input,{mail=require('nodemailer'),IMAP=require('imapflow').ImapFlow,delay=sleep,now=Date.now}={}){
 const cfg=validate(input),started=now();
 const transporter=mail.createTransport({
  host:cfg.smtpHost,port:465,secure:true,
  auth:{user:cfg.mailbox,pass:cfg.pass},
  connectionTimeout:15000,greetingTimeout:15000,socketTimeout:30000,
  tls:{rejectUnauthorized:true}
 });
 const imap=new IMAP({
  host:cfg.imapHost,port:993,secure:true,
  auth:{user:cfg.mailbox,pass:cfg.pass},
  logger:false,disableAutoIdle:true,connectionTimeout:15000,
  socketTimeout:30000,tls:{rejectUnauthorized:true}
 });
 const tests=cfg.aliases.map(alias=>({alias,marker:'ACO Studio forwarding test '+crypto.randomBytes(12).toString('hex'),sent:false,received:false}));
 let connected=false,lock=null;
 try{
  await imap.connect();connected=true;
  lock=await imap.getMailboxLock('INBOX');
  for(const item of tests){
   try{
    await transporter.sendMail({
     from:cfg.mailbox,to:item.alias,subject:item.marker,
     text:'Owner-requested forwarding test. Each alias must arrive at your verified destination inbox. Test ID: '+item.marker
    });
    item.sent=true;
   }catch{item.sent=false;}
  }
  const sent=tests.filter(t=>t.sent);
  if(sent.length){
   // A sent SMTP message alone is not proof of forwarding. Confirm its exact
   // unique marker in the destination INBOX via independent IMAP retrieval.
   const deadline=now()+90000;
   do{
    const ids=await imap.search({subject:'ACO Studio forwarding test'}, {uid:true});
    if(ids.length){
     const recent=ids.slice(-500);
     for await(const message of imap.fetch(recent,{envelope:true,internalDate:true},{uid:true})){
      if(message.internalDate&&new Date(message.internalDate).getTime()<started-30000)continue;
      const subject=String(message.envelope?.subject||'');
      for(const item of sent)if(!item.received&&subject===item.marker)item.received=true;
     }
    }
    if(sent.every(x=>x.received))break;
    if(now()>=deadline)break;
    await delay(4000);
   }while(true);
  }
  return {total:tests.length,delivered:tests.filter(t=>t.received).length,
   sentButUnconfirmed:tests.filter(t=>t.sent&&!t.received).length,
   sendFailed:tests.filter(t=>!t.sent).length,
   results:tests.map(t=>({alias:t.alias,status:t.received?'delivered':t.sent?'unconfirmed':'send_failed'}))};
 }finally{
  try{lock?.release();}catch{}
  if(connected)try{await imap.logout();}catch{}
  try{transporter.close();}catch{}
 }
}
function register({ipcMain,requireOwner,requireCloudflareSession}){
 ipcMain.handle('email:forwarding-test',(event,request)=>{
  requireOwner(event);requireCloudflareSession(event);
  return testForwarding(request);
 });
}
module.exports={validate,testForwarding,register};
