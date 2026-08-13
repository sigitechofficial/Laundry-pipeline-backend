require("dotenv").config();
const {
    users,
    booking,
    addressDb,
    countries,
    cities,
    bookingStatus,
    customerSelectedService,
    customerSelectedServiceAddOn,
    addOnServices,
    billingDetails,
    categories,
    subCategories,
    service,
    proofOfDeliveries,
    OnHoldConfirmation,
    bookingHistory,
    bookingPreference
} = require('../../models');
const moment = require('moment');
const { Op } = require('sequelize');
const {
    UnauthorizedError,
    NotFoundError,
    ConflictError,
    ValidationError
} = require('../../middlewares/universalErrorHandler');
const { confirmAndCapturePayment } = require('../../controllers/stripe');
const { sendEvent } = require('../../socket_io');
const {
    assertBookingNotCancelledForAgent,
} = require('../../utils/assertBookingNotCancelledForAgent');
const {
    wallClockNow,
    resolveBookingTimeZone,
    getActiveBookingCutoff,
} = require('../../utils/bookingTimeZone');
const invoiceManagementService = require('./invoiceManagementService');
const {
    ensureCustomerDeclaredSnapshot,
} = require('./customerDeclaredServicesService');
const { buildCollectPaymentFlags, normalizePaymentType } = require('../../utils/invoicePaymentSummary');
const { redactCustomerPhone } = require('../../utils/maskPhone');

const ORDER_HISTORY_STATUSES = ['all', 'active', 'completed', 'cancelled', 'on_hold', 'delivery_failed', 'pickup_failed'];
const COMPLETED_STATUS_IDS = [17];
const CANCELLED_STATUS_IDS = [19, 21];
const ON_HOLD_STATUS_IDS = [18, 22, 24];
const ACTIVE_EXCLUDED_STATUS_IDS = [17, 19, 21];
const DELIVERY_FAILED_STATUS_ID = 15;
const AWAITING_COLLECTION_STATUS_ID = 3;

/**
 * Agent Order Management Service
 * Handles all agent order related business logic
 */
class AgentOrderManagementService {

