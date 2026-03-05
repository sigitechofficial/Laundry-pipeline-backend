require("dotenv").config();
const { users, userType, booking, otpVerification, deviceToken, countries, cities } = require('../../models');
const sequelize = require('sequelize');
const { Op } = require('sequelize');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const redisCli = require('../../redis/redis');
const otpGenerator = require('otp-generator');
const otpMail = require('../../helper/otpMail');
const stripe = require('../../controllers/stripe');
const signupWelcomeMail = require('../../helper/signupWelcomeMail');
const { 
    ValidationError, 
    NotFoundError, 
    ConflictError, 
    UnauthorizedError 
} = require('../../middlewares/universalErrorHandler');

/**
 * Customer Authentication Service
 * Handles all customer authentication related business logic
 */
class CustomerAuthService {
    
    /**
     * Register customer with OTP
     * @param {Object} data - Registration data
     * @param {string} data.firstName - First name
     * @param {string} data.lastName - Last name
     * @param {string} data.password - Password
     * @param {string} data.dvToken - Device token
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
            dvToken, 
            phoneNum, 
            confirmPassword, 
            countryId, 
            cityId, 
            email, 
            countryCode 
        } = data;

        console.log("🚀 ~ registerCustomerWithOTP ~ data:", data);

        // Check if user already exists
        const userfind = await users.findOne({
            where: {
                email: email,
                deletedAt: {
                    [Op.is]: null
                }
            },
            include: [{
                model: otpVerification,
                required: false,
                attributes: ['OTP']
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

        console.log("🚀 ~ registerCustomerWithOTP ~ userfind:", userfind);

        if (userfind) {
            throw new ConflictError("User with this email already exists");
        }

        // Create new user
        let userTypeId = 2; // Customer type
        const hashedPassword = await bcrypt.hash(password, 8);
        
        const userCreate = await users.create({
            email,
            firstName,
            lastName,
            phoneNum,
            userTypeId,
            password: hashedPassword,
            status: true,
            countryCode
        });

        // Create Stripe customer
        const stripeCustomer = await stripe.createStripeCustomer(firstName, email);
        console.log("🚀 ~ registerCustomerWithOTP ~ stripeCustomer:", stripeCustomer);

        // Generate and send OTP
        const otp = otpGenerator.generate(4, {
            lowerCaseAlphabets: false,
            upperCaseAlphabets: false,
            specialChars: false
        });

        await otpMail({
            type: 'RegisterOTP',
            email: email,
            OTP: otp,
            userName: firstName
        });

        let dt = new Date();
        // Set OTP expiration to 1 minute from now
        let expirationTime = new Date(dt.getTime() + 1 * 60 * 1000); // 1 minute

        // Create OTP verification record
        const otpCreation = await otpVerification.create({
            OTP: otp,
            reqAt: dt,
            expirtAt: expirationTime,
            userId: userCreate.id
        });

        // Create device token
        await deviceToken.create({
            tokenId: dvToken,
            status: true,
            userId: userCreate.id
        });

        // Update user with additional info
        await users.update({
            stripeCustomerId: stripeCustomer,
            image: profileImg,
            countryId,
            cityId
        }, {
            where: { id: userCreate.id }
        });

        return {
            otpId: otpCreation.id,
            userId: userCreate.id,
            stripeCustomerId: stripeCustomer
        };
    }

    /**
     * Verify OTP for SignUp
     * @param {Object} data - OTP verification data
     * @param {number} data.otpId - OTP ID
     * @param {string} data.OTP - OTP code
     * @param {number} data.userId - User ID
     * @param {string} data.dvToken - Device token
     * @returns {Object} Verification result with user data and access token
     */
    async verifyOTpSignUp(data) {
        const { otpId, OTP, userId, dvToken } = data;

        // Get user data
        const userData = await users.findByPk(userId, {
            include: {
                model: deviceToken,
                attributes: ['tokenId']
            }
        });

        console.log("🚀 ~ verifyOTpSignUp ~ userData:", userData);

        if (!userData) {
            throw new NotFoundError("User not found");
        }

        // Check if device token exists, create if not
        if (!userData.deviceToken) {
            await deviceToken.create({
                tokenId: dvToken,
                status: true,
                userId: userData.id
            });
        }

        // Handle device token - generate one if not provided
        let finalDvToken = dvToken;
        if (!finalDvToken || finalDvToken.trim() === '') {
            // Generate a default device token if none provided
            finalDvToken = `web-${Date.now()}-${Math.random().toString(36).substring(7)}`;
            console.log("⚠️ No dvToken provided during OTP verification, generated:", finalDvToken);
        }

        // Handle special test OTP
        if (OTP === '5678') {
            // Update user verification status
            await users.update({
                verifiedAt: new Date(),
            }, {
                where: {
                    id: userId
                }
            });

            // Send welcome email after successful verification
            try {
                await signupWelcomeMail({
                    email: userData.email,
                    userName: userData.firstName || 'User'
                });
                console.log('✅ Welcome email sent to:', userData.email);
            } catch (emailError) {
                console.error('⚠️ Failed to send welcome email (non-blocking):', emailError.message);
                // Don't throw error - email failure shouldn't block signup completion
            }

            // Generate access token
            const accessToken = jwt.sign({
                id: userData.id,
                email: userData.email,
                dvToken: finalDvToken,
                userTypeId: userData.userTypeId
            }, process.env.JWT_ACCESS_SECRET);

            // Store token in Redis
            await redisCli.hSet(
                `id-${userData.id}`,
                { [finalDvToken]: accessToken }
            );

            return {
                userData,
                accessToken,
                isGuest: false
            };
        } else {
            // Verify regular OTP
            const otpData = await otpVerification.findByPk(otpId);
            
            if (!otpData) {
                throw new NotFoundError(
                    "Sorry, we could not fetch the data",
                    "Please resend OTP to continue"
                );
            }

            // Check if OTP has expired
            const now = new Date();
            if (otpData.expirtAt && new Date(otpData.expirtAt) < now) {
                throw new ValidationError("OTP has expired. Please request a new OTP to continue");
            }

            if (otpData.OTP != OTP) {
                throw new ValidationError("Entered Incorrect OTP. Please enter correct OTP to continue");
            }

            // Update user verification status
            await users.update({
                verifiedAt: new Date(),
            }, {
                where: {
                    id: userId
                }
            });

            // Send welcome email after successful verification
            try {
                await signupWelcomeMail({
                    email: userData.email,
                    userName: userData.firstName || 'User'
                });
                console.log('✅ Welcome email sent to:', userData.email);
            } catch (emailError) {
                console.error('⚠️ Failed to send welcome email (non-blocking):', emailError.message);
                // Don't throw error - email failure shouldn't block signup completion
            }

            // Generate access token
            const accessToken = jwt.sign({
                id: userData.id,
                email: userData.email,
                dvToken: finalDvToken,
                userTypeId: userData.userTypeId
            }, process.env.JWT_ACCESS_SECRET);

            // Store token in Redis
            await redisCli.hSet(
                `id-${userData.id}`,
                { [finalDvToken]: accessToken }
            );

            return {
                userData,
                accessToken,
                isGuest: false
            };
        }
    }

