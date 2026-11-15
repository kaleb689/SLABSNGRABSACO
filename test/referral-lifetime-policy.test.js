import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { qualifiesForPaidReferral, referralProfileAllowance, nextPermanentReferralBonus } from "../referral-lifetime-policy.js";

const referrer={id:"member-1",discordLinkedAt:"2026-11-01T00:00:00Z",discordUserId:"123456789012345678"};
const newMember={id:"member-2",referredByAccountId:"member-1",emailVerifiedAt:"2026-11-15T00:00:00Z"};
const records=[{customerAccountId:"member-2",status:"active"}];
const allows=row=>row.status==="active";

test("only real linked, email-verified paid signups earn a referral profile",()=>{
 assert.equal(qualifiesForPaidReferral(newMember,referrer,records,allows),true);
 assert.equal(qualifiesForPaidReferral({...newMember,emailVerifiedAt:null},referrer,records,allows),false);
 assert.equal(qualifiesForPaidReferral({...newMember,referralAwardedAt:"2026-11-15"},referrer,records,allows),false);
 assert.equal(qualifiesForPaidReferral({...newMember,referredByAccountId:"different"},referrer,records,allows),false);
 assert.equal(qualifiesForPaidReferral({...newMember,id:"member-1"},referrer,records,allows),false);
 assert.equal(qualifiesForPaidReferral(newMember,referrer,[{customerAccountId:"member-2",status:"unpaid"}],allows),false);
 assert.equal(qualifiesForPaidReferral(newMember,{...referrer,disabled:true},records,allows),false);
 assert.equal(qualifiesForPaidReferral(newMember,{...referrer,discordLinkedAt:null},records,allows),false);
});

test("one profile per referral cumulatively lasts while membership is active",()=>{
 assert.equal(nextPermanentReferralBonus(),1);
 assert.equal(nextPermanentReferralBonus(2),3);
 assert.equal(referralProfileAllowance({paidAllowance:10,earnedReferralBonus:1}),11);
 assert.equal(referralProfileAllowance({paidAllowance:10,earnedReferralBonus:3}),13);
 assert.equal(referralProfileAllowance({paidAllowance:100,earnedReferralBonus:3}),103);
 assert.equal(referralProfileAllowance({paidAllowance:20,earnedReferralBonus:1}),21);
 assert.equal(referralProfileAllowance({paidAllowance:0,earnedReferralBonus:9}),0);
 assert.equal(referralProfileAllowance({paidAllowance:0,giftedAllowance:1,earnedReferralBonus:9}),1);
 assert.equal(referralProfileAllowance({paidAllowance:5,giftedAllowance:2,legacyReferralAllowance:3,earnedReferralBonus:2}),10);
});

test("server gates awards on a paid record and preserves historical one-month grants",()=>{
 const server=readFileSync(new URL("../server.js",import.meta.url),"utf8");
 const signup=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
 assert.match(server,/qualifiesForPaidReferral\(referred, referrer, paid, subscriptionAllowsProfiles\)/);
 assert.match(server,/referrer\.referralBonusProfiles = nextPermanentReferralBonus/);
 assert.match(server,/referred\.referralRewardType = "membership_lifetime_bonus"/);
 assert.match(server,/referralProfileAllowance\(\{/);
 assert.match(server,/createdBy === "referral"/);
 assert.match(server,/if \(account\.referredByAccountId && account\.emailVerifiedAt && !account\.referralAwardedAt\)/);
 assert.match(server,/const quantity=Math\.max\(0,profileAllowanceForRecord\(record\)\)\+earnedBonus;/);
 assert.match(signup,/one more bonus profile/);
});
