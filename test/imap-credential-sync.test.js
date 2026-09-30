import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { authenticator } from 'otplib';
import { updateMatchingImap, effectiveAdminImap } from '../imap-credential-sync.js';

test('updates only matching IMAP fields, preserves other secrets, and prefers the newest saved copy', () => {
  const original = { acoEmail: 'old@gmail.com', acoPassword: 'old', card: 'sentinel', retailerPassword: 'untouched' };
  const next = updateMatchingImap(original, 'OLD@gmail.com', 'new@gmail.com', 'new', '2026-09-30T01:00:00Z');
  assert.equal(next.acoEmail, 'new@gmail.com'); assert.equal(next.card, 'sentinel');
  assert.equal(next.retailerPassword, 'untouched'); assert.equal(original.acoPassword, 'old');
  assert.equal(updateMatchingImap(original, 'other@gmail.com', 'another@gmail.com', 'new', ''), null);
  const entry = { email: 'old@gmail.com', password: 'saved', updatedAt: '2026-09-30T02:00:00Z' };
  assert.equal(effectiveAdminImap(original, [entry]).acoPassword, 'saved');
  assert.equal(effectiveAdminImap({ ...original, imapUpdatedAt: '2026-09-30T03:00:00Z' }, [entry]).acoPassword, 'old');
});

