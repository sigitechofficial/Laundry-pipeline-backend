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
const sequelize = require('sequelize');
const momentTz = require('moment-timezone');
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
    /**
     * Get order count statistics
     * @returns {Object} Order count metrics
     */
    async getOrderCount() {
            const allOrderCount = await booking.count();

            const completedOrder = await booking.count({
                where: {
                    bookingStatusId: 17
                }
            });

            const onHoldOrders = await booking.count({
                where: {
                    bookingStatusId: {
                        [Op.or]: [18, 24]
                    }
                }
            });

            const cancelledOrders = await booking.count({
                where: {
                    bookingStatusId: 19
                }
            });

            const pendingOrders = await booking.count({
                where: {
                    bookingStatusId: {
                        [Op.notIn]: [17, 18, 19, 24] // Not completed, on hold, or cancelled
                    }
                }
            });

            return {
                allOrderCount: allOrderCount,
                completedOrders: completedOrder,
                onHoldOrders: onHoldOrders,
                cancelledOrders: cancelledOrders,
                pendingOrders: pendingOrders
            };
    }

    /**
     * Get optimized bookings with pagination and filtering
     * @param {Object} whereClause - Sequelize where clause
     * @param {number} page - Page number
     * @param {number} limit - Records per page
     * @returns {Object} Bookings with pagination info
     */
    async getOptimizedBookings(whereClause, page = 1, limit = 50) {
            const offset = (page - 1) * limit;

            // Get total count
            const totalCount = await booking.count({ where: whereClause });

            // Get bookings with optimized includes
            const bookings = await booking.findAll({
                where: whereClause,
                include: [
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
                ],
                order: [['id', 'DESC']],
                limit: limit,
                offset: offset,
                attributes: {
                    exclude: ['updatedAt', 'categoryId', 'serviceId', 'subCategoryId', 'vehicleTypeId']
                },
                logging: false,
                benchmark: false
            });

            // Calculate pagination info
            const totalPages = Math.ceil(totalCount / limit);
            const hasNextPage = page < totalPages;
            const hasPrevPage = page > 1;

            return {
                bookings,
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
                whereClause.bookingStatusId = filters.status;
            }
            if (filters.date) {
                whereClause.createdAt = {
                    [Op.gte]: new Date(filters.date),
                    [Op.lt]: new Date(new Date(filters.date).getTime() + 24 * 60 * 60 * 1000)
                };
            }

            const result = await this.getOptimizedBookings(whereClause, page, limit);

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
    async getPendingOrders(page = 1, limit = 20) {
            const whereClause = {
                bookingStatusId: {
                    [Op.ne]: [17, 23]
                }
            };

            const result = await this.getOptimizedBookings(whereClause, page, limit);

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
    async getCancelledOrders(page = 1, limit = 20) {
            const whereClause = {
                bookingStatusId: {
                    [Op.eq]: [19]
                }
            };

            const result = await this.getOptimizedBookings(whereClause, page, limit);

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
    async getCompletedOrders(page = 1, limit = 20) {
            const whereClause = {
                bookingStatusId: {
                    [Op.eq]: [17]
                }
            };

            const result = await this.getOptimizedBookings(whereClause, page, limit);

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
                        attributes: ['id', 'imgUpload', 'noOfItems', 'note', 'deliveryType', 'bookingId', 'userId']
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

            return orderDetails;
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

            // Update services if provided
            if (Array.isArray(services) && services.length > 0) {
                // Delete existing services
                await customerSelectedService.destroy({ where: { bookingId: orderId } });

                // Calculate charges
                categoryCharge = services.reduce(
                    (acc, svc) => acc + parseFloat(svc.categoryCharge || 0),
                    0
                );
                orderAmount = categoryCharge;

                const currentTime = new Date().toLocaleTimeString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                });
                const currentDate = new Date().toISOString().split("T")[0];

                // Create new services
                const serviceData = services.map((svc) => {
                    let serviceObj = {
                        bookingId: orderId,
                        serviceId: svc.serviceId,
                        date: svc.date || currentDate,
                        time: svc.time || currentTime,
                        items: svc.items || 1,
                        categoryPrice: svc.categoryCharge || 0
                    };
                    
                    if (svc.categoryId) serviceObj.categoryId = svc.categoryId;
                    if (svc.subCategoryId) serviceObj.subCategoryId = svc.subCategoryId;
                    if (svc.servicePrice) serviceObj.servicePrice = svc.servicePrice;
                    if (svc.status !== undefined) serviceObj.status = svc.status;

                    return serviceObj;
                });

                await customerSelectedService.bulkCreate(serviceData);
                
                // Update order amount
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
     * Get all on hold bookings
     * @returns {Object} All on hold bookings
     */
    async getOnHoldBookings() {
        const onHoldBookings = await booking.findAll({ 
            where: 
            { 
                bookingStatusId: {
                    [Op.or]: [18, 24]
                }
            } 
        });
        return {
            message: "All on hold bookings retrieved successfully",
            data: { onHoldBookings }
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
                    attributes: ['id', 'name', 'zoneAdminComission']
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

        let total = 0;

        for (const serviceItem of services) {
            const itemTotalPrice = parseFloat(serviceItem.categoryCharge || 0);
            total += itemTotalPrice;

            const existingRecords = await customerSelectedService.findAll({
                where: {
                    bookingId,
                    serviceId: serviceItem.serviceId,
                    subCategoryId: { [Op.is]: null },
                    categoryId: { [Op.is]: null },
                }
            });

            let matched = existingRecords.find(r => r.subCategoryId === serviceItem.subCategoryId);
            if (!matched) {
                matched = existingRecords.find(r => r.subCategoryId === null);
            }

            let selectedServiceRow;
            if (matched) {
                await matched.update({
                    categoryId: serviceItem.categoryId,
                    categoryPrice: itemTotalPrice,
                    subCategoryId: serviceItem.subCategoryId,
                    items: serviceItem.items,
                    date: currentDate,
                    time: currentTime,
                    status: true
                });
                selectedServiceRow = matched;
            } else {
                selectedServiceRow = await customerSelectedService.create({
                    date: currentDate,
                    time: currentTime,
                    bookingId,
                    serviceId: serviceItem.serviceId,
                    categoryId: serviceItem.categoryId,
                    categoryPrice: itemTotalPrice,
                    subCategoryId: serviceItem.subCategoryId,
                    items: serviceItem.items,
                    status: true
                });
            }

            if (Array.isArray(serviceItem.addOnServiceIds)) {
                await customerSelectedServiceAddOn.destroy({
                    where: { customerSelectedServiceId: selectedServiceRow.id }
                });

                if (serviceItem.addOnServiceIds.length > 0) {
                    const addOnRecords = await addOnServices.findAll({
                        where: { id: serviceItem.addOnServiceIds }
                    });
                    for (const addOn of addOnRecords) {
                        const addOnPrice = parseFloat(addOn.price || 0);
                        total += addOnPrice;
                        await customerSelectedServiceAddOn.create({
                            customerSelectedServiceId: selectedServiceRow.id,
                            addOnServiceId: addOn.id,
                            price: addOnPrice
                        });
                    }
                }
            }
        }

        const parsedServiceCharge = parseFloat(serviceCharge) || 0;
        const parsedZoneMinimum = parseFloat(zoneMinimumAmount) || 0;
        const tipAmount = bookings.tips && bookings.tips.length > 0
            ? bookings.tips.reduce((sum, t) => sum + parseFloat(t.amount || 0), 0)
            : 0;

        let subTotal = total + parsedServiceCharge + parsedZoneMinimum + tipAmount;
        total = subTotal - parsedZoneMinimum;

        const zoneAdminCommission = parseFloat(zoneData.zoneAdminComission || 20);
        const zoneAdminCommissionAmount = (subTotal * zoneAdminCommission) / 100;

        total = parseFloat(total.toFixed(2));
        subTotal = parseFloat(subTotal.toFixed(2));
        const finalZoneAdminCommissionAmount = parseFloat(zoneAdminCommissionAmount.toFixed(2));

        if (isNaN(total)) {
            throw new Error("Calculated total is NaN. Please check your input values.");
        }

        await billingDetails.update(
            {
                total,
                discount: 0,
                paymentStatus: "Pending",
                zoneAdminCommission: finalZoneAdminCommissionAmount,
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
            total,
            subTotal,
            zoneAdminCommission: finalZoneAdminCommissionAmount
        };
    }
}

module.exports = new OrderService();

