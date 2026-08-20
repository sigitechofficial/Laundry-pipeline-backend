'use strict';

const { Op } = require('sequelize');
const {
    users,
    booking,
    billingDetails,
    zone,
    sequelize,
    bussinessInformation,
    addressDb,
    customerSelectedService,
    service,
} = require('../../models');
const {
    COMPLETED,
    CANCELLED,
    ON_HOLD,
    ORDER_CREATED,
    PENDING_EXCLUDED,
} = require('../../constants/bookingStatusIds');
const { resolveDisplayCurrency } = require('../../utils/resolveDisplayCurrency');

/** Status buckets for Orders Management chart */
const PIPELINE = {
    pending: [1, 2, 3],
    inProgress: [4, 5, 6, 7, 8, 9, 10, 11, 12],
    outForDelivery: [13, 14, 15],
    completed: [COMPLETED, 16],
};

/** Completed / collected orders used for revenue math (matches reports) */
const REVENUE_STATUSES = [16, 17, COMPLETED].filter(
    (v, i, a) => a.indexOf(v) === i
);

const T = {
    bookings: booking.getTableName(),
    billingDetails: billingDetails.getTableName(),
    zones: zone.getTableName(),
    addressDb: addressDb.getTableName(),
    bussinessInformation: bussinessInformation.getTableName(),
    customerSelectedService: customerSelectedService.getTableName(),
    service: service.getTableName(),
};

function lastMonthFullRange(now = new Date()) {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    return { start, end };
}

/** Same day-of-month window last month (fair MTD comparison). */
function lastMonthMtdRange(now = new Date()) {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastDayPrev = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
    const day = Math.min(now.getDate(), lastDayPrev);
    const end = new Date(now.getFullYear(), now.getMonth() - 1, day, 23, 59, 59);
    return { start, end };
}

function yearToDateRange(now = new Date()) {
    return {
        start: new Date(now.getFullYear(), 0, 1),
        end: now,
    };
}

function pctChange(current, previous) {
    const c = Number(current) || 0;
    const p = Number(previous) || 0;
    if (p === 0) return c === 0 ? 0 : 100;
    return Math.round(((c - p) / p) * 1000) / 10;
}

function enrichPeriodStats(split) {
    const orders = Number(split.ordersCompleted) || 0;
    const gross = Number(split.grossRevenue) || 0;
    return {
        ...split,
        ordersCompleted: orders,
        avgOrderValue:
            orders > 0 ? Math.round((gross / orders) * 100) / 100 : 0,
    };
}

function buildPeriodDateRange(period, startDate, endDate) {
    const now = new Date();

    if (period === 'today') {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
        return { start, end };
    }

    // Rolling last 7 days — calendar "week starting Sunday" often has zero collections mid-week
    if (period === 'this_week') {
        const start = new Date(now);
        start.setDate(now.getDate() - 6);
        start.setHours(0, 0, 0, 0);
        return { start, end: now };
    }

    if (period === 'this_month') {
        const start = new Date(now.getFullYear(), now.getMonth(), 1);
        return { start, end: now };
    }

    if (period === 'custom' && startDate && endDate) {
        return {
            start: new Date(startDate),
            end: new Date(`${endDate}T23:59:59`),
        };
    }

    return null;
}

function sqlDateTime(d) {
    return d.toISOString().slice(0, 19).replace('T', ' ');
}

function sqlDate(d) {
    return d.toISOString().slice(0, 10);
}

