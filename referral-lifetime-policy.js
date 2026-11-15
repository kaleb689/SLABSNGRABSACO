// Permanent referral entitlement is for a verified, PAID signup and lasts
// only while the referring member retains an active paid membership.
// No payment is created, no customer vault is modified by this pure module.
const safeCount = value => Number.isSafeInteger(Number(value)) && Number(value) > 0
  ? Number(value) : 0;

export function qualifiesForPaidReferral(referred, referrer, paidRecords, allowsProfiles) {
  if (!referred?.id || !referrer?.id || String(referred.id) === String(referrer.id) ||
      !referred.emailVerifiedAt || referred.referralAwardedAt ||
      String(referred.referredByAccountId) !== String(referrer.id) ||
      !referrer.discordLinkedAt || !referrer.discordUserId || referrer.disabled === true ||
      typeof allowsProfiles !== "function") return false;
  return (Array.isArray(paidRecords) ? paidRecords : []).some(record =>
    String(record.customerAccountId) === String(referred.id) && allowsProfiles(record));
}

export function referralProfileAllowance({paidAllowance=0,giftedAllowance=0,
  legacyReferralAllowance=0,earnedReferralBonus=0}={}) {
  const paid=safeCount(paidAllowance),gifted=safeCount(giftedAllowance),
    legacy=safeCount(legacyReferralAllowance);
  const base=Math.max(paid,gifted)+legacy;
  if (!base) return 0;
  // Referral bonuses never create free access without a paid membership.
  const bonus=paid>0?safeCount(earnedReferralBonus):0;
  return Math.min(Number.MAX_SAFE_INTEGER,base+bonus);
}

export function nextPermanentReferralBonus(existing=0) {
  const value=safeCount(existing);
  if (!Number.isSafeInteger(value+1)) throw Error("Referral bonus count is too large.");
  return value+1;
}
