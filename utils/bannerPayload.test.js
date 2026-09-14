'use strict';

const assert = require('assert');
const {
  parseFormBoolean,
  emptyToNull,
  normalizeZoneIds,
  zoneIdsApplyTo,
  publicPathFromMulterFile,
  pickBannerUpload,
  isMissingTableError,
} = require('./bannerPayload');

assert.strictEqual(parseFormBoolean('true', false), true);
assert.strictEqual(parseFormBoolean('false', true), false);
assert.strictEqual(parseFormBoolean(false, true), false);
assert.strictEqual(parseFormBoolean('', true), true);
assert.strictEqual(parseFormBoolean(undefined, true), true);
assert.strictEqual(parseFormBoolean('0'), false);
assert.strictEqual(parseFormBoolean('1'), true);

assert.strictEqual(emptyToNull(''), null);
assert.strictEqual(emptyToNull('null'), null);
assert.strictEqual(emptyToNull('12'), '12');

assert.deepStrictEqual(normalizeZoneIds(''), null);
assert.deepStrictEqual(normalizeZoneIds('3'), [3]);
assert.deepStrictEqual(normalizeZoneIds('1, 4'), [1, 4]);
assert.deepStrictEqual(normalizeZoneIds(['2', '5']), [2, 5]);
assert.deepStrictEqual(normalizeZoneIds('[3,6]'), [3, 6]);
assert.deepStrictEqual(normalizeZoneIds([]), null);

assert.strictEqual(zoneIdsApplyTo(null, 3), true);
assert.strictEqual(zoneIdsApplyTo([], 3), true);
assert.strictEqual(zoneIdsApplyTo('[3]', 3), true);
assert.strictEqual(zoneIdsApplyTo('3', 3), true);
assert.strictEqual(zoneIdsApplyTo(['3'], 3), true);
assert.strictEqual(zoneIdsApplyTo([1, 4], 3), false);

assert.strictEqual(
  publicPathFromMulterFile({ path: './Public/BannerImages/a.jpg', filename: 'a.jpg' }),
  'Public/BannerImages/a.jpg'
);
assert.strictEqual(
  pickBannerUpload({ files: { bannerImage: [{ filename: 'x.png' }] } }).filename,
  'x.png'
);
assert.strictEqual(
  pickBannerUpload({ files: { image: [{ filename: 'y.jpg' }] } }).filename,
  'y.jpg'
);

assert.strictEqual(
  isMissingTableError({ message: "Table 'laundry.banners' doesn't exist" }),
  true
);
assert.strictEqual(isMissingTableError({ message: 'Unknown column' }), false);

console.log('bannerPayload tests passed');
