'use strict';

const {
  TOKEN_FILE,
  getOpsControlToken,
  tokensMatch,
  tokenFromHeaderOrBody,
} = require('../utils/opsToken');

function getExpectedToken() {
  return getOpsControlToken();
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

  const provided = tokenFromHeaderOrBody(req, {
    headers: ['X-Ops-Token'],
    bodyKeys: ['opsToken'],
  });

  if (!tokensMatch(provided, expected)) {
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
