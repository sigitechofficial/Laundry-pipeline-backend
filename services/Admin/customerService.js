const { users, booking } = require('../../models');
const sequelize = require('sequelize');
const { Op } = require('sequelize');
const { 
    ValidationError, 
    NotFoundError, 
    ConflictError,
    UnprocessableEntityError 
} = require('../../middlewares/universalErrorHandler');

class CustomerService {
    /**
     * Get all customers with booking statistics
     * @returns {Array} List of customers with booking counts and amounts
     */
    async getAllCustomers(startPage = 1, endPage = 10, offset = 0) {
        // Calculate limit based on start and end page
        const limit = (endPage - startPage + 1) * 10; // Assuming 10 items per page
        const calculatedOffset = offset + ((startPage - 1) * 10);

        const findCustomers = await users.findAll({
            where: {
                userTypeId: 2,  // Ensuring we're fetching only customers
            },
            attributes: [
                'id',
                'firstName',
                'lastName',
                'email',
                'phoneNum',
                'status',
                [
                    sequelize.literal(`(
                SELECT COUNT(*) 
                FROM bookings 
                WHERE bookings.customerId = users.id
              )`),
                    'bookingCount'
                ],
                [
                    sequelize.literal(`(
                SELECT COALESCE(SUM(orderAmount), 0) 
                FROM bookings 
                WHERE bookings.customerId = users.id
              )`),
                    'totalAmountSpent'
                ],
                [
                    sequelize.literal(`(
                SELECT MAX(createdAt) 
                FROM bookings 
                WHERE bookings.customerId = users.id
              )`),
                    'lastBookingDate'
                ]
            ],
            limit: limit,
            offset: calculatedOffset,
            order: [['createdAt', 'DESC']] // Add ordering for consistent pagination
        });

        // Get total count for pagination info
        const totalCount = await users.count({
            where: {
                userTypeId: 2,
            }
        });

        // Format the last booking date and totalAmountSpent
        const formattedCustomers = findCustomers.map(customer => {
            const customerData = customer.toJSON(); // Convert to plain object
            return {
                ...customerData,
                lastBookingDate: customerData.lastBookingDate
                    ? new Date(customerData.lastBookingDate).toISOString().split('T')[0]
                    : null,
                totalAmountSpent: customerData.totalAmountSpent.toFixed(2) // Limit to 2 decimals
            };
        });

        return {
            customers: formattedCustomers,
            pagination: {
                currentPage: startPage,
                totalPages: Math.ceil(totalCount / 10),
                totalCount: totalCount,
                hasNextPage: endPage < Math.ceil(totalCount / 10),
                hasPreviousPage: startPage > 1
            }
        };
    }

    /**
     * Get customer count statistics
     * @returns {Object} Customer count metrics
     */
    async getCustomerCount() {
            const customerCount = await users.count({
                where: {
                    userTypeId: 2
                }
            });

            const fourDayAgo = new Date();
            fourDayAgo.setDate(fourDayAgo.getDate() - 4);

            const recentCustomer = await users.count({
                where: {
                    userTypeId: 2,
                    createdAt: {
                        [Op.gte]: fourDayAgo
                    }
                }
            });

            const activeUser = await users.count({
                where: {
                    status: true,
                    userTypeId: 2
                }
            });

            const repeatCustomers = await booking.findAll({
                attributes: [
                    'customerId',
                    [sequelize.fn('COUNT', sequelize.col('customerId')), 'RepeatingCustomerCount']
                ],
                group: ['customerId'],
                having: sequelize.literal('COUNT(customerId) > 1'),
                order: [[sequelize.fn('COUNT', sequelize.col('customerId')), 'DESC']],
                include: [
                    {
                        model: users,
                        as: 'customer',
                        attributes: ['id', 'email', 'firstName', 'lastName']
                    }
                ]
            });

            const repeatCustomersCount = repeatCustomers.length;

            return {
                TotalCustomer: customerCount,
                NewCustomers: recentCustomer,
                activeUser: activeUser,
                RepeatedCustomers: repeatCustomersCount
            };
    }