    _getOrderHistoryIncludes() {
        return [
            {
                model: bookingStatus,
                attributes: ['id', 'title', 'description'],
            },
            {
                model: addressDb,
                as: 'pickupAddress',
                attributes: [
                    'id',
                    'title',
                    'streetAddress',
                    'district',
                    'province',
                    'addressType',
                    'lat',
                    'lng',
                    'postalcode',
                ],
                include: [
                    {
                        model: countries,
                        attributes: ['id', 'name', 'shortName'],
                    },
                    {
                        model: cities,
                        attributes: ['id', 'name'],
                    },
                ],
            },
            {
                model: addressDb,
                as: 'dropOffAddress',
                attributes: [
                    'id',
                    'title',
                    'streetAddress',
                    'district',
                    'province',
                    'addressType',
                    'lat',
                    'lng',
                    'postalcode',
                ],
                include: [
                    {
                        model: countries,
                        attributes: ['id', 'name', 'shortName'],
                    },
                    {
                        model: cities,
                        attributes: ['id', 'name'],
                    },
                ],
            },
            {
                model: users,
                as: 'customer',
                attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum', 'image'],
            },
            {
                model: users,
                as: 'driver',
                required: false,
                attributes: ['id', 'firstName', 'lastName', 'image'],
            },
            {
                model: users,
                as: 'deliveryDriver',
                required: false,
                attributes: ['id', 'firstName', 'lastName', 'image'],
            },
            {
                model: users,
                as: 'pickupCompletedBy',
                required: false,
                attributes: ['id', 'firstName', 'lastName', 'image'],
            },
            {
                model: users,
                as: 'deliveryCompletedBy',
                required: false,
                attributes: ['id', 'firstName', 'lastName', 'image'],
            },
            {
                model: billingDetails,
                as: 'billingDetail',
                required: false,
                attributes: [
                    'upfrontAmount',
                    'serviceCharge',
                    'discount',
                    'total',
                    'agentEarning',
                    'paymentStatus',
                ],
            },
            {
                model: customerSelectedService,
                required: false,
                where: { status: true },
                attributes: [
                    'id',
                    'serviceId',
                    'categoryId',
                    'subCategoryId',
                    'categoryPrice',
                    'items',
                    'status',
                ],
                include: [
                    {
                        model: service,
                        required: false,
                        attributes: ['id', 'name'],
                    },
                    {
                        model: subCategories,
                        required: false,
                        attributes: ['id', 'name', 'price'],
                    },
                    {
                        model: customerSelectedServiceAddOn,
                        as: 'addOns',
                        required: false,
                        attributes: ['id', 'addOnServiceId', 'price', 'items'],
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
        ];
    }

    _buildOrderHistoryStatusWhere(status) {
        switch (status) {
            case 'active':
                return { bookingStatusId: { [Op.notIn]: ACTIVE_EXCLUDED_STATUS_IDS } };
            case 'completed':
                return { bookingStatusId: { [Op.in]: COMPLETED_STATUS_IDS } };
            case 'cancelled':
                return { bookingStatusId: { [Op.in]: CANCELLED_STATUS_IDS } };
            case 'on_hold':
                return { bookingStatusId: { [Op.in]: ON_HOLD_STATUS_IDS } };
            case 'delivery_failed':
                return { bookingStatusId: DELIVERY_FAILED_STATUS_ID };
            case 'pickup_failed':
                return {
                    bookingStatusId: AWAITING_COLLECTION_STATUS_ID,
                    pickupRescheduleRequired: true,
                };
            case 'all':
            default:
                return { bookingStatusId: { [Op.ne]: 1 } };
        }
    }

    async _enrichOrderHistoryItem(orderPlain) {
        const paymentSummary =
            await invoiceManagementService.getPaymentSummaryForBooking(orderPlain.id);
        const servicesSubtotal =
            paymentSummary.laundrySubtotal ??
            paymentSummary.orderSummary?.laundrySubtotal ??
            0;

        // Compute a display-level status override for cases where bookingStatusId alone
        // is not descriptive enough (e.g. status 3 = Awaiting Collection, but after a
        // failed pickup attempt it should surface as "Pickup Failed").
        const isPickupFailed =
            orderPlain.bookingStatusId === AWAITING_COLLECTION_STATUS_ID &&
            Boolean(orderPlain.pickupRescheduleRequired);

        const displayStatus = isPickupFailed
            ? { id: 3, title: 'Pickup Failed', description: 'A pickup attempt was unsuccessful' }
            : orderPlain.bookingStatus || null;

        const enriched = {
            ...orderPlain,
            servicesSubtotal,
            paymentSummary,
            displayStatus,
            agentEarning:
                orderPlain.billingDetail?.agentEarning != null
                    ? parseFloat(orderPlain.billingDetail.agentEarning)
                    : null,
        };

        if (enriched.customer) {
            enriched.customer = redactCustomerPhone(enriched.customer);
        }

        const paymentFlags = buildCollectPaymentFlags({
            paymentType: orderPlain.paymentType,
            paymentConfirmed: Boolean(orderPlain.paymentConfirmed),
            amountDueNow: paymentSummary?.amountDueNow,
            balancePaymentMethod: orderPlain.balancePaymentMethod,
            balanceCollectedVia: orderPlain.balanceCollectedVia,
            billingPaymentStatus:
                orderPlain.billingDetail?.paymentStatus ||
                paymentSummary?.billingPaymentStatus ||
                "Pending",
            bookingStatusId: orderPlain.bookingStatusId,
        });
        Object.assign(enriched, paymentFlags);

        const hasInvoiceTotals =
            orderPlain.invoiceStatus === 'finalized' ||
            orderPlain.invoiceStatus === 'draft' ||
            servicesSubtotal > 0;

        if (hasInvoiceTotals) {
            const fullOrderTotal = paymentSummary.orderSummary.totalOrderAmount;
            enriched.subTotal = fullOrderTotal;
            enriched.orderAmount = fullOrderTotal;
            if (enriched.billingDetail) {
                enriched.billingDetail = {
                    ...enriched.billingDetail,
                    total: fullOrderTotal,
                    balanceDue: paymentSummary.amountDueNow,
                };
            }
        }

        return enriched;
    }

    /**
     * Agent order history with tab filters and pagination
     * @param {number} agentId
     * @param {{
     *   status?: string,
     *   page?: number,
     *   limit?: number,
     *   startDate?: string,
     *   endDate?: string,
     *   staffUserId?: number,
     * }} options
     */
    async getOrderHistory(agentId, options = {}) {
        const status = (options.status || 'all').toLowerCase();
        const page = Math.max(parseInt(options.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(options.limit, 10) || 20, 1), 100);
        const offset = (page - 1) * limit;
        const staffUserId =
            options.staffUserId != null && options.staffUserId !== ''
                ? Number(options.staffUserId)
                : null;

        if (!ORDER_HISTORY_STATUSES.includes(status)) {
            throw new ValidationError(
                'Invalid status. Allowed: all, active, completed, cancelled, on_hold, delivery_failed, pickup_failed'
            );
        }

        const addressFound = await addressDb.findOne({
            where: {
                userId: agentId,
                addressType: 'LaundaryShopAddress',
            },
        });

        if (!addressFound) {
            throw new NotFoundError('Address not found for agent');
        }

        const shopBaseWhere = { laundryShopId: addressFound.id };

        if (options.startDate || options.endDate) {
            const range = {};
            if (options.startDate) {
                const start = new Date(options.startDate);
                if (!Number.isNaN(start.getTime())) range[Op.gte] = start;
            }
            if (options.endDate) {
                const end = new Date(options.endDate);
                if (!Number.isNaN(end.getTime())) {
                    end.setHours(23, 59, 59, 999);
                    range[Op.lte] = end;
                }
            }
            if (Object.keys(range).length) {
                shopBaseWhere.createdAt = range;
            }
        }

        if (staffUserId && !Number.isNaN(staffUserId)) {
            shopBaseWhere[Op.or] = [
                { driverId: staffUserId },
                { deliveryDriverId: staffUserId },
                { pickupCompletedByUserId: staffUserId },
                { deliveryCompletedByUserId: staffUserId },
            ];
        }

        const statusWhere = this._buildOrderHistoryStatusWhere(status);
        const listWhere = { ...shopBaseWhere, ...statusWhere };

        const historyAttributes = [
            'id',
            'orderTrackId',
            'bookingStatusId',
            'invoiceStatus',
            'invoiceDraftSavedAt',
            'orderAmount',
            'subTotal',
            'totalItems',
            'totalBags',
            'sameBagForAllServices',
            'noOfBags',
            'paymentType',
            'paymentConfirmed',
            'balancePaymentMethod',
            'balanceCollectedVia',
            'collectionDate',
            'collectionTimeFrom',
            'collectionTimeTo',
            'deliveryDate',
            'deliveryTimeFrom',
            'deliveryTimeTo',
            'driverInstructionOptions',
            'driverInstructionOptions1',
            'driverInstruction',
            'pickupAttemptCount',
            'pickupRescheduleRequired',
            'deliveryAttemptCount',
            'driverId',
            'deliveryDriverId',
            'pickupCompletedByUserId',
            'pickupCompletedAt',
            'deliveryCompletedByUserId',
            'deliveryCompletedAt',
            'createdAt',
            'updatedAt',
        ];

        const [total, orders, allCount, activeCount, completedCount, cancelledCount, onHoldCount, deliveryFailedCount, pickupFailedCount] =
            await Promise.all([
                booking.count({ where: listWhere }),
                booking.findAll({
                    where: listWhere,
                    order: [['id', 'DESC']],
                    limit,
                    offset,
                    attributes: historyAttributes,
                    include: this._getOrderHistoryIncludes(),
                }),
                booking.count({
                    where: {
                        ...shopBaseWhere,
                        ...this._buildOrderHistoryStatusWhere('all'),
                    },
                }),
                booking.count({
                    where: {
                        ...shopBaseWhere,
                        ...this._buildOrderHistoryStatusWhere('active'),
                    },
                }),
                booking.count({
                    where: {
                        ...shopBaseWhere,
                        ...this._buildOrderHistoryStatusWhere('completed'),
                    },
                }),
                booking.count({
                    where: {
                        ...shopBaseWhere,
                        ...this._buildOrderHistoryStatusWhere('cancelled'),
                    },
                }),
                booking.count({
                    where: {
                        ...shopBaseWhere,
                        ...this._buildOrderHistoryStatusWhere('on_hold'),
                    },
                }),
                booking.count({
                    where: {
                        ...shopBaseWhere,
                        ...this._buildOrderHistoryStatusWhere('delivery_failed'),
                    },
                }),
                booking.count({
                    where: {
                        ...shopBaseWhere,
                        ...this._buildOrderHistoryStatusWhere('pickup_failed'),
                    },
                }),
            ]);

        const totalPages = total > 0 ? Math.ceil(total / limit) : 0;

        const mappedOrders = orders.map((row) => {
            const plain = row.get ? row.get({ plain: true }) : row;
            const staffName = (u) => {
                if (!u) return null;
                const n = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
                return n || null;
            };
            plain.pickupStaffName =
                staffName(plain.pickupCompletedBy) || staffName(plain.driver);
            plain.deliveryStaffName =
                staffName(plain.deliveryCompletedBy) ||
                staffName(plain.deliveryDriver);
            plain.pickupCompletedByName = staffName(plain.pickupCompletedBy);
            plain.deliveryCompletedByName = staffName(plain.deliveryCompletedBy);
            return plain;
        });

        return {
            filter: status,
            staffScoped: Boolean(staffUserId),
            pagination: {
                page,
                limit,
                total,
                totalPages,
                hasNextPage: page < totalPages,
                hasPrevPage: page > 1,
            },
            counts: {
                all: allCount,
                active: activeCount,
                completed: completedCount,
                cancelled: cancelledCount,
                on_hold: onHoldCount,
                delivery_failed: deliveryFailedCount,
                pickup_failed: pickupFailedCount,
            },
            orders: mappedOrders,
        };
    }

    /**
     * Get Booking Home - Get available bookings for agent
     * @param {number} agentId - Agent ID
     * @returns {Object} Available bookings data
     */
    async getBookingHome(agentId, timeZone, clientTimeZone) {
        const userData = await users.findOne({
            where: {
                id: agentId,
            },
            include: [
                {
                    model: addressDb,
                    attributes: [
                        "id",
                        "streetAddress",
                        "zoneId",
                        "lat",
                        "lng",
                        "addressType",
                    ],
                },
            ],
        });

        if (!userData || !userData.addressDb) {
            throw new NotFoundError("Agent address not found");
        }

        let agentZone = userData.addressDb.zoneId;
        const resolvedExpireTz = resolveBookingTimeZone(timeZone, clientTimeZone);
        const { timeHHmm: currentTimeString } = wallClockNow(timeZone, clientTimeZone);
        const expireCutoff = getActiveBookingCutoff(timeZone, clientTimeZone);
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const createdAtCutoff =
            expireCutoff > twentyFourHoursAgo ? expireCutoff : twentyFourHoursAgo;

        console.log(
            "[getBookingHome] zone:",
            agentZone,
            "tz:",
            resolvedExpireTz,
            "now:",
            currentTimeString,
            "createdAt >=",
            createdAtCutoff.toISOString()
        );

        const bookingData = await booking.findAll({
            where: {
                laundryShopId: null,
                bookingStatusId: 1,
                zoneId: agentZone,
                createdAt: {
                    [Op.gte]: createdAtCutoff,
                },
            },
            include: [
                {
                    model: addressDb,
                    as: "pickupAddress",
                    attributes: ["id", "streetAddress", "district", "province", "postalcode", "lat", "lng", "addressType"],
                    include: [
                        {
                            model: countries,
                            attributes: ['id', 'name', 'shortName']
                        },
                        {
                            model: cities,
                            attributes: ['id', 'name']
                        }
                    ]
                },
                {
                    model: users,
                    as: "customer",
                    attributes: ["id", "firstName", "lastName", "email", "phoneNum", "image"],
                    include: [
                        {
                            model: countries,
                            attributes: ["id", "name", "shortName"],
                        },
                        {
                            model: cities,
                            attributes: ["id", "name"],
                        },
                    ],
                },
                {
                    model: bookingStatus,
                    attributes: ["id", "name"],
                }
            ],
            order: [['createdAt', 'DESC']]
        });

        const bookingDataPlain = bookingData.map((row) => {
            const plain = row.toJSON ? row.toJSON() : row;
            if (plain.customer) {
                plain.customer = redactCustomerPhone(plain.customer);
            }
            return plain;
        });

        return {
            bookingData: bookingDataPlain,
        };
    }

    /**
     * Get Agent Orders - Get accepted orders for agent
     * @param {number} agentId - Agent ID
     * @returns {Object} Agent orders data
     */
    async getAgentOrder(agentId) {
        const getShopAddress = await addressDb.findOne({
            where: {
                userId: agentId,
                addressType: "LaundaryShopAddress",
            },
        });

        if (!getShopAddress) {
            throw new NotFoundError("Shop address not found");
        }

        const getBooking = await booking.findAll({
            where: {
                bookingStatusId: 2,
                laundryShopId: getShopAddress.id,
            },
            include: [
                {
                    model: users,
                    as: "customer",
                    attributes: [
                        "id",
                        "firstName",
                        "lastName",
                        "email",
                        "phoneNum",
                        "image",
                    ],
                    include: [
                        {
                            model: countries,
                            attributes: ["id", "name", "shortName"],
                        },
                        {
                            model: cities,
                            attributes: ["id", "name"],
                        },
                    ],
                },
                {
                    model: addressDb,
                    as: "pickupAddress",
                    attributes: [
                        "id",
                        "title",
                        "streetAddress",
                        "province",
                        "district",
                        "postalcode",
                        "lat",
                        "lng",
                        "addressType",
                    ],
                    include: [
                        {
                            model: countries,
                            attributes: ["id", "name", "shortName"],
                        },
                        {
                            model: cities,
                            attributes: ["id", "name"],
                        },
                    ],
                },
                {
                    model: bookingStatus,
                    attributes: ["id", "name"],
                }
            ],
            order: [['createdAt', 'DESC']]
        });

        const getBookingPlain = getBooking.map((row) => {
            const plain = row.toJSON ? row.toJSON() : row;
            if (plain.customer) {
                plain.customer = redactCustomerPhone(plain.customer);
            }
            return plain;
        });

        return {
            getBooking: getBookingPlain,
        };
    }

    /**
     * Get Order Details by ID
     * @param {Object} data - Order details data
     * @param {number} data.bookingId - Booking ID
     * @param {string} data.orderTrackId - Order track ID
     * @returns {Object} Order details
     */
    async orderDetailsById(data) {
        const { bookingId, orderTrackId } = data;

        let whereCondition = {};

        if (bookingId) {
            whereCondition.id = bookingId;
        } else {
            whereCondition.orderTrackId = orderTrackId;
        }
        console.log("🚀 ~ orderDetailsById ~ whereCondition:", whereCondition);

        const bookingfind = await booking.findOne({
            where: whereCondition,
            include: [
                {
                    model: users,
                    as: "customer",
                    attributes: ["id", "firstName", "lastName", "email", "userTypeId"],
                },
                {
                    model: bookingHistory,
                    attributes: ["date", "time", "bookingStatusId"],
                    include: [
                        {
                            model: bookingStatus,
                            attributes: ["title", "description"],
                        },
                    ],
                },
                {
                    model: addressDb,
                    as: "pickupAddress",
                    attributes: ["title", "streetAddress", "district", "province"],
                },
                {
                    model: bookingStatus,
                    attributes: ["title", "description"],
                },
            ],
        });

        if (bookingfind.bookingStatusId === 5) {
            const paymentType = normalizePaymentType(bookingfind.paymentType);
            const plain = bookingfind.toJSON ? bookingfind.toJSON() : bookingfind;
            if (plain.customer) {
                plain.customer = redactCustomerPhone(plain.customer);
            }
            const result = { bookingfind: plain };
            // 1-hour payment window hint applies to card only (cash COD skips)
            if (paymentType === 'card') {
                result.oneHourLater = moment().add(1, 'hours').format('HH:mm A');
                result.invoicePaymentWindowApplies = true;
            } else {
                result.invoicePaymentWindowApplies = false;
            }
            return result;
        }

        let paymentSummary = null;
        try {
            paymentSummary =
                await invoiceManagementService.getPaymentSummaryForBooking(
                    bookingfind.id
                );
        } catch (_) {
            paymentSummary = null;
        }

        const paymentFlags = buildCollectPaymentFlags({
            paymentType: bookingfind.paymentType,
            paymentConfirmed: Boolean(bookingfind.paymentConfirmed),
            amountDueNow: paymentSummary?.amountDueNow,
            balancePaymentMethod: bookingfind.balancePaymentMethod,
            billingPaymentStatus: paymentSummary?.billingPaymentStatus,
        });

        const plain = bookingfind.toJSON ? bookingfind.toJSON() : bookingfind;
        if (plain.customer) {
            plain.customer = redactCustomerPhone(plain.customer);
        }

        return {
            bookingfind: plain,
            paymentSummary,
            ...paymentFlags,
        };
    }

    /**
     * Agent Booking Filters
     * @param {Object} data - Filter data
     * @param {string} data.filterType - Filter type
     * @param {number} agentId - Agent ID
     * @returns {Object} Filtered bookings
     */
    async agentBookingFilters(data, agentId) {
        const { filterType } = data;

        const addressFound = await addressDb.findOne({
            where: { userId: agentId },
        });

        if (!addressFound) {
            throw new NotFoundError("Address not found for agent");
        }

        const results = {};

        // Slot bookings
        if (filterType === 'slots') {
            results.slots = await this.getSlotBookings(addressFound.id, data.filterDate);
            return {
                results,
            };
        }

        // All bookings (any booking with this laundryShopId)
        results.All = await booking.findAll({
            where: {
                laundryShopId: addressFound.id,
                bookingStatusId: {
                    [Op.notIn]: [1, 13, 17]
                }
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
                "bookingStatusId"
            ],
            include: [
                {
                    model: bookingStatus,
                    attributes: ['id', 'title', 'description']
                },
                {
                    model: addressDb,
                    as: "laundryShop",
                    attributes: ["streetAddress", "district", "province", "addressType", "lat", "lng", 'postalcode'],
                    include: [
                        {
                            model: countries,
                            attributes: ['id', 'name', 'shortName']
                        },
                        {
                            model: cities,
                            attributes: ['id', 'name']
                        }
                    ]
                },
                {
                    model: addressDb,
                    as: "pickupAddress",
                    attributes: ["streetAddress", "district", "province", "addressType", "lat", "lng", 'postalcode'],
                    include: [
                        {
                            model: countries,
                            attributes: ['id', 'name', 'shortName']
                        },
                        {
                            model: cities,
                            attributes: ['id', 'name']
                        }
                    ]
                },
                {
                    model: addressDb,
                    as: "dropOffAddress",
                    attributes: ["streetAddress", "district", "province", "addressType", "lat", "lng", 'postalcode'],
                    include: [
                        {
                            model: countries,
                            attributes: ['id', 'name', 'shortName']
                        },
                        {
                            model: cities,
                            attributes: ['id', 'name']
                        }
                    ]
                },
                {
                    model: users,
                    as: "customer",
                    attributes: ["firstName", "lastName", "email", "phoneNum"],
                },
            ],
        });

        return {
            results
        };
    }

    /**
     * Get Slot Bookings
     * @param {number} laundryShopId - Laundry shop ID
     * @returns {Array} Slot bookings
     */
    /**
     * Slot bookings — aligned with controllers/Agent/agents.js getSlotBookings.
     * Pickup phase (3..7) → collection time/date; facility+ (8..16) → delivery time/date when filterDate set.
     * Without filterDate, only pickup-phase rows (avoids resurfacing facility-done on wrong day).
     */
    async getSlotBookings(laundryShopId, filterDate) {
        const PICKUP_STATUSES = [3, 4, 5, 6, 7];
        const POST_PICKUP_STATUSES = [8, 9, 10, 11, 12, 13, 14, 15, 16];
        const ALL_ACTIVE = [...PICKUP_STATUSES, ...POST_PICKUP_STATUSES];

        const slots = [
            "07:00",
            "08:00",
            "09:00",
            "10:00",
            "11:00",
            "12:00",
            "13:00",
            "14:00",
            "15:00",
            "16:00",
            "17:00",
            "18:00",
        ];

        let dayStart = null;
        let dayEnd = null;
        if (filterDate && moment(filterDate, "YYYY-MM-DD", true).isValid()) {
            dayStart = moment(filterDate, "YYYY-MM-DD").format("YYYY-MM-DD");
            dayEnd = moment(filterDate, "YYYY-MM-DD").add(1, "day").format("YYYY-MM-DD");
        }

        const slotBookings = await Promise.all(
            slots.map(async (slot) => {
                const slotFrom = slot;
                const slotTo = this.getNextHourTime(slot);

                const pickupBranch = {
                    bookingStatusId: { [Op.in]: PICKUP_STATUSES },
                    collectionTimeFrom: { [Op.gte]: slotFrom },
                    collectionTimeTo: { [Op.lte]: slotTo },
                };
                let where;
                if (dayStart && dayEnd) {
                    pickupBranch.collectionDate = { [Op.gte]: dayStart, [Op.lt]: dayEnd };
                    where = {
                        laundryShopId,
                        bookingStatusId: { [Op.in]: ALL_ACTIVE },
                        [Op.or]: [
                            pickupBranch,
                            {
                                bookingStatusId: { [Op.in]: POST_PICKUP_STATUSES },
                                deliveryDate: { [Op.gte]: dayStart, [Op.lt]: dayEnd },
                                deliveryTimeFrom: { [Op.gte]: slotFrom },
                                deliveryTimeTo: { [Op.lte]: slotTo },
                            },
                        ],
                    };
                } else {
                    where = { laundryShopId, ...pickupBranch };
                }

                const bookings = await booking.findAll({
                    where,
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
                        "bookingStatusId"
                    ],
                    include: [
                        {
                            model: bookingStatus,
                            attributes: ['id', 'title', 'description']
                        },
                        {
                            model: addressDb,
                            as: "laundryShop",
                            attributes: ["streetAddress", "district", "province", "addressType", "lat", "lng", 'postalcode'],
                            include: [
                                {
                                    model: countries,
                                    attributes: ['id', 'name', 'shortName']
                                },
                                {
                                    model: cities,
                                    attributes: ['id', 'name']
                                }
                            ]
                        },
                        {
                            model: addressDb,
                            as: "pickupAddress",
                            attributes: ["streetAddress", "district", "province", "addressType", "lat", "lng", 'postalcode'],
                            include: [
                                {
                                    model: countries,
                                    attributes: ['id', 'name', 'shortName']
                                },
                                {
                                    model: cities,
                                    attributes: ['id', 'name']
                                }
                            ]
                        },
                        {
                            model: addressDb,
                            as: "dropOffAddress",
                            attributes: ["streetAddress", "district", "province", "addressType", "lat", "lng", 'postalcode'],
                            include: [
                                {
                                    model: countries,
                                    attributes: ['id', 'name', 'shortName']
                                },
                                {
                                    model: cities,
                                    attributes: ['id', 'name']
                                }
                            ]
                        },
                        {
                            model: users,
                            as: "customer",
                            attributes: ["firstName", "lastName", "email", "phoneNum"],
                        },
                    ],
                });

                return {
                    slot: `${slotFrom} - ${slotTo}`,
                    bookingCount: bookings.length,
                    bookings,
                };
            })
        );

        return slotBookings;
    }

    /**
     * Get Next Hour Time
     * @param {string} time - Time string
     * @returns {string} Next hour time
     */
    getNextHourTime(time) {
        const [hour, minute] = time.split(":").map(Number);
        const nextHour = hour === 12 ? 1 : hour + 1;
        return `${nextHour.toString().padStart(2, "0")}:${minute
            .toString()
            .padStart(2, "0")}`;
    }

    /**
     * Agent Booking Status On The Way
     * @param {Object} data - Booking data
     * @param {number} data.bookingId - Booking ID
     * @returns {Object} Status update result
     */
    async agentBookingStatusOnTheWay(data) {
        const { bookingId } = data;

        const bookingfind = await booking.findOne({
            where: { id: bookingId },
            include: [
                {
                    model: users,
                    as: 'customer',
                    attributes: ['id', 'stripeCustomerId'],
                }
            ]
        });

        if (!bookingfind) {
            throw new NotFoundError(`Booking with ID ${bookingId} not found`);
        }

        assertBookingNotCancelledForAgent(bookingfind);

        if (bookingfind.bookingStatusId !== 3) {
            throw new ValidationError("No driver is assigned to this booking yet");
        }

        if (!bookingfind.customer.stripeCustomerId) {
            throw new NotFoundError("PaymentIntent or PaymentMethod not found for this booking");
        }

        const stripeResult = await confirmAndCapturePayment(
            bookingfind.paymentIntentId,
            bookingfind.paymentMethodId,
            bookingfind.customer.stripeCustomerId
        );

        if (stripeResult.status !== 'succeeded') {
            throw new ValidationError(`Payment failed or incomplete. Current status: ${stripeResult.status}`);
        }

        await booking.update(
            { bookingStatusId: 4 },
            { where: { id: bookingId } }
        );

        const currentTime = new Date().toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        });

        // Send socket event
        sendEvent('bookingStatusUpdated', {
            bookingId: bookingId,
            status: 4,
            message: "Driver is on the way",
            time: currentTime
        });

        return {
            bookingId: bookingId,
            status: 4
        };
    }

