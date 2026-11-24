'use strict';

/**
 * Shop registration writes (address, business information, services, working hours)
 * are for the account that proves itself:
 *   - with a session: the signed-in owner's own shop; another account's id in the
 *     body / path is refused; staff are refused;
 *   - without one (LEGACY builds): only a verified, active owner account, and
 *     business info / services only while that shop's set-up is unfinished;
 *     SHOP_REGISTRATION_ALLOW_ANONYMOUS=false refuses them all.
 * Also the shop address fields: UK postcodes stored as "EC1A 1BB", town and county
 * kept apart.
 * Pure: in-memory models, no config.json / MySQL.
 *   node tests/shopRegistrationAccess.test.js
 */

const assert = require('assert');
const { createShopRegistrationAccess } = require('../services/Agent/shopRegistrationAccess');
const { shopAddressFields, bookingAddressFields, formatUkPostcode } = require('../utils/shopAddressInput');

// ─── In-memory accounts ──────────────────────────────────────────────────────
// 10: verified owner, set-up unfinished (no business info yet)
// 11: verified owner, set-up complete (business info + services): a live shop
// 12: owner who has not verified the sign-up code
// 13: blocked owner
// 14: shop employee (works for 11)
// 15: customer
const USERS = {
  10: { id: 10, userTypeId: 4, classifiedAsId: null, verifiedAt: new Date(), status: true },
  11: { id: 11, userTypeId: 4, classifiedAsId: null, verifiedAt: new Date(), status: true },
  12: { id: 12, userTypeId: 4, classifiedAsId: null, verifiedAt: null, status: true },
  13: { id: 13, userTypeId: 4, classifiedAsId: null, verifiedAt: new Date(), status: false },
  14: { id: 14, userTypeId: 4, classifiedAsId: 1, verifiedAt: new Date(), status: true, employeeOff: 11 },
  15: { id: 15, userTypeId: 2, classifiedAsId: null, verifiedAt: new Date(), status: true },
};
const INFO = { 11: { id: 1, shopName: 'Clean Co', matchProfileOptions: 'ALL IN HOUSE' } };
const SERVICES = { 11: { id: 5 } };

const models = {
  users: {
    findOne: async ({ where }) => {
      const u = USERS[where.id];
      return u && u.userTypeId === where.userTypeId ? u : null;
    },
  },
  bussinessInformation: { findOne: async ({ where }) => INFO[where.agentId] || null },
  agentSelectServices: { findOne: async ({ where }) => SERVICES[where.agentServiceId] || null },
};

const access = createShopRegistrationAccess({ models, env: {} });
const closed = createShopRegistrationAccess({ models, env: { SHOP_REGISTRATION_ALLOW_ANONYMOUS: 'false' } });

const anonymous = { user: undefined };
const signedIn = (user) => ({ user });

async function refused(promise, statusCode, label) {
  await assert.rejects(promise, (err) => {
    assert.strictEqual(err.statusCode, statusCode, `${label}: status ${err.statusCode} (${err.message})`);
    return true;
  }, label);
}

