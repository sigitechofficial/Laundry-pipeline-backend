require('dotenv').config()
const{verify}=require('jsonwebtoken')
const redisCli=require('../redis/redis')
const customError=require('../middlewares/customError')


module.exports=async function validateAccessToken(req,res,next) {
    try {

        const accessToken=req.cookies.accessToken
        console.log("🚀 ~ validateAccessToken ~ req.cookies:", req.cookies)
        console.log("URL---------------------------->>",req.url);

        // If not found in cookies, check for Authorization header
        if (!accessToken && req.headers.authorization) {
            const authHeader = req.headers.authorization;
            // The format should be 'Bearer <token>'
            const token = authHeader.split(' ')[1]; // Get the token part of the Authorization header
            if (token) {
                accessToken = token;
            }
        }
        

        if(!accessToken){
            throw new Error();
        }
    
        const validateToken=verify(accessToken,process.env.JWT_ACCESS_SECRET)
        console.log("🚀 ~ validateAccessToken ~ validateToken:", validateToken)
    
        const redisToken=await redisCli.hGetAll(`id-${validateToken.id}`);
        console.log("🚀 ~ validateAccessToken ~ redisToken:", redisToken)
        if(!redisToken){
            throw new Error("Invalid Token")
        }
    
        const dvToken=validateToken.dvToken;
        console.log("🚀 ~ validateAccessToken ~ dvToken:", dvToken)
        const redis_Validate=verify(redisToken[dvToken],process.env.JWT_ACCESS_SECRET)
        console.log("🚀 ~ validateAccessToken ~ redis_Validate:", redis_Validate)
    
        req.user=redis_Validate;
        next()
        
    } catch (error) {
        return res.status(403).json({
            status:'0',
            message:"Access Denied",
            data:{},
            error:'You are not authorized to access it'
        })
        
    }
  
    
}