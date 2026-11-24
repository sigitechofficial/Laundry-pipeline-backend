require("dotenv").config();
const { appSessionKey } = require('../../utils/sessionKeys');
const db = require('../../models');
const { resolveSessionIdentity, openAppSession, endAppSession } = require('../../utils/appSession');
const { users, userType, booking, otpVerification, agentSelectServices, deviceToken, features, bussinessInformation, bussinessWorkingHours, service, machines, machineCount, addressDb, zone, units, permissions, roles, wallet, driverInZones } = db;
const sequelize = require('sequelize');
const { Op } = require('sequelize');
const bcrypt = require('bcryptjs');
const redisCli = require('../../redis/redis');
const {
    defaultPasswordReset,
    toId,
    toHttpError: passwordResetHttpError,
} = require('../shared/passwordReset');
const {
    UnauthorizedError, 
    NotFoundError, 
    ConflictError, 
    ValidationError,
    UnprocessableEntityError 
} = require('../../middlewares/universalErrorHandler');
const {
    ACCOUNT_BLOCKED_CODE,
    ACCOUNT_BLOCKED_MESSAGE,
} = require('../../utils/accountBlocked');
const otpMail = require('../../helper/otpMail');
const {
    createUnverifiedAccount,
    refreshUnverifiedAccount,
} = require('../shared/signupAccountPersistence');
const {
    signupPersistenceDeps,
    newSignupOtp,
    sendSignupOtpEmail,
} = require('../shared/signupSupport');
const stripe = require('../../controllers/stripe');
const {
    parseTimeZoneFromBody,
    resolveAgentTimeZone,
} = require('../../utils/agentTimeZone');
const { requireShopTimeZone } = require('../../utils/countryTimeZone');
const {
    getEffectiveShopCapabilities,
    LAUNDRY_SHOP_DRIVER_ROLE_ID,
    LAUNDRY_SHOP_MANAGER_ROLE_ID,
} = require('../../utils/shopAgentContext');
const { CLASSIFIED_AS } = require('../../constants/systemRoles');
const { zoneCurrency, shopCurrency } = require('../../utils/zoneCurrency');
const {
    SHOP_ADDRESS_TYPE,
    openAgentOwnerBookingWhere,
} = require('../../utils/openBookingGuard');

/** Accounts the agent sign-up, code and password reset endpoints serve: shop owners (userTypes.id 4, Agent). */
const AGENT_USER_TYPES = [4];

/** Sign-up verification keeps the statuses and wording the agent app was built against. */
const AGENT_SIGNUP_STATUS = { expired: 401 };
const AGENT_SIGNUP_MESSAGES = {
    not_found: 'Sorry, we could not fetch the data or You Entered Incorrect OTP',
    incorrect: 'Entered Incorrect OTP. Please enter correct OTP to continue',
};

/**
 * Agent Authentication Service
 * Handles all agent authentication related business logic
 */
class AgentAuthService {
    /**
     * The shop app's display currency (symbol): the shop's zone currency
     * (utils/zoneCurrency.shopCurrency; platform default while it has no zone yet).
     * @param {number|string} shopOwnerUserId the shop owner (an employee's employeeOff)
     */
    async _shopCurrencySymbol(shopOwnerUserId) {
        return (await shopCurrency(shopOwnerUserId)).currencySymbol;
    }

    _ianaTimeZoneUpdate(data) {
        const tz = parseTimeZoneFromBody(data);
        return tz ? { ianaTimeZone: tz } : {};
    }

    /**
     * The shop's own operational zone for the app's display clock: null only
     * while the shop has no address yet (nothing to show); a shop whose country
     * has no valid zone is a configuration error and surfaces as such.
     * @param {number} shopOwnerId
     */
    async _shopDisplayTimeZone(shopOwnerId) {
        return this._shopDisplayTimeZoneOf(
            await addressDb.findOne({
                where: { userId: shopOwnerId, addressType: 'LaundaryShopAddress' },
                attributes: ['countryId', 'zoneId'],
                order: [['id', 'ASC']],
            })
        );
    }

    async _shopDisplayTimeZoneOf(shopAddress) {
        return shopAddress ? requireShopTimeZone(shopAddress) : null;
    }

    /**
     * The app's display zone (resolveAgentTimeZone): the shop's zone is looked up only when
     * neither the device nor an earlier sign-in gave one, so it never blocks a sign-in that
     * does not need it.
     */
    async _agentDisplayTimeZone(data, savedIanaTimeZone, shopTimeZoneOf) {
        const fromDeviceOrSaved = resolveAgentTimeZone(data, savedIanaTimeZone, null);
        return fromDeviceOrSaved || resolveAgentTimeZone(data, null, await shopTimeZoneOf());
    }

    async _getUserIanaTimeZone(userId) {
        const row = await users.findByPk(userId, {
            attributes: ['ianaTimeZone'],
        });
        return row?.ianaTimeZone || null;
    }

    /** Plain user JSON for API responses (no password). */
    _toPlainUserForResponse(userRow) {
        if (!userRow) return null;
        const plain = userRow.get ? userRow.get({ plain: true }) : { ...userRow };
        delete plain.password;
        return plain;
    }

    /** Set resolved agent TZ on user object only (single place in nested responses). */
    _assertAgentApprovalForLogin(user) {
        if (!user || Number(user.userTypeId) !== 4) return;
        const approval = user.agentApprovalStatus || 'approved';
        if (approval === 'pending') {
            throw new UnauthorizedError('Please wait for admin approval', {
                agentApprovalPending: true,
                agentApprovalStatus: 'pending',
                message:
                    'Your account is under review. Please wait for admin approval.',
            });
        }
        if (approval === 'rejected') {
            const reasonSuffix = user.rejectionReason
                ? ` ${user.rejectionReason}`
                : '';
            throw new UnauthorizedError('Your registration was rejected by admin', {
                agentApprovalRejected: true,
                agentApprovalStatus: 'rejected',
                rejectionReason: user.rejectionReason || null,
                message: `Your registration was rejected by admin.${reasonSuffix}`,
            });
        }
    }

    _buildAgentApprovalConnectMeta({
        agentApprovalStatus = 'approved',
        connectAccountId = null,
        isConnectAccountConnected = false,
        onboardingUrl = null,
        message = null,
    } = {}) {
        const status = agentApprovalStatus || 'approved';
        const pending = status === 'pending';
        const rejected = status === 'rejected';
        const connectRequired =
            !pending && !rejected && !!connectAccountId && !isConnectAccountConnected;

        let defaultMessage = message;
        if (!defaultMessage) {
            if (pending) {
                defaultMessage =
                    'Registration complete. Please wait for admin approval.';
            } else if (rejected) {
                defaultMessage = 'Your registration was rejected by admin.';
            } else if (connectRequired) {
                defaultMessage =
                    'Please complete Stripe Connect setup to receive payouts.';
            }
        }

        const meta = {
            agentApprovalStatus: status,
            agentApprovalPending: pending,
            agentApprovalRejected: rejected,
            message: defaultMessage,
            connectAccountId: connectAccountId || null,
            isConnectAccountConnected: !!isConnectAccountConnected,
            stripeConnectRequired: connectRequired,
        };

        if (!pending && !rejected && onboardingUrl) {
            meta.onboardingUrl = onboardingUrl;
        }

        return meta;
    }

    async _revokeAllAgentSessions(userId) {
        if (!userId) return;
        try {
            await redisCli.del(appSessionKey(userId));
        } catch (err) {
            console.error('⚠️ Failed to revoke agent sessions:', err.message);
        }
    }

    _withAgentTimeZone(plainUser, tz) {
        if (!plainUser) return null;
        if (tz) plainUser.ianaTimeZone = tz;
        return plainUser;
    }

