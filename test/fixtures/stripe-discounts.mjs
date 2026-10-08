import { Prices } from '../../node_modules/stripe/esm/resources/Prices.js';
import { Coupons } from '../../node_modules/stripe/esm/resources/Coupons.js';
import { PromotionCodes } from '../../node_modules/stripe/esm/resources/PromotionCodes.js';
let counter = 0;
const coupons = new Map(), promotions = new Map();
Prices.prototype.retrieve = async id => ({ id, product: `product_${id}`, active: true, type: 'recurring', currency: 'usd', unit_amount: 1500, recurring: { interval: 'month', interval_count: 1 } });
Coupons.prototype.create = async data => { const item = { ...data, id: `coupon_${++counter}`, times_redeemed: 0 }; coupons.set(item.id, item); return item; };
Coupons.prototype.retrieve = async id => { const item = coupons.get(id); if (!item) throw new Error('Missing coupon'); return item; };
Coupons.prototype.del = async id => { coupons.delete(id); return { id, deleted: true }; };
PromotionCodes.prototype.create = async data => {
  if (data.code === 'FAIL20') throw new Error('Synthetic promotion creation failure');
  if ([...promotions.values()].some(item => item.code === data.code && item.active)) throw new Error('Duplicate active code');
  const item = { ...data, id: `promo_${++counter}`, active: data.active ?? true };
  promotions.set(item.id, item); return item;
};
PromotionCodes.prototype.update = async (id, data) => {
  const item = promotions.get(id); if (!item) throw new Error('Missing promotion');
  Object.assign(item, data); return item;
};
PromotionCodes.prototype.retrieve = async id => promotions.get(id);
