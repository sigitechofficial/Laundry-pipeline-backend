'use strict';

const { Op, fn, col, literal } = require('sequelize');
const sequelize = require('../../models').sequelize;
const {
    booking,
    billingDetails,
    users,
    zone,
    service,
    categories,
    customerSelectedService,
    bussinessInformation,
    addressDb,
    OnHoldConfirmation
} = require('../../models');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Build a Sequelize WHERE clause for booking.collectionDate based on period.
 * period: 'today' | 'this_week' | 'this_month' | 'custom' | 'all'
 */
function _buildDateFilter(period, startDate, endDate) {
    const now = new Date();

    if (period === 'today') {
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const todayEnd   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
        return { [Op.between]: [todayStart, todayEnd] };
    }

    if (period === 'this_week') {
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - now.getDay());
        weekStart.setHours(0, 0, 0, 0);
        return { [Op.gte]: weekStart };
    }

    if (period === 'this_month') {
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        return { [Op.gte]: monthStart };
    }

    if (period === 'custom' && startDate && endDate) {
        return { [Op.between]: [new Date(startDate), new Date(`${endDate}T23:59:59`)] };
    }

    return {}; // 'all' — no date filter
}

/**
 * Build the booking WHERE clause shared by all reports.
 * @param {Object} filters - { period, startDate, endDate, zoneId, search }
 * @param {Array}  extraWhere - extra conditions merged in
 */
function _buildBookingWhere(filters = {}, extraWhere = {}) {
    const { period, startDate, endDate, zoneId, search } = filters;
    const where = { ...extraWhere };

    const dateFilter = _buildDateFilter(period, startDate, endDate);
    if (Object.keys(dateFilter).length) {
        where.collectionDate = dateFilter;
    }

    if (zoneId) {
        where.zoneId = zoneId;
    }

    if (search) {
        where.orderTrackId = { [Op.like]: `%${search}%` };
    }

    return where;
}

/** Pagination helper */
function _paginate(page, limit) {
    const p = Math.max(1, parseInt(page) || 1);
    const l = Math.min(100, parseInt(limit) || 20);
    return { offset: (p - 1) * l, limit: l };
}

// ---------------------------------------------------------------------------
// 1. Top Services Report
// ---------------------------------------------------------------------------
async function getTopServicesReport(filters = {}) {
    const { page, limit } = filters;
    const bookingWhere = _buildBookingWhere(filters);
    const { offset, limit: lim } = _paginate(page, limit);

    const rows = await customerSelectedService.findAll({
        attributes: [
            [fn('COUNT', col('customerSelectedService.bookingId')), 'numberOfOrders'],
            [fn('SUM', col('customerSelectedService.servicePrice')),  'totalRevenue']
        ],
        include: [
            {
                model: service,
                attributes: ['id', 'name'],
                required: true
            },
            {
                model: booking,
                attributes: [],
                where: bookingWhere,
                required: true
            }
        ],
        group: ['service.id'],
        order: [[literal('numberOfOrders'), 'DESC']],
        offset,
        limit: lim,
        subQuery: false
    });

    return rows.map((r, idx) => ({
        sl:           offset + idx + 1,
        rank:         String(offset + idx + 1).padStart(2, '0'),
        service:      r.service?.name || '—',
        numberOfOrders: parseInt(r.get('numberOfOrders')) || 0,
        totalRevenue: parseFloat(r.get('totalRevenue') || 0).toFixed(2)
    }));
}

