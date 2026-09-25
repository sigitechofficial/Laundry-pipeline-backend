'use strict';

const assert = require('assert');
const {
    calcDiscount,
    evaluateCouponAgainstLaundry,
    parseZoneIds,
    couponAppliesToZone,
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

assert.strictEqual(calcDiscount(flat30(), 30), 30);
assert.strictEqual(calcDiscount(flat30(), 150), 30);
assert.strictEqual(calcDiscount(flat30(), 10), 10);
assert.strictEqual(calcDiscount(pct10Cap20(), 300), 20);
assert.strictEqual(calcDiscount(pct10Cap20(), 100), 10);

{
    const rejected = evaluateCouponAgainstLaundry({
        couponData: flat30(),
        laundryAmount: 30,
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
}

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

assert.deepStrictEqual(parseZoneIds(null), []);
assert.deepStrictEqual(parseZoneIds([]), []);
assert.deepStrictEqual(parseZoneIds([1, '2', 0, 'x']), [1, 2]);
assert.deepStrictEqual(parseZoneIds('3,4'), [3, 4]);
assert.strictEqual(couponAppliesToZone({ zoneIds: null }, 9), true);
assert.strictEqual(couponAppliesToZone({ zoneIds: [1, 2] }, 2), true);
assert.strictEqual(couponAppliesToZone({ zoneIds: [1, 2] }, 9), false);

console.log('couponDiscount.test.js: ok');
