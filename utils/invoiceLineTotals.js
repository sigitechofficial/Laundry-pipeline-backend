'use strict';

const {
    customerSelectedService,
    customerSelectedServiceAddOn,
    customerSelectedServiceLine,
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
 * Normalize the add-ons of a single line. Unlike the flat normalizer this keeps
 * each entry's instructions and does NOT merge across lines.
 * @param {Array} rawAddOns
 * @returns {Array<{ addOnServiceId: number, items: number, instructions: string|null }>}
 */
function normalizeLineAddOns(rawAddOns) {
    const result = [];
    if (!Array.isArray(rawAddOns)) return result;

    for (const a of rawAddOns) {
        if (a == null) continue;

        let id;
        let items;
        let instructions;

        if (typeof a === 'number' || typeof a === 'string') {
            id = Number(a);
            items = 1;
            instructions = null;
        } else {
            id = Number(a.addOnServiceId ?? a.id ?? a.addOnId);
            items = getLineQuantity(a.items ?? a.qty ?? a.quantity ?? 1);
            const note = a.instructions ?? a.note ?? '';
            instructions = note === '' ? null : note;
        }

        if (!Number.isFinite(id) || id <= 0) continue;
        result.push({ addOnServiceId: id, items, instructions });
    }

    return result;
}

/**
 * Resolve the line-split for a service payload.
 * - Prefers explicit serviceLines[] (line-split UI).
 * - Falls back to flat addOns -> a single line carrying the full quantity (legacy).
 * @param {object} service
 * @returns {Array<{ lineNum: number, items: number, addOns: Array }>}
 */
function resolveServiceLinesFromPayload(service) {
    const totalItems = getLineQuantity(service.items);

    if (Array.isArray(service?.serviceLines) && service.serviceLines.length > 0) {
        return service.serviceLines.map((line, idx) => ({
            lineNum:
                Number(line?.lineNum) > 0 ? Number(line.lineNum) : idx + 1,
            items: getLineQuantity(line?.items),
            addOns: normalizeLineAddOns(line?.addOns),
        }));
    }

    // Legacy flat payload -> single line with full quantity.
    const flat = normalizeAddOnEntriesFromService(service).map((e) => ({
        addOnServiceId: e.addOnServiceId,
        items: e.items,
        instructions: null,
    }));

    return [{ lineNum: 1, items: totalItems, addOns: flat }];
}

/**
 * Replace all lines (and their add-ons) for a selected-service row.
 * Stores both customerSelectedServiceId (for subtotal queries) and the line id.
 * @param {import('sequelize').Model} selectedServiceRow
 * @param {object} service - request line with serviceLines[] or flat addOns
 * @param {import('sequelize').Model} addOnServicesModel
 * @returns {Promise<number>} add-on subtotal across all lines of this service
 */
async function replaceServiceLinesForSelectedService(
    selectedServiceRow,
    service,
    addOnServicesModel
) {
    const customerSelectedServiceId = selectedServiceRow.id;

    // Wipe existing lines (cascade removes their add-ons) and any legacy flat add-ons.
    await customerSelectedServiceLine.destroy({
        where: { customerSelectedServiceId },
    });
    await customerSelectedServiceAddOn.destroy({
        where: { customerSelectedServiceId },
    });

    const lines = resolveServiceLinesFromPayload(service);

    const allIds = [
        ...new Set(
            lines.flatMap((l) => l.addOns.map((a) => a.addOnServiceId))
        ),
    ];
    const priceById = new Map();
    if (allIds.length > 0) {
        const catalog = await addOnServicesModel.findAll({
            where: { id: allIds },
        });
        catalog.forEach((row) =>
            priceById.set(row.id, getUnitCategoryCharge(row.price))
        );
    }

    let addOnSubtotal = 0;
    for (const line of lines) {
        const lineRow = await customerSelectedServiceLine.create({
            customerSelectedServiceId,
            lineNum: line.lineNum,
            items: line.items,
        });

        for (const addOn of line.addOns) {
            const unitPrice = priceById.get(addOn.addOnServiceId) ?? 0;
            await customerSelectedServiceAddOn.create({
                customerSelectedServiceId,
                customerSelectedServiceLineId: lineRow.id,
                addOnServiceId: addOn.addOnServiceId,
                price: unitPrice,
                items: addOn.items,
                instructions: addOn.instructions,
            });
            addOnSubtotal += getLineSubtotal(unitPrice, addOn.items);
        }
    }

    return parseFloat(addOnSubtotal.toFixed(2));
}

/**
 * Validate that the sum of line items equals the service quantity (when lines given).
 * @param {object} service
 * @returns {{ valid: boolean, expected: number, actual: number }}
 */
function validateServiceLineItems(service) {
    const expected = getLineQuantity(service?.items);
    if (!Array.isArray(service?.serviceLines) || service.serviceLines.length === 0) {
        return { valid: true, expected, actual: expected };
    }
    const actual = service.serviceLines.reduce(
        (sum, line) => sum + getLineQuantity(line?.items),
        0
    );
    return { valid: actual === expected, expected, actual };
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
    normalizeLineAddOns,
    resolveServiceLinesFromPayload,
    replaceServiceLinesForSelectedService,
    validateServiceLineItems,
    sumActiveBookingServicesSubtotal,
};
