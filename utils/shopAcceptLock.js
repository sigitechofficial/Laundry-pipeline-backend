'use strict';

const crypto = require('crypto');
const { ConflictError } = require('../middlewares/universalErrorHandler');

const LOCK_TTL_MS = 10 * 1000;
const WAIT_MS = 4 * 1000;
const RETRY_MS = 100;
const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serialises capacity check + accept per shop so two devices cannot both take
 * the last slot. Fails open (runs unlocked) when Redis is unavailable, so
 * accepting never depends on Redis.
 */
async function withShopAcceptLock(shopAddressId, fn) {
  let redis;
  try {
    redis = require('../redis/redis');
  } catch (_) {
    return fn();
  }
  if (!redis?.isReady) return fn();

  const key = `shop-accept-lock:${shopAddressId}`;
  const token = crypto.randomUUID();
  const deadline = Date.now() + WAIT_MS;

  for (;;) {
    let acquired;
    try {
      acquired = (await redis.set(key, token, { NX: true, PX: LOCK_TTL_MS })) === 'OK';
    } catch (err) {
      console.warn('[shopAcceptLock] redis unavailable, accepting unlocked:', err?.message || err);
      return fn();
    }
    if (acquired) break;
    if (Date.now() >= deadline) {
      throw new ConflictError('Another order is being accepted for your shop. Please try again.');
    }
    await sleep(RETRY_MS);
  }

  try {
    return await fn();
  } finally {
    try {
      await redis.eval(RELEASE_SCRIPT, { keys: [key], arguments: [token] });
    } catch (err) {
      console.warn('[shopAcceptLock] release failed (expires on its own):', err?.message || err);
    }
  }
}

module.exports = { withShopAcceptLock };
