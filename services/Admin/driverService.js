const { users, booking, driverInZones, proofOfDeliveries, addressDb, bussinessInformation, roles } = require('../../models');
const { Op } = require('sequelize');

class DriverService {
    /**
     * Get driver count statistics
     * @returns {Object} Driver count metrics
     */
    async getDriverCount() {
        try {
            const driverCount = await users.count({
                where: {
                    roleId: 6,
                    classifiedAsId: 1
                }
            });

            const shopAgentDrivers = await users.count({
                where: {
                    roleId: 6,
                    classifiedAsId: 1
                }
            });

            const availableDrivers = await users.count({
                where: {
                    status: true,
                    classifiedAsId: 1,
                    roleId: 6
                }
            });

            const blockDrivers = await users.count({
                where: {
                    status: false,
                    classifiedAsId: 1,
                    roleId: 6
                }
            });

            return {
                totalDrivers: driverCount,
                shopAgentDrivers: shopAgentDrivers,
                availableDrivers: availableDrivers,
                blockDrivers: blockDrivers
            };
        } catch (error) {
            throw new Error(`Driver count service error: ${error.message}`);
        }
    }

    /**
     * Get all drivers with booking statistics
     * @returns {Array} List of drivers with order counts and earnings
     */
    async getAllDriversWithStats() {
        try {
            const findDrivers = await users.findAll({
                where: {
                    roleId: 6,
                    classifiedAsId: 1,
                    status: true
                },
                attributes: [
                    'id',
                    'firstName',
                    'lastName',
                    'email',
                    'userTypeId',
                    'classifiedAsId',
                    'roleId',
                    'status',
                    'createdAt'
                ],
                include: [
                    {
                        model: roles,
                        attributes: ['name']
                    }
                ]
            });

            // Get booking counts for each driver
            const driversWithBookingCounts = await Promise.all(
                findDrivers.map(async (driver) => {
                    const driverId = driver.id;

                    // Get pickup orders count
                    const pickupOrdersCount = await booking.count({
                        where: {
                            driverId: driverId
                        }
                    });

                    // Get delivery orders count
                    const deliveryOrdersCount = await booking.count({
                        where: {
                            deliveryDriverId: driverId
                        }
                    });

                    // Get total orders count
                    const totalOrdersCount = await booking.count({
                        where: {
                            [Op.or]: [
                                { driverId: driverId },
                                { deliveryDriverId: driverId }
                            ]
                        }
                    });

                    // Get completed orders count
                    const completedOrdersCount = await booking.count({
                        where: {
                            [Op.or]: [
                                { driverId: driverId },
                                { deliveryDriverId: driverId }
                            ],
                            bookingStatusId: 17 // Completed status
                        }
                    });

                    // Get pending orders count
                    const pendingOrdersCount = await booking.count({
                        where: {
                            [Op.or]: [
                                { driverId: driverId },
                                { deliveryDriverId: driverId }
                            ],
                            bookingStatusId: {
                                [Op.notIn]: [17, 19, 23] // Exclude completed, cancelled, and failed
                            }
                        }
                    });

                    // Get driver earnings from completed orders
                    const driverEarnings = await booking.sum('orderAmount', {
                        where: {
                            [Op.or]: [
                                { driverId: driverId },
                                { deliveryDriverId: driverId }
                            ],
                            bookingStatusId: 17 // Only completed orders
                        }
                    });

                    return {
                        ...driver.toJSON(),
                        DriverPickUpOrders: pickupOrdersCount,
                        DriverDeliveryOrders: deliveryOrdersCount,
                        totalOrders: totalOrdersCount,
                        completedOrders: completedOrdersCount,
                        pendingOrders: pendingOrdersCount,
                        driverEarnings: parseFloat((driverEarnings || 0).toFixed(2))
                    };
                })
            );

            return driversWithBookingCounts;
        } catch (error) {
            throw new Error(`All drivers service error: ${error.message}`);
        }
    }

    /**
     * Get specific driver details with bookings
     * @param {number} driverId - Driver ID
     * @returns {Object} Driver details with booking information
     */
    async getSpecificDriverDetails(driverId) {
        try {
            const userInfo = await driverInZones.findOne({
                where: {
                    driverId: driverId,
                },
                include: [
                    {
                        model: users,
                        as: 'driverInZone',
                        attributes: ['id', 'firstName', 'lastName', 'email'],
                        include: [
                            {
                                model: roles,
                                attributes: ['name']
                            }
                        ]
                    },
                    {
                        model: bussinessInformation,
                        as: 'laundaryDriver',
                        attributes: ['shopName', 'shopAddressId'],
                        include: [{
                            model: addressDb,
                            attributes: ['streetAddress', 'province', 'district', 'addressType']
                        }]
                    },
                ],
                attributes: ['laundaryShopId']
            });

            // Check if driver exists in driverInZones table
            if (!userInfo) {
                throw new Error("Driver not found in the system");
            }

            const findBooking = await booking.findAll({
                where: {
                    driverId: driverId,
                    [Op.or]: [
                        { driverId: driverId },
                        { deliveryDriverId: driverId }
                    ]
                },
                include: [
                    {
                        model: proofOfDeliveries,
                        attributes: ['id', 'imgUpload', 'noOfItems', 'bookingId', 'userId']
                    },
                    {
                        model: addressDb,
                        as: 'pickupAddress',
                        attributes: ['title', 'streetAddress', 'district', 'province', 'addressType']
                    },
                    {
                        model: addressDb,
                        as: 'dropOffAddress',
                        attributes: ['title', 'streetAddress', 'district', 'province', 'addressType']
                    }
                ],
                attributes: {
                    exclude: ['createdAt', 'updatedAt', 'onHoldReason', 'categoryId', 'serviceId', 'subCategoryId', 'vehicleTypeId', 'OnHoldOtherReasons']
                }
            });

            const driverTotalOrders = await booking.count({
                where: {
                    driverId: driverId,
                    [Op.or]: [
                        { driverId: driverId },
                        { deliveryDriverId: driverId }
                    ]
                }
            });

            const pendingOrder = await booking.count({
                where: {
                    bookingStatusId: {
                        [Op.ne]: 11
                    },
                    [Op.or]: [
                        { driverId: driverId },
                        { deliveryDriverId: driverId }
                    ]
                }
            });

            return {
                userInformation: userInfo,
                driverBookings: findBooking,
                totalOrders: driverTotalOrders,
                pendingOrders: pendingOrder
            };
        } catch (error) {
            throw new Error(`Specific driver details service error: ${error.message}`);
        }
    }
}

module.exports = new DriverService();
