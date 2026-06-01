-- Manual production script (run once). If a column already exists, skip that ALTER.

ALTER TABLE bookings
  ADD COLUMN totalBags INT NULL;

ALTER TABLE bookings
  ADD COLUMN sameBagForAllServices TINYINT(1) NOT NULL DEFAULT 1;

UPDATE bookings
SET totalBags = noOfBags
WHERE totalBags IS NULL AND noOfBags IS NOT NULL;
