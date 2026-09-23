const {
    booking,
    customerSelectedService,
    customerSelectedServiceAddOn,
    customerSelectedServiceLine,
    addOnServices,
    proofOfDeliveries,
    OnHoldConfirmation,
    addressDb,
    bussinessInformation,
    bookingStatus,
    service,
    categories,
    subCategories,
    billingDetails,
    bookingPreference,
    preferenceTypes,
    serviceWithPreferences,
    serviceCategories,
    preferenceValues,
    tip,
    zone,
    cities,
    countries,
    users,
    bookingAssignmentEvent,
    bookingPaymentMethodEvent,
    bookingAttempt,
    attemptFailReason,
    bookingHistory,
} = require('../../models');
const { Op } = require('sequelize');
const adminBookingAssignService = require('./adminBookingAssignService');
const invoiceManagementService = require('../Agent/invoiceManagementService');
const {
    COMPLETED,
    CANCELLED,
    ORDER_CREATED,
    PENDING_EXCLUDED,
    ON_HOLD,
    PENDING_EXCLUDED_SQL,
    ACTIVE_EXCLUDED_SQL,
} = require('../../constants/bookingStatusIds');
const sequelize = require('sequelize');
const momentTz = require('moment-timezone');
const {
    buildOrderListSequelizeOrder,
} = require('../../utils/orderListSort');
const { clampListLimit, clampPage, DEFAULT_MAX_LIST_LIMIT } = require('../../utils/listLimit');
const { EXPORT_MAX_ROWS } = require('../../utils/listQuery');
const {
    serviceLineHasAddOnPayload,
    sumActiveBookingServicesSubtotal,
} = require('../../utils/invoiceLineTotals');
const { getCountryContextFromZoneId } = require('../../utils/countryTimeZone');
const zoneCatalogService = require('./zoneCatalogService');
const { attachCommercialTerms } = require('../../utils/bookingRateSnapshot');
const {
    resolveAgentCommissionBase,
    calculateAgentCommissionAmounts,
} = require('../../utils/agentCommission');
const { bookingTipAmountFromTips, summarizeTips, splitTips } = require('../../utils/bookingTips');
const { lockPrepaidTipAmount } = require('../../utils/invoicePaymentSummary');
const { ensureOrderTrackId, ensureOrderTrackIds } = require('../../utils/orderTrackId');
const { attachLastStatusChanges } = require('../../utils/attachLastStatusChanges');
const dbModels = require('../../models');
const {
    buildRepairItemsInclude,
    buildBookingLevelRepairItemsInclude,
    hydrateRepairItemsForBooking,
    normalizeRepairItems,
} = require('../../utils/repairBookingInclude');
const {
    ValidationError,
    NotFoundError,
    ConflictError,
    UnprocessableEntityError
} = require('../../middlewares/universalErrorHandler');

const ADMIN_BUSINESS_TIME_ZONE = 'Europe/London';

function adminWallClockDateTime(timeZone, clientTimeZone) {
    const candidate = timeZone || clientTimeZone;
    const zone = candidate && momentTz.tz.zone(candidate) ? candidate : ADMIN_BUSINESS_TIME_ZONE;
    const now = momentTz().tz(zone);
    return {
        date: now.format('YYYY-MM-DD'),
        time: now.format('HH:mm:ss')
    };
}

class OrderService {
    _applyRecurringTypeFilter(whereClause, filters = {}) {
        const mode = String(filters.recurringType || "")
            .trim()
            .toLowerCase();
        if (!mode || mode === "all") return;
        if (mode === "recurring") {
            whereClause.isRecurringAutoCreated = true;
            return;
        }
        if (mode === "manual") {
            whereClause.isRecurringAutoCreated = {
                [Op.ne]: true,
            };
        }
    }

    _applyZoneFilter(whereClause, filters = {}) {
        if (filters.zoneId == null || String(filters.zoneId).trim() === "") {
            return;
        }
        const zoneId = parseInt(filters.zoneId, 10);
        if (!Number.isNaN(zoneId)) {
            whereClause.zoneId = zoneId;
        }
    }

    /**
     * Filter to a single laundry shop. filters.shopId is an addressDb.id
     * (admin panel sends shopAddressId), same as booking.laundryShopId.
     */
    _applyShopFilter(whereClause, filters = {}) {
        if (filters.shopId == null || String(filters.shopId).trim() === "") {
            return;
        }
        const shopId = parseInt(filters.shopId, 10);
        if (!Number.isNaN(shopId)) {
            whereClause.laundryShopId = shopId;
        }
    }

    _applyPlacedDateRangeFilter(whereClause, filters = {}) {
        const { startDate, endDate, date } = filters;
        if (startDate && endDate) {
            const start = new Date(`${startDate}T00:00:00.000`);
            const end = new Date(`${endDate}T23:59:59.999`);
            whereClause.createdAt = {
                [Op.gte]: start,
                [Op.lte]: end,
            };
            return;
        }
        if (date) {
            whereClause.createdAt = {
                [Op.gte]: new Date(date),
                [Op.lt]: new Date(new Date(date).getTime() + 24 * 60 * 60 * 1000),
            };
        }
    }

