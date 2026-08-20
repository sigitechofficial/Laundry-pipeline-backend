'use strict';

const {
  getOpsControlToken,
  tokensMatch,
  tokenFromHeaderOrBody,
} = require('../utils/opsToken');

function isProduction() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

/**
 * Bind detailed health / docs surfaces to an ops token on production.
 * Development and stage stay reachable for local QA and deploy diagnostics.
 * Simple GET /health liveness is never wrapped by this guard.
 */
function sensitiveSurfaceGuard(req, res, next) {
  if (!isProduction()) {
    return next();
  }

  const expected = getOpsControlToken();
  if (!expected) {
    return res.status(404).json({
      status: '0',
      message: 'Not found',
    });
  }

  const provided = tokenFromHeaderOrBody(req, {
    headers: ['X-Ops-Token', 'X-Health-Probe-Token'],
    bodyKeys: [],
  });

  if (!tokensMatch(provided, expected)) {
    return res.status(401).json({
      status: '0',
      message: 'Unauthorized. Provide X-Ops-Token matching OPS_CONTROL_TOKEN.',
    });
  }

  return next();
}

module.exports = sensitiveSurfaceGuard;
