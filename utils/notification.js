require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const { deviceToken } = require('../models');
const { Op } = require('sequelize');

// Initialize Firebase Admin SDK only when a local service-account file exists.
// Guard prevents "already exists" crash on hot reload.
// Use readFileSync+JSON.parse (not require) so a fixed firebase.json can be
// picked up without relying on Node's require cache after a bad boot.
const firebaseCredPath = path.join(__dirname, '../firebase.json');
let firebaseReady = false;
let firebaseInitError = null;

/**
 * RTDB URL — set FIREBASE_DATABASE_URL in env after enabling Realtime Database
 * in the Firebase console (e.g. https://laundry-app-bf43c-default-rtdb.firebaseio.com).
 */
function getFirebaseDatabaseUrl() {
  const fromEnv = (process.env.FIREBASE_DATABASE_URL || '').trim();
  if (fromEnv) return fromEnv;
  // Sensible default for project laundry-app-bf43c; override via env if region differs.
  return 'https://laundry-app-bf43c-default-rtdb.firebaseio.com';
}

function ensureFirebaseReady() {
  if (firebaseReady && getApps().length) {
    return true;
  }
  if (getApps().length) {
    firebaseReady = true;
    firebaseInitError = null;
    return true;
  }
  if (!fs.existsSync(firebaseCredPath)) {
    firebaseReady = false;
    firebaseInitError = 'firebase.json not found';
    return false;
  }
  try {
    const serviceAccount = JSON.parse(fs.readFileSync(firebaseCredPath, 'utf8'));
    const databaseURL = getFirebaseDatabaseUrl();
    initializeApp({
      credential: cert(serviceAccount),
      databaseURL,
    });
    firebaseReady = true;
    firebaseInitError = null;
    console.log(
      '[Firebase] Admin initialized OK project_id=%s databaseURL=%s',
      serviceAccount.project_id || '?',
      databaseURL
    );
    return true;
  } catch (err) {
    firebaseReady = false;
    firebaseInitError = err.message;
    console.warn(
      'Firebase Admin not initialized (invalid or missing firebase.json):',
      err.message
    );
    return false;
  }
}

ensureFirebaseReady();

/**
 * Safe diagnostics for firebase.json + Admin SDK (no secrets leaked).
 */
function getFirebaseDiagnostics() {
  // Retry init if file was fixed after a failed boot (common on stage deploys).
  ensureFirebaseReady();

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

  const nodeMajor = Number(String(process.versions.node || '0').split('.')[0]);
  const nodeTooOld = nodeMajor > 0 && nodeMajor < 22;

  return {
    firebaseReady,
    firebaseInitError,
    appsInitialized: getApps().length,
    credPath: firebaseCredPath,
    databaseURL: getFirebaseDatabaseUrl(),
    fileExists,
    parseOk,
    parseError,
    projectId,
    clientEmail,
    privateKeyLooksValid,
    filePreview,
    nodeVersion: process.version,
    nodeMajor,
    nodeTooOld,
    firebaseAdminHint: nodeTooOld
      ? 'Firebase Admin 14 requires Node 22 or newer.'
      : null,
    hint: !parseOk
      ? 'firebase.json is invalid JSON (keys/values must be quoted). Fix FIREBASE_CONTENT_STAGE secret or replace the file on the server.'
      : !firebaseReady
        ? 'JSON parses but Admin SDK is not ready — check private_key newlines and restart PM2.'
        : nodeTooOld
          ? 'Firebase initialized, but Firebase Admin 14 requires Node 22 or newer.'
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
        // Omit channelId so each app uses its Manifest
        // default_notification_channel_id (customer: high_importance_channel,
        // agent: laundry_notifications_v2). Hardcoding laundry_default created
        // a mismatched channel and could show the wrong icon/style.
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
        icon: '/images/logo.png'
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

  ensureFirebaseReady();
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

  if (!ensureFirebaseReady()) {
    console.error(`${logPrefix} Firebase not ready — aborting send`, diag);
    return {
      sent: false,
      reason: 'FIREBASE_NOT_CONFIGURED',
      diagnostics: getFirebaseDiagnostics(),
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
    const response = await getMessaging().sendEachForMulticast(message);
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

    if (!ensureFirebaseReady()) {
      const result = {
        sent: false,
        reason: 'FIREBASE_NOT_CONFIGURED',
        userId,
        successCount: 0,
        failureCount: 0,
        tokenCount: 0,
        diagnostics: getFirebaseDiagnostics()
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

    const { isValidFcmRegistrationToken } = require('./fcmToken');
    const validTokenRows = (tokens || []).filter((t) =>
      isValidFcmRegistrationToken(t.tokenId)
    );
    const invalidTokenIds = (tokens || [])
      .map((t) => t.tokenId)
      .filter((id) => !isValidFcmRegistrationToken(id));

    if (invalidTokenIds.length > 0) {
      await deviceToken.destroy({
        where: {
          userId,
          tokenId: { [Op.in]: invalidTokenIds }
        }
      });
    }

    if (!validTokenRows.length) {
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

    const tokenIds = validTokenRows.map(token => token.tokenId);
    const message = buildMulticastMessage({
      title,
      body,
      data,
      tokens: tokenIds,
      tagPrefix: String(userId)
    });

    // Send the notification
    const response = await getMessaging().sendEachForMulticast(message);
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
        item.code === 'messaging/invalid-registration-token' ||
        item.code === 'messaging/invalid-argument'
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
  getFirebaseDatabaseUrl,
  ensureFirebaseReady,
  isFirebaseReady: () => firebaseReady
}; 