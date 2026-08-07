const { deviceToken } = require('../../models');
const {
  getFirebaseDiagnostics,
  sendNotificationToTokens,
  sendNotification,
  isFirebaseReady
} = require('../../utils/notification');

function maskToken(token) {
  if (!token || typeof token !== 'string') return null;
  if (token.length < 24) return `${token.slice(0, 4)}…`;
  return `${token.slice(0, 12)}…${token.slice(-8)}`;
}

/**
 * GET /debug/fcm/status
 * Returns firebase.json + Admin SDK health (no private key).
 */
async function fcmStatus(req, res) {
  const diagnostics = getFirebaseDiagnostics();
  console.log('[FCM-DEBUG] status check', diagnostics);

  return res.json({
    status: diagnostics.firebaseReady && diagnostics.parseOk ? '1' : '0',
    message: diagnostics.hint,
    data: {
      ...diagnostics,
      nodeEnv: process.env.NODE_ENV || null,
      serverTime: new Date().toISOString()
    }
  });
}

/**
 * POST /debug/fcm/send
 * Body:
 *  - token (string) OR tokens (string[])  — raw FCM registration token(s)
 *  - userId (optional) — also load DB tokens for that user and include in response
 *  - title, body, data (optional)
 *
 * Sends a real push and returns per-token FCM success/error codes for debugging.
 */
async function fcmSend(req, res) {
  const {
    token,
    tokens,
    userId,
    title = 'FCM Debug Test',
    body = 'If you see this, push delivery from this server works.',
    data = {}
  } = req.body || {};

  const rawTokens = [];
  if (typeof token === 'string' && token.trim()) rawTokens.push(token.trim());
  if (Array.isArray(tokens)) {
    for (const t of tokens) {
      if (typeof t === 'string' && t.trim()) rawTokens.push(t.trim());
    }
  }

  let dbTokens = [];
  if (userId != null && userId !== '') {
    const rows = await deviceToken.findAll({
      where: { userId, status: true },
      attributes: ['id', 'userId', 'tokenId', 'status', 'createdAt', 'updatedAt']
    });
    dbTokens = rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      tokenPreview: maskToken(r.tokenId),
      status: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt
    }));
    for (const r of rows) {
      if (r.tokenId) rawTokens.push(r.tokenId);
    }
  }

  // de-dupe
  const uniqueTokens = [...new Set(rawTokens)];

  console.log('[FCM-DEBUG] /debug/fcm/send request', {
    providedTokenCount: uniqueTokens.length,
    tokenPreviews: uniqueTokens.map(maskToken),
    userId: userId || null,
    dbTokenCount: dbTokens.length,
    title,
    body,
    data,
    firebaseReady: isFirebaseReady()
  });

  if (!uniqueTokens.length) {
    return res.status(400).json({
      status: '0',
      message: 'Provide body.token (or tokens[]) and/or userId with saved device tokens.',
      data: {
        diagnostics: getFirebaseDiagnostics(),
        dbTokens
      }
    });
  }

  const payloadData = {
    type: 'fcm_debug',
    debugAt: new Date().toISOString(),
    ...(data && typeof data === 'object' ? data : {})
  };

  const result = await sendNotificationToTokens(
    uniqueTokens,
    title,
    body,
    payloadData,
    { tagPrefix: 'fcm_debug' }
  );

  // Optional: also exercise the normal userId path (DB lookup only) for comparison logs
  let userPathResult = null;
  if (userId != null && userId !== '') {
    try {
      userPathResult = await sendNotification(
        userId,
        title,
        `[via userId] ${body}`,
        payloadData,
        { throwOnFailure: false }
      );
      console.log('[FCM-DEBUG] userId path result', userPathResult);
    } catch (err) {
      userPathResult = { sent: false, error: err.message };
      console.error('[FCM-DEBUG] userId path error', err.message);
    }
  }

  const httpOk = result.sent;
  return res.status(httpOk ? 200 : 502).json({
    status: httpOk ? '1' : '0',
    message: httpOk
      ? 'Push accepted by FCM for at least one token. Check the phone notification shade.'
      : `Push failed: ${result.reason || 'see results'}. Check PM2 logs for [FCM-DEBUG].`,
    data: {
      ...result,
      dbTokens,
      userPathResult,
      howToRead: {
        FIREBASE_NOT_CONFIGURED:
          'Server firebase.json invalid/missing — fix secret/file then pm2 restart.',
        'messaging/registration-token-not-registered':
          'Token expired or app uninstalled — get a fresh FCM token from the device.',
        'messaging/mismatched-credential':
          'Service account project does not match the Android app Firebase project.',
        'messaging/invalid-registration-token':
          'Token string is malformed — copy the full token again.'
      }
    }
  });
}

module.exports = {
  fcmStatus,
  fcmSend
};
