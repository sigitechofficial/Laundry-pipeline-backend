'use strict';

/**
 * Shared banner multipart / JSON payload helpers.
 * Form-data sends booleans and zone lists as strings; treat those as data, not JS truthiness.
 */

function parseFormBoolean(value, defaultValue = undefined) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function emptyToNull(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return null;
    return trimmed;
  }
  return value;
}

function normalizeZoneIds(zoneIds) {
  if (zoneIds === undefined || zoneIds === null || zoneIds === '') return null;

  if (typeof zoneIds === 'string') {
    const trimmed = zoneIds.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('[')) {
      try {
        return normalizeZoneIds(JSON.parse(trimmed));
      } catch {
        /* fall through to comma-separated */
      }
    }
    const parts = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    return parts.map((id) => parseInt(id, 10));
  }

  if (Array.isArray(zoneIds)) {
    if (zoneIds.length === 0) return null;
    return zoneIds.map((id) => parseInt(id, 10));
  }

  const parsed = parseInt(zoneIds, 10);
  return [parsed];
}

function zoneIdsApplyTo(zoneIds, zoneId) {
  if (zoneId == null || zoneId === '') return true;
  const want = Number(zoneId);
  if (Number.isNaN(want)) return true;
  const ids = normalizeZoneIds(zoneIds);
  if (!ids || ids.length === 0) return true;
  return ids.some((id) => Number(id) === want);
}

function publicPathFromMulterFile(file) {
  if (!file) return null;
  const raw = String(file.path || '').replace(/\\/g, '/');
  const idx = raw.indexOf('Public/');
  if (idx >= 0) return raw.slice(idx);
  if (file.filename) return `Public/BannerImages/${file.filename}`;
  return null;
}

function pickBannerUpload(req) {
  if (!req) return null;
  if (req.file) return req.file;
  const files = req.files;
  if (!files) return null;
  if (Array.isArray(files)) return files[0] || null;
  return files.image?.[0] || files.bannerImage?.[0] || null;
}

function isMissingTableError(err) {
  const msg = `${err?.message || ''} ${err?.original?.message || ''} ${err?.parent?.message || ''}`;
  return /ER_NO_SUCH_TABLE|doesn't exist|Unknown table|no such table/i.test(msg);
}

module.exports = {
  parseFormBoolean,
  emptyToNull,
  normalizeZoneIds,
  zoneIdsApplyTo,
  publicPathFromMulterFile,
  pickBannerUpload,
  isMissingTableError,
};