// ---------------------------------------------------------------------------
// 2. Hourly Report
// ---------------------------------------------------------------------------
async function getHourlyReport(filters = {}) {
    const bookingWhere = _buildBookingWhere(filters);
    const whereClause = Object.keys(bookingWhere).length
        ? 'WHERE ' + Object.entries(bookingWhere).map(([k]) => `b.\`${k}\` IS NOT NULL`).join(' AND ')
        : '';

    // Use raw query for HOUR() grouping (Sequelize ORM doesn't handle cross-column group well)
    const [pickup] = await sequelize.query(`
        SELECT HOUR(b.collectionTimeFrom) AS hour,
               COUNT(b.id)               AS pickupOrders
        FROM   bookings b
        WHERE  b.deletedAt IS NULL
          ${filters.zoneId ? `AND b.zoneId = ${parseInt(filters.zoneId)}` : ''}
          ${filters.period && filters.period !== 'all' ? _rawDateCondition(filters, 'b.collectionDate') : ''}
        GROUP  BY HOUR(b.collectionTimeFrom)
        ORDER  BY hour ASC
    `);

    const [delivery] = await sequelize.query(`
        SELECT HOUR(b.deliveryTimeFrom) AS hour,
               COUNT(b.id)             AS deliveryOrders
        FROM   bookings b
        WHERE  b.deletedAt IS NULL
          ${filters.zoneId ? `AND b.zoneId = ${parseInt(filters.zoneId)}` : ''}
          ${filters.period && filters.period !== 'all' ? _rawDateCondition(filters, 'b.collectionDate') : ''}
        GROUP  BY HOUR(b.deliveryTimeFrom)
        ORDER  BY hour ASC
    `);

    // Merge pickup and delivery by hour into one result set
    const map = {};
    for (const row of pickup) {
        map[row.hour] = { hour: row.hour, pickupOrders: parseInt(row.pickupOrders) || 0, deliveryOrders: 0 };
    }
    for (const row of delivery) {
        if (map[row.hour]) {
            map[row.hour].deliveryOrders = parseInt(row.deliveryOrders) || 0;
        } else {
            map[row.hour] = { hour: row.hour, pickupOrders: 0, deliveryOrders: parseInt(row.deliveryOrders) || 0 };
        }
    }

    return Object.values(map)
        .sort((a, b) => a.hour - b.hour)
        .map((row, idx) => ({
            sl:             idx + 1,
            hours:          `${String(row.hour).padStart(2, '0')}:00 - ${String(row.hour + 1).padStart(2, '0')}:00`,
            pickupOrders:   row.pickupOrders,
            deliveryOrders: row.deliveryOrders,
            totalActivity:  row.pickupOrders + row.deliveryOrders
        }));
}

/** Build raw SQL date condition for hourly query */
function _rawDateCondition(filters, dateCol) {
    const { period, startDate, endDate } = filters;
    const now = new Date();

    if (period === 'today') {
        const d = now.toISOString().slice(0, 10);
        return `AND DATE(${dateCol}) = '${d}'`;
    }
    if (period === 'this_week') {
        const day = now.getDay();
        const ws  = new Date(now); ws.setDate(now.getDate() - day); ws.setHours(0,0,0,0);
        return `AND ${dateCol} >= '${ws.toISOString().slice(0, 10)}'`;
    }
    if (period === 'this_month') {
        const ms = new Date(now.getFullYear(), now.getMonth(), 1);
        return `AND ${dateCol} >= '${ms.toISOString().slice(0, 10)}'`;
    }
    if (period === 'custom' && startDate && endDate) {
        return `AND DATE(${dateCol}) BETWEEN '${startDate}' AND '${endDate}'`;
    }
    return '';
}

// ---------------------------------------------------------------------------
// 3. On Hold Report
// ---------------------------------------------------------------------------
// On-hold bookings have onHoldReason set (non-null) and are not cancelled/completed
const ON_HOLD_STATUSES = [12, 13, 14]; // adjust to your booking status IDs for on-hold

