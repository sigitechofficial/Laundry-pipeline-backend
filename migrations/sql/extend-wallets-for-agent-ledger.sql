-- Agent wallet ledger columns (credits only for now)
ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS userId INT NULL,
  ADD COLUMN IF NOT EXISTS bookingId INT NULL,
  ADD COLUMN IF NOT EXISTS referenceType VARCHAR(64) NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS wallets_user_booking_reference_unique
  ON wallets (userId, bookingId, referenceType);

CREATE INDEX IF NOT EXISTS wallets_user_id_created_at
  ON wallets (userId, createdAt);
