/**
 * Ensures booking_call_sessions exists (when full migrate is blocked).
 */
require("dotenv").config();
const { sequelize } = require("../models");

async function main() {
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS booking_call_sessions (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        bookingId INT NOT NULL,
        agentUserId INT NOT NULL,
        leg ENUM('pickup','delivery') NOT NULL,
        agentPhoneE164 VARCHAR(32) NOT NULL,
        status ENUM('active','closed','expired') NOT NULL DEFAULT 'active',
        expiresAt DATETIME NOT NULL,
        closedAt DATETIME NULL,
        closeReason VARCHAR(64) NULL,
        createdAt DATETIME NOT NULL,
        updatedAt DATETIME NOT NULL,
        INDEX booking_call_sessions_agent_phone_status_idx (agentPhoneE164, status),
        INDEX booking_call_sessions_booking_leg_status_idx (bookingId, leg, status),
        INDEX booking_call_sessions_expires_idx (expiresAt)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log("OK: booking_call_sessions ready");
    await sequelize.close();
}

main().catch(async (err) => {
    console.error(err);
    try {
        await sequelize.close();
    } catch (_) {
        /* ignore */
    }
    process.exit(1);
});