test('customer IMAP edits synchronize admin copies, preserve unrelated data, and report connection failures', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'imap-sync-test-'));
  const port = 46000 + Math.floor(Math.random()*4000), base = `http://127.0.0.1:${port}`;
  const secret = 'synthetic-imap-encryption-key', adminSecret = authenticator.generateSecret();
  const key = crypto.createHash('sha256').update(secret).digest();
  const encrypt = value => {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return { version: 1, alg: 'AES-256-GCM', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  };
  const decrypt = value => {
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv,'base64'));
    cipher.setAuthTag(Buffer.from(value.tag,'base64'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data,'base64')),cipher.final()]).toString());
  };
  const server = spawn('node', ['--import','./test/fixtures/imap-credentials.mjs','server.js'], {
    cwd: path.resolve(import.meta.dirname,'..'), stdio: 'ignore',
    env: { ...process.env, DATA_DIR:dataDir, PORT:String(port), BASE_URL:base, RESEND_API_KEY:'',
      STRIPE_SECRET_KEY:'sk_test_missing', STRIPE_TIER1_PRICE_ID:'price_test',
      CUSTOMER_SESSION_SECRET:'synthetic-session-secret-123456789', SUBMISSION_ENCRYPTION_KEY:secret,
      ADMIN_PASSWORD:'synthetic-admin-password', ADMIN_2FA_SECRET:adminSecret }
  });
  const request = async (route, method='GET', body, cookie='') => {
    const response = await fetch(base+route,{method,headers:{Origin:base,Cookie:cookie,'Content-Type':'application/json'},body:body&&JSON.stringify(body)});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const read = async name => JSON.parse(await fs.readFile(path.join(dataDir,name),'utf8'));
  const write = async (name,value) => fs.writeFile(path.join(dataDir,name),JSON.stringify(value));
  const packageName = id => `secure-packages/${id}.encrypted.json`;
  try {
    let ready=false;
    for(let i=0;i<80;i++){try{await fetch(base);ready=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
    assert.ok(ready);
    const customer = await request('/api/account/register','POST',{email:'customer@example.test',password:'synthetic-customer-password'});
    assert.equal(customer.status,201);
    const accounts=await read('customer-accounts.json'), account=accounts[0];
    account.adminSecrets=encrypt({acoEmail:'original@gmail.com',acoPassword:'stale',retailerPassword:'free-untouched'});
    await write('customer-accounts.json',accounts);
    await write('paid-submissions.json', ['order-a','order-b','other-user'].map(id=>({id,orderNumber:id,customerAccountId:id==='other-user'?'other-account':account.id,profile:{email:'customer@example.test'},status:'active',createdAt:new Date().toISOString()})));
    for(const id of ['order-a','order-b','other-user']) await write(packageName(id),encrypt({acoEmail:'original@gmail.com',acoPassword:'stale',cardLabel:'preserved-card',retailerPassword:'preserved-retailer'}));
    const admin=await request('/api/admin/login','POST',{password:'synthetic-admin-password',code:authenticator.generate(adminSecret)});
    assert.equal(admin.status,200);
    const saved=await request('/api/account/imap-credentials','POST',{email:'original@gmail.com',password:'synthetic-valid-password'},customer.cookie);
    assert.equal(saved.status,200); assert.equal(saved.data.entry.connectionStatus.connected,true);
    assert.ok(!JSON.stringify(saved.data).includes('synthetic-valid-password'));
    const entryId=saved.data.entry.id;
    for(const id of ['order-a','order-b']) assert.equal(decrypt(await read(packageName(id))).acoPassword,'synthetic-valid-password');
    assert.equal(decrypt(await read(packageName('other-user'))).acoPassword,'stale');
    let adminView=await request('/api/admin/submissions','GET',null,admin.cookie);
    assert.equal(adminView.status,200);
    const rows=Array.isArray(adminView.data)?adminView.data:adminView.data.submissions;
    assert.ok(rows, JSON.stringify(Object.keys(adminView.data)));
    assert.equal(rows.find(row=>row.id==='order-a').secrets.acoPassword,'synthetic-valid-password');
    // Previously saved customer entries must also repair the admin read path.
    await write(packageName('order-a'),encrypt({acoEmail:'original@gmail.com',acoPassword:'older-copy',cardLabel:'preserved-card'}));
    adminView=await request('/api/admin/submissions','GET',null,admin.cookie);
    const repaired=Array.isArray(adminView.data)?adminView.data:adminView.data.submissions;
    assert.equal(repaired.find(row=>row.id==='order-a').secrets.acoPassword,'synthetic-valid-password');
    const renamed=await request(`/api/account/imap-credentials/${entryId}`,'PUT',{email:'renamed@gmail.com',password:'synthetic-renamed-password'},customer.cookie);
    assert.equal(renamed.status,200);
    assert.equal(decrypt(await read(packageName('order-b'))).acoEmail,'renamed@gmail.com');
    const orderSave=await request('/api/account/orders/order-b','PUT',{profile:{},secrets:{acoPassword:'synthetic-order-password'}},customer.cookie);
    assert.equal(orderSave.status,200);assert.equal(orderSave.data.imapConnectionStatus.connected,true);
    const refreshed=await read('customer-accounts.json');
    assert.equal(decrypt(refreshed[0].savedImapCredentials)[0].password,'synthetic-order-password');
    assert.equal(decrypt(refreshed[0].adminSecrets).retailerPassword,'free-untouched');
    assert.equal(decrypt(await read(packageName('order-b'))).cardLabel,'preserved-card');
    assert.equal(decrypt(await read(packageName('order-b'))).retailerPassword,'preserved-retailer');
    const failed=await request(`/api/account/imap-credentials/${entryId}`,'PUT',{email:'renamed@gmail.com',password:'synthetic-invalid-password'},customer.cookie);
    assert.equal(failed.status,200);assert.equal(failed.data.entry.connectionStatus.connected,false);
    assert.equal(decrypt(await read(packageName('order-b'))).acoPassword,'synthetic-invalid-password');
    const blank=await request(`/api/account/imap-credentials/${entryId}`,'PUT',{email:'renamed@gmail.com',password:''},customer.cookie);
    assert.equal(blank.data.entry.connectionStatus.connected,false);
    assert.equal(decrypt(await read(packageName('order-b'))).acoPassword,'synthetic-invalid-password');
    const afterFailure=await read('customer-accounts.json');
    assert.equal(decrypt(afterFailure[0].adminSecrets).acoPassword,'synthetic-invalid-password');
    assert.equal(decrypt(afterFailure[0].adminSecrets).imapConnectionStatus.connected,false);
    const visible=await request('/api/account/imap-credentials','GET',null,customer.cookie);
    assert.equal(visible.data.entries[0].connectionStatus.connected,false);
    assert.ok(!JSON.stringify(visible.data).includes('synthetic-invalid-password'));
    const denied=await request(`/api/account/imap-credentials/${entryId}`,'PUT',{email:'renamed@gmail.com',password:'synthetic-valid-password'});
    assert.equal(denied.status,401);
  } finally { server.kill(); await new Promise(resolve=>server.exitCode!==null?resolve():server.once('exit',resolve));await fs.rm(dataDir,{recursive:true,force:true}); }
});
