require('dotenv').config()
const{verify}=require('jsonwebtoken')
const redisCli=require('../redis/redis')
const customError=require('../middlewares/customError')


module.exports=async function validateAccessToken(req,res,next) {
    try {

        const accessToken=req.cookies.accessToken
        console.log("🚀 ~ validateAccessToken ~ req.cookies:", req.cookies)
        console.log("URL---------------------------->>",req.url);
        
        if(!accessToken){
            throw new Error();
        }
        console.log("AccessToken Step-1")
    
        const validateToken=verify(accessToken,process.env.JWT_ACCESS_SECRET)
        //console.log("🚀 ~ validateAccessToken ~ validateToken:", validateToken)

        console.log("AccessToken Step-2",validateAccessToken)

    
        req.user=validateToken;
        next()
        
    } catch (error) {
        return res.status(403).json({
            status:'403',
            message:"Access Denied",
            data:{error},
            error:'You are not Admin to access it'
        })
        
    }
  
    
}