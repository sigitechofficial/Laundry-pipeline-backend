-- Per-service bag count when sameBagForAllServices = false
ALTER TABLE customerSelectedServices
  ADD COLUMN bags INT NULL;
