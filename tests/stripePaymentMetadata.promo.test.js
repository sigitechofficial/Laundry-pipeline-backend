'use strict';

const {
  buildStripeChargePresentation,
  buildPromotionTrackingFields,
  buildStripeRefundPresentation,
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
  }, 'GBP');
  assert(withPromo.metadata.hasPromotion === 'yes', 'yes flag');
  assert(withPromo.metadata.couponCodes === 'SAVE10', 'codes');
  assert(withPromo.metadata.discountAmount === '5.50', 'discount');
  assert(withPromo.descriptionSuffix.includes('SAVE10'), 'suffix code');
  assert(withPromo.descriptionSuffix.includes('discount GBP 5.50'), 'suffix discount in the given currency');
  assert(withPromo.descriptionSuffix.includes('credit GBP 2.25'), 'suffix credit in the given currency');
  assert(!withPromo.descriptionSuffix.includes('£'), 'no hard-coded symbol');

  // A promotion needs the amounts' currency; none is a caller bug.
  let threw = false;
  try {
    buildPromotionTrackingFields({ hasPromotion: true, discountAmount: 1 });
  } catch (e) {
    threw = e instanceof TypeError && /buildPromotionTrackingFields: currency code is required/.test(e.message);
  }
  assert(threw, 'promotion without currency throws');

  const presentation = buildStripeChargePresentation({
    chargeType: 'delivery_balance',
    bookingId: 99,
    orderTrackId: 'ORD-99',
    amount: 40,
    currency: 'eur',
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
  assert(presentation.description.includes('discount EUR 3.00'), 'description has amount in the charge currency');
  assert(presentation.metadata.currency === 'EUR', 'metadata currency is the given ISO code');

  // Charge / refund presentations take the currency from the caller; none throws.
  for (const [name, fn] of [
    ['buildStripeChargePresentation', () => buildStripeChargePresentation({ chargeType: 'pickup', bookingId: 1, amount: 1 })],
    ['buildStripeRefundPresentation', () => buildStripeRefundPresentation({ bookingId: 1, amountRefunded: 1 })],
  ]) {
    let missing = false;
    try {
      fn();
    } catch (e) {
      missing = e instanceof TypeError && e.message.startsWith(`${name}: currency code is required`);
    }
    assert(missing, `${name} without currency throws`);
  }

  const refund = buildStripeRefundPresentation({ bookingId: 5, amountRefunded: 4, feeRetained: 1, currency: 'GBP' });
  assert(refund.description.includes('refunded GBP 4.00'), 'refund description in the given currency');
  assert(refund.metadata.currency === 'GBP', 'refund metadata currency');

  console.log('stripePaymentMetadata.promo.test.js OK');
}

run();
