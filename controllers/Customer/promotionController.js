'use strict';

const { buildPromotionContext } = require('../../services/promotions/contextBuilder');
const {
  evaluatePromotions,
  toCustomerView,
  getCustomerOffers,
  validateCouponCodes,
  buildOfferLabel,
} = require('../../services/promotions/promotionEngine');
const { ValidationError } = require('../../middlewares/universalErrorHandler');

/** Zone from the request (query/body) or the customer's token; never trusted for anything else. */
function zoneIdOf(req) {
  const raw = req.body?.zoneId ?? req.query?.zoneId ?? req.user?.zoneId;
  const zoneId = Number(raw);
  if (!Number.isInteger(zoneId) || zoneId <= 0) throw new ValidationError('zoneId is required');
  return zoneId;
}

module.exports = {
  /** GET /customer/promotions/offers?zoneId= */
  async offers(req, res) {
    const context = await buildPromotionContext({ zoneId: zoneIdOf(req), customerId: req.user?.id });
    const offers = await getCustomerOffers(context);
    res.json({ success: true, data: offers });
  },

  /** POST /customer/promotions/validate-code { code, zoneId } */
  async validateCode(req, res) {
    const code = String(req.body?.code ?? '').trim();
    if (!code) throw new ValidationError('Enter a coupon code');
    const { valid, errors } = await validateCouponCodes([code], { customerId: req.user?.id, zoneId: zoneIdOf(req) });
    if (errors.length || !valid.size) {
      const first = errors[0] || { error: 'INVALID_CODE', message: 'Invalid code' };
      return res.status(400).json({ success: false, code: first.error, message: first.message, errors });
    }
    const [, coupon] = [...valid.entries()][0];
    const promo = coupon.promotion;
    res.json({
      success: true,
      data: {
        couponCode: coupon.code,
        promotion: {
          id: promo.id,
          name: promo.name,
          description: promo.description,
          benefitType: promo.benefitType,
          label: buildOfferLabel(promo),
        },
      },
    });
  },

  /**
   * POST /customer/promotions/evaluate
   * { zoneId, items:[{ subCategoryId | addOnServiceId, qty }], couponCodes?, paymentMethod?, collectionDate?, deliveryDate? }
   * Customer, prices, order history and clock are resolved on the server.
   */
  async evaluate(req, res) {
    const body = req.body || {};
    const context = await buildPromotionContext({
      zoneId: zoneIdOf(req),
      customerId: req.user?.id,
      items: body.items,
      couponCodes: body.couponCodes ?? (body.couponCode ? [body.couponCode] : []),
      paymentMethod: body.paymentMethod,
      collectionDate: body.collectionDate,
      deliveryDate: body.deliveryDate,
    });
    const result = await evaluatePromotions(context);
    res.json({ success: true, data: toCustomerView(result) });
  },
};
