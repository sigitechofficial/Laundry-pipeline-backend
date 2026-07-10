-- Geofence radius on no-show policy (dynamic requiredRadiusMeters for agent app)
-- Equivalent to: migrations/20260710160000-add-arrival-radius-to-no-show-policy.js

ALTER TABLE no_show_policy_configs
  ADD COLUMN IF NOT EXISTS arrivalRadiusMeters INT NULL DEFAULT 100
  COMMENT 'Geofence radius in meters for Arrived / no-show / unattended';

-- Optional: mark Sequelize migration done
-- INSERT INTO SequelizeMeta (name) VALUES ('20260710160000-add-arrival-radius-to-no-show-policy.js');
