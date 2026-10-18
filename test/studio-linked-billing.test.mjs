import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const linked=source.slice(source.indexOf('"/api/admin/submissions/:id/linked-memberships"'),source.indexOf('app.get(',source.indexOf('"/api/admin/submissions/:id/linked-memberships"')+20));
const detail=source.slice(source.indexOf('"/api/admin/managed-memberships/:type/:id/customer-details"'),source.indexOf('app.',source.indexOf('"/api/admin/managed-memberships/:type/:id/customer-details"')+20));
test('Both linked-membership types expose the exact selection identifiers and billing profile',()=>{
 assert.equal((linked.match(/customerBillingProfile:\s*assignment\.customerBillingProfile/g)||[]).length,2);
 assert.equal((linked.match(/savedAddressId: assignment\.savedAddressId/g)||[]).length,2);
 assert.equal((linked.match(/savedPaymentMethodId: assignment\.savedPaymentMethodId/g)||[]).length,2);
});
test('Admin website write preserves existing billing unless explicitly changed',()=>{
 assert.match(detail,/hasOwnProperty\.call\(req\.body \|\| \{\}, "customerBillingProfile"\)/);
 assert.match(detail,/mergeManagedCustomerProfile/);
 assert.match(detail,/validProfile\(nextBilling\)/);
 assert.match(detail,/assignment\.customerBillingProfile = nextBilling/);
 assert.match(detail,/customerBillingProfile: assignment\.customerBillingProfile \|\| null/);
 assert.match(detail,/await saveFreeAssignments/);
 assert.match(detail,/await saveRentalAssignments/);
});
