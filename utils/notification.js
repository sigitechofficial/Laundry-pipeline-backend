require('dotenv').config();
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { deviceToken } = require('../models');
const { Op } = require('sequelize');

// Initialize Firebase Admin SDK only when a local service-account file exists.
// Guard prevents "already exists" crash on hot reload.
const firebaseCredPath = path.join(__dirname, '../firebase.json');
let firebaseReady = false;
let firebaseInitError = null;
if (fs.existsSync(firebaseCredPath) && !admin.apps.length) {
  try {
    const serviceAccount = require(firebaseCredPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    firebaseReady = true;
  } catch (err) {
    firebaseInitError = err.message;
    console.warn('Firebase Admin not initialized (invalid or missing firebase.json):', err.message);
  }
} else if (admin.apps.length) {
  firebaseReady = true;
} else {
  firebaseInitError = 'firebase.json not found';
  console.warn('Firebase Admin skipped: firebase.json not found (push notifications disabled locally).');
}

/**
 * Safe diagnostics for firebase.json + Admin SDK (no secrets leaked).
 */
function getFirebaseDiagnostics() {
  const fileExists = fs.existsSync(firebaseCredPath);
  let parseOk = false;
  let parseError = null;
  let projectId = null;
  let clientEmail = null;
  let privateKeyLooksValid = null;
  let filePreview = null;

  if (fileExists) {
    try {
      const raw = fs.readFileSync(firebaseCredPath, 'utf8');
      filePreview = raw.slice(0, 80).replace(/\s+/g, ' ');
      const sa = JSON.parse(raw);
      parseOk = true;
      projectId = sa.project_id || null;
      clientEmail = sa.client_email || null;
      const pk = typeof sa.private_key === 'string' ? sa.private_key : '';
      privateKeyLooksValid =
        pk.includes('BEGIN PRIVATE KEY') && (pk.includes('\\n') || pk.includes('\n'));
    } catch (err) {
      parseError = err.message;
    }
  }

  return {
    firebaseReady,
    firebaseInitError,
    appsInitialized: admin.apps.length,
    credPath: firebaseCredPath,
    fileExists,
    parseOk,
    parseError,
    projectId,
    clientEmail,
    privateKeyLooksValid,
    filePreview,
    hint: !parseOk
      ? 'firebase.json is invalid JSON (keys/values must be quoted). Fix FIREBASE_CONTENT_STAGE secret or replace the file on the server.'
      : !firebaseReady
        ? 'JSON parses but Admin SDK is not ready — check private_key newlines and restart PM2.'
        : 'Firebase Admin looks ready.'
  };
}

function buildMulticastMessage({ title, body, data = {}, tokens, tagPrefix = 'debug' }) {
  const sanitizedData = Object.entries(data || {}).reduce((acc, [key, value]) => {
    acc[key] = typeof value === 'string' ? value : JSON.stringify(value);
    return acc;
  }, {});

  return {
    notification: { title, body },
    data: sanitizedData,
    android: {
      priority: 'high',
      notification: {
        channelId: 'laundry_default',
        priority: 'high',
        defaultSound: true,
        defaultVibrateTimings: true,
        sound: 'default',
        tag: `${tagPrefix}_${Date.now()}`
      }
    },
    apns: {
      headers: { 'apns-priority': '10' },
      payload: {
        aps: {
          sound: 'default',
          badge: 1,
          contentAvailable: true,
          mutableContent: true
        }
      }
    },
    webpush: {
      headers: { Urgency: 'high' },
      notification: {
        title,
        body,
        icon: '/icons/icon-192x192.png'
      }
    },
    tokens
  };
}

/**
 * Send a push directly to one or more raw FCM registration tokens (debug / ops).
 * Does not touch the deviceToken DB.
 */
async function sendNotificationToTokens(tokens, title, body, data = {}, options = {}) {
  const logPrefix = '[FCM-DEBUG]';
  const startedAt = Date.now();
  const tokenList = (Array.isArray(tokens) ? tokens : [tokens])
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter(Boolean);

  const diag = getFirebaseDiagnostics();
  console.log(`${logPrefix} send start`, {
    tokenCount: tokenList.length,
    tokenPreviews: tokenList.map((t) => `${t.slice(0, 12)}…${t.slice(-8)}`),
    title,
    body,
    dataKeys: Object.keys(data || {}),
    firebaseReady: diag.firebaseReady,
    projectId: diag.projectId,
    parseOk: diag.parseOk,
    parseError: diag.parseError
  });

  if (!tokenList.length) {
    return {
      sent: false,
      reason: 'NO_TOKEN_PROVIDED',
      diagnostics: diag,
      durationMs: Date.now() - startedAt
    };
  }

  if (!firebaseReady) {
    console.error(`${logPrefix} Firebase not ready — aborting send`, diag);
    return {
      sent: false,
      reason: 'FIREBASE_NOT_CONFIGURED',
      diagnostics: diag,
      durationMs: Date.now() - startedAt
    };
  }

  const message = buildMulticastMessage({
    title,
    body,
    data,
    tokens: tokenList,
    tagPrefix: options.tagPrefix || 'debug'
  });

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    const results = response.responses.map((resp, index) => {
      const token = tokenList[index];
      if (resp.success) {
        return {
          success: true,
          messageId: resp.messageId,
          tokenPreview: `${token.slice(0, 12)}…${token.slice(-8)}`
        };
      }
      return {
        success: false,
        tokenPreview: `${token.slice(0, 12)}…${token.slice(-8)}`,
        code: resp.error?.code || 'unknown-error',
        message: resp.error?.message || 'Unknown FCM error',
        errorInfo: resp.error?.errorInfo || null
      };
    });

    console.log(`${logPrefix} send done`, {
      successCount: response.successCount,
      failureCount: response.failureCount,
      results,
      durationMs: Date.now() - startedAt
    });

    return {
      sent: response.successCount > 0,
      successCount: response.successCount,
      failureCount: response.failureCount,
      tokenCount: tokenList.length,
      results,
      diagnostics: diag,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    console.error(`${logPrefix} send threw`, {
      message: error.message,
      code: error.code,
      stack: error.stack
    });
    return {
      sent: false,
      reason: 'SEND_ERROR',
      error: error.message,
      code: error.code || null,
      diagnostics: diag,
      durationMs: Date.now() - startedAt
    };
  }
}

/**
 * Send a notification to a user
 * @param {string} userId - The ID of the user to send the notification to
 * @param {string} title - The title of the notification
 * @param {string} body - The body of the notification
 * @param {object} data - Additional data to send with the notification
 */
async function sendNotification(userId, title, body, data = {}, options = {}) {
  try {
    const { throwOnFailure = false } = options;

    if (!firebaseReady) {
      const result = {
        sent: false,
        reason: 'FIREBASE_NOT_CONFIGURED',
        userId,
        successCount: 0,
        failureCount: 0,
        tokenCount: 0
      };
      if (throwOnFailure) {
        throw new Error('Firebase Admin is not configured (missing firebase.json)');
      }
      return result;
    }

    // Retrieve device tokens for the user
    const tokens = await deviceToken.findAll({
      where: { userId, status: true },
      attributes: ['tokenId']
    });

    console.log("🚀 ~ sendNotification ~ tokens:", tokens);

    if (!tokens || tokens.length === 0) {
      console.log(`No device tokens found for user ++++++++++++++++++++++++++ ${userId}`);
      const result = {
        sent: false,
        reason: 'NO_TOKENS',
        userId,
        successCount: 0,
        failureCount: 0,
        tokenCount: 0
      };
      if (throwOnFailure) {
        throw new Error(`No active device tokens found for user ${userId}`);
      }
      return result;
    }

    const tokenIds = tokens.map(token => token.tokenId);
    const message = buildMulticastMessage({
      title,
      body,
      data,
      tokens: tokenIds,
      tagPrefix: String(userId)
    });

    // Send the notification
    const response = await admin.messaging().sendEachForMulticast(message);
    console.log('Successfully sent message:', response);

    const failedTokens = response.responses
      .map((resp, index) => ({ resp, token: tokenIds[index] }))
      .filter(({ resp }) => !resp.success)
      .map(({ resp, token }) => ({
        token,
        code: resp.error?.code || 'unknown-error',
        message: resp.error?.message || 'Unknown FCM error'
      }));

    const invalidTokens = failedTokens
      .filter(item =>
        item.code === 'messaging/registration-token-not-registered' ||
        item.code === 'messaging/invalid-registration-token'
      )
      .map(item => item.token);

    if (invalidTokens.length > 0) {
      await deviceToken.destroy({
        where: {
          userId,
          tokenId: { [Op.in]: invalidTokens }
        }
      });
    }

    const result = {
      sent: response.successCount > 0,
      userId,
      tokenCount: tokenIds.length,
      successCount: response.successCount,
      failureCount: response.failureCount,
      failedTokens
    };

    if (throwOnFailure && response.successCount === 0) {
      throw new Error(`Notification send failed for all tokens: ${JSON.stringify(failedTokens)}`);
    }

    return result;
  } catch (error) {
    console.error('Error sending notification:', error);
    if (options?.throwOnFailure) {
      throw error;
    }
    return {
      sent: false,
      reason: 'SEND_ERROR',
      error: error.message
    };
  }
}

module.exports = {
  sendNotification,
  sendNotificationToTokens,
  getFirebaseDiagnostics,
  isFirebaseReady: () => firebaseReady
}; 