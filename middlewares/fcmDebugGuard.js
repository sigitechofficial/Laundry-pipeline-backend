/**
 * Protects FCM debug endpoints.
 * - FCM_DEBUG_SECRET (header / body only) or OPS_CONTROL_TOKEN (X-Ops-Token) unlocks
 * - Query-string secrets are ignored (they leak in access logs)
 * - Production: disabled unless a matching token is presented
 * - Non-production: allowed without a secret (warns)
 */
const {
  getOpsControlToken,
  tokensMatch,
  tokenFromHeaderOrBody,
} = require('../utils/opsToken');

module.exports = function fcmDebugGuard(req, res, next) {
  const fcmSecret = String(process.env.FCM_DEBUG_SECRET || '').trim();
  const opsToken = getOpsControlToken();
  const providedFcm = tokenFromHeaderOrBody(req, {
    headers: ['X-FCM-Debug-Secret'],
    bodyKeys: ['debugSecret'],
  });
  const providedOps = tokenFromHeaderOrBody(req, {
    headers: ['X-Ops-Token'],
    bodyKeys: [],
  });

  if (fcmSecret && tokensMatch(providedFcm, fcmSecret)) {
    return next();
  }
  if (opsToken && tokensMatch(providedOps, opsToken)) {
    return next();
  }

  if (fcmSecret) {
    return res.status(401).json({
      status: '0',
      message: 'Unauthorized. Provide X-FCM-Debug-Secret header matching FCM_DEBUG_SECRET.',
    });
  }

  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({
      status: '0',
      message:
        'FCM debug endpoints are disabled in production unless FCM_DEBUG_SECRET or OPS_CONTROL_TOKEN is configured.',
    });
  }

  console.warn(
    '[FCM-DEBUG] Endpoint allowed without secret (NODE_ENV=%s). Set FCM_DEBUG_SECRET for stricter access.',
    process.env.NODE_ENV
  );
  return next();
};