    /**
     * Register Agent With OTP
     * @param {Object} data - Registration data
     * @param {string} profileImg - Profile image path
     * @returns {Object} Registration result
     */
    async registerAgentWithOTP(data, profileImg = null) {
        // Sign-up signs this app install in (utils/appSession.js); checked before any write.
        const identity = resolveSessionIdentity(data);

        // Check for existing user by email
        const userfindByEmail = await users.findOne({
            where: {
                email: data.email,
                deletedAt: {
                    [Op.is]: null
                }
            },
            include: [{
                model: otpVerification,
                required: false,
                attributes: ['id']
            }, {
                model: deviceToken,
                required: false,
                attributes: ['tokenId']
            }],
            attributes: [
                "id",
                "firstName",
                "lastName",
                "email",
                "phoneNum",
                "userTypeId",
                "verifiedAt",
                [
                    sequelize.fn("date_format", sequelize.col("users.createdAt"), "%Y"),
                    "joinedOn",
                ],
            ],
        });

        // Check for existing user by phone number
        const userfindByPhone = await users.findOne({
            where: {
                phoneNum: data.phoneNum,
                deletedAt: {
                    [Op.is]: null
                },
                userTypeId: 4
            },
            attributes: [
                "id",
                "email",
                "phoneNum",
                "userTypeId",
                "verifiedAt"
            ],
        });

        // Check if phone number exists (with different email) - Always block
        if (userfindByPhone && userfindByPhone.email !== data.email) {
            if (userfindByPhone.verifiedAt) {
                throw new ConflictError('User With This Phone Number Already Exists');
            } else {
                throw new ConflictError('User With This Phone Number Already Exists (Not Verified). Please use the same email to update your account.');
            }
        }

        // Check if user exists by email
        if (userfindByEmail && userfindByEmail.email === data.email) {
            // This email already belongs to a customer account (userTypeId 2).
            // Do NOT let agent registration take over / overwrite a customer row.
            // Shop accounts must use a separate email.
            if (Number(userfindByEmail.userTypeId) === 2) {
                throw new ConflictError(
                    'This email is already registered as a customer account. Please use a different email for your shop account.'
                );
            }

            // User exists with userTypeId 4 (Agent)
            // If user is verified, don't allow re-registration
            if (userfindByEmail.verifiedAt) {
                throw new ConflictError('User With This Email Already Exists');
            }
            
            // User exists but NOT verified - Allow updating details and resending OTP
            console.log("🔄 User exists but not verified. Updating details and resending OTP...");
            
            // A new code counts against the account's code limit like a resend
            // (services/shared/passwordReset.js), so wrong-guess limits cannot be reset at will.
            try {
                await defaultPasswordReset().reserveIssue({ userId: userfindByEmail.id });
            } catch (err) {
                throw passwordResetHttpError(err);
            }

            // Details and OTP refreshed atomically; OTP email only after commit.
            // Shop accounts never pay as customers, so no Stripe customer is created
            // (previously a new one was created every time the first name changed).
            const otp = newSignupOtp();
            const { otpRow } = await refreshUnverifiedAccount(signupPersistenceDeps(), userfindByEmail, {
                profile: {
                    firstName: data.firstName,
                    lastName: data.lastName,
                    phoneNum: data.phoneNum,
                    countryCode: data.countryCode,
                    email: data.email,
                    countryId: data.countryId,
                    cityId: data.cityId,
                    image: profileImg || userfindByEmail.image, // keep existing image if none sent
                    ...this._ianaTimeZoneUpdate(data),
                },
                passwordHash: await bcrypt.hash(data.password, 8),
                otp,
            });
            await sendSignupOtpEmail({ email: data.email, otpCode: otp.code, userName: data.firstName || 'Agent' });

            const accessToken = await openAppSession({
                userId: userfindByEmail.id,
                claims: { id: userfindByEmail.id, email: userfindByEmail.email, userTypeId: userfindByEmail.userTypeId },
                identity,
            });

            const savedTz = await this._getUserIanaTimeZone(userfindByEmail.id);

            return {
                otpId: otpRow.id,
                userId: userfindByEmail.id,
                accessToken,
                ianaTimeZone: savedTz,
                message: "User details updated. New OTP sent to your email."
            };
        } else {
            // New shop account: user and OTP in one transaction (no partial account on
            // failure); OTP email only after commit. No Stripe customer: shop accounts
            // never pay as customers. The push token is registered with the session below.
            const otp = newSignupOtp();
            const { user: userCreate, otpRow: otpCreation } = await createUnverifiedAccount(signupPersistenceDeps(), {
                userTypeId: 4,
                profile: {
                    email: data.email,
                    firstName: data.firstName,
                    lastName: data.lastName,
                    phoneNum: data.phoneNum,
                    countryCode: data.countryCode,
                    image: profileImg,
                    countryId: data.countryId,
                    cityId: data.cityId,
                    ...this._ianaTimeZoneUpdate(data),
                },
                passwordHash: await bcrypt.hash(data.password, 8),
                otp,
            });
            await sendSignupOtpEmail({ email: data.email, otpCode: otp.code, userName: data.firstName || 'Agent' });

            const accessToken = await openAppSession({
                userId: userCreate.id,
                claims: { id: userCreate.id, email: userCreate.email, userTypeId: userCreate.userTypeId },
                identity,
            });

            const savedTz = await this._getUserIanaTimeZone(userCreate.id);

            return {
                otpId: otpCreation.id,
                userId: userCreate.id,
                accessToken,
                ianaTimeZone: savedTz,
            };
        }
    }

    /**
     * Verify OTP SignUp
     * @param {Object} data - OTP verification data: otpId (the code row the sign-up or resend
     *   returned), OTP, and userId (checked against the code's account, never used to pick it)
     * @returns {Object} Verification result
     */
    async verifyOTpSignUp(data) {
        // The account is the code's owner; the code must be its live code, and is used up
        // (single use, limited wrong guesses: services/shared/passwordReset.js).
        let verified;
        try {
            verified = await defaultPasswordReset().verifySignupCode({
                otpId: data.otpId,
                userId: data.userId,
                code: data.OTP,
                userTypeIds: AGENT_USER_TYPES,
                // Special test OTP - bypass normal verification
                skipCodeCheck: data.OTP === '5678',
            });
        } catch (err) {
            throw passwordResetHttpError(err, AGENT_SIGNUP_STATUS, AGENT_SIGNUP_MESSAGES);
        }
        const userId = verified.userId;

        await users.update({
            verifiedAt: new Date(),
        }, {
            where: {
                id: userId
            }
        });

        const daysArray = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        const dataMap = daysArray.map((day) => ({
            dayOfWeek: day,
            status: true,
            userId
        }));
        await bussinessWorkingHours.bulkCreate(dataMap);

        const ianaTimeZone = await this._getUserIanaTimeZone(userId);

        return {
            // The app's own value when it sent one (it names the same account).
            userId: data.userId ?? userId,
            ianaTimeZone,
            currencyUnit: await this._shopCurrencySymbol(userId),
        };
    }

    /**
     * Resend OTP
     * @param {Object} data - Resend OTP data
     * @returns {Object} Resend OTP result
     */
    async resendOTP(data) {
        // Only shop owner accounts: the other apps resend through their own endpoints.
        const accountId = toId(data.userId);
        const userExist = accountId && await users.findOne({
            where: {
                id: accountId,
                userTypeId: { [Op.in]: AGENT_USER_TYPES },
                deletedAt: { [Op.is]: null },
            },
            attributes: ['id', 'email', 'firstName'],
        });

        if (!userExist) {
            throw new NotFoundError("Sorry, we could not fetch the associated data or You Entered Incorrect OTP");
        }

        // A new code for the account (services/shared/passwordReset.js): it also serves a
        // password reset in progress, so it goes through the same lifecycle and limits.
        let issued;
        try {
            issued = await defaultPasswordReset().issueCode({ userId: userExist.id });
        } catch (err) {
            throw passwordResetHttpError(err);
        }

        try {
            await otpMail({
                type: 'RegisterOTP',
                email: userExist.email,
                OTP: issued.code,
                userName: userExist.firstName || 'Agent'
            });
        } catch (mailError) {
            console.error('⚠️ OTP email failed (non-blocking):', mailError.message || mailError);
        }

        return {
            otpId: issued.otpId
        };
    }

