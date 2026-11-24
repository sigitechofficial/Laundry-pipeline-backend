/**
 * Provision the Firebase Realtime Database used for live tracking, with a project's
 * service-account credential (Admin SDK):
 *
 * - creates the project's default RTDB instance (<project_id>-default-rtdb) if missing,
 *   in the region given by --location / FIREBASE_RTDB_LOCATION (required only to create)
 * - deploys firebase/database.rules.json
 * - prints the database URL; --write-env=<file> also upserts it into that env file as
 *   FIREBASE_DATABASE_URL (--role=legacy: FIREBASE_LEGACY_DATABASE_URL)
 *
 * The project comes from the credential (project_id); nothing project-specific is in code.
 * Credential: --credentials=<file>, else FIREBASE_CREDENTIALS_PATH
 * (--role=legacy: FIREBASE_LEGACY_CREDENTIALS_PATH), else ./firebase.json.
 *
 * Run:
 *   FIREBASE_RTDB_LOCATION=europe-west1 \
 *     node scripts/provisionLiveTrackingRtdb.js --credentials=/secure/path/new-project.json
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const https = require('https');
const { cert, initializeApp } = require('firebase-admin/app');

const ROOT = path.join(__dirname, '..');
const RULES_PATH = path.join(ROOT, 'firebase', 'database.rules.json');

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));
const ROLE = ARGS.role === 'legacy' ? 'legacy' : 'primary';
const ENV_KEY = ROLE === 'legacy' ? 'FIREBASE_LEGACY_DATABASE_URL' : 'FIREBASE_DATABASE_URL';

function resolveFromRoot(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

function credentialPath() {
  const fromArg = typeof ARGS.credentials === 'string' ? ARGS.credentials : '';
  const fromEnv = (
    process.env[ROLE === 'legacy' ? 'FIREBASE_LEGACY_CREDENTIALS_PATH' : 'FIREBASE_CREDENTIALS_PATH'] || ''
  ).trim();
  return resolveFromRoot(fromArg || fromEnv || 'firebase.json');
}

const SA_PATH = credentialPath();
const ENV_PATH = typeof ARGS['write-env'] === 'string' ? resolveFromRoot(ARGS['write-env']) : null;
const LOCATION = (typeof ARGS.location === 'string' ? ARGS.location : process.env.FIREBASE_RTDB_LOCATION || '').trim();
// Set from the credential in main().
let PROJECT_ID = null;
let INSTANCE_ID = null;

function httpJson(method, url, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload =
      body == null
        ? null
        : typeof body === 'string'
          ? body
          : JSON.stringify(body);
    const req = https.request(
      {
        method,
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          Accept: 'application/json',
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = data;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch (_) {
            /* keep raw */
          }
          resolve({ status: res.statusCode, body: parsed, raw: data });
        });
      }
    );
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

async function getAccessToken(sa) {
  const app = initializeApp({ credential: cert(sa) }, `provision-${sa.project_id}`);
  const cred = app.options.credential;
  const result = await cred.getAccessToken();
  const token = result?.access_token || result?.accessToken;
  if (!token) {
    throw new Error('Failed to obtain Google access token from service account');
  }
  return token;
}

function classicDatabaseUrl() {
  return `https://${INSTANCE_ID}.firebaseio.com`;
}

function regionalDatabaseUrl() {
  return `https://${INSTANCE_ID}.${LOCATION}.firebasedatabase.app`;
}

const RTDB_API = 'firebasedatabase.googleapis.com';

function isServiceDisabled(res) {
  const details = res?.body?.error?.details || [];
  return res.status === 403 && details.some((d) => d && d.reason === 'SERVICE_DISABLED');
}

/** A new project has the RTDB management API off: switch it on (Service Usage API). */
async function enableRtdbApi(token) {
  const url = `https://serviceusage.googleapis.com/v1/projects/${PROJECT_ID}/services/${RTDB_API}:enable`;
  const res = await httpJson('POST', url, { Authorization: `Bearer ${token}` }, {});
  if (res.status >= 400) {
    throw new Error(
      `${RTDB_API} is disabled and could not be enabled (HTTP ${res.status}): ` +
        `${res.body?.error?.message || res.raw}. Enable it in Google Cloud console and re-run.`
    );
  }
  console.log(`[provision] enabled ${RTDB_API}; waiting for it to propagate…`);
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const probe = await listInstances(token);
    if (!isServiceDisabled(probe)) return probe;
  }
  throw new Error(`${RTDB_API} still reported disabled after enabling — re-run in a few minutes.`);
}

async function listInstances(token) {
  const url = `https://firebasedatabase.googleapis.com/v1beta/projects/${PROJECT_ID}/locations/-/instances`;
  return httpJson('GET', url, { Authorization: `Bearer ${token}` });
}

async function createInstance(token) {
  const url =
    `https://firebasedatabase.googleapis.com/v1beta/projects/${PROJECT_ID}` +
    `/locations/${LOCATION}/instances?databaseId=${encodeURIComponent(INSTANCE_ID)}`;
  // <project>-default-rtdb is the project's default instance (any billing plan).
  return httpJson(
    'POST',
    url,
    { Authorization: `Bearer ${token}` },
    { type: 'DEFAULT_DATABASE' }
  );
}

async function deployRules(token, databaseURL, rulesJson) {
  const url = `${databaseURL.replace(/\/$/, '')}/.settings/rules.json?access_token=${encodeURIComponent(token)}`;
  return httpJson('PUT', url, {}, rulesJson);
}

