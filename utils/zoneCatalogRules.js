"use strict";

function attachKey(subCategoryId, addOnCategoryId) {
  return `${Number(subCategoryId)}:${Number(addOnCategoryId)}`;
}

/** Inherit master unless a zone row exists. Cannot invent a master-missing link. */
function effectiveAttach(masterAttached, overlayRow, addOnCategoryEnabled = true) {
  if (!addOnCategoryEnabled) return false;
  if (!overlayRow) return Boolean(masterAttached);
  if (!masterAttached) return false;
  return overlayRow.isEnabled !== false;
}

function money(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? parseFloat(n.toFixed(2)) : 0;
}

function parseEnabled(value) {
  if (value === false || value === 0 || value === "false" || value === "0") {
    return false;
  }
  return true;
}

/**
 * Partial upsert: saving a price must not re-enable a hidden row.
 * Creating a row still defaults isEnabled=true when omitted.
 */
function mergeOverridePatch(payload = {}, { hasPrice = false, creating = false } = {}) {
  const patch = {};
  if (creating || payload.isEnabled !== undefined) {
    patch.isEnabled =
      payload.isEnabled === undefined ? true : parseEnabled(payload.isEnabled);
  }
  if (creating || payload.sortOrder !== undefined) {
    patch.sortOrder =
      payload.sortOrder == null || payload.sortOrder === ""
        ? null
        : Number(payload.sortOrder);
  }
  if (hasPrice && (creating || payload.price !== undefined)) {
    patch.price =
      payload.price == null || payload.price === "" ? null : money(payload.price);
  }
  return patch;
}

function effectiveDisplayPrice(masterPrice, overridePrice, overlaysOn) {
  const master = money(masterPrice);
  const hasOverride = overridePrice != null && overridePrice !== "";
  const overridden = hasOverride ? money(overridePrice) : null;
  if (overlaysOn && overridden != null) {
    return { price: overridden, inherited: false, staged: false };
  }
  return {
    price: master,
    inherited: overridden == null,
    staged: !overlaysOn && overridden != null,
  };
}

module.exports = {
  attachKey,
  effectiveAttach,
  money,
  parseEnabled,
  mergeOverridePatch,
  effectiveDisplayPrice,
};