    /**
     * Get specific customer details with bookings
     * @param {number} customerId - Customer ID
     * @returns {Object} Customer details with booking information
     */
    async getSpecificCustomerDetails(customerId) {
            const { addressDb, customerSelectedService, OnHoldConfirmation, bookingStatus, bussinessInformation } = require('../../models');

            const [bookingsFind, userInfo] = await Promise.all([
                booking.findAll({
                    where: { customerId },
                    include: [
                        {
                            model: customerSelectedService,
                            include: [
                                {
                                    model: require('../../models').service,
                                    attributes: ['name']
                                }
                            ],
                            attributes: ['id', 'date', 'time', 'items', 'serviceId', 'categoryPrice'],
                        },
                        {
                            model: OnHoldConfirmation,
                            required: false,
                            attributes: ['onHoldImg', 'noOfItems', 'description', 'bookingId'],
                        },
                        {
                            model: addressDb,
                            as: 'laundryShop',
                            include: {
                                model: bussinessInformation,
                                attributes: ['shopName'],
                            },
                            attributes: ['id'],
                        },
                        {
                            model: bookingStatus,
                            attributes: ['title', 'description'],
                        },
                        {
                            model: users,
                            as: 'driver',
                            attributes: ['id', 'firstName', 'lastName', 'email','phoneNum']
                        },
                        {
                            model: users,
                            as: 'deliveryDriver',
                            attributes: ['id', 'firstName', 'lastName', 'email','phoneNum']
                        }
                    ],
                    order: [['id', 'DESC']],
                    attributes: {
                        exclude: [
                            'updatedAt', 'categoryId', 'serviceId', 'subCategoryId', 'vehicleTypeId',
                            'driverInstructionOptions', 'driverInstructionOptions1', 'paymentConfirmed',
                            'partialPayment', 'subTotal', 'frequency', 'onHoldReason', 'OnHoldOtherReason',
                            'paymentMethodId', 'paymentIntentId', 'pickupAddresId', 'dropOffAddressId', 'tipId'
                        ],
                    },
                }),

                addressDb.findOne({
                    where: { userId: customerId },
                    include: [
                        {
                            model: users,
                            attributes: ['id', 'firstName', 'lastName', 'email','phoneNum'],
                        },
                    ],
                    order: [['createdAt', 'DESC']],
                    attributes: ['id', 'title', 'streetAddress', 'district', 'province', 'lat', 'lng', 'status', 'addressType', 'userId'],
                }),
            ]);

            return {
                bookingDetails: bookingsFind,
                userDetails: userInfo ? userInfo.toJSON() : {},
            };
    }

    /**
     * Update customer details
     * @param {number} customerId - Customer ID
     * @param {Object} updateData - Customer update data
     * @returns {Object} Updated customer data
     */
    async updateCustomer(customerId, updateData) {
            const { firstName, lastName, email, phoneNum, status } = updateData;

            // Check if customer exists
            const customerExists = await users.findOne({
                where: {
                    id: customerId,
                    userTypeId: 2 // Ensure it's a customer
                }
            });

            if (!customerExists) {
                throw new NotFoundError('Customer not found');
            }

            // Check if email is being changed and if it already exists
            if (email && email !== customerExists.email) {
                const emailExists = await users.findOne({
                    where: {
                        email: email,
                        id: { [Op.ne]: customerId },
                        userTypeId: 2
                    }
                });

                if (emailExists) {
                    throw new ConflictError('Email already exists');
                }
            }

            // Update customer details
            const updateFields = {};
            if (firstName) updateFields.firstName = firstName;
            if (lastName) updateFields.lastName = lastName;
            if (email) updateFields.email = email;
            if (phoneNum) updateFields.phoneNum = phoneNum;
            if (status !== undefined) updateFields.status = status;

            const updatedCustomer = await users.update(updateFields, {
                where: {
                    id: customerId,
                    userTypeId: 2
                }
            });

            if (updatedCustomer[0] === 0) {
                throw new ValidationError('No changes were made');
            }

            // Get updated customer data
            const updatedCustomerData = await users.findOne({
                where: {
                    id: customerId,
                    userTypeId: 2
                },
                attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum', 'status', 'createdAt']
            });

            return updatedCustomerData;
    }

    /**
     * Delete customer (soft delete)
     * @param {number} customerId - Customer ID
     * @returns {Object} Deletion result
     */
    async deleteCustomer(customerId) {
            // Check if customer exists
            const customerExists = await users.findOne({
                where: {
                    id: customerId,
                    userTypeId: 2 // Ensure it's a customer
                }
            });

            if (!customerExists) {
                throw new NotFoundError('Customer not found');
            }

            // Check if customer has any active bookings
            const activeBookings = await booking.count({
                where: {
                    customerId: customerId,
                    bookingStatusId: {
                        [Op.notIn]: [17, 19, 23] // Exclude completed, cancelled, and failed bookings
                    }
                }
            });

            if (activeBookings > 0) {
                throw new UnprocessableEntityError(`Customer has ${activeBookings} active booking(s). Please complete or cancel all bookings first.`);
            }

            // Soft delete the customer (set status to false)
            const deletedCustomer = await users.update(
                { status: false },
                {
                    where: {
                        id: customerId,
                        userTypeId: 2
                    }
                }
            );

            if (deletedCustomer[0] === 0) {
                throw new ValidationError('Failed to delete customer');
            }

            return { customerId, message: 'Customer deleted successfully' };
    }
}

module.exports = new CustomerService();
