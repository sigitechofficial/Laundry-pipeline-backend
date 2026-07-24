const express = require("express");
const router = express.Router();
const asyncMiddleware = require("../middlewares/asyncHandler");
const twilioVoiceWebhook = require("../controllers/twilioVoiceWebhook");

/**
 * Public Twilio webhooks — signature validated inside controller.
 */
router.post(
    "/voice/incoming",
    asyncMiddleware(twilioVoiceWebhook.voiceIncoming)
);

module.exports = router;
