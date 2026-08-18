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
const { Op } = require('sequelize');
const dbModels = require('../../models');
const {
    hydrateRepairItemsForBooking,
    normalizeRepairItems,
} = require('../../utils/repairBookingInclude');

function uniqueFirstByServiceId(rows) {
    const firstByService = new Map();
    for (const row of rows) {
        const key = row.serviceId != null ? String(row.serviceId) : `row-${row.id}`;
        if (!firstByService.has(key)) firstByService.set(key, row);
    }
    return [...firstByService.values()];
}

/** Customer booking rows are service-level. Invoice lines have a subcategory + price. */
function looksLikeCustomerIntentRow(row) {
    return row.subCategoryId == null;
}

function declaredServiceIdSet(declaredServices) {
    return new Set(
        (Array.isArray(declaredServices) ? declaredServices : [])
            .map((s) => (s?.serviceId != null ? Number(s.serviceId) : null))
            .filter((id) => Number.isFinite(id))
    );
}

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
 * Idempotent. Never freeze priced invoice lines as customer intent — those
 * replace live CSS after AgentAddSerivces. Prefer unpriced service-level rows
 * (including deactivated originals), then earliest row per serviceId.
 */
async function ensureCustomerDeclaredSnapshot(bookingId) {
    const existing = await customerOriginalServiceSnapshot.count({
        where: { bookingId },
    });
    if (existing > 0) return;

    const allRows = await customerSelectedService.findAll({
        where: { bookingId },
        order: [['id', 'ASC']],
    });
    if (!allRows.length) return;

    const intentRows = allRows.filter(looksLikeCustomerIntentRow);
    const services = uniqueFirstByServiceId(
        intentRows.length ? intentRows : allRows
    );

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
async function loadMappedSnapshots(bookingId) {
    await ensureCustomerDeclaredSnapshot(bookingId);

    const rows = await customerOriginalServiceSnapshot.findAll({
        where: { bookingId },
        include: snapshotInclude,
        order: [['id', 'ASC']],
    });

    return rows.map(mapSnapshotToDeclaredService);
}

/**
 * If snapshot rows are missing (create failed, or invoice ran on an old deploy),
 * rebuild customer intent from the earliest unpriced CSS rows.
 */
async function reconstructDeclaredFromOriginalCss(bookingId) {
    const allRows = await customerSelectedService.findAll({
        where: { bookingId },
        order: [['id', 'ASC']],
    });
    if (!allRows.length) return [];

    const intentRows = allRows.filter(looksLikeCustomerIntentRow);
    const source = uniqueFirstByServiceId(
        intentRows.length ? intentRows : allRows
    );
    const serviceIds = [
        ...new Set(
            source
                .map((s) => (s.serviceId != null ? Number(s.serviceId) : null))
                .filter((id) => Number.isFinite(id))
        ),
    ];
    const serviceRows = serviceIds.length
        ? await service.findAll({
              where: { id: serviceIds },
              attributes: ['id', 'name', 'image', 'pricingBasis'],
          })
        : [];
    const serviceById = new Map(
        serviceRows.map((s) => [Number(s.id), s.toJSON ? s.toJSON() : s])
    );

    return source.map((svc) => {
        const plain = typeof svc.toJSON === 'function' ? svc.toJSON() : { ...svc };
        const sid = plain.serviceId != null ? Number(plain.serviceId) : null;
        return {
            id: plain.id,
            bookingId: plain.bookingId,
            serviceId: plain.serviceId,
            categoryId: plain.categoryId,
            subCategoryId: plain.subCategoryId,
            items: plain.items,
            bags: plain.bags,
            noOfBags: plain.bags,
            categoryPrice:
                plain.categoryPrice != null ? String(plain.categoryPrice) : null,
            serviceInstruction: plain.serviceInstruction,
            status: true,
            service: (sid != null && serviceById.get(sid)) || null,
            category: null,
            subCategory: null,
            addOns: [],
            serviceLines: [],
            selectedServicePreferences: [],
            repairItems: [],
        };
    });
}

async function getCustomerDeclaredServices(bookingId) {
    const mapped = await loadMappedSnapshots(bookingId);
    return attachRepairItemsToDeclaredServices(bookingId, mapped);
}

async function snapshotCreatedAt(bookingId) {
    const first = await customerOriginalServiceSnapshot.findOne({
        where: { bookingId },
        order: [['id', 'ASC']],
        attributes: ['createdAt'],
    });
    return first?.createdAt ? new Date(first.createdAt) : null;
}

/**
 * Customer-app snapshot: frozen booking intent only.
 * Does not attach garments the agent added after the snapshot was taken.
 */
async function getFrozenCustomerDeclaredServices(bookingId) {
    let mapped = [];
    try {
        mapped = await loadMappedSnapshots(bookingId);
    } catch (err) {
        console.warn(
            '[getFrozenCustomerDeclaredServices] snapshot load failed:',
            err?.message || err
        );
    }

    if (!mapped.length) {
        try {
            mapped = await reconstructDeclaredFromOriginalCss(bookingId);
        } catch (err) {
            console.warn(
                '[getFrozenCustomerDeclaredServices] reconstruct failed:',
                err?.message || err
            );
            return [];
        }
    }

    const takenAt = await snapshotCreatedAt(bookingId);
    try {
        const hydrated = await attachRepairItemsToDeclaredServices(
            bookingId,
            mapped
        );
        if (!takenAt) return hydrated;
        const cutoff = new Date(takenAt.getTime() + 2 * 60 * 1000);
        return hydrated.map((svc) => {
            const repairs = Array.isArray(svc.repairItems) ? svc.repairItems : [];
            return {
                ...svc,
                repairItems: repairs.filter((item) => {
                    const raw = item?.createdAt;
                    if (!raw) return true;
                    const at = new Date(raw);
                    return !Number.isNaN(at.getTime()) && at <= cutoff;
                }),
            };
        });
    } catch (err) {
        console.warn(
            '[getFrozenCustomerDeclaredServices] repair attach failed:',
            err?.message || err
        );
        return mapped;
    }
}

/**
 * Active invoice / CSS lines the agent added that were not in the customer snapshot.
 */
function getAgentAddedServicesFromLive(declaredServices, liveSelectedServices) {
    const live = Array.isArray(liveSelectedServices) ? liveSelectedServices : [];
    const declaredIds = declaredServiceIdSet(declaredServices);
    if (!declaredIds.size) {
        // Snapshot still missing — show invoiced lines so the customer page is not blank.
        return live;
    }

    return live.filter((row) => {
        const sid = row?.serviceId != null ? Number(row.serviceId) : null;
        if (!Number.isFinite(sid)) return false;
        return !declaredIds.has(sid);
    });
}

/**
 * Repair garments created after the snapshot, including extras on a service
 * the customer already booked.
 */
async function getAgentAddedRepairServices(bookingId) {
    const takenAt = await snapshotCreatedAt(bookingId);
    if (!takenAt) return [];

    const cutoff = new Date(takenAt.getTime() + 2 * 60 * 1000);
    let rows = [];
    try {
        rows = await customerSelectedRepairItem.findAll({
            where: {
                bookingId,
                createdAt: { [Op.gt]: cutoff },
            },
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
    } catch (err) {
        console.warn('[getAgentAddedRepairServices] skipped:', err?.message || err);
        return [];
    }

    const late = normalizeRepairItems(rows);
    if (!late.length) return [];

    const byService = new Map();
    for (const item of late) {
        const sid = Number(item.serviceId);
        if (!Number.isFinite(sid)) continue;
        if (!byService.has(sid)) byService.set(sid, []);
        byService.get(sid).push(item);
    }

    const serviceIds = [...byService.keys()];
    const serviceRows = await service.findAll({
        where: { id: serviceIds },
        attributes: ['id', 'name', 'image', 'pricingBasis'],
    });
    const serviceById = new Map(
        serviceRows.map((s) => [Number(s.id), s.toJSON ? s.toJSON() : s])
    );

    return serviceIds.map((serviceId) => ({
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
        repairItems: byService.get(serviceId) || [],
        addedByAgent: true,
    }));
}

async function getAgentAddedServicesForCustomer(
    bookingId,
    declaredServices,
    liveSelectedServices
) {
    const fromLive = getAgentAddedServicesFromLive(
        declaredServices,
        liveSelectedServices
    );
    const covered = new Set(
        fromLive
            .map((s) => (s?.serviceId != null ? Number(s.serviceId) : null))
            .filter((id) => Number.isFinite(id))
    );

    const lateRepairs = await getAgentAddedRepairServices(bookingId);
    const extraRepairs = lateRepairs.filter((row) => {
        const sid = Number(row.serviceId);
        return Number.isFinite(sid) && !covered.has(sid);
    });

    // If the new service is already in fromLive, attach late repairs onto it.
    const mergedLive = fromLive.map((row) => {
        const sid = Number(row.serviceId);
        const extra = lateRepairs.find((r) => Number(r.serviceId) === sid);
        if (!extra?.repairItems?.length) return row;
        const existing = Array.isArray(row.repairItems) ? row.repairItems : [];
        const seen = new Set(existing.map((i) => i?.id).filter((id) => id != null));
        const add = extra.repairItems.filter((i) => i?.id == null || !seen.has(i.id));
        return { ...row, repairItems: [...existing, ...add], addedByAgent: true };
    });

    return [...mergedLive.map((r) => ({ ...r, addedByAgent: true })), ...extraRepairs];
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
    getFrozenCustomerDeclaredServices,
    getAgentAddedServicesForCustomer,
    getBookingRepairItems,
    attachRepairItemsToDeclaredServices,
};
