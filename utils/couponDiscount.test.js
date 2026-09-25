'use strict';

const assert = require('assert');
const {
    calcDiscount,
    evaluateCouponAgainstLaundry,
} = require('./couponDiscount');

function flat30() {
    return { discountType: 'flat', discountValue: 30, minOrderAmount: 100 };
}

function pct10Cap20() {
    return {
        discountType: 'percentage',
        discountValue: 10,
        maxDiscountCap: 20,
        minOrderAmount: 50,
    };
}

// Discount never uses prepaid — only laundry.
assert.strictEqual(calcDiscount(flat30(), 30), 30); // laundry £30, flat £30 → £30
assert.strictEqual(calcDiscount(flat30(), 150), 30);
assert.strictEqual(calcDiscount(flat30(), 10), 10); // capped to laundry
assert.strictEqual(calcDiscount(pct10Cap20(), 300), 20); // 10% of 300 = 30, cap 20
assert.strictEqual(calcDiscount(pct10Cap20(), 100), 10);

// Min order vs laundry (not prepaid £30).
{
    const rejected = evaluateCouponAgainstLaundry({
        couponData: flat30(),
        laundryAmount: 30, // prepaid-like wrong base
        deferMinOrderWhenLaundryUnknown: false,
    });
    assert.strictEqual(rejected.rejected, true);
    assert.strictEqual(rejected.discountAmt, 0);
}

{
    const ok = evaluateCouponAgainstLaundry({
        couponData: flat30(),
        laundryAmount: 150,
        deferMinOrderWhenLaundryUnknown: false,
    });
    assert.strictEqual(ok.rejected, false);
    assert.strictEqual(ok.discountAmt, 30);
    assert.strictEqual(ok.minOrderMet, true);
}

// Bags-only / unknown laundry: defer min, provisional £0 discount.
{
    const deferred = evaluateCouponAgainstLaundry({
        couponData: flat30(),
        laundryAmount: 0,
        deferMinOrderWhenLaundryUnknown: true,
    });
    assert.strictEqual(deferred.rejected, false);
    assert.strictEqual(deferred.minOrderDeferred, true);
    assert.strictEqual(deferred.discountAmt, 0);
}

// Invoice-time: laundry below min → no discount.
{
    const under = evaluateCouponAgainstLaundry({
        couponData: flat30(),
        laundryAmount: 80,
        deferMinOrderWhenLaundryUnknown: false,
    });
    assert.strictEqual(under.rejected, true);
    assert.strictEqual(under.discountAmt, 0);
}

console.log('couponDiscount.test.js: ok');
