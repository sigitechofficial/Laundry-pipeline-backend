'use strict';

const assert = require('assert/strict');
const { readFixtureInput, seedLocalFixtures } = require('../scripts/seed-local-fixtures');

async function run() {
  assert.throws(
    () => readFixtureInput({ NODE_ENV: 'production', LOCAL_FIXTURE_PASSWORD: 'long-enough' }),
    /NODE_ENV must be exactly "development"/
  );
  assert.throws(
    () => readFixtureInput({ NODE_ENV: 'development', LOCAL_FIXTURE_PASSWORD: '' }),
    /LOCAL_FIXTURE_PASSWORD is required/
  );
  assert.throws(
    () => readFixtureInput({ NODE_ENV: 'development', LOCAL_FIXTURE_PASSWORD: 'short' }),
    /8\+ characters/
  );
  assert.deepEqual(readFixtureInput({ NODE_ENV: 'development', LOCAL_FIXTURE_PASSWORD: 'long-enough' }), {
    password: 'long-enough',
  });

  // Never touches a non-local database: fails before hashing or any query.
  let touched = false;
  const remoteDb = {
    sequelize: {
      config: { host: 'prod-db.example.com' },
      transaction: async () => { touched = true; },
    },
  };
  await assert.rejects(
    seedLocalFixtures({
      db: remoteDb,
      bcrypt: { hash: async () => { touched = true; } },
      addressService: {},
      env: { NODE_ENV: 'development', LOCAL_FIXTURE_PASSWORD: 'long-enough' },
      log: () => {},
    }),
    /is not local/
  );
  assert.equal(touched, false);

  // Stripe Connect option refuses a live key (checked before any Stripe call).
  let stripeCalled = false;
  const fakeRow = { connectAccountId: null, update: async () => {} };
  const localDb = {
    sequelize: { config: { host: 'localhost' }, transaction: async () => ({ shop: { id: 1 }, customer: { id: 2 } }) },
    addressDb: { findOne: async () => ({ id: 1 }) },
    bussinessInformation: { findOne: async () => fakeRow },
  };
  await assert.rejects(
    seedLocalFixtures({
      db: localDb,
      bcrypt: { hash: async () => 'h' },
      addressService: {},
      stripeApi: { createStripeConnectAccount: async () => { stripeCalled = true; } },
      env: { NODE_ENV: 'development', LOCAL_FIXTURE_PASSWORD: 'long-enough', LOCAL_FIXTURE_STRIPE_CONNECT: '1', STRIPE_SECRET_KEY: 'sk_live_x' },
      log: () => {},
    }),
    /not a test key/
  );
  assert.equal(stripeCalled, false);

  console.log('seedLocalFixtures tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
