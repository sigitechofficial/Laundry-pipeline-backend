'use strict';

const jwt = require('jsonwebtoken');

const DEFAULT_ADMIN_JWT_EXPIRES_IN = '8h';
const DEFAULT_ADMIN_JWT_EXPIRES_IN_MS = 8 * 60 * 60 * 1000;

function getAdminJwtExpiresIn() {
  const raw = String(process.env.ADMIN_JWT_EXPIRES_IN || '').trim();
  return raw || DEFAULT_ADMIN_JWT_EXPIRES_IN;
}

function getAdminJwtExpiresInMs() {
  const raw = getAdminJwtExpiresIn();
  if (/^\d+$/.test(raw)) {
    const sec = Number(raw);
    return Number.isFinite(sec) && sec > 0 ? sec * 1000 : DEFAULT_ADMIN_JWT_EXPIRES_IN_MS;
  }
  const matched = /^(\d+)\s*(ms|s|m|h|d)$/i.exec(raw);
  if (!matched) return DEFAULT_ADMIN_JWT_EXPIRES_IN_MS;
  const n = Number(matched[1]);
  const unit = matched[2].toLowerCase();
  const mult = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  const ms = n * (mult[unit] || 0);
  return ms > 0 ? ms : DEFAULT_ADMIN_JWT_EXPIRES_IN_MS;
}

function signAdminAccessToken(payload) {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) {
    throw new Error('JWT_ACCESS_SECRET must be set');
  }
  return jwt.sign(payload, secret, { expiresIn: getAdminJwtExpiresIn() });
}

module.exports = {
  DEFAULT_ADMIN_JWT_EXPIRES_IN,
  DEFAULT_ADMIN_JWT_EXPIRES_IN_MS,
  getAdminJwtExpiresIn,
  getAdminJwtExpiresInMs,
  signAdminAccessToken,
};
