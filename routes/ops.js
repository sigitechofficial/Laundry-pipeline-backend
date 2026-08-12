'use strict';

const express = require('express');
const router = express.Router();
const asyncMiddleware = require('../middlewares/asyncHandler');
const opsControlGuard = require('../middlewares/opsControlGuard');
const opsController = require('../controllers/opsController');

/**
 * Ops control plane (PM2 logs / restart / deploy log tails).
 * Auth: X-Ops-Token == OPS_CONTROL_TOKEN (or .ops-control-token file).
 *
 * GET  /ops/status
 * GET  /ops/pm2/logs?lines=200&stream=both|out|err
 * GET  /ops/deploy-logs?name=migrate|seed|deploy&lines=200
 * POST /ops/pm2/reload   { "confirm": true }
 * POST /ops/pm2/restart  { "confirm": true }
 */
router.use(opsControlGuard);

router.get('/status', asyncMiddleware(opsController.status));
router.get('/pm2/logs', asyncMiddleware(opsController.pm2Logs));
router.get('/deploy-logs', asyncMiddleware(opsController.deployLogs));
router.post('/pm2/:action(reload|restart)', asyncMiddleware(opsController.pm2Mutate));

module.exports = router;
