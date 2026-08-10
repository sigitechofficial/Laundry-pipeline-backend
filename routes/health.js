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
 * GET /health/:dependency  — single check (mysql|redis|firebase|stripe|zeptomail)
 */
router.get('/', asyncMiddleware(healthController.liveness));
router.get('/ready', asyncMiddleware(healthController.readiness));
router.get('/:dependency', asyncMiddleware(healthController.singleDependency));

module.exports = router;