async function getOnHoldReport(filters = {}) {
    const { page, limit, search } = filters;
    const { offset, limit: lim } = _paginate(page, limit);

    const bookingWhere = _buildBookingWhere(filters, {
        onHoldReason: { [Op.ne]: null }
    });

    // Override search to look at orderTrackId only
    if (search) {
        bookingWhere.orderTrackId = { [Op.like]: `%${search}%` };
    }

    const { count, rows } = await booking.findAndCountAll({
        where: bookingWhere,
        attributes: ['id', 'orderTrackId', 'onHoldReason', 'OnHoldOtherReason', 'bookingStatusId', 'totalItems', 'updatedAt'],
        include: [
            {
                model: users,
                as: 'customer',
                attributes: ['firstName', 'lastName', 'email', 'phoneNum', 'countryCode'],
                required: false
            }
        ],
        order: [['createdAt', 'DESC']],
        offset,
        limit: lim,
        distinct: true
    });

    return {
        total: count,
        page:  parseInt(filters.page) || 1,
        limit: lim,
        data:  rows.map((b, idx) => ({
            sl:           offset + idx + 1,
            orderId:      b.orderTrackId,
            customerName: b.customer ? `${b.customer.firstName} ${b.customer.lastName}` : '—',
            email:        b.customer?.email || '—',
            phone:        b.customer ? `${b.customer.countryCode || ''}${b.customer.phoneNum || ''}` : '—',
            items:        b.totalItems,
            onHoldReason: b.onHoldReason || b.OnHoldOtherReason,
            status:       b.bookingStatusId,
            resolution:   b.updatedAt ? new Date(b.updatedAt).toISOString().slice(0, 10) : '—'
        }))
    };
}

// ---------------------------------------------------------------------------
// 4. Service Demand Report
// ---------------------------------------------------------------------------
async function getServiceDemandReport(filters = {}) {
    const { page, limit } = filters;
    const { offset, limit: lim } = _paginate(page, limit);
    const bookingWhere = _buildBookingWhere(filters);

    // Total orders for percentage calculation
    const totalOrderCount = await booking.count({ where: bookingWhere });

    const rows = await customerSelectedService.findAll({
        attributes: [
            [fn('COUNT', col('customerSelectedService.bookingId')), 'totalOrders'],
            [fn('SUM', col('customerSelectedService.categoryPrice')), 'revenue']
        ],
        include: [
            {
                model: categories,
                attributes: ['id', 'name', 'status'],
                required: true
            },
            {
                model: booking,
                attributes: [],
                where: bookingWhere,
                required: true
            }
        ],
        group: ['category.id'],
        order: [[literal('totalOrders'), 'DESC']],
        offset,
        limit: lim,
        subQuery: false
    });

    return rows.map((r, idx) => ({
        sl:             offset + idx + 1,
        category:       r.category?.name || '—',
        totalOrders:    parseInt(r.get('totalOrders')) || 0,
        percentOfTotal: totalOrderCount > 0
            ? `${((parseInt(r.get('totalOrders')) / totalOrderCount) * 100).toFixed(1)}%`
            : '0%',
        revenue:        parseFloat(r.get('revenue') || 0).toFixed(2),
        status:         r.category?.status ?? true
    }));
}

