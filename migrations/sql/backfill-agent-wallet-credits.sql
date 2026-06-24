-- Optional backfill: credit wallet for already-paid bookings with agentEarning
-- Run AFTER extend-wallets-for-agent-ledger.sql

INSERT INTO wallets (
  userId,
  bookingId,
  referenceType,
  amount,
  currency,
  type,
  status,
  description,
  createdAt,
  updatedAt
)
SELECT
  a.userId,
  b.id,
  'booking_commission',
  bd.agentEarning,
  'GBP',
  'credit',
  'completed',
  CONCAT('Commission for order #', COALESCE(b.orderTrackId, b.id)),
  NOW(),
  NOW()
FROM billingDetails bd
INNER JOIN bookings b ON b.id = bd.bookingId
INNER JOIN addressDb a ON a.id = b.laundryShopId AND a.addressType = 'LaundaryShopAddress'
WHERE bd.paymentStatus = 'Paid'
  AND bd.agentEarning IS NOT NULL
  AND bd.agentEarning > 0
  AND b.laundryShopId IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM wallets w
    WHERE w.bookingId = b.id
      AND w.referenceType = 'booking_commission'
      AND w.deletedAt IS NULL
  );
