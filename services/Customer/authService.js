require("dotenv").config();
const { users, userType, booking, otpVerification, deviceToken, countries, cities, zone, units } = require('../../models');
const sequelize = require('sequelize');
const { Op } = require('sequelize');

const guestAuthService = require("./guestAuthService");

// Find which zone a lat/lng falls into
async function findZoneByCoords(lat, lng) {
    try {
        const zones = await zone.findAll({
            where: {
                status: true,
                coordinates: sequelize.where(
                    sequelize.fn(
                        'ST_Contains',
                        sequelize.col('coordinates'),
                        sequelize.fn('ST_GeomFromText', `POINT(${lng} ${lat})`)
                    ),
                    true
                )
            },
            include: [
                {
                    model: cities,
                    required: true,
                    attributes: ['id', 'name'],
                    where: { deletedAt: { [Op.is]: null } },
                    include: [
                        {
                            model: countries,
                            required: true,
                            attributes: ['id', 'name', 'shortName'],
                            where: { deletedAt: { [Op.is]: null } }
                        }
                    ]
                },
                {
                    model: units,
                    as: 'currencyUnitZ',
                    required: false,
                    attributes: ['id', 'name', 'symbol']
                }
            ],
            attributes: ['id', 'name', 'zoneMinimumAmount', 'serviceCharge', 'status', 'currencyUnitId']
        });
        return zones.length > 0 ? zones[0] : null;
    } catch (err) {
        console.error('⚠️ Zone lookup failed (non-blocking):', err.message);
        return null;
    }
}
const bcrypt = require('bcryptjs');
const {
    defaultPasswordReset,
    toId,
    toHttpError: passwordResetHttpError,
} = require('../shared/passwordReset');
const { CODE_PURPOSES } = require('../shared/otpCode');

/** Accounts the customer sign-up, code and password reset endpoints serve: customers (userTypes.id 2). */
const CUSTOMER_USER_TYPES = [2];

/** Statuses the customer app already handles for these refusals (ValidationError, 400). */
const CUSTOMER_RESET_STATUS = { incorrect: 400 };

/** Sign-up verification keeps the statuses and wording the customer app was built against. */
const CUSTOMER_SIGNUP_STATUS = { incorrect: 400 };
const CUSTOMER_SIGNUP_MESSAGES = { incorrect: 'Entered Incorrect OTP. Please enter correct OTP to continue' };
const otpMail = require('../../helper/otpMail');
const stripe = require('../../controllers/stripe');
const { enqueueEmail } = require('../email/emailOutbox');
const {
    ValidationError, 
    NotFoundError, 
    ConflictError, 
    UnauthorizedError,
    UnprocessableEntityError,
} = require('../../middlewares/universalErrorHandler');
const { resolveSessionIdentity, openAppSession } = require('../../utils/appSession');
const { customerLoginVerification } = require('../../utils/customerLoginVerification');
const {
    createUnverifiedAccount,
    refreshUnverifiedAccount,
} = require('../shared/signupAccountPersistence');
const {
    signupPersistenceDeps,
    newSignupOtp,
    sendSignupOtpEmail,
} = require('../shared/signupSupport');
const {
    ACCOUNT_BLOCKED_CODE,
    ACCOUNT_BLOCKED_MESSAGE,
} = require('../../utils/accountBlocked');

/**
 * Customer Authentication Service
 * Handles all customer authentication related business logic
 */
class CustomerAuthService {
    _socialSignInRequiredMessage(signedFrom) {
        const labels = {
            google: 'Google',
            facebook: 'Facebook',
            apple: 'Apple',
        };
        if (!signedFrom || !labels[signedFrom]) return null;
        const label = labels[signedFrom];
        return `This email is already registered with ${label}. Please sign in with ${label}.`;
    }

