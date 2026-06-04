-- Country-scoped platform operational hours (run if Sequelize migrate not used)

ALTER TABLE countries
  ADD COLUMN IF NOT EXISTS ianaTimeZone VARCHAR(64) NULL;

UPDATE countries SET ianaTimeZone = 'Europe/London' WHERE ianaTimeZone IS NULL;
UPDATE countries SET ianaTimeZone = 'Asia/Karachi' WHERE UPPER(shortName) = 'PK' AND (ianaTimeZone IS NULL OR ianaTimeZone = 'Europe/London');
UPDATE countries SET ianaTimeZone = 'Asia/Dubai' WHERE UPPER(shortName) = 'AE' AND (ianaTimeZone IS NULL OR ianaTimeZone = 'Europe/London');

ALTER TABLE platformOperationalHours
  ADD COLUMN countryId INT NULL;

SET @defaultCountryId = (SELECT id FROM countries ORDER BY id ASC LIMIT 1);

UPDATE platformOperationalHours SET countryId = @defaultCountryId WHERE countryId IS NULL;

ALTER TABLE platformOperationalHours
  MODIFY countryId INT NOT NULL,
  ADD CONSTRAINT fk_platform_hours_country FOREIGN KEY (countryId) REFERENCES countries(id) ON DELETE CASCADE ON UPDATE CASCADE;

-- Drop old single-column unique on dayOfWeek if present (adjust index name if your DB differs)
-- ALTER TABLE platformOperationalHours DROP INDEX dayOfWeek;

ALTER TABLE platformOperationalHours
  ADD UNIQUE KEY platform_operational_hours_country_day_unique (countryId, dayOfWeek);
