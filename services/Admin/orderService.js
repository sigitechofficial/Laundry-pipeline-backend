const { booking, customerSelectedService, OnHoldConfirmation, addressDb, bussinessInformation, bookingStatus, service, categories, billingDetails } = require('../../models');
const { Op } = require('sequelize');
const { 
    ValidationError, 
    NotFoundError, 
    ConflictError,
    UnprocessableEntityError 
} = require('../../middlewares/universalErrorHandler');

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
            const { users } = require('../../models');

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
                        model: billingDetails
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
                    }
                ]
            });

            if (!orderDetails) {
                throw new Error("Order not found");
            }

            return orderDetails;
    }

    /**
     * Edit order - Comprehensive order management
     * @param {number} orderId - Order ID
     * @param {Object} orderData - Order update data
     * @returns {Object} Updated order data
     */
    async editOrder(orderId, orderData) {
            const {
                orderTrackId,
                collectionDate,
                collectionTimeFrom,
                collectionTimeTo,
                deliveryDate,
                deliveryTimeFrom,
                deliveryTimeTo,
                driverInstructionOptions,
                driverInstructionOptions1,
                driverInstruction,
                totalItems,
                orderAmount,
                subTotal,
                frequency,
                bookingStatusId,
                services,
                billingDetails
            } = orderData;

            // Check if order exists
            const orderExists = await booking.findOne({
                where: { id: orderId },
                include: [
                    {
                        model: customerSelectedService,
                        include: [
                            { model: service, attributes: ['id', 'name'] },
                            { model: categories, attributes: ['id', 'name'] }
                        ]
                    },
                    { model: billingDetails }
                ]
            });

            if (!orderExists) {
                throw new Error('Order not found');
            }

            // Update basic order fields
            const orderUpdateData = {
                orderTrackId,
                collectionDate,
                collectionTimeFrom,
                collectionTimeTo,
                deliveryDate,
                deliveryTimeFrom,
                deliveryTimeTo,
                driverInstructionOptions,
                driverInstructionOptions1,
                driverInstruction,
                totalItems,
                orderAmount,
                subTotal,
                frequency,
                bookingStatusId
            };

            await booking.update(orderUpdateData, { where: { id: orderId } });

            // Update services
            if (Array.isArray(services)) {
                await customerSelectedService.destroy({ where: { bookingId: orderId } });

                const serviceData = services.map(s => ({
                    bookingId: orderId,
                    serviceId: s.serviceId,
                    categoryId: s.categoryId,
                    date: s.date || new Date(),
                    time: s.time || new Date().toTimeString().slice(0, 8),
                    items: s.items || 1,
                    servicePrice: s.servicePrice || 0,
                    categoryPrice: s.categoryPrice || 0,
                    status: s.status !== undefined ? s.status : true
                }));

                await customerSelectedService.bulkCreate(serviceData);
            }

            // Update billing details
            if (billingDetails) {
                const billingUpdateData = {
                    upfrontAmount: billingDetails.upfrontAmount,
                    discount: billingDetails.discount,
                    total: billingDetails.total,
                    zoneAdminCommission: billingDetails.zoneAdminCommission,
                    serviceCharge: billingDetails.serviceCharge,
                    categoryCharge: billingDetails.categoryCharge,
                    pickupDriverEarning: billingDetails.pickupDriverEarning,
                    deliveryDriverEarning: billingDetails.deliveryDriverEarning,
                    paymentStatus: billingDetails.paymentStatus
                };

                const existingBilling = await billingDetails.findOne({ where: { bookingId: orderId } });

                if (existingBilling) {
                    await billingDetails.update(billingUpdateData, { where: { bookingId: orderId } });
                } else {
                    await billingDetails.create({ bookingId: orderId, ...billingUpdateData });
                }
            }

            // Fetch updated order
            const updatedOrder = await booking.findOne({
                where: { id: orderId },
                include: [
                    {
                        model: customerSelectedService,
                        include: [
                            { model: service, attributes: ['id', 'name'] },
                            { model: categories, attributes: ['id', 'name'] }
                        ]
                    },
                    { model: billingDetails },
                    { model: bookingStatus, attributes: ['id', 'title', 'description'] },
                    { model: addressDb, as: 'pickupAddress', attributes: ['id', 'title', 'streetAddress', 'district', 'province'] },
                    { model: addressDb, as: 'dropOffAddress', attributes: ['id', 'title', 'streetAddress', 'district', 'province'] }
                ]
            });

            return updatedOrder;
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
}

module.exports = new OrderService();
