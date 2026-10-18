// Shared by the existing website Admin and Studio bridge. No separate store.
export function managedWriteConflict(assignment, body = {}) {
  if (Object.hasOwn(body, 'expectedCustomerAccountId') &&
      String(body.expectedCustomerAccountId) !== String(assignment.customerAccountId || '')) {
    return {status:409,error:'This retailer account was reassigned. Reopen the current customer before saving.'};
  }
  if (Object.hasOwn(body, 'expectedUpdatedAt') &&
      String(body.expectedUpdatedAt || '') !== String(assignment.updatedAt || '')) {
    return {status:409,error:'This profile changed on another device. Your edit was not saved. Reopen the latest profile and review your changes.'};
  }
  return null;
}
export function nextManagedRevision(previous, now = Date.now()) {
  return new Date(Math.max(now, (Date.parse(previous || '') || 0) + 1)).toISOString();
}
// Serialize the whole read/check/write operation, not just the disk write.
// One queue covers both assignment files because each file contains many rows.
export function serializeManagedWrites() {
  let tail = Promise.resolve();
  return async (req, res, next) => {
    let unlock;
    const previous = tail;
    tail = new Promise(resolve => {unlock = resolve;});
    await previous;
    if (req.aborted) {unlock(); return;}
    let released = false;
    const release = () => {if (!released) {released = true; unlock();}};
    res.once('finish', release); res.once('close', release);
    try {next();} catch (error) {release(); next(error);}
  };
}
export function mergeManagedCard(existing = {}, submitted) {
  const result = {...existing};
  // Card verification values must never survive a save, including legacy aliases.
  for (const key of Object.keys(result)) if (/^(cvv2?|cvc2?|cid|cc_cvv|security_?code|accountSecurityCode|custom_?security_?code)$/i.test(key)) delete result[key];
  if (!submitted || typeof submitted !== 'object') return result;
  const limits = {cardLabel:100,cardholder:150,acoCardNumber:30,expMonth:2,expYear:4};
  for (const [key, limit] of Object.entries(limits)) {
    if (!Object.hasOwn(submitted, key)) continue;
    const value = String(submitted[key] ?? '').trim().slice(0, limit);
    result[key] = key === 'acoCardNumber' ? value.replace(/\D/g, '') : value;
  }
  return result;
}
