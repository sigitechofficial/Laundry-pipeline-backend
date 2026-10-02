require('dotenv').config()
const { Server } = require('socket.io')
const agentBookingDeclineService = require('./services/Agent/agentBookingDeclineService');
const { notifyBookingTakenByAgent } = require('./utils/bookingTakenNotify');
const { triggerHeldReleaseForAgent } = require('./utils/triggerHeldReleaseForAgent');
const {
    extractQueuedBookingId,
    shouldDropQueuedNewBooking,
    isQueuedEventExpired,
} = require('./utils/unacknowledgedEventQueue');
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
    const bookingId = extractQueuedBookingId(eventData?.data);
    const to = userId.toString();
    const event = eventData.type;

    if (bookingId != null) {
        const existing = await unAcknowledgedEvents.findOne({
            where: { to, event, bookingId: Number(bookingId) },
        });
        if (existing) return;
    }

    await unAcknowledgedEvents.create({
        to,
        event,
        data: JSON.stringify(eventData.data),
        bookingId: bookingId != null ? Number(bookingId) : null,
    });
}

/**
 * Socket.IO does not support acknowledgements on room broadcasts
 * (`io.to(room).emit(..., ack)`), so emit to each socket and resolve true
 * when at least one of them acks within ACK_TIMEOUT_MS.
 */
async function emitWithAckToRoom(room, eventType, payload) {
    const sockets = await socket_Instance.in(room).fetchSockets();
    if (!sockets.length) return { delivered: false, socketCount: 0 };

    const results = await Promise.all(
        sockets.map(
            (sock) =>
                new Promise((resolve) => {
                    const timer = setTimeout(() => resolve(false), ACK_TIMEOUT_MS);
                    try {
                        sock.emit(eventType, payload, (ack) => {
                            clearTimeout(timer);
                            resolve(Boolean(ack));
                        });
                    } catch (_) {
                        clearTimeout(timer);
                        resolve(false);
                    }
                })
        )
    );
    return { delivered: results.some(Boolean), socketCount: sockets.length };
}

async function replayUnacknowledgedEvents(userId) {
    const rows = await unAcknowledgedEvents.findAll({
        where: { to: userId.toString() },
        order: [['id', 'ASC']],
    });

    for (const row of rows) {
        const eventType = resolveStoredEventType(row);
        if (!eventType || !row.data) {
            console.warn(`⚠️ Skipping malformed unAcknowledgedEvent id=${row.id}`);
            await row.destroy().catch(() => {});
            continue;
        }

        if (isQueuedEventExpired(row.createdAt)) {
            console.log(`🗑 Dropping expired queued ${eventType} id=${row.id}`);
            await row.destroy().catch(() => {});
            continue;
        }

        let payload;
        try {
            payload = JSON.parse(row.data);
        } catch (parseErr) {
            console.warn(`⚠️ Invalid unAcknowledgedEvent data id=${row.id}:`, parseErr.message);
            await row.destroy().catch(() => {});
            continue;
        }

        if (eventType === 'newBookingRequest') {
            const bookingId = extractQueuedBookingId(payload);
            const bookingRow = bookingId
                ? await booking.findByPk(bookingId, {
                    attributes: ['id', 'bookingStatusId', 'laundryShopId', 'createdAt'],
                })
                : null;
            if (shouldDropQueuedNewBooking(bookingRow)) {
                console.log(
                    `🗑 Dropping stale queued newBookingRequest booking=${bookingId} id=${row.id}`
                );
                await row.destroy().catch(() => {});
                continue;
            }
        }

        const { delivered } = await emitWithAckToRoom(row.to, eventType, payload);
        if (delivered) {
            console.log(`✅ Event acknowledged by ${row.to}`);
            await unAcknowledgedEvents.destroy({ where: { id: row.id } });
        } else {
            console.log(`⚠️ Event not acknowledged by ${row.to}`);
        }
    }

    return rows.length;
}

const intilizeSocketFunc = (server) => {
    // 1s/0.5s ping dropped mobile agent sockets constantly, so the first
    // newBookingRequest was often missed.
    const io = new Server(server, {
        pingTimeout: 20000,
        pingInterval: 10000,
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
                // Cold joinRoom must replay the queue too, or an order placed while the
                // agent was offline stays invisible until a later refresh.
                await triggerHeldReleaseForAgent(userId).catch((err) => {
                    console.error('[joinRoom] held release error:', err.message);
                });
                const pendingEvents = await replayUnacknowledgedEvents(userId);

                // Confirm to client
                socket.emit('roomJoined', {
                    userId: userId,
                    message: 'Successfully joined room',
                    pendingEvents,
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
        const { delivered, socketCount } = await emitWithAckToRoom(
            room,
            eventData.type,
            eventData.data
        );

        if (!socketCount) {
            console.log(`${eventData.type} — no socket in room ${room}, persisting event`);
            await persistUnacknowledgedEvent(userId, eventData);
            return;
        }

        if (delivered) {
            console.log(`${eventData.type} acknowledged by ${userId}`);
        } else {
            console.log(`${eventData.type} not acknowledged by ${userId} (${socketCount} socket(s)), persisting event`);
            await persistUnacknowledgedEvent(userId, eventData);
        }
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
