'use strict';

/**
 * The shop app's Reports (Order summary, Shop performance, Earning report).
 *
 * Every report is computed in the shop's own time zone (calendar days, weeks,
 * months of the shop, never the server's), for the caller's shop (staff act for
 * their owner's shop), with statuses matched by id (titles are display text) and
 * money in the shop zone's currency. Nothing is estimated: a figure the data
 * cannot support is null, not a stand-in.
 */
const dbModels = require('../../models');
const { addressDb, bussinessInformation } = dbModels;
const { NotFoundError } = require('../../middlewares/universalErrorHandler');
const {
    COMPLETED,
    ISSUE_RESOLVED,
    CANCELLED,
    REFUNDED,
    ON_HOLD,
} = require('../../constants/bookingStatusIds');
const { requireShopTimeZone } = require('../../utils/countryTimeZone');
const { resolveShopReportPeriod, reportTrendBuckets } = require('../../utils/shopDayRange');
const { zoneCurrency } = require('../../utils/zoneCurrency');
const { classifyArrivalInZone } = require('../../utils/bookingPunctuality');
const {
    percentChange,
    money,
    emptyPunctuality,
    addArrival,
    finalizePunctuality,
} = require('../../utils/performanceDashboard');
const performanceDashboardService = require('./performanceDashboardService');

const SELECT = { type: dbModels.Sequelize.QueryTypes.SELECT };

/** Finished successfully (an issue resolved after completion is still finished). */
const DONE = [COMPLETED, ISSUE_RESOLVED];
const NOT_LIVE = [...DONE, CANCELLED, REFUNDED];

function pct(count, total) {
    return total ? Math.round((count / total) * 1000) / 10 : 0;
}

/**
 * Order-status buckets for orders placed in a range. Each order is in exactly
 * one bucket, so the buckets add up to the total.
 * @param {Array<{ bookingStatusId: number }>} orders
 */
function statusBuckets(orders) {
    const totals = { completed: 0, inProgress: 0, onHold: 0, cancelled: 0, refunded: 0 };
    for (const o of orders) {
        const id = Number(o.bookingStatusId);
        if (DONE.includes(id)) totals.completed += 1;
        else if (id === CANCELLED) totals.cancelled += 1;
        else if (id === REFUNDED) totals.refunded += 1;
        else if (ON_HOLD.includes(id)) totals.onHold += 1;
        else totals.inProgress += 1;
    }
    return totals;
}

/** Shop-level punctuality per leg kind from completed legs (see performanceDashboardService). */
function legPunctuality(legs) {
    const acc = { pickup: emptyPunctuality(), delivery: emptyPunctuality() };
    for (const leg of legs) {
        const target = acc[leg.kind];
        if (!target) continue;
        addArrival(
            target,
            classifyArrivalInZone(leg.arrivedAt, leg.slotDay, leg.slotFrom, leg.slotTo, leg.slotTimeZone)
        );
    }
    return { pickup: finalizePunctuality(acc.pickup), delivery: finalizePunctuality(acc.delivery) };
}

function rangeOut(range) {
    return {
        startDate: range.startDate,
        endDate: range.endDate,
        days: range.days,
        timeZone: range.timeZone,
    };
}

class ShopReportsService {
    /** The caller's shop, its time zone and its currency. */
    async _shop(shopOwnerId) {
        const shopAddress = await addressDb.findOne({
            where: { userId: shopOwnerId, addressType: 'LaundaryShopAddress' },
            attributes: ['id', 'zoneId', 'countryId'],
        });
        if (!shopAddress) throw new NotFoundError('Agent shop address not found');
        const [timeZone, currency] = await Promise.all([
            requireShopTimeZone(shopAddress),
            zoneCurrency(shopAddress.zoneId),
        ]);
        return {
            shopId: shopAddress.id,
            timeZone,
            currency: { code: currency.currencyCode, symbol: currency.currencySymbol },
        };
    }

    async _ordersPlaced(shopId, from, to) {
        return dbModels.sequelize.query(
            `SELECT b.id, b.bookingStatusId FROM bookings b
              WHERE b.laundryShopId = :shopId AND b.deletedAt IS NULL
                AND b.createdAt >= :from AND b.createdAt < :to`,
            { ...SELECT, replacements: { shopId, from, to } }
        );
    }

