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
    customerSelectedServiceLine,
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
const { redactCustomerPhone } = require("../../utils/maskPhone");
const {
    assertBookingNotCancelledForAgent,
} = require("../../utils/assertBookingNotCancelledForAgent");
const {
    getLineQuantity,
    getUnitCategoryCharge,
    replaceServiceLinesForSelectedService,
    validateServiceLineItems,
    sumActiveBookingServicesSubtotal,
    computePhysicalTotalItems,
} = require("../../utils/invoiceLineTotals");
const { buildPaymentSummary, buildPaymentSummaryForBooking, enrichPaymentSummary, resolveBalancePaymentMethod } = require("../../utils/invoicePaymentSummary");
const {
    resolveAgentCommissionBase,
    calculateAgentCommissionAmounts,
} = require("../../utils/agentCommission");
const {
    ensureRateSnapshotOnBooking,
    RATE_SNAPSHOT_ATTRIBUTES,
    ZONE_COMMERCIAL_ATTRIBUTES,
} = require("../../utils/bookingRateSnapshot");
const {
    ensureCustomerDeclaredSnapshot,
    getCustomerDeclaredServices,
    getBookingRepairItems,
} = require("./customerDeclaredServicesService");
const dbModels = require("../../models");
const {
    buildRepairItemsInclude,
    hydrateRepairItemsForBooking,
} = require("../../utils/repairBookingInclude");

