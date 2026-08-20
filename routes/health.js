'use strict';

const express = require('express');
const router = express.Router();
const asyncMiddleware = require('../middlewares/asyncHandler');
const healthController = require('../controllers/healthController');
const sensitiveSurfaceGuard = require('../middlewares/sensitiveSurfaceGuard');

/**
 * Health endpoints (read-only; no secrets returned).
 *
 * GET /health              — liveness (process up) — always public for deploy smoke
 * GET /health/ready        — mysql, redis, firebase, stripe, zeptomail (prod: ops token)
 * GET /health/deploy       — commit, deploy time, run, PM2, backups, node
 * GET /health/schema       — shop-review tables + SequelizeMeta + safe counts (prod: ops token)
 * GET /health/repair-catalog — repair catalog tables + seed counts (prod: ops token)
 * GET /health/compliance-catalog — fail instructions + compliance events (prod: ops token)
 * GET /health/:dependency  — single check (mysql|redis|firebase|stripe|zeptomail) (prod: ops token)
 */
router.get('/', asyncMiddleware(healthController.liveness));
router.get('/ready', sensitiveSurfaceGuard, asyncMiddleware(healthController.readiness));
router.get('/deploy', asyncMiddleware(healthController.deployInfo));
router.get('/version', asyncMiddleware(healthController.deployInfo));
router.get('/schema', sensitiveSurfaceGuard, asyncMiddleware(healthController.schemaInfo));
router.get('/repair-catalog', sensitiveSurfaceGuard, asyncMiddleware(healthController.repairCatalogSchemaInfo));
router.get('/compliance-catalog', sensitiveSurfaceGuard, asyncMiddleware(healthController.complianceCatalogSchemaInfo));
router.get('/:dependency', sensitiveSurfaceGuard, asyncMiddleware(healthController.singleDependency));

module.exports = router;