    /** Order summary: what happened to the orders placed in the period. */
    async getOrderSummary(shopOwnerId, period, query = {}) {
        const shop = await this._shop(shopOwnerId);
        const range = resolveShopReportPeriod(period, query, shop.timeZone);
        const orders = await this._ordersPlaced(shop.shopId, range.from, range.to);
        const totals = statusBuckets(orders);
        const totalOrders = orders.length;
        return {
            period,
            range: rangeOut(range),
            totalOrders,
            statusBreakdown: totals,
            distribution: Object.fromEntries(
                Object.entries(totals).map(([k, v]) => [k, pct(v, totalOrders)])
            ),
        };
    }

    /**
     * Shop performance over the period:
     * - performanceScore: % of the orders placed in the period that are completed;
     * - punctuality: drivers' arrival at the door vs the booked slot, over the
     *   pickups / deliveries completed in the period (null % when none measurable);
     * - averageTurnaroundHours: pickup completed -> delivery completed, over orders
     *   delivered in the period (null when none);
     * - rating: the customers' average star rating (null when no published review —
     *   no rating is derived from anything else).
     */
    async getShopPerformance(shopOwnerId, period, query = {}) {
        const shop = await this._shop(shopOwnerId);
        const range = resolveShopReportPeriod(period, query, shop.timeZone);
        const replacements = { shopId: shop.shopId, from: range.from, to: range.to };

        const [orders, legs, [turnaround], topServicesRaw, shopBiz] = await Promise.all([
            this._ordersPlaced(shop.shopId, range.from, range.to),
            performanceDashboardService.completedLegs(shop.shopId, range.from, range.to),
            dbModels.sequelize.query(
                `SELECT COUNT(*) AS orders,
                        AVG(TIMESTAMPDIFF(MINUTE, b.pickupCompletedAt, b.deliveryCompletedAt)) AS avgMinutes
                   FROM bookings b
                  WHERE b.laundryShopId = :shopId AND b.deletedAt IS NULL
                    AND b.pickupCompletedAt IS NOT NULL
                    AND b.deliveryCompletedAt >= :from AND b.deliveryCompletedAt < :to
                    AND b.deliveryCompletedAt >= b.pickupCompletedAt`,
                { ...SELECT, replacements }
            ),
            dbModels.sequelize.query(
                `SELECT css.serviceId, s.name, SUM(css.items) AS items
                   FROM customerSelectedServices css
                   JOIN bookings b ON b.id = css.bookingId
                   LEFT JOIN services s ON s.id = css.serviceId
                  WHERE b.laundryShopId = :shopId AND b.deletedAt IS NULL
                    AND b.createdAt >= :from AND b.createdAt < :to
                    AND b.bookingStatusId NOT IN (${CANCELLED}, ${REFUNDED})
                  GROUP BY css.serviceId, s.name
                 HAVING SUM(css.items) > 0
                  ORDER BY items DESC
                  LIMIT 3`,
                { ...SELECT, replacements }
            ),
            bussinessInformation.findOne({
                where: { shopAddressId: shop.shopId },
                attributes: ['id'],
            }),
        ]);

        const totals = statusBuckets(orders);
        const totalOrders = orders.length;
        const punctuality = legPunctuality(legs);

        let customerRating = {
            avgRating: null,
            publishedCount: 0,
            ratingCount: 0,
            histogram: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
            topPositiveReasonCode: null,
            topNegativeReasonCode: null,
            recentReviews: [],
        };
        if (shopBiz) {
            const shopReviewService = require('../Customer/shopReviewService');
            const reviewData = await shopReviewService.getShopReviews(shopBiz.id, { page: 1, limit: 10 });
            customerRating = { ...reviewData.summary, recentReviews: reviewData.reviews };
        }
        const rating = customerRating.publishedCount > 0 ? Number(customerRating.avgRating) : null;

        const serviceItems = topServicesRaw.reduce((sum, r) => sum + Number(r.items || 0), 0);
        const avgMinutes = turnaround?.avgMinutes == null ? null : Number(turnaround.avgMinutes);

        return {
            period,
            range: rangeOut(range),
            performanceScore: pct(totals.completed, totalOrders),
            punctuality: {
                onTimePickup: punctuality.pickup.onTimePercent,
                onTimeDelivery: punctuality.delivery.onTimePercent,
                pickup: punctuality.pickup,
                delivery: punctuality.delivery,
            },
            processingAndRating: {
                averageTurnaroundHours: avgMinutes == null ? null : Math.round(avgMinutes / 6) / 10,
                turnaroundOrders: Number(turnaround?.orders) || 0,
                rating,
                customerRating,
            },
            totals: {
                totalOrders,
                completedOrders: totals.completed,
                inProgressOrders: totalOrders - orders.filter((o) => NOT_LIVE.includes(Number(o.bookingStatusId))).length,
                cancelledOrders: totals.cancelled,
                refundedOrders: totals.refunded,
            },
            topServices: topServicesRaw.map((r, i) => ({
                rank: i + 1,
                serviceId: r.serviceId,
                name: r.name,
                items: Number(r.items || 0),
                percentage: pct(Number(r.items || 0), serviceItems),
            })),
        };
    }

