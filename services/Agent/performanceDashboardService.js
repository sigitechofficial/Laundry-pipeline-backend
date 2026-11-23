'use strict';

const { Op } = require('sequelize');
const dbModels = require('../../models');
const { users, addressDb } = dbModels;
const { NotFoundError } = require('../../middlewares/universalErrorHandler');
const { CANCELLED, REFUNDED } = require('../../constants/bookingStatusIds');
const { SYSTEM_ROLES } = require('../../constants/systemRoles');
const { requireShopTimeZone } = require('../../utils/countryTimeZone');
const { resolveShopDayRange } = require('../../utils/shopDayRange');
const { zoneCurrency } = require('../../utils/zoneCurrency');
const {
    percentChange,
    money,
    summarizeLegs,
    buildCommissionSummary,
} = require('../../utils/performanceDashboard');

const SELECT = { type: dbModels.Sequelize.QueryTypes.SELECT };

/*
 * One row per leg COMPLETED in [from, to): the leg's own completion instant
 * (pickupCompletedAt / deliveryCompletedAt, frozen by utils/legCompletion.js),
 * never the order's createdAt or its booked day. The person is the one who
 * completed it, else the assigned driver for rows completed before the
 * snapshot existed. arrivedAt = the driver's arrival at the door on the
 * successful attempt (booking_attempts, completed or unattended).
 * The slot day/time are formatted in SQL so no JS Date/zone conversion can
 * shift them; they are wall clock in booking.operationalTimeZone.
 */
function legSelect(kind) {
    const isPickup = kind === 'pickup';
    const completedAt = isPickup ? 'b.pickupCompletedAt' : 'b.deliveryCompletedAt';
    const person = isPickup
        ? 'COALESCE(b.pickupCompletedByUserId, b.driverId)'
        : 'COALESCE(b.deliveryCompletedByUserId, b.deliveryDriverId)';
    const day = isPickup ? 'b.collectionDate' : 'b.deliveryDate';
    const from = isPickup ? 'b.collectionTimeFrom' : 'b.deliveryTimeFrom';
    const to = isPickup ? 'b.collectionTimeTo' : 'b.deliveryTimeTo';
    return `
        SELECT '${kind}' AS kind,
               b.id AS bookingId,
               ${person} AS userId,
               DATE_FORMAT(${day}, '%Y-%m-%d') AS slotDay,
               TIME_FORMAT(${from}, '%H:%i:%s') AS slotFrom,
               TIME_FORMAT(${to}, '%H:%i:%s') AS slotTo,
               b.operationalTimeZone AS slotTimeZone,
               (SELECT a.arrivedAt FROM booking_attempts a
                 WHERE a.bookingId = b.id AND a.attemptType = '${kind}'
                   AND a.status IN ('completed', 'unattended')
                 ORDER BY a.attemptNumber DESC, a.id DESC LIMIT 1) AS arrivedAt
          FROM bookings b
         WHERE b.laundryShopId = :shopId AND b.deletedAt IS NULL
           AND ${completedAt} >= :from AND ${completedAt} < :to`;
}

/*
 * The shop's paid orders placed in [from, to) — the same order set and date
 * basis as the shop's Earning Report (getEarningReportDashboard), so both
 * screens show the same earnings for the same days. Cancelled and refunded
 * orders are excluded; a partial refund already lowers agentEarning.
 */
const PAID_ORDERS_WHERE = `
      FROM bookings b
      JOIN billingDetails bd ON bd.bookingId = b.id
     WHERE b.laundryShopId = :shopId AND b.deletedAt IS NULL
       AND b.bookingStatusId NOT IN (${CANCELLED}, ${REFUNDED})
       AND bd.paymentStatus = 'Paid'
       AND b.createdAt >= :from AND b.createdAt < :to`;

class PerformanceDashboardService {
    async _paidOrderTotals(shopId, from, to) {
        const [row] = await dbModels.sequelize.query(
            `SELECT COUNT(*) AS orders,
                    COALESCE(SUM(bd.agentEarning), 0) AS shopEarning,
                    COALESCE(SUM(bd.zoneAdminCommission), 0) AS platformCommission,
                    COALESCE(SUM(bd.serviceCharge), 0) AS platformServiceFees
             ${PAID_ORDERS_WHERE}`,
            { ...SELECT, replacements: { shopId, from, to } }
        );
        return row;
    }

