'use strict';

/**
 * promotions.timeZone: the IANA zone a promotion's start / end days are in.
 *
 * Start and end were stored as instants built from the admin's calendar days in a
 * hard-coded UK zone. A promotion now carries its own zone: the one its zones share
 * (each zone's city's country, countries.ianaTimeZone), set by the admin service on
 * every save, the way its currency is.
 *
 * Backfill, from data only: a promotion whose zones all resolve to one valid IANA zone
 * gets it ('selected' = its zones, deleted ones included; 'all' = every live zone;
 * 'excluded' = every other live zone). A promotion whose zones span several zones, or
 * have none configured, stays NULL: there is no single day to show, and the next save
 * asks the admin to fix its zones. Idempotent: only NULL rows are filled.
 *
 * Re-anchoring: the old code turned the admin's days into instants in Europe/London
 * (LEGACY_WRITE_ZONE below — a fact about how existing rows were written, not a business
 * default). A promotion backfilled to another zone keeps the day and time the admin picked,
 * now in its own zone, so startDay / endDay read back as entered. For a London zone the
 * instants are unchanged.
 */
const moment = require('moment-timezone');
const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/** The zone the replaced code wrote promotions.startDate / endDate in. */
const LEGACY_WRITE_ZONE = 'Europe/London';

/** Stored DATETIMEs are UTC wall clock (Sequelize timezone +00:00); read / written as strings. */
const DB_FORMAT = 'YYYY-MM-DD HH:mm:ss';

/** The same wall-clock day and time, moved from the legacy zone to the promotion's zone. */
function reanchor(utcText, timeZone) {
  if (utcText == null) return null;
  const wall = moment.utc(utcText, DB_FORMAT, true).tz(LEGACY_WRITE_ZONE).format(DB_FORMAT);
  return moment.tz(wall, DB_FORMAT, true, timeZone).utc().format(DB_FORMAT);
}

function zoneIdsOf(raw) {
  if (raw == null || raw === '') return [];
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch (_) {
      return [];
    }
  }
  return Array.isArray(list)
    ? list.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : [];
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'promotions', 'timeZone', {
      type: Sequelize.STRING(64),
      allowNull: true,
    });

    const select = { type: Sequelize.QueryTypes.SELECT };
    const promotions = await queryInterface.sequelize.query(
      `SELECT id, zoneScopeMode, zoneIds,
              DATE_FORMAT(startDate, '%Y-%m-%d %H:%i:%s') AS startDate,
              DATE_FORMAT(endDate, '%Y-%m-%d %H:%i:%s') AS endDate
         FROM promotions WHERE timeZone IS NULL`,
      select
    );
    if (!promotions.length) return;

    const zones = await queryInterface.sequelize.query(
      `SELECT z.id, z.status, z.deletedAt, c.ianaTimeZone
         FROM zones z
         LEFT JOIN cities ci ON ci.id = z.cityId
         LEFT JOIN countries c ON c.id = ci.countryId`,
      select
    );
    const byId = new Map(zones.map((z) => [Number(z.id), z]));
    const live = zones.filter((z) => z.deletedAt == null && Boolean(Number(z.status)));

    for (const promo of promotions) {
      const ids = zoneIdsOf(promo.zoneIds);
      let covered;
      if (promo.zoneScopeMode === 'selected') {
        covered = ids.map((id) => byId.get(id)).filter(Boolean);
      } else if (promo.zoneScopeMode === 'excluded') {
        covered = live.filter((z) => !ids.includes(Number(z.id)));
      } else {
        covered = live;
      }
      if (!covered.length) continue;
      const timeZones = new Set(covered.map((z) => (z.ianaTimeZone ? String(z.ianaTimeZone).trim() : '')));
      const [only] = [...timeZones];
      if (timeZones.size !== 1 || !only || !moment.tz.zone(only)) continue;
      await queryInterface.sequelize.query(
        'UPDATE promotions SET timeZone = ?, startDate = ?, endDate = ? WHERE id = ? AND timeZone IS NULL',
        { replacements: [only, reanchor(promo.startDate, only), reanchor(promo.endDate, only), promo.id] }
      );
    }
  },

  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'promotions', 'timeZone');
  },
};
