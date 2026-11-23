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

  console.log('seedLocalFixtures tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