(async () => {
  // ─── Signed in ──────────────────────────────────────────────────────────────
  assert.strictEqual(
    await access.registrationShopId(signedIn({ id: 10 }), { legacyUserId: '10' }),
    10, 'session: the owner\'s own shop (matching legacy id)');
  assert.strictEqual(
    await access.registrationShopId(signedIn({ id: 10 }), {}),
    10, 'session: no legacy id needed');
  assert.strictEqual(
    await access.registrationShopId(signedIn({ id: 11 }), { legacyUserId: 11, incompleteSetupOnly: true }),
    11, 'session: a live shop edits its own set-up (no unfinished-set-up limit)');
  await refused(
    access.registrationShopId(signedIn({ id: 10 }), { legacyUserId: '11' }),
    403, 'session: another account\'s id is refused, not written');
  await refused(
    access.registrationShopId(signedIn({ id: 14, classifiedAsId: 1, employeeOff: 11 }), { legacyUserId: 14 }),
    403, 'session: staff cannot change the shop set-up');

  // ─── Anonymous (LEGACY builds) ──────────────────────────────────────────────
  assert.strictEqual(
    await access.registrationShopId(anonymous, { legacyUserId: '10' }),
    10, 'anonymous: verified owner still served (installed builds)');
  assert.strictEqual(
    await access.registrationShopId(anonymous, { legacyUserId: '10', incompleteSetupOnly: true }),
    10, 'anonymous: unfinished set-up served');
  await refused(
    access.registrationShopId(anonymous, { legacyUserId: '11', incompleteSetupOnly: true }),
    401, 'anonymous: a live shop\'s business info / services cannot be changed');
  assert.strictEqual(
    await access.registrationShopId(anonymous, { legacyUserId: 11 }),
    11, 'anonymous: working hours (installed builds save them from Profile without a session)');
  for (const [id, label] of [
    [12, 'unverified sign-up'], [13, 'blocked owner'], [14, 'shop employee'], [15, 'customer'], [999, 'no such account'],
  ]) {
    await refused(access.registrationShopId(anonymous, { legacyUserId: id }), 401, `anonymous: ${label}`);
  }
  await refused(access.registrationShopId(anonymous, {}), 400, 'anonymous: no userId');
  await refused(access.registrationShopId(anonymous, { legacyUserId: 'abc' }), 400, 'anonymous: bad userId');

  // The same answer for every anonymous refusal (no account enumeration).
  const messages = new Set();
  for (const id of [12, 13, 14, 15, 999]) {
    try { await access.registrationShopId(anonymous, { legacyUserId: id }); } catch (e) { messages.add(e.message); }
  }
  try { await access.registrationShopId(anonymous, { legacyUserId: 11, incompleteSetupOnly: true }); } catch (e) { messages.add(e.message); }
  assert.strictEqual(messages.size, 1, `one anonymous refusal message, got ${[...messages].join(' | ')}`);

  // Kill switch: once every supported build sends the session.
  await refused(closed.registrationShopId(anonymous, { legacyUserId: 10 }), 401, 'switched off: anonymous refused');
  assert.strictEqual(await closed.registrationShopId(signedIn({ id: 10 }), {}), 10, 'switched off: sessions still served');

  // ─── Shop address fields ────────────────────────────────────────────────────
  assert.strictEqual(formatUkPostcode('ec1a1bb'), 'EC1A 1BB');
  assert.strictEqual(formatUkPostcode('  EC1A   1BB '), 'EC1A 1BB');
  assert.strictEqual(formatUkPostcode('m11ae'), 'M1 1AE');
  assert.strictEqual(formatUkPostcode('gir0aa'), 'GIR 0AA');
  assert.strictEqual(formatUkPostcode('EC1A'), null, 'an outward code alone is not an address postcode');
  assert.strictEqual(formatUkPostcode('12345'), null);

  const uk = { shortName: 'GB' };
  assert.deepStrictEqual(
    shopAddressFields({
      streetAddress: ' Royal Mail,  Mount Pleasant Mail Centre, Farringdon Road ',
      district: 'London', province: '', postalcode: 'EC1A1BB',
    }, uk),
    {
      streetAddress: 'Royal Mail, Mount Pleasant Mail Centre, Farringdon Road',
      district: 'London', province: null, postalcode: 'EC1A 1BB',
    },
    'UK: post town in district, empty county stored as null, postcode formatted');
  assert.throws(() => shopAddressFields({ streetAddress: 'x', postalcode: 'NOTAPC' }, uk), /UK postcode/);
  assert.throws(() => shopAddressFields({ streetAddress: '', postalcode: 'EC1A 1BB' }, uk), /street/);
  assert.throws(() => shopAddressFields({ streetAddress: 'x', postalcode: '' }, uk), /postcode/);
  assert.strictEqual(
    shopAddressFields({ streetAddress: '1 Main St', postalcode: '10001' }, { shortName: 'US' }).postalcode,
    '10001', 'other countries: postcode kept (uppercased) as sent');

  // ─── Customer booking addresses ─────────────────────────────────────────────
  // Installed customer builds: county in district, town in city, postalCode.
  const legacyBooking = bookingAddressFields({
    streetAddress: 'Royal Mail, Farringdon Road', district: 'London', city: 'London',
    province: 'London', postalCode: 'EC1A1BB', lat: 51.5, lng: -0.1,
  });
  assert.strictEqual(legacyBooking.postalcode, 'EC1A 1BB', 'postalCode is stored (it was dropped)');
  assert.strictEqual(legacyBooking.district, 'London');
  assert.ok(!('postalCode' in legacyBooking) && !('city' in legacyBooking), 'no non-column keys');
  const countyInDistrict = bookingAddressFields({ district: 'Berkshire', city: 'Reading', postalcode: 'rg1 2bh' });
  assert.strictEqual(countyInDistrict.district, 'Reading', 'the post town, not the county');
  assert.strictEqual(countyInDistrict.postalcode, 'RG1 2BH');
  assert.strictEqual(bookingAddressFields({ district: 'X' }).postalcode, null);

  console.log('shopRegistrationAccess tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
