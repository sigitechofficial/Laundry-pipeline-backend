const { booking, bookingAgentDecline, addressDb } = require('../../models');
const { Op, fn, col } = require('sequelize');
const {
    ValidationError,
    NotFoundError,
    ConflictError,
} = require('../../middlewares/universalErrorHandler');
const {
    isBookingAcceptWindowOpen,
} = require('../../utils/bookingTimeZone');
const { getBookingVisibleAt, getAcceptWindowAnchor } = require('../../utils/bookingAgentWindow');
const { getCountryContextFromZoneId } = require('../../utils/countryTimeZone');

class AgentBookingDeclineService {
    async getDeclinedBookingIdsForAgent(agentUserId) {
        const rows = await bookingAgentDecline.findAll({
            where: { agentUserId },
            attributes: ['bookingId'],
        });
        return rows.map((row) => row.bookingId);
    }

    async hasAnyDecline(bookingId) {
        const count = await bookingAgentDecline.count({
            where: { bookingId },
        });
        return count > 0;
    }

    async getDeclineCountByBookingIds(bookingIds) {
        const map = new Map();
        if (!bookingIds?.length) return map;

        const rows = await bookingAgentDecline.findAll({
            where: { bookingId: { [Op.in]: bookingIds } },
            attributes: [
                'bookingId',
                [fn('COUNT', col('id')), 'declineCount'],
            ],
            group: ['bookingId'],
            raw: true,
        });

        rows.forEach((row) => {
            const id = Number(row.bookingId);
            map.set(id, Number(row.declineCount) || 0);
        });
        return map;
    }

    async clearDeclinesForBooking(bookingId) {
        await bookingAgentDecline.destroy({ where: { bookingId } });
    }

    /**
     * Declines for one booking with the agent identity + reason, newest first.
     * Used by the admin order view so admins can see why shops declined.
     */
    async listDeclinesForBooking(bookingId) {
        const { users } = require('../../models');
        const rows = await bookingAgentDecline.findAll({
            where: { bookingId },
            attributes: ['id', 'agentUserId', 'reason', 'createdAt'],
            include: [
                {
                    model: users,
                    as: 'agent',
                    attributes: ['id', 'firstName', 'lastName'],
                    required: false,
                },
            ],
            order: [['createdAt', 'DESC'], ['id', 'DESC']],
        });
        return rows.map((row) => {
            const plain = row.get ? row.get({ plain: true }) : row;
            const name = [plain.agent?.firstName, plain.agent?.lastName]
                .filter(Boolean)
                .join(' ')
                .trim();
            return {
                id: plain.id,
                agentUserId: plain.agentUserId,
                agentName: name || null,
                reason: plain.reason || null,
                createdAt: plain.createdAt,
            };
        });
    }

    async rejectBooking(agentUserId, bookingId, reason) {
        const cleanReason = String(reason || '').trim();
        if (!cleanReason) {
            throw new ValidationError('A reason is required to decline an order');
        }
        if (cleanReason.length > 500) {
            throw new ValidationError('Reason must be 500 characters or less');
        }
        const bookingRow = await booking.findByPk(bookingId, {
            attributes: [
                'id',
                'bookingStatusId',
                'laundryShopId',
                'adminAssignedShopId',
                'zoneId',
                'createdAt',
                'agentVisibleAt',
                'orderExpireTime',
                'placedOutsidePlatformHours',
                'preferredShopAgentId',
                'preferredShopBroadcastDone',
            ],
        });

        if (!bookingRow) {
            throw new NotFoundError('Booking not found');
        }

        if (Number(bookingRow.bookingStatusId) !== 1) {
            throw new ValidationError('Only pending unassigned bookings can be rejected');
        }

        if (bookingRow.laundryShopId != null && bookingRow.laundryShopId !== '') {
            throw new ConflictError('Booking is already assigned to a shop');
        }

        const agentShop = await addressDb.findOne({
            where: {
                userId: agentUserId,
                addressType: 'LaundaryShopAddress',
            },
            attributes: ['id', 'zoneId'],
        });

        if (!agentShop) {
            throw new NotFoundError('Agent shop address not found');
        }

        if (Number(agentShop.zoneId) !== Number(bookingRow.zoneId)) {
            throw new ValidationError('This booking is not in your zone');
        }

        if (
            bookingRow.adminAssignedShopId != null &&
            Number(bookingRow.adminAssignedShopId) !== Number(agentShop.id)
        ) {
            throw new ValidationError(
                'This booking is assigned to another shop by admin'
            );
        }

        const acceptWindowStart = getAcceptWindowAnchor(bookingRow);

        const countryCtx = await getCountryContextFromZoneId(bookingRow.zoneId);
        if (
            !bookingRow.orderExpireTime ||
            !isBookingAcceptWindowOpen(
                acceptWindowStart,
                bookingRow.orderExpireTime,
                countryCtx.ianaTimeZone
            )
        ) {
            throw new ValidationError('Accept window has expired for this booking');
        }

        const existing = await bookingAgentDecline.findOne({
            where: { bookingId, agentUserId },
        });

        if (existing) {
            // Keep the latest reason if the agent re-submits.
            if (existing.reason !== cleanReason) {
                await existing.update({ reason: cleanReason });
            }
            return {
                bookingId: Number(bookingId),
                alreadyDeclined: true,
            };
        }

        await bookingAgentDecline.create({
            bookingId,
            agentUserId,
            reason: cleanReason,
        });

        // If the preferred shop just declined, immediately open to all shops (Phase 2)
        if (
            !bookingRow.preferredShopBroadcastDone &&
            bookingRow.preferredShopAgentId != null &&
            Number(bookingRow.preferredShopAgentId) === Number(agentUserId)
        ) {
            try {
                const {
                    broadcastBookingToShops,
                } = require('../bookingHeldReleaseService');
                await booking.update(
                    { preferredShopBroadcastDone: true },
                    { where: { id: bookingId } }
                );
                const { notifiedCount } = await broadcastBookingToShops(bookingId);
                console.log(
                    `[decline] booking ${bookingId} preferred shop declined → broadcast to ${notifiedCount} agent(s)`
                );
            } catch (broadcastErr) {
                // Non-fatal: cron will pick it up within 5 minutes
                console.error('[decline] Phase-2 broadcast failed, cron will retry:', broadcastErr.message);
            }
        }

        return {
            bookingId: Number(bookingId),
            alreadyDeclined: false,
        };
    }
}

module.exports = new AgentBookingDeclineService();
