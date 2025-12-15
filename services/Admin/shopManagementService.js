const { addressDb, bussinessInformation, bussinessWorkingHours, agentSelectServices, countries, cities, zone, users } = require('../../models');
const { Op } = require('sequelize');
const sequelize = require('sequelize');
const { 
    ValidationError, 
    NotFoundError, 
    ConflictError,
    UnprocessableEntityError 
} = require('../../middlewares/universalErrorHandler');

class ShopManagementService {
    /**
     * Get shop information statistics
     * @returns {Object} Shop count statistics
     */
    async getShopInformation() {
            const fourDayAgo = new Date();
            fourDayAgo.setDate(fourDayAgo.getDate() - 4);

            const getShopsCount = await addressDb.count({
                where: {
                    addressType: 'LaundaryShopAddress'
                }
            });

            const newRegisterShops = await addressDb.count({
                where: {
                    status: true,
                    createdAt: {
                        [Op.gte]: fourDayAgo
                    }
                }
            });

            const activeShops = await addressDb.count({
                where: {
                    addressType: 'LaundaryShopAddress',
                    status: true
                }
            });

            const inActiveShops = await addressDb.count({
                where: {
                    addressType: 'LaundaryShopAddress',
                    status: false
                }
            });

            return {
                getShopsCount: getShopsCount,
                newRegisterShops: newRegisterShops,
                activeShops: activeShops,
                inActiveShops: inActiveShops
            };
    }

    /**
     * Get all shops data with detailed information
     * @returns {Array} List of all shops with business information
     */
    async getShopsData() {
            const getShopData = await bussinessInformation.findAll({
                include: [
                    {
                        model: users,
                        as: 'businessInfo',
                        attributes: [
                            'firstName',
                            'lastName',
                            'email',
                            'phoneNum',
                            'userTypeId',
                            [
                                sequelize.literal(`(SELECT COUNT(*) FROM users WHERE users.employeeOff = businessInfo.id)`),
                                'TotalEmployees',
                            ]
                        ],
                        include: [
                            {
                                model: bussinessWorkingHours,
                                where: {
                                    status: true
                                },
                                attributes: ['id', 'dayOfWeek', 'openTime', 'closeTime']
                            }
                        ]
                    },
                    {
                        model: addressDb,
                        attributes: ['streetAddress', 'province', 'district', 'addressType', 'cityId', 'countryId',
                            [
                                sequelize.literal(
                                    `(SELECT COUNT(*) FROM bookings WHERE bookings.laundryShopId = addressDb.id)`
                                ),
                                'TotalBookingCount',
                            ],
                            [
                                sequelize.literal(
                                    `(SELECT COUNT(*) FROM bookings WHERE bookings.laundryShopId = addressDb.id AND bookings.bookingStatusId NOT IN (12))`
                                ),
                                'PendingBookingCount',
                            ],
                            [
                                sequelize.literal(
                                    `(SELECT ROUND(COALESCE(SUM(orderAmount), 0),2) FROM bookings WHERE bookings.laundryShopId = addressDb.id)`
                                ),
                                'TotalRevenue',
                            ]
                        ],
                        include: [
                            {
                                model: countries,
                                attributes: ['id', 'name', 'shortName', 'image', 'status']
                            },
                            {
                                model: cities,
                                attributes: ['id', 'name', 'status']
                            },
                            {
                                model: zone,
                                attributes: ['id', 'name', 'status', 'zoneMinimumAmount', 'serviceCharge']
                            }
                        ]
                    }
                ],
                attributes: ['id', 'shopName', 'matchProfileOptions', "otherText", 'shopAddressId', 'agentId']
            });

            return {
                AllShopsData: getShopData
            };
    }

    /**
     * Get single shop data by ID
     * @param {number} shopId - Shop ID
     * @returns {Object} Single shop data with detailed information
     */
    async getSingleShopData(shopId) {
            const shopData = await bussinessInformation.findOne({
                where: {
                    id: shopId
                },
                include: [
                    {
                        model: users,
                        as: 'businessInfo',
                        attributes: [
                            'id',
                            'firstName',
                            'lastName',
                            'email',
                            [
                                sequelize.literal(`(SELECT COUNT(*) FROM users WHERE users.employeeOff = businessInfo.id)`),
                                'TotalEmployees',
                            ]
                        ],
                        include: [
                            {
                                model: bussinessWorkingHours,
                                where: {
                                    status: true
                                },
                                attributes: ['id', 'dayOfWeek', 'openTime', 'closeTime']
                            },
                            {
                                model: agentSelectServices,
                                as: 'agentServices',
                                attributes: ['id'],
                                include: [
                                    {
                                        model: require('../../models').service,
                                        attributes: ['id', 'name']
                                    }
                                ]
                            }
                        ]
                    },
                    {
                        model: addressDb,
                        attributes: ['streetAddress', 'province', 'district', 'addressType', 'cityId', 'countryId',
                            [
                                sequelize.literal(
                                    `(SELECT COUNT(*) FROM bookings WHERE bookings.laundryShopId = addressDb.id)`
                                ),
                                'TotalBookingCount',
                            ],
                            [
                                sequelize.literal(
                                    `(SELECT ROUND(COALESCE(SUM(orderAmount), 0),2) FROM bookings WHERE bookings.laundryShopId = addressDb.id)`
                                ),
                                'TotalRevenue',
                            ]
                        ],
                        include: [
                            {
                                model: countries,
                                attributes: ['id', 'name', 'shortName', 'image', 'status']
                            },
                            {
                                model: cities,
                                attributes: ['id', 'name', 'status']
                            },
                            {
                                model: zone,
                                attributes: ['id', 'name', 'status', 'zoneMinimumAmount', 'serviceCharge']
                            }
                        ]
                    }
                ]
            });

            return shopData;
    }

    /**
     * Get shop employees by business ID
     * @param {number} businessId - Business ID
     * @returns {Object} Shop employees data
     */
    async getShopEmployees(businessId) {
            const findShopData = await bussinessInformation.findOne({
                where: {
                    id: businessId
                },
                attributes: ['id','agentId']
            });
            const findEmployees = await users.findAll({
                where: {
                    employeeOff: findShopData.agentId,
                    classifiedAsId: 1
                }
            });
            return findEmployees;
    }
}

module.exports = new ShopManagementService();
