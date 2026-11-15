'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validate,testForwarding,reuseSavedReceiverCredentials,fallbackBoxes,IMAP_RECEIPT_WAIT_MS}=require('../emailgen-forwarding-test');
const mailbox={mailbox:'owner@example.test',password:'test-password-never-persisted',sender:'sender@example.test',senderPassword:'sender-password-never-persisted',smtpHost:'smtp.example.testmail',imapHost:'imap.example.testmail'};
test('Forwarding test input rejects duplicate, wrong-domain and missing credentials',()=>{
 const base={...mailbox,aliases:['first@sng.sarl']};
 assert.deepEqual(validate(base).aliases,['first@sng.sarl']);
 for(const bad of [
  {...base,aliases:['first@other.example']},
  {...base,aliases:['first@sng.sarl','first@sng.sarl']},
  {...base,password:''},
  {...base,senderPassword:''},
  {...base,sender:base.mailbox},
  {...base,sender:'alias@sng.sarl'},
  {...base,smtpHost:'localhost'},
  {...base,aliases:Array(101).fill('first@sng.sarl')}
 ])assert.throws(()=>validate(bad));
});
test('Gmail dots, plus tags and googlemail.com cannot bypass separate-sender validation',()=>{
 for(const sender of ['SLABS.N.GRABS@gmail.com','slabsngrabs+test@gmail.com','slabsngrabs@googlemail.com'])
  assert.throws(()=>validate({...mailbox,mailbox:'slabsngrabs@gmail.com',sender,aliases:['first@sng.sarl']}),/different sending mailbox/);
});
test('Only exact unique test receipt in destination IMAP counts as a passed forward',async()=>{
 const sent=[],received=[];
 const mail={createTransport:options=>{assert.deepEqual(options.auth,{user:mailbox.sender,pass:mailbox.senderPassword});return {async sendMail(x){sent.push(x);if(x.to==='pass@sng.sarl')received.push({envelope:{subject:x.subject},internalDate:new Date()});},close(){}};}};
 class IMAP {
  constructor(options){assert.deepEqual(options.auth,{user:mailbox.mailbox,pass:mailbox.password});}
  async connect(){}async getMailboxLock(){return {release(){}};}
  async search(){return received.map((_,i)=>i+1);}
  async *fetch(){for(const msg of received)yield msg;}
  async logout(){}
 }
 const result=await testForwarding({...mailbox,aliases:['pass@sng.sarl','fail@sng.sarl']},{mail,IMAP,delay:async()=>{},now:(()=>{let at=Date.now();return ()=>{at+=30000;return at;};})()});
 assert.equal(result.delivered,1);
 assert.equal(result.sentButUnconfirmed,1);
 assert.deepEqual(result.results.map(x=>x.status),['delivered','unconfirmed']);
 assert.equal(sent.length,2);
 assert.ok(sent[0].subject.startsWith('ACO Studio forwarding test '));
 assert.ok(sent.every(x=>x.from===mailbox.sender));
 assert.ok(!JSON.stringify(result).includes(mailbox.password));
 assert.ok(!JSON.stringify(result).includes(mailbox.senderPassword));
});
test('SMTP accepted is never misrepresented as delivered when IMAP is empty',async()=>{
 const mail={createTransport:()=>({async sendMail(){},close(){}})};
 class IMAP {
  async connect(){}async getMailboxLock(){return {release(){}};}
  async search(){return [];}
  async *fetch(){}async logout(){}
 }
 const res=await testForwarding({...mailbox,aliases:['example@sng.sarl']},{mail,IMAP,delay:async()=>{},now:(()=>{let at=Date.now();return ()=>{at+=100000;return at;};})()});
 assert.equal(res.delivered,0);assert.equal(res.sentButUnconfirmed,1);
 assert.equal(res.results[0].status,'unconfirmed');
});
test('Cloudflare missing-email notices do not count as delivery receipts',async()=>{
 const mail={createTransport:()=>({async sendMail(){},close(){}})};
 class IMAP {
  async connect(){}async getMailboxLock(){return {release(){}};}
  async search(){return [1];}
  async *fetch(){yield {envelope:{subject:'Cloudflare Email Routing: Missing email from sender@example.test'},internalDate:new Date()};}
  async logout(){}
 }
 const result=await testForwarding({...mailbox,aliases:['first@sng.sarl']},{mail,IMAP,delay:async()=>{},now:(()=>{let n=Date.now();return ()=>n+=100000;})()});
 assert.equal(result.delivered,0);assert.equal(result.sentButUnconfirmed,1);
});


