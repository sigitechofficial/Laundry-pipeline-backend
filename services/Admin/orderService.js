const {
    booking,
    customerSelectedService,
    customerSelectedServiceAddOn,
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
    users
} = require('../../models');
const { Op } = require('sequelize');
const adminBookingAssignService = require('./adminBookingAssignService');
const invoiceManagementService = require('../Agent/invoiceManagementService');
const {
    resolveAgentCommissionPercent,
    resolveAgentCommissionBase,
    calculateAgentCommissionAmounts,
} = require('../../utils/agentCommission');
const sequelize = require('sequelize');
const momentTz = require('moment-timezone');
const {
    getLineQuantity,
    getUnitCategoryCharge,
    serviceLineHasAddOnPayload,
    replaceAddOnsForServiceLine,
    sumActiveBookingServicesSubtotal,
} = require('../../utils/invoiceLineTotals');
const { getPrepaidInvoiceDeduction } = require('../../utils/invoicePrepaidDeduction');
const { getCountryContextFromZoneId } = require('../../utils/countryTimeZone');
const invoiceManagementService = require('../Agent/invoiceManagementService');
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
    _applyZoneFilter(whereClause, filters = {}) {
        if (filters.zoneId == null || String(filters.zoneId).trim() === "") {
            return;
        }
        const zoneId = parseInt(filters.zoneId, 10);
        if (!Number.isNaN(zoneId)) {
            whereClause.zoneId = zoneId;
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
                { "$customer.phone$": { [Op.like]: like } },
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
                attributes: ['id', 'date', 'time', 'items', 'serviceId', 'categoryPrice'],
                include: [
                    {
                        model: service,
                        attributes: ['id', 'name', 'status']
                    },
                    {
                        model: categories,
                        attributes: ['id', 'name']
                    }
                ]
            },
            {
                model: OnHoldConfirmation,
                required: false,
                attributes: ['onHoldImg', 'noOfItems', 'description', 'bookingId']
            },
            {
                model: addressDb,
                as: 'laundryShop',
                include: {
                    model: bussinessInformation,
                    attributes: ['shopName']
                },
                attributes: ['id']
            },
            {
                model: bookingStatus,
                attributes: ['title', 'description']
            }
        ];
        if (includeCustomer) {
            includes.push({
                model: users,
                as: 'customer',
                attributes: ['id', 'firstName', 'lastName', 'email', 'phone'],
                required: false,
            });
        }
        return includes;
    }

    /**
     * @param {Object} [filters] - Optional zone/date scope (same as order lists)
     * @returns {Object} Order count metrics
     */
    async getOrderCount(filters = {}) {
        const scoped = {};
        this._applyZoneFilter(scoped, filters);
        this._applyPlacedDateRangeFilter(scoped, filters);

        const countWhere = (extra = {}) => ({ ...scoped, ...extra });

        const allOrderCount = await booking.count({ where: scoped });

        const completedOrder = await booking.count({
            where: countWhere({ bookingStatusId: 17 }),
        });

        const onHoldOrders = await booking.count({
            where: countWhere({
                bookingStatusId: {
                    [Op.or]: [18, 24],
                },
            }),
        });

        const cancelledOrders = await booking.count({
            where: countWhere({ bookingStatusId: 19 }),
        });

        const pendingOrders = await booking.count({
            where: countWhere({
                bookingStatusId: {
                    [Op.notIn]: [17, 18, 19, 24],
                },
            }),
        });

        const newOrders = await booking.count({
            where: countWhere({ bookingStatusId: 1 }),
        });

        const activeOrders = await booking.count({
            where: countWhere({
                bookingStatusId: {
                    [Op.notIn]: [1, 17, 18, 19, 24],
                },
            }),
        });

        const repeatCustomerRows = await booking.findAll({
            attributes: ['customerId'],
            where: countWhere({ customerId: { [Op.ne]: null } }),
            group: ['customerId'],
            having: sequelize.literal('COUNT(customerId) > 1'),
            raw: true,
        });
        const repeatCustomerIds = repeatCustomerRows
            .map((row) => row.customerId)
            .filter(Boolean);
        const repeatOrders =
            repeatCustomerIds.length > 0
                ? await booking.count({
                      where: countWhere({
                          customerId: { [Op.in]: repeatCustomerIds },
                      }),
                  })
                : 0;

        const paymentFailuresCount = await booking.count({
            where: countWhere({
                paymentType: "card",
                paymentDeliveryGate: "waiting_admin",
                bookingStatusId: { [Op.lt]: 17 },
            }),
        });

        return {
            allOrderCount: allOrderCount,
            completedOrders: completedOrder,
            onHoldOrders: onHoldOrders,
            cancelledOrders: cancelledOrders,
            pendingOrders: pendingOrders,
            newOrders,
            NewOrders: newOrders,
            activeOrders,
            repeatOrders,
            paymentFailuresCount: paymentFailuresCount,
        };
    }

    /**
     * Get optimized bookings with pagination and filtering
     * @param {Object} whereClause - Sequelize where clause
     * @param {number} page - Page number
     * @param {number} limit - Records per page
     * @returns {Object} Bookings with pagination info
     */
    async getOptimizedBookings(whereClause, page = 1, limit = 50, search = '') {
        const offset = (page - 1) * limit;
        const { where, searchActive } = this._buildWhereWithSearch(whereClause, search);
        const includes = this._bookingListIncludes(searchActive);

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

        const totalCount = await booking.count({
            where,
            include: countIncludes,
            distinct: true,
            col: 'id',
        });

        const bookings = await booking.findAll({
            where,
            include: includes,
            order: [['id', 'DESC']],
            limit: limit,
            offset: offset,
            attributes: {
                exclude: ['updatedAt', 'categoryId', 'serviceId', 'subCategoryId', 'vehicleTypeId']
            },
            logging: false,
            benchmark: false,
            subQuery: searchActive ? false : undefined,
        });

        // Calculate pagination info
        const totalPages = Math.ceil(totalCount / limit);
        const hasNextPage = page < totalPages;
        const hasPrevPage = page > 1;

        const enrichedBookings =
            await adminBookingAssignService.enrichBookingsForAdminList(bookings);

        return {
            bookings: enrichedBookings,
            totalCount,
            pagination: {
                currentPage: page,
                totalPages: totalPages,
                totalRecords: totalCount,
                recordsPerPage: limit,
                hasNextPage: hasNextPage,
                hasPrevPage: hasPrevPage
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

        const result = await this.getOptimizedBookings(whereClause, page, limit, filters.search);

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
        const whereClause = !Number.isNaN(statusId)
            ? { bookingStatusId: statusId }
            : {
                bookingStatusId: {
                    [Op.ne]: [17, 23],
                },
            };
        this._applyPlacedDateRangeFilter(whereClause, filters);
        this._applyZoneFilter(whereClause, filters);

        const result = await this.getOptimizedBookings(whereClause, page, limit, filters.search);

        return {
            orderDetails: result.bookings,
            pendingOrdersCount: result.totalCount,
            pagination: result.pagination
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
            bookingStatusId: {
                [Op.eq]: [19]
            }
        };
        this._applyPlacedDateRangeFilter(whereClause, filters);
        this._applyZoneFilter(whereClause, filters);

        const result = await this.getOptimizedBookings(whereClause, page, limit, filters.search);

        return {
            cancelOrders: result.bookings,
            cancelBookingCount: result.totalCount,
            pagination: result.pagination
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
            bookingStatusId: {
                [Op.eq]: [17]
            }
        };
        this._applyPlacedDateRangeFilter(whereClause, filters);
        this._applyZoneFilter(whereClause, filters);

        const result = await this.getOptimizedBookings(whereClause, page, limit, filters.search);

        return {
            allCompletedOrders: result.bookings,
            completedOrdersCount: result.totalCount,
            pagination: result.pagination
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
                    include: [
                        { model: service, attributes: ['id', 'name'] },
                        { model: categories, attributes: ['id', 'name'] }
                    ]
                },
                {
                    model: addressDb,
                    as: 'laundryShop',
                    required: false,
                    include: [
                        {
                            model: bussinessInformation,
                            required: false,
                            attributes: ['id', 'shopName', 'agentId', 'shopAddressId']
                        }
                    ],
                    attributes: ['id', 'userId', 'zoneId', 'addressType']
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
                    attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum']
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
                    model: proofOfDeliveries,
                    attributes: ['id', 'imgUpload', 'noOfItems', 'noOfBags', 'note', 'deliveryType', 'bookingId', 'userId']
                },
                {
                    model: tip,
                    as: 'tips',
                    required: false,
                    attributes: ['id', 'bookingId', 'amount']
                }
            ]
        });

        if (!orderDetails) {
            throw new Error("Order not found");
        }

        const plain = orderDetails.get
            ? orderDetails.get({ plain: true })
            : orderDetails;
        const countryCtx = await getCountryContextFromZoneId(plain.zoneId);
        const enriched = adminBookingAssignService.enrichBookingForAdmin(
            plain,
            countryCtx.ianaTimeZone,
            0
        );

        try {
            enriched.paymentSummary =
                await invoiceManagementService.getPaymentSummaryForBooking(orderId);
        } catch (err) {
            console.warn(
                `[getOrderForEdit] paymentSummary unavailable for booking ${orderId}:`,
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

        const bookingExists = await booking.findByPk(bookingId, { attributes: ['id'] });
        if (!bookingExists) {
            throw new NotFoundError('Booking not found');
        }

        const serviceData = await serviceCategories.findAll({
            where: { status: true },
            include: [
                {
                    model: service,
                    attributes: ['id', 'name', 'status', 'image', 'description', 'timeRequired'],
                    required: true
                },
                {
                    model: categories,
                    attributes: ['id', 'name', 'status', 'image', 'description'],
                    required: true,
                    include: [
                        {
                            model: subCategories,
                            attributes: ['id', 'name', 'status', 'price', 'unitCount'],
                            required: false
                        }
                    ]
                }
            ]
        });

        const grouped = {};
        for (const item of serviceData) {
            const plainItem = item.toJSON ? item.toJSON() : item;
            const serviceObj = plainItem.service;
            const categoryObj = plainItem.category || plainItem.categories;

            if (!serviceObj || !categoryObj) continue;

            if (!grouped[serviceObj.id]) {
                grouped[serviceObj.id] = {
                    serviceId: serviceObj.id,
                    service: {
                        id: serviceObj.id,
                        name: serviceObj.name,
                        status: serviceObj.status,
                        image: serviceObj.image || null,
                        description: serviceObj.description || null,
                        turnAroundTime: serviceObj.timeRequired || null
                    },
                    categories: []
                };
            }

            const existingCategory = grouped[serviceObj.id].categories.find(
                cat => cat.categoryId === categoryObj.id
            );

            if (!existingCategory) {
                grouped[serviceObj.id].categories.push({
                    categoryId: categoryObj.id,
                    category: {
                        id: categoryObj.id,
                        name: categoryObj.name,
                        status: categoryObj.status,
                        image: categoryObj.image || null,
                        description: categoryObj.description || null
                    },
                    subCategories: (categoryObj.subCategories || []).map(subCat => ({
                        id: subCat.id,
                        name: subCat.name,
                        status: subCat.status,
                        price: subCat.price,
                        unitCount: subCat.unitCount ?? null
                    }))
                });
            }
        }

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
                    attributes: ['id', 'addOnServiceId', 'price'],
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
                }
            ],
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

        const selectedServiceIdSet = new Set(
            selectedServices
                .map(item => item?.serviceId)
                .filter(Boolean)
        );

        const catalogWithSelectionFlag = Object.values(grouped).map(serviceItem => ({
            ...serviceItem,
            isSelectedInBooking: selectedServiceIdSet.has(serviceItem.serviceId)
        }));

        return {
            bookingId: Number(bookingId),
            serviceDetails: catalogWithSelectionFlag,
            bookingSelectedServices: selectedServices
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
            tipAmount
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
                    attributes: ['id', 'amount']
                }
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
        if (frequency !== undefined) orderUpdateData.frequency = frequency;
        if (totalItems !== undefined) orderUpdateData.totalItems = totalItems;
        if (bookingStatusId !== undefined) orderUpdateData.bookingStatusId = bookingStatusId;

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

        // Calculate totals from services
        let categoryCharge = 0;
        let orderAmount = 0;

            // Update services if provided (merge with existing rows, do not delete old entries)
            if (Array.isArray(services) && services.length > 0) {
                const currentTime = new Date().toLocaleTimeString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                });
                const currentDate = new Date().toISOString().split("T")[0];

                const existingServices = await customerSelectedService.findAll({
                    where: { bookingId: orderId }
                });

                const getServiceKey = (svc) => [
                    String(svc.serviceId ?? ""),
                    String(svc.categoryId ?? ""),
                    String(svc.subCategoryId ?? "")
                ].join("|");

                const existingByKey = new Map();
                for (const existingSvc of existingServices) {
                    existingByKey.set(getServiceKey(existingSvc), existingSvc);
                }

                for (const svc of services) {
                    const serviceKey = getServiceKey(svc);
                    const matchedService = existingByKey.get(serviceKey);

                    const servicePayload = {
                        bookingId: orderId,
                        serviceId: svc.serviceId,
                        date: svc.date || currentDate,
                        time: svc.time || currentTime,
                        items: svc.items || 1,
                        categoryPrice: svc.categoryCharge || 0
                    };

                    if (svc.categoryId) servicePayload.categoryId = svc.categoryId;
                    if (svc.subCategoryId) servicePayload.subCategoryId = svc.subCategoryId;
                    if (svc.servicePrice) servicePayload.servicePrice = svc.servicePrice;
                    if (svc.status !== undefined) servicePayload.status = svc.status;
                    if (svc.serviceInstruction) servicePayload.serviceInstruction = svc.serviceInstruction;
                    const bagVal = svc.bags ?? svc.bagsCount;
                    if (bagVal != null && bagVal !== "") {
                        const n = Number(bagVal);
                        if (Number.isFinite(n) && n > 0) servicePayload.bags = Math.floor(n);
                    }

                    if (matchedService) {
                        await matchedService.update(servicePayload);
                    } else {
                        await customerSelectedService.create(servicePayload);
                    }
                }

                const allBookingServices = await customerSelectedService.findAll({
                    where: { bookingId: orderId }
                });

                // Recalculate from all services so previously saved lines are preserved
                categoryCharge = allBookingServices.reduce(
                    (acc, svc) => acc + parseFloat(svc.categoryPrice || 0),
                    0
                );
                orderAmount = categoryCharge;

                if (orderAmount > 0) {
                    orderUpdateData.orderAmount = orderAmount;
                    orderUpdateData.subTotal = orderAmount;
                }
            }

        // Update booking preferences
        if (preferencesArray && Array.isArray(preferencesArray)) {
            // Delete existing preferences
            await bookingPreference.destroy({ where: { bookingId: orderId } });

            if (preferencesArray.length > 0) {
                // Get service IDs from the booking
                const serviceIds = services ? services.map(s => s.serviceId) :
                    existingOrder.customerSelectedServices.map(s => s.serviceId);

                const bookingPreferencesToCreate = [];

                for (const pref of preferencesArray) {
                    const { preferenceTypeId, preferenceValueId, serviceId, parentPreferenceValueId } = pref;

                    if (!preferenceTypeId || !preferenceValueId) {
                        throw new ValidationError(
                            "preferenceTypeId and preferenceValueId are required for each preference"
                        );
                    }

                    // Validate preference belongs to service
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
                    } else {
                        const servicePreferenceExists = await serviceWithPreferences.findOne({
                            where: {
                                serviceId: { [Op.in]: serviceIds },
                                preferenceTypeId: preferenceTypeId,
                                status: true
                            }
                        });

                        if (!servicePreferenceExists) {
                            throw new ValidationError(
                                `Preference type ${preferenceTypeId} is not available for any selected services`
                            );
                        }
                    }

                    // Validate preference value
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
        }

        // Update tip if provided
        if (tipAmount !== undefined) {
            const existingTip = Array.isArray(existingOrder.tips) && existingOrder.tips.length > 0
                ? existingOrder.tips[0]
                : null;

            if (existingTip) {
                await tip.update(
                    { amount: tipAmount },
                    { where: { id: existingTip.id } }
                );
            } else {
                const newTip = await tip.create({
                    bookingId: orderId,
                    amount: tipAmount
                });
                orderUpdateData.tipId = newTip.id;
            }
        }

        // Update billing details if provided
        if (billingData) {
            const billingUpdateData = {};
            if (billingData.upfrontAmount !== undefined) billingUpdateData.upfrontAmount = billingData.upfrontAmount;
            if (billingData.discount !== undefined) billingUpdateData.discount = billingData.discount;
            if (billingData.total !== undefined) billingUpdateData.total = billingData.total;
            if (billingData.serviceCharge !== undefined) billingUpdateData.serviceCharge = billingData.serviceCharge;
            if (billingData.categoryCharge !== undefined) billingUpdateData.categoryCharge = billingData.categoryCharge;
            if (categoryCharge > 0) billingUpdateData.categoryCharge = categoryCharge;
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
                    attributes: ['id', 'amount']
                },
                {
                    model: zone,
                    attributes: ['id', 'name', 'zoneMinimumAmount', 'serviceCharge']
                },
                {
                    model: users,
                    as: 'customer',
                    attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum']
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
        const findZone = await zone.findAll({
            where: {
                status: true,
                coordinates: sequelize.where(
                    sequelize.fn(
                        "ST_Contains",
                        sequelize.col("coordinates"),
                        sequelize.fn("ST_GeomFromText", `POINT(${lng} ${lat})`)
                    ),
                    true
                ),
            },
            include: [
                {
                    model: cities,
                    attributes: ["id", "name", "lat", "lng", "status"],
                    include: [
                        {
                            model: countries,
                            attributes: ["id", "name", "shortName", "status"],
                        },
                    ],
                },
            ],
            attributes: ["id", "zoneMinimumAmount", "serviceCharge", "status"],
        });
        return findZone;
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
                [Op.or]: [18, 24],
            },
        };
        this._applyPlacedDateRangeFilter(whereClause, filters);
        this._applyZoneFilter(whereClause, filters);

        const result = await this.getOptimizedBookings(whereClause, page, limit, filters.search);

        return {
            onHoldBookings: result.bookings,
            onHoldOrdersCount: result.totalCount,
            pagination: result.pagination,
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
            zoneMinimumAmount,
            serviceCharge,
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
                    attributes: ['id', 'name', 'zoneAdminComission', 'agentCommissionPercent']
                },
                {
                    model: tip,
                    as: 'tips',
                    attributes: ['id', 'amount'],
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

        const servicesSubtotal = await sumActiveBookingServicesSubtotal(bookingId);

        const parsedServiceCharge = parseFloat(serviceCharge) || 0;
        const parsedZoneMinimum = parseFloat(zoneMinimumAmount) || 0;
        const tipAmount = bookings.tips && bookings.tips.length > 0
            ? bookings.tips.reduce((sum, t) => sum + parseFloat(t.amount || 0), 0)
            : 0;

        let subTotal =
            servicesSubtotal + parsedServiceCharge + parsedZoneMinimum + tipAmount;
        const prepaidDeduction = getPrepaidInvoiceDeduction(
            parsedZoneMinimum,
            parsedServiceCharge,
            tipAmount
        );
        let total = subTotal - prepaidDeduction;

        subTotal = parseFloat(subTotal.toFixed(2));
        total = parseFloat(total.toFixed(2));

        const agentCommissionPercent = resolveAgentCommissionPercent(zoneData);
        const commissionBase = resolveAgentCommissionBase(
            servicesSubtotal,
            tipAmount,
            parsedZoneMinimum,
            bookings.paymentType
        );
        const commissionAmounts = calculateAgentCommissionAmounts(
            commissionBase,
            agentCommissionPercent
        );
        const finalZoneAdminCommissionAmount = commissionAmounts.platformCommissionAmount;
        const finalAgentEarningAmount = commissionAmounts.agentEarning;

        if (isNaN(total)) {
            throw new Error("Calculated total is NaN. Please check your input values.");
        }

        await billingDetails.update(
            {
                total,
                discount: 0,
                paymentStatus: "Pending",
                zoneAdminCommission: finalZoneAdminCommissionAmount,
                agentEarning: finalAgentEarningAmount,
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

