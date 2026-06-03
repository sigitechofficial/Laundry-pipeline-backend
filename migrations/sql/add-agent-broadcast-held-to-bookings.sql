-- Run on production if Sequelize migrations are not used
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS agentBroadcastHeld TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS agentVisibleAt DATETIME NULL;