    /**
     * Register customer with OTP
     * @param {Object} data - Registration data
     * @param {string} data.firstName - First name
     * @param {string} data.lastName - Last name
     * @param {string} data.password - Password
     * @param {string} data.deviceId - App install id (UUID): the session's identity
     * @param {string} [data.dvToken] - Push (FCM) token, optional; LEGACY builds send only this
     * @param {string} data.phoneNum - Phone number
     * @param {string} data.confirmPassword - Confirm password
     * @param {number} data.countryId - Country ID
     * @param {number} data.cityId - City ID
     * @param {string} data.email - Email
     * @param {string} data.countryCode - Country code
     * @param {string} profileImg - Profile image path
     * @returns {Object} Registration result
     */
    async registerCustomerWithOTP(data, profileImg = null) {
        const {
            firstName,
            lastName,
            password,
            phoneNum,
            confirmPassword,
            countryId,
            cityId,
            email,
            countryCode
        } = data;

        const userfindByEmail = await users.findOne({
            where: {
                email,
                deletedAt: { [Op.is]: null }
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
                'id',
                'firstName',
                'lastName',
                'email',
                'phoneNum',
                'userTypeId',
                'verifiedAt',
                'signedFrom',
                'image',
                'stripeCustomerId',
                [
                    sequelize.fn('date_format', sequelize.col('users.createdAt'), '%Y'),
                    'joinedOn'
                ]
            ]
        });

        const userfindByPhone = await users.findOne({
            where: {
                phoneNum,
                deletedAt: { [Op.is]: null },
                userTypeId: 2
            },
            attributes: ['id', 'email', 'phoneNum', 'userTypeId', 'verifiedAt']
        });

        if (userfindByPhone && userfindByPhone.email !== email) {
            if (userfindByPhone.verifiedAt) {
                throw new ConflictError('User With This Phone Number Already Exists');
            }
            throw new ConflictError(
                'User With This Phone Number Already Exists (Not Verified). Please use the same email to update your account.'
            );
        }

        if (userfindByEmail && userfindByEmail.email === email) {
            if (userfindByEmail.userTypeId !== 2) {
                throw new ConflictError('User with this email already exists');
            }

            const socialSignInMessage = this._socialSignInRequiredMessage(
                userfindByEmail.signedFrom
            );
            if (socialSignInMessage) {
                throw new ConflictError(socialSignInMessage);
            }

            if (userfindByEmail.verifiedAt) {
                throw new ConflictError('User with this email already exists');
            }

            // This branch signs the app install in (utils/appSession.js); checked before any write.
            const identity = resolveSessionIdentity(data);

            console.log('🔄 Customer exists but not verified. Updating details and resending OTP...');

            // A new code counts against the account's code limit like a resend
            // (services/shared/passwordReset.js), so wrong-guess limits cannot be reset at will.
            try {
                await defaultPasswordReset().reserveIssue({ userId: userfindByEmail.id });
            } catch (err) {
                throw passwordResetHttpError(err, CUSTOMER_RESET_STATUS);
            }

            // Details and OTP are refreshed atomically. No Stripe call: the Stripe customer
            // is created on first payment (services/shared/stripeCustomerService.js).
            const otp = newSignupOtp();
            const { otpRow } = await refreshUnverifiedAccount(signupPersistenceDeps(), userfindByEmail, {
                profile: {
                    firstName,
                    lastName,
                    phoneNum,
                    countryCode,
                    email,
                    countryId,
                    cityId,
                    image: profileImg || userfindByEmail.image,
                },
                passwordHash: await bcrypt.hash(password, 8),
                otp,
            });
            await sendSignupOtpEmail({ email, otpCode: otp.code, userName: firstName });

            const accessToken = await openAppSession({
                userId: userfindByEmail.id,
                claims: { id: userfindByEmail.id, email: userfindByEmail.email, userTypeId: userfindByEmail.userTypeId },
                identity,
            });

            return {
                otpId: otpRow.id,
                userId: userfindByEmail.id,
                // Kept for API compatibility; null until the customer first pays.
                stripeCustomerId: userfindByEmail.stripeCustomerId || null,
                accessToken,
                message: 'User details updated. New OTP sent to your email.'
            };
        }

        // New customer: user, OTP and the install's push token in one transaction (no
        // partial account on failure). No Stripe call: created on first payment. No session
        // is opened here (that happens at OTP verification), so an id is not required yet.
        const identity = resolveSessionIdentity(data, { required: false });
        const otp = newSignupOtp();
        const { user, otpRow } = await createUnverifiedAccount(signupPersistenceDeps(), {
            userTypeId: 2,
            profile: {
                email,
                firstName,
                lastName,
                phoneNum,
                countryCode,
                image: profileImg,
                countryId,
                cityId,
            },
            passwordHash: await bcrypt.hash(password, 8),
            otp,
            pushToken: identity ? identity.pushToken : null,
            deviceId: identity ? identity.deviceId : null,
        });
        await sendSignupOtpEmail({ email, otpCode: otp.code, userName: firstName });

        return {
            otpId: otpRow.id,
            userId: user.id,
            // Kept for API compatibility; null until the customer first pays.
            stripeCustomerId: null
        };
    }

