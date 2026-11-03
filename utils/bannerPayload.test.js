'use strict';

const assert = require('assert');
const {
  parseFormBoolean,
  emptyToNull,
  normalizeZoneIds,
  zoneIdsApplyTo,
  publicPathFromMulterFile,
  pickBannerUpload,
  pickWebBannerUpload,
  normalizePlacement,
  normalizePlatform,
  placementIncludes,
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
  pickWebBannerUpload({ files: { webImage: [{ filename: 'w.jpg' }], image: [{ filename: 'm.jpg' }] } }).filename,
  'w.jpg'
);
assert.strictEqual(pickWebBannerUpload({ files: { image: [{ filename: 'm.jpg' }] } }), null);
assert.strictEqual(
  pickBannerUpload({ files: { webImage: [{ filename: 'w.jpg' }] } }),
  null
);

assert.strictEqual(normalizePlacement('Web'), 'web');
assert.strictEqual(normalizePlacement('both'), 'both');
assert.strictEqual(normalizePlacement('tv'), null);
assert.strictEqual(normalizePlacement(undefined), null);
assert.strictEqual(normalizePlatform(undefined), 'mobile');
assert.strictEqual(normalizePlatform('WEB'), 'web');
assert.strictEqual(normalizePlatform('ios'), 'mobile');
assert.strictEqual(placementIncludes(null, 'mobile'), true);
assert.strictEqual(placementIncludes(null, 'web'), false);
assert.strictEqual(placementIncludes('web', 'mobile'), false);
assert.strictEqual(placementIncludes('web', 'web'), true);
assert.strictEqual(placementIncludes('both', 'web'), true);
assert.strictEqual(placementIncludes('both', undefined), true);

assert.strictEqual(
  isMissingTableError({ message: "Table 'laundry.banners' doesn't exist" }),
  true
);
assert.strictEqual(isMissingTableError({ message: 'Unknown column' }), false);

console.log('bannerPayload tests passed');