    /**
     * Login User
     * @param {Object} data - Login data
     * @param {string} data.email - Email
     * @param {string} data.password - Password
     * @param {string} data.signedFrom - Social login provider
     * @param {string} data.dvToken - Device token
     * @returns {Object} Login result with user data and access token or special response
     */
    async loginUser(data) {
        const { email, password, signedFrom, dvToken, firstName, lastName, phoneNum } = data;
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
            if (missingFields.length) {
                throw new ValidationError('Information Missing', {
                    missingFields,
                    requiredFields: missingFields,
                    email,
                    signedFrom
                });
            }

            const createStripeCustomer = await stripe.createStripeCustomer(email);

            const createUser = await users.create({
                email,
                userTypeId: 2,
                verifiedAt: Date.now(),
                status: true,
                stripeCustomerId: createStripeCustomer,
                signedFrom: signedFrom,
                firstName: typeof firstName === 'string' ? firstName.trim() : firstName,
                lastName: typeof lastName === 'string' ? lastName.trim() : lastName,
                phoneNum: typeof phoneNum === 'string' ? phoneNum.trim() : phoneNum
            });

            // Send welcome email for social signup
            try {
                await signupWelcomeMail({
                    email: email,
                    userName: firstName || 'User'
                });
                console.log('✅ Welcome email sent to:', email);
            } catch (emailError) {
                console.error('⚠️ Failed to send welcome email (non-blocking):', emailError.message);
                // Don't throw error - email failure shouldn't block signup completion
            }

            // Handle device token - generate one if not provided
            let finalDvToken = dvToken;
            if (!finalDvToken || finalDvToken.trim() === '') {
                // Generate a default device token if none provided
                finalDvToken = `web-${Date.now()}-${Math.random().toString(36).substring(7)}`;
                console.log("⚠️ No dvToken provided, generated:", finalDvToken);
            }

            await deviceToken.create({
                tokenId: finalDvToken,
                status: true,
                userId: createUser.id
            });

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

            // Generate access token
            const accessToken = jwt.sign({
                id: userData.id,
                email: userData.email,
                dvToken: finalDvToken,
                userTypeId: userData.userTypeId
            }, process.env.JWT_ACCESS_SECRET);

            // Store token in Redis
            await redisCli.hSet(
                `id-${userData.id}`,
                { [finalDvToken]: accessToken }
            );

            // Return success data with full user details
            return {
                type: 'success',
                userData: userData,
                accessToken: accessToken,
                isGuest: false
            };
        }

