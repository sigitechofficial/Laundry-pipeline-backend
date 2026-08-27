'use strict';

const {
    booking,
    customerOriginalServiceSnapshot,
    customerOriginalPreferenceSnapshot,
    customerSelectedService,
    customerSelectedServiceAddOn,
    customerSelectedServiceLine,
    bookingPreference,
    service,
    categories,
    subCategories,
    addOnServices,
    preferenceTypes,
    preferenceValues,
} = require('../../models');

function invoiceHasBeenGenerated(invoiceStatus) {
    return invoiceStatus === 'draft' || invoiceStatus === 'finalized';
}

/**
 * Fetch frozen customer-original selections vs agent invoice lines.
 *
 * Customer side = snapshot only (stable). Falls back to live lines only when
 * no snapshot exists (legacy bookings) — never mirrors into agent invoice.
 *
 * Agent side = live customerSelectedService lines ONLY after invoice draft/finalized.
 * Until then agentInvoice.services is empty.
 *
 * GET /admin/bookings/:bookingId/service-comparison
 */
exports.getServiceComparison = async (bookingId) => {
    const bookingRow = await booking.findByPk(bookingId, {
        attributes: [
            'id',
            'invoiceStatus',
            'invoiceDraftSavedAt',
            'totalItems',
            'totalBags',
            'sameBagForAllServices',
        ],
    });

    const invoiceStatus = bookingRow?.invoiceStatus || 'none';
    const invoiceGenerated = invoiceHasBeenGenerated(invoiceStatus);

    const [originalServices, liveServices] = await Promise.all([
        customerOriginalServiceSnapshot.findAll({
            where: { bookingId },
            include: [
                { model: service, as: 'service', required: false, attributes: ['id', 'name', 'image', 'pricingBasis'] },
                { model: categories, as: 'category', required: false, attributes: ['id', 'name'] },
                { model: subCategories, as: 'subCategory', required: false, attributes: ['id', 'name', 'price', 'barCode', 'unitCount'] },
                {
                    model: customerOriginalPreferenceSnapshot,
                    as: 'preferences',
                    required: false,
                    include: [
                        { model: preferenceTypes, as: 'preferenceType', required: false, attributes: ['id', 'name'] },
                        { model: preferenceValues, as: 'preferenceValue', required: false, attributes: ['id', 'value'] },
                    ],
                },
            ],
            order: [['id', 'ASC']],
        }),

        // Live lines are shared storage — only use as "agent invoice" after invoice exists.
        customerSelectedService.findAll({
            where: { bookingId, status: true },
            include: [
                { model: service, required: false, attributes: ['id', 'name', 'image', 'pricingBasis'] },
                { model: categories, required: false, attributes: ['id', 'name'] },
                { model: subCategories, required: false, attributes: ['id', 'name', 'price', 'barCode', 'unitCount'] },
                {
                    model: customerSelectedServiceAddOn,
                    as: 'addOns',
                    required: false,
                    include: [{ model: addOnServices, as: 'addOnService', required: false, attributes: ['id', 'name', 'price'] }],
                },
                {
                    model: customerSelectedServiceLine,
                    as: 'serviceLines',
                    required: false,
                    separate: true,
                    order: [['lineNum', 'ASC']],
                    attributes: ['id', 'lineNum', 'items'],
                    include: [
                        {
                            model: customerSelectedServiceAddOn,
                            as: 'addOns',
                            required: false,
                            attributes: [
                                'id',
                                'addOnServiceId',
                                'price',
                                'items',
                                'instructions',
                            ],
                            include: [
                                {
                                    model: addOnServices,
                                    as: 'addOnService',
                                    required: false,
                                    attributes: ['id', 'name', 'price'],
                                },
                            ],
                        },
                    ],
                },
                {
                    model: bookingPreference,
                    as: 'selectedServicePreferences',
                    required: false,
                    include: [
                        { model: preferenceTypes, required: false, attributes: ['id', 'name'] },
                        { model: preferenceValues, required: false, attributes: ['id', 'value'] },
                    ],
                },
            ],
            order: [['id', 'ASC']],
        }),
    ]);

    const originalBookingPrefs = await customerOriginalPreferenceSnapshot.findAll({
        where: { bookingId, snapshotServiceId: null },
        include: [
            { model: preferenceTypes, as: 'preferenceType', required: false, attributes: ['id', 'name'] },
            { model: preferenceValues, as: 'preferenceValue', required: false, attributes: ['id', 'value'] },
        ],
    });

    const snapshotAvailable = originalServices.length > 0;
    const liveJson = liveServices.map((s) => s.toJSON());

    // How the customer packed the order at booking time: one shared bag for all
    // services (all-in-one) vs one bag per service. Totals are the customer's
    // declared bag/item counts (per-service bags live on each service row's `bags`).
    const packing = {
        sameBagForAllServices: bookingRow?.sameBagForAllServices !== false,
        totalItems: bookingRow?.totalItems ?? null,
        totalBags: bookingRow?.totalBags ?? null,
    };

    const customerOriginal = snapshotAvailable
        ? {
              services: originalServices.map((s) => s.toJSON()),
              bookingPreferences: originalBookingPrefs.map((p) => p.toJSON()),
              packing,
          }
        : {
              // Legacy: no snapshot yet — show current lines as customer selection only.
              services: liveJson,
              bookingPreferences: [],
              packing,
          };

    const agentInvoice = {
        services: invoiceGenerated ? liveJson : [],
    };

    return {
        snapshotAvailable,
        fallbackToLive: !snapshotAvailable,
        invoiceStatus,
        invoiceGenerated,
        invoiceDraftSavedAt: bookingRow?.invoiceDraftSavedAt || null,
        customerOriginal,
        agentInvoice,
    };
};
