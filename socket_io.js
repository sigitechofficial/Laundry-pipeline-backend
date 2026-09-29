require('dotenv').config()
const { Server } = require('socket.io')
const agentBookingDeclineService = require('./services/Agent/agentBookingDeclineService');
const { notifyBookingTakenByAgent } = require('./utils/bookingTakenNotify');
const { triggerHeldReleaseForAgent } = require('./utils/triggerHeldReleaseForAgent');
const {
    resolveSocketAuthMode,
    parseSocketPayload,
    createSocketTokenVerifier,
    authorizeRoomJoin,
    resolveSocketActorId,
} = require('./utils/socketAuth');
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

const verifySocketAccessToken = createSocketTokenVerifier();

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

        const sockets = await socket_Instance.in(row.to).fetchSockets();
        if (!sockets.length) {
            console.log(`⚠️ Replay ${eventType}: no sockets in room ${row.to}`);
            continue;
        }

        let anyAcked = false;
        await Promise.all(
            sockets.map(
                (sock) =>
                    new Promise((resolve) => {
                        let done = false;
                        const finish = (acked) => {
                            if (done) return;
                            done = true;
                            if (acked) anyAcked = true;
                            resolve();
                        };
                        const timer = setTimeout(() => finish(false), ACK_TIMEOUT_MS);
                        try {
                            sock.emit(eventType, payload, (ack) => {
                                clearTimeout(timer);
                                finish(Boolean(ack));
                            });
                        } catch (_) {
                            clearTimeout(timer);
                            finish(false);
                        }
                    })
            )
        );

        if (anyAcked) {
            console.log(`✅ Event acknowledged by ${row.to}`);
            await unAcknowledgedEvents.destroy({ where: { id: row.id } });
        } else {
            console.log(`⚠️ Event not acknowledged by ${row.to}`);
        }
    }

    return rows.length;
}

const intilizeSocketFunc = (server) => {
    // Previous values (pingTimeout 1000 / pingInterval 500) dropped agent
    // sockets constantly — first newBookingRequest was often missed and only
    // appeared after a later reconnect / second order refresh.
    const io = new Server(server, {
        pingTimeout: 20000,
        pingInterval: 10000,
    });
    socket_Instance = io
    io.on("connection", (socket) => {
        console.log(`User Connected ${socket.id}`);

        // Join only the room of the user the access token belongs to
        // (token-less legacy joins allowed while SOCKET_AUTH_MODE=optional).
        const joinOwnRoom = async (data) => {
            const mode = resolveSocketAuthMode();
            const result = await authorizeRoomJoin({
                payload: data,
                handshake: socket.handshake,
                mode,
                verifyToken: verifySocketAccessToken,
            });
            if (!result.ok) return result;

            // Account switch on a live socket: stop receiving the previous user's events.
            const previousRoom = socket.data.userId != null ? String(socket.data.userId) : null;
            if (previousRoom && previousRoom !== result.roomId) {
                socket.leave(previousRoom);
            }
            socket.join(result.roomId);
            socket.data.userId = result.roomId;
            socket.data.authenticated = result.authenticated;

            if (!result.authenticated) {
                console.warn(`[socketAuth] legacy token-less join socket=${socket.id} room=${result.roomId} mode=${mode}`);
            }
            return result;
        };

        //Event when User Connects
        socket.on("joinRoom", async (message) => {
            try {
                const data = parseSocketPayload(message);
                // Never log the raw payload — it carries the access token.
                console.log("🚀 ~ joinRoom ~ userId:", data.userId, "userTypeId:", data.userTypeId)

                const joined = await joinOwnRoom(data);
                if (!joined.ok) {
                    console.error(`❌ joinRoom refused (${joined.code}) socket=${socket.id} userId=${data.userId}`);
                    socket.emit('error', {
                        message: joined.message,
                        code: joined.code
                    });
                    return;
                }

                const userId = joined.roomId
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
                const data = parseSocketPayload(message)
                console.log('🚀 ~ RECONNECT ROOM JOIN:', data.userId)

                const joined = await joinOwnRoom(data);
                if (!joined.ok) {
                    console.error(`❌ re-connect refused (${joined.code}) socket=${socket.id} userId=${data.userId}`);
                    socket.emit('error', {
                        message: joined.message,
                        code: joined.code
                    });
                    return;
                }

                const userId = joined.roomId
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
                const bookingDetails = parseSocketPayload(bookingData);
                const bookingId = bookingDetails.id;

                // Authenticated sockets accept only as themselves (payload agentId is not trusted).
                const actor = resolveSocketActorId({
                    socketData: socket.data,
                    requestedUserId: bookingDetails.agentId,
                    mode: resolveSocketAuthMode(),
                });
                if (!actor.ok) {
                    console.error(`❌ agentAcceptOrder refused (${actor.code}) socket=${socket.id} agentId=${bookingDetails.agentId}`);
                    socket.emit('error', {
                        message: actor.message,
                        code: actor.code
                    });
                    return;
                }
                const agentId = actor.userId;

                const { acceptOrderForAgent } = require('./services/Agent/agentAcceptOrderService');

                try {
                    await acceptOrderForAgent(agentId, bookingId);
                } catch (acceptError) {
                    const message =
                        acceptError.message || 'This order was already taken';
                    // Capacity-full must not look like "taken": the order is still open.
                    const capacityFull = acceptError.errorCode === 'SHOP_ACCEPT_CAP_REACHED';
                    await sendEvent(agentId, {
                        type: capacityFull ? 'shopAcceptCapReached' : 'orderTakenByOtherAgent',
                        data: {
                            bookingId: Number(bookingId),
                            message,
                            ...(capacityFull ? { capacity: acceptError.details?.capacity } : {}),
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

        // IMPORTANT: Socket.IO does NOT support acknowledgements when broadcasting
        // (`io.to(room).emit(..., ack)`). Ack never fires → every event was also
        // persisted and racey on replay. Emit per connected socket instead.
        let anyAcked = false;
        let settledCount = 0;
        const total = sockets.length;

        await Promise.all(
            sockets.map(
                (sock) =>
                    new Promise((resolve) => {
                        let done = false;
                        const finish = (acked) => {
                            if (done) return;
                            done = true;
                            settledCount += 1;
                            if (acked) anyAcked = true;
                            resolve();
                        };

                        const timer = setTimeout(() => finish(false), ACK_TIMEOUT_MS);

                        try {
                            sock.emit(eventData.type, eventData.data, (ack) => {
                                clearTimeout(timer);
                                finish(Boolean(ack));
                            });
                        } catch (emitErr) {
                            clearTimeout(timer);
                            console.log(
                                `Error emitting ${eventData.type} to socket ${sock.id}:`,
                                emitErr?.message || emitErr
                            );
                            finish(false);
                        }
                    })
            )
        );

        if (!anyAcked) {
            console.log(
                `${eventData.type} not acknowledged by any socket in ${room} ` +
                    `(${settledCount}/${total}), persisting event`
            );
            await persistUnacknowledgedEvent(userId, eventData);
        } else {
            console.log(
                `${eventData.type} acknowledged by at least one socket in ${room}`
            );
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
