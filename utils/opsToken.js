'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN_FILE = path.resolve(__dirname, '..', '.ops-control-token');

function readTokenFile() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const v = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    return v || null;
  } catch {
    return null;
  }
}

function getOpsControlToken() {
  const fromEnv = String(process.env.OPS_CONTROL_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  return readTokenFile();
}

/**
 * Token that may authorize stage deploy / install / migrate / pm2.
 * Prefers a dedicated deploy token, then OPS_CONTROL_TOKEN / token file.
 */
function getDeployOrOpsToken() {
  const dedicated = String(
    process.env.STAGE_TRIGGER_TOKEN || process.env.DEPLOY_TRIGGER_TOKEN || ''
  ).trim();
  if (dedicated) return dedicated;
  return getOpsControlToken();
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function tokensMatch(provided, expected) {
  if (!provided || !expected) return false;
  return timingSafeEqualString(provided, expected);
}

/**
 * Read a secret from headers or JSON body only — never the query string
 * (query tokens leak via access logs, Referer, and browser history).
 */
function tokenFromHeaderOrBody(req, { headers = [], bodyKeys = [] } = {}) {
  for (const name of headers) {
    const v = req.get && req.get(name);
    if (v) return String(v).trim();
  }
  const auth = (req.get && req.get('Authorization')) || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer) return String(bearer[1]).trim();
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  for (const key of bodyKeys) {
    if (body[key] != null && String(body[key]).trim()) {
      return String(body[key]).trim();
    }
  }
  return '';
}

module.exports = {
  TOKEN_FILE,
  getOpsControlToken,
  getDeployOrOpsToken,
  timingSafeEqualString,
  tokensMatch,
  tokenFromHeaderOrBody,
};
