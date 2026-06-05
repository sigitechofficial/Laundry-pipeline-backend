ALTER TABLE bookings
  ADD COLUMN operationalTimeZone VARCHAR(64) NULL;

ALTER TABLE bookings
  ADD COLUMN customerLocalTimeZone VARCHAR(64) NULL;