    /**
     * Verify OTP for SignUp
     * @param {Object} data - OTP verification data
     * @param {number} data.otpId - OTP ID: the code row the sign-up (or resend) returned
     * @param {string} data.OTP - OTP code
     * @param {number} [data.userId] - User ID: checked against the code's account, never used to pick it
     * @param {string} data.deviceId - App install id (UUID): the session's identity
     * @param {string} [data.dvToken] - Push (FCM) token, optional; LEGACY builds send only this
     * @returns {Object} Verification result with user data and access token
     */
    async verifyOTpSignUp(data) {
        const { otpId, OTP, userId } = data;
        const identity = resolveSessionIdentity(data);

        // The account is the code's owner; the code must be its live code, and is used up
        // (single use, limited wrong guesses: services/shared/passwordReset.js).
        let verified;
        try {
            verified = await defaultPasswordReset().verifySignupCode({
                otpId,
                userId,
                code: OTP,
                userTypeIds: CUSTOMER_USER_TYPES,
                // Special test OTP - bypass normal verification
                skipCodeCheck: OTP === '5678',
            });
        } catch (err) {
            throw passwordResetHttpError(err, CUSTOMER_SIGNUP_STATUS, CUSTOMER_SIGNUP_MESSAGES);
        }

        const userData = await users.findByPk(verified.userId, {
            include: {
                model: deviceToken,
                attributes: ['tokenId']
            }
        });
        if (!userData) {
            throw new NotFoundError("User not found");
        }

        await users.update({
            verifiedAt: new Date(),
        }, {
            where: {
                id: userData.id
            }
        });

        // Send welcome email after successful verification
        try {
            await enqueueEmail('signupWelcome', {
                email: userData.email,
                userName: userData.firstName || 'User'
            }, { dedupeKey: `signupWelcome:user:${userData.id}` });
        } catch (emailError) {
            console.error('⚠️ Failed to queue welcome email:', emailError.message);
            // Don't throw error - email failure shouldn't block signup completion
        }

        const accessToken = await openAppSession({
            userId: userData.id,
            claims: { id: userData.id, email: userData.email, userTypeId: userData.userTypeId },
            identity,
        });

        return {
            userData,
            accessToken,
            isGuest: false
        };
    }

