const { addressDb, bussinessInformation, bussinessWorkingHours, agentSelectServices, countries, cities, zone, users, roles, booking, bookingStatus, customerSelectedService, service, categories, billingDetails } = require('../../models');
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
                        attributes: ['id', 'streetAddress', 'province', 'district', 'addressType', 'cityId', 'countryId',
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

            // Fetch all orders for this shop
            let orders = [];
            if (shopData && shopData.addressDb) {
                const shopAddressId = shopData.addressDb.id;
                
                orders = await booking.findAll({
                    where: {
                        laundryShopId: shopAddressId
                    },
                    include: [
                        {
                            model: users,
                            as: 'customer',
                            attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum']
                        },
                        {
                            model: users,
                            as: 'driver',
                            attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum'],
                            required: false
                        },
                        {
                            model: users,
                            as: 'deliveryDriver',
                            attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum'],
                            required: false
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
                            model: bookingStatus,
                            attributes: ['id', 'title', 'description']
                        },
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
                            model: billingDetails,
                            attributes: ['id', 'upfrontAmount', 'discount', 'total', 'zoneAdminCommission', 'serviceCharge', 'categoryCharge', 'pickupDriverEarning', 'deliveryDriverEarning', 'paymentStatus'],
                            required: false
                        }
                    ],
                    order: [['id', 'DESC']],
                    attributes: {
                        exclude: ['updatedAt', 'categoryId', 'serviceId', 'subCategoryId', 'vehicleTypeId']
                    }
                });
            }

            // Convert shopData to plain object and add orders
            const result = shopData ? shopData.toJSON() : null;
            if (result) {
                result.orders = orders;
            }

            return result || shopData;
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

    /**
     * Get all employees with their shop information
     * @returns {Array} List of all employees with shop details
     */
    async getAllEmployeesWithShopInfo() {
        const allEmployees = await users.findAll({
            where: {
                classifiedAsId: 1,
                deletedAt: { [Op.is]: null }
            },
            attributes: [
                'id',
                'firstName',
                'lastName',
                'email',
                'phoneNum',
                'status',
                'image',
                'countryCode',
                'employeeOff',
                'roleId',
                'createdAt',
                'updatedAt'
            ],
            include: [
                {
                    model: roles,
                    attributes: ['id', 'name']
                }
            ],
            order: [['createdAt', 'DESC']]
        });

        // Get all unique agent IDs from employees
        const agentIds = [...new Set(allEmployees.map(emp => emp.employeeOff).filter(Boolean))];
        
        // Fetch all shops for these agents
        const shops = await bussinessInformation.findAll({
            where: {
                agentId: { [Op.in]: agentIds }
            },
            attributes: [
                'id',
                'shopName',
                'matchProfileOptions',
                'otherText',
                'shopAddressId',
                'agentId'
            ],
            include: [
                {
                    model: addressDb,
                    attributes: [
                        'id',
                        'streetAddress',
                        'province',
                        'district',
                        'postalCode',
                        'addressType',
                        'cityId',
                        'countryId',
                        'lat',
                        'lng'
                    ],
                    include: [
                        {
                            model: countries,
                            attributes: ['id', 'name', 'shortName', 'image']
                        },
                        {
                            model: cities,
                            attributes: ['id', 'name']
                        },
                        {
                            model: zone,
                            attributes: ['id', 'name', 'status', 'zoneMinimumAmount', 'serviceCharge']
                        }
                    ]
                }
            ]
        });

        // Create a map of agentId -> shop info
        const shopMap = {};
        shops.forEach(shop => {
            shopMap[shop.agentId] = shop;
        });

        // Attach shop info to each employee
        const employeesWithShops = allEmployees.map(employee => {
            const employeeData = employee.toJSON();
            const shopInfo = employeeData.employeeOff ? shopMap[employeeData.employeeOff] : null;
            return {
                ...employeeData,
                shopInfo: shopInfo || null
            };
        });

        return {
            employees: employeesWithShops
        };
    }
}

module.exports = new ShopManagementService();
