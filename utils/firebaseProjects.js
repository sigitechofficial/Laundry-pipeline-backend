'use strict';

/**
 * The Firebase projects this backend talks to — the single place Firebase Admin is initialised.
 *
 * PROJECTS — up to two, each from its own service-account file:
 *  - primary (required): FIREBASE_CREDENTIALS_PATH, RTDB at FIREBASE_DATABASE_URL.
 *    Without FIREBASE_CREDENTIALS_PATH the server falls back to ./firebase.json (the layout
 *    servers had before the variable existed), so a host that only has that file keeps working.
 *  - legacy (optional): FIREBASE_LEGACY_CREDENTIALS_PATH, RTDB at FIREBASE_LEGACY_DATABASE_URL.
 *    The project app builds released before a Firebase project move still use. Absent = the
 *    server runs on the primary project only.
 * Project ids always come from the credentials (`project_id`), never from code. An RTDB URL
 * that is not configured defaults to the project's classic default instance URL.
 *
 * CLIENT PROJECT — clients report the project their FCM token / Firebase Auth belong to as
 * `firebaseProjectId`. A client that does not (app builds from before the move) is on the
 * legacy project when one is configured, else on the primary: see clientProjectFor().
 *
 * Each project is a named Admin app, so messaging/auth/database calls always say which
 * project they act on (messagingFor/authFor/databaseFor).
 */

const fs = require('fs');
const path = require('path');
const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { FIREBASE_PROJECT_ERROR, normalizeFirebaseProjectId } = require('./firebaseProjectId');

const ROOT = path.join(__dirname, '..');
const DEFAULT_CREDENTIAL_FILE = path.join(ROOT, 'firebase.json');

const ROLE = Object.freeze({ PRIMARY: 'primary', LEGACY: 'legacy' });

function envValue(name) {
  const v = process.env[name];
  return typeof v === 'string' ? v.trim() : '';
}