    /**
     * Login User
     * @param {Object} data - Login data
     * @param {string} data.email - Email
     * @param {string} data.password - Password
     * @param {string} data.signedFrom - Social login provider
     * @param {string} data.deviceId - App install id (UUID): the session's identity
     * @param {string} [data.dvToken] - Push (FCM) token, optional; LEGACY builds send only this
     * @returns {Object} Login result with user data and access token or special response
     */
    async loginUser(data) {
        const wantGuest =
            data.guestUser === true ||
            data.guestUser === "true" ||
            data.isGuest === true ||
            data.isGuest === "true";
        if (wantGuest) {
            const guest = await guestAuthService.startGuestSession();
            const { lat, lng } = data;
            const zoneData =
                lat && lng ? await findZoneByCoords(lat, lng) : null;
            return {
                type: "success",
                userData: guest.userData,
                accessToken: guest.accessToken,
                isGuest: true,
                zoneId: zoneData ? zoneData.id : null,
                zoneName: zoneData ? zoneData.name : null,
                expiresInSeconds: guest.expiresInSeconds,
            };
        }

        const {
            email,
            password,
            signedFrom,
            firstName,
            lastName,
            phoneNum,
            lat,
            lng,
        } = data;
        const identity = resolveSessionIdentity(data);
        const socialProviders = ['google', 'facebook', 'apple'];
        const requiredProfileFields = ['firstName', 'lastName', 'phoneNum'];

        const normalizePayload = (payload) => {
            if (!payload) {
                return {};
            }
            if (typeof payload.get === 'function') {
                return payload.get({ plain: true });
            }
            if (payload.dataValues && typeof payload.dataValues === 'object') {
                return payload.dataValues;
            }
            return payload;
        };

        const collectMissingFields = (payload) => {
            const plainPayload = normalizePayload(payload);
            return requiredProfileFields.filter((field) => {
                const value = plainPayload[field];
                if (value === undefined || value === null) {
                    return true;
                }
                if (typeof value === 'string' && value.trim() === '') {
                    return true;
                }
                return false;
            });
        };
        // Find user
        const userFind = await users.findOne({
            where: {
                email: email,
                userTypeId: 2,
                deletedAt: { [Op.is]: null }
            },
            include: [
                {
                    model: deviceToken, 
                    attributes: ['tokenId']
                },
                {
                    model: countries,
                    required: false,
                    attributes: ['name']
                },
                {
                    model: cities,
                    attributes: ['name']
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
                "stripeCustomerId",
                "signedFrom",
                [
                    sequelize.fn("date_format", sequelize.col("users.createdAt"), "%Y"),
                    "joinedOn",
                ],
            ]
        });


        // Handle case where user doesn't exist and no social login
        // Check for any falsy value or 'null' string
        if (!userFind && !socialProviders.includes(signedFrom)) {
            console.log("🚀 ~ Throwing NotFoundError for user not found");
            console.log("signedFrom value:", signedFrom);
            throw new NotFoundError('User not found with this email. Please check your email or sign up.');
        }

        // Handle social login - user doesn't exist
        if (!userFind && socialProviders.includes(signedFrom)) {
            console.log("Going into this condition ----------------->>>");

            const missingFields = collectMissingFields({ firstName, lastName, phoneNum });
            if (missingFields.length && signedFrom !== 'apple') {
                throw new ValidationError('Information Missing', {
                    missingFields,
                    requiredFields: missingFields,
                    email,
                    signedFrom
                });
            }

            // No Stripe call here: the Stripe customer is created on first payment
            // (services/shared/stripeCustomerService.js). Previously this passed the
            // email as the customer's name and no email.
            const createUser = await users.create({
                email,
                userTypeId: 2,
                verifiedAt: Date.now(),
                status: true,
                signedFrom: signedFrom,
                firstName: typeof firstName === 'string' ? firstName.trim() : firstName,
                lastName: typeof lastName === 'string' ? lastName.trim() : lastName,
                phoneNum: typeof phoneNum === 'string' ? phoneNum.trim() : phoneNum
            });

            // Send welcome email for social signup
            try {
                await enqueueEmail('signupWelcome', {
                    email: email,
                    userName: firstName || 'User'
                }, { dedupeKey: `signupWelcome:user:${createUser.id}` });
            } catch (emailError) {
                console.error('⚠️ Failed to queue welcome email:', emailError.message);
                // Don't throw error - email failure shouldn't block signup completion
            }

            // Fetch created user with all attributes including joinedOn
            const userData = await users.findOne({
                where: {
                    id: createUser.id,
                    userTypeId: 2
                },
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
                    "stripeCustomerId",
                    "signedFrom",
                    [
                        sequelize.fn("date_format", sequelize.col("users.createdAt"), "%Y"),
                        "joinedOn",
                    ],
                ]
            });

            const accessToken = await openAppSession({
                userId: userData.id,
                claims: { id: userData.id, email: userData.email, userTypeId: userData.userTypeId },
                identity,
            });

            // Zone lookup (optional — skipped if lat/lng not provided)
            const zoneData = (lat && lng) ? await findZoneByCoords(lat, lng) : null;

            // Return success data with full user details
            return {
                type: 'success',
                userData: userData,
                accessToken: accessToken,
                isGuest: false,
                zoneId: zoneData ? zoneData.id : null,
                zoneName: zoneData ? zoneData.name : null
            };
        }

        // Handle existing user with different social login method
        if (userFind && ["google", "apple", "facebook"].includes(userFind.signedFrom) && !signedFrom) {
            const socialSignInMessage = this._socialSignInRequiredMessage(userFind.signedFrom);
            throw new ValidationError(
                socialSignInMessage ||
                    `You have previously signed up using ${userFind.signedFrom}. Please log in using ${userFind.signedFrom}.`
            );
        }

        // Handle social login for existing user
        if (socialProviders.includes(signedFrom)) {
            const socialUserFind = await users.findOne({
                where: {
                    email: email,
                    userTypeId: 2,
                    signedFrom
                },
                include: { model: deviceToken, attributes: ['tokenId'] },
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
                    "stripeCustomerId",
                    [
                        sequelize.fn("date_format", sequelize.col("users.createdAt"), "%Y"),
                        "joinedOn",
                    ],
                ]
            });


            if (!socialUserFind) {
                // The email exists but was registered with email/password — give a helpful message
                if (userFind && !userFind.signedFrom) {
                    throw new ValidationError(
                        `This email is registered with email and password. Please log in using your email and password instead of ${signedFrom}.`
                    );
                }
                throw new NotFoundError("User not found. Please ensure the correct email and sign-in method.");
            }

            if (!socialUserFind.status) {
                throw new UnauthorizedError(ACCOUNT_BLOCKED_MESSAGE, { code: ACCOUNT_BLOCKED_CODE });
            }

            const profileMissingFields = collectMissingFields(socialUserFind);
            if (profileMissingFields.length && signedFrom !== 'apple') {
                throw new ValidationError('Information Missing', {
                    missingFields: profileMissingFields,
                    requiredFields: profileMissingFields,
                    userId: socialUserFind.id,
                    email: socialUserFind.email,
                    signedFrom
                });
            }

            const accessToken = await openAppSession({
                userId: socialUserFind.id,
                claims: { id: socialUserFind.id, email: socialUserFind.email, userTypeId: socialUserFind.userTypeId },
                identity,
            });

            // Zone lookup (optional — skipped if lat/lng not provided)
            const zoneData = (lat && lng) ? await findZoneByCoords(lat, lng) : null;

            return {
                type: 'success',
                userData: socialUserFind,
                accessToken,
                isGuest: false,
                zoneId: zoneData ? zoneData.id : null,
                zoneName: zoneData ? zoneData.name : null
            };
        }