function upsertEnv(key, value) {
  if (!ENV_PATH) return false;
  let text = '';
  if (fs.existsSync(ENV_PATH)) {
    text = fs.readFileSync(ENV_PATH, 'utf8');
  }
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) {
    text = text.replace(re, line);
  } else {
    if (text.length && !text.endsWith('\n')) text += '\n';
    text += `\n# Firebase Realtime Database (live agent tracking)\n${line}\n`;
  }
  fs.writeFileSync(ENV_PATH, text, 'utf8');
  return true;
}

function pickDatabaseUrl(instance) {
  if (instance?.databaseUrl) return instance.databaseUrl;
  return classicDatabaseUrl();
}

async function main() {
  if (!fs.existsSync(SA_PATH)) {
    throw new Error(`Missing service account file: ${SA_PATH}`);
  }
  if (!fs.existsSync(RULES_PATH)) {
    throw new Error(`Missing rules file: ${RULES_PATH}`);
  }

  const sa = JSON.parse(fs.readFileSync(SA_PATH, 'utf8'));
  if (!sa.project_id) {
    throw new Error(`Service account ${path.basename(SA_PATH)} has no project_id`);
  }
  PROJECT_ID = sa.project_id;
  INSTANCE_ID = `${PROJECT_ID}-default-rtdb`;

  const rules = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  console.log(`[provision] authenticating as ${sa.client_email}`);
  const token = await getAccessToken(sa);

  console.log(`[provision] listing RTDB instances for ${PROJECT_ID}…`);
  let list = await listInstances(token);
  if (isServiceDisabled(list)) {
    list = await enableRtdbApi(token);
  }
  if (list.status === 403 || list.status === 401) {
    throw new Error(
      `Cannot list RTDB instances (HTTP ${list.status}). ` +
        `Grant the service account Firebase Admin / Editor, or create RTDB once in Console. ` +
        `Body: ${typeof list.body === 'object' ? JSON.stringify(list.body) : list.raw}`
    );
  }

  let instances = list.body?.instances || [];
  console.log(`[provision] found ${instances.length} instance(s)`);

  let instance = instances.find((i) => i.name?.includes(INSTANCE_ID));

  if (!instance) {
    if (!LOCATION) {
      throw new Error(
        `${INSTANCE_ID} does not exist yet: pass --location=<region> or FIREBASE_RTDB_LOCATION ` +
          '(e.g. europe-west1) to create it'
      );
    }
    console.log(`[provision] creating instance ${INSTANCE_ID} in ${LOCATION}…`);
    const created = await createInstance(token);
    if (created.status >= 400) {
      const msg =
        typeof created.body === 'object'
          ? JSON.stringify(created.body)
          : created.raw;
      if (
        created.status === 409 ||
        /already exists|ALREADY_EXISTS/i.test(String(msg))
      ) {
        console.log('[provision] instance already exists (409) — continuing');
        list = await listInstances(token);
        instances = list.body?.instances || [];
        instance = instances.find((i) => i.name?.includes(INSTANCE_ID));
      } else {
        throw new Error(`Create instance failed HTTP ${created.status}: ${msg}`);
      }
    } else {
      instance = created.body;
      console.log('[provision] create accepted');
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        list = await listInstances(token);
        instances = list.body?.instances || [];
        instance =
          instances.find((x) => x.name?.includes(INSTANCE_ID)) || instance;
        if (instance?.state === 'ACTIVE' || instance?.databaseUrl) break;
        console.log(`[provision] waiting for ACTIVE… state=${instance?.state}`);
      }
    }
  }

  let databaseURL = pickDatabaseUrl(instance);
  console.log(`[provision] databaseURL candidate: ${databaseURL}`);

  const candidates = Array.from(
    new Set(
      [instance?.databaseUrl, classicDatabaseUrl(), LOCATION ? regionalDatabaseUrl() : null].filter(
        Boolean
      )
    )
  );

  let deployed = false;
  let lastErr = null;
  for (const url of candidates) {
    console.log(`[provision] deploying rules → ${url}`);
    const res = await deployRules(token, url, rules);
    if (res.status >= 200 && res.status < 300) {
      databaseURL = url;
      deployed = true;
      console.log('[provision] rules deployed OK');
      break;
    }
    lastErr = `HTTP ${res.status}: ${
      typeof res.body === 'object' ? JSON.stringify(res.body) : res.raw
    }`;
    console.warn(`[provision] rules deploy failed for ${url}: ${lastErr}`);
  }

  if (!deployed) {
    throw new Error(
      `Failed to deploy RTDB rules. Last error: ${lastErr}. ` +
        'Create the Realtime Database once in Firebase Console if it does not exist yet, then re-run.'
    );
  }

  if (upsertEnv(ENV_KEY, databaseURL)) {
    console.log(`[provision] wrote ${ENV_KEY} to ${ENV_PATH}`);
  } else {
    console.log(`[provision] set ${ENV_KEY}=${databaseURL} in the server env (not written: no --write-env)`);
  }
  console.log('[provision] DONE');
  console.log(
    JSON.stringify(
      {
        projectId: PROJECT_ID,
        instanceId: INSTANCE_ID,
        location: instance?.name ? instance.name.split('/')[3] : LOCATION || null,
        databaseURL,
        envKey: ENV_KEY,
        rulesDeployed: true,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error('[provision] FAILED:', err.message || err);
  process.exit(1);
});
