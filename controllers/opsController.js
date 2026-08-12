'use strict';

const opsPm2Service = require('../services/opsPm2Service');
const { getDeploymentInfo } = require('../services/deploymentInfoService');

function requestMeta(req) {
  return {
    path: req.originalUrl || req.url,
    method: req.method,
    ip: req.ip || req.connection?.remoteAddress || null,
    userAgent: req.get('user-agent') || null
  };
}

/**
 * GET /ops/status
 */
async function status(req, res) {
  const data = await opsPm2Service.getPm2Status();
  return res.status(data.ok ? 200 : 503).json({
    status: data.ok ? '1' : '0',
    message: data.message,
    data: { ...data, request: requestMeta(req) }
  });
}

/**
 * GET /ops/pm2/logs?lines=200&stream=both|out|err&grep=Error
 */
async function pm2Logs(req, res) {
  const data = await opsPm2Service.getPm2Logs({
    lines: req.query.lines,
    stream: req.query.stream,
    grep: req.query.grep || req.query.q
  });
  return res.status(data.ok ? 200 : 500).json({
    status: data.ok ? '1' : '0',
    message: data.message,
    data: { ...data, request: requestMeta(req) }
  });
}

/**
 * GET /ops/diagnose?logLines=120
 * Bundled PM2 + deps + schema + recent error lines (no cPanel needed).
 */
async function diagnose(req, res) {
  const data = await opsPm2Service.runDiagnose({
    logLines: req.query.logLines || req.query.lines
  });
  const http =
    data.severity === 'critical' ? 503 : data.severity === 'warn' ? 200 : 200;
  return res.status(http).json({
    status: data.ok ? '1' : '0',
    message: data.message,
    data: { ...data, request: requestMeta(req) }
  });
}

/**
 * GET /ops/deploy-logs?name=migrate|seed|deploy&lines=200
 */
async function deployLogs(req, res) {
  const data = opsPm2Service.getDeployLog({
    name: req.query.name,
    lines: req.query.lines
  });
  return res.status(data.ok ? 200 : 404).json({
    status: data.ok ? '1' : '0',
    message: data.message,
    data: { ...data, deploy: getDeploymentInfo(), request: requestMeta(req) }
  });
}

/**
 * POST /ops/pm2/reload  body: { confirm: true }
 * POST /ops/pm2/restart body: { confirm: true }
 */
async function pm2Mutate(req, res) {
  const action = req.params.action || req.body?.action;
  try {
    const data = await opsPm2Service.mutatePm2(action, {
      confirm: req.body?.confirm
    });
    return res.status(data.ok ? 200 : 500).json({
      status: data.ok ? '1' : '0',
      message: data.message,
      data: { ...data, request: requestMeta(req) }
    });
  } catch (err) {
    const code = err.statusCode || 500;
    return res.status(code).json({
      status: '0',
      message: err.message || 'Mutate failed',
      data: { request: requestMeta(req) }
    });
  }
}

module.exports = {
  status,
  pm2Logs,
  deployLogs,
  diagnose,
  pm2Mutate
};