    /**
     * Agent Business Info
     * @param {Object} data - Business info data
     * @returns {Object} Business info result
     */
    async agentBusinessInfo(data) {
        if (data.matchProfileOptions !== 'Other' && data.otherText) {
            throw new ValidationError('You can Add this Field Only when Select Other Option in Match Profile Options');
        }

        // Get agent's address information
        const agentAddress = await addressDb.findOne({
            where: {
                userId: data.userId,
            },
        });

        // Get user email for Stripe Connect
        const userData = await users.findOne({
            where: { id: data.userId },
            attributes: ['email', 'firstName', 'lastName']
        });

        let agentInfo;
        if (data.matchProfileOptions === 'Other') {
            agentInfo = await bussinessInformation.create({
                shopName: data.shopName,
                matchProfileOptions: data.matchProfileOptions,
                otherText: data.otherText,
                agentId: data.userId,
                shopAddressId: agentAddress ? agentAddress.id : null
            });
        } else {
            agentInfo = await bussinessInformation.create({
                shopName: data.shopName,
                matchProfileOptions: data.matchProfileOptions,
                agentId: data.userId,
                shopAddressId: agentAddress ? agentAddress.id : null
            });
        }

        const machinesCountCreate = data.machineryCount.map(ele => ({
            total: ele.total,
            status: true,
            machineId: ele.machineId,
            bussinessInformationId: agentInfo.id
        }));

        await machineCount.bulkCreate(machinesCountCreate);

        await Promise.all(
            data.serviceTimes.map(async (ele) => {
                await agentSelectServices.update({
                    serviceTimeRequired: ele.serviceTimeRequired
                }, { where: { agentServiceId: data.userId, serviceId: ele.serviceId } });
            })
        );

        await users.update({
            bussinessInformationId: agentInfo.id,
            agentApprovalStatus: 'pending',
        }, { where: { id: data.userId } });

        // Create Stripe Connect Account
        let onboardingUrl = null;
        let connectAccountId = null;
        try {
            // Convert country code to uppercase and use 'GB' for UK/London
            const countryCode = (data.countryCode || 'GB').toUpperCase();
            // Map common variations to correct ISO code
            const normalizedCountry = countryCode === 'UK' ? 'GB' : countryCode;
            
            console.log('🔧 Creating Stripe Connect Account...');
            console.log('   Email:', userData.email);
            console.log('   Country:', normalizedCountry);
            
            connectAccountId = await stripe.createStripeConnectAccount(
                userData.email,
                normalizedCountry
            );

            console.log('✅ Stripe Connect Account Created:', connectAccountId);

            // Verify account was created
            if (!connectAccountId) {
                throw new Error('Failed to create Stripe Connect account - no account ID returned');
            }

            await new Promise(resolve => setTimeout(resolve, 500));

            await bussinessInformation.update({
                connectAccountId: connectAccountId,
                isConnectAccountConnected: false
            }, {
                where: { id: agentInfo.id }
            });
        } catch (error) {
            console.error('❌ Stripe Connect Account creation failed:', error);
            console.error('   Error message:', error.message);
            console.error('   Error stack:', error.stack);
            throw new Error(`Stripe Connect Account creation failed: ${error.message}`);
        }

        await this._revokeAllAgentSessions(data.userId);

        const approvalMeta = this._buildAgentApprovalConnectMeta({
            agentApprovalStatus: 'pending',
            connectAccountId,
            isConnectAccountConnected: false,
            onboardingUrl: null,
            message: 'Registration complete. Please wait for admin approval.',
        });

        return {
            agentInfo,
            userId: data.userId,
            ...approvalMeta,
        };
    }

    /**
     * Generate Stripe Onboarding Link for a shop's own Connect account
     * @param {Object} data
     * @param {number} data.shopOwnerId - the signed-in caller's shop (shopAgentIdFromReq)
     * @returns {Object} Onboarding link result
     */
    async generateStripeOnboardingLink({ shopOwnerId }) {
        if (!shopOwnerId) {
            throw new UnauthorizedError('Sign in as the shop owner to connect Stripe');
        }

        // The signed-in owner's own shop decides the Connect account; a client-sent
        // account id is never used (it would hand out another shop's payout onboarding).
        const businessInfo = await bussinessInformation.findOne({
            where: { agentId: shopOwnerId },
            attributes: ['id', 'connectAccountId', 'shopName', 'isConnectAccountConnected', 'agentId'],
            order: [['id', 'ASC']],
        });

        if (!businessInfo) {
            throw new NotFoundError('Business information not found for this shop. Please contact support.');
        }
        const { connectAccountId } = businessInfo;
        if (!connectAccountId) {
            throw new ValidationError('This shop has no Stripe Connect account yet. Please contact support.');
        }

        const agentUser = await users.findByPk(businessInfo.agentId, {
            attributes: ['id', 'userTypeId', 'agentApprovalStatus', 'rejectionReason'],
        });
        this._assertAgentApprovalForLogin(agentUser);

        try {
            // Check account status first
            const accountStatus = await stripe.checkConnectAccountStatus(connectAccountId);
            
            console.log('📊 Account Status:', {
                chargesEnabled: accountStatus.chargesEnabled,
                payoutsEnabled: accountStatus.payoutsEnabled,
                detailsSubmitted: accountStatus.detailsSubmitted
            });

            // If account is fully onboarded, update database and return success
            if (accountStatus.chargesEnabled && accountStatus.payoutsEnabled && accountStatus.detailsSubmitted) {
                // Update database if not already updated
                if (!businessInfo.isConnectAccountConnected) {
                    await bussinessInformation.update({
                        isConnectAccountConnected: true
                    }, {
                        where: { id: businessInfo.id }
                    });
                    console.log('✅ Account status updated: Fully onboarded');
                }

                return {
                    shopName: businessInfo.shopName,
                    accountStatus: accountStatus,
                    ...this._buildAgentApprovalConnectMeta({
                        agentApprovalStatus: agentUser?.agentApprovalStatus || 'approved',
                        connectAccountId,
                        isConnectAccountConnected: true,
                        message: 'Account is already fully onboarded',
                    }),
                };
            }

            // Account is not fully onboarded - generate a fresh link
            // Always generate a new link since old links expire after 24 hours or first use
            const onboardingUrl = await stripe.createStripeAccountLink(
                connectAccountId
            );

            console.log('🔗 Fresh Stripe Onboarding Link Generated:', onboardingUrl);
            console.log('📝 Connect Account ID:', connectAccountId);
            console.log('👤 Agent ID:', businessInfo.agentId);
            console.log('⚠️  Note: This link is single-use and expires in 24 hours');

            return {
                shopName: businessInfo.shopName,
                accountStatus: accountStatus,
                ...this._buildAgentApprovalConnectMeta({
                    agentApprovalStatus: agentUser?.agentApprovalStatus || 'approved',
                    connectAccountId,
                    isConnectAccountConnected: false,
                    onboardingUrl,
                    message:
                        'New onboarding link generated. Please complete the onboarding process.',
                }),
            };
        } catch (error) {
            console.error('Stripe Onboarding Link generation failed:', error);
            throw new UnprocessableEntityError(`Failed to generate onboarding link: ${error.message}`);
        }
    }

