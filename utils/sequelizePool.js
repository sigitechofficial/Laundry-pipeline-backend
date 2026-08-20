'use strict';

/**
 * Sequelize pool from env. Defaults stay local-MySQL safe (max 10).
 * Per-instance max is hard-capped at 50 so a typo cannot exhaust MySQL.
 */
const SEQUELIZE_POOL_DEFAULTS = Object.freeze({
    max: 10,
    min: 0,
    acquire: 30000,
    idle: 10000,
});

function envInt(env, key, fallback, min, max) {
    const n = parseInt(env[key], 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ max: number, min: number, acquire: number, idle: number }}
 */
function sequelizePoolFromEnv(env = process.env) {
    const source = env || {};
    const max = envInt(source, 'DB_POOL_MAX', SEQUELIZE_POOL_DEFAULTS.max, 1, 50);
    const min = envInt(source, 'DB_POOL_MIN', SEQUELIZE_POOL_DEFAULTS.min, 0, max);
    return {
        max,
        min,
        acquire: envInt(source, 'DB_POOL_ACQUIRE', SEQUELIZE_POOL_DEFAULTS.acquire, 1000, 120000),
        idle: envInt(source, 'DB_POOL_IDLE', SEQUELIZE_POOL_DEFAULTS.idle, 1000, 60000),
    };
}

module.exports = {
    sequelizePoolFromEnv,
    SEQUELIZE_POOL_DEFAULTS,
};
