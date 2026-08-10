'use strict';

const {
  runDependencyChecks,
  checkMysql,
  checkRedis,
  checkFirebase,
  checkStripe,
  checkZeptoMail,
  logCheck,
  logLine
} = require('../services/healthCheckService');

const SINGLE_CHECKS = {
  mysql: checkMysql,
  redis: checkRedis,
  firebase: checkFirebase,
  stripe: checkStripe,
  zeptomail: checkZeptoMail
};

function requestMeta(req) {
  return {
    path: req.originalUrl || req.url,
    method: req.method,
    ip: req.ip || req.connection?.remoteAddress || null,
    userAgent: req.get('user-agent') || null,
    nodeEnv: process.env.NODE_ENV || null
  };
}

/**
 * GET /health
 * Liveness: process is up (does not probe dependencies).
 */
async function liveness(req, res) {
  const meta = requestMeta(req);
  logLine('info', 'liveness', {
    ...meta,
    alive: true,
    uptimeSec: Math.round(process.uptime())
  });

  return res.status(200).json({
    status: '1',
    message: 'Server is alive',
    data: {
      alive: true,
      nodeEnv: process.env.NODE_ENV || null,
      uptimeSec: Math.round(process.uptime()),
      serverTime: new Date().toISOString(),
      pid: process.pid
    }
  });
}

/**
 * GET /health/ready
 * Readiness: MySQL + Redis must be ok; firebase/stripe/zeptomail reported as degraded if failing.
 */
async function readiness(req, res) {
  const meta = requestMeta(req);
  const report = await runDependencyChecks(meta);
  const httpStatus = report.ready ? 200 : 503;

  return res.status(httpStatus).json({
    status: report.ready ? '1' : '0',
    message:
      report.overall === 'ok'
        ? 'All dependency checks passed'
        : report.overall === 'degraded'
          ? 'Core deps OK; one or more optional deps failing (firebase/stripe/zeptomail)'
          : 'Core dependency failure (mysql and/or redis)',
    data: {
      ...report,
      nodeEnv: process.env.NODE_ENV || null,
      criticalDeps: ['mysql', 'redis'],
      optionalDeps: ['firebase', 'stripe', 'zeptomail'],
      howToUseLogs:
        'Search server/local logs for prefix [HEALTH]. Failed deps include message + hint + errorCode.'
    }
  });
}

/**
 * GET /health/:dependency
 * dependency = mysql | redis | firebase | stripe | zeptomail
 */
async function singleDependency(req, res) {
  const meta = requestMeta(req);
  const name = String(req.params.dependency || '')
    .trim()
    .toLowerCase();
  const fn = SINGLE_CHECKS[name];
  if (!fn) {
    logLine('warn', 'single.unknown', { ...meta, dependency: req.params.dependency });
    return res.status(404).json({
      status: '0',
      message: `Unknown dependency "${req.params.dependency}". Use mysql, redis, firebase, stripe, or zeptomail.`,
      data: { available: Object.keys(SINGLE_CHECKS) }
    });
  }

  logLine('info', 'single.start', { ...meta, dependency: name });
  const check = await fn();
  logCheck(name, check);

  const httpStatus = check.status === 'ok' ? 200 : 503;
  return res.status(httpStatus).json({
    status: check.status === 'ok' ? '1' : '0',
    message: check.message,
    data: {
      dependency: name,
      ...check,
      serverTime: new Date().toISOString(),
      request: meta
    }
  });
}

module.exports = {
  liveness,
  readiness,
  singleDependency
};
