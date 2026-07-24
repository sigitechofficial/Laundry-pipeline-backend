require('dotenv').config();
const { sequelize } = require('../models');

(async () => {
  const [meta] = await sequelize.query(
    "SELECT name FROM SequelizeMeta WHERE name LIKE '%booking_notif%' OR name LIKE '%20260724%'"
  );
  console.log('meta', meta);
  const [tables] = await sequelize.query("SHOW TABLES LIKE 'booking_notifications'");
  console.log('tables', tables);

  if (!tables.length) {
    await sequelize.query(`
      CREATE TABLE booking_notifications (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        bookingId INT NOT NULL,
        attemptId INT NULL,
        leg ENUM('pickup','delivery') NOT NULL,
        channel ENUM('sms','call') NOT NULL DEFAULT 'sms',
        agentUserId INT NULL,
        twilioSid VARCHAR(64) NULL,
        twilioStatus VARCHAR(32) NULL,
        bodyPreview VARCHAR(200) NULL,
        toMasked VARCHAR(32) NULL,
        fromNumber VARCHAR(32) NULL,
        sentAt DATETIME NOT NULL,
        createdAt DATETIME NOT NULL,
        updatedAt DATETIME NOT NULL,
        INDEX booking_notifications_booking_leg_channel_idx (bookingId, leg, channel),
        INDEX booking_notifications_attempt_id_idx (attemptId),
        INDEX booking_notifications_booking_sent_idx (bookingId, sentAt)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('created table');
    await sequelize.query(
      "INSERT INTO SequelizeMeta (name) VALUES ('20260724153000-create-booking-notifications.js')"
    );
    console.log('meta inserted');
  } else {
    console.log('table already exists');
  }

  await sequelize.close();
})().catch(async (e) => {
  console.error(e);
  try { await sequelize.close(); } catch (_) {}
  process.exit(1);
});
