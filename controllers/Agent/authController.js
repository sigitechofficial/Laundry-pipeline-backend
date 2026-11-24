const authService = require('../../services/Agent/authService');
const ResponseHelper = require('../../utils/responseHelper');
const { saveCurrentToken } = require('../../utils/deviceTokenStore');
const { reportedPushProject } = require('../../utils/pushTokenProject');
const { identityOfSession, normalizeDeviceId } = require('../../utils/appSession');
const { isValidFcmRegistrationToken } = require('../../utils/fcmToken');
const { shopAgentIdFromReq } = require('../../utils/shopAgentContext');

// Register agent with OTP
const registerAgentWithOTP = async (req, res) => {
    const profileImg = req.file?.path;
    const data = { ...req.body };

    const result = await authService.registerAgentWithOTP(data, profileImg);
    return ResponseHelper.success(res, "Agent registered successfully. Please verify your email.", result);
};

// Verify OTP for signup
const verifyOTpSignUp = async (req, res) => {
    const data = { ...req.body };
    const result = await authService.verifyOTpSignUp(data);
    
    // Set HTTP-only cookie after successful OTP verification (same as customer)
    if (result.accessToken) {
        res.cookie("accessToken", result.accessToken, {
            httpOnly: true,
            secure: true,
            sameSite: "None",
            path: "/agent",
            maxAge: 24 * 60 * 60 * 1000 // 24 hours
        });
    }
    
    return ResponseHelper.success(res, "OTP verified successfully", result);
};

// Resend OTP
const resendOTP = async (req, res) => {
    const data = { ...req.body };
    const result = await authService.resendOTP(data);
    return ResponseHelper.success(res, "OTP resent successfully", result);
};

// Agent business info
const agentBusinessInfo = async (req, res) => {
    const data = { ...req.body };

    const result = await authService.agentBusinessInfo(data);

    if (result.agentApprovalPending) {
        res.clearCookie("accessToken", {
            httpOnly: true,
            secure: true,
            sameSite: "None",
            path: "/agent",
        });
    }

    const message =
        result.message || "Business information added successfully";
    return ResponseHelper.success(res, message, result);
};

// Business info added
const businesInfoAdded = async (req, res) => {
    const { userId } = req.params;
    const data = { 
        userId: userId,
        ...req.body 
    };
    const result = await authService.businesInfoAdded(data);
    return ResponseHelper.success(res, "Service added successfully", result);
};

// Working hours update
const workingHoursUpdate = async (req, res) => {
    const { userId } = req.params;
    const data = { 
        userId: userId,
        ...req.body 
    };
    const result = await authService.workingHoursUpdate(data);
    return ResponseHelper.success(res, "Working hours updated successfully", result);
};

// Login user
const loginUser = async (req, res) => {
    const data = { ...req.body };
    const result = await authService.loginUser(data);
    
    // Set HTTP-only cookie (same as customer and admin)
    if (result.accessToken) {
        res.cookie("accessToken", result.accessToken, {
            httpOnly: true,
            secure: true,
            sameSite: "None",
            path: "/agent",
            maxAge: 24 * 60 * 60 * 1000 // 24 hours
        });
    }
    
    return ResponseHelper.success(res, "Login successful", result);
};

// Forget password request
const forgetPasswordRequest = async (req, res) => {
    const data = { ...req.body };
    const result = await authService.forgetPasswordRequest(data);
    return ResponseHelper.success(res, "Password reset OTP sent to your email", result);
};

// Verify OTP for password
const verifyOTPforPassword = async (req, res) => {
    const data = { ...req.body };
    const result = await authService.verifyOTPforPassword(data);
    return ResponseHelper.success(res, "OTP verified successfully", result);
};

// Change password OTP
const changePasswordOTP = async (req, res) => {
    const data = { ...req.body };
    const result = await authService.changePasswordOTP(data);
    return ResponseHelper.success(res, "Password changed successfully", result);
};

// Logout
const logout = async (req, res) => {
    await authService.logout(req.user);
    
    // Clear the cookie
    res.clearCookie("accessToken", {
        path: "/agent",
    });
    
    return ResponseHelper.success(res, "Log-out successfully", {});
};

