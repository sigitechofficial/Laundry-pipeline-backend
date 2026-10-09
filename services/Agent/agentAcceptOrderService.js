const {
    booking,
    addressDb,
    bookingHistory,
    proofOfDeliveries,
    sequelize,
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
            "customerId",
            "collectionDate",
            "collectionTimeFrom",
            "collectionTimeTo",
            "deliveryDate",
            "deliveryTimeFrom",
            "deliveryTimeTo",
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

    // A shop on marketplace hold may only take work an admin assigned to it.
    if (bookingRow.adminAssignedShopId == null) {
        const shopAssignmentPolicyService = require("../Admin/shopAssignmentPolicyService");
        const held = await shopAssignmentPolicyService.isMarketplaceHeld(
            shopOwnerUserId
        );
        if (held) {
            throw new ConflictError(
                "Your shop is on hold and cannot take new orders. Contact support."
            );
        }

        const customerShopExclusionService = require("../Admin/customerShopExclusionService");
        const customerExcluded =
            await customerShopExclusionService.isCustomerExcludedFromShop(
                bookingRow.customerId,
                shopAddress.id
            );
        if (customerExcluded) {
            throw new ConflictError(
                "This customer is excluded from your shop and cannot be accepted via marketplace."
            );
        }
    }

    // Slot capacity + claim in one transaction, with the shop row locked, so two
    // devices of the same shop cannot both take the last place in a slot.
    // Admin-assigned orders bypass capacity (admin decided).
    const {
        evaluateShopSlotCapacity,
        slotFullMessage,
        SLOT_FULL_CODE,
    } = require("../../utils/shopSlotCapacity");
    let slotRefusal = null;
    const affectedCount = await sequelize.transaction(async (transaction) => {
        if (bookingRow.adminAssignedShopId == null) {
            await addressDb.findByPk(shopAddress.id, {
                attributes: ["id"],
                lock: transaction.LOCK.UPDATE,
                transaction,
            });
            const slot = await evaluateShopSlotCapacity(
                shopOwnerUserId,
                shopAddress.id,
                bookingRow.get({ plain: true }),
                { excludeBookingId: bookingId, transaction }
            );
            if (!slot.allowed) {
                slotRefusal = slot;
                return 0;
            }
        }
        const [count] = await booking.update(
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
                transaction,
            }
        );
        return count;
    });

    if (slotRefusal) {
        const { getShopAcceptCapacityStatus } = require("../../utils/shopAcceptCapacity");
        const { notifyShopAcceptCapacity } = require("../../utils/shopAcceptCapacityNotify");
        const status = await getShopAcceptCapacityStatus(shopOwnerUserId).catch(() => null);
        const message = slotFullMessage(slotRefusal);
        notifyShopAcceptCapacity(shopOwnerUserId, {
            capacity: status,
            message,
            reachedToast: true,
        });
        throw new ConflictError(message, {
            code: SLOT_FULL_CODE,
            capacity: status,
            slot: slotRefusal,
        });
    }

    if (!affectedCount) {
        throw new ConflictError("This order was already taken");
    }

    try {
        const shopAssignmentAuditService = require("../Admin/shopAssignmentAuditService");
        await shopAssignmentAuditService.recordShopAssignment({
            bookingId,
            fromShopId: null,
            toShopId: shopAddress.id,
            actedByUserId: shopOwnerUserId,
            source: "agent_accept",
            note: "Shop accepted marketplace order",
        });
    } catch (auditErr) {
        console.warn(
            "[acceptOrder] shop audit skipped:",
            auditErr?.message || auditErr
        );
    }

    try {
        const { lockBookingRateSnapshot } = require("../../utils/bookingRateSnapshot");
        await lockBookingRateSnapshot(bookingId, { source: "accepted" });
    } catch (snapErr) {
        console.error(
            "[acceptOrder] rate snapshot lock failed:",
            snapErr.message
        );
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

    // Live banner + admin snapshot: history row must exist before we count.
    let capacity = null;
    try {
        const { getShopAcceptCapacityStatus } = require("../../utils/shopAcceptCapacity");
        const { notifyShopAcceptCapacity } = require("../../utils/shopAcceptCapacityNotify");
        capacity = await getShopAcceptCapacityStatus(shopOwnerUserId);
        notifyShopAcceptCapacity(shopOwnerUserId, { capacity });
    } catch (capErr) {
        console.warn(
            "[acceptOrder] accept capacity notify skipped:",
            capErr?.message || capErr
        );
    }

    await agentBookingDeclineService.clearDeclinesForBooking(bookingId);

    await notifyBookingTakenByAgent({
        bookingId,
        zoneId: bookingRow.zoneId,
        assignedUserId: shopOwnerUserId,
        source: "agent",
        // Hard-exclude acceptor so they never get "accepted by another agent".
        excludeUserIds: [shopOwnerUserId, agentUserId],
    });

    // Auto-assign after accept — must not fail the accept itself
    try {
        const autoAssignService = require("./autoAssignService");
        await autoAssignService.tryAutoAssignAfterAccept({
            shopAgentId: shopOwnerUserId,
            bookingId: Number(bookingId),
            actedByUserId: Number(agentUserId),
        });
    } catch (autoErr) {
        console.error(
            "[acceptOrder] auto-assign after accept failed:",
            autoErr.message
        );
    }

    return {
        bookingId: Number(bookingId),
        laundryShopId: shopAddress.id,
        bookingStatusId: 3,
        ...(capacity ? { capacity } : {}),
    };
}

module.exports = {
    acceptOrderForAgent,
};
