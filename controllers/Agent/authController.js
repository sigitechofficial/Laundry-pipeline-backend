const authService = require('../../services/Agent/authService');
const ResponseHelper = require('../../utils/responseHelper');

// Register agent with OTP
const registerAgentWithOTP = async (req, res) => {
    const { firstName, lastName, email, password, phoneNum, classifiedAsId, roleId, userTypeId } = req.body;
    const profileImg = req.file?.path;

    const data = {
        firstName,
        lastName,
        email,
        password,
        phoneNum,
        classifiedAsId,
        roleId,
        userTypeId
    };

    const result = await authService.registerAgentWithOTP(data, profileImg);
    return ResponseHelper.success(res, "Agent registered successfully. Please verify your email.", result);
};

// Verify OTP for signup
const verifyOTpSignUp = async (req, res) => {
    const { otpId, OTP, userId } = req.body;

    const data = { otpId, OTP, userId };
    const result = await authService.verifyOTpSignUp(data);
    return ResponseHelper.success(res, "OTP verified successfully", result);
};

// Resend OTP
const resendOTP = async (req, res) => {
    const { userId } = req.body;

    const data = { userId };
    const result = await authService.resendOTP(data);
    return ResponseHelper.success(res, "OTP resent successfully", result);
};

// Agent business info
const agentBusinessInfo = async (req, res) => {
    const { shopName, matchProfileOptions, serviceTime, userId } = req.body;

    const data = {
        shopName,
        matchProfileOptions,
        serviceTime,
        userId
    };

    const result = await authService.agentBusinessInfo(data);
    return ResponseHelper.success(res, "Business information added successfully", result);
};

// Business info added
const businesInfoAdded = async (req, res) => {
    const { serviceId, userId } = req.body;

    const data = { serviceId, userId };
    const result = await authService.businesInfoAdded(data);
    return ResponseHelper.success(res, "Service added successfully", result);
};

// Working hours update
const workingHoursUpdate = async (req, res) => {
    const { workingHours, userId } = req.body;

    const data = { workingHours, userId };
    const result = await authService.workingHoursUpdate(data);
    return ResponseHelper.success(res, "Working hours updated successfully", result);
};

// Login user
const loginUser = async (req, res) => {
    const { email, password, dvToken } = req.body;

    const data = { email, password, dvToken };
    const result = await authService.loginUser(data);
    return ResponseHelper.success(res, "Login successful", result);
};

// Forget password request
const forgetPasswordRequest = async (req, res) => {
    const { email } = req.body;

    const data = { email };
    const result = await authService.forgetPasswordRequest(data);
    return ResponseHelper.success(res, "Password reset OTP sent to your email", result);
};

// Verify OTP for password
const verifyOTPforPassword = async (req, res) => {
    const { otpId, OTP } = req.body;

    const data = { otpId, OTP };
    const result = await authService.verifyOTPforPassword(data);
    return ResponseHelper.success(res, "OTP verified successfully", result);
};

// Change password OTP
const changePasswordOTP = async (req, res) => {
    const { otpId, newPassword } = req.body;

    const data = { otpId, newPassword };
    const result = await authService.changePasswordOTP(data);
    return ResponseHelper.success(res, "Password changed successfully", result);
};

// Logout
const logout = async (req, res) => {
    const { userId, dvToken } = req.body;

    const data = { userId, dvToken };
    const result = await authService.logout(data);
    return ResponseHelper.success(res, "Logout successful", result);
};

// Session
const session = async (req, res) => {
    const { userId, guestUser, dvToken } = req.body;

    const data = {
        userId,
        guestUser,
        dvToken
    };

    const result = await authService.session(data);
    return ResponseHelper.success(res, "Session data fetched successfully", result);
};

// Get user profile
const getUserProfile = async (req, res) => {
    const { userId } = req.params;

    const data = { userId };
    const result = await authService.getUserProfile(data);
    return ResponseHelper.success(res, "User profile fetched successfully", result);
};

// Update user profile
const updateUserProfile = async (req, res) => {
    const { userId } = req.params;
    const { firstName, lastName, phoneNum } = req.body;
    const profileImg = req.file?.path;

    const data = { userId, firstName, lastName, phoneNum };
    const result = await authService.updateUserProfile(data, profileImg);
    return ResponseHelper.success(res, "Profile updated successfully", result);
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
    updateUserProfile
};