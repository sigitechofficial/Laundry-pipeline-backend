const { booking, customerSelectedService, OnHoldConfirmation, addressDb, bussinessInformation, bookingStatus, service, categories, billingDetails } = require('../../models');
const { Op } = require('sequelize');

class OrderService {
    /**
     * Get order count statistics
     * @returns {Object} Order count metrics
     */
    async getOrderCount() {
        try {
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

            return {
                allOrderCount: allOrderCount,
                completedOrders: completedOrder,
                onHoldOrders: onHoldOrders
            };
        } catch (error) {
            throw new Error(`Order count service error: ${error.message}`);
        }
    }

    /**
     * Get optimized bookings with pagination and filtering
     * @param {Object} whereClause - Sequelize where clause
     * @param {number} page - Page number
     * @param {number} limit - Records per page
     * @returns {Object} Bookings with pagination info
     */
    async getOptimizedBookings(whereClause, page = 1, limit = 50) {
        try {
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
        } catch (error) {
            throw new Error(`Optimized bookings service error: ${error.message}`);
        }
    }

    /**
     * Get all order details with pagination and filtering
     * @param {Object} filters - Filter options
     * @param {number} page - Page number
     * @param {number} limit - Records per page
     * @returns {Object} Order details with pagination
     */
    async getAllOrderDetails(filters = {}, page = 1, limit = 20) {
        try {
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
        } catch (error) {
            throw new Error(`All order details service error: ${error.message}`);
        }
    }

    /**
     * Get pending orders
     * @param {number} page - Page number
     * @param {number} limit - Records per page
     * @returns {Object} Pending orders with pagination
     */
    async getPendingOrders(page = 1, limit = 20) {
        try {
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
        } catch (error) {
            throw new Error(`Pending orders service error: ${error.message}`);
        }
    }

    /**
     * Get cancelled orders
     * @param {number} page - Page number
     * @param {number} limit - Records per page
     * @returns {Object} Cancelled orders with pagination
     */
    async getCancelledOrders(page = 1, limit = 20) {
        try {
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
        } catch (error) {
            throw new Error(`Cancelled orders service error: ${error.message}`);
        }
    }

    /**
     * Get completed orders
     * @param {number} page - Page number
     * @param {number} limit - Records per page
     * @returns {Object} Completed orders with pagination
     */
    async getCompletedOrders(page = 1, limit = 20) {
        try {
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
        } catch (error) {
            throw new Error(`Completed orders service error: ${error.message}`);
        }
    }

    /**
     * Get single order details for editing
     * @param {number} orderId - Order ID
     * @returns {Object} Order details for editing
     */
    async getOrderForEdit(orderId) {
        try {
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
        } catch (error) {
            throw new Error(`Get order for edit service error: ${error.message}`);
        }
    }
}

module.exports = new OrderService();
