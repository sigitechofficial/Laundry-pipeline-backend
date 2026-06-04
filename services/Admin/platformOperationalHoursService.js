const { platformOperationalHours, countries } = require("../../models");
const { ValidationError } = require("../../middlewares/universalErrorHandler");
const {
  DAY_ORDER,
  normalizeTimeString,
  timeToMinutes,
  assertShopHoursWithinPlatform,
} = require("../../utils/platformOperationalHours");
const { getCountryContextById } = require("../../utils/countryTimeZone");

const DEFAULT_OPEN = "07:00:00";
const DEFAULT_CLOSE = "20:00:00";

function parseCountryId(countryId) {
  const id = Number(countryId);
  if (!Number.isInteger(id) || id < 1) {
    throw new ValidationError("countryId is required");
  }
  return id;
}

class PlatformOperationalHoursService {
  async ensureSeeded(countryId) {
    const cid = parseCountryId(countryId);
    const count = await platformOperationalHours.count({
      where: { countryId: cid },
    });
    if (count >= 7) return;

    const now = new Date();
    for (let i = 0; i < DAY_ORDER.length; i += 1) {
      await platformOperationalHours.findOrCreate({
        where: { countryId: cid, dayOfWeek: DAY_ORDER[i] },
        defaults: {
          openTime: DEFAULT_OPEN,
          closeTime: DEFAULT_CLOSE,
          status: i < 6,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
  }

  async getAll(countryId) {
    const cid = parseCountryId(countryId);
    await this.ensureSeeded(cid);

    const countryCtx = await getCountryContextById(cid);
    const rows = await platformOperationalHours.findAll({
      where: { countryId: cid },
      attributes: ["id", "countryId", "dayOfWeek", "openTime", "closeTime", "status"],
    });

    const orderIndex = new Map(DAY_ORDER.map((d, i) => [d, i]));
    rows.sort(
      (a, b) =>
        (orderIndex.get(a.dayOfWeek) ?? 99) -
        (orderIndex.get(b.dayOfWeek) ?? 99)
    );

    return {
      countryId: cid,
      countryName: countryCtx.countryName,
      ianaTimeZone: countryCtx.ianaTimeZone,
      days: rows.map((r) => r.get({ plain: true })),
      dayOrder: DAY_ORDER,
    };
  }

  _validatePlatformDay(day) {
    const dayOfWeek = day?.dayOfWeek;
    if (!DAY_ORDER.includes(dayOfWeek)) {
      throw new ValidationError(`Invalid dayOfWeek: ${dayOfWeek}`);
    }

    if (!day.status) return;

    const openMin = timeToMinutes(day.openTime);
    const closeMin = timeToMinutes(day.closeTime);
    if (openMin == null || closeMin == null) {
      throw new ValidationError(`${dayOfWeek}: open and close times are required`);
    }
    if (openMin >= closeMin) {
      throw new ValidationError(
        `${dayOfWeek}: close time must be after open time`
      );
    }
  }

  async updateAll(payload) {
    const countryId = parseCountryId(
      payload?.countryId ?? payload?.country?.id
    );
    const days = payload?.days || payload?.platformOperationalDays;
    if (!Array.isArray(days) || days.length === 0) {
      throw new ValidationError("days array is required");
    }

    const countryRow = await countries.findByPk(countryId, {
      attributes: ["id"],
    });
    if (!countryRow) {
      throw new ValidationError("Invalid countryId");
    }

    days.forEach((d) => this._validatePlatformDay(d));
    await this.ensureSeeded(countryId);

    for (const day of days) {
      const openTime = normalizeTimeString(day.openTime) || DEFAULT_OPEN;
      const closeTime = normalizeTimeString(day.closeTime) || DEFAULT_CLOSE;
      await platformOperationalHours.update(
        {
          openTime,
          closeTime,
          status: Boolean(day.status),
        },
        { where: { countryId, dayOfWeek: day.dayOfWeek } }
      );
    }

    return this.getAll(countryId);
  }

  async validateShopWorkingDays(countryId, shopDays) {
    const platform = await this.getAll(countryId);
    assertShopHoursWithinPlatform(shopDays, platform.days);
  }
}

module.exports = new PlatformOperationalHoursService();
