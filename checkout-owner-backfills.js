import {createHash} from 'node:crypto';

// Owner-confirmed repair from 2026-10-15: this exact retailer login already
// belonged to this customer when the checkout happened, before its app link.
// Store only a login fingerprint; never persist the source Account password.
const approvals = [{
  id:'owner-confirmed-2026-10-15-missing-pkc-checkout',
  retailer:'PKC', date:'2026-10-15',
  loginHash:'44cb1d031fa654ea4d64f013cb58cce58c6d5fc80916820e87dadf988a451210',
  customerAccountId:'8d71e1b6-bca9-4a66-9f2c-f47e8f59a51c'
}];

export function resolveOwnerVerifiedBackfill(order, identity, candidates) {
  const email=String(identity?.email||'').trim().toLowerCase();
  if (!email || !order?.orderNumber || !Number.isFinite(Date.parse(order.checkoutAt||''))) return null;
  const fingerprint=createHash('sha256').update(email).digest('hex');
  const approval=approvals.find(item=>item.retailer===order.retailer &&
    item.date===new Date(order.checkoutAt).toISOString().slice(0,10) && item.loginHash===fingerprint);
  if (!approval) return null;
  const exact=candidates.filter(item=>item.email===email && item.retailer===order.retailer && item.customerAccountId);
  // The approved customer must still have this exact retailer login linked.
  // A conflicting historical owner or missing assignment blocks the repair.
  if (!exact.length || exact.some(item=>String(item.customerAccountId)!==approval.customerAccountId)) return null;
  const match=exact.find(item=>item.assignment && item.managedAccountId &&
    item.assignment.active!==false && !item.assignment.endedAt && !item.assignment.returnedToPoolAt);
  if (!match) return null;
  return {...Object.fromEntries(['customerAccountId','profileName','profileSlot','managedAccountId',
    'managedAssignmentId','managedAssignmentType'].filter(key=>match[key]!=null).map(key=>[key,match[key]])),
    ownerBackfillApproval:approval.id};
}
