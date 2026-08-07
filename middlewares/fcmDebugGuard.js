/**
 * Protects FCM debug endpoints.
 * - If FCM_DEBUG_SECRET is set → require matching X-FCM-Debug-Secret header (or body.debugSecret)
 * - If unset → allow only when NODE_ENV is not production
 */
module.exports = function fcmDebugGuard(req, res, next) {
  const secret = process.env.FCM_DEBUG_SECRET;
  const provided =
    req.get('X-FCM-Debug-Secret') ||
    req.body?.debugSecret ||
    req.query?.debugSecret;

  if (secret) {
    if (provided !== secret) {
      return res.status(401).json({
        status: '0',
        message: 'Unauthorized. Provide X-FCM-Debug-Secret header matching FCM_DEBUG_SECRET.'
      });
    }
    return next();
  }

  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({
      status: '0',
      message:
        'FCM debug endpoints are disabled in production unless FCM_DEBUG_SECRET is configured.'
    });
  }

  console.warn(
    '[FCM-DEBUG] Endpoint allowed without secret (NODE_ENV=%s). Set FCM_DEBUG_SECRET for stricter access.',
    process.env.NODE_ENV
  );
  return next();
};
