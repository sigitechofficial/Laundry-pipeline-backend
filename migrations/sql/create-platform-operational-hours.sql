-- Platform operational hours (run if Sequelize migrate not used)
CREATE TABLE IF NOT EXISTS platformOperationalHours (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  dayOfWeek ENUM('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday') NOT NULL UNIQUE,
  openTime TIME NULL DEFAULT '07:00:00',
  closeTime TIME NULL DEFAULT '20:00:00',
  status TINYINT(1) NOT NULL DEFAULT 1,
  createdAt DATETIME NOT NULL,
  updatedAt DATETIME NOT NULL
);

INSERT IGNORE INTO platformOperationalHours (dayOfWeek, openTime, closeTime, status, createdAt, updatedAt)
VALUES
  ('Monday', '07:00:00', '20:00:00', 1, NOW(), NOW()),
  ('Tuesday', '07:00:00', '20:00:00', 1, NOW(), NOW()),
  ('Wednesday', '07:00:00', '20:00:00', 1, NOW(), NOW()),
  ('Thursday', '07:00:00', '20:00:00', 1, NOW(), NOW()),
  ('Friday', '07:00:00', '20:00:00', 1, NOW(), NOW()),
  ('Saturday', '07:00:00', '20:00:00', 1, NOW(), NOW()),
  ('Sunday', '07:00:00', '20:00:00', 0, NOW(), NOW());
