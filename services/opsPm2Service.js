'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { getDeploymentInfo } = require('./deploymentInfoService');

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_LINES = 200;
const MAX_LINES = 1000;
const MAX_LOG_CHARS = 400_000;
const MUTATE_COOLDOWN_MS = 15_000;

let lastMutateAt = 0;

function clampLines(raw) {
  const n = Number.parseInt(String(raw ?? DEFAULT_LINES), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LINES;
  return Math.min(n, MAX_LINES);
}

function resolvePm2AppName() {
  const info = getDeploymentInfo();
  return (
    process.env.PM2_APP_NAME ||
    info.pm2App ||
    (info.branch === 'main' || process.env.NODE_ENV === 'production'
      ? 'laundary'
      : 'laundary-stage')
  );
}

function resolveDeployRoot() {
  const info = getDeploymentInfo();
  if (info.deployRoot) return info.deployRoot;
  if (process.env.DEPLOY_ROOT) return process.env.DEPLOY_ROOT;
  const app = resolvePm2AppName();
  if (app === 'laundary') return '/home/sigisolutions/deployments/laundry-api';
  return '/home/sigisolutions/deployments/laundry-api-stage';
}

function redactLogText(text) {
  let out = String(text || '');
  out = out.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]');
  out = out.replace(/\b(sk_(?:live|test)_[A-Za-z0-9]+)/g, 'sk_[REDACTED]');
  out = out.replace(/Zoho-enczapikey\s+\S+/gi, 'Zoho-enczapikey [REDACTED]');
  out = out.replace(
    /\b(OPS_CONTROL_TOKEN|JWT_ACCESS_SECRET|JWT_GUEST_SECRET|STRIPE_SECRET_KEY|TWILIO_AUTH_TOKEN|ZEPTOMAIL_API_TOKEN|SSH_PRIVATE_KEY)\s*[=:]\s*\S+/gi,
    '$1=[REDACTED]'
  );
  out = out.replace(/("?(?:password|secret|token|apiKey|api_key)"?\s*:\s*")([^"]{4,})(")/gi, '$1[REDACTED]$3');
  if (out.length > MAX_LOG_CHARS) {
    out = `…[truncated ${out.length - MAX_LOG_CHARS} chars]…\n` + out.slice(-MAX_LOG_CHARS);
  }
  return out;
}

function runPm2(args, { timeoutMs = 45000 } = {}) {
  return execFileAsync('pm2', args, {
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
    env: process.env
  }).then(
    ({ stdout, stderr }) => ({
      ok: true,
      stdout: String(stdout || ''),
      stderr: String(stderr || '')
    }),
    (err) => ({
      ok: false,
      stdout: String(err.stdout || ''),
      stderr: String(err.stderr || err.message || String(err)),
      code: err.code || null,
      killed: !!err.killed
    })
  );
}

function pickSafePm2Process(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const env = raw.pm2_env || {};
  return {
    name: raw.name || env.name || null,
    pmId: raw.pm_id ?? env.pm_id ?? null,
    status: env.status || null,
    restartTime: env.restart_time ?? null,
    unstableRestarts: env.unstable_restarts ?? null,
    createdAt: env.created_at || null,
    execMode: env.exec_mode || null,
    instances: env.instances ?? null,
    execPath: env.pm_exec_path || null,
    cwd: env.pm_cwd || null,
    nodeVersion: env.node_version || null,
    version: env.version || null,
    axmMonitor: raw.monit
      ? {
          cpu: raw.monit.cpu,
          memory: raw.monit.memory
        }
      : null,
    // Never dump full env (secrets). Only names of keys present on app env.
    envKeyNames: Object.keys(env.env && typeof env.env === 'object' ? env.env : {})
      .filter((k) => !/password|secret|token|key|private/i.test(k))
      .slice(0, 80)
  };
}

async function getPm2Status() {
  const appName = resolvePm2AppName();
  const deploy = getDeploymentInfo();
  const listed = await runPm2(['jlist']);
  let processes = [];
  if (listed.ok && listed.stdout.trim()) {
    try {
      const arr = JSON.parse(listed.stdout);
      processes = Array.isArray(arr) ? arr.map(pickSafePm2Process).filter(Boolean) : [];
    } catch (err) {
      return {
        ok: false,
        message: 'Failed to parse pm2 jlist',
        error: err.message,
        appName,
        deploy
      };
    }
  } else if (!listed.ok) {
    return {
      ok: false,
      message: 'pm2 jlist failed',
      error: listed.stderr || listed.stdout,
      appName,
      deploy
    };
  }

  const self = processes.find((p) => p.name === appName) || null;
  return {
    ok: true,
    message: self ? `PM2 process ${appName} is ${self.status}` : `PM2 process ${appName} not found`,
    appName,
    self,
    processes,
    deploy: {
      shortCommit: deploy.shortCommit,
      branch: deploy.branch,
      releaseName: deploy.releaseName,
      deployedAt: deploy.deployedAt,
      livePath: deploy.livePath,
      deployRoot: deploy.deployRoot,
      pm2App: deploy.pm2App,
      migrate: deploy.migrate || null,
      seed: deploy.seed || null
    },
    serverTime: new Date().toISOString()
  };
}

async function getPm2Logs({ lines = DEFAULT_LINES, stream = 'both', grep = null } = {}) {
  const appName = resolvePm2AppName();
  const n = clampLines(lines);
  const streamNorm = String(stream || 'both').toLowerCase();
  const args = ['logs', appName, '--lines', String(n), '--nostream', '--raw'];
  if (streamNorm === 'err' || streamNorm === 'error') args.push('--err');
  else if (streamNorm === 'out' || streamNorm === 'output') args.push('--out');

  const result = await runPm2(args, { timeoutMs: 60000 });
  let combined = `${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}`;
  const grepRaw = grep == null ? '' : String(grep).trim();
  let matchedLines = null;
  if (grepRaw) {
    let re;
    try {
      re = new RegExp(grepRaw, 'i');
    } catch {
      re = new RegExp(grepRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    const filtered = combined.split(/\r?\n/).filter((line) => re.test(line));
    matchedLines = filtered.length;
    combined = filtered.join('\n');
  }
  return {
    ok: result.ok,
    message: result.ok
      ? grepRaw
        ? `Matched ${matchedLines} line(s) in last ${n} for ${appName} (grep=${grepRaw})`
        : `Last ${n} log line(s) for ${appName}`
      : 'pm2 logs failed',
    appName,
    stream: streamNorm,
    lines: n,
    grep: grepRaw || null,
    matchedLines,
    text: redactLogText(combined),
    error: result.ok ? null : result.stderr || result.stdout,
    serverTime: new Date().toISOString()
  };
}

const ERROR_LINE_RE =
  /\b(error|exception|fatal|unhandled|ECONNREFUSED|ETIMEDOUT|EADDRINUSE|TypeError|ReferenceError|SequelizeDatabaseError|WARN:)\b/i;

function extractInterestingLogLines(text, { limit = 40 } = {}) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .filter((l) => ERROR_LINE_RE.test(l));
  return lines.slice(-limit);
}

const DEPLOY_LOG_FILES = {
  migrate: 'last-migrate-deploy.log',
  seed: 'last-seed.log',
  deploy: 'deploy.log'
};

function tailFile(filePath, lines) {
  const n = clampLines(lines);
  if (!fs.existsSync(filePath)) {
    return { ok: false, message: `File not found: ${filePath}`, text: null };
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const all = raw.split(/\r?\n/);
  const slice = all.slice(-n).join('\n');
  return {
    ok: true,
    message: `Tailed ${Math.min(n, all.length)} line(s)`,
    path: filePath,
    totalLines: all.length,
    text: redactLogText(slice)
  };
}

function getDeployLog({ name = 'migrate', lines = DEFAULT_LINES } = {}) {
  const key = String(name || 'migrate').toLowerCase();
  const fileName = DEPLOY_LOG_FILES[key];
  if (!fileName) {
    return {
      ok: false,
      message: `Unknown deploy log "${name}". Use migrate|seed|deploy`,
      available: Object.keys(DEPLOY_LOG_FILES)
    };
  }
  const deployRoot = resolveDeployRoot();
  const filePath = path.join(deployRoot, 'logs', fileName);
  const tailed = tailFile(filePath, lines);
  return {
    ...tailed,
    name: key,
    deployRoot,
    serverTime: new Date().toISOString()
  };
}

function assertMutateAllowed() {
  const now = Date.now();
  const wait = MUTATE_COOLDOWN_MS - (now - lastMutateAt);
  if (wait > 0) {
    const err = new Error(`Mutate cooldown active — retry in ${Math.ceil(wait / 1000)}s`);
    err.statusCode = 429;
    throw err;
  }
}

async function mutatePm2(action, { confirm } = {}) {
  if (confirm !== true && confirm !== 'true' && confirm !== 1) {
    const err = new Error('Pass JSON body { "confirm": true } to proceed');
    err.statusCode = 400;
    throw err;
  }
  assertMutateAllowed();

  const appName = resolvePm2AppName();
  const normalized = String(action || '').toLowerCase();
  let args;
  if (normalized === 'reload') {
    args = ['reload', appName, '--update-env'];
  } else if (normalized === 'restart') {
    args = ['restart', appName, '--update-env'];
  } else {
    const err = new Error('action must be reload or restart');
    err.statusCode = 400;
    throw err;
  }

  lastMutateAt = Date.now();
  console.warn('[OPS] pm2 mutate', { action: normalized, appName, at: new Date().toISOString() });

  // Detach slightly so the HTTP response can flush before process dies on restart.
  const startedAt = new Date().toISOString();
  const resultPromise = new Promise((resolve) => {
    setTimeout(async () => {
      const result = await runPm2(args, { timeoutMs: 90000 });
      resolve(result);
    }, 250);
  });

  // Wait up to ~8s for acknowledgment; if process dies mid-flight client may still see disconnect.
  const raced = await Promise.race([
    resultPromise,
    new Promise((resolve) =>
      setTimeout(() => resolve({ ok: true, deferred: true, stdout: '', stderr: '' }), 8000)
    )
  ]);

  return {
    ok: !!raced.ok,
    deferred: !!raced.deferred,
    message: raced.deferred
      ? `Accepted pm2 ${normalized} ${appName} --update-env (still running)`
      : raced.ok
        ? `pm2 ${normalized} ${appName} --update-env completed`
        : `pm2 ${normalized} failed`,
    action: normalized,
    appName,
    startedAt,
    stdout: redactLogText(raced.stdout || ''),
    stderr: redactLogText(raced.stderr || ''),
    serverTime: new Date().toISOString()
  };
}

/**
 * One-shot remote diagnosis: PM2 + deps + schema + recent error lines + deploy logs.
 */
async function runDiagnose({ logLines = 120 } = {}) {
  const { runDependencyChecks, checkShopReviewSchema } = require('./healthCheckService');
  const n = clampLines(logLines);

  const [pm2, errLogs, outLogs, ready, schema] = await Promise.all([
    getPm2Status(),
    getPm2Logs({ lines: n, stream: 'err' }),
    getPm2Logs({ lines: Math.min(n, 80), stream: 'out' }),
    runDependencyChecks({ path: '/ops/diagnose' }),
    checkShopReviewSchema()
  ]);

  const migrate = getDeployLog({ name: 'migrate', lines: 40 });
  const seed = getDeployLog({ name: 'seed', lines: 50 });

  const interesting = extractInterestingLogLines(
    `${errLogs.text || ''}\n${outLogs.text || ''}`,
    { limit: 50 }
  );

  const issues = [];
  if (!pm2.ok) issues.push({ code: 'pm2_query_failed', detail: pm2.message });
  if (!pm2.self) issues.push({ code: 'pm2_process_missing', detail: `Expected ${pm2.appName}` });
  else if (pm2.self.status !== 'online') {
    issues.push({ code: 'pm2_not_online', detail: pm2.self.status });
  }
  if (ready.overall === 'fail') {
    issues.push({
      code: 'deps_fail',
      detail: (ready.summary?.fail || []).join(',')
    });
  } else if (ready.overall === 'degraded') {
    issues.push({
      code: 'deps_degraded',
      detail: (ready.summary?.fail || []).join(',')
    });
  }
  if (schema.status !== 'ok') {
    issues.push({ code: 'schema_fail', detail: schema.message });
  }
  if (!migrate.ok) issues.push({ code: 'migrate_log_missing', detail: migrate.message });
  if (interesting.length >= 3) {
    issues.push({
      code: 'recent_error_lines',
      detail: `${interesting.length} matching line(s) in recent PM2 logs`
    });
  }

  const severity =
    issues.some((i) => ['pm2_not_online', 'pm2_process_missing', 'deps_fail', 'schema_fail'].includes(i.code))
      ? 'critical'
      : issues.length
        ? 'warn'
        : 'ok';

  return {
    ok: severity === 'ok',
    severity,
    message:
      severity === 'ok'
        ? 'Diagnose OK — PM2 online, core deps healthy, schema present'
        : `Diagnose ${severity}: ${issues.map((i) => i.code).join(', ')}`,
    issues,
    pm2: {
      ok: pm2.ok,
      appName: pm2.appName,
      self: pm2.self,
      deploy: pm2.deploy
    },
    dependencies: {
      overall: ready.overall,
      ready: ready.ready,
      summary: ready.summary,
      checks: Object.fromEntries(
        Object.entries(ready.checks || {}).map(([name, c]) => [
          name,
          {
            status: c.status,
            message: c.message,
            latencyMs: c.latencyMs,
            hint: c.hint || c.fixHint || null
          }
        ])
      )
    },
    schema: {
      status: schema.status,
      message: schema.message,
      migration: schema.migration,
      tables: schema.tables,
      counts: schema.counts
    },
    logs: {
      interesting,
      errTail: redactLogText((errLogs.text || '').split(/\r?\n/).slice(-25).join('\n')),
      outTail: redactLogText((outLogs.text || '').split(/\r?\n/).slice(-15).join('\n'))
    },
    deployLogs: {
      migrate: {
        ok: migrate.ok,
        summary: (migrate.text || '').split(/\r?\n/).slice(-8).join('\n')
      },
      seed: {
        ok: seed.ok,
        summary: (seed.text || '').split(/\r?\n/).slice(-10).join('\n')
      }
    },
    serverTime: new Date().toISOString()
  };
}

module.exports = {
  getPm2Status,
  getPm2Logs,
  getDeployLog,
  mutatePm2,
  runDiagnose,
  extractInterestingLogLines,
  resolvePm2AppName,
  resolveDeployRoot,
  redactLogText
};
