const { addressDb, bussinessInformation, bussinessWorkingHours, agentSelectServices, countries, cities, zone, users, roles, booking, bookingStatus, customerSelectedService, service, categories, billingDetails } = require('../../models');
const { Op } = require('sequelize');
const sequelize = require('sequelize');
const { 
    ValidationError, 
    NotFoundError, 
    ConflictError,
    UnprocessableEntityError 
} = require('../../middlewares/universalErrorHandler');
const { clampListLimit, UNBOUNDED_LIST_SAFETY_MAX } = require('../../utils/listLimit');
// Keep the shop "pending" count in sync with the admin order sidebar / pendingOrders
// list (services/Admin/orderService.js). Canonical exclusions: Completed, On-Hold
// (customer + agent), Cancelled — see constants/bookingStatusIds.js.
const { PENDING_EXCLUDED_SQL } = require('../../constants/bookingStatusIds');
const { shopCollectedNetRevenueSql } = require('../../utils/shopCollectedRevenue');

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

    _buildShopListFilters(filters = {}) {
        const shopWhere = {};
        const addressWhere = {};
        const userWhere = {};
        let addressRequired = false;
        let userRequired = false;
        let searchActive = false;

        if (filters.zoneId != null && String(filters.zoneId).trim() !== '') {
            const zoneId = parseInt(filters.zoneId, 10);
            if (!Number.isNaN(zoneId)) {
                addressWhere.zoneId = zoneId;
                addressRequired = true;
            }
        }

        if (filters.status != null && String(filters.status).trim() !== '') {
            const raw = String(filters.status).trim().toLowerCase();
            if (raw === '1' || raw === 'true' || raw === 'active') {
                addressWhere.status = true;
                addressRequired = true;
            } else if (raw === '0' || raw === 'false' || raw === 'inactive' || raw === 'block') {
                addressWhere.status = false;
                addressRequired = true;
            }
        }

        if (filters.startDate && filters.endDate) {
            shopWhere.createdAt = {
                [Op.gte]: new Date(`${filters.startDate}T00:00:00.000`),
                [Op.lte]: new Date(`${filters.endDate}T23:59:59.999`),
            };
        } else if (filters.date) {
            const day = new Date(filters.date);
            shopWhere.createdAt = {
                [Op.gte]: day,
                [Op.lt]: new Date(day.getTime() + 24 * 60 * 60 * 1000),
            };
        }

        const term = String(filters.search || '').trim();
        if (term) {
            searchActive = true;
            const like = `%${term}%`;
            const or = [
                { shopName: { [Op.like]: like } },
                { '$businessInfo.email$': { [Op.like]: like } },
                { '$businessInfo.phoneNum$': { [Op.like]: like } },
                { '$addressDb.streetAddress$': { [Op.like]: like } },
                { '$addressDb.district$': { [Op.like]: like } },
                { '$addressDb.province$': { [Op.like]: like } },
            ];
            if (/^\d+$/.test(term)) {
                or.push({ id: parseInt(term, 10) });
            }
            shopWhere[Op.or] = or;
            addressRequired = true;
            userRequired = true;
        }

        return { shopWhere, addressWhere, userWhere, addressRequired, userRequired, searchActive };
    }

    /**
     * Get all shops data with detailed information
     * @param {Object} [filters] - zoneId, search, startDate, endDate, status, page, limit
     * @returns {Object} Paginated shops + top performers
     */
    async getShopsData(filters = {}) {
            // Paginate only when client asks (shops list UI). Other callers expect full list.
            const wantsPagination =
                Object.prototype.hasOwnProperty.call(filters, 'page') ||
                Object.prototype.hasOwnProperty.call(filters, 'limit');
            const page = Math.max(1, parseInt(filters.page, 10) || 1);
            const limit = clampListLimit(filters.limit, 25, 100);
            const offset = (page - 1) * limit;

            const {
                shopWhere,
                addressWhere,
                addressRequired,
                userRequired,
                searchActive,
            } = this._buildShopListFilters(filters);

            const addressInclude = {
                model: addressDb,
                required: addressRequired,
                where: Object.keys(addressWhere).length ? addressWhere : undefined,
                attributes: ['streetAddress', 'province', 'district', 'addressType', 'cityId', 'countryId', 'zoneId', 'status',
                    [
                        sequelize.literal(
                            `(SELECT COUNT(*) FROM bookings WHERE bookings.laundryShopId = addressDb.id)`
                        ),
                        'TotalBookingCount',
                    ],
                    [
                        sequelize.literal(
                            `(SELECT COUNT(*) FROM bookings WHERE bookings.laundryShopId = addressDb.id AND bookings.bookingStatusId NOT IN (${PENDING_EXCLUDED_SQL}))`
                        ),
                        'PendingBookingCount',
                    ],
                    [
                        sequelize.literal(
                            shopCollectedNetRevenueSql('addressDb.id')
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
            };

            const businessInfoInclude = {
                model: users,
                as: 'businessInfo',
                required: userRequired,
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
                        required: false,
                        where: {
                            status: true
                        },
                        attributes: ['id', 'dayOfWeek', 'openTime', 'closeTime']
                    }
                ]
            };

            const listOptions = {
                where: shopWhere,
                include: [businessInfoInclude, addressInclude],
                attributes: ['id', 'shopName', 'matchProfileOptions', 'otherText', 'shopAddressId', 'agentId', 'createdAt'],
                order: [['id', 'DESC']],
                distinct: true,
                col: 'id',
                subQuery: searchActive ? false : undefined,
            };
            if (wantsPagination) {
                listOptions.limit = limit;
                listOptions.offset = offset;
            } else {
                listOptions.limit = UNBOUNDED_LIST_SAFETY_MAX;
            }

            const { rows: getShopData, count } = await bussinessInformation.findAndCountAll(listOptions);
            let total = 0;
            if (typeof count === 'number') {
                total = count;
            } else if (typeof count === 'string' && count.trim() !== '') {
                total = Number(count) || 0;
            } else if (Array.isArray(count)) {
                // distinct + includes can return grouped rows; prefer length of unique ids
                total = count.length;
            } else if (count != null && typeof count === 'object' && count.count != null) {
                total = Number(count.count) || 0;
            }
            if (!Number.isFinite(total) || total < 0) total = 0;
            // If count collapsed to 0 but we have rows, never show empty footer
            if (total === 0 && getShopData.length > 0 && !wantsPagination) {
                total = getShopData.length;
            }
            if (total === 0 && getShopData.length > 0 && wantsPagination) {
                // Paginated page with broken count: at least cover current offset + rows
                total = offset + getShopData.length;
            }

            // Top 5 performers — same zone/date/search/status scope
            const topAddressInclude = {
                model: addressDb,
                required: addressRequired,
                where: Object.keys(addressWhere).length ? addressWhere : undefined,
                attributes: [
                    'id',
                    'streetAddress',
                    'province',
                    'district',
                    [
                        sequelize.literal(
                            `(SELECT COUNT(*) FROM bookings WHERE bookings.laundryShopId = addressDb.id)`
                        ),
                        'orderCount',
                    ],
                    [
                        sequelize.literal(
                            shopCollectedNetRevenueSql('addressDb.id')
                        ),
                        'totalRevenue',
                    ]
                ],
                include: [
                    {
                        model: cities,
                        attributes: ['id', 'name']
                    }
                ]
            };

            const topPerformingShops = await bussinessInformation.findAll({
                where: shopWhere,
                include: [
                    {
                        model: users,
                        as: 'businessInfo',
                        required: userRequired,
                        attributes: ['id', 'email', 'phoneNum'],
                    },
                    topAddressInclude,
                ],
                attributes: [
                    'id',
                    'shopName',
                    'agentId'
                ],
                order: [
                    [
                        sequelize.literal(
                            shopCollectedNetRevenueSql('`addressDb`.`id`')
                        ),
                        'DESC'
                    ]
                ],
                limit: 5,
                subQuery: searchActive ? false : undefined,
            });

            const formattedTopShops = topPerformingShops.map(shop => {
                const shopData = shop.toJSON();
                return {
                    id: shopData.id,
                    shopName: shopData.shopName,
                    address: shopData.addressDb ? {
                        streetAddress: shopData.addressDb.streetAddress,
                        province: shopData.addressDb.province,
                        district: shopData.addressDb.district,
                        city: shopData.addressDb.city ? shopData.addressDb.city.name : null
                    } : null,
                    orderCount: shopData.addressDb ? parseInt(shopData.addressDb.orderCount) || 0 : 0,
                    totalRevenue: shopData.addressDb ? parseFloat(shopData.addressDb.totalRevenue) || 0 : 0
                };
            });

            return {
                AllShopsData: getShopData,
                topPerformingShops: formattedTopShops,
                total,
                page: wantsPagination ? page : 1,
                limit: wantsPagination ? limit : Math.min(total, UNBOUNDED_LIST_SAFETY_MAX),
                pagination: {
                    total,
                    totalRecords: total,
                    page: wantsPagination ? page : 1,
                    limit: wantsPagination ? limit : Math.min(total, UNBOUNDED_LIST_SAFETY_MAX),
                    totalPages: wantsPagination ? (Math.ceil(total / limit) || 1) : 1,
                },
            };
    }

    /**
     * Get single shop data by ID
     * @param {number} shopId - Shop ID
     * @returns {Object} Single shop data with detailed information
     */
    async getSingleShopData(shopId) {
            const id = parseInt(shopId, 10);
            if (!Number.isFinite(id) || id <= 0) {
                throw new NotFoundError("Shop not found");
            }

            const shopIncludes = [
                    {
                        model: users,
                        as: 'businessInfo',
                        required: false,
                        attributes: [
                            'id',
                            'firstName',
                            'lastName',
                            'email',
                            'phoneNum',
                            'status',
                            [
                                sequelize.literal(`(SELECT COUNT(*) FROM users WHERE users.employeeOff = businessInfo.id)`),
                                'TotalEmployees',
                            ]
                        ],
                        include: [
                            {
                                model: bussinessWorkingHours,
                                required: false,
                                attributes: ['id', 'dayOfWeek', 'openTime', 'closeTime', 'status']
                            },
                            {
                                model: agentSelectServices,
                                as: 'agentServices',
                                required: false,
                                attributes: ['id', 'serviceId', 'status', 'serviceTimeRequired'],
                                include: [
                                    {
                                        model: require('../../models').service,
                                        attributes: [
                                            'id',
                                            'name',
                                            'description',
                                            'timeRequired',
                                            'status',
                                            'numberOfBags',
                                            'numberOfItems',
                                        ]
                                    }
                                ]
                            }
                        ]
                    },
                    {
                        model: addressDb,
                        required: false,
                        attributes: ['id', 'streetAddress', 'province', 'district', 'postalcode', 'addressType', 'cityId', 'countryId',
                            [
                                sequelize.literal(
                                    `(SELECT COUNT(*) FROM bookings WHERE bookings.laundryShopId = addressDb.id)`
                                ),
                                'TotalBookingCount',
                            ],
                            [
                                sequelize.literal(
                                    `(SELECT COUNT(*) FROM bookings WHERE bookings.laundryShopId = addressDb.id AND bookings.bookingStatusId NOT IN (${PENDING_EXCLUDED_SQL}))`
                                ),
                                'PendingBookingCount',
                            ],
                            [
                                sequelize.literal(
                                    shopCollectedNetRevenueSql('addressDb.id')
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
            ];

            let shopData = await bussinessInformation.findOne({
                where: { id },
                include: shopIncludes,
            });
            if (!shopData) {
                shopData = await bussinessInformation.findOne({
                    where: { agentId: id },
                    include: shopIncludes,
                });
            }
            if (!shopData) {
                shopData = await bussinessInformation.findOne({
                    where: { shopAddressId: id },
                    include: shopIncludes,
                });
            }
            if (!shopData) {
                throw new NotFoundError("Shop not found");
            }

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
                            as: 'billingDetail',
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

            return result;
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
            limit: UNBOUNDED_LIST_SAFETY_MAX,
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

    /**
     * Soft delete shop (shop details, user, and address)
     * @param {number} shopId - Shop ID
     * @returns {Object} Deletion result
     */
    async deleteShop(shopId) {
        // Check if shop exists
        const shopExists = await bussinessInformation.findOne({
            where: {
                id: shopId
            },
            include: [
                {
                    model: addressDb,
                    attributes: ['id']
                }
            ]
        });

        if (!shopExists) {
            throw new NotFoundError('Shop not found');
        }

        // Check if shop is already deleted
        if (shopExists.deletedAt) {
            throw new ConflictError('Shop is already deleted');
        }

        // Get shop details
        const agentId = shopExists.agentId;
        const shopAddressId = shopExists.shopAddressId;

        // Check if shop has any active bookings
        const activeBookings = await booking.count({
            where: {
                laundryShopId: shopAddressId,
                bookingStatusId: {
                    [Op.notIn]: [17, 19, 23] // Exclude completed, cancelled, and failed bookings
                }
            }
        });

        if (activeBookings > 0) {
            throw new UnprocessableEntityError(`Shop has ${activeBookings} active booking(s). Please complete or cancel all bookings first.`);
        }

        // Soft delete the shop (bussinessInformation)
        const deletedShop = await bussinessInformation.destroy({
            where: {
                id: shopId
            }
        });

        if (!deletedShop) {
            throw new ValidationError('Failed to delete shop');
        }

        // Soft delete the associated user (agent)
        if (agentId) {
            await users.destroy({
                where: {
                    id: agentId
                }
            });
        }

        // Soft delete the associated address
        if (shopAddressId) {
            await addressDb.destroy({
                where: {
                    id: shopAddressId
                }
            });
        }

        return {
            shopId,
            message: 'Shop, user, and address deleted successfully'
        };
    }
}

module.exports = new ShopManagementService();
