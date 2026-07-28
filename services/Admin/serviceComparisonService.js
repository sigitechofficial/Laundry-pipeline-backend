'use strict';

const {
    customerOriginalServiceSnapshot,
    customerOriginalPreferenceSnapshot,
    customerSelectedService,
    customerSelectedServiceAddOn,
    bookingPreference,
    service,
    categories,
    subCategories,
    addOnServices,
    preferenceTypes,
    preferenceValues,
} = require('../../models');

/**
 * Fetch both the frozen customer-original selections and the current agent invoice
 * for a given booking, so admin can compare side-by-side.
 *
 * GET /admin/bookings/:bookingId/service-comparison
 */
exports.getServiceComparison = async (bookingId) => {
    const [originalServices, agentServices] = await Promise.all([
        // ── Customer original (snapshot) ──────────────────────────────────────
        customerOriginalServiceSnapshot.findAll({
            where: { bookingId },
            include: [
                { model: service,      as: 'service',     required: false, attributes: ['id', 'name', 'image', 'pricingBasis'] },
                { model: categories,   as: 'category',    required: false, attributes: ['id', 'name'] },
                { model: subCategories, as: 'subCategory', required: false, attributes: ['id', 'name', 'price', 'barCode', 'unitCount'] },
                {
                    model: customerOriginalPreferenceSnapshot,
                    as: 'preferences',
                    required: false,
                    include: [
                        { model: preferenceTypes,  as: 'preferenceType',  required: false, attributes: ['id', 'name'] },
                        { model: preferenceValues, as: 'preferenceValue', required: false, attributes: ['id', 'value'] },
                    ]
                }
            ],
            order: [['id', 'ASC']]
        }),

        // ── Agent current invoice (active lines only) ─────────────────────────
        customerSelectedService.findAll({
            where: { bookingId, status: true },
            include: [
                { model: service,       required: false, attributes: ['id', 'name', 'image', 'pricingBasis'] },
                { model: categories,    required: false, attributes: ['id', 'name'] },
                { model: subCategories, required: false, attributes: ['id', 'name', 'price', 'barCode', 'unitCount'] },
                {
                    model: customerSelectedServiceAddOn,
                    as: 'addOns',
                    required: false,
                    include: [{ model: addOnServices, as: 'addOnService', required: false, attributes: ['id', 'name', 'price'] }]
                },
                {
                    model: bookingPreference,
                    as: 'selectedServicePreferences',
                    required: false,
                    include: [
                        { model: preferenceTypes,  required: false, attributes: ['id', 'name'] },
                        { model: preferenceValues, required: false, attributes: ['id', 'value'] },
                    ]
                }
            ],
            order: [['id', 'ASC']]
        }),
    ]);

    // Booking-level original preferences (not tied to a service snapshot)
    const originalBookingPrefs = await customerOriginalPreferenceSnapshot.findAll({
        where: { bookingId, snapshotServiceId: null },
        include: [
            { model: preferenceTypes,  as: 'preferenceType',  required: false, attributes: ['id', 'name'] },
            { model: preferenceValues, as: 'preferenceValue', required: false, attributes: ['id', 'value'] },
        ]
    });

    return {
        snapshotAvailable: originalServices.length > 0,
        customerOriginal: {
            services:            originalServices.map((s) => s.toJSON()),
            bookingPreferences:  originalBookingPrefs.map((p) => p.toJSON()),
        },
        agentInvoice: {
            services: agentServices.map((s) => s.toJSON()),
        },
    };
};
