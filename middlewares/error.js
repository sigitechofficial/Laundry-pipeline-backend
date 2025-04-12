module.exports=function(err,req,res,next){
    err=JSON.parse(JSON.stringify(err))

    let message='Something went wrong'
    if(err.message){
        message=err.message
    }
    else if(err.body){
        message=err.body
    }
    else if(err?.errors && err.errors.length>0){
        message=err.errors[0].message
    }

    res.json({
        status:'0',
        message:'',
        data:{},
        'error':message
    })
}