        // Regular email/password login


        // Check if user exists before accessing properties
        if (!userFind) {
            throw new NotFoundError('User not found with this email. Please check your email or sign up.');
        }

        if (!userFind.status) {
            throw new UnauthorizedError(ACCOUNT_BLOCKED_MESSAGE, { code: ACCOUNT_BLOCKED_CODE });
        } else {
            // users.verifiedAt is the source of truth; the OTP row only matters for an
            // unverified account (its id routes the app to OTP verification).
            const otpData = await otpVerification.findOne({
                where: { userId: userFind.id },
                attributes: ["id"],
                order: [["id", "ASC"]],
            });
            const verification = customerLoginVerification(userFind, otpData);
            if (!verification.verified) {
                if (!verification.otpId) {
                    throw new UnauthorizedError("User Not Verified", "user not verified by otp");
                }
                throw new UnauthorizedError("Please verify your email to continue", {
                    userId: userFind.id,
                    otpId: verification.otpId,
                    email: userFind.email
                });
            }
        }

        // Check user data completeness
        if (userFind.userTypeId === 2) {
            if (userFind.firstName === null || !userFind.phoneNum) {
                throw new UnauthorizedError("Your first Name or Phone Number is Missing", { 
                    userId: userFind.id 
                });
            }

            if (userFind.firstName === null) {
                throw new UnauthorizedError("Your first Name is Missing", { 
                    userId: userFind.id 
                });
            }
        }

