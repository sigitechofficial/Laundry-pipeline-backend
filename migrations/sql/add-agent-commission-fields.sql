-- Agent commission: zone % + per-booking earning
ALTER TABLE zones
  ADD COLUMN IF NOT EXISTS agentCommissionPercent INT NULL
    COMMENT 'Percent of order total paid to agent/shop';

ALTER TABLE billingDetails
  ADD COLUMN IF NOT EXISTS agentEarning DECIMAL(10,2) NULL
    COMMENT 'Agent shop earning for this booking';

UPDATE zones
SET agentCommissionPercent = 100 - zoneAdminComission
WHERE agentCommissionPercent IS NULL
  AND zoneAdminComission IS NOT NULL;

UPDATE zones
SET agentCommissionPercent = 80
WHERE agentCommissionPercent IS NULL;

UPDATE billingDetails bd
INNER JOIN bookings b ON b.id = bd.bookingId
INNER JOIN zones z ON z.id = b.zoneId
SET bd.agentEarning = ROUND(
    bd.total * (COALESCE(z.agentCommissionPercent, 100 - COALESCE(z.zoneAdminComission, 20)) / 100),
    2
)
WHERE bd.agentEarning IS NULL
  AND bd.total IS NOT NULL
  AND bd.total > 0;
