require('dotenv').config()
const { Server } = require('socket.io')
const agentBookingDeclineService = require('./services/Agent/agentBookingDeclineService');
const { notifyBookingTakenByAgent } = require('./utils/bookingTakenNotify');
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
    zone,
    unAcknowledgedEvents } = require('./models')

let socket_Instance;


const intilizeSocketFunc = (server) => {
    const io = new Server(server,{
    pingTimeout: 1000, // Time (in ms) before the server considers the connection dead if no pong is received
    pingInterval: 500, // Time (in ms) between ping packets sent by the server to check client connectivity
  })
    socket_Instance = io
    io.on("connection", (socket) => {
        console.log(`User Connected ${socket.id}`);
        //Event when User Connects
        socket.on("joinRoom", (message) => {
            try {
                let data = JSON.parse(message);
                console.log("🚀 ~ socket.on ~ data:", data)
                const userId = data.userId
                const userTypeId = data.userTypeId
                
                // Validate userId - ensure it's not null, undefined, or string 'null'
                if (!userId || userId === 'null' || userId === 'undefined' || userId === null || userId === undefined) {
                    console.error(`❌ Invalid userId received: ${userId}. Cannot join room.`);
                    socket.emit('error', { 
                        message: 'Invalid user ID. Please authenticate first.',
                        code: 'INVALID_USER_ID'
                    });
                    return;
                }
                
                socket.join(userId.toString())
                console.log(`✅ Socket ${socket.id} joined room ${userId}`);
                
                // Confirm to client
                socket.emit('roomJoined', { 
                    userId: userId,
                    message: 'Successfully joined room'
                });
            } catch (error) {
                console.error("❌ Error in joinRoom:", error)
                socket.emit('error', { 
                    message: 'Failed to join room',
                    code: 'JOIN_ROOM_ERROR'
                });
            }
        })
        //Reconnect User Event
        socket.on('re-connect', async (message) => {
            try {
                let data = JSON.parse(message)
                const userId = data.userId
                console.log('🚀 ~ RECONNECT ROOM JOIN:', userId)
                
                // Validate userId
                if (!userId || userId === 'null' || userId === 'undefined' || userId === null || userId === undefined) {
                    console.error(`❌ Invalid userId on reconnect: ${userId}`);
                    socket.emit('error', { 
                        message: 'Invalid user ID on reconnect. Please authenticate first.',
                        code: 'INVALID_USER_ID'
                    });
                    return;
                }
                
                socket.join(userId.toString())
                console.log(`✅ Socket ${socket.id} reconnected to room ${userId}`);
                
                const rows = await unAcknowledgedEvents.findAll({ 
                    where: { to: userId.toString() } 
                })
                
                rows.forEach((event) => {
                    //console.log(`🚀🚀🚀Even a`, event)

                    socket_Instance
                        .to(event.to)
                        .emit(event.type, JSON.parse(event.data), async (ack) => {
                            if (ack) {
                                console.log(`✅ Event acknowledged by ${event.to}`)
                                await unAcknowledgedEvents.destroy({ where: { id: event.id } })
                                // Event was acknowledged, no further action needed
                            } else {
                                console.log(`⚠️ Event not acknowledged by ${event.to}`)
                            }
                        })
                })
                
                // Confirm reconnection to client
                socket.emit('reconnected', {
                    userId: userId,
                    message: 'Successfully reconnected',
                    pendingEvents: rows.length
                });
            } catch (error) {
                console.error("❌ Error in re-connect:", error);
                socket.emit('error', { 
                    message: 'Reconnection failed',
                    code: 'RECONNECT_ERROR'
                });
            }
        })
        //Agent Accept Order
        socket.on('agentAcceptOrder', async (bookingData) => {
            try {
                const bookingDetails = JSON.parse(bookingData);
                const bookingId = bookingDetails.id;
                const agentId = bookingDetails.agentId;

                const { acceptOrderForAgent } = require('./services/Agent/agentAcceptOrderService');

                try {
                    await acceptOrderForAgent(agentId, bookingId);
                } catch (acceptError) {
                    const message =
                        acceptError.message || 'This order was already taken';
                    await sendEvent(agentId, {
                        type: 'orderTakenByOtherAgent',
                        data: {
                            bookingId: Number(bookingId),
                            message,
                        },
                    });
                }
            } catch (error) {
                console.error("Error in event listeing agentAceeptOrder : ", error)
            }
        })
        //Assign Driver
        socket.on('FreeLanceDriverAcceptOrder', async (bookingData) => {
            let driverId = bookingData.driverId
        })
        //Disconnect User Event
        socket.on("disconnect", () => {
            console.log(`User ${socket.id} disconnected`);

        })

    })
    return io;


}




// Helper function to send events to users in specific rooms
// const sendEvent=async(userId,eventData)=>{
//     try {
//         console.log(`Sending event to user ${userId}: `,eventData);

//         socket_Instance.to(userId).emit(eventData.type, eventData.data)

//     } catch (error) {
//         console.error(`Error in sending the event to user ${userId}: `,error)
//     }
// }

const sendEvent = async (userId, eventData) => {
    try {
        //console.log(`Event data being sent:`, eventData);
        //console.log(`Event data being sent to:`, userId.toString());

        socket_Instance
            .to(userId.toString())
            .emit(eventData.type, eventData.data, async (ack) => {
                console.log(`Acknowledgement received: ${ack}`);
                if (ack) {
                    console.log(`${eventData.type} acknowledged by ${userId}`);
                } else {
                    console.log(`${eventData.type} not acknowledged by ${userId}`);
                    await unAcknowledgedEvents.create({
                        to: userId,
                        type: eventData.type,
                        data: JSON.stringify(eventData.data), // Store as string in DB
                    });
                }
            });
    } catch (error) {
        console.log(`Error while sending event: ${error}`);
    }
};

module.exports = {
    intilizeSocketFunc,
    sendEvent

}