    /**
     * Driver Status Arrived
     * @param {Object} data - Booking data
     * @param {number} data.bookingId - Booking ID
     * @returns {Object} Status update result
     */
    async driverStatusArrived(data) {
        const { bookingId } = data;

        const bookingfind = await booking.findOne({
            where: { id: bookingId }
        });

        if (!bookingfind) {
            throw new NotFoundError(`Booking with ID ${bookingId} not found`);
        }

        assertBookingNotCancelledForAgent(bookingfind);

        if (bookingfind.bookingStatusId !== 4) {
            throw new ValidationError("Driver is not on the way yet");
        }

        await booking.update(
            { bookingStatusId: 5 },
            { where: { id: bookingId } }
        );

        const currentTime = new Date().toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        });

        // Send socket event
        sendEvent('bookingStatusUpdated', {
            bookingId: bookingId,
            status: 5,
            message: "Driver has arrived",
            time: currentTime
        });

        return {
            bookingId: bookingId,
            status: 5
        };
    }

    /**
     * Add Pickup Delivery Proof
     * @param {Object} data - Proof data
     * @param {number} data.bookingId - Booking ID
     * @param {Array} data.images - Proof images
     * @returns {Object} Proof addition result
     */
    async AddPickupDeliveryProof(data, images) {
        const { bookingId } = data;

        const bookingfind = await booking.findOne({
            where: { id: bookingId }
        });

        if (!bookingfind) {
            throw new NotFoundError(`Booking with ID ${bookingId} not found`);
        }

        assertBookingNotCancelledForAgent(bookingfind);

        // Create proof records for each image
        const proofRecords = [];
        for (const image of images) {
            const proof = await proofOfDeliveries.create({
                bookingId: bookingId,
                imagePath: image,
                proofType: 'pickup_delivery',
                createdAt: new Date()
            });
            proofRecords.push(proof);
        }

        return {
            proofRecords,
        };
    }

    /**
     * Agent Inspection Status
     * @param {Object} data - Inspection data
     * @param {number} data.bookingId - Booking ID
     * @returns {Object} Inspection status result
     */
    async agentInspectionStatus(data) {
        const { bookingId } = data;

        const bookingfind = await booking.findOne({
            where: { id: bookingId }
        });

        if (!bookingfind) {
            throw new NotFoundError(`Booking with ID ${bookingId} not found`);
        }

        assertBookingNotCancelledForAgent(bookingfind);

        if (bookingfind.bookingStatusId !== 5) {
            throw new ValidationError("Driver has not arrived yet");
        }

        await booking.update(
            { bookingStatusId: 6 },
            { where: { id: bookingId } }
        );

        const currentTime = new Date().toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        });

        // Send socket event
        sendEvent('bookingStatusUpdated', {
            bookingId: bookingId,
            status: 6,
            time: currentTime
        });

        return {
            bookingId: bookingId,
            status: 6
        };
    }

    /**
     * Reached At Delivery Shop Status
     * @param {Object} data - Delivery data
     * @param {number} data.bookingId - Booking ID
     * @returns {Object} Delivery status result
     */
    async reachedAtDeliveryShopStatus(data) {
        const { bookingId } = data;

        const bookingfind = await booking.findOne({
            where: { id: bookingId }
        });

        if (!bookingfind) {
            throw new NotFoundError(`Booking with ID ${bookingId} not found`);
        }

        assertBookingNotCancelledForAgent(bookingfind);

        if (bookingfind.bookingStatusId !== 6) {
            throw new ValidationError("Inspection not completed yet");
        }

        await booking.update(
            { bookingStatusId: 7 },
            { where: { id: bookingId } }
        );

        const currentTime = new Date().toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        });

        // Send socket event
        sendEvent('bookingStatusUpdated', {
            bookingId: bookingId,
            status: 7,
            time: currentTime
        });

        return {
            bookingId: bookingId,
            status: 7
        };
    }

    /**
     * Take a one-time frozen snapshot of customer's original service selections
     * (called once when booking transitions 7 → 8). Idempotent — skips if already taken.
     */
    async _snapshotCustomerSelections(bookingId) {
        await ensureCustomerDeclaredSnapshot(bookingId);
    }

    /**
     * Laundry Wash Completed
     * @param {Object} data - Wash completion data
     * @param {number} data.bookingId - Booking ID
     * @returns {Object} Wash completion result
     */
    async laundryWashCompleted(data) {
        const { bookingId } = data;

        const bookingfind = await booking.findOne({
            where: { id: bookingId }
        });

        if (!bookingfind) {
            throw new NotFoundError(`Booking with ID ${bookingId} not found`);
        }

        assertBookingNotCancelledForAgent(bookingfind);

        if (bookingfind.bookingStatusId !== 7) {
            throw new ValidationError("Laundry not at delivery shop yet");
        }

        await this._snapshotCustomerSelections(bookingId);

        await booking.update(
            { bookingStatusId: 8 },
            { where: { id: bookingId } }
        );

        const currentTime = new Date().toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        });

        // Send socket event
        sendEvent('bookingStatusUpdated', {
            bookingId: bookingId,
            status: 8,
            time: currentTime
        });

        return {
            bookingId: bookingId,
            status: 8
        };
    }

    /**
     * Laundry Deliver To Customer
     * @param {Object} data - Delivery data
     * @param {number} data.bookingId - Booking ID
     * @returns {Object} Delivery result
     */
    async laundryDeliverToCustomer(data) {
        const { bookingId } = data;

        const bookingfind = await booking.findOne({
            where: { id: bookingId }
        });

        if (!bookingfind) {
            throw new NotFoundError(`Booking with ID ${bookingId} not found`);
        }

        assertBookingNotCancelledForAgent(bookingfind);

        if (bookingfind.bookingStatusId !== 8) {
            throw new ValidationError("Laundry wash not completed yet");
        }

        await booking.update(
            { bookingStatusId: 9 },
            { where: { id: bookingId } }
        );

        const currentTime = new Date().toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        });

        // Send socket event
        sendEvent('bookingStatusUpdated', {
            bookingId: bookingId,
            status: 9,
            time: currentTime
        });

        return {
            bookingId: bookingId,
            status: 9
        };
    }

    /**
     * Driver Reached For Delivery
     * @param {Object} data - Delivery data
     * @param {number} data.bookingId - Booking ID
     * @returns {Object} Delivery status result
     */
    async driverReachedForDelivery(data) {
        const { bookingId } = data;

        const bookingfind = await booking.findOne({
            where: { id: bookingId }
        });

        if (!bookingfind) {
            throw new NotFoundError(`Booking with ID ${bookingId} not found`);
        }

        assertBookingNotCancelledForAgent(bookingfind);

        if (bookingfind.bookingStatusId !== 9) {
            throw new ValidationError("Not out for delivery yet");
        }

        await booking.update(
            { bookingStatusId: 10 },
            { where: { id: bookingId } }
        );

        const currentTime = new Date().toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        });

        // Send socket event
        sendEvent('bookingStatusUpdated', {
            bookingId: bookingId,
            status: 10,
            time: currentTime
        });

        return {
            bookingId: bookingId,
            status: 10
        };
    }

    /**
     * Booking Deliver To Customer
     * @param {Object} data - Delivery data
     * @param {number} data.bookingId - Booking ID
     * @returns {Object} Delivery completion result
     */
    async bookingDeliverToCustomer(data) {
        const { bookingId } = data;

        const bookingfind = await booking.findOne({
            where: { id: bookingId }
        });

        if (!bookingfind) {
            throw new NotFoundError(`Booking with ID ${bookingId} not found`);
        }

        assertBookingNotCancelledForAgent(bookingfind);

        if (bookingfind.bookingStatusId !== 10) {
            throw new ValidationError("Driver has not reached for delivery yet");
        }

        await booking.update(
            { bookingStatusId: 11 },
            { where: { id: bookingId } }
        );

        const currentTime = new Date().toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        });

        // Send socket event
        sendEvent('bookingStatusUpdated', {
            bookingId: bookingId,
            status: 11,
            time: currentTime
        });

        return {
            bookingId: bookingId,
            status: 11
        };
    }

    /**
     * Agent Cancel Booking
     * @param {Object} data - Cancel booking data
     * @param {number} data.bookingId - Booking ID
     * @param {string} data.reason - Cancellation reason
     * @param {number} agentId - Agent ID
     * @returns {Object} Cancellation result
     */
    async agentCancelBooking(data, agentId) {
        const { bookingId, reason } = data;

        const bookingfind = await booking.findOne({
            where: { id: bookingId }
        });

        if (!bookingfind) {
            throw new NotFoundError(`Booking with ID ${bookingId} not found`);
        }

        if (bookingfind.bookingStatusId >= 11) {
            throw new ValidationError("Cannot cancel completed booking");
        }

        await booking.update(
            {
                bookingStatusId: 12, // Cancelled status
                cancellationReason: reason,
                cancelledBy: agentId,
                cancelledAt: new Date()
            },
            { where: { id: bookingId } }
        );

        return {
            bookingId: bookingId,
            status: 12
        };
    }
}

module.exports = new AgentOrderManagementService();
