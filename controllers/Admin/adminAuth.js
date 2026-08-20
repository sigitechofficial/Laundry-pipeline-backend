require("dotenv").config();
// Admin-specific error handling
const { 
    AdminValidationError, 
    AdminNotFoundError, 
    AdminUnauthorizedError, 
    AdminConflictError 
} = require('../../middlewares/adminErrorHandler');
const ResponseHelper = require('../../utils/responseHelper');
const adminValidateToken = require('../../middlewares/adminValidateToken');

// Import services
const { authService } = require('../../services/Admin');
const { getAdminJwtExpiresInMs } = require('../../utils/adminJwt');




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
        sameSite: "none",
        path: "/admin",
        maxAge: getAdminJwtExpiresInMs()
    });


    return ResponseHelper.success(res, "Login Successful", output);
}





/*
 *        Zone Admin SignIn
 */
async function zoneAdminSignIn(req, res) {
    const { email, password, dvToken } = req.body;

    if (!email || !password) {
        return ResponseHelper.validationError(res, "Email and password are required");
    }

    const signInData = { email, password, dvToken };
    const output = await authService.zoneAdminSignIn(signInData);

    // Set HTTP-only cookie
    res.cookie("accessToken", output.accessToken, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: "/admin",
        maxAge: getAdminJwtExpiresInMs()
    });

    return ResponseHelper.success(res, "Zone Admin Login Successful", output);
}


/*
 *        Admin SignOut
 */
async function signOut(req, res) {
    const adminId = req.user?.id;
    const dvToken = req.user?.dvToken;

    // Never accept session identifiers from the request body: the verified
    // access token is the authority for which Redis session may be revoked.
    if (!adminId || !dvToken) {
        return ResponseHelper.validationError(res, "Authenticated admin session is required");
    }

    await authService.adminSignOut(adminId, dvToken);
    adminValidateToken.invalidateCachedSession(adminId, dvToken);

    // Clear the cookie
    res.clearCookie("accessToken", {
        path: "/admin",
    });

    return ResponseHelper.success(res, "Sign out successful", {});
}

module.exports = {
    signIn,
    zoneAdminSignIn,
    signOut
}