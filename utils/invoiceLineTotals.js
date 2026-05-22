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
 * Subtotal for a persisted add-on row (unit price × items).
 * @param {{ price?: number|string, items?: number|string }} row
 * @returns {number}
 */
function getAddOnRowSubtotal(row) {
    if (!row) return 0;
    return getLineSubtotal(row.price, row.items);
}

/**
 * Parse add-on payload from agent/admin service line.
 * Supports:
 * - addOnServiceIds: [10, 10, 9] (duplicate ids = quantity)
 * - addOnServiceIds: [{ addOnServiceId: 10, items: 2 }]
 * - addOns / addOnServices: [{ id, qty|items|quantity }]
 * @param {object} service
 * @returns {Array<{ addOnServiceId: number, items: number }>}
 */
function normalizeAddOnEntriesFromService(service) {
    const merged = new Map();

    const bump = (addOnServiceId, items) => {
        const id = Number(addOnServiceId);
        if (!Number.isFinite(id) || id <= 0) return;
        const qty = getLineQuantity(items);
        merged.set(id, (merged.get(id) || 0) + qty);
    };

    const consumeList = (raw) => {
        if (!Array.isArray(raw)) return;
        for (const item of raw) {
            if (item == null) continue;
            if (typeof item === 'number' || typeof item === 'string') {
                bump(item, 1);
                continue;
            }
            if (typeof item === 'object') {
                bump(
                    item.addOnServiceId ?? item.id ?? item.addOnId,
                    item.items ?? item.qty ?? item.quantity ?? 1
                );
            }
        }
    };

    if (Array.isArray(service?.addOns) && service.addOns.length > 0) {
        consumeList(service.addOns);
    } else if (
        Array.isArray(service?.addOnServices) &&
        service.addOnServices.length > 0
    ) {
        consumeList(service.addOnServices);
    } else if (
        Array.isArray(service?.addOnServiceIds) &&
        service.addOnServiceIds.length > 0
    ) {
        consumeList(service.addOnServiceIds);
    }

    return [...merged.entries()].map(([addOnServiceId, items]) => ({
        addOnServiceId,
        items,
    }));
}

function serviceLineHasAddOnPayload(service) {
    return (
        (Array.isArray(service?.addOnServiceIds) &&
            service.addOnServiceIds.length > 0) ||
        (Array.isArray(service?.addOns) && service.addOns.length > 0) ||
        (Array.isArray(service?.addOnServices) &&
            service.addOnServices.length > 0)
    );
}

/**
 * Replace add-ons on a line; stores unit price + items qty.
 * @param {number} customerSelectedServiceId
 * @param {object} service - request line with addOn* fields
 * @param {import('sequelize').Model} addOnServicesModel
 * @returns {Promise<number>} add-on subtotal for this line
 */
async function replaceAddOnsForServiceLine(
    customerSelectedServiceId,
    service,
    addOnServicesModel
) {
    await customerSelectedServiceAddOn.destroy({
        where: { customerSelectedServiceId },
    });

    const entries = normalizeAddOnEntriesFromService(service);
    if (entries.length === 0) return 0;

    const catalog = await addOnServicesModel.findAll({
        where: { id: entries.map((e) => e.addOnServiceId) },
    });
    const priceById = new Map(
        catalog.map((row) => [row.id, getUnitCategoryCharge(row.price)])
    );

    let lineAddOnSubtotal = 0;
    for (const { addOnServiceId, items } of entries) {
        const unitPrice = priceById.get(addOnServiceId) ?? 0;
        const qty = getLineQuantity(items);
        await customerSelectedServiceAddOn.create({
            customerSelectedServiceId,
            addOnServiceId,
            price: unitPrice,
            items: qty,
        });
        lineAddOnSubtotal += getLineSubtotal(unitPrice, qty);
    }

    return parseFloat(lineAddOnSubtotal.toFixed(2));
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
            attributes: ['price', 'items'],
        });
        sum += addOnRows.reduce(
            (acc, addOn) => acc + getAddOnRowSubtotal(addOn),
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
    getAddOnRowSubtotal,
    normalizeAddOnEntriesFromService,
    serviceLineHasAddOnPayload,
    replaceAddOnsForServiceLine,
    sumActiveBookingServicesSubtotal,
};
