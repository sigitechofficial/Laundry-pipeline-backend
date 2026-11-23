'use strict';

const assert = require('assert/strict');
const bcrypt = require('bcryptjs');
const {
  BCRYPT_ROUNDS,
  provisionLocalAdmin,
  readProvisioningInput,
} = require('../scripts/provision-local-admin');

function expectedEnv(overrides = {}) {
  return {
    NODE_ENV: 'development',
    LOCAL_ADMIN_EMAIL: ' Admin@Example.com ',
    LOCAL_ADMIN_PASSWORD: 'local-test-password',
    ...overrides,
  };
}

async function run() {
  assert.throws(
    () => readProvisioningInput(expectedEnv({ NODE_ENV: 'production' })),
    /NODE_ENV must be exactly "development"/
  );
  assert.throws(
    () => readProvisioningInput(expectedEnv({ LOCAL_ADMIN_PASSWORD: '' })),
    /LOCAL_ADMIN_EMAIL and LOCAL_ADMIN_PASSWORD are required/
  );

  const input = readProvisioningInput(expectedEnv());
  assert.equal(input.email, 'admin@example.com');

  let updatedValues;
  const admin = {
    id: 8,
    email: input.email,
    password: 'old-hash',
    status: true,
    userTypeId: 1,
    deletedAt: null,
    async update(values) {
      updatedValues = values;
      this.password = values.password;
    },
  };
  const users = {
    async findOne(query) {
      assert.deepEqual(query, {
        where: { email: 'admin@example.com' },
        paranoid: false,
      });
      return admin;
    },
  };

  const result = await provisionLocalAdmin({
    users,
    sequelize: { config: { host: '127.0.0.1' } },
    bcrypt,
    env: expectedEnv(),
  });

  assert.deepEqual(result, { id: 8, email: 'admin@example.com', created: false });
  assert.equal(await bcrypt.compare('local-test-password', updatedValues.password), true);
  assert.equal(bcrypt.getRounds(updatedValues.password), BCRYPT_ROUNDS);

  await assert.rejects(
    provisionLocalAdmin({
      users,
      sequelize: { config: { host: 'db.example.com' } },
      bcrypt,
      env: expectedEnv(),
    }),
    /database host "db\.example\.com" is not local/
  );

  const nonAdminUsers = {
    async findOne() {
      return { ...admin, userTypeId: 2 };
    },
  };
  await assert.rejects(
    provisionLocalAdmin({
      users: nonAdminUsers,
      sequelize: { config: { host: 'localhost' } },
      bcrypt,
      env: expectedEnv(),
    }),
    /account must already be an active admin/
  );

  // No admin yet (fresh database, nothing seeded): created as an active super admin.
  let createdValues;
  const emptyUsers = {
    async findOne() {
      return null;
    },
    async create(values) {
      createdValues = values;
      return { id: 1, ...values };
    },
  };
  const created = await provisionLocalAdmin({
    users: emptyUsers,
    sequelize: { config: { host: 'localhost' } },
    bcrypt,
    env: expectedEnv(),
  });
  assert.deepEqual(created, { id: 1, email: 'admin@example.com', created: true });
  assert.equal(createdValues.userTypeId, 1);
  assert.equal(createdValues.status, true);
  assert.ok(createdValues.verifiedAt instanceof Date);
  assert.equal(createdValues.classifiedAsId, undefined, 'super admin has no classifiedAsId');
  assert.equal(await bcrypt.compare('local-test-password', createdValues.password), true);
  assert.equal(bcrypt.getRounds(createdValues.password), BCRYPT_ROUNDS);

  // Creation keeps the same guards: never against a non-local database.
  await assert.rejects(
    provisionLocalAdmin({
      users: emptyUsers,
      sequelize: { config: { host: 'db.example.com' } },
      bcrypt,
      env: expectedEnv(),
    }),
    /is not local/
  );

  console.log('provisionLocalAdmin tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
