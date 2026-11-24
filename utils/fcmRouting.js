'use strict';

/**
 * Deliver one push to many FCM tokens that may belong to different Firebase projects.
 *
 * An FCM token can only be sent through the project that issued it. Each token is tried on:
 *  - its recorded project first (deviceTokens.firebaseProjectId), then the other projects —
 *    so a mis-recorded token heals itself;
 *  - when nothing is recorded (rows stored before projects were recorded): the legacy project,
 *    then the primary (firebaseProjects.unclassifiedTokenOrder).
 * A project answering "not my token" (sender-id mismatch, unregistered, invalid registration)
 * hands the token to the next project; any other error (quota, auth, APNs config, payload)
 * stops there and keeps the token — it is not the token's fault.
 *
 * Verdicts:
 *  - delivered: some project accepted it; `deliveredProjectId` is the token's real project
 *    (the caller records it when it differs from the recorded one).
 *  - dead: every configured project rejected it and at least one said the token itself is
 *    unregistered/invalid — safe (and required) to delete.
 *  - kept: anything else — a server-side error, the recorded project is not configured here,
 *    or only sender-id mismatches (the token belongs to a project this server holds no key
 *    for, e.g. a missing legacy credential: deleting would wipe every such user's push).
 *
 * Pure apart from the injected `messagingFor`, so it is unit-testable without Firebase.
 */

const { isStaleTokenError } = require('./fcmToken');

const MULTICAST_LIMIT = 500;

/** FCM says the token was issued by another sender/project. */
function isWrongProjectError(error) {
  const code = error && error.code;
  if (code === 'messaging/mismatched-credential') return true;
  return /sender ?id mismatch/i.test(String((error && error.message) || ''));
}

/** The project did not accept the token as its own: try the next project. */
function isNotThisProjectsToken(error) {
  return isWrongProjectError(error) || isStaleTokenError(error);
}

function candidateProjects(recordedProjectId, readyProjectIds, unclassifiedOrder) {
  const ready = new Set(readyProjectIds);
  if (recordedProjectId && ready.has(recordedProjectId)) {
    return {
      queue: [recordedProjectId, ...unclassifiedOrder.filter((p) => p !== recordedProjectId)],
      recordedUnavailable: false,
    };
  }
  return { queue: [...unclassifiedOrder], recordedUnavailable: Boolean(recordedProjectId) };
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * @param {object} args
 * @param {{ token: string, projectId?: string|null }[]} args.entries
 * @param {(tokens: string[]) => object} args.buildMessage multicast message for these tokens
 * @param {(projectId: string) => { sendEachForMulticast: Function }} args.messagingFor
 * @param {string[]} args.readyProjectIds configured + initialised projects
 * @param {string[]} args.unclassifiedOrder order for tokens without a recorded project
 * @param {boolean} [args.dryRun] validate only (FCM validate_only), nothing is delivered
 * @returns {Promise<Array<{
 *   token: string, recordedProjectId: string|null, verdict: 'delivered'|'dead'|'kept',
 *   deliveredProjectId: string|null, messageId: string|null, reason: string|null,
 *   attempts: { projectId: string, code: string, message: string }[]
 * }>>} one outcome per entry, same order
 */
async function deliverRouted({ entries, buildMessage, messagingFor, readyProjectIds, unclassifiedOrder, dryRun = false }) {
  const outcomes = entries.map((e) => {
    const { queue, recordedUnavailable } = candidateProjects(e.projectId || null, readyProjectIds, unclassifiedOrder);
    return {
      token: e.token,
      recordedProjectId: e.projectId || null,
      verdict: null,
      deliveredProjectId: null,
      messageId: null,
      reason: null,
      attempts: [],
      queue,
      recordedUnavailable,
    };
  });

  for (;;) {
    const byProject = new Map();
    for (const o of outcomes) {
      if (o.verdict || o.queue.length === 0) continue;
      const projectId = o.queue[0];
      if (!byProject.has(projectId)) byProject.set(projectId, []);
      byProject.get(projectId).push(o);
    }
    if (byProject.size === 0) break;

    for (const [projectId, group] of byProject) {
      for (const batch of chunk(group, MULTICAST_LIMIT)) {
        let responses;
        try {
          const response = await messagingFor(projectId).sendEachForMulticast(
            buildMessage(batch.map((o) => o.token)),
            dryRun
          );
          responses = response.responses;
        } catch (err) {
          // The whole call failed (credential, network): a server problem, never the tokens'.
          responses = batch.map(() => ({ success: false, error: err }));
        }
        batch.forEach((o, idx) => {
          o.queue.shift();
          const resp = responses[idx] || { success: false, error: { code: 'unknown-error' } };
          if (resp.success) {
            o.verdict = 'delivered';
            o.deliveredProjectId = projectId;
            o.messageId = resp.messageId || null;
            return;
          }
          const error = resp.error || {};
          o.attempts.push({
            projectId,
            code: error.code || 'unknown-error',
            message: error.message || 'Unknown FCM error',
          });
          if (!isNotThisProjectsToken(error)) {
            o.verdict = 'kept';
            o.reason = error.code || 'unknown-error';
          }
        });
      }
    }
  }

  for (const o of outcomes) {
    if (o.verdict) continue;
    if (o.attempts.length === 0) {
      o.verdict = 'kept';
      o.reason = 'FIREBASE_NOT_CONFIGURED';
    } else if (o.recordedUnavailable) {
      o.verdict = 'kept';
      o.reason = 'FIREBASE_PROJECT_NOT_CONFIGURED';
    } else if (o.attempts.some((a) => isStaleTokenError(a))) {
      o.verdict = 'dead';
      o.reason = o.attempts[o.attempts.length - 1].code;
    } else {
      o.verdict = 'kept';
      o.reason = 'SENDER_MISMATCH_ALL_PROJECTS';
    }
  }

  return outcomes.map(({ queue, recordedUnavailable, ...rest }) => rest);
}

module.exports = {
  MULTICAST_LIMIT,
  isWrongProjectError,
  isNotThisProjectsToken,
  candidateProjects,
  deliverRouted,
};
