const { users, booking } = require('../../models');
const sequelize = require('sequelize');
const { Op, UniqueConstraintError, ValidationError: SequelizeValidationError } = require('sequelize');
const bcrypt = require('bcryptjs');
const stripe = require('../../controllers/stripe');
const signupWelcomeMail = require('../../helper/signupWelcomeMail');
const {
    ValidationError,
    NotFoundError,
    ConflictError,
    UnprocessableEntityError
} = require('../../middlewares/universalErrorHandler');
const { literal, fn, col } = require("sequelize");
const { addressDb, customerSelectedService, OnHoldConfirmation, bookingStatus, bussinessInformation,service } = require('../../models');
const { clampListLimit, clampPage } = require('../../utils/listLimit');
const {
    resolveListWindow,
    parseSearchTerm,
    buildSearchWhere,
    andWhere,
    buildDateRangeWhere,
    resolveSort,
    buildPagination,
} = require('../../utils/listQuery');
const { customerPhoneError } = require('../../utils/customerPhone');
const { isUserBlocked } = require('../../utils/accountBlocked');
const { presentCustomerUserDetails } = require('../../utils/customerUserDetails');

class CustomerService {
    /**
     * Get all customers with booking statistics
     * @returns {Array} List of customers with booking counts and amounts
     */
    /**
     * Admin customer directory. Query contract (see utils/listQuery):
     *   search    id / first / last / full name / email / phone
     *   status    "active" | "blocked"
     *   startDate/endDate  signup (createdAt) calendar range
     *   sortBy    name | email | createdAt | bookingCount | totalAmountSpent | lastBookingDate
     *   page/limit or export=1
     */
    async getAllCustomers(query = {}) {
        const window = resolveListWindow(query, { defaultLimit: 25 });

        let where = { userTypeId: 2 };

        const statusFilter = String(query.status || '').trim().toLowerCase();
        if (statusFilter === 'blocked') where.status = { [Op.in]: [false, 0] };
        else if (statusFilter === 'active') where.status = { [Op.notIn]: [false, 0] };

        const createdRange = buildDateRangeWhere(query.startDate, query.endDate);
        if (createdRange) where.createdAt = createdRange;

        const searchTerm = parseSearchTerm(query.search);
        const searchWhere = buildSearchWhere(
            searchTerm,
            ['firstName', 'lastName', 'email', 'phoneNum'],
            { idFields: ['id'] }
        );
        if (searchWhere && searchTerm.includes(' ')) {
            // "Jane Doe" → match the concatenated name too.
            searchWhere[Op.or].push(
                sequelize.where(
                    sequelize.fn('CONCAT_WS', ' ', sequelize.col('firstName'), sequelize.col('lastName')),
                    { [Op.like]: `%${searchTerm}%` }
                )
            );
        }
        where = andWhere(where, searchWhere);

        const BOOKING_COUNT = `(SELECT COUNT(*) FROM bookings WHERE bookings.customerId = users.id)`;
        const TOTAL_SPENT = `(SELECT COALESCE(SUM(orderAmount), 0) FROM bookings WHERE bookings.customerId = users.id)`;
        const LAST_BOOKING = `(SELECT MAX(createdAt) FROM bookings WHERE bookings.customerId = users.id)`;

        const { order } = resolveSort(
            query,
            {
                name: 'firstName',
                email: 'email',
                createdAt: 'createdAt',
                bookingCount: sequelize.literal(BOOKING_COUNT),
                totalAmountSpent: sequelize.literal(TOTAL_SPENT),
                lastBookingDate: sequelize.literal(LAST_BOOKING),
            },
            { sortBy: 'createdAt', sortDir: 'DESC' }
        );
        // Stable tiebreaker for paging.
        order.push(['id', 'DESC']);

        const [totalCount, findCustomers] = await Promise.all([
            users.count({ where }),
            users.findAll({
                where,
                attributes: [
                    'id',
                    'firstName',
                    'lastName',
                    'email',
                    'phoneNum',
                    'countryCode',
                    'status',
                    'createdAt',
                    'updatedAt',
                    [sequelize.literal(BOOKING_COUNT), 'bookingCount'],
                    [sequelize.literal(TOTAL_SPENT), 'totalAmountSpent'],
                    [sequelize.literal(LAST_BOOKING), 'lastBookingDate'],
                ],
                limit: window.limit,
                offset: window.offset,
                order,
            }),
        ]);

        const formattedCustomers = findCustomers.map((customer) => {
            const customerData = customer.toJSON();
            return {
                ...customerData,
                blocked: isUserBlocked(customerData.status),
                bookingCount: Number(customerData.bookingCount || 0),
                lastBookingDate: customerData.lastBookingDate
                    ? new Date(customerData.lastBookingDate).toISOString().split('T')[0]
                    : null,
                totalAmountSpent: Number(customerData.totalAmountSpent || 0).toFixed(2),
            };
        });

        const pagination = buildPagination(totalCount, window);
        return {
            customers: formattedCustomers,
            pagination: {
                ...pagination,
                // legacy aliases kept for older clients
                totalCount: pagination.totalRecords,
                hasPreviousPage: pagination.hasPrevPage,
            },
            filters: {
                search: searchTerm,
                status: statusFilter || null,
                startDate: query.startDate || null,
                endDate: query.endDate || null,
            },
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
     * Admin-created customer: verified immediately so they can sign in to the app.
     * Super Admin and staff with customerManagement create can call this.
     */
    async addCustomer(customerData) {
        const firstName = String(customerData?.firstName || '').trim();
        const lastName = String(customerData?.lastName || '').trim();
        const email = String(customerData?.email || '').trim().toLowerCase();
        const phoneNum = String(customerData?.phoneNum || '').trim();
        const password = String(customerData?.password || '');
        const countryCode = customerData?.countryCode
            ? String(customerData.countryCode).trim()
            : null;

        if (!firstName || !lastName || !email || !phoneNum || !password) {
            throw new ValidationError(
                'firstName, lastName, email, phoneNum and password are required'
            );
        }
        const phoneError = customerPhoneError(phoneNum);
        if (phoneError) {
            throw new ValidationError(phoneError);
        }
        if (password.length < 6) {
            throw new ValidationError('Password must be at least 6 characters');
        }

        const existingEmail = await users.findOne({
            where: { email, deletedAt: { [Op.is]: null } },
            attributes: ['id', 'userTypeId', 'verifiedAt'],
        });
        if (existingEmail) {
            throw new ConflictError(
                'An account with this email already exists. Please use a different email.'
            );
        }

        const existingPhone = await users.findOne({
            where: {
                phoneNum,
                deletedAt: { [Op.is]: null },
                userTypeId: 2,
            },
            attributes: ['id'],
        });
        if (existingPhone) {
            throw new ConflictError(
                'A customer with this phone number already exists. Please use a different number.'
            );
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        let user;
        try {
            user = await users.create({
                firstName,
                lastName,
                email,
                phoneNum,
                countryCode,
                password: hashedPassword,
                userTypeId: 2,
                status: true,
                verifiedAt: new Date(),
            });
        } catch (dbError) {
            if (dbError instanceof UniqueConstraintError) {
                throw new ConflictError(
                    'An account with this email already exists. Please use a different email.'
                );
            }
            if (dbError instanceof SequelizeValidationError) {
                const messages = dbError.errors.map((e) => e.message).join(', ');
                throw new ValidationError(`Invalid data: ${messages}`);
            }
            throw dbError;
        }

        let stripeCustomerId = null;
        try {
            stripeCustomerId = await stripe.createStripeCustomer(
                `${firstName} ${lastName}`.trim(),
                email
            );
            await users.update(
                { stripeCustomerId },
                { where: { id: user.id } }
            );
        } catch (stripeError) {
            console.error(
                '⚠️ Admin addCustomer Stripe failed (account still created):',
                stripeError.message || stripeError
            );
        }

        try {
            await signupWelcomeMail({
                email,
                userName: firstName || 'Customer',
            });
        } catch (mailError) {
            console.error(
                '⚠️ Admin addCustomer welcome email failed (non-blocking):',
                mailError.message || mailError
            );
        }

        return {
            id: user.id,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            phoneNum: user.phoneNum,
            status: user.status,
            verifiedAt: user.verifiedAt,
            stripeCustomerId,
        };
    }

    /**
     * Get specific customer details with bookings
     * @param {number} customerId - Customer ID
     * @returns {Object} Customer details with booking information
     */
    async getSpecificCustomerDetails(customerId) {
            const normalizedCustomerId = Number(customerId);
            if (!Number.isInteger(normalizedCustomerId) || normalizedCustomerId <= 0) {
                throw new ValidationError('Invalid customer ID');
            }
            const customer = await users.findOne({
                where: { id: normalizedCustomerId, userTypeId: 2 },
                attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum', 'countryCode', 'status', 'createdAt'],
            });
            if (!customer) {
                throw new NotFoundError('Customer not found');
            }

            const [bookingsFind, userInfo] = await Promise.all([
                booking.findAll({
                    where: { customerId: normalizedCustomerId },
                    include: [
                        {
                            model: customerSelectedService,
                            // Active lines only; edited invoices deactivate replaced lines.
                            required: false,
                            where: { status: true },
                            include: [
                                {
                                    model:service,
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
                            attributes: ['id', 'firstName', 'lastName', 'email','phoneNum', 'countryCode']
                        },
                        {
                            model: users,
                            as: 'deliveryDriver',
                            attributes: ['id', 'firstName', 'lastName', 'email','phoneNum', 'countryCode']
                        }
                    ],
                    order: [['id', 'DESC']],
                    attributes: {
                        exclude: [
                            'updatedAt', 'categoryId', 'serviceId', 'subCategoryId', 'vehicleTypeId',
                            'driverInstructionOptions', 'driverInstructionOptions1', 'paymentConfirmed',
                            'partialPayment', 'subTotal', 'onHoldReason', 'OnHoldOtherReason',
                            'paymentMethodId', 'paymentIntentId', 'pickupAddresId', 'dropOffAddressId', 'tipId'
                        ],
                    },
                }),

                addressDb.findOne({
                    where: { userId: normalizedCustomerId },
                    include: [
                        {
                            model: users,
                            attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum', 'countryCode', 'status', 'createdAt'],
                        },
                    ],
                    order: [['createdAt', 'DESC']],
                    attributes: ['id', 'title', 'streetAddress', 'district', 'province', 'lat', 'lng', 'status', 'addressType', 'userId'],
                }),
            ]);

            return {
                bookingDetails: bookingsFind,
                userDetails: presentCustomerUserDetails(customer, userInfo),
            };
    }

    /**
     * Update customer details
     * @param {number} customerId - Customer ID
     * @param {Object} updateData - Customer update data
     * @returns {Object} Updated customer data
     */
    async updateCustomer(customerId, updateData) {
            const customerExists = await users.findOne({
                where: {
                    id: customerId,
                    userTypeId: 2
                }
            });

            if (!customerExists) {
                throw new NotFoundError('Customer not found');
            }

            const allowed = ['firstName', 'lastName', 'email', 'phoneNum', 'countryCode', 'status', 'password'];
            const updateFields = {};
            for (const key of allowed) {
                if (updateData[key] !== undefined) updateFields[key] = updateData[key];
            }

            if (updateFields.firstName !== undefined) {
                updateFields.firstName = String(updateFields.firstName || '').trim();
                if (!updateFields.firstName) throw new ValidationError('First name is required');
            }
            if (updateFields.lastName !== undefined) {
                updateFields.lastName = String(updateFields.lastName || '').trim();
                if (!updateFields.lastName) throw new ValidationError('Last name is required');
            }

            if (updateFields.email !== undefined) {
                updateFields.email = String(updateFields.email || '').trim().toLowerCase();
                if (!updateFields.email) throw new ValidationError('Email is required');
            }

            if (updateFields.email && updateFields.email !== customerExists.email) {
                const emailExists = await users.findOne({
                    where: {
                        email: updateFields.email,
                        id: { [Op.ne]: customerId },
                        deletedAt: { [Op.is]: null }
                    }
                });

                if (emailExists) {
                    throw new ConflictError('Email already exists');
                }
            }

            if (updateFields.phoneNum !== undefined) {
                updateFields.phoneNum = String(updateFields.phoneNum || '').trim();
                const phoneError = customerPhoneError(updateFields.phoneNum);
                if (phoneError) {
                    throw new ValidationError(phoneError);
                }
                if (updateFields.phoneNum !== customerExists.phoneNum) {
                    const phoneExists = await users.findOne({
                        where: {
                            phoneNum: updateFields.phoneNum,
                            id: { [Op.ne]: customerId },
                            deletedAt: { [Op.is]: null },
                            userTypeId: 2
                        },
                        attributes: ['id']
                    });
                    if (phoneExists) {
                        throw new ConflictError(
                            'A customer with this phone number already exists. Please use a different number.'
                        );
                    }
                }
            }

            if (updateFields.password !== undefined) {
                const nextPassword = String(updateFields.password || '');
                if (!nextPassword.trim()) {
                    delete updateFields.password;
                } else if (nextPassword.length < 6) {
                    throw new ValidationError('Password must be at least 6 characters');
                } else {
                    updateFields.password = await bcrypt.hash(nextPassword, 10);
                }
            }

            if (Object.keys(updateFields).length === 0) {
                throw new ValidationError('No changes were made');
            }

            const updatedCustomer = await users.update(updateFields, {
                where: {
                    id: customerId,
                    userTypeId: 2
                }
            });

            if (updatedCustomer[0] === 0) {
                throw new ValidationError('No changes were made');
            }

            const updatedCustomerData = await users.findOne({
                where: {
                    id: customerId,
                    userTypeId: 2
                },
                attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum', 'countryCode', 'status', 'createdAt']
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
