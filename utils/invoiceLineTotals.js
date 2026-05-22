'use strict';

const {
    customerSelectedService,
    customerSelectedServiceAddOn,
} = require('../models');

/**
 * Quantity for an invoice line (minimum 1).
 * @param {number|string|null|undefined} items
 * @returns {number}
 */
function getLineQuantity(items) {
    const parsed = parseInt(items, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Unit price from categoryCharge / categoryPrice field.
 * @param {number|string|null|undefined} categoryCharge
 * @returns {number}
 */
function getUnitCategoryCharge(categoryCharge) {
    const unit = parseFloat(categoryCharge);
    return Number.isFinite(unit) && unit >= 0 ? unit : 0;
}

/**
 * Line subtotal = unit price × quantity.
 * @param {number|string} unitPrice
 * @param {number|string|null|undefined} items
 * @returns {number}
 */
function getLineSubtotal(unitPrice, items) {
    const unit = getUnitCategoryCharge(unitPrice);
    const qty = getLineQuantity(items);
    return parseFloat((unit * qty).toFixed(2));
}

/**
 * Subtotal for a persisted customerSelectedService row.
 * @param {{ categoryPrice?: number|string, items?: number|string }} row
 * @returns {number}
 */
function getSelectedServiceRowSubtotal(row) {
    if (!row) return 0;
    return getLineSubtotal(row.categoryPrice, row.items);
}

/**
 * Sum categoryPrice×items for all active lines on a booking, optionally including add-ons.
 * @param {number|string} bookingId
 * @param {{ includeAddOns?: boolean }} [options]
 * @returns {Promise<number>}
 */
async function sumActiveBookingServicesSubtotal(bookingId, options = {}) {
    const { includeAddOns = true } = options;

    const rows = await customerSelectedService.findAll({
        where: { bookingId, status: true },
        attributes: ['id', 'categoryPrice', 'items'],
    });

    let sum = rows.reduce(
        (acc, row) => acc + getSelectedServiceRowSubtotal(row),
        0
    );

    if (includeAddOns && rows.length > 0) {
        const lineIds = rows.map((r) => r.id);
        const addOnRows = await customerSelectedServiceAddOn.findAll({
            where: { customerSelectedServiceId: lineIds },
            attributes: ['price'],
        });
        sum += addOnRows.reduce(
            (acc, addOn) => acc + (parseFloat(addOn.price) || 0),
            0
        );
    }

    return parseFloat(sum.toFixed(2));
}

module.exports = {
    getLineQuantity,
    getUnitCategoryCharge,
    getLineSubtotal,
    getSelectedServiceRowSubtotal,
    sumActiveBookingServicesSubtotal,
};