// Session
const session = async (req, res) => {
    const data = {
        ...req.body,
        userId: req.user.id,
        // Re-issues this install's session; the body cannot switch it to another one.
        identity: identityOfSession(req.user, req.body),
    };

    const result = await authService.session(data);
    return ResponseHelper.success(res, "Session data fetched successfully", result);
};

// Get user profile
const getUserProfile = async (req, res) => {
    const data = { userId: req.user.id };
    const result = await authService.getUserProfile(data);
    return ResponseHelper.success(res, "User profile fetched successfully", result);
};

// Update user profile
const updateUserProfile = async (req, res) => {
    const profileImg = req.file?.path;

    const data = { 
        userId: req.user.id,
        ...req.body
    };
    const result = await authService.updateUserProfile(data, profileImg);
    return ResponseHelper.success(res, "Profile updated successfully", result);
};

// Stripe onboarding link for the signed-in owner's shop (route: validateAccessToken +
// requireShopOwner). Installed builds still send ?connectAccountId=; it is ignored —
// the Connect account is the one stored for the caller's shop.
const generateStripeOnboardingLink = async (req, res) => {
    const result = await authService.generateStripeOnboardingLink({
        shopOwnerId: shopAgentIdFromReq(req),
    });
    return ResponseHelper.success(res, "Stripe onboarding link generated successfully", result);
};

// Employee login
const employeeLogin = async (req, res) => {
    const data = { ...req.body };
    const result = await authService.employeeLogin(data);

    if (result.accessToken) {
        res.cookie("accessToken", result.accessToken, {
            httpOnly: true,
            secure: true,
            sameSite: "None",
            path: "/agent",
            maxAge: 24 * 60 * 60 * 1000
        });
    }

    return ResponseHelper.success(res, "Employee login successful", result);
};

/**
 * POST /agent/deviceToken { dvToken, firebaseProjectId? } — the shop app reports its current push token
 * (on start and whenever Firebase rotates it). The server otherwise only learns the
 * token at sign-in, so a rotated token silently stopped all pushes until the next login,
 * and an install that had no token at sign-in (simulator, Firebase unavailable) got none.
 * Works for owners and staff alike: the token belongs to the signed-in account and, for
 * installs with a deviceId session, replaces that install's previous token.
 */
const updateDeviceToken = async (req, res) => {
    const token = typeof req.body?.dvToken === 'string' ? req.body.dvToken.trim() : '';
    if (!isValidFcmRegistrationToken(token)) {
        return res.status(400).json({
            status: '0', message: 'A valid device token is required', data: {}, error: 'INVALID_DEVICE_TOKEN',
        });
    }
    const project = reportedPushProject(req.body);
    if (!project.ok) {
        return res.status(400).json({ status: '0', message: project.message, data: {}, error: project.error });
    }
    const { created } = await saveCurrentToken(
        req.user.id, token, normalizeDeviceId(req.user.deviceId), project.firebaseProjectId
    );
    return ResponseHelper.success(res, 'Device token saved', { created, firebaseProjectId: project.firebaseProjectId });
};

// Employee logout
const employeeLogout = async (req, res) => {
    await authService.employeeLogout(req.user);

    res.clearCookie("accessToken", { path: "/agent" });

    return ResponseHelper.success(res, "Employee logged out successfully", {});
};

const deleteAccount = async (req, res) => {
    const result = await authService.deleteAgentAccount(req.user.id);
    res.clearCookie("accessToken", { path: "/agent" });
    return ResponseHelper.success(res, "Account deleted successfully", result);
};

module.exports = {
    registerAgentWithOTP,
    verifyOTpSignUp,
    resendOTP,
    agentBusinessInfo,
    businesInfoAdded,
    workingHoursUpdate,
    loginUser,
    forgetPasswordRequest,
    verifyOTPforPassword,
    changePasswordOTP,
    logout,
    session,
    getUserProfile,
    updateUserProfile,
    generateStripeOnboardingLink,
    employeeLogin,
    employeeLogout,
    updateDeviceToken,
    deleteAccount
};