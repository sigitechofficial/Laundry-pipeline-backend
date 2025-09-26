require("dotenv").config();
// Admin-specific error handling
const { 
    AdminValidationError, 
    AdminNotFoundError, 
    AdminUnauthorizedError, 
    AdminConflictError 
} = require('../../middlewares/adminErrorHandler');
const ResponseHelper = require('../../utils/responseHelper');

// Import services
const { authService } = require('../../services/Admin');




//!-------------------------Admin SignIn-----------------------------------------//
/*
 *        Admin SignIn
*/

async function signIn(req, res) {
    const { email, password, dvToken } = req.body;

    // Basic validation only
    if (!email || !password) {
        return ResponseHelper.validationError(res, "Email and password are required");
    }

    const signInData = {
        email,
        password,
        dvToken
    };

    const output = await authService.adminSignIn(signInData);

    // Set HTTP-only cookie
    res.cookie("accessToken", output.accessToken, {
        httpOnly: true,
        secure: true,
        sameSite: "None",
        path: "/admin",
        maxAge: 24 * 60 * 60 * 1000
    });

    return ResponseHelper.success(res, "Login Successful", output);
}





/*
 *        Admin SignOut
 */
async function signOut(req, res) {
    const { adminId, dvToken } = req.body;

    // Basic validation only
    if (!adminId || !dvToken) {
        return ResponseHelper.validationError(res, "Admin ID and device token are required");
    }

    await authService.adminSignOut(adminId, dvToken);

    // Clear the cookie
    res.clearCookie("accessToken", {
        path: "/admin"
    });

    return ResponseHelper.success(res, "Sign out successful", {});
}

module.exports = {
    signIn,
    signOut
}