function resolvePath(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

/** Where each project's credential and RTDB URL come from (no I/O). */
function projectSources() {
  const primaryPath = envValue('FIREBASE_CREDENTIALS_PATH');
  const legacyPath = envValue('FIREBASE_LEGACY_CREDENTIALS_PATH');
  const sources = [
    {
      role: ROLE.PRIMARY,
      credentialPath: primaryPath ? resolvePath(primaryPath) : DEFAULT_CREDENTIAL_FILE,
      credentialSource: primaryPath ? 'FIREBASE_CREDENTIALS_PATH' : 'firebase.json',
      databaseUrlEnv: 'FIREBASE_DATABASE_URL',
    },
  ];
  if (legacyPath) {
    sources.push({
      role: ROLE.LEGACY,
      credentialPath: resolvePath(legacyPath),
      credentialSource: 'FIREBASE_LEGACY_CREDENTIALS_PATH',
      databaseUrlEnv: 'FIREBASE_LEGACY_DATABASE_URL',
    });
  }
  return sources;
}

function defaultDatabaseUrl(projectId) {
  return `https://${projectId}-default-rtdb.firebaseio.com`;
}

/** role -> state; rebuilt only when a project is not ready yet (retry after a fixed file). */
const states = new Map();

function appName(role) {
  return `firebase-${role}`;
}

function findApp(name) {
  return getApps().find((a) => a && a.name === name) || null;
}

function readServiceAccount(credentialPath) {
  const raw = fs.readFileSync(credentialPath, 'utf8');
  const sa = JSON.parse(raw);
  if (!sa || typeof sa.project_id !== 'string' || !sa.project_id) {
    throw new Error('service account has no project_id');
  }
  return sa;
}

function initProject(source, takenProjectIds) {
  const state = {
    role: source.role,
    credentialPath: source.credentialPath,
    credentialSource: source.credentialSource,
    fileExists: false,
    parseOk: false,
    parseError: null,
    projectId: null,
    clientEmail: null,
    privateKeyLooksValid: null,
    databaseURL: null,
    databaseUrlSource: null,
    app: null,
    ready: false,
    error: null,
  };

  state.fileExists = fs.existsSync(source.credentialPath);
  if (!state.fileExists) {
    state.error = `${path.basename(source.credentialPath)} not found`;
    return state;
  }

  let sa;
  try {
    sa = readServiceAccount(source.credentialPath);
    state.parseOk = true;
  } catch (err) {
    state.parseError = err.message;
    state.error = err.message;
    return state;
  }

  state.projectId = sa.project_id;
  state.clientEmail = sa.client_email || null;
  const pk = typeof sa.private_key === 'string' ? sa.private_key : '';
  state.privateKeyLooksValid = pk.includes('BEGIN PRIVATE KEY') && (pk.includes('\\n') || pk.includes('\n'));

  const fromEnv = envValue(source.databaseUrlEnv);
  state.databaseURL = fromEnv || defaultDatabaseUrl(sa.project_id);
  state.databaseUrlSource = fromEnv ? source.databaseUrlEnv : 'default';

  if (takenProjectIds.has(sa.project_id)) {
    state.error = `same project (${sa.project_id}) as the primary credential — ignored`;
    return state;
  }

  try {
    const name = appName(source.role);
    state.app =
      findApp(name) ||
      initializeApp({ credential: cert(sa), databaseURL: state.databaseURL, projectId: sa.project_id }, name);
    state.ready = true;
    console.log(
      '[Firebase] %s project ready project_id=%s databaseURL=%s',
      source.role,
      sa.project_id,
      state.databaseURL
    );
  } catch (err) {
    state.error = err.message;
    console.warn(`[Firebase] ${source.role} Admin init failed:`, err.message);
  }
  return state;
}

/**
 * Initialise every configured project that is not ready yet. Cheap once ready.
 * @returns {boolean} the primary project is ready
 */
function ensureFirebaseReady() {
  const sources = projectSources();
  const taken = new Set();
  for (const source of sources) {
    const prev = states.get(source.role);
    const sameSource = prev && prev.credentialPath === source.credentialPath;
    const state = sameSource && prev.ready ? prev : initProject(source, taken);
    states.set(source.role, state);
    if (state.ready && state.projectId) taken.add(state.projectId);
  }
  for (const role of [...states.keys()]) {
    if (!sources.some((s) => s.role === role)) states.delete(role);
  }
  const primary = states.get(ROLE.PRIMARY);
  return Boolean(primary && primary.ready);
}

/** Ready projects, primary first. */
function readyProjects() {
  ensureFirebaseReady();
  return [ROLE.PRIMARY, ROLE.LEGACY].map((r) => states.get(r)).filter((s) => s && s.ready);
}

function isAnyProjectReady() {
  return readyProjects().length > 0;
}

function getProject(projectId) {
  if (!projectId) return null;
  return readyProjects().find((p) => p.projectId === projectId) || null;
}

function getProjectByRole(role) {
  return readyProjects().find((p) => p.role === role) || null;
}

function configuredProjectIds() {
  return readyProjects().map((p) => p.projectId);
}

/**
 * Projects to try for a token with no recorded project, in order: the legacy project first
 * (every token stored before projects were recorded came from it, except web clients'),
 * then the primary.
 */
function unclassifiedTokenOrder() {
  const order = [];
  const legacy = getProjectByRole(ROLE.LEGACY);
  const primary = getProjectByRole(ROLE.PRIMARY);
  if (legacy) order.push(legacy.projectId);
  if (primary) order.push(primary.projectId);
  return order;
}

/** True when `projectId` (already normalised) is one of the projects this server holds. */
function isConfiguredProject(projectId) {
  return Boolean(getProject(projectId));
}

/**
 * A client-reported project (already normalised) checked against the projects this server
 * holds: null stays null (client did not say), a configured project is returned as is.
 * @throws {Error & { code: 'FIREBASE_PROJECT_NOT_CONFIGURED' }}
 */
function acceptClientProject(projectId) {
  if (!projectId) return null;
  if (isConfiguredProject(projectId)) return projectId;
  const err = new Error(`Firebase project ${projectId} is not configured on this server`);
  err.code = FIREBASE_PROJECT_ERROR.NOT_CONFIGURED;
  throw err;
}

/**
 * The project a client is on: the one it reported, or — for clients that do not report one —
 * the legacy project when configured, else the primary.
 * @returns {object|null} the project state, null when the reported project is not configured
 */
function clientProjectFor(firebaseProjectId) {
  if (firebaseProjectId) return getProject(firebaseProjectId);
  return getProjectByRole(ROLE.LEGACY) || getProjectByRole(ROLE.PRIMARY);
}

function requireApp(projectId) {
  const project = getProject(projectId);
  if (!project) {
    const err = new Error(`Firebase project ${projectId} is not configured on this server`);
    err.code = FIREBASE_PROJECT_ERROR.NOT_CONFIGURED;
    throw err;
  }
  return project.app;
}

function messagingFor(projectId) {
  return require('firebase-admin/messaging').getMessaging(requireApp(projectId));
}

function authFor(projectId) {
  return require('firebase-admin/auth').getAuth(requireApp(projectId));
}

function databaseFor(projectId) {
  return require('firebase-admin/database').getDatabase(requireApp(projectId));
}

/** Safe per-project diagnostics (no key material). */
function projectDiagnostics() {
  ensureFirebaseReady();
  return [...states.values()].map((s) => ({
    role: s.role,
    projectId: s.projectId,
    ready: s.ready,
    error: s.error,
    credentialSource: s.credentialSource,
    credentialFile: path.basename(s.credentialPath),
    fileExists: s.fileExists,
    parseOk: s.parseOk,
    parseError: s.parseError,
    clientEmail: s.clientEmail,
    privateKeyLooksValid: s.privateKeyLooksValid,
    databaseURL: s.databaseURL,
    databaseUrlSource: s.databaseUrlSource,
  }));
}

module.exports = {
  ROLE,
  FIREBASE_PROJECT_ERROR,
  ensureFirebaseReady,
  isAnyProjectReady,
  readyProjects,
  getProject,
  getProjectByRole,
  configuredProjectIds,
  unclassifiedTokenOrder,
  normalizeFirebaseProjectId,
  isConfiguredProject,
  acceptClientProject,
  clientProjectFor,
  messagingFor,
  authFor,
  databaseFor,
  projectDiagnostics,
};