class DashboardService {
    /**
     * Resolve zone ids for geo filters (zone wins; else city; else country).
     */
    async resolveZoneIds(filters = {}) {
        const zoneId = filters.zoneId != null && String(filters.zoneId).trim() !== ''
            ? parseInt(filters.zoneId, 10)
            : null;
        if (Number.isFinite(zoneId)) return [zoneId];

        const cityId = filters.cityId != null && String(filters.cityId).trim() !== ''
            ? parseInt(filters.cityId, 10)
            : null;
        const countryId = filters.countryId != null && String(filters.countryId).trim() !== ''
            ? parseInt(filters.countryId, 10)
            : null;

        if (!Number.isFinite(cityId) && !Number.isFinite(countryId)) {
            return null;
        }

        const where = { status: true };
        if (Number.isFinite(cityId)) {
            where.cityId = cityId;
        } else if (Number.isFinite(countryId)) {
            const { cities } = require('../../models');
            const cityRows = await cities.findAll({
                where: { countryId },
                attributes: ['id'],
            });
            const cityIds = cityRows.map((c) => c.id);
            if (!cityIds.length) return [];
            where.cityId = { [Op.in]: cityIds };
        }

        const zones = await zone.findAll({ where, attributes: ['id'] });
        return zones.map((z) => z.id);
    }

    buildBookingWhere(filters = {}, zoneIds, dateField = 'createdAt') {
        const where = {};
        if (Array.isArray(zoneIds)) {
            if (zoneIds.length === 0) {
                where.id = { [Op.in]: [] };
            } else {
                where.zoneId = { [Op.in]: zoneIds };
            }
        }

        const range = buildPeriodDateRange(
            filters.period,
            filters.startDate,
            filters.endDate
        );
        if (range) {
            where[dateField] = { [Op.between]: [range.start, range.end] };
        }

        return where;
    }

    zoneSqlFragment(zoneIds) {
        if (!Array.isArray(zoneIds)) return '';
        if (!zoneIds.length) return 'AND 1=0';
        const ids = zoneIds.map((id) => parseInt(id, 10)).filter(Number.isFinite);
        if (!ids.length) return 'AND 1=0';
        return `AND b.zoneId IN (${ids.join(',')})`;
    }

    periodSqlFragment(filters, dateCol) {
        const range = buildPeriodDateRange(
            filters.period,
            filters.startDate,
            filters.endDate
        );
        if (!range) return '';
        return `AND ${dateCol} BETWEEN '${sqlDateTime(range.start)}' AND '${sqlDateTime(range.end)}'`;
    }

    async sumRevenueSplit(zoneIds, dateRange) {
        if (Array.isArray(zoneIds) && zoneIds.length === 0) {
            return enrichPeriodStats({
                adminRevenue: 0,
                shopRevenue: 0,
                grossRevenue: 0,
                ordersCompleted: 0,
            });
        }

        const zoneSql = this.zoneSqlFragment(zoneIds);
        let dateSql = '';
        if (dateRange) {
            dateSql = `AND b.collectionDate BETWEEN '${sqlDateTime(dateRange.start)}' AND '${sqlDateTime(dateRange.end)}'`;
        }

        const [rows] = await sequelize.query(`
            SELECT
                COUNT(DISTINCT b.id) AS ordersCompleted,
                COALESCE(SUM(bd.total), 0) AS grossRevenue,
                COALESCE(SUM(bd.zoneAdminCommission), 0) AS adminRevenue,
                COALESCE(SUM(bd.total), 0)
                    - COALESCE(SUM(bd.zoneAdminCommission), 0)
                    - COALESCE(SUM(bd.pickupDriverEarning + bd.deliveryDriverEarning), 0)
                    - COALESCE(SUM(b.rescheduleCharge), 0) AS shopRevenue
            FROM \`${T.bookings}\` b
            LEFT JOIN \`${T.billingDetails}\` bd ON bd.bookingId = b.id
            WHERE b.deletedAt IS NULL
              AND b.bookingStatusId IN (${REVENUE_STATUSES.join(',')})
              ${zoneSql}
              ${dateSql}
        `);

        const row = rows?.[0] || {};
        return enrichPeriodStats({
            adminRevenue: Math.round((Number(row.adminRevenue) || 0) * 100) / 100,
            shopRevenue: Math.round((Number(row.shopRevenue) || 0) * 100) / 100,
            grossRevenue: Math.round((Number(row.grossRevenue) || 0) * 100) / 100,
            ordersCompleted: Number(row.ordersCompleted) || 0,
        });
    }

