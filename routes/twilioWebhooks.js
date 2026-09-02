const express = require("express");
const router = express.Router();
const asyncMiddleware = require("../middlewares/asyncHandler");
const twilioVoiceWebhook = require("../controllers/twilioVoiceWebhook");
const twilioSmsWebhook = require("../controllers/twilioSmsWebhook");

/**
 * Public Twilio webhooks — signature validated inside controller.
 */
router.post(
    "/voice/incoming",
    asyncMiddleware(twilioVoiceWebhook.voiceIncoming)
);

router.post(
    "/voice/status",
    asyncMiddleware(twilioVoiceWebhook.voiceStatus)
);

router.post(
    "/sms/status",
    asyncMiddleware(twilioSmsWebhook.smsStatus)
);

module.exports = router;
