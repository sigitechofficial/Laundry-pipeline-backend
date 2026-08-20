'use strict';

/**
 * Read-only dependency health checks for ops / local verification.
 * Never mutates data, never sends email, never creates Stripe charges.
 * Logs are detailed but secret-safe (no raw keys/tokens).
 */

const axios = require('axios');
const db = require('../models');
const redisClient = require('../redis/redis');
const { getFirebaseDiagnostics } = require('../utils/notification');
const { validateTokenConfig } = require('../helper/zeptomailApi');

const ZEPTOMAIL_API_URL = 'https://api.zeptomail.com/v1.1/email';
const LOG_PREFIX = '[HEALTH]';

function nowMs() {
  return Date.now();
}

function result(status, message, extra = {}) {
  return { status, message, ...extra };
}

function safeErrorFields(err) {
  if (!err) return {};
  return {
    errorName: err.name || null,
    errorMessage: err.message || String(err),
    errorCode: err.code || err.errno || err.statusCode || null,
    errorSyscall: err.syscall || null,
    errorAddress: err.address || null,
    errorPort: err.port || null,
    // Sequelize nested
    parentCode: err.parent?.code || null,
    parentErrno: err.parent?.errno || null,
    parentSyscall: err.parent?.syscall || null,
    originalMessage: err.original?.message || null
  };
}

function maskSecretMeta(value) {
  const v = value == null ? '' : String(value);
  if (!v) {
    return { present: false, length: 0, prefix: null };
  }
  return {
    present: true,
    length: v.length,
    prefix: v.slice(0, 7),
    looksPlaceholder: /placeholder|not_for_real|changeme|your_key|your_.*_here/i.test(v)
  };
}

