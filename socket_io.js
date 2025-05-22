require('dotenv').config()
const{Server}=require('socket.io')
const { users,
    userType,
    booking,
    otpVerification,
    deviceToken,
    bookingHistory,
    billingDetails,
    categories,
    subCategories,
    addressDb,
    customerSelectedService,
    bookingStatus,
    service,
    zone } = require('./models')

let socket_Instance;


const intilizeSocketFunc=(server)=>{
    const io=new Server(server)
    socket_Instance=io
    io.on("connection",(socket)=>{
        console.log(`User Connected ${socket.id}`);
        //Event when User Connects
        socket.on("joinRoom",(message) =>{
            try {
                let data = JSON.parse(message);
                console.log("🚀 ~ socket.on ~ data:", data)
                const userId=data.userId
                const userTypeId=data.userTypeId
                socket.join(userId)
                console.log(`Socket ${socket.id} joined room ${userId}`);
            } catch (error) {
                console.error("Error in joinRoom",error)
                
            }
        })
        //Reconnect User Event
        socket.on('Reconnect',async(message) =>{
            try {
                console.log("Reconnecting User .........");
                const data=JSON.parse(message)
                const userId=data.userId
                socket.join(userId)
                console.log(`User ${userId} re-connected`);
                socket_Instance.to(userId).emit("reconnectEvent",{message:"User Reconnected Sucessfully"}) 
            } catch (error) {
                console.error("Error during Reconnect : ",error);
            }
        })
        //Agent Accept Order
        socket.on('agentAcceptOrder',async(bookingData)=>{
            try {
                const bookingDetails=JSON.parse(bookingData);
                let bookingId=bookingDetails.id
                let agentId=bookingDetails.agentId
                await booking.update({
                    bookingStatusId:4,
                    laundryShopId:bookingDetails.laundryShopId,
                    driverId:agentId
                },{where:{id:bookingId}})
                const currentTime = new Date().toLocaleTimeString('en-US', {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                });
                const currentDate = new Date().toISOString().split('T')[0];
                console.log(currentDate);
                console.log(currentTime); 
                const statusId=[2,4];
                const bookinghistories=statusId.map(statusId =>({
                    date:currentDate,
                    time:currentTime,
                    bookingId:bookingId,
                    bookingStatusId:statusId
                }))
                await bookingHistory.bulkCreate(bookinghistories)
            } catch (error) {
                console.error("Error in event listeing agentAceeptOrder : ",error)
                
            }
        })
        //Assign Driver
        socket.on('FreeLanceDriverAcceptOrder',async(bookingData) =>{
            let driverId=bookingData.driverId
        })
        //Disconnect User Event
        socket.on("disconnect",() =>{
            console.log(`User ${socket.id} disconnected`);
            
        })
        
    })
    return io;
    
    
}




// Helper function to send events to users in specific rooms
const sendEvent=async(userId,eventData)=>{
    try {
        console.log(`Sending event to user ${userId}: `,eventData);
        
        socket_Instance.to(userId).emit(eventData.type, eventData.data)
        
    } catch (error) {
        console.error(`Error in sending the event to user ${userId}: `,error)
    }
}


module.exports={
    intilizeSocketFunc,
    sendEvent

}