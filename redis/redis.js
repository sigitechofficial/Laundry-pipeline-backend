require('dotenv').config()
const redis=require('redis')

//connect Redis and create client 
const redisClient=redis.createClient({
    host:'localhost',
    port:'6379',
    pass:''
})

redisClient.on('connect',function(){
    console.log('\x1b[31m%s\x1b[0m', "Redis Cli  Connected");
    
})

redisClient.on('error',function(err){
    console.log('Error in Connecting Redis',err);
    
})

redisFunc()
async function redisFunc() {
    await redisClient.connect()
    
}

module.exports=redisClient