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

function getExpectedToken() {
  const fromEnv = String(process.env.OPS_CONTROL_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  return readTokenFile();
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) {
    // Compare against self to keep runtime roughly constant when lengths differ
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

/**
 * Protects /ops/* control-plane endpoints.
 * Requires OPS_CONTROL_TOKEN (.env) or .ops-control-token file.
 * Header: X-Ops-Token (also accepts Authorization: Bearer <token>)
 */
function opsControlGuard(req, res, next) {
  const expected = getExpectedToken();
  if (!expected) {
    return res.status(503).json({
      status: '0',
      message:
        'Ops control disabled. Set OPS_CONTROL_TOKEN in .env or create .ops-control-token, then pm2 reload --update-env.'
    });
  }

  const headerToken = req.get('X-Ops-Token') || '';
  const auth = req.get('Authorization') || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  const provided = String(headerToken || (bearer && bearer[1]) || req.query?.opsToken || '').trim();

  if (!provided || !timingSafeEqualString(provided, expected)) {
    console.warn('[OPS] unauthorized', {
      ip: req.ip || req.connection?.remoteAddress || null,
      path: req.originalUrl || req.url,
      method: req.method
    });
    return res.status(401).json({
      status: '0',
      message: 'Unauthorized. Provide X-Ops-Token matching OPS_CONTROL_TOKEN.'
    });
  }

  return next();
}

module.exports = opsControlGuard;
module.exports.getExpectedToken = getExpectedToken;
module.exports.TOKEN_FILE = TOKEN_FILE;
