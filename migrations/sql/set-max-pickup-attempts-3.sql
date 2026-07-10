-- Raise default max pickup attempts from 2 to 3 (existing DBs)
ALTER TABLE bookings
  MODIFY COLUMN maxPickupAttempts INT NOT NULL DEFAULT 3;

UPDATE bookings SET maxPickupAttempts = 3 WHERE maxPickupAttempts = 2;
