require('dotenv').config();
const { deviceToken } = require('../models');
const { Op } = require('sequelize');
const firebaseProjects = require('./firebaseProjects');
const { deliverRouted } = require('./fcmRouting');

// Firebase Admin lives in utils/firebaseProjects.js (primary + optional legacy project).
// Initialise at load so a broken credential shows up in the boot log, not on the first push.
firebaseProjects.ensureFirebaseReady();

function ensureFirebaseReady() {
  firebaseProjects.ensureFirebaseReady();
  return firebaseProjects.isAnyProjectReady();
}

/**
 * Safe diagnostics for the Firebase credentials + Admin SDK (no secrets leaked).
 * Top-level fields describe the primary project (shape kept for existing callers);
 * `projects` lists every configured project.
 */
function getFirebaseDiagnostics() {
  // Retries init if a credential file was fixed after a failed boot (common on stage deploys).
  const ready = ensureFirebaseReady();
  const projects = firebaseProjects.projectDiagnostics();
  const primary = projects.find((p) => p.role === firebaseProjects.ROLE.PRIMARY) || {};

  const nodeMajor = Number(String(process.versions.node || '0').split('.')[0]);
  const nodeTooOld = nodeMajor > 0 && nodeMajor < 22;
  const failing = projects.filter((p) => !p.ready);

  return {
    firebaseReady: Boolean(primary.ready),
    anyProjectReady: ready,
    firebaseInitError: primary.error || null,
    appsInitialized: projects.filter((p) => p.ready).length,
    credentialSource: primary.credentialSource || null,
    databaseURL: primary.databaseURL || null,
    fileExists: Boolean(primary.fileExists),
    parseOk: Boolean(primary.parseOk),
    parseError: primary.parseError || null,
    projectId: primary.projectId || null,
    clientEmail: primary.clientEmail || null,
    privateKeyLooksValid: primary.privateKeyLooksValid ?? null,
    projects,
    nodeVersion: process.version,
    nodeMajor,
    nodeTooOld,
    firebaseAdminHint: nodeTooOld
      ? 'Firebase Admin 14 requires Node 22 or newer.'
      : null,
    hint: !primary.fileExists
      ? 'Primary Firebase credential file is missing (FIREBASE_CREDENTIALS_PATH, or ./firebase.json when unset).'
      : !primary.parseOk
        ? 'Primary Firebase credential is invalid JSON (keys/values must be quoted). Fix the deploy secret or the file on the server.'
        : failing.length
          ? `Firebase not ready for: ${failing.map((p) => `${p.role} (${p.error})`).join('; ')}`
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

function tokenPreview(token) {
  return `${token.slice(0, 12)}…${token.slice(-8)}`;
}

/** Route each token to its Firebase project (utils/fcmRouting.js). */
function deliver(entries, { title, body, data, tagPrefix, dryRun }) {
  return deliverRouted({
    entries,
    buildMessage: (tokens) => buildMulticastMessage({ title, body, data, tokens, tagPrefix }),
    messagingFor: firebaseProjects.messagingFor,
    readyProjectIds: firebaseProjects.configuredProjectIds(),
    unclassifiedOrder: firebaseProjects.unclassifiedTokenOrder(),
    dryRun: Boolean(dryRun),
  });
}

function summarize(outcomes) {
  const failedTokens = outcomes
    .filter((o) => o.verdict !== 'delivered')
    .map((o) => {
      const last = o.attempts[o.attempts.length - 1] || {};
      return {
        token: o.token,
        code: last.code || o.reason || 'unknown-error',
        message: last.message || o.reason || 'Unknown FCM error',
        verdict: o.verdict,
        attempts: o.attempts,
      };
    });
  const deliveredByProject = {};
  for (const o of outcomes) {
    if (o.verdict === 'delivered') {
      deliveredByProject[o.deliveredProjectId] = (deliveredByProject[o.deliveredProjectId] || 0) + 1;
    }
  }
  return {
    successCount: outcomes.filter((o) => o.verdict === 'delivered').length,
    failureCount: failedTokens.length,
    failedTokens,
    deliveredByProject,
  };
}

/**
 * Send a push directly to one or more raw FCM registration tokens (debug / ops / admin fallback).
 * Does not touch the deviceToken DB. Tokens go to `options.firebaseProjectId` first when given,
 * else are routed like unclassified tokens (legacy project, then primary).
 * `options.dryRun` validates the send with FCM without delivering it.
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
    tokenPreviews: tokenList.map(tokenPreview),
    title,
    body,
    dataKeys: Object.keys(data || {}),
    projects: diag.projects.map((p) => ({ role: p.role, projectId: p.projectId, ready: p.ready })),
    dryRun: Boolean(options.dryRun)
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
    console.error(`${logPrefix} Firebase not ready — aborting send`, diag.hint);
    return {
      sent: false,
      reason: 'FIREBASE_NOT_CONFIGURED',
      diagnostics: diag,
      durationMs: Date.now() - startedAt
    };
  }

  try {
    const outcomes = await deliver(
      tokenList.map((token) => ({ token, projectId: options.firebaseProjectId || null })),
      { title, body, data, tagPrefix: options.tagPrefix || 'debug', dryRun: options.dryRun }
    );
    const results = outcomes.map((o) => {
      if (o.verdict === 'delivered') {
        return {
          success: true,
          messageId: o.messageId,
          firebaseProjectId: o.deliveredProjectId,
          tokenPreview: tokenPreview(o.token)
        };
      }
      const last = o.attempts[o.attempts.length - 1] || {};
      return {
        success: false,
        tokenPreview: tokenPreview(o.token),
        code: last.code || o.reason,
        message: last.message || o.reason,
        verdict: o.verdict,
        attempts: o.attempts
      };
    });
    const summary = summarize(outcomes);

    console.log(`${logPrefix} send done`, {
      successCount: summary.successCount,
      failureCount: summary.failureCount,
      deliveredByProject: summary.deliveredByProject,
      results,
      durationMs: Date.now() - startedAt
    });

    return {
      sent: summary.successCount > 0,
      dryRun: Boolean(options.dryRun),
      successCount: summary.successCount,
      failureCount: summary.failureCount,
      deliveredByProject: summary.deliveredByProject,
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
 * Apply what a send learned about the user's tokens: record each token's real project
 * (self-healing unclassified / mis-recorded rows) and delete tokens no project accepts.
 * `dryRun`: a validate-only send changes nothing; the counts say what a real send would do.
 */
async function applyDeliveryOutcomes(userId, outcomes, { dryRun = false } = {}) {
  const learned = outcomes.filter(
    (o) => o.verdict === 'delivered' && o.deliveredProjectId !== o.recordedProjectId
  );
  const dead = outcomes.filter((o) => o.verdict === 'dead').map((o) => o.token);
  if (dryRun) {
    return { reclassified: 0, removed: 0, wouldReclassify: learned.length, wouldRemove: dead.length };
  }
  for (const o of learned) {
    await deviceToken.update(
      { firebaseProjectId: o.deliveredProjectId },
      { where: { userId, tokenId: o.token } }
    );
  }
  if (dead.length > 0) {
    await deviceToken.destroy({ where: { userId, tokenId: { [Op.in]: dead } } });
  }
  return { reclassified: learned.length, removed: dead.length };
}

/**
 * Send a notification to a user
 * @param {string} userId - The ID of the user to send the notification to
 * @param {string} title - The title of the notification
 * @param {string} body - The body of the notification
 * @param {object} data - Additional data to send with the notification
 * @param {{ throwOnFailure?: boolean, dryRun?: boolean }} [options] dryRun: FCM validate_only,
 *   and the deviceToken table is left untouched (no reclassification, no cleanup).
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
        throw new Error('Firebase Admin is not configured (no Firebase credential)');
      }
      return result;
    }

    // Retrieve device tokens for the user, with the Firebase project each belongs to
    const tokens = await deviceToken.findAll({
      where: { userId, status: true },
      attributes: ['tokenId', 'firebaseProjectId']
    });

    const { isValidFcmRegistrationToken } = require('./fcmToken');
    const validTokenRows = (tokens || []).filter((t) =>
      isValidFcmRegistrationToken(t.tokenId)
    );
    const invalidTokenIds = (tokens || [])
      .map((t) => t.tokenId)
      .filter((id) => !isValidFcmRegistrationToken(id));

    if (invalidTokenIds.length > 0 && !options.dryRun) {
      await deviceToken.destroy({
        where: {
          userId,
          tokenId: { [Op.in]: invalidTokenIds }
        }
      });
    }

    if (!validTokenRows.length) {
      console.log(`[FCM] no device tokens for user ${userId}`);
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

    // One entry per distinct token (the same token cannot be on two rows of one user).
    const seen = new Set();
    const entries = [];
    for (const row of validTokenRows) {
      if (seen.has(row.tokenId)) continue;
      seen.add(row.tokenId);
      entries.push({ token: row.tokenId, projectId: row.firebaseProjectId || null });
    }

    const outcomes = await deliver(entries, {
      title,
      body,
      data,
      tagPrefix: String(userId),
      dryRun: options.dryRun
    });
    const summary = summarize(outcomes);
    const applied = await applyDeliveryOutcomes(userId, outcomes, { dryRun: Boolean(options.dryRun) });

    const keptFailures = summary.failedTokens.filter((f) => f.verdict === 'kept');
    if (keptFailures.length > 0) {
      // Not the token's fault (APNs/auth/quota/payload, or a project this server holds no
      // key for): keep the tokens, report the cause.
      console.warn(
        `[FCM] send to user ${userId} failed for ${keptFailures.length} token(s); tokens kept:`,
        [...new Set(keptFailures.map((f) => `${f.code}: ${f.message}`))].join(' | ')
      );
    }

    console.log(
      `[FCM] user ${userId}: delivered=${summary.successCount}/${entries.length}`,
      summary.deliveredByProject,
      applied.reclassified || applied.removed ? applied : ''
    );

    const result = {
      sent: summary.successCount > 0,
      userId,
      tokenCount: entries.length,
      successCount: summary.successCount,
      failureCount: summary.failureCount,
      deliveredByProject: summary.deliveredByProject,
      dryRun: Boolean(options.dryRun),
      reclassifiedTokens: applied.reclassified,
      removedTokens: applied.removed,
      ...(options.dryRun
        ? { wouldReclassifyTokens: applied.wouldReclassify, wouldRemoveTokens: applied.wouldRemove + invalidTokenIds.length }
        : {}),
      failedTokens: summary.failedTokens
    };

    if (throwOnFailure && summary.successCount === 0) {
      throw new Error(
        `Notification send failed for all tokens: ${JSON.stringify(
          summary.failedTokens.map((f) => ({ code: f.code, verdict: f.verdict }))
        )}`
      );
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
  ensureFirebaseReady,
  isFirebaseReady: () => firebaseProjects.isAnyProjectReady()
};