function logLine(level, message, details) {
  const payload = details == null ? '' : ` ${JSON.stringify(details)}`;
  const text = `${LOG_PREFIX} ${message}${payload}`;
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

function logCheck(name, check) {
  const level = check.status === 'ok' ? 'info' : check.critical ? 'error' : 'warn';
  const summary = {
    dependency: name,
    status: check.status,
    critical: !!check.critical,
    checkType: check.checkType || null,
    latencyMs: check.latencyMs ?? null,
    message: check.message,
    hint: check.hint || check.fixHint || null,
    errorCode: check.errorCode || check.stripeCode || check.parentCode || null,
    httpStatus: check.httpStatus || null
  };
  logLine(level, `check.${name}`, summary);
  if (check.status !== 'ok' && check.details) {
    logLine(level, `check.${name}.details`, check.details);
  }
}

function logReport(report, meta = {}) {
  const level =
    report.overall === 'ok' ? 'info' : report.overall === 'degraded' ? 'warn' : 'error';
  logLine(level, 'ready.summary', {
    overall: report.overall,
    ready: report.ready,
    ok: report.summary?.ok || [],
    fail: report.summary?.fail || [],
    checkedAt: report.checkedAt,
    nodeEnv: process.env.NODE_ENV || null,
    ...meta
  });

  for (const [name, check] of Object.entries(report.checks || {})) {
    logCheck(name, check);
  }

  if ((report.summary?.fail || []).length) {
    logLine(level, 'ready.fixHints', {
      failed: (report.summary.fail || []).map((name) => ({
        dependency: name,
        message: report.checks[name]?.message,
        hint: report.checks[name]?.hint || report.checks[name]?.fixHint || null
      }))
    });
  }
}

async function checkMysql() {
  const started = nowMs();
  const cfg = db.sequelize?.config || {};
  const target = {
    host: cfg.host || null,
    port: cfg.port || null,
    database: cfg.database || null,
    username: cfg.username || null
  };

  try {
    await db.sequelize.authenticate();
    const [rows] = await db.sequelize.query(
      'SELECT 1 AS ok, DATABASE() AS dbName, NOW() AS serverTime'
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    const ok = row && Number(row.ok) === 1;
    if (!ok) {
      return result('fail', 'MySQL connected but probe query returned unexpected result', {
        latencyMs: nowMs() - started,
        critical: true,
        checkType: 'live',
        target,
        hint: 'DB accepted the TCP connection but SELECT 1 failed unexpectedly. Check MySQL process list and privileges.',
        details: { row }
      });
    }

    let tableCount = null;
    let migrationCount = null;
    try {
      const [tableRows] = await db.sequelize.query(
        `SELECT COUNT(*) AS c
         FROM information_schema.tables
         WHERE table_schema = DATABASE()`
      );
      tableCount = Number(tableRows?.[0]?.c ?? 0);
    } catch (err) {
      logLine('warn', 'check.mysql.tableCountFailed', safeErrorFields(err));
    }
    try {
      const [metaRows] = await db.sequelize.query('SELECT COUNT(*) AS c FROM SequelizeMeta');
      migrationCount = Number(metaRows?.[0]?.c ?? 0);
    } catch (err) {
      logLine('warn', 'check.mysql.migrationCountFailed', safeErrorFields(err));
    }

    return result('ok', 'MySQL connected and queryable', {
      latencyMs: nowMs() - started,
      critical: true,
      checkType: 'live',
      host: target.host,
      port: target.port,
      database: row.dbName || target.database || null,
      tableCount,
      migrationCount,
      dbServerTime: row.serverTime || null
    });
  } catch (err) {
    const fields = safeErrorFields(err);
    return result('fail', err.message || 'MySQL connection failed', {
      latencyMs: nowMs() - started,
      critical: true,
      checkType: 'live',
      target,
      ...fields,
      hint:
        'Verify MySQL is running and config/config.json (or DB_* env) host/port/user/password/database match. Local MAMP usually uses 127.0.0.1:8889.',
      details: fields
    });
  }
}

async function checkRedis() {
  const started = nowMs();
  try {
    if (!redisClient || typeof redisClient.ping !== 'function') {
      return result('fail', 'Redis client is not initialized', {
        latencyMs: nowMs() - started,
        critical: true,
        checkType: 'live',
        hint: 'Redis module failed to create a client. Check redis/redis.js and that the redis package is installed.'
      });
    }
    if (redisClient.isOpen === false) {
      return result('fail', 'Redis client is not connected (isOpen=false)', {
        latencyMs: nowMs() - started,
        critical: true,
        checkType: 'live',
        isOpen: false,
        hint: 'Start Redis locally (`redis-server`) or on the server, then restart Node so it can reconnect.'
      });
    }
    const pong = await redisClient.ping();
    if (String(pong).toUpperCase() !== 'PONG') {
      return result('fail', `Unexpected Redis ping response: ${pong}`, {
        latencyMs: nowMs() - started,
        critical: true,
        checkType: 'live',
        hint: 'Redis responded but not with PONG. Check Redis version/ACL and client config.'
      });
    }
    return result('ok', 'Redis connected', {
      latencyMs: nowMs() - started,
      critical: true,
      checkType: 'live',
      isOpen: !!redisClient.isOpen
    });
  } catch (err) {
    const fields = safeErrorFields(err);
    return result('fail', err.message || 'Redis ping failed', {
      latencyMs: nowMs() - started,
      critical: true,
      checkType: 'live',
      ...fields,
      hint: 'Cannot reach Redis on localhost:6379 (default). Start Redis and confirm nothing else blocks the port.',
      details: fields
    });
  }
}

async function checkFirebase() {
  const started = nowMs();
  try {
    const diagnostics = getFirebaseDiagnostics();
    const ok = !!(diagnostics.firebaseReady && diagnostics.parseOk && !diagnostics.nodeTooOld);
    let hint = diagnostics.hint || null;
    if (!diagnostics.fileExists) {
      hint = 'firebase.json is missing next to the app root. Deploy/copy the service account JSON and restart.';
    } else if (!diagnostics.parseOk) {
      hint =
        'firebase.json is invalid JSON (often broken private_key newlines on cPanel). Fix the file/secret and restart PM2.';
    } else if (!diagnostics.firebaseReady) {
      hint =
        'firebase.json parses but Admin SDK init failed. Check private_key formatting and Node version, then restart.';
    } else if (diagnostics.nodeTooOld) {
      hint = 'Upgrade Node to >=22 for Firebase Admin 14.';
    }

    return result(
      ok ? 'ok' : 'fail',
      diagnostics.hint || (ok ? 'Firebase Admin ready' : 'Firebase Admin not ready'),
      {
        latencyMs: nowMs() - started,
        critical: false,
        checkType: 'live',
        projectId: diagnostics.projectId || null,
        appsInitialized: diagnostics.appsInitialized,
        firebaseReady: diagnostics.firebaseReady,
        parseOk: diagnostics.parseOk,
        fileExists: diagnostics.fileExists,
        privateKeyLooksValid: diagnostics.privateKeyLooksValid,
        nodeVersion: diagnostics.nodeVersion,
        nodeTooOld: diagnostics.nodeTooOld,
        firebaseInitError: diagnostics.firebaseInitError || null,
        hint
      }
    );
  } catch (err) {
    const fields = safeErrorFields(err);
    return result('fail', err.message || 'Firebase check failed', {
      latencyMs: nowMs() - started,
      critical: false,
      checkType: 'live',
      ...fields,
      hint: 'Unexpected Firebase diagnostics failure. Check utils/notification.js and firebase.json.',
      details: fields
    });
  }
}

async function checkStripe() {
  const started = nowMs();
  const key = process.env.STRIPE_SECRET_KEY || '';
  const publishable = process.env.STRIPE_PUBLISHABLE_KEY || '';
  const secretMeta = maskSecretMeta(key);
  const publishableMeta = maskSecretMeta(publishable);
  const mode = key.startsWith('sk_live')
    ? 'live'
    : key.startsWith('sk_test')
      ? 'test'
      : 'unknown';

  try {
    if (!key) {
      return result('fail', 'STRIPE_SECRET_KEY is not set in .env', {
        latencyMs: nowMs() - started,
        critical: false,
        configured: false,
        publishableConfigured: !!publishable,
        checkType: 'live',
        secretMeta,
        publishableMeta,
        hint: 'Add STRIPE_SECRET_KEY=sk_test_... (local) or live key (prod only) to env, then restart Node/PM2 with updated env.'
      });
    }
    if (secretMeta.looksPlaceholder) {
      return result(
        'fail',
        'STRIPE_SECRET_KEY is a local placeholder — put a real Stripe test key (sk_test_...) in .env',
        {
          latencyMs: nowMs() - started,
          critical: false,
          configured: true,
          publishableConfigured: !!publishable,
          mode,
          checkType: 'live',
          secretMeta,
          publishableMeta,
          hint: 'Replace placeholder Stripe keys in .env with Dashboard test keys, save file, restart server.'
        }
      );
    }

    const Stripe = require('stripe');
    const stripe = new Stripe(key, { timeout: 10000, maxNetworkRetries: 0 });
    const balance = await stripe.balance.retrieve();

    return result('ok', 'Stripe API reachable (live balance.retrieve)', {
      latencyMs: nowMs() - started,
      critical: false,
      configured: true,
      publishableConfigured: !!publishable,
      mode,
      livemode: typeof balance?.livemode === 'boolean' ? balance.livemode : null,
      checkType: 'live',
      secretMeta: { present: true, length: secretMeta.length, prefix: secretMeta.prefix },
      publishableMeta: {
        present: publishableMeta.present,
        length: publishableMeta.length,
        prefix: publishableMeta.prefix
      }
    });
  } catch (err) {
    const fields = safeErrorFields(err);
    return result('fail', err.message || 'Stripe API check failed', {
      latencyMs: nowMs() - started,
      critical: false,
      configured: !!key,
      publishableConfigured: !!publishable,
      mode,
      stripeCode: err?.code || err?.raw?.code || null,
      stripeType: err?.type || null,
      stripeStatusCode: err?.statusCode || err?.raw?.statusCode || null,
      stripeRequestId: err?.requestId || err?.raw?.requestId || null,
      checkType: 'live',
      secretMeta: { present: secretMeta.present, length: secretMeta.length, prefix: secretMeta.prefix },
      ...fields,
      hint:
        'Stripe rejected the key or network call. Confirm key mode (test/live), account access, outbound HTTPS from server, then restart.',
      details: {
        ...fields,
        stripeCode: err?.code || err?.raw?.code || null,
        stripeType: err?.type || null
      }
    });
  }
}

async function checkZeptoMail() {
  const started = nowMs();
  try {
    const validation = validateTokenConfig();
    const tokenMeta = maskSecretMeta(process.env.ZEPTOMAIL_API_TOKEN || '');

    if (!validation.valid) {
      return result('fail', validation.issues.join('; ') || 'ZeptoMail token invalid', {
        latencyMs: nowMs() - started,
        critical: false,
        configured: validation.tokenSet,
        tokenFromEnv: validation.tokenFromEnv,
        warnings: validation.warnings,
        checkType: 'config',
        tokenMeta,
        hint:
          'Set ZEPTOMAIL_API_TOKEN=Zoho-enczapikey <token> in .env with NO spaces around = and NO wrapping quotes issues. Restart Node/PM2.',
        details: {
          issues: validation.issues,
          warnings: validation.warnings,
          tokenMeta
        }
      });
    }

    const token = process.env.ZEPTOMAIL_API_TOKEN;
    let response;
    try {
      response = await axios.post(
        ZEPTOMAIL_API_URL,
        {
          from: { address: 'healthcheck-invalid@invalid.local' },
          subject: 'health-check-no-send'
        },
        {
          headers: {
            Authorization: token,
            'Content-Type': 'application/json'
          },
          timeout: 10000,
          validateStatus: () => true
        }
      );
    } catch (err) {
      const fields = safeErrorFields(err);
      return result('fail', err.message || 'ZeptoMail API unreachable', {
        latencyMs: nowMs() - started,
        critical: false,
        configured: validation.tokenSet,
        tokenFromEnv: validation.tokenFromEnv,
        warnings: validation.warnings,
        checkType: 'live',
        tokenMeta,
        apiUrl: ZEPTOMAIL_API_URL,
        ...fields,
        hint:
          'Server cannot reach api.zeptomail.com. Check outbound HTTPS/firewall/DNS on cPanel or local network.',
        details: fields
      });
    }

    const status = response.status;
    const responseSnippet =
      typeof response.data === 'string'
        ? response.data.slice(0, 180)
        : JSON.stringify(response.data || {}).slice(0, 180);

    if (status >= 400 && status < 500 && status !== 401 && status !== 403) {
      return result('ok', 'ZeptoMail API reachable and token accepted (no email sent)', {
        latencyMs: nowMs() - started,
        critical: false,
        configured: true,
        tokenFromEnv: validation.tokenFromEnv,
        warnings: validation.warnings,
        checkType: 'live',
        httpStatus: status,
        tokenMeta: { present: true, length: tokenMeta.length, prefix: 'Zoho-en' }
      });
    }
    if (status === 401 || status === 403) {
      return result('fail', 'ZeptoMail rejected the API token (unauthorized)', {
        latencyMs: nowMs() - started,
        critical: false,
        configured: true,
        tokenFromEnv: validation.tokenFromEnv,
        warnings: validation.warnings,
        checkType: 'live',
        httpStatus: status,
        tokenMeta,
        hint: 'Token prefix/value is wrong or revoked. Create a new ZeptoMail API token and update env.',
        details: { httpStatus: status, responseSnippet }
      });
    }
    if (status >= 200 && status < 300) {
      return result('ok', 'ZeptoMail API reachable', {
        latencyMs: nowMs() - started,
        critical: false,
        configured: true,
        tokenFromEnv: validation.tokenFromEnv,
        warnings: validation.warnings,
        checkType: 'live',
        httpStatus: status
      });
    }
    return result('fail', `ZeptoMail API returned HTTP ${status}`, {
      latencyMs: nowMs() - started,
      critical: false,
      configured: true,
      tokenFromEnv: validation.tokenFromEnv,
      warnings: validation.warnings,
      checkType: 'live',
      httpStatus: status,
      hint: 'Unexpected ZeptoMail HTTP status. Inspect response snippet and ZeptoMail dashboard/API limits.',
      details: { httpStatus: status, responseSnippet }
    });
  } catch (err) {
    const fields = safeErrorFields(err);
    return result('fail', err.message || 'ZeptoMail check failed', {
      latencyMs: nowMs() - started,
      critical: false,
      checkType: 'config',
      ...fields,
      hint: 'Unexpected ZeptoMail health failure. Check helper/zeptomailApi.js and env parsing.',
      details: fields
    });
  }
}

async function runDependencyChecks(options = {}) {
  const started = nowMs();
  logLine('info', 'ready.start', {
    nodeEnv: process.env.NODE_ENV || null,
    pid: process.pid,
    ...options
  });

  const entries = await Promise.all([
    checkMysql().then((r) => ['mysql', r]),
    checkRedis().then((r) => ['redis', r]),
    checkFirebase().then((r) => ['firebase', r]),
    checkStripe().then((r) => ['stripe', r]),
    checkZeptoMail().then((r) => ['zeptomail', r])
  ]);

  const checks = Object.fromEntries(entries);
  const fail = [];
  const ok = [];
  let criticalFail = false;
  let optionalFail = false;

  for (const [name, check] of entries) {
    if (check.status === 'ok') {
      ok.push(name);
    } else {
      fail.push(name);
      if (check.critical) criticalFail = true;
      else optionalFail = true;
    }
  }

  let overall = 'ok';
  if (criticalFail) overall = 'down';
  else if (optionalFail) overall = 'degraded';

  const report = {
    overall,
    ready: !criticalFail,
    checks,
    summary: { ok, fail },
    checkedAt: new Date().toISOString(),
    totalLatencyMs: nowMs() - started,
    fixHints: fail.map((name) => ({
      dependency: name,
      message: checks[name]?.message || null,
      hint: checks[name]?.hint || checks[name]?.fixHint || null,
      errorCode:
        checks[name]?.errorCode ||
        checks[name]?.stripeCode ||
        checks[name]?.parentCode ||
        null
    }))
  };

  logReport(report, options);
  return report;
}

/**
 * Read-only schema probe for shop ratings/reviews feature.
 * Confirms tables exist, migration is recorded, and returns safe counts.
 * Never returns secrets or row contents.
 */
async function checkShopReviewSchema() {
  const started = nowMs();
  const REQUIRED_TABLES = [
    'reviewReasonCodes',
    'shopReviews',
    'shopReviewReasons',
    'shopReviewStats'
  ];
  const REVIEW_MIGRATION = '20260811180000-create-shop-review-tables.js';

  try {
    const [tableRows] = await db.sequelize.query(
      `SELECT TABLE_NAME AS name
       FROM information_schema.tables
       WHERE table_schema = DATABASE()
         AND TABLE_NAME IN (:names)`,
      { replacements: { names: REQUIRED_TABLES } }
    );
    const existing = new Set(
      (tableRows || []).map((r) => String(r.name).toLowerCase())
    );
    const tables = {};
    for (const name of REQUIRED_TABLES) {
      tables[name] = existing.has(name.toLowerCase());
    }
    const missingTables = REQUIRED_TABLES.filter(
      (name) => !existing.has(name.toLowerCase())
    );

    let migrationApplied = false;
    let migrationError = null;
    try {
      const [metaRows] = await db.sequelize.query(
        `SELECT name FROM SequelizeMeta WHERE name = :name LIMIT 1`,
        { replacements: { name: REVIEW_MIGRATION } }
      );
      migrationApplied = Array.isArray(metaRows) && metaRows.length > 0;
    } catch (err) {
      migrationError = err.message || String(err);
    }

    const counts = {
      reviewReasonCodes: null,
      shopReviews: null,
      shopReviewsPublished: null,
      shopReviewStats: null
    };
    const countErrors = {};

    async function safeCount(key, sql) {
      try {
        const [rows] = await db.sequelize.query(sql);
        counts[key] = Number(rows?.[0]?.c ?? 0);
      } catch (err) {
        countErrors[key] = err.message || String(err);
      }
    }

    if (tables.reviewReasonCodes) {
      await safeCount('reviewReasonCodes', 'SELECT COUNT(*) AS c FROM reviewReasonCodes');
    }
    if (tables.shopReviews) {
      await safeCount('shopReviews', 'SELECT COUNT(*) AS c FROM shopReviews');
      await safeCount(
        'shopReviewsPublished',
        `SELECT COUNT(*) AS c FROM shopReviews WHERE visibility = 'published'`
      );
    }
    if (tables.shopReviewStats) {
      await safeCount('shopReviewStats', 'SELECT COUNT(*) AS c FROM shopReviewStats');
    }

    const ok = missingTables.length === 0 && migrationApplied;
    return result(ok ? 'ok' : 'fail', ok
      ? 'Shop review schema present (tables + SequelizeMeta)'
      : missingTables.length
        ? `Missing tables: ${missingTables.join(', ')}`
        : `Migration not in SequelizeMeta: ${REVIEW_MIGRATION}`, {
      latencyMs: nowMs() - started,
      checkType: 'schema',
      feature: 'shopReviews',
      migration: {
        name: REVIEW_MIGRATION,
        applied: migrationApplied,
        error: migrationError
      },
      tables,
      missingTables,
      counts,
      countErrors: Object.keys(countErrors).length ? countErrors : undefined,
      hint: ok
        ? null
        : 'If tables are missing, re-run db:migrate on stage (deploy should do this). If only meta is missing but tables exist, investigate partial migrate.'
    });
  } catch (err) {
    const fields = safeErrorFields(err);
    return result('fail', err.message || 'Schema check failed', {
      latencyMs: nowMs() - started,
      checkType: 'schema',
      feature: 'shopReviews',
      ...fields,
      hint: 'MySQL must be reachable. Verify /health/mysql first.'
    });
  }
}

/**
 * Read-only schema probe for dedicated alteration/repair catalog.
 * Confirms tables + migration + seed row counts (no secrets / row contents).
 */
async function checkRepairCatalogSchema() {
  const started = nowMs();
  const REQUIRED_TABLES = [
    'repairGarments',
    'repairOptions',
    'repairGarmentOptions',
    'customerSelectedRepairItems',
    'customerSelectedRepairItemOptions',
    'customerSelectedRepairItemImages',
  ];
  const REPAIR_MIGRATION =
    '20260813170000-create-repair-catalog-and-booking-items.js';
  const REPAIR_IMAGES_MIGRATION =
    '20260813160000-create-customer-selected-service-repair-images.js';

  try {
    const [tableRows] = await db.sequelize.query(
      `SELECT TABLE_NAME AS name
       FROM information_schema.tables
       WHERE table_schema = DATABASE()
         AND TABLE_NAME IN (:names)`,
      { replacements: { names: REQUIRED_TABLES } }
    );
    const existing = new Set(
      (tableRows || []).map((r) => String(r.name).toLowerCase())
    );
    const tables = {};
    for (const name of REQUIRED_TABLES) {
      tables[name] = existing.has(name.toLowerCase());
    }
    const missingTables = REQUIRED_TABLES.filter(
      (name) => !existing.has(name.toLowerCase())
    );

    async function migrationApplied(name) {
      try {
        const [metaRows] = await db.sequelize.query(
          `SELECT name FROM SequelizeMeta WHERE name = :name LIMIT 1`,
          { replacements: { name } }
        );
        return {
          name,
          applied: Array.isArray(metaRows) && metaRows.length > 0,
          error: null,
        };
      } catch (err) {
        return {
          name,
          applied: false,
          error: err.message || String(err),
        };
      }
    }

    const migrations = {
      catalog: await migrationApplied(REPAIR_MIGRATION),
      legacyImages: await migrationApplied(REPAIR_IMAGES_MIGRATION),
    };

    const counts = {
      repairGarments: null,
      repairOptions: null,
      repairGarmentOptions: null,
      garmentsWithOptions: null,
    };
    const countErrors = {};

    async function safeCount(key, sql) {
      try {
        const [rows] = await db.sequelize.query(sql);
        counts[key] = Number(rows?.[0]?.c ?? 0);
      } catch (err) {
        countErrors[key] = err.message || String(err);
      }
    }

    if (tables.repairGarments) {
      await safeCount(
        'repairGarments',
        'SELECT COUNT(*) AS c FROM repairGarments WHERE deletedAt IS NULL'
      );
    }
    if (tables.repairOptions) {
      await safeCount(
        'repairOptions',
        'SELECT COUNT(*) AS c FROM repairOptions WHERE deletedAt IS NULL'
      );
    }
    if (tables.repairGarmentOptions) {
      await safeCount(
        'repairGarmentOptions',
        'SELECT COUNT(*) AS c FROM repairGarmentOptions'
      );
      await safeCount(
        'garmentsWithOptions',
        `SELECT COUNT(DISTINCT repairGarmentId) AS c FROM repairGarmentOptions`
      );
    }

    const seeded =
      (counts.repairGarments || 0) > 0 &&
      (counts.repairOptions || 0) > 0 &&
      (counts.garmentsWithOptions || 0) > 0;
    const migrationsOk =
      migrations.catalog.applied === true;
    const ok = missingTables.length === 0 && migrationsOk && seeded;

    return result(
      ok ? 'ok' : 'fail',
      ok
        ? 'Repair catalog schema present and seeded'
        : missingTables.length
          ? `Missing tables: ${missingTables.join(', ')}`
          : !migrationsOk
            ? `Migration not in SequelizeMeta: ${REPAIR_MIGRATION}`
            : 'Tables exist but catalog is empty (seed not applied)',
      {
        latencyMs: nowMs() - started,
        checkType: 'schema',
        feature: 'repairCatalog',
        migrations,
        tables,
        missingTables,
        counts,
        seeded,
        countErrors: Object.keys(countErrors).length ? countErrors : undefined,
        verifyEndpoints: {
          health: 'GET /health/repair-catalog',
          adminGarments: 'GET /admin/getRepairGarments',
          adminOptions: 'GET /admin/getRepairOptions',
          adminSeed: 'POST /admin/seedRepairCatalog',
          customerCatalog: 'GET /customer/repairCatalog/:serviceId',
          deploy: 'GET /health/deploy',
        },
        hint: ok
          ? null
          : missingTables.length || !migrationsOk
            ? 'Deploy should run db:migrate. Check GET /health/deploy migrate section.'
            : 'Run deploy seeds (includes repair catalog) or POST /admin/seedRepairCatalog. Customer catalog also auto-seeds when empty.',
      }
    );
  } catch (err) {
    const fields = safeErrorFields(err);
    return result('fail', err.message || 'Repair catalog schema check failed', {
      latencyMs: nowMs() - started,
      checkType: 'schema',
      feature: 'repairCatalog',
      ...fields,
      hint: 'MySQL must be reachable. Verify /health/mysql first.',
    });
  }
}

async function checkComplianceCatalogSchema() {
  const started = nowMs();
  const REQUIRED_TABLES = [
    'attempt_fail_instruction_sets',
    'attempt_fail_instructions',
    'agent_compliance_events',
    'attempt_fail_reasons',
  ];
  const MIGRATION =
    '20260817150000-agent-fail-instructions-and-compliance-events.js';
  const REASONS_MIGRATION = '20260818140000-attempt-fail-reasons.js';

  try {
    const [tableRows] = await db.sequelize.query(
      `SELECT TABLE_NAME AS name
       FROM information_schema.tables
       WHERE table_schema = DATABASE()
         AND TABLE_NAME IN (:names)`,
      { replacements: { names: REQUIRED_TABLES } }
    );
    const existing = new Set(
      (tableRows || []).map((r) => String(r.name).toLowerCase())
    );
    const tables = {};
    for (const name of REQUIRED_TABLES) {
      tables[name] = existing.has(name.toLowerCase());
    }
    const missingTables = REQUIRED_TABLES.filter(
      (name) => !existing.has(name.toLowerCase())
    );

    let migrationApplied = false;
    try {
      const [metaRows] = await db.sequelize.query(
        `SELECT name FROM SequelizeMeta WHERE name = :name LIMIT 1`,
        { replacements: { name: MIGRATION } }
      );
      migrationApplied = Array.isArray(metaRows) && metaRows.length > 0;
    } catch (_) {
      migrationApplied = false;
    }

    let reasonsMigrationApplied = false;
    try {
      const [reasonMeta] = await db.sequelize.query(
        `SELECT name FROM SequelizeMeta WHERE name = :name LIMIT 1`,
        { replacements: { name: REASONS_MIGRATION } }
      );
      reasonsMigrationApplied = Array.isArray(reasonMeta) && reasonMeta.length > 0;
    } catch (_) {
      reasonsMigrationApplied = false;
    }

    const counts = {
      instructionSets: null,
      instructionsEnabled: null,
      complianceEvents: null,
      failReasons: null,
      failReasonsCharging: null,
      failReasonsNoFee: null,
    };
    if (tables.attempt_fail_instruction_sets) {
      try {
        const [rows] = await db.sequelize.query(
          'SELECT COUNT(*) AS c FROM attempt_fail_instruction_sets WHERE isActive = 1'
        );
        counts.instructionSets = Number(rows?.[0]?.c ?? 0);
      } catch (_) {
        /* ignore */
      }
    }
    if (tables.attempt_fail_instructions) {
      try {
        const [rows] = await db.sequelize.query(
          'SELECT COUNT(*) AS c FROM attempt_fail_instructions WHERE isEnabled = 1'
        );
        counts.instructionsEnabled = Number(rows?.[0]?.c ?? 0);
      } catch (_) {
        /* ignore */
      }
    }
    if (tables.agent_compliance_events) {
      try {
        const [rows] = await db.sequelize.query(
          'SELECT COUNT(*) AS c FROM agent_compliance_events'
        );
        counts.complianceEvents = Number(rows?.[0]?.c ?? 0);
      } catch (_) {
        /* ignore */
      }
    }
    if (tables.attempt_fail_reasons) {
      try {
        const [rows] = await db.sequelize.query(
          `SELECT
             COUNT(*) AS c,
             SUM(CASE WHEN chargesFee = 1 AND status = 1 THEN 1 ELSE 0 END) AS feeOn,
             SUM(CASE WHEN chargesFee = 0 AND status = 1 THEN 1 ELSE 0 END) AS feeOff
           FROM attempt_fail_reasons`
        );
        counts.failReasons = Number(rows?.[0]?.c ?? 0);
        counts.failReasonsCharging = Number(rows?.[0]?.feeOn ?? 0);
        counts.failReasonsNoFee = Number(rows?.[0]?.feeOff ?? 0);
      } catch (_) {
        /* ignore */
      }
    }

    const seeded =
      Number(counts.instructionSets || 0) >= 2 &&
      Number(counts.instructionsEnabled || 0) > 0 &&
      Number(counts.failReasons || 0) > 0 &&
      Number(counts.failReasonsCharging || 0) > 0 &&
      Number(counts.failReasonsNoFee || 0) > 0;
    const ok =
      missingTables.length === 0 &&
      migrationApplied &&
      reasonsMigrationApplied &&
      seeded;

    return result(
      ok ? 'ok' : 'fail',
      ok
        ? 'Compliance catalog schema present and seeded'
        : 'Compliance catalog schema incomplete',
      {
        latencyMs: nowMs() - started,
        checkType: 'schema',
        feature: 'agentCompliance',
        migrations: {
          catalog: { name: MIGRATION, applied: migrationApplied },
          failReasons: { name: REASONS_MIGRATION, applied: reasonsMigrationApplied },
        },
        tables,
        missingTables,
        counts,
        seeded,
        verifyEndpoints: {
          health: 'GET /health/compliance-catalog',
          adminSets: 'GET /admin/failAttemptInstructions',
          adminReasons: 'GET /admin/failAttemptReasons',
          adminReport: 'GET /admin/compliance/geofence-overrides',
          deploy: 'GET /health/deploy',
        },
        hint: ok
          ? null
          : 'Deploy migrate + seed attempt-fail-instruction-defaults and attempt-fail-reason-defaults',
      }
    );
  } catch (err) {
    const fields = safeErrorFields(err);
    return result('fail', err.message || 'Compliance catalog check failed', {
      latencyMs: nowMs() - started,
      checkType: 'schema',
      feature: 'agentCompliance',
      ...fields,
    });
  }
}

module.exports = {
  checkMysql,
  checkRedis,
  checkFirebase,
  checkStripe,
  checkZeptoMail,
  checkShopReviewSchema,
  checkRepairCatalogSchema,
  checkComplianceCatalogSchema,
  runDependencyChecks,
  logCheck,
  logLine
};
