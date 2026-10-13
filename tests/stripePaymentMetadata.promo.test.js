'use strict';

const {
  buildStripeChargePresentation,
  buildPromotionTrackingFields,
} = require('../utils/stripePaymentMetadata');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function run() {
  const empty = buildPromotionTrackingFields(null);
  assert(empty.descriptionSuffix === '', 'empty suffix');
  assert(!empty.metadata.hasPromotion, 'empty has no flag');

  const none = buildPromotionTrackingFields({ hasPromotion: false });
  assert(none.metadata.hasPromotion === 'no', 'explicit no');

  const withPromo = buildPromotionTrackingFields({
    hasPromotion: true,
    promotionIds: '12,34',
    promotionNames: 'Welcome Off | Basket 10%',
    couponCodes: 'SAVE10',
    discountAmount: 5.5,
    cashbackAmount: 1,
    creditUsed: 2.25,
    promotionStatus: 'applied',
  });
  assert(withPromo.metadata.hasPromotion === 'yes', 'yes flag');
  assert(withPromo.metadata.couponCodes === 'SAVE10', 'codes');
  assert(withPromo.metadata.discountAmount === '5.50', 'discount');
  assert(withPromo.descriptionSuffix.includes('SAVE10'), 'suffix code');
  assert(withPromo.descriptionSuffix.includes('£5.50'), 'suffix discount');

  const presentation = buildStripeChargePresentation({
    chargeType: 'delivery_balance',
    bookingId: 99,
    orderTrackId: 'ORD-99',
    amount: 40,
    customer: { id: 1, firstName: 'Sam', lastName: 'Lee' },
    promotions: {
      hasPromotion: true,
      promotionIds: '7',
      promotionNames: 'First Order',
      couponCodes: 'HELLO',
      discountAmount: 3,
      cashbackAmount: 0,
      creditUsed: 0,
      promotionStatus: 'committed',
    },
  });
  assert(presentation.metadata.hasPromotion === 'yes', 'presentation flag');
  assert(presentation.metadata.couponCodes === 'HELLO', 'presentation code');
  assert(presentation.description.includes('HELLO'), 'description has promo');
  assert(presentation.description.includes('£3.00'), 'description has amount');

  console.log('stripePaymentMetadata.promo.test.js OK');
}

run();