    async getDailyRevenueSeries(filters, zoneIds) {
        if (Array.isArray(zoneIds) && zoneIds.length === 0) return [];

        const zoneSql = this.zoneSqlFragment(zoneIds);
        const periodSql = this.periodSqlFragment(filters, 'b.collectionDate');
        // When period=all, still cap chart to last 31 collection days with data
        const limit = filters.period && filters.period !== 'all' ? 62 : 31;

        const [rows] = await sequelize.query(`
            SELECT * FROM (
                SELECT
                    DATE(b.collectionDate) AS date,
                    COALESCE(SUM(bd.total), 0) AS grossRevenue,
                    COALESCE(SUM(bd.zoneAdminCommission), 0) AS adminRevenue,
                    COALESCE(SUM(bd.total), 0)
                        - COALESCE(SUM(bd.zoneAdminCommission), 0) AS shopRevenue,
                    COUNT(b.id) AS ordersCompleted
                FROM \`${T.bookings}\` b
                LEFT JOIN \`${T.billingDetails}\` bd ON bd.bookingId = b.id
                WHERE b.deletedAt IS NULL
                  AND b.bookingStatusId IN (${REVENUE_STATUSES.join(',')})
                  AND b.collectionDate IS NOT NULL
                  ${zoneSql}
                  ${periodSql}
                GROUP BY DATE(b.collectionDate)
                ORDER BY date DESC
                LIMIT ${limit}
            ) recent
            ORDER BY date ASC
        `);

        return (rows || []).map((r) => ({
            date: r.date ? sqlDate(new Date(r.date)) : null,
            grossRevenue: Math.round((Number(r.grossRevenue) || 0) * 100) / 100,
            adminRevenue: Math.round((Number(r.adminRevenue) || 0) * 100) / 100,
            shopRevenue: Math.round((Number(r.shopRevenue) || 0) * 100) / 100,
            ordersCompleted: Number(r.ordersCompleted) || 0,
        })).filter((r) => r.date);
    }

    async getTopShops(zoneIds, dateRange, limit = 5) {
        if (Array.isArray(zoneIds) && zoneIds.length === 0) return [];

        const zoneSql = this.zoneSqlFragment(zoneIds);
        const dateSql = dateRange
            ? `AND b.collectionDate BETWEEN '${sqlDateTime(dateRange.start)}' AND '${sqlDateTime(dateRange.end)}'`
            : '';

        const [rows] = await sequelize.query(`
            SELECT
                bi.id AS shopId,
                bi.shopName,
                z.name AS zoneName,
                COUNT(DISTINCT b.id) AS ordersCompleted,
                COALESCE(SUM(bd.total), 0) AS grossRevenue,
                COALESCE(SUM(bd.zoneAdminCommission), 0) AS adminRevenue,
                COALESCE(SUM(bd.total), 0)
                    - COALESCE(SUM(bd.zoneAdminCommission), 0)
                    - COALESCE(SUM(bd.pickupDriverEarning + bd.deliveryDriverEarning), 0)
                    - COALESCE(SUM(b.rescheduleCharge), 0) AS shopRevenue
            FROM \`${T.bookings}\` b
            JOIN \`${T.addressDb}\` a ON a.id = b.laundryShopId
            JOIN \`${T.bussinessInformation}\` bi ON bi.shopAddressId = a.id
            LEFT JOIN \`${T.billingDetails}\` bd ON bd.bookingId = b.id
            LEFT JOIN \`${T.zones}\` z ON z.id = b.zoneId
            WHERE b.deletedAt IS NULL
              AND b.bookingStatusId IN (${REVENUE_STATUSES.join(',')})
              ${zoneSql}
              ${dateSql}
            GROUP BY bi.id, z.id
            ORDER BY shopRevenue DESC, ordersCompleted DESC
            LIMIT ${parseInt(limit, 10) || 5}
        `);

        return (rows || []).map((r, idx) => ({
            rank: idx + 1,
            shopId: r.shopId,
            shopName: r.shopName || '—',
            zoneName: r.zoneName || '—',
            ordersCompleted: Number(r.ordersCompleted) || 0,
            grossRevenue: Math.round((Number(r.grossRevenue) || 0) * 100) / 100,
            adminRevenue: Math.round((Number(r.adminRevenue) || 0) * 100) / 100,
            shopRevenue: Math.round((Number(r.shopRevenue) || 0) * 100) / 100,
        }));
    }

