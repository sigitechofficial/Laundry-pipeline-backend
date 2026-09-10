"use strict";

const { clampListLimit, clampPage } = require("../../utils/listLimit");

const ALLOWED_PERIODS = Object.freeze([
  "today",
  "last_2_days",
  "last_7_days",
  "last_30_days",
  "this_week",
  "this_month",
  "this_year",
  "custom",
  "all",
]);

function parseDateOnlySafe(value) {
  const raw = value == null ? "" : String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(date) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    23,
    59,
    59,
    999
  );
}

function parsePeriodQuery(raw = {}) {
  const period = ALLOWED_PERIODS.includes(raw.period) ? raw.period : "this_month";
  const startDate = period === "custom" ? parseDateOnlySafe(raw.startDate) : "";
  const endDate = period === "custom" ? parseDateOnlySafe(raw.endDate) : "";
  return {
    period,
    startDate,
    endDate,
    page: clampPage(raw.page),
    limit: clampListLimit(raw.limit, 20, 100),
  };
}

/**
 * Inclusive local-time range. `all` returns null (no date predicate).
 */
function buildPeriodRange(period, startDate, endDate, now = new Date()) {
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);

  if (period === "today") {
    return { start: todayStart, end: todayEnd };
  }

  if (period === "last_2_days") {
    const start = startOfDay(now);
    start.setDate(start.getDate() - 1);
    return { start, end: todayEnd };
  }

  // Rolling windows (inclusive of today).
  if (period === "last_7_days" || period === "this_week") {
    const start = startOfDay(now);
    start.setDate(start.getDate() - 6);
    return { start, end: todayEnd };
  }

  if (period === "last_30_days") {
    const start = startOfDay(now);
    start.setDate(start.getDate() - 29);
    return { start, end: todayEnd };
  }

  // Calendar month-to-date / year-to-date.
  if (period === "this_month") {
    return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: todayEnd };
  }

  if (period === "this_year") {
    return { start: new Date(now.getFullYear(), 0, 1), end: todayEnd };
  }

  if (period === "custom" && startDate && endDate) {
    if (startDate > endDate) {
      return {
        start: new Date(`${endDate}T00:00:00`),
        end: new Date(`${startDate}T23:59:59.999`),
      };
    }
    return {
      start: new Date(`${startDate}T00:00:00`),
      end: new Date(`${endDate}T23:59:59.999`),
    };
  }

  return null;
}

function previousPeriodRange(range) {
  if (!range?.start || !range?.end) return null;
  const spanMs = Math.max(range.end.getTime() - range.start.getTime(), 0);
  const end = new Date(range.start.getTime() - 1);
  const start = new Date(end.getTime() - spanMs);
  return { start, end };
}

function sqlDateTime(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function toIsoDate(d) {
  if (!d) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function money(value) {
  const n = Number(value);
  return parseFloat((Number.isFinite(n) ? n : 0).toFixed(2));
}

function pctChange(current, previous) {
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (prev === 0 && cur === 0) return 0;
  if (prev === 0) return null;
  return parseFloat((((cur - prev) / prev) * 100).toFixed(1));
}

module.exports = {
  ALLOWED_PERIODS,
  parsePeriodQuery,
  buildPeriodRange,
  previousPeriodRange,
  sqlDateTime,
  toIsoDate,
  money,
  pctChange,
  parseDateOnlySafe,
};