// ---------------------------------------------------------------------------
// 5. Top Performing Shops
// ---------------------------------------------------------------------------
async function getTopShopsReport(filters = {}) {
    const { page, limit } = filters;
    const { offset, limit: lim } = _paginate(page, limit);

    const [rows] = await sequelize.query(`
        SELECT
            bi.id                                                         AS shopId,
            bi.shopName,
            a.streetAddress                                               AS location,
            a.province                                                    AS city,
            a.district                                                    AS country,
            z.name                                                        AS zoneName,
            z.zoneAdminComission                                          AS commissionPercent,
            COUNT(DISTINCT b.id)                                          AS ordersCompleted,
            COALESCE(SUM(bd.total), 0)                                    AS grossRevenue,
            COALESCE(SUM(bd.zoneAdminCommission), 0)                      AS commissionAmount,
            COALESCE(SUM(bd.pickupDriverEarning + bd.deliveryDriverEarning), 0) AS driversCommission,
            COALESCE(SUM(b.rescheduleCharge), 0)                          AS deduction,
            COALESCE(SUM(bd.total), 0)
                - COALESCE(SUM(bd.zoneAdminCommission), 0)
                - COALESCE(SUM(bd.pickupDriverEarning + bd.deliveryDriverEarning), 0)
                - COALESCE(SUM(b.rescheduleCharge), 0)                    AS netPayout
        FROM   bookings b
        JOIN   addressDb a  ON a.id = b.laundryShopId
        JOIN   bussinessInformation bi ON bi.shopAddressId = a.id
        LEFT   JOIN billingDetails bd ON bd.bookingId = b.id
        LEFT   JOIN zones z ON z.id = b.zoneId
        WHERE  b.deletedAt  IS NULL
          AND  b.bookingStatusId IN (16, 17)
          ${filters.zoneId  ? `AND b.zoneId = ${parseInt(filters.zoneId)}` : ''}
          ${filters.period  && filters.period !== 'all' ? _rawDateCondition(filters, 'b.collectionDate') : ''}
          ${filters.search  ? `AND bi.shopName LIKE '%${filters.search.replace(/'/g, "''")}%'` : ''}
        GROUP  BY bi.id, a.id, z.id
        ORDER  BY ordersCompleted DESC
        LIMIT  ${lim} OFFSET ${offset}
    `);

    return rows.map((r, idx) => ({
        sl:               offset + idx + 1,
        rank:             String(offset + idx + 1).padStart(2, '0'),
        shopName:         r.shopName,
        city:             r.city   || '—',
        country:          r.country || '—',
        location:         r.location || '—',
        zone:             r.zoneName || '—',
        ordersCompleted:  parseInt(r.ordersCompleted) || 0,
        grossRevenue:     parseFloat(r.grossRevenue || 0).toFixed(2),
        commissionPercent: r.commissionPercent != null ? `${r.commissionPercent}%` : '—',
        commissionAmount: parseFloat(r.commissionAmount || 0).toFixed(2),
        driversCommission: parseFloat(r.driversCommission || 0).toFixed(2),
        deduction:        parseFloat(r.deduction || 0).toFixed(2),
        netPayout:        parseFloat(r.netPayout || 0).toFixed(2)
    }));
}

// ---------------------------------------------------------------------------
// 6. Daily Earning Report
// ---------------------------------------------------------------------------
async function getDailyEarningReport(filters = {}) {
    const { page, limit } = filters;
    const { offset, limit: lim } = _paginate(page, limit);

    const [rows] = await sequelize.query(`
        SELECT
            DATE(b.collectionDate)     AS date,
            DAYNAME(b.collectionDate)  AS dayOfWeek,
            COUNT(b.id)                AS ordersCompleted,
            COALESCE(SUM(bd.total), 0) AS grossRevenue,
            COALESCE(AVG(bd.total), 0) AS avgOrderValue
        FROM   bookings b
        LEFT   JOIN billingDetails bd ON bd.bookingId = b.id
        WHERE  b.deletedAt IS NULL
          AND  b.bookingStatusId IN (16, 17)
          ${filters.zoneId ? `AND b.zoneId = ${parseInt(filters.zoneId)}` : ''}
          ${filters.period && filters.period !== 'all' ? _rawDateCondition(filters, 'b.collectionDate') : ''}
          ${filters.search ? `AND b.orderTrackId LIKE '%${filters.search.replace(/'/g, "''")}%'` : ''}
        GROUP  BY DATE(b.collectionDate)
        ORDER  BY date DESC
        LIMIT  ${lim} OFFSET ${offset}
    `);

    return rows.map((r, idx) => ({
        sl:             offset + idx + 1,
        date:           r.date ? new Date(r.date).toISOString().slice(0, 10) : '—',
        dayOfWeek:      r.dayOfWeek,
        ordersCompleted: parseInt(r.ordersCompleted) || 0,
        grossRevenue:   parseFloat(r.grossRevenue || 0).toFixed(2),
        avgOrderValue:  parseFloat(r.avgOrderValue || 0).toFixed(2)
    }));
}

// ---------------------------------------------------------------------------
// 7. Daily Earning Report — by Zone
// ---------------------------------------------------------------------------
async function getDailyEarningByZoneReport(filters = {}) {
    const { page, limit } = filters;
    const { offset, limit: lim } = _paginate(page, limit);

    const [rows] = await sequelize.query(`
        SELECT
            DATE(b.collectionDate)     AS date,
            DAYNAME(b.collectionDate)  AS dayOfWeek,
            z.name                     AS zoneName,
            COALESCE(SUM(bd.total), 0) AS revenue
        FROM   bookings b
        LEFT   JOIN billingDetails bd ON bd.bookingId = b.id
        LEFT   JOIN zones z ON z.id = b.zoneId
        WHERE  b.deletedAt IS NULL
          AND  b.bookingStatusId IN (16, 17)
          ${filters.zoneId ? `AND b.zoneId = ${parseInt(filters.zoneId)}` : ''}
          ${filters.period && filters.period !== 'all' ? _rawDateCondition(filters, 'b.collectionDate') : ''}
        GROUP  BY DATE(b.collectionDate), b.zoneId
        ORDER  BY date DESC, revenue DESC
        LIMIT  ${lim} OFFSET ${offset}
    `);

    return rows.map((r, idx) => ({
        sl:        offset + idx + 1,
        date:      r.date ? new Date(r.date).toISOString().slice(0, 10) : '—',
        dayOfWeek: r.dayOfWeek,
        zoneName:  r.zoneName || '—',
        revenue:   parseFloat(r.revenue || 0).toFixed(2)
    }));
}

// ---------------------------------------------------------------------------
// 8. Daily Earning Report — by Shop
// ---------------------------------------------------------------------------
async function getDailyEarningByShopReport(filters = {}) {
    const { page, limit } = filters;
    const { offset, limit: lim } = _paginate(page, limit);

    const [rows] = await sequelize.query(`
        SELECT
            DATE(b.collectionDate)     AS date,
            DAYNAME(b.collectionDate)  AS dayOfWeek,
            bi.shopName,
            z.name                     AS zoneName,
            COALESCE(SUM(bd.total), 0) AS revenue
        FROM   bookings b
        JOIN   addressDb a  ON a.id = b.laundryShopId
        JOIN   bussinessInformation bi ON bi.shopAddressId = a.id
        LEFT   JOIN billingDetails bd ON bd.bookingId = b.id
        LEFT   JOIN zones z ON z.id = b.zoneId
        WHERE  b.deletedAt IS NULL
          AND  b.bookingStatusId IN (16, 17)
          ${filters.zoneId ? `AND b.zoneId = ${parseInt(filters.zoneId)}` : ''}
          ${filters.period && filters.period !== 'all' ? _rawDateCondition(filters, 'b.collectionDate') : ''}
          ${filters.search ? `AND bi.shopName LIKE '%${filters.search.replace(/'/g, "''")}%'` : ''}
        GROUP  BY DATE(b.collectionDate), bi.id
        ORDER  BY date DESC, revenue DESC
        LIMIT  ${lim} OFFSET ${offset}
    `);

    return rows.map((r, idx) => ({
        sl:        offset + idx + 1,
        date:      r.date ? new Date(r.date).toISOString().slice(0, 10) : '—',
        dayOfWeek: r.dayOfWeek,
        shopName:  r.shopName || '—',
        zoneName:  r.zoneName || '—',
        revenue:   parseFloat(r.revenue || 0).toFixed(2)
    }));
}

module.exports = {
    getTopServicesReport,
    getHourlyReport,
    getOnHoldReport,
    getServiceDemandReport,
    getTopShopsReport,
    getDailyEarningReport,
    getDailyEarningByZoneReport,
    getDailyEarningByShopReport
};