    async getTopServices(zoneIds, dateRange, limit = 5) {
        if (Array.isArray(zoneIds) && zoneIds.length === 0) return [];

        const zoneSql = this.zoneSqlFragment(zoneIds);
        const dateSql = dateRange
            ? `AND b.collectionDate BETWEEN '${sqlDateTime(dateRange.start)}' AND '${sqlDateTime(dateRange.end)}'`
            : '';

        const [rows] = await sequelize.query(`
            SELECT
                s.id AS serviceId,
                s.name AS serviceName,
                COUNT(css.id) AS qty,
                COALESCE(SUM(
                    COALESCE(css.servicePrice, 0) + COALESCE(css.categoryPrice, 0)
                ), 0) AS revenue
            FROM \`${T.customerSelectedService}\` css
            JOIN \`${T.service}\` s ON s.id = css.serviceId
            JOIN \`${T.bookings}\` b ON b.id = css.bookingId
            WHERE b.deletedAt IS NULL
              AND b.bookingStatusId IN (${REVENUE_STATUSES.join(',')})
              ${zoneSql}
              ${dateSql}
            GROUP BY s.id, s.name
            ORDER BY revenue DESC, qty DESC
            LIMIT ${parseInt(limit, 10) || 5}
        `);

        return (rows || []).map((r, idx) => ({
            rank: idx + 1,
            serviceId: r.serviceId,
            name: r.serviceName || '—',
            qty: Number(r.qty) || 0,
            revenue: Math.round((Number(r.revenue) || 0) * 100) / 100,
        }));
    }

