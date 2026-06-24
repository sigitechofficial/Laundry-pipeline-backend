-- Admin assign / reassign: target shop must accept before laundryShopId is set
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS adminAssignedShopId INT NULL
    COMMENT 'Admin-target shop address id; pending accept by that shop only';
