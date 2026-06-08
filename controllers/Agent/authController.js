const authService = require('../../services/Agent/authService');
const ResponseHelper = require('../../utils/responseHelper');

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
    const data = { 
        userId: req.user.id,
        dvToken: req.user.dvToken
    };
    await authService.logout(data);
    
    // Clear the cookie
    res.clearCookie("accessToken", {
        path: "/agent",
    });
    
    return ResponseHelper.success(res, "Log-out successfully", {});
};

// Session
const session = async (req, res) => {
    const data = {
        userId: req.user.id,
        dvToken: req.user.dvToken,
        ...req.body
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

// Generate Stripe onboarding link - Now accepts connectAccountId from query
const generateStripeOnboardingLink = async (req, res) => {
    const { connectAccountId } = req.query;
    
    if (!connectAccountId) {
        return ResponseHelper.error(res, "connectAccountId is required in query parameters", "Missing required parameter", 400);
    }

    const data = { 
        connectAccountId: connectAccountId
    };

    const result = await authService.generateStripeOnboardingLink(data);
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

// Employee logout
const employeeLogout = async (req, res) => {
    const data = {
        userId: req.user.id,
        dvToken: req.user.dvToken
    };
    await authService.employeeLogout(data);

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
    deleteAccount
};