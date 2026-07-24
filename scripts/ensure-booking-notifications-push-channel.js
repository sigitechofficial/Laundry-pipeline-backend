/**
 * Ensures booking_notifications.channel includes 'push' (Firebase notify ladder).
 * Safe to run when full db:migrate is blocked by older migrations.
 */
require("dotenv").config();
const { sequelize } = require("../models");

async function main() {
    await sequelize.query(
        "ALTER TABLE `booking_notifications` MODIFY COLUMN `channel` ENUM('sms','call','push') NOT NULL DEFAULT 'sms'"
    );
    console.log("OK: booking_notifications.channel now includes push");
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