    async _paidOrderRates(shopId, from, to) {
        return dbModels.sequelize.query(
            `SELECT b.appliedAgentCommissionPercent AS shopPercent,
                    b.appliedPlatformCommissionPercent AS platformPercent,
                    COUNT(*) AS orders
             ${PAID_ORDERS_WHERE}
             GROUP BY b.appliedAgentCommissionPercent, b.appliedPlatformCommissionPercent`,
            { ...SELECT, replacements: { shopId, from, to } }
        );
    }

    async _completedLegs(shopId, from, to) {
        return dbModels.sequelize.query(
            `${legSelect('pickup')}
             UNION ALL
             ${legSelect('delivery')}`,
            { ...SELECT, replacements: { shopId, from, to } }
        );
    }

    /**
     * @param {number} shopOwnerId the shop owner (req.shopAgentId: an employee's employeeOff)
     * @param {{ startDate?: string, endDate?: string }} query shop-local YYYY-MM-DD days
     */
    async getPerformanceDashboard(shopOwnerId, query = {}) {
        const shopAddress = await addressDb.findOne({
            where: { userId: shopOwnerId, addressType: 'LaundaryShopAddress' },
            attributes: ['id', 'zoneId', 'countryId'],
        });
        if (!shopAddress) {
            throw new NotFoundError('Agent shop address not found');
        }

        const timeZone = await requireShopTimeZone(shopAddress);
        const range = resolveShopDayRange(query, timeZone);
        const shopId = shopAddress.id;

        const [currency, legs, current, previous, rates, team] = await Promise.all([
            zoneCurrency(shopAddress.zoneId),
            this._completedLegs(shopId, range.from, range.to),
            this._paidOrderTotals(shopId, range.from, range.to),
            this._paidOrderTotals(shopId, range.previous.from, range.previous.to),
            this._paidOrderRates(shopId, range.from, range.to),
            // Former staff still count as the shop's own for legs they did.
            users.findAll({
                where: { employeeOff: shopOwnerId },
                attributes: ['id', 'firstName', 'lastName', 'roleId', 'deletedAt'],
                paranoid: false,
                raw: true,
            }),
        ]);

        const teamIds = new Set(team.map((u) => Number(u.id)));
        const outsiderIds = [
            ...new Set(
                legs
                    .map((l) => (l.userId == null ? null : Number(l.userId)))
                    .filter((id) => id != null && !teamIds.has(id))
            ),
        ];
        const outsiders = outsiderIds.length
            ? await users.findAll({
                  where: { id: { [Op.in]: outsiderIds } },
                  attributes: ['id', 'firstName', 'lastName'],
                  paranoid: false,
                  raw: true,
              })
            : [];
        const people = new Map(
            [...team, ...outsiders].map((u) => [
                Number(u.id),
                { firstName: u.firstName, lastName: u.lastName },
            ])
        );

        const summary = summarizeLegs({
            legs,
            ownerId: Number(shopOwnerId),
            employeeIds: teamIds,
            people,
            rosterDriverIds: team
                .filter((u) => Number(u.roleId) === SYSTEM_ROLES.LAUNDRY_SHOP_DRIVER && !u.deletedAt)
                .map((u) => Number(u.id)),
        });

        const earnings = money(current.shopEarning);
        const previousEarnings = money(previous.shopEarning);

        return {
            currency: { code: currency.currencyCode, symbol: currency.currencySymbol },
            todaySummary: {
                pickups: summary.pickups,
                deliveries: summary.deliveries,
                paidOrders: Number(current.orders) || 0,
                earnings,
                previousEarnings,
                earningsComparison: percentChange(earnings, previousEarnings),
                range: {
                    startDate: range.startDate,
                    endDate: range.endDate,
                    days: range.days,
                    timeZone: range.timeZone,
                },
                previousRange: {
                    startDate: range.previous.startDate,
                    endDate: range.previous.endDate,
                },
            },
            deliveryTypeSplit: summary.deliveryTypeSplit,
            driverPerformance: summary.driverPerformance,
            commissionSummary: buildCommissionSummary(current, rates),
        };
    }
}

module.exports = new PerformanceDashboardService();
