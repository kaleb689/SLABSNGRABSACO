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
