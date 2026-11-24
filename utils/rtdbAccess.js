'use strict';

/**
 * Bounded, circuit-broken access to each Firebase project's Realtime Database.
 *
 * The Admin SDK never settles a call to an RTDB instance that is missing or unreachable (it
 * keeps retrying), so every per-project call is bounded by LIVE_TRACKING_RTDB_TIMEOUT_MS.
 * A bound alone still makes every request pay the timeout while one project's RTDB is down
 * (e.g. FIREBASE_DATABASE_URL set before the instance exists), so each project also has a
 * circuit breaker: after LIVE_TRACKING_RTDB_BREAKER_THRESHOLD consecutive failures its calls
 * fail fast for LIVE_TRACKING_RTDB_COOLDOWN_MS, then one window of calls is let through again
 * (half-open); any success closes it. The health check probe feeds the same breaker.
 *
 * Also offers REST reads (shallow key listing, probe) authenticated with the project's own
 * service-account access token, for what the SDK cannot do cheaply.
 */

const firebaseProjects = require('./firebaseProjects');

function envMs(name, fallback, min) {
  const n = Number(process.env[name]);
  return Math.max(min, Number.isFinite(n) && n > 0 ? n : fallback);
}

const RTDB_TIMEOUT_MS = envMs('LIVE_TRACKING_RTDB_TIMEOUT_MS', 5000, 500);
const BREAKER_COOLDOWN_MS = envMs('LIVE_TRACKING_RTDB_COOLDOWN_MS', 30000, 1000);
const BREAKER_THRESHOLD = Math.max(1, Number(process.env.LIVE_TRACKING_RTDB_BREAKER_THRESHOLD) || 2);

