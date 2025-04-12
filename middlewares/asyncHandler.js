module.exports=function(handler){
    return async(req ,res, next)=>{
        try {
            await handler(req,res)
        } catch (err) {
            console.log("Async MiddleWare Error",err);
            next(err)
        }
    }
}