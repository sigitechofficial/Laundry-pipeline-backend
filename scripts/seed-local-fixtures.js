/**
 * Local development fixtures: a ready-to-use zone, shop and customer, so the admin
 * panel, website, customer app and shop app can be exercised against a local API.
 *
 *   NODE_ENV=development LOCAL_FIXTURE_PASSWORD='choose-one' npm run db:seed:local-fixtures
 *
 * Creates (idempotent — re-running only fills in what is missing):
 *  - United Kingdom / London, and a "London (local dev)" zone (GBP, km, Stripe)
 *  - Shop owner  shop@justdrycleans.test     — verified, approved, shop address in the
 *    zone (via the real agent address service), business info, 3 services, opening hours
 *  - Customer    customer@justdrycleans.test — verified
 *
 * Deliberately NOT done:
 *  - Stripe: no Stripe customer (created on first payment) and no Connect account. To take
 *    payouts, complete Stripe Connect onboarding in test mode from the shop app.
 *  - Emails/OTP: accounts are created verified, so nothing is sent.
 *
 * Guards (same as provision-local-admin): NODE_ENV must be "development", the database
 * host must be local, and the password must come from LOCAL_FIXTURE_PASSWORD (never
 * defaulted). Uses `.test` addresses (RFC 2606) — they can never receive mail.
 */
'use strict';

const { assertLocalDatabase } = require('./provision-local-admin');

const BCRYPT_ROUNDS = 12;
const SHOP_EMAIL = 'shop@justdrycleans.test';
const CUSTOMER_EMAIL = 'customer@justdrycleans.test';
const ZONE_NAME = 'London (local dev)';
const SHOP_SERVICE_NAMES = ['Wash & Fold', 'Wash & Iron', 'Dry Clean'];
const WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Greater London bounding polygon (GeoJSON order: [lng, lat]); ring is closed.
const LONDON_ZONE_RING = [
  [-0.51, 51.28], [0.33, 51.28], [0.33, 51.69], [-0.51, 51.69], [-0.51, 51.28],
];
// Shop near Charing Cross with a ~3 km coverage square.
const SHOP = { lat: 51.5072, lng: -0.1276, postalcode: 'WC2N 5DU' };
const SHOP_COVERAGE_RING = [
  [-0.1706, 51.4802], [-0.0846, 51.4802], [-0.0846, 51.5342], [-0.1706, 51.5342], [-0.1706, 51.4802],
];

function readFixtureInput(env = process.env) {
  if (env.NODE_ENV !== 'development') {
    throw new Error('Refusing to seed fixtures: NODE_ENV must be exactly "development".');
  }
  const password = String(env.LOCAL_FIXTURE_PASSWORD || '');
  if (password.length < 8) {
    throw new Error('LOCAL_FIXTURE_PASSWORD is required (8+ characters); it is never defaulted.');
  }
  return { password };
}

async function findOrCreate(model, where, defaults, transaction) {
  const existing = await model.findOne({ where, transaction, paranoid: false });
  if (existing) return { row: existing, created: false };
  return { row: await model.create({ ...where, ...defaults }, { transaction }), created: true };
}