function withTimeout(promise, label, ms = RTDB_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/** projectId -> { failures, openUntil, lastError, lastFailureAt, lastSuccessAt } */
const breakers = new Map();

function breakerOf(projectId) {
  if (!breakers.has(projectId)) {
    breakers.set(projectId, { failures: 0, openUntil: 0, lastError: null, lastFailureAt: null, lastSuccessAt: null });
  }
  return breakers.get(projectId);
}

function isOpen(projectId, now = Date.now()) {
  const b = breakers.get(projectId);
  return Boolean(b && b.openUntil > now);
}

function recordSuccess(projectId) {
  const b = breakerOf(projectId);
  if (b.openUntil) console.log(`[rtdb] ${projectId} reachable again; circuit closed`);
  b.failures = 0;
  b.openUntil = 0;
  b.lastSuccessAt = Date.now();
}

function recordFailure(projectId, err) {
  const b = breakerOf(projectId);
  b.failures += 1;
  b.lastError = (err && err.message) || String(err);
  b.lastFailureAt = Date.now();
  if (b.failures >= BREAKER_THRESHOLD) {
    const wasOpen = b.openUntil > b.lastFailureAt;
    b.openUntil = b.lastFailureAt + BREAKER_COOLDOWN_MS;
    if (!wasOpen) {
      console.warn(
        `[rtdb] ${projectId} failing (${b.failures}x, last: ${b.lastError}); skipping it for ${BREAKER_COOLDOWN_MS}ms`
      );
    }
  }
}

function breakerState(projectId) {
  const b = breakers.get(projectId);
  if (!b) return { open: false, failures: 0, lastError: null, openUntil: null };
  return {
    open: isOpen(projectId),
    failures: b.failures,
    lastError: b.lastError,
    openUntil: b.openUntil ? new Date(b.openUntil).toISOString() : null,
    lastSuccessAt: b.lastSuccessAt ? new Date(b.lastSuccessAt).toISOString() : null,
  };
}

function circuitOpenError(projectId) {
  const b = breakers.get(projectId);
  const err = new Error(`RTDB ${projectId} skipped: circuit open (${(b && b.lastError) || 'recent failures'})`);
  err.code = 'RTDB_CIRCUIT_OPEN';
  return err;
}

/**
 * Run `fn(db)` against one project's RTDB: fails fast while its circuit is open, is bounded
 * by the timeout, and records the outcome.
 */
async function guarded(projectId, label, fn) {
  if (isOpen(projectId)) throw circuitOpenError(projectId);
  const db = firebaseProjects.databaseFor(projectId);
  try {
    const value = await withTimeout(fn(db), `${label} ${projectId}`);
    recordSuccess(projectId);
    return value;
  } catch (err) {
    recordFailure(projectId, err);
    throw err;
  }
}

/** Ready projects whose circuit is not open, primary first. */
function usableProjects() {
  return firebaseProjects.readyProjects().filter((p) => !isOpen(p.projectId));
}

/* ---------------- REST (service-account access token) ---------------- */

const tokens = new Map(); // projectId -> { value, expiresAt }

async function accessToken(project) {
  const cached = tokens.get(project.projectId);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.value;
  const credential = project.app && project.app.options && project.app.options.credential;
  if (!credential || typeof credential.getAccessToken !== 'function') {
    throw new Error(`no credential to read RTDB ${project.projectId}`);
  }
  const t = await credential.getAccessToken();
  tokens.set(project.projectId, {
    value: t.access_token,
    expiresAt: Date.now() + (Number(t.expires_in) || 3000) * 1000,
  });
  return t.access_token;
}

function restUrl(project, path, query) {
  const base = String(project.databaseURL || '').replace(/\/+$/, '');
  const clean = String(path || '').replace(/^\/+|\/+$/g, '');
  const qs = new URLSearchParams(query || {}).toString();
  return `${base}/${clean}.json${qs ? `?${qs}` : ''}`;
}

/** GET a path over REST. Resolves { status, body } (body parsed JSON or null). */
async function restGet(projectId, path, query, timeoutMs = RTDB_TIMEOUT_MS) {
  const project = firebaseProjects.getProject(projectId);
  if (!project) throw new Error(`Firebase project ${projectId} is not configured on this server`);
  const token = await withTimeout(accessToken(project), `RTDB token ${projectId}`, timeoutMs);
  const res = await fetch(restUrl(project, path, query), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    body = null;
  }
  return { status: res.status, body };
}

/**
 * Keys directly under `path` (shallow read: values are not downloaded), guarded like SDK calls.
 * @returns {Promise<string[]>}
 */
async function childKeys(projectId, path) {
  if (isOpen(projectId)) throw circuitOpenError(projectId);
  try {
    const { status, body } = await restGet(projectId, path, { shallow: 'true' });
    if (status !== 200) throw new Error(`RTDB ${projectId} ${path} HTTP ${status}`);
    recordSuccess(projectId);
    return body && typeof body === 'object' ? Object.keys(body) : [];
  } catch (err) {
    recordFailure(projectId, err);
    throw err;
  }
}

/**
 * `meta` of every child of `root` in one project (e.g. every live-tracking session), without
 * downloading the children's other payloads (location, route): shallow key listing over REST,
 * then one bounded read per child's meta, a few at a time.
 * @returns {Promise<Map<string, object>>} key -> meta (children without meta are left out)
 */
async function readChildMetas(projectId, root, { concurrency = 10 } = {}) {
  const keys = await childKeys(projectId, root);
  const metas = new Map();
  for (let i = 0; i < keys.length; i += concurrency) {
    const batch = keys.slice(i, i + concurrency);
    const values = await Promise.all(
      batch.map((k) => guarded(projectId, `RTDB meta ${root}/${k}`, async (db) => (await db.ref(`${root}/${k}/meta`).once('value')).val()))
    );
    batch.forEach((k, idx) => {
      if (values[idx] && typeof values[idx] === 'object') metas.set(k, values[idx]);
    });
  }
  return metas;
}

/**
 * Health probe of one project's RTDB (shallow read of the root, authenticated). Feeds the
 * breaker, so a recovered instance is picked up before the cooldown ends.
 * @returns {Promise<{ status: 'ok'|'missing'|'denied'|'unreachable'|'error', httpStatus: number|null, latencyMs: number, error: string|null }>}
 */
async function probe(projectId, timeoutMs = Math.min(RTDB_TIMEOUT_MS, 4000)) {
  const started = Date.now();
  let status;
  let httpStatus = null;
  let error = null;
  try {
    const r = await restGet(projectId, '', { shallow: 'true' }, timeoutMs);
    httpStatus = r.status;
    if (r.status === 200) status = 'ok';
    else if (r.status === 404) {
      status = 'missing';
      error = 'RTDB instance does not exist (create it with scripts/provisionLiveTrackingRtdb.js)';
    } else if (r.status === 401 || r.status === 403) {
      status = 'denied';
      error = (r.body && r.body.error) || `HTTP ${r.status}`;
    } else {
      status = 'error';
      error = (r.body && r.body.error) || `HTTP ${r.status}`;
    }
  } catch (err) {
    status = 'unreachable';
    error = err.message;
  }
  if (status === 'ok') recordSuccess(projectId);
  else recordFailure(projectId, new Error(error));
  return { status, httpStatus, latencyMs: Date.now() - started, error };
}

function resetForTests() {
  breakers.clear();
  tokens.clear();
}

module.exports = {
  RTDB_TIMEOUT_MS,
  BREAKER_COOLDOWN_MS,
  BREAKER_THRESHOLD,
  withTimeout,
  guarded,
  usableProjects,
  isOpen,
  recordSuccess,
  recordFailure,
  breakerState,
  childKeys,
  readChildMetas,
  restGet,
  probe,
  resetForTests,
};