    _buildWhereWithSearch(baseWhere, searchRaw) {
        const term = String(searchRaw || "")
            .trim()
            .replace(/^#+/, "")
            .trim();
        if (!term) {
            return { where: baseWhere, searchActive: false };
        }

        const like = `%${term}%`;
        const bookingOr = [{ orderTrackId: { [Op.like]: like } }];
        if (/^\d+$/.test(term)) {
            bookingOr.push({ id: parseInt(term, 10) });
        }

        const searchOr = {
            [Op.or]: [
                ...bookingOr,
                { "$customer.firstName$": { [Op.like]: like } },
                { "$customer.lastName$": { [Op.like]: like } },
                { "$customer.email$": { [Op.like]: like } },
                { "$customer.phoneNum$": { [Op.like]: like } },
            ],
        };

        const baseKeys = Object.keys(baseWhere || {});
        if (baseKeys.length === 0) {
            return { where: searchOr, searchActive: true };
        }
        return {
            where: { [Op.and]: [baseWhere, searchOr] },
            searchActive: true,
        };
    }

    _bookingListIncludes(includeCustomer = false) {
        const includes = [
            {
                model: customerSelectedService,
                // Only active lines — an edited invoice deactivates replaced lines
                // (status:false); including them inflates the Items badge and
                // shows stale services in the list.
                required: false,
                where: { status: true },
                attributes: ['id', 'serviceId', 'items'],
                include: [
                    {
                        model: service,
                        attributes: ['id', 'name'],
                    },
                ],
            },
            {
                model: OnHoldConfirmation,
                required: false,
                attributes: ['id', 'bookingId'],
            },
            {
                model: addressDb,
                as: 'laundryShop',
                required: false,
                attributes: ['id', 'userId'],
                include: {
                    model: bussinessInformation,
                    attributes: ['id', 'shopName'],
                    required: false,
                },
            },
            {
                model: bookingStatus,
                attributes: ['id', 'title'],
            },
            {
                model: billingDetails,
                as: 'billingDetail',
                required: false,
                attributes: ['upfrontAmount', 'total', 'paymentStatus'],
            },
            {
                model: users,
                as: 'driver',
                required: false,
                attributes: ['id', 'firstName', 'lastName'],
            },
            {
                model: users,
                as: 'deliveryDriver',
                required: false,
                attributes: ['id', 'firstName', 'lastName'],
            },
        ];
        if (includeCustomer) {
            includes.push({
                model: users,
                as: 'customer',
                attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum', 'countryCode'],
                required: false,
            });
        }
        return includes;
    }

    _listBookingAttributes() {
        return [
            'id',
            'orderTrackId',
            'createdAt',
            'updatedAt',
            'bookingStatusId',
            'zoneId',
            'collectionDate',
            'collectionTimeFrom',
            'collectionTimeTo',
            'deliveryDate',
            'deliveryTimeFrom',
            'deliveryTimeTo',
            'totalItems',
            'totalBags',
            'noOfBags',
            'sameBagForAllServices',
            'allInOneBag',
            'onHoldReason',
            'OnHoldOtherReason',
            'orderAmount',
            'laundryShopId',
            'adminAssignedShopId',
            'invoiceStatus',
            'agentBroadcastHeld',
            'agentVisibleAt',
            'orderExpireTime',
            'placedOutsidePlatformHours',
            'driverId',
            'deliveryDriverId',
            'customerId',
            'paymentType',
            'balancePaymentMethod',
            'balanceCollectedVia',
            'paymentDeliveryGate',
            'autoChargeStatus',
            'lastPaymentFailureCode',
            'lastPaymentFailureMessage',
            'lastPaymentFailureAt',
            'isRecurringAutoCreated',
            'recurringSourceBookingId',
            'recurringNextBookingId',
            'recurringCycleDate',
            'recurringPlanId',
        ];
    }

    _toInt(value, fallback = 0) {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    /**
     * @param {Object} [filters] - Optional zone/date/status/search scope (same as order lists)
     * @returns {Object} Order count metrics
     */
    async getOrderCount(filters = {}) {
        const scoped = {};
        this._applyZoneFilter(scoped, filters);
        this._applyShopFilter(scoped, filters);
        this._applyPlacedDateRangeFilter(scoped, filters);
        this._applyRecurringTypeFilter(scoped, filters);

        if (filters.status) {
            const statusId = parseInt(filters.status, 10);
            if (!Number.isNaN(statusId)) {
                scoped.bookingStatusId = statusId;
            }
        }

        const { where, searchActive } = this._buildWhereWithSearch(
            scoped,
            filters.search
        );
        const countIncludes = searchActive
            ? [
                  {
                      model: users,
                      as: 'customer',
                      attributes: [],
                      required: false,
                  },
              ]
            : [];

        const [metricsRow, repeatOrders] = await Promise.all([
            booking.findAll({
                where,
                include: countIncludes,
                attributes: [
                    [
                        sequelize.fn('COUNT', sequelize.col('booking.id')),
                        'allOrderCount',
                    ],
                    [
                        sequelize.literal(
                            `SUM(CASE WHEN \`booking\`.\`bookingStatusId\` = ${COMPLETED} THEN 1 ELSE 0 END)`
                        ),
                        'completedOrders',
                    ],
                    [
                        sequelize.literal(
                            `SUM(CASE WHEN \`booking\`.\`bookingStatusId\` IN (${ON_HOLD.join(', ')}) THEN 1 ELSE 0 END)`
                        ),
                        'onHoldOrders',
                    ],
                    [
                        sequelize.literal(
                            `SUM(CASE WHEN \`booking\`.\`bookingStatusId\` = ${CANCELLED} THEN 1 ELSE 0 END)`
                        ),
                        'cancelledOrders',
                    ],
                    [
                        sequelize.literal(
                            `SUM(CASE WHEN \`booking\`.\`bookingStatusId\` NOT IN (${PENDING_EXCLUDED_SQL}) THEN 1 ELSE 0 END)`
                        ),
                        'pendingOrders',
                    ],
                    [
                        sequelize.literal(
                            `SUM(CASE WHEN \`booking\`.\`bookingStatusId\` = ${ORDER_CREATED} THEN 1 ELSE 0 END)`
                        ),
                        'newOrders',
                    ],
                    [
                        sequelize.literal(
                            `SUM(CASE WHEN \`booking\`.\`bookingStatusId\` NOT IN (${ACTIVE_EXCLUDED_SQL}) THEN 1 ELSE 0 END)`
                        ),
                        'activeOrders',
                    ],
                    [
                        sequelize.literal(
                            `SUM(CASE WHEN \`booking\`.\`paymentType\` = 'card' AND \`booking\`.\`paymentDeliveryGate\` = 'waiting_admin' AND \`booking\`.\`bookingStatusId\` < ${COMPLETED} THEN 1 ELSE 0 END)`
                        ),
                        'paymentFailuresCount',
                    ],
                ],
                raw: true,
                subQuery: false,
            }),
            this._countRepeatOrders(where, countIncludes),
        ]);

        const metrics = metricsRow?.[0] || {};
        const newOrders = this._toInt(metrics.newOrders);

        let actionRequiredCount = 0;
        try {
            const actionRequiredOrdersService = require('./actionRequiredOrdersService');
            const ar = await actionRequiredOrdersService.countActionRequiredOrders(filters);
            actionRequiredCount = this._toInt(ar.actionRequiredCount);
        } catch (e) {
            console.warn('[getOrderCount] actionRequiredCount failed:', e.message);
        }

        return {
            allOrderCount: this._toInt(metrics.allOrderCount),
            completedOrders: this._toInt(metrics.completedOrders),
            onHoldOrders: this._toInt(metrics.onHoldOrders),
            cancelledOrders: this._toInt(metrics.cancelledOrders),
            pendingOrders: this._toInt(metrics.pendingOrders),
            newOrders,
            NewOrders: newOrders,
            activeOrders: this._toInt(metrics.activeOrders),
            repeatOrders,
            paymentFailuresCount: this._toInt(metrics.paymentFailuresCount),
            actionRequiredCount,
        };
    }

    /**
     * Count bookings belonging to customers who have more than one booking
     * (scoped to the same filters). One grouped query — no giant IN list.
     */
    async _countRepeatOrders(where, countIncludes = []) {
        const rows = await booking.findAll({
            where: {
                ...where,
                customerId: { [Op.ne]: null },
            },
            include: countIncludes,
            attributes: [
                'customerId',
                [sequelize.fn('COUNT', sequelize.col('booking.id')), 'orderCount'],
            ],
            group: ['booking.customerId'],
            having: sequelize.literal('COUNT(`booking`.`id`) > 1'),
            raw: true,
            subQuery: false,
        });

        return rows.reduce(
            (sum, row) => sum + this._toInt(row.orderCount),
            0
        );
    }

    /**
     * Get optimized bookings with pagination and filtering.
     * Sort: allowlisted sortBy + sortDir only; default createdAt DESC, id DESC.
     * @param {Object} whereClause - Sequelize where clause
     * @param {number} page - Page number
     * @param {number} limit - Records per page
     * @param {Object|string} [filters] - search / sortBy / sortDir (string treated as search)
     * @returns {Object} Bookings with pagination info
     */
    async getOptimizedBookings(whereClause, page = 1, limit = 50, filters = {}) {
        const exportMode = typeof filters === 'object' && filters !== null && filters.exportMode === true;
        if (exportMode) {
            // CSV export: one window over the whole filtered set (capped).
            page = 1;
            limit = EXPORT_MAX_ROWS;
        } else {
            page = clampPage(page);
            // Keep caller defaults (All Orders 20, this helper 50). Cap abuse only.
            limit = clampListLimit(limit, limit || 20, DEFAULT_MAX_LIST_LIMIT);
        }
        const search = typeof filters === 'string' ? filters : filters.search;
        const sortBy = typeof filters === 'string' ? undefined : filters.sortBy;
        const sortDir = typeof filters === 'string' ? undefined : filters.sortDir;
        const order = buildOrderListSequelizeOrder(sortBy, sortDir);
        const offset = (page - 1) * limit;
        const { where, searchActive } = this._buildWhereWithSearch(whereClause, search);
        const includes = this._bookingListIncludes(true);

        const countIncludes = searchActive
            ? [
                  {
                      model: users,
                      as: 'customer',
                      attributes: [],
                      required: false,
                  },
              ]
            : [];

        const [totalCount, bookings] = await Promise.all([
            booking.count({
                where,
                include: countIncludes,
                distinct: true,
                col: 'id',
            }),
            booking.findAll({
                where,
                include: includes,
                order,
                limit: limit,
                offset: offset,
                attributes: this._listBookingAttributes(),
                logging: false,
                benchmark: false,
                subQuery: searchActive ? false : undefined,
            }),
        ]);

        await ensureOrderTrackIds(booking, bookings);

        const totalPages = Math.ceil(totalCount / limit);
        const hasNextPage = page < totalPages;
        const hasPrevPage = page > 1;

        const enrichedBookings =
            await adminBookingAssignService.enrichBookingsForAdminList(bookings);

        try {
            const {
                getRefundAggregatesByBookingIds,
            } = require('./adminRefundService');
            const ids = enrichedBookings.map((b) => Number(b.id)).filter((id) => id > 0);
            const aggregates = await getRefundAggregatesByBookingIds(ids);
            for (const row of enrichedBookings) {
                const agg = aggregates.get(Number(row.id));
                const totalRefunded = agg ? Number(agg.totalRefunded || 0) : 0;
                const count = agg ? Number(agg.count || 0) : 0;
                const isFullyRefunded = Number(row.bookingStatusId) === 21;
                row.refundSummary = {
                    totalRefunded,
                    count,
                    hasRefund: totalRefunded > 0.009 || count > 0,
                    isFullyRefunded,
                    latestReason: agg?.latestReason || null,
                    latestChannel: agg?.latestChannel || null,
                };
            }
        } catch (err) {
            console.warn(
                '[getOptimizedBookings] refund aggregates skipped:',
                err?.message || err
            );
        }

        await attachLastStatusChanges(dbModels.sequelize, enrichedBookings);

        return {
            bookings: enrichedBookings,
            totalCount,
            pagination: {
                currentPage: page,
                totalPages: totalPages,
                totalRecords: totalCount,
                recordsPerPage: limit,
                hasNextPage: hasNextPage,
                hasPrevPage: hasPrevPage,
                exportMode,
                truncated: exportMode && totalCount > limit,
            }
        };
    }

    /**
     * Get all order details with pagination and filtering
     * @param {Object} filters - Filter options
     * @param {number} page - Page number
     * @param {number} limit - Records per page
     * @returns {Object} Order details with pagination
     */
    async getAllOrderDetails(filters = {}, page = 1, limit = 20) {
        let whereClause = {};

        if (filters.status) {
            const statusId = parseInt(filters.status, 10);
            if (!Number.isNaN(statusId)) {
                whereClause.bookingStatusId = statusId;
            }
        }
        this._applyPlacedDateRangeFilter(whereClause, filters);
        this._applyZoneFilter(whereClause, filters);
        this._applyShopFilter(whereClause, filters);
        this._applyRecurringTypeFilter(whereClause, filters);

        const includeCounts = ['1', 'true', true].includes(filters.includeCounts);

        if (includeCounts) {
            const [result, counts] = await Promise.all([
                this.getOptimizedBookings(whereClause, page, limit, filters),
                this.getOrderCount(filters),
            ]);
            return {
                orderDetails: result.bookings,
                pagination: result.pagination,
                counts,
            };
        }

        const result = await this.getOptimizedBookings(whereClause, page, limit, filters);

        return {
            orderDetails: result.bookings,
            pagination: result.pagination
        };
    }

    /**
     * Get pending orders
     * @param {number} page - Page number
     * @param {number} limit - Records per page
     * @returns {Object} Pending orders with pagination
     */
    async getPendingOrders(page = 1, limit = 20, filters = {}) {
        const statusId = filters.status ? parseInt(filters.status, 10) : NaN;
        // Keep in sync with getOrderCount.pendingOrders (PENDING_EXCLUDED).
        const whereClause = !Number.isNaN(statusId)
            ? { bookingStatusId: statusId }
            : {
                bookingStatusId: {
                    [Op.notIn]: PENDING_EXCLUDED,
                },
            };
        this._applyPlacedDateRangeFilter(whereClause, filters);
        this._applyZoneFilter(whereClause, filters);
        this._applyShopFilter(whereClause, filters);
        this._applyRecurringTypeFilter(whereClause, filters);

        const includeCounts = ['1', 'true', true].includes(filters.includeCounts);
        const bookingsPromise = this.getOptimizedBookings(
            whereClause,
            page,
            limit,
            filters
        );
        const result = includeCounts
            ? await Promise.all([bookingsPromise, this.getOrderCount(filters)]).then(
                  ([list, counts]) => ({ ...list, counts })
              )
            : await bookingsPromise;

        return {
            orderDetails: result.bookings,
            pendingOrdersCount: result.totalCount,
            pagination: result.pagination,
            ...(result.counts ? { counts: result.counts } : {}),
        };
    }

    /**
     * Get cancelled orders
     * @param {number} page - Page number
     * @param {number} limit - Records per page
     * @returns {Object} Cancelled orders with pagination
     */
    async getCancelledOrders(page = 1, limit = 20, filters = {}) {
        const whereClause = {
            bookingStatusId: CANCELLED,
        };
        this._applyPlacedDateRangeFilter(whereClause, filters);
        this._applyZoneFilter(whereClause, filters);
        this._applyShopFilter(whereClause, filters);
        this._applyRecurringTypeFilter(whereClause, filters);

        const includeCounts = ['1', 'true', true].includes(filters.includeCounts);
        const bookingsPromise = this.getOptimizedBookings(
            whereClause,
            page,
            limit,
            filters
        );
        const result = includeCounts
            ? await Promise.all([bookingsPromise, this.getOrderCount(filters)]).then(
                  ([list, counts]) => ({ ...list, counts })
              )
            : await bookingsPromise;

        return {
            cancelOrders: result.bookings,
            cancelBookingCount: result.totalCount,
            pagination: result.pagination,
            ...(result.counts ? { counts: result.counts } : {}),
        };
    }

    /**
     * Get completed orders
     * @param {number} page - Page number
     * @param {number} limit - Records per page
     * @returns {Object} Completed orders with pagination
     */
    async getCompletedOrders(page = 1, limit = 20, filters = {}) {
        const whereClause = {
            bookingStatusId: COMPLETED,
        };
        this._applyPlacedDateRangeFilter(whereClause, filters);
        this._applyZoneFilter(whereClause, filters);
        this._applyShopFilter(whereClause, filters);
        this._applyRecurringTypeFilter(whereClause, filters);

        const includeCounts = ['1', 'true', true].includes(filters.includeCounts);
        const bookingsPromise = this.getOptimizedBookings(
            whereClause,
            page,
            limit,
            filters
        );
        const result = includeCounts
            ? await Promise.all([bookingsPromise, this.getOrderCount(filters)]).then(
                  ([list, counts]) => ({ ...list, counts })
              )
            : await bookingsPromise;

        return {
            allCompletedOrders: result.bookings,
            completedOrdersCount: result.totalCount,
            pagination: result.pagination,
            ...(result.counts ? { counts: result.counts } : {}),
        };
    }

    /**
     * Get single order details for editing
     * @param {number} orderId - Order ID
     * @returns {Object} Order details for editing
     */
    async getOrderForEdit(orderId) {
        const orderDetails = await booking.findOne({
            where: { id: orderId },
            include: [
                {
                    model: customerSelectedService,
                    // Only active invoice lines — an edited invoice deactivates removed
                    // lines (status:false); including them double-counts items/totals.
                    required: false,
                    where: { status: true },
                    include: [
                        { model: service, attributes: ['id', 'name', 'image'] },
                        { model: categories, attributes: ['id', 'name', 'image'] },
                        {
                            model: subCategories,
                            required: false,
                            attributes: [
                                'id',
                                'name',
                                'price',
                                'status',
                                'description',
                                'barCode',
                                'weightKg',
                                'unitCount',
                            ],
                        },
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
                                'customerSelectedServiceLineId',
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
                            attributes: [
                                'id',
                                'bookingId',
                                'customerSelectedServiceId',
                                'preferenceTypeId',
                                'preferenceValueId',
                                'parentPreferenceValueId',
                                'preferenceInstruction',
                            ],
                            include: [
                                {
                                    model: preferenceTypes,
                                    required: false,
                                    attributes: ['id', 'name'],
                                },
                                {
                                    model: preferenceValues,
                                    required: false,
                                    attributes: ['id', 'value'],
                                },
                            ],
                        },
                        buildRepairItemsInclude(dbModels),
                    ].filter(Boolean),
                },
                buildBookingLevelRepairItemsInclude(dbModels),
                {
                    model: addressDb,
                    as: 'laundryShop',
                    required: false,
                    include: [
                        {
                            model: bussinessInformation,
                            required: false,
                            attributes: [
                                'id',
                                'shopName',
                                'agentId',
                                'shopAddressId',
                                'matchProfileOptions',
                                'isConnectAccountConnected',
                            ],
                            include: [
                                {
                                    // Shop owner/agent contact info — powers the
                                    // "Call shop" action on Order Details.
                                    model: users,
                                    as: 'businessInfo',
                                    required: false,
                                    attributes: [
                                        'id',
                                        'firstName',
                                        'lastName',
                                        'email',
                                        'phoneNum',
                                        'countryCode',
                                        'status',
                                        'agentApprovalStatus',
                                    ],
                                },
                            ],
                        }
                    ],
                    attributes: ['id', 'userId', 'zoneId', 'addressType', 'streetAddress', 'district', 'province', 'postalcode']
                },
                {
                    model: billingDetails,
                    as: 'billingDetail'
                },
                {
                    model: bookingStatus,
                    attributes: ['id', 'title', 'description']
                },
                {
                    model: addressDb,
                    as: 'pickupAddress',
                    attributes: ['id', 'title', 'streetAddress', 'district', 'province']
                },
                {
                    model: addressDb,
                    as: 'dropOffAddress',
                    attributes: ['id', 'title', 'streetAddress', 'district', 'province']
                },
                {
                    model: users,
                    as: 'customer',
                    attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum', 'countryCode']
                },
                {
                    model: users,
                    as: 'driver',
                    attributes: ['id', 'firstName', 'lastName', 'email']
                },
                {
                    model: users,
                    as: 'deliveryDriver',
                    attributes: ['id', 'firstName', 'lastName', 'email']
                },
                {
                    model: users,
                    as: 'pickupCompletedBy',
                    required: false,
                    attributes: ['id', 'firstName', 'lastName', 'email']
                },
                {
                    model: users,
                    as: 'deliveryCompletedBy',
                    required: false,
                    attributes: ['id', 'firstName', 'lastName', 'email']
                },
                {
                    model: proofOfDeliveries,
                    attributes: ['id', 'imgUpload', 'noOfItems', 'noOfBags', 'note', 'deliveryType', 'bookingId', 'userId', 'createdAt', 'updatedAt']
                },
                {
                    model: tip,
                    as: 'tips',
                    required: false,
                    attributes: ['id', 'bookingId', 'amount', 'source', 'paymentType', 'paidAt', 'createdAt']
                },
                {
                    model: zone,
                    attributes: [
                        'id',
                        'name',
                        'zoneMinimumAmount',
                        'serviceCharge',
                        'zoneAdminComission',
                        'agentCommissionPercent',
                    ],
                    required: false,
                }
            ].filter(Boolean)
        });

        if (!orderDetails) {
            throw new Error("Order not found");
        }

        await ensureOrderTrackId(booking, orderDetails);

        const plain = orderDetails.get
            ? orderDetails.get({ plain: true })
            : orderDetails;
        plain.customerSelectedServices = await hydrateRepairItemsForBooking(
            dbModels,
            orderId,
            Array.isArray(plain.customerSelectedServices)
                ? plain.customerSelectedServices
                : []
        );
        plain.repairItems = normalizeRepairItems(plain.repairItems);
        plain.zoneName = plain.zone?.name || null;
        plain.commercialTerms = attachCommercialTerms(plain, plain.zone);

        // Show the actual £ split alongside the agent/platform commission %,
        // not just the percentages, using the same frozen rate terms and
        // effective laundry base the invoice itself was calculated from.
        try {
            const servicesSubtotal = await sumActiveBookingServicesSubtotal(orderId);
            const tipAmount = bookingTipAmountFromTips(plain.tips);
            const commissionBase = resolveAgentCommissionBase(
                servicesSubtotal,
                plain.commercialTerms.zoneMinimumAmount,
                plain.paymentType
            );
            const commissionAmounts = calculateAgentCommissionAmounts(
                commissionBase,
                plain.commercialTerms.agentCommissionPercent,
                tipAmount
            );
            plain.commercialTerms.commissionBaseAmount = commissionBase;
            plain.commercialTerms.agentCommissionAmount = commissionAmounts.laundryAgentShare;
            plain.commercialTerms.platformCommissionAmount = commissionAmounts.platformCommissionAmount;
            plain.commercialTerms.agentEarningWithTip = commissionAmounts.agentEarning;
        } catch (err) {
            console.warn(
                `[getOrderForEdit] commission amount breakdown unavailable for booking ${orderId}:`,
                err?.message || err
            );
        }

        const countryCtx = await getCountryContextFromZoneId(plain.zoneId);
        let agentDeclines = [];
        try {
            const agentBookingDeclineService = require('../Agent/agentBookingDeclineService');
            agentDeclines = await agentBookingDeclineService.listDeclinesForBooking(orderId);
        } catch (err) {
            console.warn(
                `[getOrderForEdit] agent declines unavailable for booking ${orderId}:`,
                err?.message || err
            );
        }
        const enriched = adminBookingAssignService.enrichBookingForAdmin(
            plain,
            countryCtx.ianaTimeZone,
            agentDeclines.length
        );
        enriched.agentDeclines = agentDeclines;

        try {
            enriched.paymentSummary =
                await invoiceManagementService.getPaymentSummaryForBooking(orderId);
        } catch (err) {
            console.warn(
                `[getOrderForEdit] paymentSummary unavailable for booking ${orderId}:`,
                err?.message || err
            );
        }

        try {
            const events = await bookingAssignmentEvent.findAll({
                where: { bookingId: orderId },
                order: [['createdAt', 'DESC'], ['id', 'DESC']],
                limit: 50,
                include: [
                    {
                        model: users,
                        as: 'fromUser',
                        attributes: ['id', 'firstName', 'lastName'],
                        required: false,
                    },
                    {
                        model: users,
                        as: 'toUser',
                        attributes: ['id', 'firstName', 'lastName'],
                        required: false,
                    },
                    {
                        model: users,
                        as: 'actedByUser',
                        attributes: ['id', 'firstName', 'lastName'],
                        required: false,
                    },
                ],
            });
            enriched.assignmentEvents = events.map((ev) =>
                ev.get ? ev.get({ plain: true }) : ev
            );
        } catch (err) {
            console.warn(
                `[getOrderForEdit] assignmentEvents unavailable for booking ${orderId}:`,
                err?.message || err
            );
            enriched.assignmentEvents = [];
        }

        try {
            const pmEvents = await bookingPaymentMethodEvent.findAll({
                where: { bookingId: orderId },
                order: [['createdAt', 'DESC'], ['id', 'DESC']],
                limit: 50,
                include: [
                    {
                        model: users,
                        as: 'actedByUser',
                        attributes: ['id', 'firstName', 'lastName'],
                        required: false,
                    },
                ],
            });
            enriched.paymentMethodEvents = pmEvents.map((ev) =>
                ev.get ? ev.get({ plain: true }) : ev
            );
        } catch (err) {
            console.warn(
                `[getOrderForEdit] paymentMethodEvents unavailable for booking ${orderId}:`,
                err?.message || err
            );
            enriched.paymentMethodEvents = [];
        }

        try {
            const attempts = await bookingAttempt.findAll({
                where: { bookingId: orderId },
                order: [['id', 'ASC']],
                include: [
                    {
                        model: attemptFailReason,
                        as: 'failReason',
                        required: false,
                    },
                    {
                        model: users,
                        as: 'driver',
                        attributes: ['id', 'firstName', 'lastName'],
                        required: false,
                    },
                ],
            });
            enriched.attempts = attempts.map((row) => {
                const a = row.get ? row.get({ plain: true }) : row;
                const charged = Number(a.feeAmount || 0) > 0 && a.feeWaived !== true;
                return {
                    id: a.id,
                    attemptType: a.attemptType,
                    attemptNumber: a.attemptNumber,
                    status: a.status,
                    arrivedAt: a.arrivedAt,
                    failedAt: a.failedAt,
                    completedAt: a.completedAt,
                    failureReason: a.failureReason,
                    failureReasonCode: a.failureReasonCode || a.failReason?.code || null,
                    failureReasonNote: a.failureReasonNote || null,
                    failureReasonLabel: a.failReason?.label || a.failureReason || null,
                    chargesFee: a.failureChargesFee != null
                        ? Boolean(a.failureChargesFee)
                        : Boolean(a.failReason?.chargesFee),
                    feeAmount: Number(a.feeAmount || 0),
                    feeCurrency: a.feeCurrency || 'GBP',
                    feeWaived: Boolean(a.feeWaived),
                    feeWaiveReason: a.feeWaiveReason || null,
                    feeCharged: charged,
                    driverName: a.driver
                        ? [a.driver.firstName, a.driver.lastName].filter(Boolean).join(' ').trim()
                        : null,
                };
            });
        } catch (err) {
            console.warn(
                `[getOrderForEdit] attempts unavailable for booking ${orderId}:`,
                err?.message || err
            );
            enriched.attempts = [];
        }

        const shopOwnerUserId =
            enriched.laundryShop?.userId != null
                ? Number(enriched.laundryShop.userId)
                : null;
        enriched.shopOwnerUserId = shopOwnerUserId;
        enriched.isPickupShopHeld =
            enriched.driverId == null ||
            (shopOwnerUserId != null &&
                Number(enriched.driverId) === shopOwnerUserId);
        enriched.isDeliveryShopHeld =
            enriched.deliveryDriverId == null ||
            (shopOwnerUserId != null &&
                Number(enriched.deliveryDriverId) === shopOwnerUserId);

        const staffName = (u) => {
            if (!u) return null;
            const n = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
            return n || null;
        };
        enriched.pickupCompletedByName = staffName(enriched.pickupCompletedBy);
        enriched.deliveryCompletedByName = staffName(enriched.deliveryCompletedBy);
        enriched.pickupStaffName =
            enriched.pickupCompletedByName || staffName(enriched.driver);
        enriched.deliveryStaffName =
            enriched.deliveryCompletedByName || staffName(enriched.deliveryDriver);
        enriched.geofenceCompliance = {
            pickupArrivedOverride: Boolean(enriched.pickupArrivedGeofenceOverride),
            deliveryArrivedOverride: Boolean(enriched.deliveryArrivedGeofenceOverride),
            pickupCompleteOverride: Boolean(enriched.pickupCompleteGeofenceOverride),
            deliveryCompleteOverride: Boolean(
                enriched.deliveryCompleteGeofenceOverride
            ),
            hasAnyOverride:
                Boolean(enriched.pickupArrivedGeofenceOverride) ||
                Boolean(enriched.deliveryArrivedGeofenceOverride) ||
                Boolean(enriched.pickupCompleteGeofenceOverride) ||
                Boolean(enriched.deliveryCompleteGeofenceOverride),
        };
        enriched.extraTip = summarizeTips(enriched.tips || []);

        try {
            const {
                getPublicRefundSummary,
                buildRefundPreview,
            } = require('./adminRefundService');
            let refundableNow = null;
            try {
                const preview = await buildRefundPreview(orderId);
                refundableNow = preview?.refundableNow;
            } catch (_) {
                /* preview optional for display */
            }
            enriched.refunds = await getPublicRefundSummary(orderId, {
                bookingStatusId: enriched.bookingStatusId,
                refundableNow,
            });
            enriched.refundSummary = {
                totalRefunded: enriched.refunds.totalRefunded,
                count: enriched.refunds.count,
                hasRefund: enriched.refunds.hasRefund,
                isFullyRefunded: enriched.refunds.isFullyRefunded,
                refundableNow:
                    refundableNow != null ? Number(refundableNow) : null,
                latestReason: enriched.refunds.latest?.reason || null,
                latestChannel: enriched.refunds.latest?.channel || null,
            };
        } catch (err) {
            console.warn(
                `[getOrderForEdit] refunds summary unavailable for booking ${orderId}:`,
                err?.message || err
            );
            enriched.refunds = {
                totalRefunded: 0,
                count: 0,
                hasRefund: false,
                isFullyRefunded: Number(enriched.bookingStatusId) === 21,
                latest: null,
                history: [],
            };
            enriched.refundSummary = {
                totalRefunded: 0,
                count: 0,
                hasRefund: false,
                isFullyRefunded: Number(enriched.bookingStatusId) === 21,
                refundableNow: null,
                latestReason: null,
                latestChannel: null,
            };
        }

        // Returning-customer signal: how many OTHER COMPLETED orders this
        // customer has finished at the SAME shop (booking.laundryShopId =
        // shop addressDb.id). Only completed orders count as real repeat
        // business. Helps admin spot a repeat customer of the shop at a glance.
        enriched.customerOrdersAtShop = 0;
        enriched.isReturningCustomerAtShop = false;
        try {
            if (plain.customerId && plain.laundryShopId) {
                const priorAtShop = await booking.count({
                    where: {
                        customerId: plain.customerId,
                        laundryShopId: plain.laundryShopId,
                        bookingStatusId: COMPLETED,
                        id: { [Op.ne]: orderId },
                    },
                });
                enriched.customerOrdersAtShop = priorAtShop;
                enriched.isReturningCustomerAtShop = priorAtShop > 0;
            }
        } catch (err) {
            console.warn(
                `[getOrderForEdit] returning-customer count unavailable for booking ${orderId}:`,
                err?.message || err
            );
        }

        return enriched;
    }

    /**
     * Get service detail catalog and booking-selected services
     * @param {number} bookingId - Booking ID
     * @returns {Object} Combined service catalog and selected services
     */
    async getServiceDetailWithBookingSelection(bookingId) {
        if (!bookingId) {
            throw new ValidationError('bookingId is required');
        }

        const bookingExists = await booking.findByPk(bookingId, { attributes: ['id', 'zoneId'] });
        if (!bookingExists) {
            throw new NotFoundError('Booking not found');
        }

        const serviceManagementService = require('./serviceManagementService');
        const allServices = await service.findAll({
            where: { status: true },
            attributes: ['id', 'name', 'status', 'image', 'description', 'timeRequired'],
        });
        const grouped = {};
        for (const svc of allServices) {
            let tree = await serviceManagementService.getServiceCategoriesDataForService(svc.id);
            tree = await zoneCatalogService.applyToServiceCategoriesData(
                tree,
                bookingExists.zoneId,
                svc.id
            );
            if (!tree.length) continue;
            grouped[svc.id] = {
                serviceId: svc.id,
                service: {
                    id: svc.id,
                    name: svc.name,
                    status: svc.status,
                    image: svc.image || null,
                    description: svc.description || null,
                    turnAroundTime: svc.timeRequired || null,
                },
                categories: tree.map((row) => ({
                    categoryId: row.categoryId,
                    category: {
                        id: row.category.id,
                        name: row.category.name,
                        status: true,
                        image: row.category.image || null,
                        description: row.category.description || null,
                    },
                    subCategories: (row.category.subCategories || []).map((subCat) => {
                        const plain = subCat.toJSON ? subCat.toJSON() : subCat;
                        return {
                            id: plain.id,
                            name: plain.name,
                            status: plain.status,
                            price: plain.price,
                            unitCount: plain.unitCount ?? null,
                        };
                    }),
                })),
            };
        }
        const ServiceCategoriesList = Object.values(grouped);

        const selectedServices = await customerSelectedService.findAll({
            where: {
                bookingId,
                status: true
            },
            include: [
                {
                    model: service,
                    attributes: ['id', 'name', 'status', 'image'],
                    required: false
                },
                {
                    model: categories,
                    attributes: ['id', 'name', 'status', 'image', 'description'],
                    required: false
                },
                {
                    model: subCategories,
                    attributes: ['id', 'name', 'status', 'price', 'unitCount'],
                    required: false
                },
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
                        'customerSelectedServiceLineId',
                    ],
                    include: [
                        {
                            model: addOnServices,
                            as: 'addOnService',
                            attributes: ['id', 'name', 'price']
                        }
                    ]
                },
                {
                    model: bookingPreference,
                    as: 'selectedServicePreferences',
                    required: false,
                    attributes: [
                        'id',
                        'customerSelectedServiceId',
                        'preferenceTypeId',
                        'preferenceValueId',
                        'parentPreferenceValueId',
                        'preferenceInstruction'
                    ],
                    include: [
                        {
                            model: preferenceTypes,
                            attributes: ['id', 'name'],
                            required: false
                        },
                        {
                            model: preferenceValues,
                            attributes: ['id', 'value'],
                            required: false
                        }
                    ]
                },
                buildRepairItemsInclude(dbModels),
            ].filter(Boolean),
            attributes: [
                'id',
                'date',
                'time',
                'serviceId',
                'categoryId',
                'subCategoryId',
                'items',
                'categoryPrice',
                'serviceInstruction'
            ]
        });

