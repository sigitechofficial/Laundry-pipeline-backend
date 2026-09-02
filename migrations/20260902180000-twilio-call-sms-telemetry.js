"use strict";

const {
    tableExists,
    addColumnIfMissing,
    removeColumnIfExists,
} = require("../utils/migrationHelpers");

/**
 * Twilio telemetry for admin Notify / Call logs.
 *
 * - booking_call_sessions: capture the real dialer-call lifecycle from the
 *   Twilio voice status callback (which SID, final outcome, duration, when the
 *   customer leg connected and ended) so admin sees more than "session made".
 * - booking_notifications: record when an SMS was actually delivered (via the
 *   new /webhooks/twilio/sms/status callback) instead of only the send-time
 *   status.
 *
 * Idempotent (addColumnIfMissing) so scripts/ensure-live-migrations.js heals a
 * drifted live DB on re-deploy.
 */
module.exports = {
    async up(queryInterface, Sequelize) {
        if (await tableExists(queryInterface, "booking_call_sessions")) {
            await addColumnIfMissing(
                queryInterface,
                "booking_call_sessions",
                "callSid",
                {
                    type: Sequelize.STRING(64),
                    allowNull: true,
                    comment: "Twilio CallSid of the bridged customer leg",
                }
            );
            await addColumnIfMissing(
                queryInterface,
                "booking_call_sessions",
                "callStatus",
                {
                    type: Sequelize.STRING(32),
                    allowNull: true,
                    comment: "Final Twilio DialCallStatus/CallStatus",
                }
            );
            await addColumnIfMissing(
                queryInterface,
                "booking_call_sessions",
                "callDurationSec",
                {
                    type: Sequelize.INTEGER,
                    allowNull: true,
                    comment: "Bridged call duration in seconds",
                }
            );
            await addColumnIfMissing(
                queryInterface,
                "booking_call_sessions",
                "connectedAt",
                {
                    type: Sequelize.DATE,
                    allowNull: true,
                    comment: "When the customer leg was answered/connected",
                }
            );
            await addColumnIfMissing(
                queryInterface,
                "booking_call_sessions",
                "endedAt",
                {
                    type: Sequelize.DATE,
                    allowNull: true,
                    comment: "When the call reached a terminal state",
                }
            );
        }

        if (await tableExists(queryInterface, "booking_notifications")) {
            await addColumnIfMissing(
                queryInterface,
                "booking_notifications",
                "deliveredAt",
                {
                    type: Sequelize.DATE,
                    allowNull: true,
                    comment: "When Twilio reported the SMS as delivered",
                }
            );
        }
    },

    async down(queryInterface) {
        await removeColumnIfExists(
            queryInterface,
            "booking_notifications",
            "deliveredAt"
        );
        await removeColumnIfExists(
            queryInterface,
            "booking_call_sessions",
            "endedAt"
        );
        await removeColumnIfExists(
            queryInterface,
            "booking_call_sessions",
            "connectedAt"
        );
        await removeColumnIfExists(
            queryInterface,
            "booking_call_sessions",
            "callDurationSec"
        );
        await removeColumnIfExists(
            queryInterface,
            "booking_call_sessions",
            "callStatus"
        );
        await removeColumnIfExists(
            queryInterface,
            "booking_call_sessions",
            "callSid"
        );
    },
};
