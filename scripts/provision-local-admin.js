'use strict';

const LOCAL_DATABASE_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const BCRYPT_ROUNDS = 12;

function readProvisioningInput(env = process.env) {
  if (env.NODE_ENV !== 'development') {
    throw new Error('Refusing to provision admin: NODE_ENV must be exactly "development".');
  }

  const email = String(env.LOCAL_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(env.LOCAL_ADMIN_PASSWORD || '');

  if (!email || !password) {
    throw new Error(
      'LOCAL_ADMIN_EMAIL and LOCAL_ADMIN_PASSWORD are required; credentials are never defaulted.'
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('LOCAL_ADMIN_EMAIL must be a valid email address.');
  }
  if (password.length > 1024) {
    throw new Error('LOCAL_ADMIN_PASSWORD is unexpectedly long.');
  }

  return { email, password };
}

function assertLocalDatabase(sequelize) {
  const host = String(sequelize?.config?.host || '').toLowerCase();
  if (!LOCAL_DATABASE_HOSTS.has(host)) {
    throw new Error(
      `Refusing to provision admin: database host "${host || '(missing)'}" is not local.`
    );
  }
}

async function provisionLocalAdmin({ users, sequelize, bcrypt, env = process.env }) {
  const { email, password } = readProvisioningInput(env);
  assertLocalDatabase(sequelize);

  const admin = await users.findOne({
    where: { email },
    paranoid: false,
  });

  if (!admin) {
    // No admin is seeded (a seeded account would ship a known password). Create the
    // local super admin here: dev-only, local DB only, credentials from env (above).
    // classifiedAsId stays null = super admin (see middlewares/checkPermission.js).
    const created = await users.create({
      firstName: 'Local',
      lastName: 'Admin',
      email,
      password: await bcrypt.hash(password, BCRYPT_ROUNDS),
      status: true,
      userTypeId: 1,
      verifiedAt: new Date(),
    });
    return { id: created.id, email: created.email, created: true };
  }
  if (admin.deletedAt) {
    throw new Error(`Refusing to modify deleted admin "${email}".`);
  }
  if (Number(admin.userTypeId) !== 1 || admin.status !== true) {
    throw new Error(
      `Refusing to modify "${email}": account must already be an active admin (userTypeId 1).`
    );
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await admin.update({ password: passwordHash });

  if (!(await bcrypt.compare(password, admin.password))) {
    throw new Error('Admin password verification failed after update.');
  }

  return { id: admin.id, email: admin.email, created: false };
}

async function main() {
  require('dotenv').config();
  readProvisioningInput(process.env);

  const bcrypt = require('bcryptjs');
  const { users, sequelize } = require('../models');

  try {
    const admin = await provisionLocalAdmin({ users, sequelize, bcrypt });
    console.log(
      admin.created
        ? `Local admin created for ${admin.email} (id ${admin.id}).`
        : `Local admin password updated securely for ${admin.email} (id ${admin.id}).`
    );
  } finally {
    await sequelize.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  BCRYPT_ROUNDS,
  assertLocalDatabase,
  provisionLocalAdmin,
  readProvisioningInput,
};
