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
    bookingHistory
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

const ORDER_HISTORY_STATUSES = ['all', 'active', 'completed', 'cancelled', 'on_hold'];
const COMPLETED_STATUS_IDS = [17];
const CANCELLED_STATUS_IDS = [19, 21];
const ON_HOLD_STATUS_IDS = [18, 22, 24];
const ACTIVE_EXCLUDED_STATUS_IDS = [17, 19, 21];

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

        const enriched = {
            ...orderPlain,
            servicesSubtotal,
            paymentSummary,
            agentEarning:
                orderPlain.billingDetail?.agentEarning != null
                    ? parseFloat(orderPlain.billingDetail.agentEarning)
                    : null,
        };

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
     * @param {{ status?: string, page?: number, limit?: number }} options
     */
    async getOrderHistory(agentId, options = {}) {
        const status = (options.status || 'all').toLowerCase();
        const page = Math.max(parseInt(options.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(options.limit, 10) || 20, 1), 100);
        const offset = (page - 1) * limit;

        if (!ORDER_HISTORY_STATUSES.includes(status)) {
            throw new ValidationError(
                'Invalid status. Allowed: all, active, completed, cancelled, on_hold'
            );
        }

        const addressFound = await addressDb.findOne({
            where: { userId: agentId },
        });

        if (!addressFound) {
            throw new NotFoundError('Address not found for agent');
        }

        const shopBaseWhere = { laundryShopId: addressFound.id };
        const statusWhere = this._buildOrderHistoryStatusWhere(status);
        const listWhere = { ...shopBaseWhere, ...statusWhere };

        const [total, orders, allCount, activeCount, completedCount, cancelledCount, onHoldCount] =
            await Promise.all([
                booking.count({ where: listWhere }),
                booking.findAll({
                    where: listWhere,
                    order: [['id', 'DESC']],
                    limit,
                    offset,
                    attributes: [
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
                        'createdAt',
                        'updatedAt',
                    ],
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
            ]);

        const totalPages = total > 0 ? Math.ceil(total / limit) : 0;

        return {
            filter: status,
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
                onHold: onHoldCount,
            },
            orders: await Promise.all(
                orders.map((row) => this._enrichOrderHistoryItem(row.toJSON()))
            ),
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

        return {
            bookingData,
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

        return {
            getBooking,
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
            const oneHourLater = moment().add(1, "hours").format("HH:mm A"); // 24-hour format with AM/PM
            return {
                bookingfind,
                oneHourLater,
            };
        }

        return {
            bookingfind
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
            results.slots = await this.getSlotBookings(addressFound.id);
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
    async getSlotBookings(laundryShopId) {
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

        // Use map to iterate over slots and get the booking count and details for each slot
        const slotBookings = await Promise.all(
            slots.map(async (slot) => {
                const collectionTimeFrom = slot;
                const collectionTimeTo = this.getNextHourTime(slot);

                // Fetch the count of bookings for the current slot
                const bookingCount = await booking.count({
                    where: {
                        laundryShopId: laundryShopId,
                        collectionTimeFrom: { [Op.gte]: collectionTimeFrom },
                        collectionTimeTo: { [Op.lte]: collectionTimeTo },
                    },
                });

                // Fetch the booking details for the current slot
                const bookings = await booking.findAll({
                    where: {
                        laundryShopId: laundryShopId,
                        collectionTimeFrom: { [Op.gte]: collectionTimeFrom },
                        collectionTimeTo: { [Op.lte]: collectionTimeTo },
                        bookingStatusId: { [Op.notIn]: [1, 13] } // exclude status 1 and 3
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

                // Return the result for each slot
                return {
                    slot: `${collectionTimeFrom} - ${collectionTimeTo}`,
                    bookingCount: bookingCount,
                    bookings: bookings, // Include the actual booking details
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
