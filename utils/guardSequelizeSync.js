'use strict';

/**
 * Production hard-stop for sequelize.sync({ alter: true }) / { force: true }.
 * Wired in models/index.js so laundary.js cannot bypass it by flipping syncDb.
 * Schema changes in shared environments must go through migrations.
 */
function isProductionEnv(nodeEnv) {
  return String(nodeEnv || '').toLowerCase() === 'production';
}

function assertSafeSyncOptions(options, nodeEnv = process.env.NODE_ENV) {
  if (!isProductionEnv(nodeEnv)) return;
  const opts = options || {};
  if (opts.alter || opts.force) {
    throw new Error(
      '[SchemaGuard] sequelize.sync({ alter: true }) / { force: true } is forbidden in production. ' +
        'Apply schema via migrations (npm run db:migrate). Do not flip syncDb.'
    );
  }
}

function guardSequelizeSync(sequelize, nodeEnv = process.env.NODE_ENV) {
  if (!sequelize || typeof sequelize.sync !== 'function') {
    throw new Error('[SchemaGuard] sequelize instance with sync() is required');
  }
  const originalSync = sequelize.sync.bind(sequelize);
  sequelize.sync = function syncGuarded(options) {
    assertSafeSyncOptions(options, nodeEnv);
    return originalSync(options);
  };
  return sequelize;
}

module.exports = {
  guardSequelizeSync,
  assertSafeSyncOptions,
  isProductionEnv,
};