async function seedLocalFixtures({ db, bcrypt, addressService, env = process.env, log = console.log }) {
  const { password } = readFixtureInput(env);
  assertLocalDatabase(db.sequelize);
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const report = [];
  const note = (what, created) => report.push(`${created ? 'created ' : 'exists  '} ${what}`);

  const { shop, customer } = await db.sequelize.transaction(async (transaction) => {
    const units = await db.units.findAll({ where: { name: ['GBP', 'kilometer'] }, transaction });
    const unitId = (name) => {
      const u = units.find((x) => x.name === name);
      if (!u) throw new Error(`Unit "${name}" missing — run db:seed first.`);
      return u.id;
    };

    const country = await findOrCreate(db.countries, { name: 'United Kingdom' },
      { shortName: 'GB', status: true, ianaTimeZone: 'Europe/London' }, transaction);
    note('country United Kingdom', country.created);

    const city = await findOrCreate(db.cities, { name: 'London', countryId: country.row.id },
      { lat: '51.5074', lng: '-0.1278', status: true }, transaction);
    note('city London', city.created);

    const zone = await findOrCreate(db.zone, { name: ZONE_NAME }, {
      coordinates: { type: 'Polygon', coordinates: [LONDON_ZONE_RING] },
      status: true,
      zoneMinimumAmount: 15,
      serviceCharge: 2.5,
      paymentMehtod: 'Stripe',
      agentCommissionPercent: 80,
      zoneAdminComission: 20,
      currencyUnitId: unitId('GBP'),
      distanceUnitId: unitId('kilometer'),
      cityId: city.row.id,
    }, transaction);
    note(`zone ${ZONE_NAME}`, zone.created);

    const shopUser = await findOrCreate(db.users, { email: SHOP_EMAIL }, {
      firstName: 'Local',
      lastName: 'Shop',
      password: passwordHash,
      phoneNum: '7400123457',
      countryCode: '+44',
      userTypeId: 4,
      status: true,
      verifiedAt: new Date(),
      agentApprovalStatus: 'approved',
      countryId: country.row.id,
      cityId: city.row.id,
      ianaTimeZone: 'Europe/London',
    }, transaction);
    note(`shop owner ${SHOP_EMAIL}`, shopUser.created);
    if (Number(shopUser.row.userTypeId) !== 4) {
      throw new Error(`${SHOP_EMAIL} exists but is not a shop account; refusing to modify it.`);
    }

    const hours = await db.bussinessWorkingHours.count({ where: { userId: shopUser.row.id }, transaction });
    if (!hours) {
      await db.bussinessWorkingHours.bulkCreate(
        WEEK.map((dayOfWeek) => ({ dayOfWeek, openTime: '09:00:00', closeTime: '18:00:00', status: true, userId: shopUser.row.id })),
        { transaction }
      );
    }
    note('shop opening hours (09:00–18:00 daily)', !hours);

    const services = await db.service.findAll({ where: { name: SHOP_SERVICE_NAMES, deletedAt: null }, transaction });
    if (services.length !== SHOP_SERVICE_NAMES.length) {
      throw new Error(`Services ${SHOP_SERVICE_NAMES.join(', ')} missing — run db:seed first.`);
    }
    for (const svc of services) {
      const link = await findOrCreate(db.agentSelectServices, { agentServiceId: shopUser.row.id, serviceId: svc.id },
        { status: true, serviceTimeRequired: '48 Hours' }, transaction);
      note(`shop service ${svc.name}`, link.created);
    }

    const customerUser = await findOrCreate(db.users, { email: CUSTOMER_EMAIL }, {
      firstName: 'Local',
      lastName: 'Customer',
      password: passwordHash,
      phoneNum: '7400123458',
      countryCode: '+44',
      userTypeId: 2,
      status: true,
      verifiedAt: new Date(),
      countryId: country.row.id,
      cityId: city.row.id,
    }, transaction);
    note(`customer ${CUSTOMER_EMAIL}`, customerUser.created);
    if (Number(customerUser.row.userTypeId) !== 2) {
      throw new Error(`${CUSTOMER_EMAIL} exists but is not a customer account; refusing to modify it.`);
    }

    return { shop: shopUser.row, customer: customerUser.row };
  });

  // Shop address through the real agent service (zone lookup by point, coverage
  // polygon, revenue-ramp marking) — after commit, because it runs its own queries.
  let address = await db.addressDb.findOne({ where: { userId: shop.id, addressType: 'LaundaryShopAddress' } });
  if (!address) {
    ({ registerShop: address } = await addressService.agentAddressAdd({
      streetAddress: 'Local Dev Street 1',
      district: 'Westminster',
      province: 'London',
      lat: SHOP.lat,
      lng: SHOP.lng,
      postalcode: SHOP.postalcode,
      coordinates: [SHOP_COVERAGE_RING],
      addressType: 'LaundaryShopAddress',
      userId: shop.id,
    }));
    note('shop address (in zone)', true);
  } else {
    note('shop address (in zone)', false);
  }

  const info = await findOrCreate(db.bussinessInformation, { agentId: shop.id }, {
    shopName: 'Local Dev Dry Cleaners',
    matchProfileOptions: 'ALL IN HOUSE- Washing, Ironing and Dry cleaning all done by us',
    isConnectAccountConnected: false,
    shopAddressId: address.id,
  });
  note('shop business information', info.created);

  log('[local-fixtures] Done:\n  ' + report.join('\n  '));
  log(`[local-fixtures] Sign in with ${SHOP_EMAIL} (shop app) or ${CUSTOMER_EMAIL} (customer app/website)` +
    ' using LOCAL_FIXTURE_PASSWORD.');
  return { shopUserId: shop.id, customerUserId: customer.id };
}

async function main() {
  require('dotenv').config();
  readFixtureInput(process.env); // fail fast before loading models
  const bcrypt = require('bcryptjs');
  const db = require('../models');
  const addressService = require('../services/Agent/addressManagementService');
  try {
    await seedLocalFixtures({ db, bcrypt, addressService });
  } finally {
    await db.sequelize.close();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0)) // the address service pulls in modules that keep handles open
    .catch((error) => {
      console.error(error.message || error);
      process.exit(1);
    });
}

module.exports = { readFixtureInput, seedLocalFixtures, SHOP_EMAIL, CUSTOMER_EMAIL, ZONE_NAME };
