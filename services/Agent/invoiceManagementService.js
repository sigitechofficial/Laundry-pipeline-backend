require("dotenv").config();
const momentTz = require("moment-timezone");
const {
    booking,
    addressDb,
    bookingStatus,
    countries,
    cities,
    customerSelectedService,
    service,
    servicePreferences,
    categories,
    subCategories,
    zone,
    users,
    billingDetails,
    tip,
    customerSelectedServiceAddOn,
    addOnServices,
    bookingPreference,
    preferenceTypes,
    preferenceValues,
    preferencesServiceName,
} = require("../../models");
const { Op } = require("sequelize");
const {
    UnauthorizedError,
    NotFoundError,
    ValidationError,
} = require("../../middlewares/universalErrorHandler");
const {
    getLineQuantity,
    getUnitCategoryCharge,
    serviceLineHasAddOnPayload,
    replaceAddOnsForServiceLine,
    sumActiveBookingServicesSubtotal,
} = require("../../utils/invoiceLineTotals");

const AGENT_BUSINESS_TIME_ZONE = "Europe/London";
const INVOICE_STAGE_STATUS_ID = 8;

function agentWallClockDateTime(timeZone, clientTimeZone) {
    const candidate = timeZone || clientTimeZone;
    const tz =
        candidate && typeof candidate === "string" && momentTz.tz.zone(candidate.trim())
            ? candidate.trim()
            : AGENT_BUSINESS_TIME_ZONE;
    const m = momentTz.tz(tz);
    return {
        date: m.format("YYYY-MM-DD"),
        time: m.format("HH:mm:ss"),
    };
}

/**
 * Agent Invoice Management Service
 * Handles agent invoice draft and related business logic
 */
class AgentInvoiceManagementService {
    async assertAgentBookingAccess(agentId, bookingId) {
        const agentShop = await addressDb.findOne({
            where: { userId: agentId },
        });

        if (!agentShop) {
            throw new NotFoundError("Address not found for agent");
        }

        const bookingRow = await booking.findByPk(bookingId);

        if (!bookingRow) {
            throw new NotFoundError("Booking not found");
        }

        if (bookingRow.laundryShopId !== agentShop.id) {
            throw new UnauthorizedError("You do not have access to this booking");
        }

        return { agentShop, bookingRow };
    }

    buildInvoiceDraftIncludes(bookingId) {
        return [
            {
                model: zone,
                attributes: ["id", "name", "zoneMinimumAmount", "serviceCharge"],
            },
            {
                model: users,
                as: "customer",
                attributes: ["firstName", "lastName", "email", "phoneNum", "image", "stripeCustomerId"],
            },
            {
                model: addressDb,
                as: "pickupAddress",
                attributes: ["title", "streetAddress", "district", "province", "postalcode", "addressType"],
                include: [
                    { model: countries, attributes: ["name", "shortName"] },
                    { model: cities, attributes: ["id", "name"] },
                ],
            },
            {
                model: addressDb,
                as: "dropOffAddress",
                attributes: ["title", "streetAddress", "district", "province", "postalcode", "addressType"],
                include: [
                    { model: countries, attributes: ["name", "shortName"] },
                    { model: cities, attributes: ["id", "name"] },
                ],
            },
            {
                model: customerSelectedService,
                required: false,
                include: [
                    {
                        model: service,
                        required: false,
                        attributes: { exclude: ["createdAt", "updatedAt", "timeRequired"] },
                        include: [
                            {
                                model: servicePreferences,
                                required: false,
                                where: { bookingId },
                                attributes: [
                                    "id",
                                    "type",
                                    "chooseTemperature",
                                    "numberOfBags",
                                    "preferencesServiceNameId",
                                    "serviceId",
                                ],
                                include: [
                                    {
                                        model: preferencesServiceName,
                                        attributes: ["id", "title"],
                                    },
                                ],
                            },
                        ],
                    },
                    {
                        model: categories,
                        required: false,
                        attributes: { exclude: ["createdAt", "updatedAt", "serviceId"] },
                    },
                    {
                        model: subCategories,
                        required: false,
                        attributes: [
                            "id",
                            "name",
                            "price",
                            "status",
                            "description",
                            "barCode",
                            "weightKg",
                            "unitCount",
                        ],
                    },
                    {
                        model: customerSelectedServiceAddOn,
                        as: "addOns",
                        required: false,
                        attributes: ["id", "addOnServiceId", "price", "items"],
                        include: [
                            {
                                model: addOnServices,
                                as: "addOnService",
                                attributes: ["id", "name", "price"],
                            },
                        ],
                    },
                    {
                        model: bookingPreference,
                        as: "selectedServicePreferences",
                        required: false,
                        attributes: [
                            "id",
                            "customerSelectedServiceId",
                            "preferenceTypeId",
                            "preferenceValueId",
                            "parentPreferenceValueId",
                            "preferenceInstruction",
                        ],
                        include: [
                            { model: preferenceTypes, attributes: ["id", "name"] },
                            { model: preferenceValues, attributes: ["id", "value"] },
                        ],
                    },
                ],
                attributes: [
                    "id",
                    "date",
                    "time",
                    "categoryPrice",
                    "bookingId",
                    "categoryId",
                    "serviceId",
                    "subCategoryId",
                    "items",
                    "bags",
                    "serviceInstruction",
                    "status",
                ],
            },
            {
                model: billingDetails,
                as: "billingDetail",
                required: false,
                attributes: [
                    "upfrontAmount",
                    "discount",
                    "total",
                    "zoneAdminCommission",
                    "serviceCharge",
                    "categoryCharge",
                    "paymentStatus",
                ],
            },
            {
                model: tip,
                as: "tips",
                required: false,
                attributes: ["id", "amount"],
            },
            {
                model: bookingStatus,
                attributes: ["id", "title", "description"],
            },
        ];
    }