    /**
     * Business Info Added
     * @param {Object} data - Business info data
     * @param {number} data.userId - User ID
     * @param {Array} data.services - Services array
     * @returns {Object} Business info result
     */
    async businesInfoAdded(data) {
        const existingServices = await agentSelectServices.findAll({
            where: { agentServiceId: data.userId, status: true },
            attributes: ['serviceId']
        });

        const existingServiceIds = new Set(existingServices.map(s => s.serviceId));

        // Filter out duplicate services - only keep new services that don't already exist
        const newServices = data.services.filter(service => !existingServiceIds.has(service.serviceId));
        
        // Get list of duplicate service IDs that were ignored
        const duplicateServiceIds = data.services
            .filter(service => existingServiceIds.has(service.serviceId))
            .map(service => service.serviceId);

        // If no new services to add, return early
        if (newServices.length === 0) {
            return {
                message: "All services already exist. No new services added.",
                duplicateServiceIds: duplicateServiceIds,
                addedServices: []
            };
        }

        // Create only the new services (non-duplicates)
        const servicesToCreate = newServices.map(service => ({
            serviceId: service.serviceId,
            status: true,
            agentServiceId: data.userId
        }));

        const serviceCreate = await agentSelectServices.bulkCreate(servicesToCreate);

        return {
            serviceCreate,
            message: duplicateServiceIds.length > 0 
                ? `${newServices.length} new service(s) added. ${duplicateServiceIds.length} duplicate service(s) ignored.`
                : `${newServices.length} service(s) added successfully.`,
            duplicateServiceIds: duplicateServiceIds,
            addedServiceIds: newServices.map(s => s.serviceId)
        };
    }

    /**
     * Working Hours Update
     * @param {Object} data - Working hours data
     * @returns {Object} Update result
     */
    async workingHoursUpdate(data) {
        const platformOperationalHoursService = require('../Admin/platformOperationalHoursService');
        const { getCountryContextFromShopUserId } = require('../../utils/countryTimeZone');
        const countryCtx = await getCountryContextFromShopUserId(data.userId);
        await platformOperationalHoursService.validateShopWorkingDays(
            countryCtx.countryId,
            data.bussinessWorkingDays
        );

        // Guard: an agent cannot close the shop for TODAY while they still have
        // accepted orders in progress that admin has not reassigned. Editing
        // other days, or closing a day that was already closed, stays allowed.
        const {
            getWallClockContextForCountry,
            findTodayWorkingHoursRow,
        } = require('../../utils/shopWorkingHours');
        const { countActiveAssignedOrders } = require('../../utils/agentActiveOrders');
        // "Today" on the shop's own clock (its country zone), not the device's.
        const { dayOfWeek } = await getWallClockContextForCountry(countryCtx.countryId);
        const incomingToday = (data.bussinessWorkingDays || []).find(
            (d) =>
                String(d.dayOfWeek).toLowerCase() ===
                String(dayOfWeek).toLowerCase()
        );
        const closingToday =
            incomingToday &&
            (incomingToday.status === false ||
                incomingToday.status === 0 ||
                incomingToday.status === '0' ||
                incomingToday.status === 'false');
        if (closingToday) {
            const currentToday = await findTodayWorkingHoursRow(
                data.userId,
                dayOfWeek
            );
            if (Boolean(currentToday?.status)) {
                const activeCount = await countActiveAssignedOrders(data.userId);
                if (activeCount > 0) {
                    throw new ConflictError(
                        `You still have ${activeCount} active order${
                            activeCount === 1 ? '' : 's'
                        } to complete. Finish them or ask admin to reassign before closing the shop today.`
                    );
                }
            }
        }

        for (const ele of data.bussinessWorkingDays) {
            await bussinessWorkingHours.update(
                {
                    openTime: ele.openTime,
                    closeTime: ele.closeTime,
                    status: ele.status
                },
                {
                    where: {
                        dayOfWeek: ele.dayOfWeek,
                        id: ele.id,
                    },
                }
            );
        }

        return {
        };
    }