        // Handle existing user with different social login method
        if (userFind && ["google", "apple", "facebook"].includes(userFind.signedFrom) && !signedFrom) {
            throw new ValidationError(`You have previously signed up using ${userFind.signedFrom}. Please log in using ${userFind.signedFrom}.`);
        }

        // Handle social login for existing user
        if (socialProviders.includes(signedFrom)) {
            const userFind = await users.findOne({
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

            console.log("userFind------------>", userFind);

            if (!userFind) {
                throw new NotFoundError("User not found. Please ensure the correct email and sign-in method.");
            }

            if (!userFind.status) {
                throw new UnauthorizedError('Blocked By admin Please contact admin to continue');
            }

            const profileMissingFields = collectMissingFields(userFind);
            if (profileMissingFields.length) {
                throw new ValidationError('Information Missing', {
                    missingFields: profileMissingFields,
                    requiredFields: profileMissingFields,
                    userId: userFind.id,
                    email: userFind.email,
                    signedFrom
                });
            }

            // Handle device token - generate one if not provided
            let finalDvToken = dvToken;
            if (!finalDvToken || finalDvToken.trim() === '') {
                // Generate a default device token if none provided
                finalDvToken = `web-${Date.now()}-${Math.random().toString(36).substring(7)}`;
                console.log("⚠️ No dvToken provided, generated:", finalDvToken);
            }

            const dvTokenFound = userFind.deviceToken?.find((ele) => ele.tokenId === finalDvToken);
            if (!dvTokenFound) {
                await deviceToken.create({
                    tokenId: finalDvToken,
                    status: true,
                    userId: userFind.id
                });
            }

            // Generate access token
            const accessToken = jwt.sign({
                id: userFind.id,
                email: userFind.email,
                dvToken: finalDvToken,
                userTypeId: userFind.userTypeId
            }, process.env.JWT_ACCESS_SECRET);

            // Store in Redis
            await redisCli.hSet(
                `id-${userFind.id}`,
                { [finalDvToken]: accessToken }
            );

            return {
                type: 'success',
                userData: userFind,
                accessToken,
                isGuest: false
            };
        }

        // Regular email/password login
        let otpId = 0;

        console.log("User Find------------>", userFind);

        // Check if user exists before accessing properties
        if (!userFind) {
            throw new NotFoundError('User not found with this email. Please check your email or sign up.');
        }

        if (!userFind.status) {
            throw new UnauthorizedError("Blocked by admin Please contact admin to continue");
        } else {
            const otpData = await otpVerification.findOne(
                { where: { userId: userFind.id } },
                { attributes: ["id", "OTP", "verifiedAtForgetCase", "userId"] }
            );
            if (!otpData) {
                throw new UnauthorizedError("User Not Verified", "user not verified by otp");
            }
            otpId = otpData.id;
        }

        // Check email verification
        if (!userFind.verifiedAt) {
            throw new UnauthorizedError("Please verify your email to continue", { 
                userId: userFind.id, 
                otpId, 
                email: userFind.email 
            });
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

        // Handle device token - generate one if not provided
        let finalDvToken = dvToken;
        if (!finalDvToken || finalDvToken.trim() === '') {
            // Generate a default device token if none provided
            finalDvToken = `web-${Date.now()}-${Math.random().toString(36).substring(7)}`;
            console.log("⚠️ No dvToken provided, generated:", finalDvToken);
        }

        const dvTokenFound = userFind.deviceTokens?.find((ele) => ele.tokenId === finalDvToken);
        console.log("🚀 ~ loginUser ~ dvTokenFound:", dvTokenFound);
        if (!dvTokenFound) {
            await deviceToken.create({
                tokenId: finalDvToken,
                status: true,
                userId: userFind.id
            });
        }

        // Generate access token
        const accessToken = jwt.sign({
            id: userFind.id,
            email: userFind.email,
            dvToken: finalDvToken,
            userTypeId: userFind.userTypeId
        }, process.env.JWT_ACCESS_SECRET);

        // Store in Redis
        await redisCli.hSet(
            `id-${userFind.id}`,
            { [finalDvToken]: accessToken }
        );

        return {
            type: 'success',
            userData: userFind,
            accessToken,
            isGuest: false
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
            include: { model: otpVerification, attributes: ["id"] },
            attributes: ["id", "signedFrom"],
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

        // Generate OTP
        let OTP = otpGenerator.generate(4, {
            lowerCaseAlphabets: false,
            upperCaseAlphabets: false,
            specialChars: true,
        });

        // Send OTP email
        // otpMail({
        //     type: 'ForgetPassword',
        //     email: email,
        //     OTP: OTP
        // });

        let dt = new Date();
        // Set OTP expiration to 1 minute from now
        let expirationTime = new Date(dt.getTime() + 1 * 60 * 1000); // 1 minute

        // Update existing OTP or create new one
        if (userData.otpVerification != null) {
            try {
                await otpVerification.update(
                    {
                        OTP: OTP,
                        reqAt: dt,
                        expirtAt: expirationTime,
                    }, 
                    { where: { userId: userData.id } }
                );

                return {
                    otpId: userData.otpVerification.id,
                    userId: userData.id,
                    message: "OTP Updated Successfully"
                };

            } catch (error) {
                console.log("Error in updating OTP", error);
                throw new UniversalHttpError(`Failed to update OTP: ${error.message}`);
            }
        } else {
            try {
                const otpSend = await otpVerification.create({
                    OTP: OTP,
                    reqAt: dt,
                    expirtAt: expirationTime,
                    userId: userData.id
                });

                return {
                    otpId: otpSend.id,
                    userId: userData.id,
                    message: "OTP sent Successfully for Password Reset"
                };

            } catch (error) {
                console.log("Error in creating OTP", error);
                throw new UniversalHttpError(`Failed to create OTP: ${error.message}`);
            }
        }
    }

    /**
     * Verify OTP for changing password
     * @param {Object} data - OTP verification data
     * @param {number} data.otpId - OTP ID
     * @param {string} data.OTP - OTP code
     * @returns {Object} Verification result
     */
    async verifyOTPforPassword(data) {
        const { otpId, OTP } = data;

        const otpData = await otpVerification.findByPk(otpId, {
            attributes: ["id", "OTP", "verifiedAtForgetCase", "userId", "expirtAt"],
        });

        if (!otpData) {
            throw new NotFoundError("Sorry, we could not fetch the data", "Please resend OTP to continue");
        }

        // Special test OTP - bypass normal verification
        if (OTP === '5678') {
            otpData.verifiedAtForgetCase = true;
            await otpData.save();

            return {
                otpId,
                userId: otpData.userId,
                message: "OTP verified"
            };
        }

        // Check if OTP has expired
        const now = new Date();
        if (otpData.expirtAt && new Date(otpData.expirtAt) < now) {
            throw new ValidationError("OTP has expired. Please request a new OTP to continue");
        }

        // Normal OTP verification
        if (OTP != otpData.OTP) {
            throw new ValidationError("You entered incorrect OTP Please enter correct OTP to continue");
        }

        otpData.verifiedAtForgetCase = true;
        await otpData.save();

        return {
            otpId,
            userId: otpData.userId,
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

        const otpData = await otpVerification.findByPk(otpId, {
            attributes: ["id", "OTP", "verifiedAtForgetCase"],
        });

        const userData = await users.findByPk(userId, {
            attributes: ["id", "password"],
        });

        if (!otpData) {
            throw new NotFoundError("Sorry, we could not fetch the data", "Please resend OTP to continue");
        }

        if (otpData.verifiedAtForgetCase === false) {
            throw new UnauthorizedError("OTP not verified yet", "Please verify OTP first");
        }

        let hashedPassword = await bcrypt.hash(password, 8);
        userData.password = hashedPassword;
        await userData.save();

        // Reset the OTP verification status
        otpData.verifiedAtForgetCase = false;
        await otpData.save();

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

        const userExist = await users.findByPk(userId);

        if (!userExist) {
            throw new NotFoundError("Sorry, we could not fetch the associated data", "Please try sending again");
        }

        let otpData = await otpVerification.findOne({ where: { userId } });
        let OTP = otpGenerator.generate(4, {
            lowerCaseAlphabets: false,
            upperCaseAlphabets: false,
            specialChars: false,
        });

        // Send OTP email using otpMail
        await otpMail({
            type: 'RegisterOTP',
            email: userExist.email,
            OTP: OTP,
            userName: userExist.firstName
        });

        let DT = new Date();
        // Set OTP expiration to 1 minute from now
        let expirationTime = new Date(DT.getTime() + 1 * 60 * 1000); // 1 minute

        if (!otpData) {
            const newOtpData = await otpVerification.create({
                OTP,
                reqAt: DT,
                expirtAt: expirationTime,
                verifiedInForgetCase: false,
                userId,
            });
            return {
                otpId: newOtpData.id,
                message: "OTP sent successfully"
            };
        } else {
            await otpVerification.update(
                {
                    OTP,
                    reqAt: DT,
                    expirtAt: expirationTime,
                    verifiedInForgetCase: false,
                },
                { where: { userId } }
            );
            return {
                otpId: otpData.id,
                message: "OTP sent successfully"
            };
        }
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
                "You are blocked by Admin",
                "Please contact support for more information"
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

        const userData = await users.findOne({
            where: {
                id: userId
            },
            attributes: ['id', 'firstName', 'lastName', 'image', 'email', 'phoneNum', 'userTypeId', 'stripeCustomerId', 'countryCode']
        });

        if (!userData) {
            throw new NotFoundError('No User Exists with this email');
        }

        return {
            userData,
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
}

module.exports = new CustomerAuthService();
