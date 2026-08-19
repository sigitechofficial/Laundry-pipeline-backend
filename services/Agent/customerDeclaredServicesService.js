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
        const sid = resolvedServiceId(row);
        const key = sid != null ? String(sid) : `row-${row.id}`;
        if (!firstByService.has(key)) firstByService.set(key, row);
    }
    return [...firstByService.values()];
}

function firstPositiveInt(...values) {
    for (const value of values) {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
    return null;
}

function resolvedServiceId(row) {
    if (!row || typeof row !== 'object') return null;
    const n = Number(row.serviceId ?? row.service?.id);
    return Number.isFinite(n) ? n : null;
}

function snapshotItems(row) {
    return firstPositiveInt(
        row?.items,
        row?.noOfItems,
        row?.totalItems,
        row?.quantity,
        row?.qty
    );
}

function snapshotBags(row) {
    return firstPositiveInt(row?.bags, row?.noOfBags, row?.numberOfBags);
}

/** Customer booking rows are service-level. Invoice lines have a subcategory + price. */
function looksLikeCustomerIntentRow(row) {
    return row.subCategoryId == null;
}

function declaredServiceIdSet(declaredServices) {
    return new Set(
        (Array.isArray(declaredServices) ? declaredServices : [])
            .map((s) => resolvedServiceId(s))
            .filter((id) => id != null)
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
            serviceId: resolvedServiceId(svc),
            categoryId: svc.categoryId ?? null,
            subCategoryId: svc.subCategoryId ?? null,
            items: snapshotItems(svc),
            bags: snapshotBags(svc),
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
    const bags = snapshotBags(plain);
    const items = snapshotItems(plain);
    return {
        id: plain.id,
        bookingId: plain.bookingId,
        serviceId: resolvedServiceId(plain) ?? plain.serviceId ?? null,
        categoryId: plain.categoryId,
        subCategoryId: plain.subCategoryId,
        items,
        bags,
        noOfBags: bags,
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
        return attachLeftoverRepairsToAlteration(bookingId, list);
    }

    if (orphanServiceIds.length === 0) {
        return attachLeftoverRepairsToAlteration(bookingId, list);
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

    return attachLeftoverRepairsToAlteration(
        bookingId,
        [...list, ...hydratedPlaceholders]
    );
}

function isAlterationDeclaredRow(row) {
    const name = String(row?.service?.name || '').toLowerCase();
    return name.includes('alter') || name.includes('repair');
}

/** Last-resort: garments with a missing/mismatched serviceId still land on Alteration. */
async function attachLeftoverRepairsToAlteration(bookingId, declaredServices) {
    const list = Array.isArray(declaredServices) ? declaredServices : [];
    if (!list.length) return list;

    let allRepair = [];
    try {
        allRepair = await getBookingRepairItems(bookingId);
    } catch (err) {
        console.warn(
            '[attachLeftoverRepairsToAlteration] skipped:',
            err?.message || err
        );
        return list;
    }
    if (!allRepair.length) return list;

    const assigned = new Set();
    for (const svc of list) {
        for (const item of svc.repairItems || []) {
            if (item?.id != null) assigned.add(Number(item.id));
        }
    }
    const leftovers = allRepair.filter(
        (item) => item?.id == null || !assigned.has(Number(item.id))
    );
    if (!leftovers.length) return list;

    return list.map((svc) => {
        if (Array.isArray(svc.repairItems) && svc.repairItems.length) return svc;
        if (!isAlterationDeclaredRow(svc)) return svc;
        const sid = Number(svc.serviceId);
        const forThis = leftovers.filter((item) => {
            const repairSid = Number(item.serviceId);
            return !Number.isFinite(repairSid) || !Number.isFinite(sid) || repairSid === sid;
        });
        if (!forThis.length) return svc;
        return { ...svc, repairItems: forThis };
    });
}

/**
 * Ensure snapshot exists, then return agent-app-friendly declared services
 * including repair garments / options / images.
 */
function hasSnapshotCounts(row) {
    return firstPositiveInt(row?.items) != null || firstPositiveInt(row?.bags, row?.noOfBags) != null;
}

function mergeMissingCounts(primary, secondary) {
    if (!Array.isArray(primary) || !primary.length || !Array.isArray(secondary) || !secondary.length) {
        return primary;
    }
    const byService = new Map();
    for (const row of secondary) {
        const sid = resolvedServiceId(row);
        if (sid == null || byService.has(sid)) continue;
        byService.set(sid, row);
    }
    return primary.map((row) => {
        if (hasSnapshotCounts(row)) return row;
        const match = byService.get(resolvedServiceId(row));
        if (!match || !hasSnapshotCounts(match)) return row;
        return {
            ...row,
            items: match.items ?? row.items,
            bags: match.bags ?? row.bags,
            noOfBags: match.noOfBags ?? match.bags ?? row.noOfBags,
        };
    });
}

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
        const sid = resolvedServiceId(plain);
        const bags = snapshotBags(plain);
        const items = snapshotItems(plain);
        return {
            id: plain.id,
            bookingId: plain.bookingId,
            serviceId: sid,
            categoryId: plain.categoryId,
            subCategoryId: plain.subCategoryId,
            items,
            bags,
            noOfBags: bags,
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

async function loadDeclaredServicesWithCounts(bookingId) {
    let mapped = [];
    try {
        mapped = await loadMappedSnapshots(bookingId);
    } catch (err) {
        console.warn(
            '[loadDeclaredServicesWithCounts] snapshot load failed:',
            err?.message || err
        );
    }

    if (!mapped.length || !mapped.some(hasSnapshotCounts)) {
        try {
            const reconstructed = await reconstructDeclaredFromOriginalCss(bookingId);
            if (!mapped.length) {
                mapped = reconstructed;
            } else {
                mapped = mergeMissingCounts(mapped, reconstructed);
            }
        } catch (err) {
            console.warn(
                '[loadDeclaredServicesWithCounts] reconstruct failed:',
                err?.message || err
            );
        }
    }
    return mapped;
}

async function getCustomerDeclaredServices(bookingId) {
    const mapped = await loadDeclaredServicesWithCounts(bookingId);
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
        mapped = await loadDeclaredServicesWithCounts(bookingId);
    } catch (err) {
        console.warn(
            '[getFrozenCustomerDeclaredServices] snapshot load failed:',
            err?.message || err
        );
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
 * Invoice lines are priced / itemized (subcategory, price, add-ons).
 * Customer snapshot rows are service-level and typically have none of these.
 */
function looksLikeInvoiceLine(row) {
    if (!row || typeof row !== 'object') return false;
    if (row.subCategoryId != null) return true;
    const price = Number(row.categoryPrice ?? row.categoryprice ?? 0);
    if (Number.isFinite(price) && price > 0) return true;
    if (Array.isArray(row.serviceLines) && row.serviceLines.length) return true;
    if (Array.isArray(row.addOns) && row.addOns.length) return true;
    return false;
}

/**
 * Invoice / CSS lines the collector added.
 * Same serviceId as the snapshot still counts when the agent itemized garments.
 */
function getAgentAddedServicesFromLive(declaredServices, liveSelectedServices) {
    const live = Array.isArray(liveSelectedServices) ? liveSelectedServices : [];
    const declaredIds = declaredServiceIdSet(declaredServices);
    if (!declaredIds.size) {
        // Snapshot still missing — show invoiced lines so the customer page is not blank.
        return live;
    }

    return live.filter((row) => {
        if (looksLikeInvoiceLine(row)) return true;
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
