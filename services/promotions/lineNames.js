'use strict';

/**
 * Names for discount lines. Pure (no database), so tests and the checkout code can use
 * it without loading the models. promotionReportService re-exports it.
 */

/** Customer-facing name of one discount line. */
function displayLineName(lineType, lineItemId, names) {
  if (lineType === 'delivery') return 'Delivery fee';
  if (lineType === 'basket' || lineItemId == null) return 'Whole order';
  const stored = lineType === 'item' ? 'subCategory' : lineType;
  return names.get(`${stored}:${lineItemId}`)
    || (lineType === 'service' ? 'Service' : lineType === 'addon' ? 'Add-on' : 'Item');
}

module.exports = { displayLineName };
