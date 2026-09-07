'use strict';

/**
 * Load Sequelize models only when a persistence helper runs.
 * Pure math/normalize functions must stay importable without config.json
 * so unit tests and CI can run from committed files alone.
 */
function invoiceLineModels() {
    return require('../models');
}

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
    const { customerSelectedServiceAddOn } = invoiceLineModels();
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
    try {
        const { booking, customerSelectedService } = invoiceLineModels();
        const line = await customerSelectedService.findByPk(customerSelectedServiceId, {
            attributes: ["id", "bookingId"],
        });
        const bookingRow = line?.bookingId
            ? await booking.findByPk(line.bookingId, { attributes: ["id", "zoneId"] })
            : null;
        if (bookingRow?.zoneId) {
            const zoneCatalogService = require("../services/Admin/zoneCatalogService");
            for (const { addOnServiceId } of entries) {
                const resolved = await zoneCatalogService.resolvePrice(
                    bookingRow.zoneId,
                    { addOnServiceId }
                );
                priceById.set(addOnServiceId, getUnitCategoryCharge(resolved.price));
            }
        }
    } catch (err) {
        console.warn(
            "[invoiceLineTotals] zone add-on resolve failed, using master:",
            err.message
        );
    }

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
    const {
        customerSelectedServiceLine,
        customerSelectedServiceAddOn,
    } = invoiceLineModels();

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
        try {
            const { booking } = invoiceLineModels();
            const zoneCatalogService = require("../services/Admin/zoneCatalogService");
            const bookingRow = selectedServiceRow.bookingId
                ? await booking.findByPk(selectedServiceRow.bookingId, {
                      attributes: ["id", "zoneId"],
                  })
                : null;
            if (bookingRow?.zoneId) {
                for (const addOnId of allIds) {
                    const resolved = await zoneCatalogService.resolvePrice(
                        bookingRow.zoneId,
                        { addOnServiceId: addOnId }
                    );
                    priceById.set(addOnId, getUnitCategoryCharge(resolved.price));
                }
            }
        } catch (err) {
            console.warn(
                "[invoiceLineTotals] zone add-on resolve failed, using master:",
                err.message
            );
        }
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
    const {
        customerSelectedService,
        customerSelectedServiceAddOn,
    } = invoiceLineModels();

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

function sumRepairPieceCount(items) {
    if (!Array.isArray(items) || items.length === 0) return 0;
    return items.reduce((sum, item) => {
        const q = Number(item?.quantity ?? item?.qty ?? item?.pieceCount);
        return sum + (Number.isFinite(q) && q > 0 ? Math.floor(q) : 1);
    }, 0);
}

function lineUnitCount(row) {
    const raw = Number(row?.subCategory?.unitCount ?? row?.unitCount);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
}

/**
 * Do this line's repair garments describe the line itself, or are they the
 * service-wide list the customer declared?
 *
 * They describe the line when the garments were created against it, when the
 * line is the un-priced placeholder for the whole service, or when booking
 * already stored the garment total on it. An agent's priced line keeps its own
 * quantity — otherwise one "Hem trousers × 1" line reports 12 items.
 * @param {object} row
 * @param {Array} garments
 * @returns {boolean}
 */
function lineOwnsRepairGarments(row, garments) {
    if (!row || !Array.isArray(garments) || garments.length === 0) return false;
    const rowId = Number(row.id);
    const ownedByRow = garments.some(
        (g) =>
            g?.customerSelectedServiceId != null &&
            Number(g.customerSelectedServiceId) === rowId
    );
    if (ownedByRow) return true;
    if (row.subCategoryId == null) return true;
    return Number(row.items) === sumRepairPieceCount(garments);
}

function rowPieceCount(row) {
    const qty = Number(row?.items);
    if (!Number.isFinite(qty) || qty <= 0) return 0;
    return Math.floor(qty) * lineUnitCount(row);
}

/**
 * Physical garments / pieces for the "N items" badge.
 *
 * Every priced line counts as items × unitCount — that is exactly what the agent
 * typed on the add-services screen, so invoice / receipt / order screens agree.
 *
 * The one exception is the customer's un-itemised alteration booking: a single
 * placeholder line stands for the whole service, so its declared garments count
 * instead. Once the agent itemises, that service has one row per priced option
 * and the booking-level garments are a per-service total — reusing them there is
 * what produced "195 items", and collapsing those rows produced "15".
 */
function computePhysicalTotalItems({
    customerSelectedServices = [],
    customerDeclaredServices = [],
    repairItems = [],
} = {}) {
    const active = (customerSelectedServices || []).filter(
        (row) => row && row.status !== false
    );
    const repairs = Array.isArray(repairItems) ? repairItems : [];
    const repairsByService = new Map();
    for (const item of repairs) {
        const sid = Number(item?.serviceId);
        if (!Number.isFinite(sid) || sid <= 0) continue;
        if (!repairsByService.has(sid)) repairsByService.set(sid, []);
        repairsByService.get(sid).push(item);
    }

    const rowsByService = new Map();
    for (const row of active) {
        const sid = Number(row.serviceId);
        const key = Number.isFinite(sid) && sid > 0 ? sid : `row-${row.id}`;
        if (!rowsByService.has(key)) rowsByService.set(key, []);
        rowsByService.get(key).push(row);
    }

    let total = 0;
    for (const [key, rows] of rowsByService) {
        const lineTotal = rows.reduce((sum, row) => sum + rowPieceCount(row), 0);
        if (rows.length === 1) {
            const row = rows[0];
            const garments = repairsByService.get(key)?.length
                ? repairsByService.get(key)
                : row.repairItems;
            if (lineOwnsRepairGarments(row, garments)) {
                total += Math.max(lineTotal, sumRepairPieceCount(garments));
                continue;
            }
        }
        total += lineTotal;
    }

    if (total > 0) return total;

    const declared = (customerDeclaredServices || []).reduce((sum, row) => {
        const n = Number(row?.items);
        return sum + (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
    }, 0);
    if (declared > 0) return declared;
    return sumRepairPieceCount(repairs);
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
    computePhysicalTotalItems,
    sumRepairPieceCount,
    lineOwnsRepairGarments,
};
