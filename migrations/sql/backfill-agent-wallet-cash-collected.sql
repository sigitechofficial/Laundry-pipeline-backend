-- Backfill cash_collected debits for paid cash bookings (run AFTER backfill-agent-wallet-credits.sql)

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
  'cash_collected',
  bd.total,
  'GBP',
  'debit',
  'completed',
  CONCAT('Cash collected for order #', COALESCE(b.orderTrackId, b.id)),
  NOW(),
  NOW()
FROM billingDetails bd
INNER JOIN bookings b ON b.id = bd.bookingId
INNER JOIN addressDb a ON a.id = b.laundryShopId AND a.addressType = 'LaundaryShopAddress'
WHERE bd.paymentStatus = 'Paid'
  AND LOWER(COALESCE(b.paymentType, '')) = 'cash'
  AND bd.total IS NOT NULL
  AND bd.total > 0
  AND b.laundryShopId IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM wallets w
    WHERE w.bookingId = b.id
      AND w.referenceType = 'cash_collected'
      AND w.deletedAt IS NULL
  );
