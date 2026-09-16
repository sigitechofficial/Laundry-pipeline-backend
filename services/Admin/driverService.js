const { users, booking, driverInZones, proofOfDeliveries, addressDb, bussinessInformation, roles } = require('../../models');
const { Op } = require('sequelize');
const { UNBOUNDED_LIST_SAFETY_MAX } = require('../../utils/listLimit');
const bcrypt = require('bcryptjs');
const {
    ConflictError,
    NotFoundError,
    ValidationError,
    UnprocessableEntityError
} = require('../../middlewares/universalErrorHandler');

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
                    'phoneNum',
                    'countryCode',
                    'status',
                    'createdAt'
                ],
                include: [
                    {
                        model: roles,
                        attributes: ['name']
                    }
                ],
                order: [['id', 'DESC']],
                limit: UNBOUNDED_LIST_SAFETY_MAX,
            });

            const ids = findDrivers.map((driver) => driver.id);
            const statsById = new Map();
            if (ids.length > 0) {
                const [statRows] = await booking.sequelize.query(
                    `
                    SELECT
                        t.driver_id AS driverId,
                        SUM(t.is_pickup) AS pickupOrders,
                        SUM(t.is_delivery) AS deliveryOrders,
                        COUNT(DISTINCT t.booking_id) AS totalOrders,
                        COUNT(DISTINCT CASE WHEN t.bookingStatusId = 17 THEN t.booking_id END) AS completedOrders,
                        COUNT(DISTINCT CASE WHEN t.bookingStatusId NOT IN (17, 19, 23) THEN t.booking_id END) AS pendingOrders,
                        COALESCE(SUM(t.completed_amount), 0) AS driverEarnings
                    FROM (
                        SELECT
                            b.id AS booking_id,
                            b.driverId AS driver_id,
                            1 AS is_pickup,
                            0 AS is_delivery,
                            b.bookingStatusId,
                            CASE WHEN b.bookingStatusId = 17 THEN b.orderAmount ELSE 0 END AS completed_amount
                        FROM bookings b
                        WHERE b.deletedAt IS NULL AND b.driverId IN (:ids)
                        UNION ALL
                        SELECT
                            b.id AS booking_id,
                            b.deliveryDriverId AS driver_id,
                            0 AS is_pickup,
                            1 AS is_delivery,
                            b.bookingStatusId,
                            CASE
                                WHEN b.bookingStatusId = 17
                                 AND (b.driverId IS NULL OR b.driverId <> b.deliveryDriverId)
                                THEN b.orderAmount ELSE 0
                            END AS completed_amount
                        FROM bookings b
                        WHERE b.deletedAt IS NULL AND b.deliveryDriverId IN (:ids)
                    ) t
                    GROUP BY t.driver_id
                    `,
                    { replacements: { ids } }
                );
                for (const row of statRows) {
                    statsById.set(Number(row.driverId), {
                        DriverPickUpOrders: Number(row.pickupOrders) || 0,
                        DriverDeliveryOrders: Number(row.deliveryOrders) || 0,
                        totalOrders: Number(row.totalOrders) || 0,
                        completedOrders: Number(row.completedOrders) || 0,
                        pendingOrders: Number(row.pendingOrders) || 0,
                        driverEarnings: parseFloat(Number(row.driverEarnings || 0).toFixed(2)),
                    });
                }
            }

            return findDrivers.map((driver) => {
                const stats = statsById.get(driver.id) || {
                    DriverPickUpOrders: 0,
                    DriverDeliveryOrders: 0,
                    totalOrders: 0,
                    completedOrders: 0,
                    pendingOrders: 0,
                    driverEarnings: 0,
                };
                return {
                    ...driver.toJSON(),
                    ...stats,
                };
            });
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
            const normalizedDriverId = Number(driverId);
            if (!Number.isInteger(normalizedDriverId) || normalizedDriverId <= 0) {
                throw new ValidationError('Invalid driver ID');
            }
            const userInfo = await driverInZones.findOne({
                where: {
                    driverId: normalizedDriverId,
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
                throw new NotFoundError("Driver not found in the system");
            }

            const findBooking = await booking.findAll({
                where: {
                    [Op.or]: [
                        { driverId: normalizedDriverId },
                        { deliveryDriverId: normalizedDriverId }
                    ]
                },
                include: [
                    {
                        model: proofOfDeliveries,
                        attributes: ['id', 'imgUpload', 'noOfItems', 'noOfBags', 'bookingId', 'userId']
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
                    [Op.or]: [
                        { driverId: normalizedDriverId },
                        { deliveryDriverId: normalizedDriverId }
                    ]
                }
            });

            const pendingOrder = await booking.count({
                where: {
                    bookingStatusId: {
                        [Op.ne]: 11
                    },
                    [Op.or]: [
                        { driverId: normalizedDriverId },
                        { deliveryDriverId: normalizedDriverId }
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
            if (error instanceof NotFoundError || error instanceof ValidationError) throw error;
            throw new Error(`Specific driver details service error: ${error.message}`);
        }
    }

    /**
     * Change driver status
     * @param {number} driverId - Driver ID
     * @param {boolean} status - New status
     * @returns {Object} Status change result
     */
    async changeDriverStatus(driverId, status) {
        try {
            const driverStatusChange = await users.update({
                status: status
            }, {
                where: {
                    id: driverId
                }
            });

            if (driverStatusChange[0] === 0) {
                throw new Error('Driver not found or no changes made');
            }

            return { driverId, status, message: 'Driver status updated successfully' };
        } catch (error) {
            throw new Error(`Change driver status service error: ${error.message}`);
        }
    }

    /**
     * Update driver details
     * @param {number} driverId - Driver ID
     * @param {Object} updateData - Driver update data
     * @param {string} updateData.firstName - First name
     * @param {string} updateData.lastName - Last name
     * @param {string} updateData.email - Email
     * @param {string} updateData.password - Password (will be hashed)
     * @param {string} updateData.phoneNum - Phone number
     * @param {string} updateData.countryCode - Country code
     * @param {boolean} updateData.status - Status
     * @param {string} profileImg - Profile image path
     * @returns {Object} Updated driver data
     */
    async updateDriver(driverId, updateData, profileImg = null) {
        // Check if driver exists
        const driverExists = await users.findOne({
            where: {
                id: driverId,
                roleId: 6,
                classifiedAsId: 1
            }
        });

        if (!driverExists) {
            throw new NotFoundError('Driver not found');
        }

        // Check if email is being changed and if it already exists
        if (updateData.email && updateData.email !== driverExists.email) {
            const emailExists = await users.findOne({
                where: {
                    email: updateData.email,
                    id: { [Op.ne]: driverId },
                    roleId: 6,
                    classifiedAsId: 1
                }
            });

            if (emailExists) {
                throw new ConflictError('Email already exists');
            }
        }

        // Remove driverId from updateData if present
        const { driverId: _, ...updateFields } = updateData;

        // Hash password if provided
        if (updateFields.password && updateFields.password.trim() !== '') {
            updateFields.password = await bcrypt.hash(updateFields.password, 10);
        } else {
            // Remove password from updateFields if it's empty
            delete updateFields.password;
        }

        // Add profile image if provided
        if (profileImg) {
            updateFields.image = profileImg;
        }

        const updatedDriver = await users.update(updateFields, {
            where: {
                id: driverId,
                roleId: 6,
                classifiedAsId: 1
            }
        });

        if (updatedDriver[0] === 0) {
            throw new ValidationError('No changes were made');
        }

        // Get updated driver data
        const updatedDriverData = await users.findOne({
            where: {
                id: driverId,
                roleId: 6,
                classifiedAsId: 1
            },
            attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum', 'status', 'image', 'countryCode', 'createdAt', 'updatedAt'],
            include: [
                {
                    model: roles,
                    attributes: ['id', 'name']
                }
            ]
        });

        return updatedDriverData;
    }

    /**
     * Add driver by laundry shop ID
     * @param {Object} data - Driver data
     * @param {string} data.firstName - First name
     * @param {string} data.lastName - Last name
     * @param {string} data.email - Email
     * @param {string} data.password - Password
     * @param {string} data.phoneNum - Phone number
     * @param {string} data.countryCode - Country code
     * @param {number} data.roleId - Role ID (should be 6 for driver)
     * @param {number} data.laundaryShopId - Laundry shop ID (bussinessInformation.id)
     * @param {string} profileImg - Profile image path
     * @returns {Object} Created driver data
     */
    async addDriverByLaundryShop(data, profileImg = null) {
        const {
            firstName,
            lastName,
            email,
            password,
            phoneNum,
            countryCode,
            roleId,
            laundaryShopId
        } = data;

        // Validate required fields
        if (!laundaryShopId) {
            throw new ValidationError('Laundry shop ID is required');
        }

        // Get business information to find agent ID
        const businessInfo = await bussinessInformation.findOne({
            where: {
                id: laundaryShopId
            }
        });

        if (!businessInfo) {
            throw new NotFoundError('Laundry shop not found');
        }

        const agentId = businessInfo.agentId;

        if (!agentId) {
            throw new NotFoundError('Agent ID not found for this laundry shop');
        }

        // Check if driver already exists
        const userFind = await users.findOne({
            where: {
                classifiedAsId: 1,
                roleId: roleId || 6,
                firstName: firstName,
                lastName: lastName,
                email: email
            }
        });

        if (userFind) {
            throw new ConflictError('Driver already exists with this information');
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create driver user
        const user = await users.create({
            firstName,
            lastName,
            email,
            password: hashedPassword,
            phoneNum,
            roleId: roleId || 6,
            status: true,
            classifiedAsId: 1,
            image: profileImg,
            countryCode,
            verifiedAt: Date.now()
        });

        // Update user with employeeOff (agent ID)
        await users.update(
            {
                employeeOff: agentId
            },
            {
                where: { id: user.id }
            }
        );

        // Get agent's address information
        const agentAddress = await addressDb.findOne({
            where: {
                userId: agentId
            }
        });

        if (!agentAddress) {
            throw new NotFoundError('Agent address not found');
        }

        const zoneId = agentAddress.zoneId;
        const countryId = agentAddress.countryId;
        const cityId = agentAddress.cityId;
        const driverId = user.id;

        // Create driverInZones record
        await driverInZones.create({
            driverId: driverId,
            zoneId: zoneId,
            laundaryShopId: laundaryShopId,
            countryId: countryId,
            cityId: cityId
        });

        // Get created driver with role information
        const createdDriver = await users.findOne({
            where: { id: user.id },
            attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum', 'countryCode', 'status', 'createdAt', 'employeeOff'],
            include: [
                {
                    model: roles,
                    attributes: ['id', 'name']
                }
            ]
        });

        return {
            driver: createdDriver,
            message: 'Driver added successfully'
        };
    }

    /**
     * Delete driver (soft delete)
     * @param {number} driverId - Driver ID
     * @returns {Object} Deletion result
     */
    async deleteDriver(driverId) {
        // Check if driver exists
        const driverExists = await users.findOne({
            where: {
                id: driverId,
                roleId: 6,
                classifiedAsId: 1
            }
        });

        if (!driverExists) {
            throw new NotFoundError('Driver not found');
        }

        // Check if driver has any active bookings as pickup driver
        const activePickupBookings = await booking.count({
            where: {
                driverId: driverId,
                bookingStatusId: {
                    [Op.notIn]: [17, 19, 23] // Exclude completed, cancelled, and failed bookings
                }
            }
        });

        // Check if driver has any active bookings as delivery driver
        const activeDeliveryBookings = await booking.count({
            where: {
                deliveryDriverId: driverId,
                bookingStatusId: {
                    [Op.notIn]: [17, 19, 23] // Exclude completed, cancelled, and failed bookings
                }
            }
        });

        const totalActiveBookings = activePickupBookings + activeDeliveryBookings;

        if (totalActiveBookings > 0) {
            throw new UnprocessableEntityError(`Driver has ${totalActiveBookings} active booking(s). Please complete or cancel all bookings first.`);
        }

        // Soft delete the driver (set status to false)
        const deletedDriver = await users.update(
            { status: false },
            {
                where: {
                    id: driverId,
                    roleId: 6,
                    classifiedAsId: 1
                }
            }
        );

        if (deletedDriver[0] === 0) {
            throw new ValidationError('Failed to delete driver');
        }

        return { driverId, message: 'Driver deleted successfully' };
    }
}

module.exports = new DriverService();
