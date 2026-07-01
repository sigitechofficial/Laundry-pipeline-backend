require('dotenv').config()
const { Server } = require('socket.io')
const agentBookingDeclineService = require('./services/Agent/agentBookingDeclineService');
const { notifyBookingTakenByAgent } = require('./utils/bookingTakenNotify');
const { triggerHeldReleaseForAgent } = require('./utils/triggerHeldReleaseForAgent');
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

const ACK_TIMEOUT_MS = 4000;

function resolveStoredEventType(row) {
    const plain = row?.toJSON ? row.toJSON() : row;
    return plain?.event || plain?.type || null;
}

async function persistUnacknowledgedEvent(userId, eventData) {
    const bookingId =
        eventData?.data?.id ??
        eventData?.data?.bookingId ??
        null;

    await unAcknowledgedEvents.create({
        to: userId.toString(),
        event: eventData.type,
        data: JSON.stringify(eventData.data),
        bookingId: bookingId != null ? Number(bookingId) : null,
    });
}

async function replayUnacknowledgedEvents(userId) {
    const rows = await unAcknowledgedEvents.findAll({
        where: { to: userId.toString() },
    });

    for (const row of rows) {
        const eventType = resolveStoredEventType(row);
        if (!eventType || !row.data) {
            console.warn(`⚠️ Skipping malformed unAcknowledgedEvent id=${row.id}`);
            continue;
        }

        let payload;
        try {
            payload = JSON.parse(row.data);
        } catch (parseErr) {
            console.warn(`⚠️ Invalid unAcknowledgedEvent data id=${row.id}:`, parseErr.message);
            continue;
        }

        socket_Instance
            .to(row.to)
            .emit(eventType, payload, async (ack) => {
                if (ack) {
                    console.log(`✅ Event acknowledged by ${row.to}`);
                    await unAcknowledgedEvents.destroy({ where: { id: row.id } });
                } else {
                    console.log(`⚠️ Event not acknowledged by ${row.to}`);
                }
            });
    }

    return rows.length;
}

const intilizeSocketFunc = (server) => {
    const io = new Server(server,{
    pingTimeout: 1000, // Time (in ms) before the server considers the connection dead if no pong is received
    pingInterval: 500, // Time (in ms) between ping packets sent by the server to check client connectivity
  })
    socket_Instance = io
    io.on("connection", (socket) => {
        console.log(`User Connected ${socket.id}`);
        //Event when User Connects
        socket.on("joinRoom", async (message) => {
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

                // Agent shop open → release held bookings + deliver pending socket events.
                triggerHeldReleaseForAgent(userId).catch((err) => {
                    console.error('[joinRoom] held release error:', err.message);
                });
                
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

                await triggerHeldReleaseForAgent(userId);
                const pendingEvents = await replayUnacknowledgedEvents(userId);
                
                // Confirm reconnection to client
                socket.emit('reconnected', {
                    userId: userId,
                    message: 'Successfully reconnected',
                    pendingEvents,
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
        if (!socket_Instance) {
            await persistUnacknowledgedEvent(userId, eventData);
            return;
        }

        const room = userId.toString();
        const sockets = await socket_Instance.in(room).fetchSockets();

        if (!sockets.length) {
            console.log(`${eventData.type} — no socket in room ${room}, persisting event`);
            await persistUnacknowledgedEvent(userId, eventData);
            return;
        }

        let settled = false;
        const timer = setTimeout(async () => {
            if (settled) return;
            settled = true;
            console.log(`${eventData.type} ack timeout for ${room}, persisting event`);
            await persistUnacknowledgedEvent(userId, eventData);
        }, ACK_TIMEOUT_MS);

        socket_Instance
            .to(room)
            .emit(eventData.type, eventData.data, async (ack) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);

                console.log(`Acknowledgement received: ${ack}`);
                if (ack) {
                    console.log(`${eventData.type} acknowledged by ${userId}`);
                } else {
                    console.log(`${eventData.type} not acknowledged by ${userId}`);
                    await persistUnacknowledgedEvent(userId, eventData);
                }
            });
    } catch (error) {
        console.log(`Error while sending event: ${error}`);
        try {
            await persistUnacknowledgedEvent(userId, eventData);
        } catch (persistErr) {
            console.log(`Error persisting unacknowledged event: ${persistErr.message}`);
        }
    }
};

module.exports = {
    intilizeSocketFunc,
    sendEvent

}
