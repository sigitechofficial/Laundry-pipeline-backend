'use strict';

const express = require('express');
const router = express.Router();
const asyncMiddleware = require('../middlewares/asyncHandler');
const healthController = require('../controllers/healthController');

/**
 * Health endpoints (read-only; no secrets returned).
 *
 * GET /health              — liveness (process up)
 * GET /health/ready        — mysql, redis, firebase, stripe, zeptomail
 * GET /health/deploy       — commit, deploy time, run, PM2, backups, node
 * GET /health/:dependency  — single check (mysql|redis|firebase|stripe|zeptomail)
 */
router.get('/', asyncMiddleware(healthController.liveness));
router.get('/ready', asyncMiddleware(healthController.readiness));
router.get('/deploy', asyncMiddleware(healthController.deployInfo));
router.get('/version', asyncMiddleware(healthController.deployInfo));
router.get('/:dependency', asyncMiddleware(healthController.singleDependency));

module.exports = router;
