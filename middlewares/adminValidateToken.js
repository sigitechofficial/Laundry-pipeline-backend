// require('dotenv').config()
// const{verify}=require('jsonwebtoken')
// const redisCli=require('../redis/redis')
// const customError=require('../middlewares/customError')


// module.exports=async function validateAccessToken(req,res,next) {
//     try {

//         const accessToken=req.cookies.accessToken
//         console.log("🚀 ~ validateAccessToken ~ req.cookies:", req.cookies)
//         console.log("URL---------------------------->>",req.url);
        
//         if(!accessToken){
//             throw new Error();
//         }
//         console.log("AccessToken Step-1")
    
//         const validateToken=verify(accessToken,process.env.JWT_ACCESS_SECRET)
//         //console.log("🚀 ~ validateAccessToken ~ validateToken:", validateToken)

//         console.log("AccessToken Step-2",validateAccessToken)

    
//         req.user=validateToken;
//         next()
        
//     } catch (error) {
//         return res.status(403).json({
//             status:'403',
//             message:"Access Denied",
//             data:{error},
//             error:'You are not Admin to access it'
//         })
        
//     }
  
    
// }

require('dotenv').config();
const { verify } = require('jsonwebtoken');
const redisCli = require('../redis/redis');
const customError = require('../middlewares/customError');

module.exports = async function validateAccessToken(req, res, next) {
    try {
        // Check for token in cookies
        let accessToken = req.cookies.accessToken;

        // If not found in cookies, check for Authorization header
        if (!accessToken && req.headers.authorization) {
            const authHeader = req.headers.authorization;
            // The format should be 'Bearer <token>'
            const token = authHeader.split(' ')[1]; // Get the token part of the Authorization header
            if (token) {
                accessToken = token;
            }
        }

        // If no token found in both, deny access
        if (!accessToken) {
            throw new Error('Access token not found');
        }

        // Verify the token
        const validateToken = verify(accessToken, process.env.JWT_ACCESS_SECRET);
        console.log("AccessToken valid: ", validateToken);

        // Attach the user info to the request object for further use
        req.user = validateToken;

        // Proceed to the next middleware or route handler
        next();

    } catch (error) {
        // If verification fails or token is missing, send an error response
        return res.status(403).json({
            status: '403',
            message: "Access Denied",
            data: { error: error.message },
            error: 'You are not authorized to access this resource'
        });
    }
};
