const express = require('express');
const router = express.Router();
const asyncMiddleware = require('../middlewares/asyncHandler');
const fcmDebugGuard = require('../middlewares/fcmDebugGuard');
const fcmDebugController = require('../controllers/debug/fcmDebugController');

/**
 * FCM / push notification debug tools.
 * GET  /debug/fcm/status
 * POST /debug/fcm/send
 */
router.get(
  '/fcm/status',
  fcmDebugGuard,
  asyncMiddleware(fcmDebugController.fcmStatus)
);

router.post(
  '/fcm/send',
  fcmDebugGuard,
  asyncMiddleware(fcmDebugController.fcmSend)
);

module.exports = router;