const AGENT_BUSINESS_TIME_ZONE = "Europe/London";
const INVOICE_STAGE_STATUS_ID = 8;
const INVOICE_EDITABLE_STATUS_IDS = [8, 9];

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

        assertBookingNotCancelledForAgent(bookingRow);

        if (bookingRow.laundryShopId !== agentShop.id) {
            throw new UnauthorizedError("You do not have access to this booking");
        }

        return { agentShop, bookingRow };
    }

    assertInvoiceEditableBookingStatus(bookingRow) {
        if (!INVOICE_EDITABLE_STATUS_IDS.includes(bookingRow.bookingStatusId)) {
            throw new ValidationError(
                "Invoice can only be edited while booking is at the laundry shop or invoice stage"
            );
        }
    }

    buildInvoiceDraftIncludes(bookingId) {
        return [
            {
                model: zone,
                    attributes: [
                        "id",
                        "name",
                        "zoneMinimumAmount",
                        "serviceCharge",
                        "zoneAdminComission",
                        "agentCommissionPercent",
                    ],
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
                        attributes: ["id", "addOnServiceId", "price", "items", "instructions"],
                        include: [
                            {
                                model: addOnServices,
                                as: "addOnService",
                                attributes: ["id", "name", "price"],
                            },
                        ],
                    },
                    {
                        model: customerSelectedServiceLine,
                        as: "serviceLines",
                        required: false,
                        separate: true,
                        order: [["lineNum", "ASC"]],
                        attributes: ["id", "lineNum", "items"],
                        include: [
                            {
                                model: customerSelectedServiceAddOn,
                                as: "addOns",
                                required: false,
                                attributes: ["id", "addOnServiceId", "price", "items", "instructions"],
                                include: [
                                    {
                                        model: addOnServices,
                                        as: "addOnService",
                                        attributes: ["id", "name", "price"],
                                    },
                                ],
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
                    buildRepairItemsInclude(dbModels),
                ].filter(Boolean),
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
                    "agentEarning",
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

    async finalizeInvoiceDraftTotals({
        bookingId,
        serviceCharge,
        zoneMinimumAmount,
        preserveInvoiceStatus = false,
    }) {
        const bookingWithZone = await booking.findByPk(bookingId, {
            include: [
                {
                    model: zone,
                    attributes: [
                        "id",
                        "name",
                        "zoneAdminComission",
                        "agentCommissionPercent",
                        "zoneMinimumAmount",
                        "serviceCharge",
                    ],
                },
                {
                    model: tip,
                    as: "tips",
                    attributes: ["id", "amount"],
                    required: false,
                },
            ],
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
                agentEarning: totals.finalAgentEarningAmount,
                serviceCharge: totals.parsedServiceCharge,
            },
            { where: { bookingId } }
        );

        const draftSavedAt = new Date();
        const bookingUpdate = {
            orderAmount: totals.subTotal,
            subTotal: totals.subTotal,
        };

        if (!preserveInvoiceStatus) {
            bookingUpdate.invoiceStatus = "draft";
            bookingUpdate.invoiceDraftSavedAt = draftSavedAt;
        }

        await booking.update(bookingUpdate, { where: { id: bookingId } });

        return {
            totals,
            draftSavedAt: preserveInvoiceStatus ? null : draftSavedAt,
            invoiceStatus: preserveInvoiceStatus
                ? bookingWithZone.invoiceStatus || "finalized"
                : "draft",
        };
    }

    /**
     * Resolve an existing invoice line for sync (by id, or serviceId + category + subCategory).
     */
    async findExistingInvoiceLineForSync(bookingId, serviceLine) {
        if (serviceLine.id) {
            return customerSelectedService.findOne({
                where: {
                    id: serviceLine.id,
                    bookingId,
                },
            });
        }

        if (!serviceLine.serviceId) {
            return null;
        }

        const where = {
            bookingId,
            serviceId: serviceLine.serviceId,
            status: true,
        };

        if (serviceLine.categoryId != null && serviceLine.categoryId !== "") {
            where.categoryId = serviceLine.categoryId;
        }

        if (serviceLine.subCategoryId != null && serviceLine.subCategoryId !== "") {
            where.subCategoryId = serviceLine.subCategoryId;
        } else {
            where.subCategoryId = { [Op.is]: null };
        }

        return customerSelectedService.findOne({
            where,
            order: [["id", "DESC"]],
        });
    }

    /**
     * Sync draft lines — update by id or natural key, create new, deactivate removed.
     */
    async syncInvoiceDraftServiceLines({
        bookingId,
        services,
        currentDate,
        currentTime,
    }) {
        // Freeze customer booking intent BEFORE agent lines replace live CSS.
        await ensureCustomerDeclaredSnapshot(bookingId);

        const keptActiveIds = [];

        for (const serviceLine of services) {
            const unitPrice = getUnitCategoryCharge(serviceLine.categoryCharge);
            const qty = getLineQuantity(serviceLine.items);
            const lineActive = serviceLine.status !== false;

            // Enforce: sum(serviceLines[].items) === service.items (when split given).
            const lineCheck = validateServiceLineItems(serviceLine);
            if (!lineCheck.valid) {
                throw new ValidationError(
                    `Service lines total (${lineCheck.actual}) must equal item quantity (${lineCheck.expected})`
                );
            }

            let selectedServiceRow = await this.findExistingInvoiceLineForSync(
                bookingId,
                serviceLine
            );

            if (serviceLine.id && !selectedServiceRow) {
                throw new ValidationError(
                    `Service line ${serviceLine.id} not found for this booking`
                );
            }

            if (selectedServiceRow) {
                await selectedServiceRow.update({
                    serviceId: serviceLine.serviceId,
                    categoryId: serviceLine.categoryId,
                    categoryPrice: unitPrice,
                    subCategoryId: serviceLine.subCategoryId ?? null,
                    items: qty,
                    date: currentDate,
                    time: currentTime,
                    status: lineActive,
                });
            } else {
                selectedServiceRow = await customerSelectedService.create({
                    date: currentDate,
                    time: currentTime,
                    bookingId,
                    serviceId: serviceLine.serviceId,
                    categoryId: serviceLine.categoryId,
                    categoryPrice: unitPrice,
                    subCategoryId: serviceLine.subCategoryId ?? null,
                    items: qty,
                    status: lineActive,
                });
            }

            if (lineActive) {
                keptActiveIds.push(selectedServiceRow.id);
            }

            // Always rebuild lines (split or single) so add-ons/instructions persist.
            await replaceServiceLinesForSelectedService(
                selectedServiceRow,
                serviceLine,
                addOnServices
            );
        }

        // Agent invoice lines only — customer intent lives in original snapshots.
        const deactivateWhere = {
            bookingId,
            status: true,
        };

        if (keptActiveIds.length > 0) {
            deactivateWhere.id = { [Op.notIn]: keptActiveIds };
        }

        await customerSelectedService.update(
            { status: false },
            { where: deactivateWhere }
        );

        // Keep booking.totalItems = physical pieces (not priced repair-option Σ).
        await this.updateBookingTotalItems(bookingId);

        return keptActiveIds;
    }

    /**
     * Recompute booking.totalItems as physical garments/pieces.
     * Repair option lines share the same garments — count them once.
     * @param {number|string} bookingId
     */
    async updateBookingTotalItems(bookingId) {
        const rows = await customerSelectedService.findAll({
            where: { bookingId, status: true },
            attributes: ["id", "items", "serviceId", "status"],
            include: [
                {
                    model: subCategories,
                    required: false,
                    attributes: ["id", "unitCount"],
                },
                {
                    model: service,
                    required: false,
                    attributes: ["id", "name"],
                },
            ],
        });
        let repairItems = [];
        let declared = [];
        try {
            repairItems = await getBookingRepairItems(bookingId);
        } catch (err) {
            console.warn(
                `[updateBookingTotalItems] repair items skipped:`,
                err?.message || err
            );
        }
        try {
            declared = await getCustomerDeclaredServices(bookingId);
        } catch (err) {
            console.warn(
                `[updateBookingTotalItems] declared services skipped:`,
                err?.message || err
            );
        }

        const totalItems = computePhysicalTotalItems({
            customerSelectedServices: rows.map((row) =>
                typeof row.get === "function" ? row.get({ plain: true }) : row
            ),
            customerDeclaredServices: declared,
            repairItems,
        });

        await booking.update({ totalItems }, { where: { id: bookingId } });
        return totalItems;
    }

    async calculateInvoiceTotals(bookingRow, bookingId, _serviceCharge, _zoneMinimumAmount) {
        const terms = await ensureRateSnapshotOnBooking(bookingRow);
        if (!bookingRow?.zone && !terms.locked) {
            throw new NotFoundError("Zone information not found for this booking");
        }

        const servicesSubtotal = await sumActiveBookingServicesSubtotal(bookingId);
        const parsedServiceCharge = terms.serviceCharge;
        const parsedZoneMinimum = terms.zoneMinimumAmount;
        const agentCommissionPercent = terms.agentCommissionPercent;

        const tipAmount =
            bookingRow.tips && bookingRow.tips.length > 0
                ? bookingRow.tips.reduce((sum, t) => sum + parseFloat(t.amount || 0), 0)
                : 0;

        const existingBilling = await billingDetails.findOne({ where: { bookingId } });
        const existingDiscount = parseFloat(existingBilling?.discount || 0);

        const paymentSummary = enrichPaymentSummary(
            buildPaymentSummaryForBooking(bookingRow.paymentType, {
                laundrySubtotal: servicesSubtotal,
                serviceFee: parsedServiceCharge,
                minimumOrderPayment: parsedZoneMinimum,
                driverTip: tipAmount,
                discount: existingDiscount,
            }),
            {
                paymentType: bookingRow.paymentType,
                balancePaymentMethod: bookingRow.balancePaymentMethod,
                balanceCollectedVia: bookingRow.balanceCollectedVia,
                billingPaymentStatus: existingBilling?.paymentStatus,
                paymentConfirmed: Boolean(bookingRow.paymentConfirmed),
            }
        );

        const totalOrderAmount = paymentSummary.orderSummary.totalOrderAmount;
        const amountDueNow = paymentSummary.amountDueNow;

        const commissionBase = resolveAgentCommissionBase(
            servicesSubtotal,
            parsedZoneMinimum,
            bookingRow.paymentType
        );
        const commissionAmounts = calculateAgentCommissionAmounts(
            commissionBase,
            agentCommissionPercent,
            tipAmount
        );

        if (Number.isNaN(amountDueNow)) {
            throw new ValidationError("Calculated total is invalid. Please check your input values.");
        }

        return {
            servicesSubtotal,
            subTotal: totalOrderAmount,
            total: amountDueNow,
            paymentSummary,
            existingDiscount,
            agentCommissionPercent,
            finalAgentEarningAmount: commissionAmounts.agentEarning,
            finalZoneAdminCommissionAmount: commissionAmounts.platformCommissionAmount,
            parsedServiceCharge,
            parsedZoneMinimum,
        };
    }

    /**
     * Build paymentSummary for a booking (customer/agent invoice screens).
     * @param {number} bookingId
     * @returns {Promise<object>} paymentSummary
     */
    async getPaymentSummaryForBooking(bookingId) {
        const bookingRow = await booking.findByPk(bookingId, {
            attributes: [
                "id",
                "paymentType",
                "paymentConfirmed",
                "balancePaymentMethod",
                "balanceCollectedVia",
                ...RATE_SNAPSHOT_ATTRIBUTES,
            ],
            include: [
                {
                    model: zone,
                    attributes: ZONE_COMMERCIAL_ATTRIBUTES,
                },
                {
                    model: tip,
                    as: "tips",
                    attributes: ["id", "amount"],
                    required: false,
                },
                {
                    model: billingDetails,
                    as: "billingDetail",
                    required: false,
                    attributes: [
                        "upfrontAmount",
                        "serviceCharge",
                        "discount",
                        "total",
                        "paymentStatus",
                    ],
                },
            ],
        });

        if (!bookingRow) {
            throw new NotFoundError("Booking not found");
        }

        const totals = await this.calculateInvoiceTotals(
            bookingRow,
            bookingId
        );

        return totals.paymentSummary;
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

        this.assertInvoiceEditableBookingStatus(bookingRow);

        const isFinalized = bookingRow.invoiceStatus === "finalized";

        if (bookingRow.invoiceStatus === "draft") {
            throw new ValidationError(
                "Draft already exists for this booking. Use PATCH /agent/invoice/update-draft to update it."
            );
        }

        const { date: currentDate, time: currentTime } = agentWallClockDateTime(
            timeZone,
            clientTimeZone
        );

        const keptActiveIds = await this.syncInvoiceDraftServiceLines({
            bookingId,
            services,
            currentDate,
            currentTime,
        });

        const { totals, draftSavedAt, invoiceStatus } = await this.finalizeInvoiceDraftTotals({
            bookingId,
            serviceCharge,
            zoneMinimumAmount,
            preserveInvoiceStatus: isFinalized,
        });

        // If invoice is being re-edited after a failed OFD charge attempt, reset
        // the retry flag and payment gate so the new amount can be charged fresh.
        // This also prevents Stripe idempotency key conflicts (same key, new amount).
        if (
            bookingRow.ofdAutoRetryDone ||
            bookingRow.paymentDeliveryGate === 'waiting_admin'
        ) {
            await bookingRow.update({
                ofdAutoRetryDone: false,
                paymentDeliveryGate: null,
            });
        }

        return {
            bookingId,
            invoiceStatus,
            draftSavedAt,
            activeLineIds: keptActiveIds,
            servicesCount: keptActiveIds.length,
            servicesSubtotal: totals.servicesSubtotal,
            subTotal: totals.subTotal,
            total: totals.total,
            agentEarning: totals.finalAgentEarningAmount,
            agentCommissionPercent: totals.agentCommissionPercent,
            paymentSummary: totals.paymentSummary,
        };
    }

    /**
     * Update existing invoice draft — sync lines by id, deactivate removed lines.
     */
    async updateInvoiceDraft(data) {
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

        this.assertInvoiceEditableBookingStatus(bookingRow);

        if (
            bookingRow.invoiceStatus !== "draft" &&
            bookingRow.invoiceStatus !== "finalized"
        ) {
            throw new ValidationError(
                "No draft found for this booking. Use POST /agent/invoice/save-draft first."
            );
        }

        const isFinalized = bookingRow.invoiceStatus === "finalized";

        const { date: currentDate, time: currentTime } = agentWallClockDateTime(
            timeZone,
            clientTimeZone
        );

        const keptActiveIds = await this.syncInvoiceDraftServiceLines({
            bookingId,
            services,
            currentDate,
            currentTime,
        });

        const { totals, draftSavedAt, invoiceStatus } = await this.finalizeInvoiceDraftTotals({
            bookingId,
            serviceCharge,
            zoneMinimumAmount,
            preserveInvoiceStatus: isFinalized,
        });

        // Reset OFD retry flag + payment gate if invoice edited after a failed charge.
        if (
            bookingRow.ofdAutoRetryDone ||
            bookingRow.paymentDeliveryGate === 'waiting_admin'
        ) {
            await bookingRow.update({
                ofdAutoRetryDone: false,
                paymentDeliveryGate: null,
            });
        }

        return {
            bookingId,
            invoiceStatus,
            draftSavedAt,
            activeLineIds: keptActiveIds,
            servicesCount: keptActiveIds.length,
            servicesSubtotal: totals.servicesSubtotal,
            subTotal: totals.subTotal,
            total: totals.total,
            paymentSummary: totals.paymentSummary,
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

        bookingData.customerSelectedServices = (bookingData.customerSelectedServices || [])
            .filter((item) => item.status !== false)
            .map((item) => {
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
            });

        bookingData.customerSelectedServices = await hydrateRepairItemsForBooking(
            dbModels,
            bookingId,
            bookingData.customerSelectedServices
        );
        bookingData.customerDeclaredServices =
            await getCustomerDeclaredServices(bookingId);
        bookingData.repairItems = await getBookingRepairItems(bookingId);

        const servicesSubtotal = await sumActiveBookingServicesSubtotal(bookingId);
        const billing = bookingData.billingDetail || {};
        const tipAmount =
            bookingData.tips && bookingData.tips.length > 0
                ? bookingData.tips.reduce((sum, t) => sum + parseFloat(t.amount || 0), 0)
                : 0;

        const paymentSummary = buildPaymentSummary({
            laundrySubtotal: servicesSubtotal,
            serviceFee: parseFloat(billing.serviceCharge || 0),
            minimumOrderPayment: parseFloat(billing.upfrontAmount || 0),
            driverTip: tipAmount,
            discount: parseFloat(billing.discount || 0),
        });

        return {
            bookingId,
            invoiceStatus: bookingData.invoiceStatus,
            draftSavedAt: bookingData.invoiceDraftSavedAt,
            invoiceDetails: bookingData,
            servicesSubtotal,
            subTotal: bookingData.subTotal,
            total: bookingData.orderAmount,
            paymentSummary,
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
                "createdAt",
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

        if (Array.isArray(results.All)) {
            results.All = results.All.map((row) => {
                const plain = row.toJSON ? row.toJSON() : row;
                if (plain.customer) {
                    plain.customer = redactCustomerPhone(plain.customer);
                }
                return plain;
            });
        }

        return { results };
    }
}

module.exports = new AgentInvoiceManagementService();
