const {
    booking,
    addressDb,
    bookingHistory,
    proofOfDeliveries,
} = require("../../models");
const { Op } = require("sequelize");
const {
    ValidationError,
    NotFoundError,
    ConflictError,
} = require("../../middlewares/universalErrorHandler");
const { notifyBookingTakenByAgent } = require("../../utils/bookingTakenNotify");
const agentBookingDeclineService = require("./agentBookingDeclineService");

/**
 * Shared accept logic for REST and socket.
 * @param {number} agentUserId - Shop owner user id
 * @param {number} bookingId
 * @param {{ timeZone?: string, clientTimeZone?: string }} [options]
 */
async function acceptOrderForAgent(agentUserId, bookingId, options = {}) {
    const shopAddress = await addressDb.findOne({
        where: {
            userId: agentUserId,
            addressType: "LaundaryShopAddress",
        },
        attributes: ["id", "zoneId", "userId"],
    });

    if (!shopAddress) {
        throw new NotFoundError("Agent shop address not found");
    }

    // Prefer shop owner id for socket room notifications (must match zone owner list).
    const shopOwnerUserId = Number(shopAddress.userId) || Number(agentUserId);

    const bookingRow = await booking.findByPk(bookingId, {
        attributes: [
            "id",
            "zoneId",
            "laundryShopId",
            "bookingStatusId",
            "adminAssignedShopId",
        ],
    });

    if (!bookingRow) {
        throw new NotFoundError("Booking not found");
    }

    if (Number(bookingRow.bookingStatusId) !== 1) {
        throw new ConflictError("This order is not available to accept");
    }

    if (bookingRow.laundryShopId != null && bookingRow.laundryShopId !== "") {
        throw new ConflictError("This order was already taken");
    }

    if (Number(bookingRow.zoneId) !== Number(shopAddress.zoneId)) {
        throw new ValidationError("This order is not in your zone");
    }

    if (
        bookingRow.adminAssignedShopId != null &&
        Number(bookingRow.adminAssignedShopId) !== Number(shopAddress.id)
    ) {
        throw new ConflictError(
            "This order is assigned to another shop by admin"
        );
    }

    const [affectedCount] = await booking.update(
        {
            bookingStatusId: 3,
            laundryShopId: shopAddress.id,
            adminAssignedShopId: null,
            driverId: agentUserId,
        },
        {
            where: {
                id: bookingId,
                laundryShopId: null,
                bookingStatusId: 1,
            },
        }
    );

    if (!affectedCount) {
        throw new ConflictError("This order was already taken");
    }

    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];
    const timeStr = now.toTimeString().slice(0, 8);

    await bookingHistory.bulkCreate(
        [2, 3].map((statusId) => ({
            bookingId,
            bookingStatusId: statusId,
            date: dateStr,
            time: timeStr,
        }))
    );

    await agentBookingDeclineService.clearDeclinesForBooking(bookingId);

    await notifyBookingTakenByAgent({
        bookingId,
        zoneId: bookingRow.zoneId,
        assignedUserId: shopOwnerUserId,
        source: "agent",
        // Hard-exclude acceptor so they never get "accepted by another agent".
        excludeUserIds: [shopOwnerUserId, agentUserId],
    });

    return {
        bookingId: Number(bookingId),
        laundryShopId: shopAddress.id,
        bookingStatusId: 3,
    };
}

module.exports = {
    acceptOrderForAgent,
};