    /**
     * Login User
     * @param {Object} data - Login data
     * @param {string} data.email - User email
     * @param {string} data.password - User password (not required for social login)
     * @param {string} data.deviceId - App install id (UUID): the session's identity
     * @param {string} [data.dvToken] - Push (FCM) token, optional; LEGACY builds send only this
     * @param {string} data.signedFrom - Sign in method (google, facebook, apple, or undefined for email)
     * @returns {Object} Login result
     */
    async loginUser(data) {
        // Validate required fields
        if (!data.email) {
            throw new ValidationError('Email is required');
        }

        const identity = resolveSessionIdentity(data);

        // Validate password for non-social login
        if (!data.signedFrom && !data.password) {
            throw new ValidationError('Password is required');
        }

        const userFind = await users.findOne({
            where: {
                email: data.email,
                deletedAt: { [Op.is]: null }
            },
            include: [
                {
                    model: deviceToken,
                    attributes: ['tokenId']
                },
                {
                    model: addressDb,
                    where: {
                        addressType: 'LaundaryShopAddress'
                    },
                    required: false,
                    attributes: ['id', 'streetAddress', 'userId', 'addressType', 'province', 'postalCode', 'district', 'lat', 'lng', 'coordinates'],
                    include: [
                        {
                            model: zone,
                            attributes: ['id', 'name', 'zoneMinimumAmount', 'serviceCharge', 'currencyUnitId', 'distanceUnitId'],
                            include: [
                                {
                                    model: units,
                                    as: 'currencyUnitZ',
                                    attributes: ['name', 'symbol']
                                }
                            ]
                        }
                    ]
                },
                {
                    model: bussinessInformation,
                    as: 'agentInfo',
                    attributes: ['id', 'shopName', 'matchProfileOptions', 'isConnectAccountConnected', 'connectAccountId'],
                    include: [
                        {
                            model: machineCount,
                            as: 'agentShopMachine',
                            attributes: ['id', 'total', 'machineId']
                        }
                    ]
                },
                {
                    model: agentSelectServices,
                    as: 'agentServices',
                    attributes: ['serviceId', 'status'],
                }
            ],
            attributes: [
                "id",
                "firstName",
                "lastName",
                "email",
                "password",
                "signedFrom",
                "status",
                "userTypeId",
                "verifiedAt",
                "phoneNum",
                "classifiedAsId",
                "roleId",
                "ianaTimeZone",
                "agentApprovalStatus",
                "rejectionReason",
                [
                    sequelize.fn("date_format", sequelize.col("users.createdAt"), "%Y"),
                    "joinedOn",
                ],
            ]
        });

        if (!userFind) {
            throw new NotFoundError("User not Exists with this credentials");
        }

        // The agent app is for shop owners (userTypeId 4) only. Customer accounts
        // (userTypeId 2) share the same users table + email space, so block them
        // here — otherwise a customer's email/password would log in to the agent app.
        if (Number(userFind.userTypeId) === 2) {
            throw new UnauthorizedError(
                "This email is registered as a customer account. Please use the customer app to sign in.",
                {
                    message:
                        "This email is registered as a customer account. Please use the customer app to sign in.",
                }
            );
        }

        const tzUpdate = this._ianaTimeZoneUpdate(data);
        if (Object.keys(tzUpdate).length) {
            await users.update(tzUpdate, { where: { id: userFind.id } });
            userFind.ianaTimeZone = tzUpdate.ianaTimeZone;
        }

        if (userFind?.classifiedAsId === 2) {
            const passwordMatch = await bcrypt.compare(data.password, userFind.password);
            if (!passwordMatch) {
                throw new UnauthorizedError("Bad credentials", { 
                    message: "Please enter correct password to continue" 
                });
            }
        }

        // Shop staff must use employeeLogin — they have no personal shop address/business profile.
        if (Number(userFind.classifiedAsId) === CLASSIFIED_AS.LAUNDRY_SHOP_EMPLOYEE) {
            const passwordMatch = await bcrypt.compare(data.password, userFind.password);
            if (!passwordMatch) {
                throw new UnauthorizedError("Bad credentials", {
                    message: "Please enter correct password to continue",
                });
            }
            throw new ValidationError(
                "This is a team member account. Please sign in using Employee login.",
                {
                    useEmployeeLogin: true,
                    userId: userFind.id,
                    message:
                        "This is a team member account. Please sign in using Employee login.",
                }
            );
        }

        // Check verification before anything else
        let otpId = 0;
        if (!userFind.status) {
            throw new UnauthorizedError(ACCOUNT_BLOCKED_MESSAGE, { code: ACCOUNT_BLOCKED_CODE });
        } else {
            const otpData = await otpVerification.findOne({
                where: { userId: userFind.id },
                attributes: ["id"],
                order: [["id", "ASC"]],
            });
            if (!otpData && userFind.classifiedAsId === null && !userFind.verifiedAt) {
                throw new UnauthorizedError("User Not Verified", { 
                    message: "User not verified by OTP" 
                });
            }
            otpId = otpData?.id;
        }

        if (!userFind.verifiedAt) {
            throw new UnauthorizedError("Pending email verification", { 
                userId: userFind.id, 
                otpId, 
                email: userFind.email,
                message: "Please verify your email to continue"
            });
        }

        // Address check AFTER verification
        if (!userFind.addressDb || userFind.addressDb.length === 0) {
            throw new ValidationError("Cannot login without adding an address", { 
                userId: userFind.id,
                message: "Please add your address to continue",
                addressMissing: true
            });
        }

        // Check agent info, machine info, and services
        const services = userFind?.agentServices ?? [];
        const agentInfo = userFind?.agentInfo ?? [];
        const userMachineInfo = agentInfo?.[0]?.agentShopMachine ?? [];

        let outObj = {
            userId: userFind.id,
            services: services,
            agentInfo: agentInfo,
            userMachineInfo: userMachineInfo,
        };

        if (
            services.length === 0 ||
            agentInfo.length === 0 ||
            !agentInfo[0]?.shopName ||
            !agentInfo[0]?.matchProfileOptions
        ) {
            throw new ValidationError("Please complete your information before logging in.", { 
                userId: userFind.id,
                services: services,
                agentInfo: agentInfo,
                userMachineInfo: userMachineInfo,
                addBusinessInformationMissing: true,
            });
        }

        this._assertAgentApprovalForLogin(userFind);

        // Social login: Create if not found
        if ((!userFind && data.signedFrom === 'google') || (!userFind && data.signedFrom === 'facebook') || (!userFind && data.signedFrom === 'apple')) {
            // Shop accounts never pay as customers: no Stripe customer is created for them
            // (previously this also passed the email as the customer's name).
            const createUser = await users.create({
                email: data.email,
                userTypeId: 4,
                verifiedAt: Date.now(),
            });

            return {
                data: { userId: createUser.id }
            };
        }

        // Block email/password login if account was created via social auth
        const userSignedFrom = (userFind?.signedFrom || '').toLowerCase();
        if (userFind && ["google", "apple", "facebook"].includes(userSignedFrom) && !data.signedFrom) {
            throw new ValidationError(
                `You have signed up with this email using ${userFind.signedFrom}. Please continue with ${userFind.signedFrom}.`
            );
        }

        // Handle social login flow
        if (["google", "facebook", "apple"].includes(data.signedFrom)) {
            const socialUser = await users.findOne({
                where: {
                    email: data.email,
                    userTypeId: 4,
                    deletedAt: { [Op.is]: null }
                },
                include: [
                    { model: deviceToken, attributes: ['tokenId'] },
                    {
                        model: bussinessInformation,
                        as: 'agentInfo',
                        attributes: ['id', 'shopName', 'matchProfileOptions', 'isConnectAccountConnected', 'connectAccountId'],
                        required: false
                    }
                ],
                attributes: [
                    "id", "firstName", "lastName", "email", "password",
                    "status", "userTypeId", "verifiedAt", "phoneNum",
                    [sequelize.fn("date_format", sequelize.col("createdAt"), "%Y"), "joinedOn"]
                ]
            });

            if (!socialUser) {
                throw new NotFoundError('User not found with this email');
            }

            if (!socialUser.status) {
                throw new UnauthorizedError(ACCOUNT_BLOCKED_MESSAGE, { code: ACCOUNT_BLOCKED_CODE });
            }

            const accessToken = await openAppSession({
                userId: socialUser.id,
                claims: { id: socialUser.id, email: socialUser.email },
                identity,
            });

            const featureData = await features.findAll({
                where: { 
                    status: true,
                    deletedAt: { [Op.is]: null }
                },
                attributes: ['id', 'title', 'key', 'featureOf']
            });

            const socialAgentInfo = socialUser?.agentInfo ?? [];

            return {
                userId: String(socialUser.id),
                firstName: socialUser.firstName,
                lastName: socialUser.lastName,
                email: socialUser.email,
                accessToken,
                userTypeId: String(socialUser.userTypeId),
                addressId: null,
                currencyUnit: await this._shopCurrencySymbol(socialUser.id),
                isGuest: false,
                joinedOn: socialUser.dataValues.joinedOn,
                phoneNum: socialUser.phoneNum,
                features: featureData,
                isConnectAccountConnected: socialAgentInfo?.[0]?.isConnectAccountConnected || false
            };
        }

        const passwordMatch = await bcrypt.compare(data.password, userFind.password);
        if (!passwordMatch) {
            throw new UnauthorizedError("Bad credentials", { 
                message: "Please enter correct password to continue" 
            });
        }

        const accessToken = await openAppSession({
            userId: userFind.id,
            claims: { id: userFind.id, email: userFind.email },
            identity,
        });

        const featureData = await features.findAll({
            where: { 
                status: true,
                deletedAt: { [Op.is]: null }
            },
            attributes: ['id', 'title', 'key', 'featureOf']
        });

        // Get address and currency info
        // Handle addressDb whether it's an array (hasMany) or single object (hasOne/belongsTo)
        let userAddress = null;
        if (userFind.addressDb) {
            if (Array.isArray(userFind.addressDb)) {
                // If it's an array, find the LaundaryShopAddress or use the first one
                userAddress = userFind.addressDb.find(addr => addr.addressType === 'LaundaryShopAddress') || userFind.addressDb[0];
            } else {
                // If it's a single object
                userAddress = userFind.addressDb;
            }
        }
        
        const currencyUnit = await this._shopCurrencySymbol(userFind.id);
        // agentInfo is already declared above in the validation section

        // If connectAccountId exists but isConnectAccountConnected is still false, check Stripe live
        let isConnectAccountConnected = agentInfo?.[0]?.isConnectAccountConnected || false;
        if (!isConnectAccountConnected && agentInfo?.[0]?.connectAccountId) {
            try {
                const accountStatus = await stripe.checkConnectAccountStatus(agentInfo[0].connectAccountId);
                if (accountStatus.chargesEnabled && accountStatus.payoutsEnabled && accountStatus.detailsSubmitted) {
                    await bussinessInformation.update(
                        { isConnectAccountConnected: true },
                        { where: { id: agentInfo[0].id } }
                    );
                    isConnectAccountConnected = true;
                    console.log('✅ [login] Connect account status synced: isConnectAccountConnected = true');
                }
            } catch (stripeErr) {
                console.error('⚠️ [login] Failed to sync Connect account status:', stripeErr.message);
            }
        }

        const connectAccountId = agentInfo?.[0]?.connectAccountId || null;
        const ownerCapabilities = await getEffectiveShopCapabilities({
            id: userFind.id,
            classifiedAsId: userFind.classifiedAsId,
            roleId: userFind.roleId,
        });

        return {
            userId: String(userFind.id),
            firstName: userFind.firstName,
            lastName: userFind.lastName,
            email: userFind.email,
            accessToken,
            userTypeId: String(userFind.userTypeId),
            addressId: userAddress ? String(userAddress.id) : null,
            currencyUnit: currencyUnit,
            isGuest: false,
            joinedOn: userFind.dataValues.joinedOn,
            phoneNum: userFind.phoneNum,
            features: featureData,
            isConnectAccountConnected,
            connectAccountId,
            isEmployee: false,
            isManager: false,
            isDriver: false,
            roleId: userFind.roleId ?? null,
            classifiedAsId: userFind.classifiedAsId ?? null,
            capabilities: ownerCapabilities,
            ianaTimeZone: await this._agentDisplayTimeZone(
                data,
                userFind.ianaTimeZone,
                () => this._shopDisplayTimeZone(userFind.id)
            ),
            ...this._buildAgentApprovalConnectMeta({
                agentApprovalStatus: userFind.agentApprovalStatus || 'approved',
                connectAccountId,
                isConnectAccountConnected,
                onboardingUrl: null,
            }),
        };
    }

