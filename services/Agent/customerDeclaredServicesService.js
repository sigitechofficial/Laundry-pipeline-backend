'use strict';

/**
 * Customer-declared services are a frozen snapshot of what the customer booked.
 * Agent invoice lines live in customerSelectedServices and may be replaced freely.
 * Never derive green-ticks / "Customer selected" UI from live invoice lines.
 */

const {
    customerOriginalServiceSnapshot,
    customerOriginalPreferenceSnapshot,
    customerSelectedService,
    bookingPreference,
    service,
    categories,
    subCategories,
    preferenceTypes,
    preferenceValues,
} = require('../../models');

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
    };
}

/**
 * Ensure snapshot exists, then return agent-app-friendly declared services.
 */
async function getCustomerDeclaredServices(bookingId) {
    await ensureCustomerDeclaredSnapshot(bookingId);

    const rows = await customerOriginalServiceSnapshot.findAll({
        where: { bookingId },
        include: snapshotInclude,
        order: [['id', 'ASC']],
    });

    return rows.map(mapSnapshotToDeclaredService);
}

module.exports = {
    ensureCustomerDeclaredSnapshot,
    getCustomerDeclaredServices,
};
