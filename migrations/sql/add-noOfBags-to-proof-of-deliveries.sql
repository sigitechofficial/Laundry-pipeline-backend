-- Add noOfBags to proofOfDeliveries (run if not using sequelize-cli migrate)
ALTER TABLE proofOfDeliveries
  ADD COLUMN noOfBags INT NULL AFTER noOfItems;

UPDATE proofOfDeliveries AS pod
INNER JOIN bookings AS b ON b.id = pod.bookingId
SET pod.noOfBags = COALESCE(b.totalBags, b.noOfBags)
WHERE pod.noOfBags IS NULL
  AND COALESCE(b.totalBags, b.noOfBags) IS NOT NULL;
