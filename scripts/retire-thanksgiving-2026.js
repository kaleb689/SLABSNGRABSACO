// Owner-requested retirement of the live 2026 THANKS25 promotion only.
// Existing coupons, applied discounts, subscriptions, and paid terms are untouched.
import Stripe from "stripe";
const promotionId="promo_1UcBZiAgnoiOBmXPg80fpQUT";
const expectedCoupon="SNG_THANKS25_SIX_MONTHS_2026";
const key=process.env.STRIPE_SECRET_KEY;
const target="srv-dao4skv40ujc73dtg2n0";
if(process.env.RENDER==="true"&&(!process.env.RENDER_SERVICE_ID||process.env.RENDER_SERVICE_ID===target)&&/^(sk|rk)_live_/.test(key||"")&&Date.now()<Date.parse("2026-11-28T05:00:00.000Z")){
  try{
    const stripe=new Stripe(key,{timeout:8000,maxNetworkRetries:0});
    const p=await stripe.promotionCodes.retrieve(promotionId);
    const coupon=p.promotion?.coupon??p.coupon;
    const couponId=typeof coupon==="string"?coupon:coupon?.id;
    if(p.id!==promotionId||p.livemode!==true||p.code?.toUpperCase()!=="THANKS25"||couponId!==expectedCoupon)throw Error("Unexpected promotion identity; no change made");
    if(p.active){
      const result=await stripe.promotionCodes.update(promotionId,{active:false});
      if(result.active!==false)throw Error("Stripe did not confirm deactivation");
    }
    console.log("THANKS25 promotion retired; existing discounts and subscriptions unchanged.");
  }catch(error){
    // Do not prevent the site from starting. Site-side retirement remains enforced.
    console.error("THANKS25 Stripe retirement not confirmed:",error?.code||error?.type||"verification failed");
  }
}
