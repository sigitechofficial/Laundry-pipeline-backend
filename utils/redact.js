'use strict';

/**
 * Masks credentials before anything is logged.
 *
 * Use whenever a request body, user row, token payload or similar object is logged:
 *   console.log('[createBooking] body', redact(req.body));
 *
 * Keys are matched case-insensitively at any depth (objects, arrays, Sequelize
 * instances via toJSON). Values are replaced, never partially shown, so nothing
 * that could be replayed (password, OTP, session token, card/Stripe secret) reaches
 * the logs. Guarded by scripts/check-log-secrets.js in CI.
 */

const SENSITIVE_KEYS = new Set(
  [
    'password',
    'confirmPassword',
    'newPassword',
    'oldPassword',
    'currentPassword',
    'hashpass',
    'otp',
    'accessToken',
    'refreshToken',
    'token',
    'dvToken',
    'tokenId',
    'idToken',
    'authorization',
    'cookie',
    'cookies',
    'secret',
    'clientSecret',
    'client_secret',
    'apiKey',
    'api_key',
    'privateKey',
    'private_key',
    'cardNumber',
    'cvc',
    'cvv',
  ].map((k) => k.toLowerCase())
);

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;

function isSensitiveKey(key) {
  return SENSITIVE_KEYS.has(String(key).toLowerCase());
}

function redact(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (typeof value.toJSON === 'function' && !(value instanceof Date)) {
    return redact(value.toJSON(), depth, seen);
  }
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redact(v, depth + 1, seen);
  }
  return out;
}

module.exports = { redact, isSensitiveKey, REDACTED };