test('Only exact nonce-matched delivered test messages are moved to Trash in receiving Inbox and sender Sent',async()=>{
 const messages={receiver:[],sender:[]},moves=[];
 const cfg={...mailbox,senderImapHost:'imap.sent-mail.example.com'};
 const mail={createTransport:()=>({async sendMail({subject,to}){
  messages.receiver.push({uid:101+messages.receiver.length,envelope:{subject},internalDate:new Date()});
  messages.sender.push({uid:201+messages.sender.length,envelope:{subject},internalDate:new Date()});
  messages.receiver.push({uid:99,envelope:{subject:'Important unrelated mail'},internalDate:new Date()});
 },close(){}})};
 class IMAP {
  constructor({auth}){this.kind=auth.user===cfg.sender?'sender':'receiver';this.box='';}
  async connect(){}
  async getMailboxLock(box){this.box=box;return {release(){}};}
  async list(){return [{path:'INBOX'},{path:'[Gmail]/Sent Mail',specialUse:'\\Sent'},{path:'[Gmail]/Trash',specialUse:'\\Trash'}];}
  async search(){return this.kind==='receiver'?[101,99]:[201];}
  async *fetch(){yield* messages[this.kind];}
  async messageMove(uids,to){moves.push({kind:this.kind,uids:[...uids],to});return true;}
  async logout(){}
 }
 const progress=[];
 const result=await testForwarding({...cfg,aliases:['verified@sng.sarl']},
  {mail,IMAP,onProgress:item=>progress.push(item),delay:async()=>{},now:Date.now});
 assert.equal(result.delivered,1);
 assert.equal(result.receiverMovedToTrash,1);
 assert.equal(result.senderMovedToTrash,1);
 assert.equal(result.cleanupPending,0);
 assert.deepEqual(moves,[{kind:'receiver',uids:[101],to:'[Gmail]/Trash'},{kind:'sender',uids:[201],to:'[Gmail]/Trash'}]);
 assert.ok(progress.some(x=>x.status==='delivered'));
 assert.ok(!moves.some(x=>x.uids.includes(99)),'unrelated inbox message must never be moved');
 assert.ok(!JSON.stringify(result).includes(cfg.password));
});
test('SMTP rate limit stops next sends; skipped addresses are not reported as failures',async()=>{
 const attempted=[],events=[];
 const mail={createTransport:()=>({async sendMail(x){
  attempted.push(x.to);
  if(x.to==='second@sng.sarl'){const err=new Error('429 sending quota exceeded');err.responseCode=429;throw err;}
 },close(){}})};
 class IMAP {async connect(){}async getMailboxLock(){return {release(){}};}async search(){return [];}
  async *fetch(){}async logout(){}}
 const cfg={...mailbox,aliases:['first@sng.sarl','second@sng.sarl','third@sng.sarl']};
 const result=await testForwarding(cfg,{mail,IMAP,onProgress:x=>events.push(x),delay:async()=>{},now:(()=>{
  let now=Date.now();return ()=>{now+=100000;return now;};})()});
 assert.equal(result.rateLimited,true);
 assert.deepEqual(attempted,['first@sng.sarl','second@sng.sarl']);
 assert.deepEqual(result.results.map(x=>x.status),['unconfirmed','send_failed','not_attempted']);
 assert.equal(result.skipped,1);
 assert.equal(result.sendFailed,1);
 assert.ok(!events.some(x=>x.alias==='third@sng.sarl'));
});

