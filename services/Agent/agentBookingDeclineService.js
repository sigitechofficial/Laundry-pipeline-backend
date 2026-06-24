const { booking, bookingAgentDecline, addressDb } = require('../../models');
const { Op } = require('sequelize');
const {
    ValidationError,
    NotFoundError,
    ConflictError,
} = require('../../middlewares/universalErrorHandler');
const {
    isBookingAcceptWindowOpen,
} = require('../../utils/bookingTimeZone');
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
            attributes: ['bookingId'],
        });

        rows.forEach((row) => {
            const id = Number(row.bookingId);
            map.set(id, (map.get(id) || 0) + 1);
        });
        return map;
    }

    async clearDeclinesForBooking(bookingId) {
        await bookingAgentDecline.destroy({ where: { bookingId } });
    }

    async rejectBooking(agentUserId, bookingId) {
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

        const acceptWindowStart =
            bookingRow.adminAssignedShopId != null
                ? bookingRow.agentVisibleAt || bookingRow.createdAt
                : bookingRow.createdAt;

        const countryCtx = await getCountryContextFromZoneId(bookingRow.zoneId);
        if (
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
            return {
                bookingId: Number(bookingId),
                alreadyDeclined: true,
            };
        }

        await bookingAgentDecline.create({
            bookingId,
            agentUserId,
        });

        return {
            bookingId: Number(bookingId),
            alreadyDeclined: false,
        };
    }
}

module.exports = new AgentBookingDeclineService();