        // Verify password
        const passwordMatch = await bcrypt.compare(password, userFind.password);
        if (!passwordMatch) {
            throw new UnauthorizedError(
                "Bad credentials Please enter correct password to continue"
            );
        }

        const accessToken = await openAppSession({
            userId: userFind.id,
            claims: { id: userFind.id, email: userFind.email, userTypeId: userFind.userTypeId },
            identity,
        });

        // Zone lookup (optional — skipped if lat/lng not provided)
        const zoneData = (lat && lng) ? await findZoneByCoords(lat, lng) : null;

        return {
            type: 'success',
            userData: userFind,
            accessToken,
            isGuest: false,
            zoneId: zoneData ? zoneData.id : null,
            zoneName: zoneData ? zoneData.name : null
        };
    }

    /**
     * Forget Password Request
     * @param {Object} data - Forget password data
     * @param {string} data.email - Email
     * @returns {Object} Forget password result with OTP info
     */
    async forgetPasswordRequest(data) {
        const { email } = data;

        // Find user
        const userData = await users.findOne({
            where: {
                email,
                deletedAt: { [Op.is]: null },
                userTypeId: { [Op.or]: [2] },
            },
            attributes: ["id", "signedFrom", "firstName"],
        });

        // User not found
        if (!userData) {
            throw new NotFoundError("No user exists against this email");
        }

        // Check if user signed in via social login (Google, Facebook, Apple)
        const socialProviders = ['google', 'facebook', 'apple'];
        if (userData.signedFrom && socialProviders.includes(userData.signedFrom.toLowerCase())) {
            const providerName = userData.signedFrom.charAt(0).toUpperCase() + userData.signedFrom.slice(1);
            throw new ValidationError(
                `This account is linked to ${providerName} login`,
                `You cannot reset password for social login accounts. Please sign in using ${providerName} instead.`
            );
        }

        // A new code ends any earlier code and verified reset (services/shared/passwordReset.js).
        let issued;
        try {
            issued = await defaultPasswordReset().issueCode({
                userId: userData.id,
                purpose: CODE_PURPOSES.PASSWORD_RESET,
            });
        } catch (err) {
            throw passwordResetHttpError(err, CUSTOMER_RESET_STATUS);
        }

        // Send forgot password email with OTP
        try {
            const forgotPasswordMail = require('../../helper/forgotPasswordMail');
            await forgotPasswordMail({
                email,
                userName: userData.firstName || 'User',
                otp: issued.code
            });
            console.log('✅ Forgot password email sent to:', email);
        } catch (emailError) {
            console.error('⚠️ Failed to send forgot password email (non-blocking):', emailError.message);
        }

        return {
            otpId: issued.otpId,
            userId: userData.id,
            message: issued.created
                ? "OTP sent Successfully for Password Reset"
                : "OTP Updated Successfully"
        };
    }

    /**
     * Verify OTP for changing password
     * @param {Object} data - OTP verification data
     * @param {number} data.otpId - OTP ID
     * @param {string} data.OTP - OTP code
     * @returns {Object} Verification result
     */
    async verifyOTPforPassword(data) {
        const { otpId, OTP, userId } = data;

        // The code must be the account's live, unexpired code; it is used up here
        // (single use, limited wrong guesses) and opens the reset (services/shared/passwordReset.js).
        // A userId sent with it must name the code's account.
        let verified;
        try {
            verified = await defaultPasswordReset().verifyResetCode({
                otpId,
                userId,
                code: OTP,
                userTypeIds: CUSTOMER_USER_TYPES,
                // Special test OTP - bypass normal verification
                skipCodeCheck: OTP === '5678',
            });
        } catch (err) {
            throw passwordResetHttpError(err, CUSTOMER_RESET_STATUS);
        }

        return {
            otpId,
            userId: verified.userId,
            message: "OTP verified"
        };
    }

    /**
     * Change password in response to OTP
     * @param {Object} data - Change password data
     * @param {number} data.userId - User ID
     * @param {number} data.otpId - OTP ID
     * @param {string} data.password - New password
     * @returns {Object} Change password result
     */
    async changePasswordOTP(data) {
        const { userId, otpId, password } = data;

        // The password changed is the verified code's owner's; a userId the app sends must name
        // that owner. Every session of the account ends (services/shared/passwordReset.js).
        try {
            await defaultPasswordReset().resetPassword({
                otpId,
                userId,
                password,
                userTypeIds: CUSTOMER_USER_TYPES,
            });
        } catch (err) {
            throw passwordResetHttpError(err, CUSTOMER_RESET_STATUS);
        }

        return {
            message: "Password updated successfully. Please login to continue"
        };
    }

    /**
     * Resend OTP
     * @param {Object} data - Resend OTP data
     * @param {number} data.userId - User ID
     * @returns {Object} Resend OTP result
     */
    async resendOTP(data) {
        const { userId } = data;

        // Only customer accounts: the other apps resend through their own endpoints.
        const accountId = toId(userId);
        const userExist = accountId && await users.findOne({
            where: {
                id: accountId,
                userTypeId: { [Op.in]: CUSTOMER_USER_TYPES },
                deletedAt: { [Op.is]: null },
            },
            attributes: ['id', 'email', 'firstName'],
        });

        if (!userExist) {
            throw new NotFoundError("Sorry, we could not fetch the associated data", "Please try sending again");
        }

        // A new code for the account (services/shared/passwordReset.js): the app's forgot-password
        // screen resends through here too, so it goes through the same lifecycle and limits, and
        // the new code keeps the purpose of the one it replaces (sign-up or password reset).
        let issued;
        try {
            issued = await defaultPasswordReset().issueResendCode({ userId: userExist.id });
        } catch (err) {
            throw passwordResetHttpError(err, CUSTOMER_RESET_STATUS);
        }

        try {
            await otpMail({
                type: 'RegisterOTP',
                email: userExist.email,
                OTP: issued.code,
                userName: userExist.firstName
            });
        } catch (mailError) {
            console.error('⚠️ OTP email failed (non-blocking):', mailError.message || mailError);
        }

        return {
            otpId: issued.otpId,
            message: "OTP sent successfully"
        };
    }

    /**
     * Session - Get user session data
     * @param {Object} data - Session data
     * @param {number} data.userId - User ID from authenticated user
     * @param {boolean} data.guestUser - Guest user flag
     * @returns {Object} Session result with user data
     */
    async session(data) {
        const { userId, guestUser } = data;

        if (guestUser) {
            throw new UnauthorizedError("Login failed");
        }

        const userData = await users.findByPk(userId, {
            attributes: [
                "id",
                "firstName",
                "lastName",
                "email",
                "status",
                "countryCode",
                "phoneNum",
            ],
        });

        if (!userData) {
            throw new NotFoundError(
                "Sorry no user found!",
                "Please contact support for more information"
            );
        }

        if (!userData?.status) {
            throw new UnauthorizedError(
                ACCOUNT_BLOCKED_MESSAGE,
                { code: ACCOUNT_BLOCKED_CODE }
            );
        }

        return {
            userData,
            accessToken: "", // Empty for session
            isGuest: guestUser
        };
    }

    /**
     * Get User Profile
     * @param {Object} data - Profile data
     * @param {number} data.userId - User ID from authenticated user
     * @returns {Object} User profile data
     */
    async getUserProfile(data) {
        const { userId } = data;

        const [userData, totalOrders] = await Promise.all([
            users.findOne({
                where: { id: userId },
                attributes: [
                    'id', 'firstName', 'lastName', 'image', 'email',
                    'phoneNum', 'userTypeId', 'stripeCustomerId', 'countryCode',
                    'status', 'createdAt'
                ]
            }),
            booking.count({ where: { customerId: userId } })
        ]);

        if (!userData) {
            throw new NotFoundError('No User Exists with this email');
        }

        return {
            userData: {
                ...userData.toJSON(),
                totalOrders,
                registeredAt: userData.createdAt,
                isActive: userData.status
            },
            message: "User Profile fetched"
        };
    }

    /**
     * Update User Profile
     * @param {Object} data - Update profile data
     * @param {number} data.userId - User ID from authenticated user
     * @param {string} data.firstName - First name
     * @param {string} data.lastName - Last name
     * @param {string} data.email - Email
     * @param {string} data.isProfileImgChanged - Profile image change flag
     * @param {string} data.phoneNum - Phone number
     * @param {string} data.countryCode - Country code
     * @param {string} profileImage - Profile image path
     * @returns {Object} Update result
     */
    async updateUserProfile(data, profileImage = null) {
        const { userId, firstName, lastName, email, isProfileImgChanged, phoneNum, countryCode } = data;

        const userFind = await users.findOne({
            where: {
                id: userId
            },
            attributes: ['id', 'firstName', 'lastName', 'image', 'email', 'phoneNum', 'userTypeId']
        });

        if (!userFind) {
            throw new NotFoundError("user Not Exists with this ID");
        }

        // Handle profile image
        if (isProfileImgChanged === "true") {
            if (!profileImage) {
                throw new ValidationError("Profile Image Required");
            }
        }

        await users.update({
            firstName,
            lastName,
            phoneNum,
            email,
            countryCode,
            image: isProfileImgChanged === "true" ? profileImage : undefined,
        }, { where: { id: userId } });

        return {
            message: "User Profile Updated Successfully"
        };
    }

    /**
     * Delete customer account (self-service)
     * @param {Object} params
     * @param {number} params.userId
     * @param {string} params.email - Must match account email
     * @param {string} [params.reason]
     * @param {string} [params.otherText]
     */
    async deleteCustomerAccount({ userId, email, reason, otherText }) {
        const normalizedEmail = (email || '').trim().toLowerCase();

        const customer = await users.findOne({
            where: {
                id: userId,
                userTypeId: 2,
                deletedAt: { [Op.is]: null },
            },
        });

        if (!customer) {
            throw new NotFoundError('Customer account not found');
        }

        if ((customer.email || '').trim().toLowerCase() !== normalizedEmail) {
            throw new ValidationError('Email does not match your account');
        }

        const activeBookings = await booking.count({
            where: {
                customerId: userId,
                bookingStatusId: {
                    [Op.notIn]: [17, 19, 23],
                },
            },
        });

        if (activeBookings > 0) {
            throw new UnprocessableEntityError(
                `You have ${activeBookings} active booking(s). Please complete or cancel them before deleting your account.`
            );
        }

        await deviceToken.destroy({ where: { userId } });
        await otpVerification.destroy({ where: { userId } });

        await users.destroy({ where: { id: userId, userTypeId: 2 } });

        return {
            message: 'Account deleted successfully',
            reason: reason || null,
            otherText: otherText || null,
        };
    }
}

module.exports = new CustomerAuthService();


//check if customer has responded to on hold confirmation