    async persistInvoiceServiceLines({
        bookingId,
        services,
        currentDate,
        currentTime,
    }) {
        if (!Array.isArray(services) || services.length === 0) {
            return;
        }

        for (const serviceLine of services) {
            const unitPrice = getUnitCategoryCharge(serviceLine.categoryCharge);
            const qty = getLineQuantity(serviceLine.items);

            const existingRecords = await customerSelectedService.findAll({
                where: {
                    bookingId,
                    serviceId: serviceLine.serviceId,
                    subCategoryId: { [Op.is]: null },
                    categoryId: { [Op.is]: null },
                },
            });

            let matched = existingRecords.find(
                (row) => row.subCategoryId === serviceLine.subCategoryId
            );

            if (!matched) {
                matched = existingRecords.find((row) => row.subCategoryId === null);
            }

            let selectedServiceRow;
            if (matched) {
                await matched.update({
                    categoryId: serviceLine.categoryId,
                    categoryPrice: unitPrice,
                    subCategoryId: serviceLine.subCategoryId,
                    items: qty,
                    date: currentDate,
                    time: currentTime,
                    status: true,
                });
                selectedServiceRow = matched;
            } else {
                selectedServiceRow = await customerSelectedService.create({
                    date: currentDate,
                    time: currentTime,
                    bookingId,
                    serviceId: serviceLine.serviceId,
                    categoryId: serviceLine.categoryId,
                    categoryPrice: unitPrice,
                    subCategoryId: serviceLine.subCategoryId,
                    items: qty,
                    status: true,
                });
            }

            if (serviceLineHasAddOnPayload(serviceLine)) {
                await replaceAddOnsForServiceLine(
                    selectedServiceRow.id,
                    serviceLine,
                    addOnServices
                );
            }
        }
    }

    async calculateInvoiceTotals(bookingRow, bookingId, serviceCharge, zoneMinimumAmount) {
        const zoneData = bookingRow.zone;
        if (!zoneData) {
            throw new NotFoundError("Zone information not found for this booking");
        }

        const servicesSubtotal = await sumActiveBookingServicesSubtotal(bookingId);
        const parsedServiceCharge = parseFloat(serviceCharge) || 0;
        const parsedZoneMinimum = parseFloat(zoneMinimumAmount) || 0;

        const tipAmount =
            bookingRow.tips && bookingRow.tips.length > 0
                ? bookingRow.tips.reduce((sum, t) => sum + parseFloat(t.amount || 0), 0)
                : 0;

        let subTotal = servicesSubtotal + parsedServiceCharge + parsedZoneMinimum + tipAmount;
        let total = subTotal - parsedZoneMinimum;

        const zoneAdminCommission = parseFloat(zoneData.zoneAdminComission || 20);
        const zoneAdminCommissionAmount = (subTotal * zoneAdminCommission) / 100;

        const existingBilling = await billingDetails.findOne({ where: { bookingId } });
        const existingDiscount = parseFloat(existingBilling?.discount || 0);

        total = parseFloat(total.toFixed(2));
        subTotal = parseFloat(subTotal.toFixed(2));
        const finalZoneAdminCommissionAmount = parseFloat(zoneAdminCommissionAmount.toFixed(2));
        const discountedTotal = parseFloat(Math.max(0, total - existingDiscount).toFixed(2));

        if (Number.isNaN(discountedTotal)) {
            throw new ValidationError("Calculated total is invalid. Please check your input values.");
        }

        return {
            servicesSubtotal,
            subTotal,
            total: discountedTotal,
            existingDiscount,
            finalZoneAdminCommissionAmount,
            parsedServiceCharge,
            parsedZoneMinimum,
        };
    }