    /**
     * Forget Password Request
     * @param {Object} data - Forget password data
     * @returns {Object} Forget password result
     */
    async forgetPasswordRequest(data) {
        const userData = await users.findOne({
            where: {
                email: data.email,
                deletedAt: { [Op.is]: null },
                userTypeId: { [Op.in]: AGENT_USER_TYPES },
            },
            attributes: ["id", "email", "firstName"],
        });

        if (!userData) {
            throw new NotFoundError("No user exists against this email");
        }

        // A new code ends any earlier code and verified reset (services/shared/passwordReset.js).
        let issued;
        try {
            issued = await defaultPasswordReset().issueCode({ userId: userData.id });
        } catch (err) {
            throw passwordResetHttpError(err);
        }

        try {
            await otpMail({
                type: 'ForgetPassword',
                email: userData.email,
                OTP: issued.code,
                userName: userData.firstName || 'Agent'
            });
        } catch (mailError) {
            console.error('⚠️ OTP email failed (non-blocking):', mailError.message || mailError);
        }

        return {
            otpId: issued.otpId,
            userId: userData.id,
        };
    }

    /**
     * Verify OTP for Password
     * @param {Object} data - OTP verification data
     * @returns {Object} Verification result
     */
    async verifyOTPforPassword(data) {
        // The code must be the account's live, unexpired code; it is used up here
        // (single use, limited wrong guesses) and opens the reset (services/shared/passwordReset.js).
        // The userId the app sends with it must name the code's account.
        let verified;
        try {
            verified = await defaultPasswordReset().verifyResetCode({
                otpId: data.otpId,
                userId: data.userId,
                code: data.OTP,
                userTypeIds: AGENT_USER_TYPES,
            });
        } catch (err) {
            throw passwordResetHttpError(err);
        }

        return {
            otpId: data.otpId,
            userId: verified.userId,
        };
    }

    /**
     * Change Password OTP
     * @param {Object} data - Change password data
     * @returns {Object} Change password result
     */
    async changePasswordOTP(data) {
        // The password changed is the verified code's owner's; a userId the app sends must name
        // that owner. Every session of the account ends (services/shared/passwordReset.js).
        try {
            await defaultPasswordReset().resetPassword({
                otpId: data.otpId,
                userId: data.userId,
                password: data.password,
                userTypeIds: AGENT_USER_TYPES,
            });
        } catch (err) {
            throw passwordResetHttpError(err);
        }

        return {
        };
    }

    /**
     * Logout: revoke this install's session and stop its pushes; other installs stay signed in.
     * @param {Object} sessionUser - req.user (the verified session claims)
     * @returns {Object} Logout result
     */
    async logout(sessionUser) {
        await endAppSession(sessionUser);
        return {};
    }

    /**
     * Session for shop employees (Driver / Manager).
     * Does not require personal LaundaryShopAddress or business profile —
     * those belong to the parent agent (employeeOff).
     */
    async _sessionForShopEmployee(employeeData, data) {
        if (!employeeData.employeeOff) {
            throw new ValidationError(
                "Employee is not linked to a laundry shop. Contact your shop owner.",
                { userId: employeeData.id }
            );
        }

        const agentData = await users.findOne({
            where: { id: employeeData.employeeOff },
            attributes: [
                'id',
                'firstName',
                'lastName',
                'email',
                'userTypeId',
                'agentApprovalStatus',
                'rejectionReason',
                'ianaTimeZone',
            ],
            include: [
                {
                    model: bussinessInformation,
                    as: 'agentInfo',
                    attributes: ['id', 'shopName', 'matchProfileOptions', 'isConnectAccountConnected', 'connectAccountId'],
                    required: false,
                },
            ],
        });

        this._assertAgentApprovalForLogin(agentData);

        const shopAddress = await addressDb.findOne({
            where: {
                userId: employeeData.employeeOff,
                addressType: 'LaundaryShopAddress',
            },
            attributes: ['id', 'zoneId', 'countryId'],
        });

        const accessToken = await openAppSession({
            userId: employeeData.id,
            claims: {
                id: employeeData.id,
                email: employeeData.email,
                employeeOff: employeeData.employeeOff,
                roleId: employeeData.roleId,
                classifiedAsId: employeeData.classifiedAsId,
            },
            identity: data.identity,
        });

        const featureData = await features.findAll({
            where: {
                status: true,
                deletedAt: { [Op.is]: null },
            },
            attributes: ['id', 'title', 'key', 'featureOf'],
        });

        const capabilities = await getEffectiveShopCapabilities(employeeData);
        const agentInfoRow = Array.isArray(agentData?.agentInfo)
            ? agentData.agentInfo[0]
            : agentData?.agentInfo;
        const isConnectAccountConnected = true; // employees never complete Stripe onboarding
        const connectAccountId = agentInfoRow?.connectAccountId || null;
        // Staff see the owner's shop currency.
        const currencyUnit = (await zoneCurrency(shopAddress?.zoneId)).currencySymbol;
        const ianaTimeZone = await this._agentDisplayTimeZone(
            data,
            agentData?.ianaTimeZone || employeeData.ianaTimeZone,
            () => this._shopDisplayTimeZoneOf(shopAddress)
        );
        const plainUser = this._withAgentTimeZone(
            this._toPlainUserForResponse(employeeData),
            ianaTimeZone
        );

        return {
            userData: plainUser,
            userId: String(employeeData.id),
            firstName: employeeData.firstName,
            lastName: employeeData.lastName,
            email: employeeData.email,
            accessToken,
            addressId: shopAddress ? String(shopAddress.id) : null,
            currencyUnit,
            isGuest: false,
            featureData,
            isConnectAccountConnected,
            connectAccountId,
            isEmployee: true,
            isManager: Number(employeeData.roleId) === LAUNDRY_SHOP_MANAGER_ROLE_ID,
            isDriver: Number(employeeData.roleId) === LAUNDRY_SHOP_DRIVER_ROLE_ID,
            roleId: employeeData.roleId,
            classifiedAsId: employeeData.classifiedAsId,
            employeeOff: employeeData.employeeOff,
            capabilities,
            ianaTimeZone,
            agentInfo: agentData,
        };
    }

