'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validate,testForwarding}=require('../emailgen-forwarding-test');
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