    /**
     * Save invoice as draft — no notifications, no status change, no email.
     */
    async saveInvoiceDraft(data) {
        const {
            agentId,
            bookingId,
            services = [],
            serviceCharge,
            zoneMinimumAmount,
            timeZone,
            clientTimeZone,
        } = data;

        if (!bookingId) {
            throw new ValidationError("bookingId is required");
        }

        if (!Array.isArray(services)) {
            throw new ValidationError("services must be an array");
        }

        const { bookingRow } = await this.assertAgentBookingAccess(agentId, bookingId);

        if (bookingRow.bookingStatusId !== INVOICE_STAGE_STATUS_ID) {
            throw new ValidationError("Invoice draft can only be saved while booking is at the laundry shop");
        }

        const { date: currentDate, time: currentTime } = agentWallClockDateTime(
            timeZone,
            clientTimeZone
        );

        const bookingWithZone = await booking.findByPk(bookingId, {
            include: [
                {
                    model: zone,
                    attributes: ["id", "name", "zoneAdminComission"],
                },
                {
                    model: tip,
                    as: "tips",
                    attributes: ["id", "amount"],
                    required: false,
                },
            ],
        });

        await this.persistInvoiceServiceLines({
            bookingId,
            services,
            currentDate,
            currentTime,
        });

        const totals = await this.calculateInvoiceTotals(
            bookingWithZone,
            bookingId,
            serviceCharge,
            zoneMinimumAmount
        );

        await billingDetails.update(
            {
                total: totals.total,
                discount: totals.existingDiscount,
                zoneAdminCommission: totals.finalZoneAdminCommissionAmount,
                serviceCharge: totals.parsedServiceCharge,
            },
            { where: { bookingId } }
        );

        const draftSavedAt = new Date();

        await booking.update(
            {
                orderAmount: totals.total,
                subTotal: totals.subTotal,
                invoiceStatus: "draft",
                invoiceDraftSavedAt: draftSavedAt,
            },
            { where: { id: bookingId } }
        );

        return {
            bookingId,
            invoiceStatus: "draft",
            draftSavedAt,
            servicesCount: services.length,
            servicesSubtotal: totals.servicesSubtotal,
            subTotal: totals.subTotal,
            total: totals.total,
        };
    }

    /**
     * Get saved invoice draft for agent's booking.
     */
    async getInvoiceDraft(data) {
        const { agentId, bookingId } = data;

        if (!bookingId) {
            throw new ValidationError("bookingId is required");
        }

        const { bookingRow } = await this.assertAgentBookingAccess(agentId, bookingId);

        if (bookingRow.invoiceStatus !== "draft") {
            throw new NotFoundError("No draft found for this booking");
        }

        const draftBooking = await booking.findOne({
            where: { id: bookingId },
            include: this.buildInvoiceDraftIncludes(bookingId),
            attributes: { exclude: ["categoryId", "serviceId", "subCategoryId"] },
        });

        if (!draftBooking) {
            throw new NotFoundError("No draft found for this booking");
        }

        const bookingData = draftBooking.toJSON();
        const seenServiceIds = new Set();

        bookingData.customerSelectedServices = (bookingData.customerSelectedServices || []).map(
            (item) => {
                if (!item.service) return item;

                const serviceId = item.service.id;
                if (seenServiceIds.has(serviceId)) {
                    return {
                        ...item,
                        service: {
                            ...item.service,
                            servicePreferences: [],
                        },
                    };
                }

                seenServiceIds.add(serviceId);
                return item;
            }
        );

        const servicesSubtotal = await sumActiveBookingServicesSubtotal(bookingId);

        return {
            bookingId,
            invoiceStatus: bookingData.invoiceStatus,
            draftSavedAt: bookingData.invoiceDraftSavedAt,
            invoiceDetails: bookingData,
            servicesSubtotal,
            subTotal: bookingData.subTotal,
            total: bookingData.orderAmount,
        };
    }

    /**
     * Get Invoice Detail Tab
     * @param {number} agentId - Agent ID
     * @returns {Object} Invoice details data
     */
    async invoiceDetailTab(agentId) {
        const addressFound = await addressDb.findOne({
            where: { userId: agentId },
        });

        if (!addressFound) {
            throw new NotFoundError("Address not found for agent");
        }

        const results = {};

        results.All = await booking.findAll({
            where: {
                laundryShopId: addressFound.id,
                bookingStatusId: INVOICE_STAGE_STATUS_ID,
            },
            attributes: [
                "id",
                "ordertrackId",
                "collectionTimeFrom",
                "collectiontimeTo",
                "collectionDate",
                "deliveryTimeFrom",
                "deliveryTimeTo",
                "deliveryDate",
                "driverInstructionOptions",
                "driverInstructionOptions1",
                "bookingStatusId",
                "invoiceStatus",
                "invoiceDraftSavedAt",
            ],
            include: [
                {
                    model: bookingStatus,
                    attributes: ["id", "title", "description"],
                },
                {
                    model: addressDb,
                    as: "laundryShop",
                    attributes: [
                        "streetAddress",
                        "district",
                        "province",
                        "addressType",
                        "lat",
                        "lng",
                        "postalcode",
                    ],
                    include: [
                        { model: countries, attributes: ["id", "name", "shortName"] },
                        { model: cities, attributes: ["id", "name"] },
                    ],
                },
                {
                    model: users,
                    as: "customer",
                    attributes: ["firstName", "lastName", "email", "phoneNum", "image"],
                },
            ],
        });

        return { results };
    }
}

module.exports = new AgentInvoiceManagementService();