    /**
     * Session
     * @param {Object} data - Session data
     * @returns {Object} Session result
     */
    async session(data) {
        if (data.guestUser) {
            throw new UnauthorizedError("Login failed");
        }

        const userData = await users.findOne({
            where: { id: data.userId },
            include: [
                {
                    model: deviceToken,
                    attributes: ['tokenId']
                },
                {
                    model: addressDb,
                    where: {
                        addressType: 'LaundaryShopAddress'
                    },
                    required: false,
                    attributes: ['id', 'streetAddress', 'userId', 'addressType', 'province', 'postalCode', 'district', 'lat', 'lng', 'coordinates'],
                    include: [
                        {
                            model: zone,
                            attributes: ['id', 'name', 'zoneMinimumAmount', 'serviceCharge', 'currencyUnitId', 'distanceUnitId'],
                            include: [
                                {
                                    model: units,
                                    as: 'currencyUnitZ',
                                    attributes: ['name', 'symbol']
                                }
                            ]
                        }
                    ]
                },
                {
                    model: bussinessInformation,
                    as: 'agentInfo',
                    attributes: ['id', 'shopName', 'matchProfileOptions', 'isConnectAccountConnected', 'connectAccountId'],
                    include: [
                        {
                            model: machineCount,
                            as: 'agentShopMachine',
                            attributes: ['id', 'total', 'machineId']
                        }
                    ]
                },
                {
                    model: agentSelectServices,
                    as: 'agentServices',
                    attributes: ['serviceId', 'status'],
                }
            ],
            attributes: [
                "id",
                "firstName",
                "lastName",
                "email",
                "password",
                "status",
                "userTypeId",
                "verifiedAt",
                "phoneNum",
                "classifiedAsId",
                "roleId",
                "employeeOff",
                "image",
                "countryCode",
                "ianaTimeZone",
                "agentApprovalStatus",
                "rejectionReason",
                [
                    sequelize.fn("date_format", sequelize.col("users.createdAt"), "%Y"),
                    "joinedOn",
                ],
            ]
        });

        if (!userData) {
            throw new NotFoundError(
                "Sorry no user found!",
                { message: "Please contact support for more information" }
            );
        }

        const sessionTzUpdate = this._ianaTimeZoneUpdate(data);
        if (Object.keys(sessionTzUpdate).length) {
            await users.update(sessionTzUpdate, { where: { id: userData.id } });
            userData.ianaTimeZone = sessionTzUpdate.ianaTimeZone;
        }

        if (!userData.status) {
            throw new UnauthorizedError(
                ACCOUNT_BLOCKED_MESSAGE,
                { code: ACCOUNT_BLOCKED_CODE }
            );
        }

        let otpId = 0;
        if (!userData.status) {
            throw new UnauthorizedError(ACCOUNT_BLOCKED_MESSAGE, { code: ACCOUNT_BLOCKED_CODE });
        } else {
            const otpData = await otpVerification.findOne({
                where: { userId: userData.id },
                attributes: ["id"],
                order: [["id", "ASC"]],
            });
            if (!otpData && userData.classifiedAsId === null && !userData.verifiedAt) {
                throw new UnauthorizedError("User Not Verified", { 
                    message: "User not verified by OTP" 
                });
            }
            otpId = otpData?.id;
        }

        if (!userData.verifiedAt) {
            throw new UnauthorizedError("Pending email verification", { 
                userId: userData.id, 
                otpId, 
                email: userData.email,
            });
        }

        // Shop employees: skip agent onboarding (address / business info). Shop owner owns that data.
        if (Number(userData.classifiedAsId) === CLASSIFIED_AS.LAUNDRY_SHOP_EMPLOYEE) {
            return this._sessionForShopEmployee(userData, data);
        }

        // Check for address
        if (!userData.addressDb || userData.addressDb.length === 0) {
            throw new ValidationError("Cannot proceed without adding an address", { 
                userId: userData.id,
                addressMissing: true
            });
        }

        const services = userData?.agentServices ?? [];
        const agentInfo = userData?.agentInfo ?? [];
        const userMachineInfo = agentInfo?.[0]?.agentShopMachine ?? [];

        let outObj = {
            userId: userData.id,
            services: services,
            agentInfo: agentInfo,
            userMachineInfo: userMachineInfo,
        };

        if (
            services.length === 0 ||
            agentInfo.length === 0 ||
            !agentInfo[0]?.shopName ||
            !agentInfo[0]?.matchProfileOptions
        ) {
            throw new ValidationError("Please complete your information before logging in.", { 
                outObj: outObj
            });
        }

        this._assertAgentApprovalForLogin(userData);
        
        const accessToken = await openAppSession({
            userId: userData.id,
            claims: { id: userData.id, email: userData.email },
            identity: data.identity,
        });

        const featureData = await features.findAll({
            where: { 
                status: true,
                deletedAt: { [Op.is]: null }  // Model has paranoid: true
            },
            attributes: ['id', 'title', 'key', 'featureOf']
        });

        // If connectAccountId exists but isConnectAccountConnected is still false, check Stripe live
        let isConnectAccountConnected = agentInfo?.[0]?.isConnectAccountConnected || false;
        if (!isConnectAccountConnected && agentInfo?.[0]?.connectAccountId) {
            try {
                const accountStatus = await stripe.checkConnectAccountStatus(agentInfo[0].connectAccountId);
                if (accountStatus.chargesEnabled && accountStatus.payoutsEnabled && accountStatus.detailsSubmitted) {
                    await bussinessInformation.update(
                        { isConnectAccountConnected: true },
                        { where: { id: agentInfo[0].id } }
                    );
                    isConnectAccountConnected = true;
                    console.log('✅ [session] Connect account status synced: isConnectAccountConnected = true');
                }
            } catch (stripeErr) {
                console.error('⚠️ [session] Failed to sync Connect account status:', stripeErr.message);
            }
        }

        const ianaTimeZone = await this._agentDisplayTimeZone(
            data,
            userData.ianaTimeZone,
            () => this._shopDisplayTimeZone(userData.id)
        );
        const plainUser = this._withAgentTimeZone(
            this._toPlainUserForResponse(userData),
            ianaTimeZone
        );

        const connectAccountId = agentInfo?.[0]?.connectAccountId || null;

        return {
            userData: plainUser,
            accessToken,
            currencyUnit: await this._shopCurrencySymbol(userData.id),
            isGuest: data.guestUser,
            featureData,
            isConnectAccountConnected,
            connectAccountId,
            ...this._buildAgentApprovalConnectMeta({
                agentApprovalStatus: userData.agentApprovalStatus || 'approved',
                connectAccountId,
                isConnectAccountConnected,
                onboardingUrl: null,
            }),
        };
    }

    /**
     * Get User Profile
     * @param {Object} data - Profile data
     * @returns {Object} User profile data
     */
    async getUserProfile(data) {
        const userData = await users.findOne({
            where: {
                id: data.userId
            },
            include: [
                {
                    model: bussinessInformation,
                    as: 'agentInfo',
                    attributes: ['id', 'shopName', 'matchProfileOptions', 'isConnectAccountConnected', 'connectAccountId'],
                    required: false
                }
            ],
            attributes: ['id', 'firstName', 'lastName', 'image', 'email', 'phoneNum', 'userTypeId', 'stripeCustomerId', 'countryCode', 'ianaTimeZone']
        });

        if (!userData) {
            throw new NotFoundError('No User Exists with this email');
        }

        const plainUser = this._toPlainUserForResponse(userData);

        return {
            userData: plainUser,
            isConnectAccountConnected: userData.agentInfo?.[0]?.isConnectAccountConnected || false,
            connectAccountId: userData.agentInfo?.[0]?.connectAccountId || null,
        };
    }

    /**
     * Update User Profile
     * @param {Object} data - Update profile data
     * @param {string} profileImage - Profile image path
     * @returns {Object} Update result
     */
    async updateUserProfile(data, profileImage = null) {
        const userFind = await users.findOne({
            where: {
                id: data.userId
            },
            attributes: ['id', 'firstName', 'lastName', 'image', 'email', 'phoneNum', 'userTypeId']
        });

        if (!userFind) {
            throw new NotFoundError("user Not Exists with this ID");
        }

        if (data.isProfileImgChanged === "true") {
            if (!profileImage) {
                throw new ValidationError("Profile Image Required");
            }
        }

        await users.update({
            firstName: data.firstName,
            lastName: data.lastName,
            phoneNum: data.phoneNum,
            email: data.email,
            countryCode: data.countryCode,
            image: data.isProfileImgChanged === "true" ? profileImage : undefined,
            ...this._ianaTimeZoneUpdate(data),
        }, { where: { id: data.userId } });

        const ianaTimeZone = await this._getUserIanaTimeZone(data.userId);

        return {
            ianaTimeZone,
        };
    }