test('Adding a new sender reuses only exact saved receiver IMAP credentials',()=>{
 const found={mailbox:'receiver@gmail.com',password:'saved-imap-password',imapHost:'imap.gmail.com'};
 const calls=[],store={read:arg=>{calls.push(arg);return arg.mailbox==='receiver@gmail.com'?found:null;}};
 const config={mailbox:'receiver@gmail.com',sender:'new-sender@gmail.com',senderPassword:'new-sender-secret',
  password:'',imapHost:'imap.wrong.test',reuseReceiverCredentials:true};
 const merged=reuseSavedReceiverCredentials(config,store);
 assert.equal(merged.password,'saved-imap-password');
 assert.equal(merged.imapHost,'imap.gmail.com');
 assert.equal(merged.senderPassword,'new-sender-secret');
 assert.deepEqual(calls,[{mailbox:'receiver@gmail.com'}]);
 assert.throws(()=>reuseSavedReceiverCredentials({...config,mailbox:'other@gmail.com'},store),/No saved receiver credentials/);
 assert.equal(reuseSavedReceiverCredentials({...config,password:'new-receiver-secret'},store).password,'new-receiver-secret');
 assert.equal(reuseSavedReceiverCredentials({...config,reuseReceiverCredentials:false},store).password,'');
});

test('Mail found only in Gmail All Mail is accurately confirmed by exact nonce, not SMTP success',async()=>{
 const folders=[{path:'INBOX'},{path:'[Gmail]/All Mail',specialUse:'\\\\All'},{path:'[Gmail]/Spam',specialUse:'\\\\Junk'},
  {path:'[Gmail]/Trash',specialUse:'\\\\Trash'}];
 const actual=[],moves=[];
 const mail={createTransport:()=>({async sendMail(info){
  actual.push({envelope:{subject:'Fwd: '+info.subject},internalDate:new Date()});
 },close(){}})};
 class IMAP{
  constructor(){this.folder='';}
  async connect(){}async getMailboxLock(folder){this.folder=folder;return {release(){}};}
  async list(){return folders;}
  async search(){return this.folder==='[Gmail]/All Mail'?[30]:[];}
  async *fetch(){if(this.folder==='[Gmail]/All Mail')yield* actual;}
  async messageMove(ids,folder){moves.push({ids,folder});return true;}
  async logout(){}
 }
 const result=await testForwarding({...mailbox,aliases:['pass@sng.sarl']},{
  mail,IMAP,delay:async()=>{},now:(()=>{let n=Date.now();return ()=>n+=16000;})()
 });
 assert.equal(result.delivered,1,'exact subject/nonce in All Mail is a verified receipt');
 assert.equal(result.sentButUnconfirmed,0);
 assert.deepEqual(result.results.map(r=>r.status),['delivered']);
 assert.equal(result.receiptDiagnostics.discoveredOutsideInbox,1);
 assert.ok(result.receiptDiagnostics.folders.includes('[Gmail]/All Mail'));
 assert.equal(result.cleanupPending,0,'no false cleanup warning for All Mail');
 assert.equal(moves.length,0,'never move emails in filtered folders to Trash');
});
test('Mail found only in Gmail Spam is verified only with matching test ID; unrelated mail is untouched',async()=>{
 const messages=[],moved=[];
 const mail={createTransport:()=>({async sendMail(info){messages.push({envelope:{subject:info.subject},internalDate:new Date()});},close(){}})};
 class IMAP{
  constructor(){this.folder='';}
  async connect(){}async getMailboxLock(folder){this.folder=folder;return {release(){}};}
  async list(){return [{path:'INBOX'},{path:'[Gmail]/All Mail',specialUse:'\\\\All'}, {path:'[Gmail]/Spam',specialUse:'\\\\Junk'}];}
  async search(){return this.folder==='[Gmail]/Spam'?[4,5]:[];}
  async *fetch(){if(this.folder==='[Gmail]/Spam'){
   yield {envelope:{subject:'Unrelated message'},internalDate:new Date()};
   yield* messages;
  }}
  async messageMove(ids,folder){moved.push({ids,folder});}
  async logout(){}
 }
 const result=await testForwarding({...mailbox,aliases:['spam@sng.sarl']},{
  mail,IMAP,delay:async()=>{},now:(()=>{let n=Date.now();return ()=>n+=16000;})()
 });
 assert.equal(result.delivered,1);
 assert.equal(result.receiptDiagnostics.discoveredOutsideInbox,1);
 assert.ok(result.receiptDiagnostics.folders.includes('[Gmail]/Spam'));
 assert.deepEqual(moved,[],'no Spam messages moved or deleted');
});
test('No exact receipt in any folder must stay amber and bound the wait to 15 seconds per group',async()=>{
 let t=Date.now(),delayCalls=0;
 const mail={createTransport:()=>({async sendMail(){},close(){}})};
 class IMAP{
  constructor(){this.folder='';}
  async connect(){}async getMailboxLock(folder){this.folder=folder;return {release(){}};}
  async list(){return [{path:'INBOX'},{path:'[Gmail]/All Mail',specialUse:'\\\\All'}];}
  async search(){return this.folder==='[Gmail]/All Mail'?[1]:[];}
  async *fetch(){yield {envelope:{subject:'Not a valid ACO test nonce'},internalDate:new Date(t)};}
  async logout(){}
 }
 const result=await testForwarding({...mailbox,aliases:['missing@sng.sarl']},{
  mail,IMAP,now:()=>t,delay:async(ms)=>{delayCalls++;t+=ms;}
 });
 assert.equal(IMAP_RECEIPT_WAIT_MS,15000);
 assert.equal(result.receiptDiagnostics.waitMs,15000);
 assert.ok(delayCalls<=5,'no per-group 90-second wait');
 assert.equal(result.delivered,0);
 assert.equal(result.sentButUnconfirmed,1);
 assert.equal(result.results[0].status,'unconfirmed');
 assert.ok(result.receiptDiagnostics.folders.includes('[Gmail]/All Mail'));
});
test('Fallback folder discovery uses Gmail All Mail and Spam special-use flags or names',()=>{
 assert.deepEqual(fallbackBoxes([{path:'INBOX'}, {path:'[Gmail]/All Mail',specialUse:'\\\\All'},
  {path:'[Gmail]/Spam',specialUse:'\\\\Junk'}]),['[Gmail]/All Mail','[Gmail]/Spam']);
 assert.deepEqual(fallbackBoxes([{path:'INBOX'}, {path:'Custom/All Mail'}, {path:'Custom/Spam'}]),
  ['Custom/All Mail','Custom/Spam']);
});

