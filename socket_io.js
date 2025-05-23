require('dotenv').config()
const { Server } = require('socket.io')
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
                socket.join(userId)
                console.log(`Socket ${socket.id} joined room ${userId}`);
            } catch (error) {
                console.error("Error in joinRoom", error)

            }
        })
        //Reconnect User Event
        socket.on('re-connect', async (message) => {
            let data = JSON.parse(message)
            const userId = data.userId
            console.log('🚀 ~ RECONNECT ROOM JOIN:', userId)
            socket.join(userId)
            const rows = await unAcknowledgedEvents.findAll({ where: { to: userId } })
            rows.forEach((event) => {
                //console.log(`🚀ðŸš€ðŸš€Even a`, event)

                socket_Instance
                    .to(event.to)
                    .emit(event.type, JSON.parse(event.data), async (ack) => {
                        if (ack) {
                            console.log(`🚀ðŸš€ðŸš€Even acknowledged by `)
                            await unAcknowledgedEvents.destroy({ where: { id: event.id } })
                            // Event was acknowledged, no further action needed
                        } else {
                            console.log(`🚀ðŸš€ðŸš€Event not acknowledged by `)
                        }
                    })
            })
        })
        //Agent Accept Order
        socket.on('agentAcceptOrder', async (bookingData) => {
            try {
                const bookingDetails = JSON.parse(bookingData);
                let bookingId = bookingDetails.id
                let agentId = bookingDetails.agentId
                await booking.update({
                    bookingStatusId: 4,
                    laundryShopId: bookingDetails.laundryShopId,
                    driverId: agentId
                }, { where: { id: bookingId } })
                const currentTime = new Date().toLocaleTimeString('en-US', {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                });
                const currentDate = new Date().toISOString().split('T')[0];
                console.log(currentDate);
                console.log(currentTime);
                const statusId = [2, 4];
                const bookinghistories = statusId.map(statusId => ({
                    date: currentDate,
                    time: currentTime,
                    bookingId: bookingId,
                    bookingStatusId: statusId
                }))
                await bookingHistory.bulkCreate(bookinghistories);
                const eventData = {
                    type: 'AcceptedOrder',
                    data: {
                        data: bookingId,
                        message: 'Order Accepted By Agent'
                    }
                }
                sendEvent(agentId, eventData)
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
        console.log(`Event data being sent:`, eventData);
        console.log(`Event data being sent to:`, userId.toString());

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