    /**
     * Agent Employee Login
     * Allows an agent employee (classifiedAsId = 1) to sign in with email, password and the
     * app install's deviceId (push token optional; LEGACY builds send only dvToken).
     * Returns a JWT, the employee's role permissions, and the agent shop info they belong to.
     * @param {Object} data - { email, password, deviceId, dvToken? }
     * @returns {Object} Login result with accessToken, permissions, and agent info
     */
    async employeeLogin(data) {
        const { email, password } = data;

        if (!email || !password) {
            throw new ValidationError('Email and password are required');
        }
        const identity = resolveSessionIdentity(data);

        const employeeData = await users.findOne({
            where: {
                email,
                classifiedAsId: 1,
                deletedAt: { [Op.is]: null }
            },
            attributes: ['id', 'firstName', 'lastName', 'email', 'password', 'classifiedAsId', 'roleId', 'employeeOff', 'image', 'phoneNum', 'countryCode', 'status']
        });

        if (!employeeData) {
            throw new NotFoundError('Employee not found. Please enter valid credentials.');
        }

        if (!employeeData.status) {
            throw new UnauthorizedError(ACCOUNT_BLOCKED_MESSAGE, { code: ACCOUNT_BLOCKED_CODE });
        }

        const passwordMatch = await bcrypt.compare(password, employeeData.password);
        if (!passwordMatch) {
            throw new UnauthorizedError('Invalid credentials. Please enter the correct password.');
        }

        // Get the agent this employee belongs to
        const agentData = await users.findOne({
            where: { id: employeeData.employeeOff },
            attributes: [
                'id',
                'firstName',
                'lastName',
                'email',
                'userTypeId',
                'agentApprovalStatus',
                'rejectionReason',
                'ianaTimeZone',
            ],
            include: [
                {
                    model: bussinessInformation,
                    as: 'agentInfo',
                    attributes: ['id', 'shopName', 'matchProfileOptions', 'connectAccountId'],
                    required: false
                }
            ]
        });

        this._assertAgentApprovalForLogin(agentData);

        const shopAddress = await addressDb.findOne({
            where: {
                userId: employeeData.employeeOff,
                addressType: 'LaundaryShopAddress',
            },
            attributes: ['id', 'zoneId'],
            include: [{ model: db.countries, attributes: ['ianaTimeZone'], required: false }],
        });

        // Staff work on the shop's clock: same timezone fields the owner app gets
        // (login `ianaTimeZone`, getAgentAddress `shopOperationalTimeZone`). Without
        // them the app fell back to UTC and bucketed Today/Tomorrow on UTC days.
        const shopOperationalTimeZone = shopAddress?.country?.ianaTimeZone || null;
        const shopTimeZone = agentData?.ianaTimeZone || shopOperationalTimeZone;

        // Get permissions for the employee's role — only Agent/Agent Employee/both features
        const permissionData = await permissions.findAll({
            where: { roleId: employeeData.roleId },
            attributes: ['featureId', 'create', 'read', 'update', 'delete'],
            include: [
                {
                    model: features,
                    where: {
                        status: true,
                        featureOf: { [Op.in]: ['Agent', 'Agent Employee', 'both'] }
                    },
                    attributes: ['id', 'title', 'key', 'featureOf'],
                    required: true
                }
            ]
        });

        // Get role details
        const roleData = await roles.findOne({
            where: { id: employeeData.roleId },
            attributes: ['id', 'name']
        });

        // Staff receive pushes too (job assignments, staffAssignmentNotify): the install's
        // push token, when it has one, is registered exactly like the owner login does.
        const accessToken = await openAppSession({
            userId: employeeData.id,
            claims: {
                id: employeeData.id,
                email: employeeData.email,
                employeeOff: employeeData.employeeOff,
                roleId: employeeData.roleId,
                classifiedAsId: employeeData.classifiedAsId,
            },
            identity,
        });

        const capabilities = await getEffectiveShopCapabilities(employeeData);

        return {
            id: employeeData.id,
            userId: String(employeeData.id),
            firstName: employeeData.firstName,
            lastName: employeeData.lastName,
            email: employeeData.email,
            image: employeeData.image,
            phoneNum: employeeData.phoneNum,
            countryCode: employeeData.countryCode,
            roleId: employeeData.roleId,
            role: roleData,
            classifiedAsId: employeeData.classifiedAsId,
            employeeOff: employeeData.employeeOff,
            addressId: shopAddress ? String(shopAddress.id) : null,
            // Staff see the owner's shop currency.
            currencyUnit: (await zoneCurrency(shopAddress?.zoneId)).currencySymbol,
            ianaTimeZone: shopTimeZone,
            shopOperationalTimeZone,
            isEmployee: true,
            isManager: Number(employeeData.roleId) === LAUNDRY_SHOP_MANAGER_ROLE_ID,
            isDriver: Number(employeeData.roleId) === LAUNDRY_SHOP_DRIVER_ROLE_ID,
            capabilities,
            agentInfo: agentData,
            permissions: permissionData,
            accessToken
        };
    }

    /**
     * Agent Employee Logout: revoke this install's session and stop its pushes.
     * @param {Object} sessionUser - req.user (the verified session claims)
     * @returns {Object} Empty result
     */
    async employeeLogout(sessionUser) {
        await endAppSession(sessionUser);
        return {};
    }

    /**
     * Delete agent account and all related data (soft delete).
     * Refuses while the shop still has incomplete bookings (same terminal
     * set as admin block/delete — Completed / Cancelled / Refunded / Issue Resolved).
     * @param {number} userId - Agent user ID
     * @returns {Object} Deletion result
     */
    async deleteAgentAccount(userId) {
        const agentUser = await users.findOne({
            where: { id: userId, userTypeId: 4 },
            include: [
                { model: bussinessInformation, as: 'businessInfo' }
            ],
        });

        if (!agentUser) {
            throw new NotFoundError('Agent account not found');
        }

        const shopAddress = await addressDb.findOne({
            where: { userId, addressType: SHOP_ADDRESS_TYPE },
            attributes: ['id'],
        });
        const shopAddressId =
            shopAddress?.id || agentUser.businessInfo?.shopAddressId || null;

        const openCount = await booking.count({
            where: openAgentOwnerBookingWhere(userId, shopAddressId, Op),
        });
        if (openCount > 0) {
            throw new UnprocessableEntityError(
                `You have ${openCount} active order(s). Complete or cancel them before deleting your account.`
            );
        }

        const transaction = await db.sequelize.transaction();

        try {
            const businessInfo = agentUser.businessInfo;

            // Delete business-related data
            if (businessInfo) {
                await bussinessWorkingHours.destroy({
                    where: { bussinessInformationId: businessInfo.id },
                    transaction
                });

                await machineCount.destroy({
                    where: { bussinessInformationId: businessInfo.id },
                    transaction
                });

                await driverInZones.destroy({
                    where: { laundaryShopId: businessInfo.id },
                    transaction
                });

                if (businessInfo.shopAddressId) {
                    await addressDb.destroy({
                        where: { id: businessInfo.shopAddressId },
                        transaction
                    });
                }

                await bussinessInformation.destroy({
                    where: { id: businessInfo.id },
                    transaction
                });
            }

            // Delete user-level related data
            await bussinessWorkingHours.destroy({
                where: { userId },
                transaction
            });

            await agentSelectServices.destroy({
                where: { agentServiceId: userId },
                transaction
            });

            await deviceToken.destroy({
                where: { userId },
                transaction
            });

            await otpVerification.destroy({
                where: { userId },
                transaction
            });

            await wallet.destroy({
                where: { userId },
                transaction
            });

            await addressDb.destroy({
                where: { userId },
                transaction
            });

            // Clear all Redis sessions for this user
            await redisCli.del(appSessionKey(userId));

            // Soft-delete the user
            await users.destroy({
                where: { id: userId },
                transaction
            });

            await transaction.commit();
            return { message: 'Account deleted successfully' };
        } catch (error) {
            await transaction.rollback();
            throw error;
        }
    }
}

module.exports = new AgentAuthService();