test('Incoming mail with rewritten subject but intact unique test ID in body is verified',async()=>{
 const messages=[],sent=[];
 const mail={createTransport:()=>({async sendMail(info){
  sent.push(info);
  messages.push({uid:61,internalDate:new Date(),
   envelope:{subject:'A forwarded message',from:[{address:mailbox.sender}]},
   source:Buffer.from('From: '+mailbox.sender+'\r\nTo: '+mailbox.mailbox+
    '\r\nSubject: A forwarded message\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nOriginal unique test ID: '+info.subject)});
 },close(){}})};
 class IMAP{
  constructor(){this.folder='INBOX';}
  async connect(){}async getMailboxLock(folder){this.folder=folder;return {release(){}};}
  async search(query){assert.ok(query.since instanceof Date,'no SUBJECT-only search may exclude rewritten mail');return [61];}
  async *fetch(){if(this.folder==='INBOX')yield* messages;}
  async logout(){}
 }
 const result=await testForwarding({...mailbox,aliases:['rewrite@sng.sarl']},
  {mail,IMAP,now:Date.now,delay:async()=>{}});
 assert.equal(result.delivered,1);
 assert.equal(result.sentButUnconfirmed,0);
 assert.equal(result.receiptDiagnostics.matchMethods.source,1);
 assert.ok(sent[0].headers['X-ACO-Test-ID']);
 assert.ok(result.receiptDiagnostics.recentCount>0);
});
test('MIME base64 forwarded body is decoded before matching the full unique test ID',async()=>{
 const messages=[];
 const mail={createTransport:()=>({async sendMail(info){
  const encoded=Buffer.from('Forwarded original note. Unique test ID: '+info.subject).toString('base64');
  messages.push({uid:71,internalDate:new Date(),
   envelope:{subject:'Cloud forwarding notice',from:[{address:mailbox.sender}]},
   source:Buffer.from('From: '+mailbox.sender+'\r\nTo: '+mailbox.mailbox+
    '\r\nSubject: Cloud forwarding notice\r\nMIME-Version: 1.0\r\n'+
    'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n'+encoded+'\r\n')});
 },close(){}})};
 class IMAP{
  constructor(){this.folder='INBOX';}
  async connect(){}async getMailboxLock(folder){this.folder=folder;return {release(){}};}
  async search(query){assert.ok(query.since instanceof Date);return [71];}
  async *fetch(){if(this.folder==='INBOX')yield* messages;}
  async logout(){}
 }
 const result=await testForwarding({...mailbox,aliases:['encoded@sng.sarl']},{mail,IMAP,now:Date.now,delay:async()=>{}});
 assert.equal(result.delivered,1);
 assert.equal(result.receiptDiagnostics.matchMethods['decoded-body'],1);
 assert.equal(result.sentButUnconfirmed,0);
});
test('Bounce quoting valid marker must not be counted as a delivered forwarding email',async()=>{
 const messages=[];
 const mail={createTransport:()=>({async sendMail(info){
  messages.push({uid:81,internalDate:new Date(),
   envelope:{subject:'Mail Delivery Subsystem: Delivery failure',from:[{address:'mailer-daemon@example.org'}]},
   source:Buffer.from('From: mailer-daemon@example.org\r\nSubject: Delivery failure\r\n\r\n'+info.subject)});
 },close(){}})};
 class IMAP{
  async connect(){}async getMailboxLock(){return {release(){}};}
  async search(query){assert.ok(query.since instanceof Date);return [81];}
  async *fetch(){yield* messages;}
  async logout(){}
 }
 const result=await testForwarding({...mailbox,aliases:['bounce@sng.sarl']},{
  mail,IMAP,delay:async()=>{},now:(()=>{let at=Date.now();return ()=>at+=20000;})()
 });
 assert.equal(result.delivered,0);
 assert.equal(result.sentButUnconfirmed,1);
 assert.equal(result.receiptDiagnostics.exactMatches,0);
});
test('Delayed message in Spam is polled within the same bounded receipt interval',async()=>{
 const delivered=[],clock={t:Date.now(),loops:0};
 const mail={createTransport:()=>({async sendMail(info){delivered.push({uid:91,
  internalDate:new Date(),envelope:{subject:'Subject changed'},
  source:Buffer.from('From: forwarder@example.org\r\nSubject: Subject changed\r\n\r\n'+info.subject)});},close(){}})};
 class IMAP{
  constructor(){this.folder='INBOX';}
  async connect(){}async getMailboxLock(box){this.folder=box;return {release(){}};}
  async list(){return [{path:'INBOX'},{path:'[Gmail]/All Mail',specialUse:'\\\\All'},{path:'[Gmail]/Spam',specialUse:'\\\\Junk'}];}
  async search(query){assert.ok(query.since instanceof Date);return this.folder==='[Gmail]/Spam'&&clock.loops>=1?[91]:[];}
  async *fetch(){if(this.folder==='[Gmail]/Spam')yield* delivered;}
  async logout(){}
 }
 const result=await testForwarding({...mailbox,aliases:['delay@sng.sarl']},{mail,IMAP,
  now:()=>clock.t,delay:async(ms)=>{clock.loops++;clock.t+=ms;}
 });
 assert.equal(result.delivered,1);
 assert.equal(result.receiptDiagnostics.discoveredOutsideInbox,1);
 assert.ok(clock.loops>=1);
 assert.ok(result.receiptDiagnostics.waitMs<=15000);
});

test('Explicit one-email diagnosis waits up to 60 seconds for delayed proof, without changing normal bulk 15-second cap',async()=>{
 const captured=[],clock={value:Date.now(),rounds:0};
 const mail={createTransport:()=>({async sendMail(info){captured.push(info);},close(){}})};
 class IMAP{
  async connect(){}async getMailboxLock(){return {release(){}};}
  async search(query){assert.ok(query.since instanceof Date);return [];}
  async *fetch(){}async logout(){}
 }
 const result=await testForwarding({...mailbox,aliases:['diagnose@sng.sarl'],diagnostic:true},{
  mail,IMAP,now:()=>clock.value,delay:async(ms)=>{clock.rounds++;clock.value+=ms;}
 });
 assert.equal(captured.length,1);
 assert.equal(result.delivered,0);
 assert.equal(result.sentButUnconfirmed,1);
 assert.equal(result.receiptDiagnostics.waitMs,60000);
 assert.equal(clock.rounds,20);
 assert.equal(IMAP_RECEIPT_WAIT_MS,15000);
});
