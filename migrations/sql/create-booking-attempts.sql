-- Manual production script (run once).
-- Pickup/delivery attempts + no-show tracking
-- Equivalent to: migrations/20260710140000-create-booking-attempts.js

-- ---------------------------------------------------------------------------
-- 1) booking_attempts table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_attempts (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  bookingId INT NOT NULL,
  attemptType ENUM('pickup', 'delivery') NOT NULL,
  attemptNumber INT NOT NULL DEFAULT 1,
  status ENUM('arrived', 'completed', 'unattended', 'failed', 'superseded') NOT NULL DEFAULT 'arrived',
  arrivedAt DATETIME NOT NULL,
  completedAt DATETIME NULL,
  failedAt DATETIME NULL,
  driverId INT NULL,
  driverLateMinutes INT NULL,
  feeAmount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  feeCurrency VARCHAR(10) NULL DEFAULT 'USD',
  feeWaived TINYINT(1) NOT NULL DEFAULT 0,
  feeWaiveReason VARCHAR(255) NULL,
  failureReason VARCHAR(500) NULL,
  unattendedMethod ENUM('bag_at_door', 'concierge', 'locker') NULL,
  noShowPolicyId INT NULL,
  createdAt DATETIME NOT NULL,
  updatedAt DATETIME NOT NULL,
  KEY booking_attempts_booking_type_number (bookingId, attemptType, attemptNumber),
  KEY booking_attempts_booking_status (bookingId, status),
  CONSTRAINT fk_ba_booking FOREIGN KEY (bookingId) REFERENCES bookings(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_ba_driver FOREIGN KEY (driverId) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_ba_noshow_policy FOREIGN KEY (noShowPolicyId) REFERENCES policies(id) ON DELETE SET NULL ON UPDATE CASCADE
);

-- ---------------------------------------------------------------------------
-- 2) bookings columns (skip if column already exists)
-- MySQL 8.0+: IF NOT EXISTS on ADD COLUMN may not work — run one-by-one if error.
-- ---------------------------------------------------------------------------
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS pickupAttemptCount INT NOT NULL DEFAULT 0;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS deliveryAttemptCount INT NOT NULL DEFAULT 0;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS maxPickupAttempts INT NOT NULL DEFAULT 3;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS noShowFeeAccrued DECIMAL(10, 2) NOT NULL DEFAULT 0.00;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS noShowPolicyId INT NULL;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS cancellationPolicyId INT NULL;

-- Foreign keys (only if columns were just added and FKs don't exist yet)
-- ALTER TABLE bookings
--   ADD CONSTRAINT fk_bookings_noshow_policy
--   FOREIGN KEY (noShowPolicyId) REFERENCES policies(id) ON DELETE SET NULL ON UPDATE CASCADE;

-- ALTER TABLE bookings
--   ADD CONSTRAINT fk_bookings_cancel_policy
--   FOREIGN KEY (cancellationPolicyId) REFERENCES policies(id) ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3) Optional: mark migration as done in SequelizeMeta (if using sequelize-cli)
-- ---------------------------------------------------------------------------
-- INSERT INTO SequelizeMeta (name) VALUES ('20260710140000-create-booking-attempts.js');

-- ---------------------------------------------------------------------------
-- 4) Verify
-- ---------------------------------------------------------------------------
-- SHOW TABLES LIKE 'booking_attempts';
-- SHOW COLUMNS FROM bookings LIKE 'pickupAttemptCount';
-- SHOW COLUMNS FROM bookings LIKE 'noShowPolicyId';
