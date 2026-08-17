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

// Resolve actual MySQL table names from Sequelize models (avoids pluralisation guessing)
const T = {
    bookings:              booking.getTableName(),
    billingDetails:        billingDetails.getTableName(),
    zones:                 zone.getTableName(),
    addressDb:             addressDb.getTableName(),
    bussinessInformation:  bussinessInformation.getTableName(),
    shopReviews:           'shopReviews',
    shopReviewReasons:     'shopReviewReasons',
    reviewReasonCodes:     'reviewReasonCodes',
    shopReviewStats:       'shopReviewStats',
};

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
        FROM   \`${T.bookings}\` b
        WHERE  b.deletedAt IS NULL
          ${filters.zoneId ? `AND b.zoneId = ${parseInt(filters.zoneId)}` : ''}
          ${filters.period && filters.period !== 'all' ? _rawDateCondition(filters, 'b.collectionDate') : ''}
        GROUP  BY HOUR(b.collectionTimeFrom)
        ORDER  BY hour ASC
    `);

    const [delivery] = await sequelize.query(`
        SELECT HOUR(b.deliveryTimeFrom) AS hour,
               COUNT(b.id)             AS deliveryOrders
        FROM   \`${T.bookings}\` b
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
        // Rolling last 7 days (calendar week often has zero collections mid-week)
        const ws = new Date(now);
        ws.setDate(now.getDate() - 6);
        ws.setHours(0, 0, 0, 0);
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
        FROM   \`${T.bookings}\` b
        JOIN   \`${T.addressDb}\` a  ON a.id = b.laundryShopId
        JOIN   \`${T.bussinessInformation}\` bi ON bi.shopAddressId = a.id
        LEFT   JOIN \`${T.billingDetails}\` bd ON bd.bookingId = b.id
        LEFT   JOIN \`${T.zones}\` z ON z.id = b.zoneId
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
            MAX(DAYNAME(b.collectionDate))  AS dayOfWeek,
            COUNT(b.id)                AS ordersCompleted,
            COALESCE(SUM(bd.total), 0) AS grossRevenue,
            COALESCE(AVG(bd.total), 0) AS avgOrderValue
        FROM   \`${T.bookings}\` b
        LEFT   JOIN \`${T.billingDetails}\` bd ON bd.bookingId = b.id
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
        FROM   \`${T.bookings}\` b
        LEFT   JOIN \`${T.billingDetails}\` bd ON bd.bookingId = b.id
        LEFT   JOIN \`${T.zones}\` z ON z.id = b.zoneId
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
        FROM   \`${T.bookings}\` b
        JOIN   \`${T.addressDb}\` a  ON a.id = b.laundryShopId
        JOIN   \`${T.bussinessInformation}\` bi ON bi.shopAddressId = a.id
        LEFT   JOIN \`${T.billingDetails}\` bd ON bd.bookingId = b.id
        LEFT   JOIN \`${T.zones}\` z ON z.id = b.zoneId
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

// ---------------------------------------------------------------------------
// 9. Shop Ratings Performance Report
// ---------------------------------------------------------------------------
async function getShopRatingsReport(filters = {}) {
    const { page, limit, minReviews = 1, sort = 'avg_desc' } = filters;
    const { offset, limit: lim } = _paginate(page, limit);
    const minN = Math.max(1, parseInt(minReviews) || 1);

    let orderBy = 's.avgRating DESC, s.publishedCount DESC';
    if (sort === 'avg_asc') orderBy = 's.avgRating ASC, s.publishedCount DESC';
    if (sort === 'low_pct_desc') {
        orderBy =
            '((s.rating1 + s.rating2) / NULLIF(s.publishedCount, 0)) DESC, s.publishedCount DESC';
    }
    if (sort === 'count_desc') orderBy = 's.publishedCount DESC, s.avgRating DESC';

    const [rows] = await sequelize.query(`
        SELECT
            bi.id AS shopId,
            bi.shopName,
            s.avgRating,
            s.publishedCount,
            s.ratingCount,
            s.rating1,
            s.rating2,
            s.rating3,
            s.rating4,
            s.rating5,
            s.topPositiveReasonCode,
            s.topNegativeReasonCode,
            ROUND(
              ((s.rating1 + s.rating2) / NULLIF(s.publishedCount, 0)) * 100,
              1
            ) AS lowRatingPercent
        FROM \`${T.shopReviewStats}\` s
        JOIN \`${T.bussinessInformation}\` bi ON bi.id = s.businessInfoId
        WHERE bi.deletedAt IS NULL
          AND s.publishedCount >= ${minN}
          ${filters.search ? `AND bi.shopName LIKE '%${filters.search.replace(/'/g, "''")}%'` : ''}
        ORDER BY ${orderBy}
        LIMIT ${lim} OFFSET ${offset}
    `);

    return rows.map((r, idx) => {
        const avg = parseFloat(r.avgRating || 0);
        const lowPct = parseFloat(r.lowRatingPercent || 0);
        let performance = 'good';
        if (avg < 3.5 || lowPct >= 25) performance = 'poor';
        else if (avg < 4.0 || lowPct >= 15) performance = 'fair';

        return {
            sl: offset + idx + 1,
            shopId: r.shopId,
            shopName: r.shopName,
            avgRating: avg.toFixed(2),
            publishedCount: parseInt(r.publishedCount) || 0,
            ratingCount: parseInt(r.ratingCount) || 0,
            lowRatingPercent: lowPct.toFixed(1),
            performance,
            histogram: {
                1: parseInt(r.rating1) || 0,
                2: parseInt(r.rating2) || 0,
                3: parseInt(r.rating3) || 0,
                4: parseInt(r.rating4) || 0,
                5: parseInt(r.rating5) || 0,
            },
            topPositiveReasonCode: r.topPositiveReasonCode || null,
            topNegativeReasonCode: r.topNegativeReasonCode || null,
        };
    });
}

// ---------------------------------------------------------------------------
// 10. Platform Reason Insights
// ---------------------------------------------------------------------------
async function getReviewReasonInsights(filters = {}) {
    const dateCond =
        filters.period && filters.period !== 'all'
            ? _rawDateCondition(filters, 'sr.submittedAt')
            : '';

    const [rows] = await sequelize.query(`
        SELECT
            rc.id AS reasonId,
            rc.code,
            rc.label,
            rc.sentiment,
            COUNT(srr.id) AS selectionCount,
            COUNT(DISTINCT sr.businessInfoId) AS shopCount,
            COUNT(DISTINCT sr.id) AS reviewCount
        FROM \`${T.reviewReasonCodes}\` rc
        LEFT JOIN \`${T.shopReviewReasons}\` srr ON srr.reasonCodeId = rc.id
        LEFT JOIN \`${T.shopReviews}\` sr
          ON sr.id = srr.shopReviewId
          AND sr.deletedAt IS NULL
          AND sr.visibility = 'published'
          ${dateCond}
          ${filters.zoneId ? `AND EXISTS (
              SELECT 1 FROM \`${T.bookings}\` b
              WHERE b.id = sr.bookingId AND b.zoneId = ${parseInt(filters.zoneId)}
            )` : ''}
        WHERE rc.status = 1
          ${filters.sentiment === 'positive' || filters.sentiment === 'negative'
            ? `AND rc.sentiment = '${filters.sentiment}'`
            : ''}
        GROUP BY rc.id
        ORDER BY selectionCount DESC, rc.sentiment ASC, rc.sortOrder ASC
    `);

    const positives = [];
    const negatives = [];
    for (const r of rows) {
        const item = {
            reasonId: r.reasonId,
            code: r.code,
            label: r.label,
            sentiment: r.sentiment,
            selectionCount: parseInt(r.selectionCount) || 0,
            shopCount: parseInt(r.shopCount) || 0,
            reviewCount: parseInt(r.reviewCount) || 0,
        };
        if (r.sentiment === 'positive') positives.push(item);
        else negatives.push(item);
    }

    return {
        positives,
        negatives,
        topPositive: positives[0] || null,
        topNegative: negatives[0] || null,
    };
}

// ---------------------------------------------------------------------------
 // 11. Shops driving a specific reason code
// ---------------------------------------------------------------------------
async function getReasonShopBreakdown(filters = {}) {
    const code = String(filters.reasonCode || '').trim().toUpperCase();
    if (!code) return [];

    const { page, limit } = filters;
    const { offset, limit: lim } = _paginate(page, limit);
    const dateCond =
        filters.period && filters.period !== 'all'
            ? _rawDateCondition(filters, 'sr.submittedAt')
            : '';

    const [rows] = await sequelize.query(`
        SELECT
            bi.id AS shopId,
            bi.shopName,
            COUNT(srr.id) AS selectionCount,
            AVG(sr.rating) AS avgRatingInSubset
        FROM \`${T.shopReviewReasons}\` srr
        JOIN \`${T.reviewReasonCodes}\` rc ON rc.id = srr.reasonCodeId
        JOIN \`${T.shopReviews}\` sr ON sr.id = srr.shopReviewId
        JOIN \`${T.bussinessInformation}\` bi ON bi.id = sr.businessInfoId
        WHERE sr.deletedAt IS NULL
          AND sr.visibility = 'published'
          AND rc.code = '${code.replace(/'/g, "''")}'
          ${dateCond}
        GROUP BY bi.id
        ORDER BY selectionCount DESC
        LIMIT ${lim} OFFSET ${offset}
    `);

    return rows.map((r, idx) => ({
        sl: offset + idx + 1,
        shopId: r.shopId,
        shopName: r.shopName,
        selectionCount: parseInt(r.selectionCount) || 0,
        avgRatingInSubset: parseFloat(r.avgRatingInSubset || 0).toFixed(2),
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
    getDailyEarningByShopReport,
    getShopRatingsReport,
    getReviewReasonInsights,
    getReasonShopBreakdown,
};
