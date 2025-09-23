const { users, booking } = require('../../models');
const sequelize = require('sequelize');
const { Op } = require('sequelize');

class CustomerService {
    /**
     * Get all customers with booking statistics
     * @returns {Array} List of customers with booking counts and amounts
     */
    async getAllCustomers() {
        try {
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
                ]
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

            return formattedCustomers;
        } catch (error) {
            throw new Error(`Customer service error: ${error.message}`);
        }
    }

    /**
     * Get customer count statistics
     * @returns {Object} Customer count metrics
     */
    async getCustomerCount() {
        try {
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
        } catch (error) {
            throw new Error(`Customer count service error: ${error.message}`);
        }
    }

    /**
     * Get specific customer details with bookings
     * @param {number} customerId - Customer ID
     * @returns {Object} Customer details with booking information
     */
    async getSpecificCustomerDetails(customerId) {
        try {
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
                            attributes: ['id', 'firstName', 'lastName', 'email']
                        },
                        {
                            model: users,
                            as: 'deliveryDriver',
                            attributes: ['id', 'firstName', 'lastName', 'email']
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
                            attributes: ['id', 'firstName', 'lastName', 'email'],
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
        } catch (error) {
            throw new Error(`Specific customer details service error: ${error.message}`);
        }
    }
}

module.exports = new CustomerService();
