'use strict';

/** Customer booking rows are service-level. Invoice lines have a subcategory + price. */
function looksLikeCustomerIntentRow(row) {
  return row != null && row.subCategoryId == null;
}

function uniqueFirstByServiceId(rows) {
  const firstByService = new Map();
  for (const row of rows || []) {
    const sid = Number(row.serviceId ?? row.service?.id);
    const key = Number.isFinite(sid) ? String(sid) : `row-${row.id}`;
    if (!firstByService.has(key)) firstByService.set(key, row);
  }
  return [...firstByService.values()];
}

/**
 * Recurring clones must copy the customer's original selection, never the
 * agent's invoice lines (priced subcategory / add-on / serviceLines).
 */
function pickCustomerIntentCloneSource({ snapshotRows, cssRows } = {}) {
  const snaps = Array.isArray(snapshotRows) ? snapshotRows : [];
  if (snaps.length) {
    return { source: 'snapshot', rows: snaps };
  }
  const css = Array.isArray(cssRows) ? cssRows : [];
  const intent = uniqueFirstByServiceId(css.filter(looksLikeCustomerIntentRow));
  if (intent.length) {
    return { source: 'css_intent', rows: intent };
  }
  return { source: 'none', rows: [] };
}

module.exports = {
  looksLikeCustomerIntentRow,
  uniqueFirstByServiceId,
  pickCustomerIntentCloneSource,
};
