import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBulkProfileEmails,
  normalizeBulkProfileDuration,
  customProfileExpiration,
  resolveBulkProfileMatches,
  registerAdminBulkProfileAssignments
} from './admin-bulk-profile-assignments.js';

test('pasted emails are normalized and duplicates do not become duplicate assignments', () => {
  const parsed = parseBulkProfileEmails('FIRST@example.com, second@example.net\n first@example.com');
  assert.deepEqual(parsed, {
    emails: ['first@example.com', 'second@example.net'], duplicates: 1
  });
  assert.throws(() => parseBulkProfileEmails('user@example.com:secret'), /Paste emails only/);
  assert.throws(() => parseBulkProfileEmails(''), /between 1 and 1,000/);
});

test('custom time is bounded and calculated from activation with month/year clamping', () => {
  assert.deepEqual(normalizeBulkProfileDuration({
    durationType: 'custom', customDurationUnit: 'days', customDurationAmount: '10'
  }), {durationType:'custom',customDurationUnit:'days',customDurationAmount:10});
  assert.equal(customProfileExpiration('2026-01-31T12:00:00.000Z',1,'months'),
    '2026-02-28T12:00:00.000Z');
  assert.equal(customProfileExpiration('2024-02-29T12:00:00.000Z',1,'years'),
    '2025-02-28T12:00:00.000Z');
  assert.equal(customProfileExpiration('2026-11-15T12:00:00.000Z',18,'hours'),
    '2026-11-16T06:00:00.000Z');
  assert.throws(() => normalizeBulkProfileDuration({
    durationType:'custom', customDurationUnit:'days', customDurationAmount:0
  }), /whole-number/);
});

test('retailer-aware matcher rejects missing, unavailable, duplicate, and shared records', () => {
  const accounts = [
    {id:'a', creds:{target:{username:'a@example.com'}}},
    {id:'b', creds:{target:{username:'duplicate@example.com'}}},
    {id:'c', creds:{target:{username:'duplicate@example.com'}}},
    {id:'d', creds:{pokemoncenter:{username:'held@example.com'}}},
    {id:'e', creds:{target:{username:'one@example.com'},pokemoncenter:{username:'two@example.com'}}}
  ];
  const rows = resolveBulkProfileMatches({
    emails:['a@example.com','duplicate@example.com','held@example.com',
      'one@example.com','two@example.com','missing@example.com'],
    retailer:'all', managed:accounts, decodeCredentials:account=>account.creds,
    availableByRetailer:{
      target:new Set(['a','b','c','e']),pokemoncenter:new Set(['e'])
    }
  });
  assert.deepEqual(rows.map(row=>row.status),
    ['ready','ambiguous','unavailable','ready','shared_record','not_found']);
});

test('bulk preview excludes Restore Hold and final commit preserves activation lifecycle', async () => {
  const routes = new Map();
  const app = {post(path, ...handlers) { routes.set(path, handlers.at(-1)); }};
  const accounts = [
    {id:'a',profileName:'Target 1',credentials:{target:{username:'one@example.com'}}},
    {id:'b',profileName:'Target 2',credentials:{target:{username:'hold@example.com'}}}
  ];
  let assignments = [], saves = 0, broadcasts = 0, notifications = 0;
  registerAdminBulkProfileAssignments({
    app, requireAdmin(){}, serialize(){},
    getManagedAccounts:async()=>accounts,
    getAvailableManagedAccountsForRetailer:async()=>accounts,
    getRestoreHolds:async()=>[{managedAccountId:'b'}],
    heldManagedAccountIdsFromHolds:()=>new Set(['b']),
    getCustomerAccounts:async()=>[{id:'member',email:'member@example.com'}],
    activeMembershipForCustomer:async()=>({id:'paid',profile:{email:'member@example.com'}}),
    getFreeAssignments:async()=>assignments,
    saveFreeAssignments:async items=>{saves++;assignments=items;},
    getRentalAssignments:async()=>[],
    saveRentalAssignments:async()=>{},
    normalizeRetailerCredentials:x=>x,
    decryptJson:x=>x, sanitizeProfile:x=>x,
    membershipEncryptedPackage:async()=>null,
    encryptJson:x=>x,
    prepareNewManagedAssignment:async()=>{},
    ensureManagedProfileDiscordMessage:async()=>{notifications++;},
    broadcastLiveDataChange:()=>{broadcasts++;}
  });
  const invoke = async (path,body) => {
    let status = 200, payload = null;
    const response = {set(){return this;},status(code){status=code;return this;},
      json(out){payload=out;return this;}};
    await routes.get(path)({body},response);
    return {status,payload};
  };
  const preview = await invoke('/api/admin/managed-pool/bulk-assign/preview',
    {emailsText:'one@example.com\nhold@example.com',retailer:'target'});
  assert.equal(preview.status,200);
  assert.equal(preview.payload.ready,1);
  assert.equal(preview.payload.blocked,1);
  assert.deepEqual(preview.payload.rows.map(x=>x.status),['ready','unavailable']);
  const blocked = await invoke('/api/admin/managed-pool/bulk-assign',
    {confirmed:true,emailsText:'one@example.com,hold@example.com',retailer:'target',
      customerAccountId:'member',assignmentType:'free',durationType:'1_week'});
  assert.equal(blocked.status,409);
  assert.equal(blocked.payload.ok,false);
  assert.equal(saves,0);
  const saved = await invoke('/api/admin/managed-pool/bulk-assign',
    {confirmed:true,emailsText:'one@example.com',retailer:'target',customerAccountId:'member',
      assignmentType:'free',durationType:'custom',customDurationAmount:10,customDurationUnit:'days'});
  assert.equal(saved.status,200);
  assert.equal(saved.payload.assigned,1);
  assert.equal(assignments[0].managedAccountId,'a');
  assert.equal(assignments[0].customerAccountId,'member');
  assert.equal(assignments[0].durationType,'custom');
  assert.equal(assignments[0].customDurationAmount,10);
  assert.equal(assignments[0].customDurationUnit,'days');
  assert.equal(assignments[0].activationStatus,'awaiting_activation');
  assert.equal(assignments[0].startsAt,null);
  assert.equal(assignments[0].expiresAt,null);
  assert.equal(saves,2);
  assert.equal(broadcasts,1);
  assert.equal(notifications,1);
});
