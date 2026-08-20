/**
 * Provision Firebase Realtime Database for live tracking using the existing
 * service-account firebase.json (Admin SDK credentials).
 *
 * - Creates default RTDB instance if missing (us-central1)
 * - Deploys firebase/database.rules.json
 * - Upserts FIREBASE_DATABASE_URL into .env
 *
 * Run: node scripts/provisionLiveTrackingRtdb.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { cert, getApp, getApps, initializeApp } = require('firebase-admin/app');

const ROOT = path.join(__dirname, '..');
const SA_PATH = path.join(ROOT, 'firebase.json');
const RULES_PATH = path.join(ROOT, 'firebase', 'database.rules.json');
const ENV_PATH = path.join(ROOT, '.env');
const PROJECT_ID = 'laundry-app-bf43c';
const INSTANCE_ID = `${PROJECT_ID}-default-rtdb`;
const LOCATION = process.env.FIREBASE_RTDB_LOCATION || 'us-central1';

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
  if (!getApps().length) {
    initializeApp({
      credential: cert(sa),
    });
  }
  const cred = getApp().options.credential;
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

async function listInstances(token) {
  const url = `https://firebasedatabase.googleapis.com/v1beta/projects/${PROJECT_ID}/locations/-/instances`;
  return httpJson('GET', url, { Authorization: `Bearer ${token}` });
}

async function createInstance(token) {
  const url =
    `https://firebasedatabase.googleapis.com/v1beta/projects/${PROJECT_ID}` +
    `/locations/${LOCATION}/instances?databaseId=${encodeURIComponent(INSTANCE_ID)}`;
  return httpJson(
    'POST',
    url,
    { Authorization: `Bearer ${token}` },
    { type: 'USER_OWNED' }
  );
}

async function deployRules(token, databaseURL, rulesJson) {
  const url = `${databaseURL.replace(/\/$/, '')}/.settings/rules.json?access_token=${encodeURIComponent(token)}`;
  return httpJson('PUT', url, {}, rulesJson);
}

function upsertEnv(key, value) {
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
  if (sa.project_id !== PROJECT_ID) {
    console.warn(
      `[warn] service account project_id=${sa.project_id} expected=${PROJECT_ID}`
    );
  }

  const rules = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  console.log(`[provision] authenticating as ${sa.client_email}`);
  const token = await getAccessToken(sa);

  console.log(`[provision] listing RTDB instances for ${PROJECT_ID}…`);
  let list = await listInstances(token);
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
      [instance?.databaseUrl, classicDatabaseUrl(), regionalDatabaseUrl()].filter(
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

  upsertEnv('FIREBASE_DATABASE_URL', databaseURL);
  console.log('[provision] wrote FIREBASE_DATABASE_URL to .env');
  console.log('[provision] DONE');
  console.log(
    JSON.stringify(
      {
        projectId: PROJECT_ID,
        instanceId: INSTANCE_ID,
        databaseURL,
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