    /**
     * @param {Object} filters - { zoneId, cityId, countryId, period, startDate, endDate }
     */
    async getDashboardData(filters = {}) {
        const zoneIds = await this.resolveZoneIds(filters);
        const bookingWhere = this.buildBookingWhere(filters, zoneIds, 'createdAt');
        const emptyGeo = Array.isArray(zoneIds) && zoneIds.length === 0;

        const periodRange = buildPeriodDateRange(
            filters.period,
            filters.startDate,
            filters.endDate
        );
        const thisMonthRange = buildPeriodDateRange('this_month');
        const lastMonthRange = lastMonthFullRange();
        const lastMonthMtd = lastMonthMtdRange();
        const ytdRange = yearToDateRange();

        const [
            scopedRevenue,
            thisMonthSplit,
            lastMonthSplit,
            lastMonthMtdSplit,
            ytdSplit,
            dailyRevenue,
            topShopsMtd,
            topShopsLastMonth,
            topShopsYtd,
            topServicesMtd,
            topServicesYtd,
            displayCurrency,
        ] = await Promise.all([
            this.sumRevenueSplit(zoneIds, periodRange),
            this.sumRevenueSplit(zoneIds, thisMonthRange),
            this.sumRevenueSplit(zoneIds, lastMonthRange),
            this.sumRevenueSplit(zoneIds, lastMonthMtd),
            this.sumRevenueSplit(zoneIds, ytdRange),
            this.getDailyRevenueSeries(filters, zoneIds),
            this.getTopShops(zoneIds, thisMonthRange, 5),
            this.getTopShops(zoneIds, lastMonthRange, 5),
            this.getTopShops(zoneIds, ytdRange, 5),
            this.getTopServices(zoneIds, thisMonthRange, 5),
            this.getTopServices(zoneIds, ytdRange, 5),
            resolveDisplayCurrency(filters),
        ]);

        // Platform revenue KPI: prefer billed commission on collected/completed orders
        const adminRevenue = scopedRevenue.adminRevenue;

        const insights = {
            mtdAdmin: {
                ...thisMonthSplit,
                vsLastMonthMtdPct: pctChange(
                    thisMonthSplit.adminRevenue,
                    lastMonthMtdSplit.adminRevenue
                ),
            },
            mtdShops: {
                ...thisMonthSplit,
                total: thisMonthSplit.shopRevenue,
                vsLastMonthMtdPct: pctChange(
                    thisMonthSplit.shopRevenue,
                    lastMonthMtdSplit.shopRevenue
                ),
            },
            lastMonthAdmin: {
                ...lastMonthSplit,
                status: 'Completed',
            },
            lastMonthShops: {
                ...lastMonthSplit,
                total: lastMonthSplit.shopRevenue,
                status: 'Completed',
            },
            ytdAdmin: ytdSplit,
            topShopsMtd,
            topShopsLastMonth,
            topShopsYtd,
            topServicesMtd,
            topServicesYtd,
        };

        const totalBookings = emptyGeo ? 0 : await booking.count({ where: bookingWhere });

        const totalUsers = await users.count();
        const totalCustomers = await users.count({
            where: { userTypeId: 2, status: true },
        });
        const totalAgents = await users.count({
            where: { userTypeId: 4 },
        });
        const totalAgentActive = await users.count({
            where: { userTypeId: 4, status: true },
        });

        const countByStatuses = async (statusIds) => {
            if (emptyGeo) return 0;
            return booking.count({
                where: {
                    ...bookingWhere,
                    bookingStatusId: { [Op.in]: statusIds },
                },
            });
        };

        const [
            pendingOrders,
            inProgressOrders,
            outForDeliveryOrders,
            completedOrders,
            cancelledOrders,
            onHoldOrders,
            newOrders,
        ] = await Promise.all([
            countByStatuses(PIPELINE.pending),
            countByStatuses(PIPELINE.inProgress),
            countByStatuses(PIPELINE.outForDelivery),
            countByStatuses(PIPELINE.completed),
            emptyGeo
                ? 0
                : booking.count({
                      where: { ...bookingWhere, bookingStatusId: CANCELLED },
                  }),
            emptyGeo
                ? 0
                : booking.count({
                      where: { ...bookingWhere, bookingStatusId: { [Op.in]: ON_HOLD } },
                  }),
            emptyGeo
                ? 0
                : booking.count({
                      where: { ...bookingWhere, bookingStatusId: ORDER_CREATED },
                  }),
        ]);

        const openPipeline = emptyGeo
            ? 0
            : await booking.count({
                  where: {
                      ...bookingWhere,
                      bookingStatusId: { [Op.notIn]: PENDING_EXCLUDED },
                  },
              });

        let averageOrderCompletionTimeHours = 0;
        let completedOrdersCount = 0;
        if (!emptyGeo) {
            const zoneSql =
                Array.isArray(zoneIds) && zoneIds.length
                    ? `AND zoneId IN (${zoneIds.map((id) => parseInt(id, 10)).join(',')})`
                    : '';
            const range = buildPeriodDateRange(
                filters.period,
                filters.startDate,
                filters.endDate
            );
            let dateSql = '';
            if (range) {
                dateSql = `AND createdAt BETWEEN '${sqlDateTime(range.start)}' AND '${sqlDateTime(range.end)}'`;
            }
            const [avgRows] = await sequelize.query(`
                SELECT
                    COUNT(*) AS completedCount,
                    AVG(TIMESTAMPDIFF(SECOND, createdAt, updatedAt)) / 3600 AS avgHours
                FROM \`${T.bookings}\`
                WHERE deletedAt IS NULL
                  AND bookingStatusId = ${COMPLETED}
                  ${zoneSql}
                  ${dateSql}
            `);
            completedOrdersCount = Number(avgRows?.[0]?.completedCount) || 0;
            averageOrderCompletionTimeHours =
                completedOrdersCount > 0
                    ? Math.round((Number(avgRows[0].avgHours) || 0) * 100) / 100
                    : 0;
        }

        let agentAcceptanceRate = 0;
        if (!emptyGeo && totalBookings > 0) {
            const assigned = await booking.count({
                where: {
                    ...bookingWhere,
                    laundryShopId: { [Op.ne]: null },
                },
            });
            agentAcceptanceRate = Math.min(
                100,
                Math.round((assigned / totalBookings) * 10000) / 100
            );
        }

        let attention = {
            actionRequiredCount: 0,
            paymentFailureCount: 0,
            onHoldCount: onHoldOrders,
            newOrdersCount: newOrders,
            needsAssignmentCount: 0,
        };
        if (!emptyGeo) {
            const [paymentFailureCount, needsAssignmentCount] = await Promise.all([
                booking.count({
                    where: {
                        ...bookingWhere,
                        paymentType: 'card',
                        paymentDeliveryGate: 'waiting_admin',
                        bookingStatusId: { [Op.lt]: COMPLETED },
                    },
                }),
                booking.count({
                    where: {
                        ...bookingWhere,
                        laundryShopId: null,
                        bookingStatusId: { [Op.in]: [1, 2, 3] },
                    },
                }),
            ]);
            attention = {
                paymentFailureCount,
                needsAssignmentCount,
                onHoldCount: onHoldOrders,
                newOrdersCount: newOrders,
                actionRequiredCount:
                    paymentFailureCount + onHoldOrders + needsAssignmentCount,
            };
        }

        return {
            adminRevenue,
            shopRevenue: scopedRevenue.shopRevenue,
            grossRevenue: scopedRevenue.grossRevenue,
            currencySymbol: displayCurrency.currencySymbol,
            currencyCode: displayCurrency.currencyCode,
            currency: displayCurrency.currencyCode,
            thisMonthAdminRevenue: thisMonthSplit.adminRevenue,
            thisMonthShopRevenue: thisMonthSplit.shopRevenue,
            thisMonthGrossRevenue: thisMonthSplit.grossRevenue,
            thisMonthOrders: thisMonthSplit.ordersCompleted,
            thisMonthAvgOrderValue: thisMonthSplit.avgOrderValue,
            lastMonthAdminRevenue: lastMonthSplit.adminRevenue,
            lastMonthShopRevenue: lastMonthSplit.shopRevenue,
            lastMonthGrossRevenue: lastMonthSplit.grossRevenue,
            lastMonthOrders: lastMonthSplit.ordersCompleted,
            lastMonthAvgOrderValue: lastMonthSplit.avgOrderValue,
            dailyRevenue,
            topShops: topShopsMtd,
            insights,
            totalBookings,
            totalUsers,
            totalCustomers,
            totalAgents,
            totalAgentActive,
            averageOrderCompletionTimeHours,
            completedOrdersCount,
            agentAcceptanceRate,
            orderPipeline: {
                pending: pendingOrders,
                inProgress: inProgressOrders,
                outForDelivery: outForDeliveryOrders,
                completed: completedOrders,
            },
            orderCounts: {
                newOrders,
                pending: openPipeline,
                completed: completedOrders,
                cancelled: cancelledOrders,
                onHold: onHoldOrders,
            },
            attention,
            filtersApplied: {
                zoneId: filters.zoneId || null,
                cityId: filters.cityId || null,
                countryId: filters.countryId || null,
                period: filters.period || 'all',
                emptyGeo,
            },
        };
    }
}

module.exports = new DashboardService();
