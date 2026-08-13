'use strict';

/**
 * Customer-declared services are a frozen snapshot of what the customer booked.
 * Agent invoice lines live in customerSelectedServices and may be replaced freely.
 * Never derive green-ticks / "Customer selected" UI from live invoice lines.
 *
 * Repair/alteration garments are stored on customerSelectedRepairItems (not in the
 * CSS snapshot tables). They are attached at read time so agents always see them.
 */

const {
    customerOriginalServiceSnapshot,
    customerOriginalPreferenceSnapshot,
    customerSelectedService,
    customerSelectedRepairItem,
    bookingPreference,
    service,
    categories,
    subCategories,
    preferenceTypes,
    preferenceValues,
} = require('../../models');
const dbModels = require('../../models');
const {
    hydrateRepairItemsForBooking,
    normalizeRepairItems,
} = require('../../utils/repairBookingInclude');

const snapshotInclude = [
    {
        model: service,
        as: 'service',
        required: false,
        attributes: ['id', 'name', 'image', 'pricingBasis'],
    },
    {
        model: categories,
        as: 'category',
        required: false,
        attributes: ['id', 'name'],
    },
    {
        model: subCategories,
        as: 'subCategory',
        required: false,
        attributes: ['id', 'name', 'price', 'barCode', 'unitCount'],
    },
    {
        model: customerOriginalPreferenceSnapshot,
        as: 'preferences',
        required: false,
        include: [
            {
                model: preferenceTypes,
                as: 'preferenceType',
                required: false,
                attributes: ['id', 'name'],
            },
            {
                model: preferenceValues,
                as: 'preferenceValue',
                required: false,
                attributes: ['id', 'value'],
            },
        ],
    },
];

/**
 * One-time freeze of customer selections into snapshot tables.
 * Idempotent. Prefer active CSS; if none, fall back to earliest row per serviceId.
 */
async function ensureCustomerDeclaredSnapshot(bookingId) {
    const existing = await customerOriginalServiceSnapshot.count({
        where: { bookingId },
    });
    if (existing > 0) return;

    let services = await customerSelectedService.findAll({
        where: { bookingId, status: true },
        order: [['id', 'ASC']],
    });

    if (!services.length) {
        const allRows = await customerSelectedService.findAll({
            where: { bookingId },
            order: [['id', 'ASC']],
        });
        const firstByService = new Map();
        for (const row of allRows) {
            const key = row.serviceId != null ? String(row.serviceId) : `row-${row.id}`;
            if (!firstByService.has(key)) firstByService.set(key, row);
        }
        services = [...firstByService.values()];
    }

    for (const svc of services) {
        const snap = await customerOriginalServiceSnapshot.create({
            bookingId,
            serviceId: svc.serviceId ?? null,
            categoryId: svc.categoryId ?? null,
            subCategoryId: svc.subCategoryId ?? null,
            items: svc.items ?? null,
            bags: svc.bags ?? null,
            categoryPrice: svc.categoryPrice ?? null,
            serviceInstruction: svc.serviceInstruction ?? null,
        });

        const prefs = await bookingPreference.findAll({
            where: { bookingId, customerSelectedServiceId: svc.id },
        });
        if (prefs.length > 0) {
            await customerOriginalPreferenceSnapshot.bulkCreate(
                prefs.map((p) => ({
                    bookingId,
                    snapshotServiceId: snap.id,
                    preferenceTypeId: p.preferenceTypeId ?? null,
                    preferenceValueId: p.preferenceValueId ?? null,
                    parentPreferenceValueId: p.parentPreferenceValueId ?? null,
                    preferenceInstruction: p.preferenceInstruction ?? null,
                }))
            );
        }
    }

    const bookingLevelPrefs = await bookingPreference.findAll({
        where: { bookingId, customerSelectedServiceId: null },
    });
    if (bookingLevelPrefs.length > 0) {
        await customerOriginalPreferenceSnapshot.bulkCreate(
            bookingLevelPrefs.map((p) => ({
                bookingId,
                snapshotServiceId: null,
                preferenceTypeId: p.preferenceTypeId ?? null,
                preferenceValueId: p.preferenceValueId ?? null,
                parentPreferenceValueId: p.parentPreferenceValueId ?? null,
                preferenceInstruction: p.preferenceInstruction ?? null,
            }))
        );
    }
}

/**
 * Shape snapshot rows like customerSelectedServices for the agent app.
 */