        const hydratedSelectedServices = await hydrateRepairItemsForBooking(
            dbModels,
            bookingId,
            selectedServices.map((row) =>
                row.toJSON ? row.toJSON() : row
            )
        );

        const selectedServiceIdSet = new Set(
            hydratedSelectedServices
                .map(item => item?.serviceId)
                .filter(Boolean)
        );

        const catalogWithSelectionFlag = ServiceCategoriesList.map(serviceItem => ({
            ...serviceItem,
            isSelectedInBooking: selectedServiceIdSet.has(serviceItem.serviceId)
        }));

        return {
            bookingId: Number(bookingId),
            serviceDetails: catalogWithSelectionFlag,
            bookingSelectedServices: hydratedSelectedServices
        };
    }

    /**
     * Edit order - Comprehensive order management
     * @param {number} orderId - Order ID
     * @param {Object} orderData - Order update data
     * @param {string} orderData.collectionDate - Collection date
     * @param {string} orderData.collectionTimeFrom - Collection time from
     * @param {string} orderData.collectionTimeTo - Collection time to
     * @param {string} orderData.deliveryDate - Delivery date
     * @param {string} orderData.deliveryTimeFrom - Delivery time from
     * @param {string} orderData.deliveryTimeTo - Delivery time to
     * @param {string} orderData.driverInstruction - Driver instruction
     * @param {string} orderData.driverInstructionOptions - Driver instruction options
     * @param {string} orderData.driverInstructionOptions1 - Driver instruction options 1
     * @param {string} orderData.frequency - Frequency (e.g., "Just Once")
     * @param {number} orderData.totalItems - Total items
     * @param {number} orderData.bookingStatusId - Booking status ID
     * @param {Object} orderData.pickUpAddress - Pick up address object with lat, lng, streetAddress, etc.
     * @param {Object} orderData.dropOffAddress - Drop off address object
     * @param {boolean} orderData.updatePickupAddress - Flag to update pickup address
     * @param {boolean} orderData.updateDropOffAddress - Flag to update drop off address
     * @param {boolean} orderData.dropOffSamePickUp - Flag if drop off same as pickup
     * @param {Array} orderData.services - Array of services with serviceId, categoryId, subCategoryId, categoryCharge
     * @param {Object} orderData.billingData - Billing details object
     * @param {Array} orderData.preferencesArray - Array of preferences with preferenceTypeId, preferenceValueId
     * @param {number} orderData.tipAmount - Tip amount
     * @returns {Object} Updated order data
     */
    async editOrder(orderId, orderData) {
        const {
            collectionDate,
            collectionTimeFrom,
            collectionTimeTo,
            deliveryDate,
            deliveryTimeFrom,
            deliveryTimeTo,
            driverInstruction,
            driverInstructionOptions,
            driverInstructionOptions1,
            frequency,
            totalItems,
            bookingStatusId,
            pickUpAddress,
            dropOffAddress,
            updatePickupAddress,
            updateDropOffAddress,
            dropOffSamePickUp,
            services,
            billingData,
            preferencesArray,
            tipAmount,
            driverId,
            deliveryDriverId,
            laundryShopId,
        } = orderData;

        // Check if order exists
        const existingOrder = await booking.findOne({
            where: { id: orderId },
            include: [
                {
                    model: customerSelectedService,
                    include: [
                        { model: service, attributes: ['id', 'name'] },
                        { model: categories, attributes: ['id', 'name'] }
                    ]
                },
                {
                    model: billingDetails,
                    as: 'billingDetail'
                },
                {
                    model: addressDb,
                    as: 'pickupAddress',
                    attributes: ['id', 'title', 'streetAddress', 'district', 'province', 'lat', 'lng', 'cityId', 'countryId']
                },
                {
                    model: addressDb,
                    as: 'dropOffAddress',
                    attributes: ['id', 'title', 'streetAddress', 'district', 'province', 'lat', 'lng', 'cityId', 'countryId']
                },
                {
                    model: tip,
                    as: 'tips',
                    required: false,
                    attributes: ['id', 'amount', 'source', 'paymentType', 'paidAt', 'createdAt']
                },
                {
                    model: zone,
                    attributes: [
                        'id',
                        'name',
                        'zoneAdminComission',
                        'agentCommissionPercent',
                        'zoneMinimumAmount',
                        'serviceCharge',
                    ],
                },
            ]
        });

        if (!existingOrder) {
            throw new NotFoundError('Order not found');
        }

        // Prepare update data object (only include fields that are provided)
        const orderUpdateData = {};
        if (collectionDate !== undefined) orderUpdateData.collectionDate = collectionDate;
        if (collectionTimeFrom !== undefined) orderUpdateData.collectionTimeFrom = collectionTimeFrom;
        if (collectionTimeTo !== undefined) orderUpdateData.collectionTimeTo = collectionTimeTo;
        if (deliveryDate !== undefined) orderUpdateData.deliveryDate = deliveryDate;
        if (deliveryTimeFrom !== undefined) orderUpdateData.deliveryTimeFrom = deliveryTimeFrom;
        if (deliveryTimeTo !== undefined) orderUpdateData.deliveryTimeTo = deliveryTimeTo;
        if (driverInstruction !== undefined) orderUpdateData.driverInstruction = driverInstruction;
        if (driverInstructionOptions !== undefined) orderUpdateData.driverInstructionOptions = driverInstructionOptions;
        if (driverInstructionOptions1 !== undefined) orderUpdateData.driverInstructionOptions1 = driverInstructionOptions1;
        if (frequency !== undefined) {
            // Admin UI uses "Every week"; DB enum is "Weekly"
            orderUpdateData.frequency =
                frequency === "Every week" ? "Weekly" : frequency;
        }
        if (totalItems !== undefined) orderUpdateData.totalItems = totalItems;
        if (bookingStatusId !== undefined) orderUpdateData.bookingStatusId = bookingStatusId;
        if (driverId !== undefined) orderUpdateData.driverId = driverId;
        if (deliveryDriverId !== undefined) orderUpdateData.deliveryDriverId = deliveryDriverId;
        if (laundryShopId !== undefined) orderUpdateData.laundryShopId = laundryShopId;

        // Handle pickup address update
        let pickupAddressId = existingOrder.pickupAddresId;
        if (updatePickupAddress && pickUpAddress) {
            // Validate and get zone info from pickup address
            let findZone = await this.findZones(pickUpAddress.lat, pickUpAddress.lng);
            if (!findZone || findZone.length === 0) {
                throw new NotFoundError("No Zone found for these pickup address coordinates");
            }

            let cityId = pickUpAddress.cityId || findZone[0].city.id;
            let countryId = pickUpAddress.countryId || findZone[0].city.country.id;
            let zoneId = findZone[0].id;

            // Update existing pickup address
            await addressDb.update(
                {
                    title: pickUpAddress.title,
                    streetAddress: pickUpAddress.streetAddress,
                    district: pickUpAddress.district,
                    province: pickUpAddress.province,
                    lat: pickUpAddress.lat,
                    lng: pickUpAddress.lng,
                    postalcode: pickUpAddress.postalcode,
                    cityId: cityId,
                    countryId: countryId
                },
                { where: { id: existingOrder.pickupAddresId } }
            );

            // Update zone if changed
            if (existingOrder.zoneId !== zoneId) {
                orderUpdateData.zoneId = zoneId;
            }
        }

        // Handle drop off address update
        let dropOffAddressId = existingOrder.dropOffAddressId;
        if (dropOffSamePickUp) {
            orderUpdateData.dropOffAddressId = pickupAddressId;
        } else if (updateDropOffAddress && dropOffAddress) {
            // Update existing drop off address
            await addressDb.update(
                {
                    title: dropOffAddress.title,
                    streetAddress: dropOffAddress.streetAddress,
                    district: dropOffAddress.district,
                    province: dropOffAddress.province,
                    lat: dropOffAddress.lat,
                    lng: dropOffAddress.lng,
                    postalcode: dropOffAddress.postalcode,
                    cityId: dropOffAddress.cityId,
                    countryId: dropOffAddress.countryId
                },
                { where: { id: existingOrder.dropOffAddressId } }
            );
        }

        // Invoice line payload (category/subCategory/items/addOns) — same path as agent invoice sync.
        // Stub-only `{ serviceId }` arrays must not create orphan lines or wipe add-ons.
        const hasInvoiceLineDetails =
            Array.isArray(services) &&
            services.some(
                (svc) =>
                    svc?.categoryId != null ||
                    svc?.subCategoryId != null ||
                    (svc?.id != null && Number.isFinite(Number(svc.id))) ||
                    serviceLineHasAddOnPayload(svc) ||
                    (svc?.items != null && Number(svc.items) > 0)
            );

        let syncedInvoiceLines = false;

        if (hasInvoiceLineDetails) {
            const { date: currentDate, time: currentTime } = adminWallClockDateTime(
                orderData.timeZone,
                orderData.clientTimeZone
            );
            await invoiceManagementService.syncInvoiceDraftServiceLines({
                bookingId: orderId,
                services,
                currentDate,
                currentTime,
            });
            syncedInvoiceLines = true;
        }

        // Update tip if provided (tips table only — bookings has no tipId column)
        if (tipAmount !== undefined) {
            const existingBillingForTip = await billingDetails.findOne({
                where: { bookingId: orderId },
            });
            const prepaidTipAmount = lockPrepaidTipAmount(
                existingOrder.paymentType,
                existingBillingForTip?.prepaidTipAmount,
                bookingTipAmountFromTips(existingOrder.tips)
            );
            if (existingBillingForTip) {
                await billingDetails.update(
                    { prepaidTipAmount },
                    { where: { bookingId: orderId } }
                );
            }

            const { bookingTips } = splitTips(existingOrder.tips);
            const existingTip = bookingTips[0] || null;

            if (existingTip) {
                await tip.update(
                    { amount: tipAmount },
                    { where: { id: existingTip.id } }
                );
            } else {
                await tip.create({
                    bookingId: orderId,
                    amount: tipAmount,
                    source: 'booking',
                });
            }
        }

        // After line/tip changes, recompute invoice like agent updateInvoice
        if (syncedInvoiceLines || tipAmount !== undefined) {
            const refreshedBooking = await booking.findByPk(orderId, {
                include: [
                    {
                        model: zone,
                        attributes: [
                            'id',
                            'name',
                            'zoneAdminComission',
                            'agentCommissionPercent',
                            'zoneMinimumAmount',
                            'serviceCharge',
                        ],
                    },
                    {
                        model: tip,
                        as: 'tips',
                        attributes: ['id', 'amount', 'source', 'paymentType', 'paidAt', 'createdAt'],
                        required: false,
                    },
                ],
            });
            const totals = await invoiceManagementService.calculateInvoiceTotals(
                refreshedBooking,
                orderId
            );
            const serviceCharge =
                billingData?.serviceCharge !== undefined
                    ? billingData.serviceCharge
                    : totals.parsedServiceCharge;
            const upfrontAmount =
                billingData?.upfrontAmount !== undefined
                    ? billingData.upfrontAmount
                    : totals.parsedZoneMinimum;

            orderUpdateData.orderAmount = totals.total;
            orderUpdateData.subTotal = totals.subTotal;
            // syncInvoiceDraftServiceLines already wrote physical totalItems
            delete orderUpdateData.totalItems;

            const existingBilling = await billingDetails.findOne({ where: { bookingId: orderId } });
            const billingPayload = {
                total: totals.total,
                discount: totals.existingDiscount || 0,
                categoryCharge: totals.servicesSubtotal,
                serviceCharge,
                upfrontAmount,
                zoneAdminCommission: totals.finalZoneAdminCommissionAmount,
                agentEarning: totals.finalAgentEarningAmount,
            };
            if (existingBilling?.prepaidTipAmount != null) {
                billingPayload.prepaidTipAmount = existingBilling.prepaidTipAmount;
            }
            if (existingBilling) {
                await billingDetails.update(billingPayload, { where: { bookingId: orderId } });
            } else {
                await billingDetails.create({
                    bookingId: orderId,
                    ...billingPayload,
                });
            }
        } else if (billingData) {
            const billingUpdateData = {};
            if (billingData.upfrontAmount !== undefined) billingUpdateData.upfrontAmount = billingData.upfrontAmount;
            if (billingData.discount !== undefined) billingUpdateData.discount = billingData.discount;
            if (billingData.total !== undefined) billingUpdateData.total = billingData.total;
            if (billingData.serviceCharge !== undefined) billingUpdateData.serviceCharge = billingData.serviceCharge;
            if (billingData.categoryCharge !== undefined) billingUpdateData.categoryCharge = billingData.categoryCharge;
            if (billingData.zoneAdminCommission !== undefined) billingUpdateData.zoneAdminCommission = billingData.zoneAdminCommission;
            if (billingData.pickupDriverEarning !== undefined) billingUpdateData.pickupDriverEarning = billingData.pickupDriverEarning;
            if (billingData.deliveryDriverEarning !== undefined) billingUpdateData.deliveryDriverEarning = billingData.deliveryDriverEarning;
            if (billingData.paymentStatus !== undefined) billingUpdateData.paymentStatus = billingData.paymentStatus;
            if (billingData.total !== undefined) orderUpdateData.orderAmount = billingData.total;

            const existingBilling = await billingDetails.findOne({ where: { bookingId: orderId } });

            if (existingBilling) {
                await billingDetails.update(billingUpdateData, { where: { bookingId: orderId } });
            } else {
                await billingDetails.create({
                    bookingId: orderId,
                    ...billingUpdateData
                });
            }
        }

        // Replace preferences only when the client sends a non-empty list (empty would wipe agent prefs)
        if (Array.isArray(preferencesArray) && preferencesArray.length > 0) {
            await bookingPreference.destroy({ where: { bookingId: orderId } });

            const serviceIds = services
                ? services.map((s) => s.serviceId)
                : existingOrder.customerSelectedServices.map((s) => s.serviceId);
            const scopedServiceIds = serviceIds
                .map((id) => Number(id))
                .filter((id) => Number.isFinite(id) && id > 0);

            const bookingPreferencesToCreate = [];

            for (const pref of preferencesArray) {
                const { preferenceTypeId, preferenceValueId, serviceId, parentPreferenceValueId } = pref;

                if (!preferenceTypeId || !preferenceValueId) {
                    throw new ValidationError(
                        "preferenceTypeId and preferenceValueId are required for each preference"
                    );
                }

                if (serviceId) {
                    const servicePreferenceExists = await serviceWithPreferences.findOne({
                        where: {
                            serviceId: serviceId,
                            preferenceTypeId: preferenceTypeId,
                            status: true
                        }
                    });

                    if (!servicePreferenceExists) {
                        throw new ValidationError(
                            `Preference type ${preferenceTypeId} is not available for service ${serviceId}`
                        );
                    }
                    await zoneCatalogService.assertPreferenceEnabled(existingOrder.zoneId, {
                        serviceId,
                        preferenceTypeId,
                    });
                } else {
                    const servicePreferenceExists = await serviceWithPreferences.findOne({
                        where: {
                            serviceId: { [Op.in]: scopedServiceIds },
                            preferenceTypeId: preferenceTypeId,
                            status: true
                        }
                    });

                    if (!servicePreferenceExists) {
                        throw new ValidationError(
                            `Preference type ${preferenceTypeId} is not available for any selected services`
                        );
                    }
                    await zoneCatalogService.assertPreferenceEnabled(existingOrder.zoneId, {
                        preferenceTypeId,
                        serviceIds: scopedServiceIds,
                    });
                }

                const preferenceValue = await preferenceValues.findOne({
                    where: {
                        id: preferenceValueId,
                        preferenceTypeId: preferenceTypeId,
                        status: true
                    }
                });

                if (!preferenceValue) {
                    throw new ValidationError(
                        `Preference value ${preferenceValueId} is invalid or does not belong to preference type ${preferenceTypeId}`
                    );
                }

                bookingPreferencesToCreate.push({
                    bookingId: orderId,
                    preferenceTypeId: preferenceTypeId,
                    preferenceValueId: preferenceValueId,
                    parentPreferenceValueId: parentPreferenceValueId || null
                });
            }

            if (bookingPreferencesToCreate.length > 0) {
                await bookingPreference.bulkCreate(bookingPreferencesToCreate);
            }
        }

        // Update the booking record
        if (Object.keys(orderUpdateData).length > 0) {
            await booking.update(orderUpdateData, { where: { id: orderId } });
        }

        // Fetch and return updated order with all relations
        const updatedOrder = await booking.findOne({
            where: { id: orderId },
            include: [
                {
                    model: customerSelectedService,
                    include: [
                        { model: service, attributes: ['id', 'name', 'status'] },
                        { model: categories, attributes: ['id', 'name', 'status'] }
                    ]
                },
                {
                    model: billingDetails,
                    as: 'billingDetail'
                },
                {
                    model: bookingStatus,
                    attributes: ['id', 'title', 'description']
                },
                {
                    model: addressDb,
                    as: 'pickupAddress',
                    attributes: ['id', 'title', 'streetAddress', 'district', 'province', 'lat', 'lng']
                },
                {
                    model: addressDb,
                    as: 'dropOffAddress',
                    attributes: ['id', 'title', 'streetAddress', 'district', 'province', 'lat', 'lng']
                },
                {
                    model: bookingPreference,
                    as: 'bookingPreferences'
                },
                {
                    model: tip,
                    as: 'tips',
                    required: false,
                    attributes: ['id', 'amount', 'source', 'paymentType', 'paidAt', 'createdAt']
                },
                {
                    model: zone,
                    attributes: ['id', 'name', 'zoneMinimumAmount', 'serviceCharge']
                },
                {
                    model: users,
                    as: 'customer',
                    attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum', 'countryCode']
                },
                {
                    model: users,
                    as: 'driver',
                    attributes: ['id', 'firstName', 'lastName', 'email']
                },
                {
                    model: users,
                    as: 'deliveryDriver',
                    attributes: ['id', 'firstName', 'lastName', 'email']
                }
            ]
        });

        return updatedOrder;
    }

    /**
     * Helper function to find zones
     * @param {number} lat - Latitude
     * @param {number} lng - Longitude
     * @returns {Array} Zone data
     */
    async findZones(lat, lng) {
        const { findZones } = require("../../utils/findZones");
        return findZones(lat, lng);
    }
    /**
     * Get on-hold bookings (paginated)
     * @param {number} page
     * @param {number} limit
     * @returns {Object}
     */
    async getOnHoldBookings(page = 1, limit = 25, filters = {}) {
        const whereClause = {
            bookingStatusId: {
                [Op.in]: ON_HOLD,
            },
        };
        this._applyPlacedDateRangeFilter(whereClause, filters);
        this._applyZoneFilter(whereClause, filters);
        this._applyShopFilter(whereClause, filters);
        this._applyRecurringTypeFilter(whereClause, filters);

        const includeCounts = ['1', 'true', true].includes(filters.includeCounts);
        const bookingsPromise = this.getOptimizedBookings(
            whereClause,
            page,
            limit,
            filters
        );
        const result = includeCounts
            ? await Promise.all([bookingsPromise, this.getOrderCount(filters)]).then(
                  ([list, counts]) => ({ ...list, counts })
              )
            : await bookingsPromise;

        return {
            onHoldBookings: result.bookings,
            onHoldOrdersCount: result.totalCount,
            pagination: result.pagination,
            ...(result.counts ? { counts: result.counts } : {}),
        };
    }

    /**
     * Soft delete order
     * @param {number} orderId - Order ID
     * @returns {Object} Deletion result
     */
    async deleteOrder(orderId) {
        // Check if order exists
        const orderExists = await booking.findOne({
            where: {
                id: orderId
            }
        });

        if (!orderExists) {
            throw new NotFoundError('Order not found');
        }

        // Check if order is already deleted (if deletedAt field exists)
        if (orderExists.deletedAt) {
            throw new ConflictError('Order is already deleted');
        }

        // Check if order can be deleted (optional: check if order is in a state that allows deletion)
        // For example, you might want to prevent deletion of orders that are in processing
        const restrictedStatuses = [11]; // Processing status - adjust as needed
        if (restrictedStatuses.includes(orderExists.bookingStatusId)) {
            throw new UnprocessableEntityError('Cannot delete order that is currently being processed');
        }

        // Soft delete the order using update with deletedAt timestamp
        // Note: This requires a deletedAt field in the bookings table
        // If the field doesn't exist, you need to add it via migration
        const deletedOrder = await booking.update(
            { deletedAt: new Date() },
            {
                where: {
                    id: orderId
                }
            }
        );

        if (deletedOrder[0] === 0) {
            throw new ValidationError('Failed to delete order');
        }

        return {
            orderId,
            message: 'Order deleted successfully',
            deletedAt: new Date()
        };
    }

    /**
     * Update invoice services (Admin side)
     * Mirrors agent invoice-creation business logic in service-controller style.
     * @param {Object} data - Request data
     * @returns {Object} Invoice update summary
     */
    async updateInvoice(data) {
        const {
            services,
            bookingId,
            timeZone,
            clientTimeZone,
        } = data;

        if (!Array.isArray(services) || services.length === 0) {
            throw new ValidationError("Invalid request. Please provide an array of services.");
        }

        const { date: currentDate, time: currentTime } = adminWallClockDateTime(
            timeZone,
            clientTimeZone
        );

        const bookings = await booking.findByPk(bookingId, {
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
                    as: 'tips',
                    attributes: ['id', 'amount', 'source', 'paymentType', 'paidAt', 'createdAt'],
                    required: false
                }
            ]
        });

        if (!bookings) {
            throw new NotFoundError("Booking not found");
        }

        const zoneData = bookings.zone;
        if (!zoneData) {
            throw new NotFoundError("Zone information not found for this booking");
        }

        if (Array.isArray(services) && services.length > 0) {
            await invoiceManagementService.syncInvoiceDraftServiceLines({
                bookingId,
                services,
                currentDate,
                currentTime,
            });
        }

        const totals = await invoiceManagementService.calculateInvoiceTotals(
            bookings,
            bookingId
        );
        const {
            servicesSubtotal,
            subTotal,
            total,
            agentCommissionPercent,
            finalZoneAdminCommissionAmount,
            finalAgentEarningAmount,
        } = totals;

        if (Number.isNaN(total)) {
            throw new Error("Calculated total is NaN. Please check your input values.");
        }

        await billingDetails.update(
            {
                total,
                discount: totals.existingDiscount || 0,
                paymentStatus: "Pending",
                zoneAdminCommission: finalZoneAdminCommissionAmount,
                agentEarning: finalAgentEarningAmount,
                serviceCharge: totals.parsedServiceCharge,
            },
            { where: { bookingId } }
        );

        await bookingHistory.create({
            date: currentDate,
            time: currentTime,
            bookingId,
            bookingStatusId: 9,
        });

        await booking.update(
            {
                orderAmount: total,
                bookingStatusId: 9,
                subTotal,
            },
            { where: { id: bookingId } }
        );

        return {
            bookingId,
            servicesSubtotal,
            total,
            subTotal,
            agentCommissionPercent,
            agentEarning: finalAgentEarningAmount,
            zoneAdminCommission: finalZoneAdminCommissionAmount,
        };
    }
}

module.exports = new OrderService();