    /**
     * Earning report: the shop's own earning (agentEarning) on its paid orders
     * placed in the period — not cancelled or refunded (a partial refund already
     * lowers agentEarning) — vs the same number of days just before.
     */
    async getEarningReport(shopOwnerId, period, query = {}) {
        const shop = await this._shop(shopOwnerId);
        const range = resolveShopReportPeriod(period, query, shop.timeZone);
        const buckets = reportTrendBuckets(period, range, shop.timeZone);

        const paidOrders = (from, to) =>
            dbModels.sequelize.query(
                `SELECT b.id, b.createdAt,
                        COALESCE(bd.agentEarning, 0) AS earning,
                        COALESCE(bd.total, 0) AS total,
                        (SELECT COALESCE(SUM(t.amount), 0) FROM tips t WHERE t.bookingId = b.id) AS tips
                   FROM bookings b
                   JOIN billingDetails bd ON bd.bookingId = b.id
                  WHERE b.laundryShopId = :shopId AND b.deletedAt IS NULL
                    AND b.bookingStatusId NOT IN (${CANCELLED}, ${REFUNDED})
                    AND bd.paymentStatus = 'Paid'
                    AND b.createdAt >= :from AND b.createdAt < :to`,
                { ...SELECT, replacements: { shopId: shop.shopId, from, to } }
            );

        const trendFrom = buckets[0].from < range.from ? buckets[0].from : range.from;
        const trendTo = buckets[buckets.length - 1].to > range.to ? buckets[buckets.length - 1].to : range.to;
        const [current, previous, trendOrders] = await Promise.all([
            paidOrders(range.from, range.to),
            paidOrders(range.previous.from, range.previous.to),
            paidOrders(trendFrom, trendTo),
        ]);

        const sum = (rows, key) => rows.reduce((s, r) => s + Number(r[key] || 0), 0);
        const currentEarnings = money(sum(current, 'earning'));
        const previousEarnings = money(sum(previous, 'earning'));
        const count = current.length;

        return {
            period,
            currency: shop.currency,
            range: rangeOut(range),
            previousRange: {
                startDate: range.previous.startDate,
                endDate: range.previous.endDate,
            },
            summary: {
                currentEarnings,
                previousEarnings,
                // Null when nothing was earned before — there is no change to show.
                growthPercentage: percentChange(currentEarnings, previousEarnings),
            },
            quickMetrics: {
                avgOrderValue: count ? money(sum(current, 'total') / count) : null,
                avgEarningPerOrder: count ? money(currentEarnings / count) : null,
                paidOrders: count,
                tipsCollected: money(sum(current, 'tips')),
            },
            earningsTrend: {
                labels: buckets.map((b) => b.label),
                points: buckets.map((b) =>
                    money(
                        trendOrders
                            .filter((o) => {
                                const t = new Date(o.createdAt).getTime();
                                return t >= b.from.getTime() && t < b.to.getTime();
                            })
                            .reduce((s, o) => s + Number(o.earning || 0), 0)
                    )
                ),
            },
        };
    }
}

module.exports = new ShopReportsService();
module.exports.statusBuckets = statusBuckets;
module.exports.legPunctuality = legPunctuality;