function mapSnapshotToDeclaredService(row) {
    const plain = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };
    const prefs = plain.preferences || [];
    return {
        id: plain.id,
        bookingId: plain.bookingId,
        serviceId: plain.serviceId,
        categoryId: plain.categoryId,
        subCategoryId: plain.subCategoryId,
        items: plain.items,
        bags: plain.bags,
        noOfBags: plain.bags,
        categoryPrice: plain.categoryPrice != null ? String(plain.categoryPrice) : null,
        serviceInstruction: plain.serviceInstruction,
        status: true,
        service: plain.service || null,
        category: plain.category || null,
        subCategory: plain.subCategory || null,
        addOns: [],
        serviceLines: [],
        selectedServicePreferences: prefs.map((p) => ({
            id: p.id,
            customerSelectedServiceId: null,
            preferenceTypeId: p.preferenceTypeId,
            preferenceValueId: p.preferenceValueId,
            parentPreferenceValueId: p.parentPreferenceValueId,
            preferenceInstruction: p.preferenceInstruction,
            preferenceType: p.preferenceType || null,
            preferenceValue: p.preferenceValue || null,
        })),
        repairItems: [],
    };
}

/**
 * Attach live repair lines onto declared services (by serviceId).
 * Creates a synthetic declared row when a repair service has garments but no snapshot.
 */
async function attachRepairItemsToDeclaredServices(bookingId, declaredServices) {
    let list = Array.isArray(declaredServices) ? [...declaredServices] : [];

    // Snapshot row ids ≠ customerSelectedServiceId — match repair lines by serviceId.
    list = await hydrateRepairItemsForBooking(dbModels, bookingId, list, {
        matchByServiceIdOnly: true,
    });

    // Collect serviceIds already covered.
    const covered = new Set(
        list
            .map((s) => (s?.serviceId != null ? Number(s.serviceId) : null))
            .filter((id) => Number.isFinite(id))
    );

    // Find repair serviceIds not represented in declared list.
    let orphanServiceIds = [];
    try {
        const allRepair = await customerSelectedRepairItem.findAll({
            where: { bookingId },
            attributes: ['serviceId'],
            raw: true,
        });
        const seen = new Set();
        for (const r of allRepair) {
            const sid = Number(r.serviceId);
            if (!Number.isFinite(sid) || covered.has(sid) || seen.has(sid)) continue;
            seen.add(sid);
            orphanServiceIds.push(sid);
        }
    } catch (err) {
        console.warn(
            '[attachRepairItemsToDeclaredServices] orphan lookup skipped:',
            err?.message || err
        );
        return list;
    }

    if (orphanServiceIds.length === 0) {
        return list;
    }

    const serviceRows = await service.findAll({
        where: { id: orphanServiceIds },
        attributes: ['id', 'name', 'image', 'pricingBasis'],
    });
    const serviceById = new Map(
        serviceRows.map((s) => [Number(s.id), s.toJSON ? s.toJSON() : s])
    );

    const placeholders = orphanServiceIds.map((serviceId) => ({
        id: null,
        bookingId: Number(bookingId),
        serviceId,
        categoryId: null,
        subCategoryId: null,
        items: null,
        bags: null,
        noOfBags: null,
        categoryPrice: null,
        serviceInstruction: null,
        status: true,
        service: serviceById.get(serviceId) || {
            id: serviceId,
            name: 'Alteration and Repair',
        },
        category: null,
        subCategory: null,
        addOns: [],
        serviceLines: [],
        selectedServicePreferences: [],
        repairItems: [],
    }));

    const hydratedPlaceholders = await hydrateRepairItemsForBooking(
        dbModels,
        bookingId,
        placeholders,
        { matchByServiceIdOnly: true }
    );

    return [...list, ...hydratedPlaceholders];
}

/**
 * Ensure snapshot exists, then return agent-app-friendly declared services
 * including repair garments / options / images.
 */
async function getCustomerDeclaredServices(bookingId) {
    await ensureCustomerDeclaredSnapshot(bookingId);

    const rows = await customerOriginalServiceSnapshot.findAll({
        where: { bookingId },
        include: snapshotInclude,
        order: [['id', 'ASC']],
    });

    const mapped = rows.map(mapSnapshotToDeclaredService);
    return attachRepairItemsToDeclaredServices(bookingId, mapped);
}

/**
 * Flat list of all repair items for a booking (for top-level API fields).
 */
async function getBookingRepairItems(bookingId) {
    try {
        const rows = await customerSelectedRepairItem.findAll({
            where: { bookingId },
            order: [['id', 'ASC']],
            include: [
                {
                    model: dbModels.customerSelectedRepairItemOption,
                    as: 'options',
                    required: false,
                },
                {
                    model: dbModels.customerSelectedRepairItemImage,
                    as: 'images',
                    required: false,
                },
            ],
        });
        return normalizeRepairItems(rows);
    } catch (err) {
        console.warn('[getBookingRepairItems] skipped:', err?.message || err);
        return [];
    }
}

module.exports = {
    ensureCustomerDeclaredSnapshot,
    getCustomerDeclaredServices,
    getBookingRepairItems,
    attachRepairItemsToDeclaredServices,
};
