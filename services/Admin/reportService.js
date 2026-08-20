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
    bookingStatus,
    invoicePaymentAttempt,
    cancelBooking,
} = require('../../models');
const { formatPaymentFailureReason } = require('../../utils/paymentFailureLabels');
const {
    parseFilters,
    buildPeriodRange,
    sqlDateTime,
    buildBookingWhere,
    buildSqlFragments,
    paginate,
    money,
    asInt,
    resolveReportCurrency,
    envelope,
    REVENUE_STATUSES,
    EXCLUDED_FROM_ACTIVITY,
    CANCELLED,
    ON_HOLD,
    COMPLETED,
} = require('./reportQuery');

const T = {
    bookings: booking.getTableName(),
    billingDetails: billingDetails.getTableName(),
    zones: zone.getTableName(),
    addressDb: addressDb.getTableName(),
    bussinessInformation: bussinessInformation.getTableName(),
    users: users.getTableName(),
    services: service.getTableName(),
    categories: categories.getTableName(),
    customerSelectedService: customerSelectedService.getTableName(),
    bookingStatuses: bookingStatus.getTableName(),
    invoicePaymentAttempts: invoicePaymentAttempt.getTableName(),
    cancelBookings: cancelBooking.getTableName(),
    shopReviews: 'shopReviews',
    shopReviewReasons: 'shopReviewReasons',
    reviewReasonCodes: 'reviewReasonCodes',
    shopReviewStats: 'shopReviewStats',
};

const REVENUE_SQL = REVENUE_STATUSES.join(',');
const ACTIVITY_EXCLUDE_SQL = EXCLUDED_FROM_ACTIVITY.join(',');
const ON_HOLD_SQL = ON_HOLD.join(',');

const OVERDUE_PICKUP_STATUSES = [1, 2, 3];
const OVERDUE_DELIVERY_STATUSES = [8, 9, 10, 11, 12, 13, 14];

async function query(sql, replacements = {}) {
    const [rows] = await sequelize.query(sql, { replacements });
    return rows;
}

function attachCurrency(rows, currency) {
    return rows.map((row) => ({
        ...row,
        currencySymbol: currency.currencySymbol,
        currency: currency.currencyCode,
        currencyCode: currency.currencyCode,
    }));
}

// ---------------------------------------------------------------------------
// 1. Top Services
// ---------------------------------------------------------------------------
async function getTopServicesReport(rawFilters = {}) {
    const filters = parseFilters(rawFilters);
    const { offset, limit, page } = paginate(filters);
    const currency = await resolveReportCurrency(filters);
    const bookingWhere = buildBookingWhere(filters, {
        bookingStatusId: { [Op.notIn]: EXCLUDED_FROM_ACTIVITY },
    });

    const include = [
        { model: service, attributes: ['id', 'name'], required: true },
        { model: booking, attributes: [], where: bookingWhere, required: true },
    ];

    if (filters.search) {
        include[0].where = { name: { [Op.like]: `%${filters.search}%` } };
    }

    const grouped = await customerSelectedService.findAll({
        attributes: [
            [fn('COUNT', fn('DISTINCT', col('customerSelectedService.bookingId'))), 'numberOfOrders'],
            [fn('SUM', literal('COALESCE(NULLIF(`customerSelectedService`.`servicePrice`, 0), `customerSelectedService`.`categoryPrice`, 0)')), 'totalRevenue'],
        ],
        include,
        group: ['service.id'],
        subQuery: false,
    });

    const distinctOrders = await booking.count({ where: bookingWhere });

    const sorted = grouped
        .map((r) => ({
            serviceId: r.service?.id,
            service: r.service?.name || '—',
            numberOfOrders: asInt(r.get('numberOfOrders')),
            totalRevenue: Number(r.get('totalRevenue') || 0),
        }))
        .sort((a, b) => b.numberOfOrders - a.numberOfOrders || b.totalRevenue - a.totalRevenue);

    const summary = {
        services: sorted.length,
        orders: distinctOrders,
        revenue: money(sorted.reduce((s, r) => s + r.totalRevenue, 0)),
    };

    const pageRows = sorted.slice(offset, offset + limit).map((r, idx) => ({
        sl: offset + idx + 1,
        rank: String(offset + idx + 1).padStart(2, '0'),
        service: r.service,
        numberOfOrders: r.numberOfOrders,
        totalRevenue: money(r.totalRevenue),
    }));

    return envelope({
        filters,
        data: attachCurrency(pageRows, currency),
        total: sorted.length,
        page,
        limit,
        summary,
        currency,
    });
}

// ---------------------------------------------------------------------------
// 2. Hourly
// ---------------------------------------------------------------------------
async function getHourlyReport(rawFilters = {}) {
    const filters = parseFilters(rawFilters);
    const currency = await resolveReportCurrency(filters);
    const { whereSql, replacements } = buildSqlFragments(filters, 'b.collectionDate');

    const pickup = await query(
        `
        SELECT HOUR(b.collectionTimeFrom) AS hour, COUNT(b.id) AS pickupOrders
        FROM \`${T.bookings}\` b
        WHERE ${whereSql}
          AND b.bookingStatusId NOT IN (${ACTIVITY_EXCLUDE_SQL})
        GROUP BY HOUR(b.collectionTimeFrom)
        `,
        replacements
    );

    const delivery = await query(
        `
        SELECT HOUR(b.deliveryTimeFrom) AS hour, COUNT(b.id) AS deliveryOrders
        FROM \`${T.bookings}\` b
        WHERE ${whereSql}
          AND b.bookingStatusId NOT IN (${ACTIVITY_EXCLUDE_SQL})
        GROUP BY HOUR(b.deliveryTimeFrom)
        `,
        replacements
    );

    const map = {};
    for (const row of pickup) {
        map[row.hour] = { hour: asInt(row.hour), pickupOrders: asInt(row.pickupOrders), deliveryOrders: 0 };
    }
    for (const row of delivery) {
        const hour = asInt(row.hour);
        if (!map[hour]) map[hour] = { hour, pickupOrders: 0, deliveryOrders: 0 };
        map[hour].deliveryOrders = asInt(row.deliveryOrders);
    }

    const data = Object.values(map)
        .sort((a, b) => a.hour - b.hour)
        .map((row, idx) => ({
            sl: idx + 1,
            hours: `${String(row.hour).padStart(2, '0')}:00 - ${String(row.hour + 1).padStart(2, '0')}:00`,
            pickupOrders: row.pickupOrders,
            deliveryOrders: row.deliveryOrders,
            totalActivity: row.pickupOrders + row.deliveryOrders,
        }));

    const summary = {
        hours: data.length,
        pickup: data.reduce((s, r) => s + r.pickupOrders, 0),
        delivery: data.reduce((s, r) => s + r.deliveryOrders, 0),
        activity: data.reduce((s, r) => s + r.totalActivity, 0),
    };

    return envelope({
        filters,
        data,
        total: data.length,
        page: 1,
        limit: data.length || 24,
        summary,
        currency,
    });
}

// ---------------------------------------------------------------------------
// 3. On Hold
// ---------------------------------------------------------------------------
async function getOnHoldReport(rawFilters = {}) {
    const filters = parseFilters(rawFilters);
    const { offset, limit, page } = paginate(filters);
    const currency = await resolveReportCurrency(filters);

    const bookingWhere = buildBookingWhere(filters, {
        bookingStatusId: { [Op.in]: ON_HOLD },
    });

    if (filters.search) {
        bookingWhere[Op.or] = [
            { orderTrackId: { [Op.like]: `%${filters.search}%` } },
            { onHoldReason: { [Op.like]: `%${filters.search}%` } },
        ];
    }

    const { count, rows } = await booking.findAndCountAll({
        where: bookingWhere,
        attributes: [
            'id',
            'orderTrackId',
            'onHoldReason',
            'OnHoldOtherReason',
            'bookingStatusId',
            'totalItems',
            'updatedAt',
        ],
        include: [
            {
                model: users,
                as: 'customer',
                attributes: ['firstName', 'lastName', 'email', 'phoneNum', 'countryCode'],
                required: false,
            },
            {
                model: bookingStatus,
                attributes: ['id', 'title'],
                required: false,
            },
        ],
        order: [['updatedAt', 'DESC']],
        offset,
        limit,
        distinct: true,
    });

    const reasonRows = await booking.findAll({
        where: buildBookingWhere(filters, { bookingStatusId: { [Op.in]: ON_HOLD } }),
        attributes: [
            'onHoldReason',
            [fn('COUNT', col('booking.id')), 'count'],
        ],
        group: ['onHoldReason'],
        raw: true,
    });

    const data = rows.map((b, idx) => ({
        sl: offset + idx + 1,
        orderId: b.orderTrackId,
        customerName: b.customer
            ? `${b.customer.firstName || ''} ${b.customer.lastName || ''}`.trim() || '—'
            : '—',
        email: b.customer?.email || '—',
        phone: b.customer
            ? `${b.customer.countryCode || ''}${b.customer.phoneNum || ''}`
            : '—',
        items: b.totalItems,
        onHoldReason: b.onHoldReason || b.OnHoldOtherReason || '—',
        status: b.bookingStatus?.title || String(b.bookingStatusId),
        resolution: b.updatedAt ? new Date(b.updatedAt).toISOString().slice(0, 10) : '—',
    }));

    return envelope({
        filters,
        data,
        total: count,
        page,
        limit,
        summary: {
            onHold: count,
            reasons: reasonRows.map((r) => ({
                reason: r.onHoldReason || 'Unspecified',
                count: asInt(r.count),
            })),
        },
        currency,
    });
}

// ---------------------------------------------------------------------------
// 4. Service Demand
// ---------------------------------------------------------------------------
async function getServiceDemandReport(rawFilters = {}) {
    const filters = parseFilters(rawFilters);
    const { offset, limit, page } = paginate(filters);
    const currency = await resolveReportCurrency(filters);
    const bookingWhere = buildBookingWhere(filters, {
        bookingStatusId: { [Op.notIn]: EXCLUDED_FROM_ACTIVITY },
    });

    const completedOrders = await booking.count({ where: bookingWhere });

    const include = [
        { model: categories, attributes: ['id', 'name', 'status'], required: true },
        { model: booking, attributes: [], where: bookingWhere, required: true },
    ];
    if (filters.search) {
        include[0].where = { name: { [Op.like]: `%${filters.search}%` } };
    }

    const grouped = await customerSelectedService.findAll({
        attributes: [
            [fn('COUNT', fn('DISTINCT', col('customerSelectedService.bookingId'))), 'totalOrders'],
            [fn('SUM', col('customerSelectedService.categoryPrice')), 'revenue'],
        ],
        include,
        group: ['category.id'],
        subQuery: false,
    });

    const sorted = grouped
        .map((r) => ({
            category: r.category?.name || '—',
            status: r.category?.status ?? true,
            totalOrders: asInt(r.get('totalOrders')),
            revenue: Number(r.get('revenue') || 0),
        }))
        .sort((a, b) => b.totalOrders - a.totalOrders);

    const summary = {
        categories: sorted.length,
        orders: completedOrders,
        demandOrders: sorted.reduce((s, r) => s + r.totalOrders, 0),
        revenue: money(sorted.reduce((s, r) => s + r.revenue, 0)),
    };

    const pageRows = sorted.slice(offset, offset + limit).map((r, idx) => ({
        sl: offset + idx + 1,
        category: r.category,
        totalOrders: r.totalOrders,
        percentOfTotal:
            completedOrders > 0
                ? `${((r.totalOrders / completedOrders) * 100).toFixed(1)}%`
                : '0%',
        revenue: money(r.revenue),
        status: r.status,
    }));

    return envelope({
        filters,
        data: attachCurrency(pageRows, currency),
        total: sorted.length,
        page,
        limit,
        summary,
        currency,
    });
}

// ---------------------------------------------------------------------------
// 5. Top Performing Shops
// ---------------------------------------------------------------------------
async function getTopShopsReport(rawFilters = {}) {
    const filters = parseFilters(rawFilters);
    const { offset, limit, page } = paginate(filters);
    const currency = await resolveReportCurrency(filters);
    const { whereSql, replacements } = buildSqlFragments(filters, 'b.collectionDate');

    if (filters.search) {
        replacements.shopSearch = `%${filters.search}%`;
    }

    const all = await query(
        `
        SELECT
            bi.id AS shopId,
            bi.shopName,
            a.streetAddress AS location,
            a.province AS city,
            a.district AS country,
            z.name AS zoneName,
            z.zoneAdminComission AS commissionPercent,
            COUNT(DISTINCT b.id) AS ordersCompleted,
            COALESCE(SUM(bd.total), 0) AS grossRevenue,
            COALESCE(SUM(bd.zoneAdminCommission), 0) AS commissionAmount,
            COALESCE(SUM(bd.pickupDriverEarning + bd.deliveryDriverEarning), 0) AS driversCommission,
            COALESCE(SUM(b.rescheduleCharge), 0) AS deduction,
            COALESCE(SUM(bd.total), 0)
                - COALESCE(SUM(bd.zoneAdminCommission), 0)
                - COALESCE(SUM(bd.pickupDriverEarning + bd.deliveryDriverEarning), 0)
                - COALESCE(SUM(b.rescheduleCharge), 0) AS netPayout
        FROM \`${T.bookings}\` b
        JOIN \`${T.addressDb}\` a ON a.id = b.laundryShopId
        JOIN \`${T.bussinessInformation}\` bi ON bi.shopAddressId = a.id
        LEFT JOIN \`${T.billingDetails}\` bd ON bd.bookingId = b.id
        LEFT JOIN \`${T.zones}\` z ON z.id = b.zoneId
        WHERE ${whereSql}
          AND b.bookingStatusId IN (${REVENUE_SQL})
          ${filters.search ? 'AND bi.shopName LIKE :shopSearch' : ''}
        GROUP BY bi.id, a.id, z.id
        ORDER BY ordersCompleted DESC, grossRevenue DESC
        `,
        replacements
    );

    const summary = {
        shops: all.length,
        orders: all.reduce((s, r) => s + asInt(r.ordersCompleted), 0),
        revenue: money(all.reduce((s, r) => s + Number(r.grossRevenue || 0), 0)),
        netPayout: money(all.reduce((s, r) => s + Number(r.netPayout || 0), 0)),
    };

    const pageRows = all.slice(offset, offset + limit).map((r, idx) => ({
        sl: offset + idx + 1,
        rank: String(offset + idx + 1).padStart(2, '0'),
        shopId: r.shopId,
        shopName: r.shopName,
        city: r.city || '—',
        country: r.country || '—',
        location: r.location || '—',
        zone: r.zoneName || '—',
        ordersCompleted: asInt(r.ordersCompleted),
        grossRevenue: money(r.grossRevenue),
        commissionPercent: r.commissionPercent != null ? `${r.commissionPercent}%` : '—',
        commissionAmount: money(r.commissionAmount),
        driversCommission: money(r.driversCommission),
        deduction: money(r.deduction),
        netPayout: money(r.netPayout),
    }));

    return envelope({
        filters,
        data: attachCurrency(pageRows, currency),
        total: all.length,
        page,
        limit,
        summary,
        currency,
    });
}

// ---------------------------------------------------------------------------
// 6–8. Daily earnings
// ---------------------------------------------------------------------------
async function getDailyEarningReport(rawFilters = {}) {
    const filters = parseFilters(rawFilters);
    const { offset, limit, page } = paginate(filters);
    const currency = await resolveReportCurrency(filters);
    const { whereSql, replacements } = buildSqlFragments(filters, 'b.collectionDate');

    const all = await query(
        `
        SELECT
            DATE(b.collectionDate) AS date,
            MAX(DAYNAME(b.collectionDate)) AS dayOfWeek,
            COUNT(b.id) AS ordersCompleted,
            COALESCE(SUM(bd.total), 0) AS grossRevenue,
            COALESCE(AVG(bd.total), 0) AS avgOrderValue
        FROM \`${T.bookings}\` b
        LEFT JOIN \`${T.billingDetails}\` bd ON bd.bookingId = b.id
        WHERE ${whereSql}
          AND b.bookingStatusId IN (${REVENUE_SQL})
        GROUP BY DATE(b.collectionDate)
        ORDER BY date DESC
        `,
        replacements
    );

    const summary = {
        days: all.length,
        orders: all.reduce((s, r) => s + asInt(r.ordersCompleted), 0),
        revenue: money(all.reduce((s, r) => s + Number(r.grossRevenue || 0), 0)),
    };

    const pageRows = all.slice(offset, offset + limit).map((r, idx) => ({
        sl: offset + idx + 1,
        date: r.date ? new Date(r.date).toISOString().slice(0, 10) : '—',
        dayOfWeek: r.dayOfWeek,
        ordersCompleted: asInt(r.ordersCompleted),
        grossRevenue: money(r.grossRevenue),
        avgOrderValue: money(r.avgOrderValue),
    }));

    return envelope({
        filters,
        data: attachCurrency(pageRows, currency),
        total: all.length,
        page,
        limit,
        summary,
        currency,
    });
}

async function getDailyEarningByZoneReport(rawFilters = {}) {
    const filters = parseFilters(rawFilters);
    const { offset, limit, page } = paginate(filters);
    const currency = await resolveReportCurrency(filters);
    const { whereSql, replacements } = buildSqlFragments(filters, 'b.collectionDate');

    const all = await query(
        `
        SELECT
            DATE(b.collectionDate) AS date,
            MAX(DAYNAME(b.collectionDate)) AS dayOfWeek,
            z.name AS zoneName,
            COUNT(b.id) AS ordersCompleted,
            COALESCE(SUM(bd.total), 0) AS revenue
        FROM \`${T.bookings}\` b
        LEFT JOIN \`${T.billingDetails}\` bd ON bd.bookingId = b.id
        LEFT JOIN \`${T.zones}\` z ON z.id = b.zoneId
        WHERE ${whereSql}
          AND b.bookingStatusId IN (${REVENUE_SQL})
        GROUP BY DATE(b.collectionDate), b.zoneId
        ORDER BY date DESC, revenue DESC
        `,
        replacements
    );

    const summary = {
        rows: all.length,
        orders: all.reduce((s, r) => s + asInt(r.ordersCompleted), 0),
        revenue: money(all.reduce((s, r) => s + Number(r.revenue || 0), 0)),
    };

    const pageRows = all.slice(offset, offset + limit).map((r, idx) => ({
        sl: offset + idx + 1,
        date: r.date ? new Date(r.date).toISOString().slice(0, 10) : '—',
        dayOfWeek: r.dayOfWeek,
        zoneName: r.zoneName || '—',
        ordersCompleted: asInt(r.ordersCompleted),
        revenue: money(r.revenue),
    }));

    return envelope({
        filters,
        data: attachCurrency(pageRows, currency),
        total: all.length,
        page,
        limit,
        summary,
        currency,
    });
}

async function getDailyEarningByShopReport(rawFilters = {}) {
    const filters = parseFilters(rawFilters);
    const { offset, limit, page } = paginate(filters);
    const currency = await resolveReportCurrency(filters);
    const { whereSql, replacements } = buildSqlFragments(filters, 'b.collectionDate');
    if (filters.search) replacements.shopSearch = `%${filters.search}%`;

    const all = await query(
        `
        SELECT
            DATE(b.collectionDate) AS date,
            MAX(DAYNAME(b.collectionDate)) AS dayOfWeek,
            bi.shopName,
            z.name AS zoneName,
            COUNT(b.id) AS ordersCompleted,
            COALESCE(SUM(bd.total), 0) AS revenue
        FROM \`${T.bookings}\` b
        JOIN \`${T.addressDb}\` a ON a.id = b.laundryShopId
        JOIN \`${T.bussinessInformation}\` bi ON bi.shopAddressId = a.id
        LEFT JOIN \`${T.billingDetails}\` bd ON bd.bookingId = b.id
        LEFT JOIN \`${T.zones}\` z ON z.id = b.zoneId
        WHERE ${whereSql}
          AND b.bookingStatusId IN (${REVENUE_SQL})
          ${filters.search ? 'AND bi.shopName LIKE :shopSearch' : ''}
        GROUP BY DATE(b.collectionDate), bi.id
        ORDER BY date DESC, revenue DESC
        `,
        replacements
    );

    const summary = {
        rows: all.length,
        orders: all.reduce((s, r) => s + asInt(r.ordersCompleted), 0),
        revenue: money(all.reduce((s, r) => s + Number(r.revenue || 0), 0)),
    };

    const pageRows = all.slice(offset, offset + limit).map((r, idx) => ({
        sl: offset + idx + 1,
        date: r.date ? new Date(r.date).toISOString().slice(0, 10) : '—',
        dayOfWeek: r.dayOfWeek,
        shopName: r.shopName || '—',
        zoneName: r.zoneName || '—',
        ordersCompleted: asInt(r.ordersCompleted),
        revenue: money(r.revenue),
    }));

    return envelope({
        filters,
        data: attachCurrency(pageRows, currency),
        total: all.length,
        page,
        limit,
        summary,
        currency,
    });
}

// ---------------------------------------------------------------------------
// 9. Shop ratings
// ---------------------------------------------------------------------------
async function getShopRatingsReport(rawFilters = {}) {
    const filters = parseFilters(rawFilters);
    const { offset, limit, page } = paginate(filters);
    const minN = Math.max(1, parseInt(rawFilters.minReviews, 10) || 1);
    const sortAllow = {
        avg_desc: 's.avgRating DESC, s.publishedCount DESC',
        avg_asc: 's.avgRating ASC, s.publishedCount DESC',
        low_pct_desc:
            '((s.rating1 + s.rating2) / NULLIF(s.publishedCount, 0)) DESC, s.publishedCount DESC',
        count_desc: 's.publishedCount DESC, s.avgRating DESC',
    };
    const orderBy = sortAllow[rawFilters.sort] || sortAllow.avg_desc;
    const replacements = { minN, lim: limit, off: offset };
    if (filters.search) replacements.shopSearch = `%${filters.search}%`;

    const countRows = await query(
        `
        SELECT COUNT(*) AS total
        FROM \`${T.shopReviewStats}\` s
        JOIN \`${T.bussinessInformation}\` bi ON bi.id = s.businessInfoId
        WHERE bi.deletedAt IS NULL
          AND s.publishedCount >= :minN
          ${filters.search ? 'AND bi.shopName LIKE :shopSearch' : ''}
        `,
        replacements
    );

    const rows = await query(
        `
        SELECT
            bi.id AS shopId,
            bi.shopName,
            s.avgRating,
            s.publishedCount,
            s.ratingCount,
            s.rating1, s.rating2, s.rating3, s.rating4, s.rating5,
            s.topPositiveReasonCode,
            s.topNegativeReasonCode,
            ROUND(((s.rating1 + s.rating2) / NULLIF(s.publishedCount, 0)) * 100, 1) AS lowRatingPercent
        FROM \`${T.shopReviewStats}\` s
        JOIN \`${T.bussinessInformation}\` bi ON bi.id = s.businessInfoId
        WHERE bi.deletedAt IS NULL
          AND s.publishedCount >= :minN
          ${filters.search ? 'AND bi.shopName LIKE :shopSearch' : ''}
        ORDER BY ${orderBy}
        LIMIT :lim OFFSET :off
        `,
        replacements
    );

    const data = rows.map((r, idx) => {
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
            publishedCount: asInt(r.publishedCount),
            ratingCount: asInt(r.ratingCount),
            lowRatingPercent: lowPct.toFixed(1),
            performance,
            histogram: {
                1: asInt(r.rating1),
                2: asInt(r.rating2),
                3: asInt(r.rating3),
                4: asInt(r.rating4),
                5: asInt(r.rating5),
            },
            topPositiveReasonCode: r.topPositiveReasonCode || null,
            topNegativeReasonCode: r.topNegativeReasonCode || null,
        };
    });

    return envelope({
        filters: { ...filters, minReviews: minN, sort: rawFilters.sort || 'avg_desc' },
        data,
        total: asInt(countRows[0]?.total),
        page,
        limit,
        summary: { shops: asInt(countRows[0]?.total) },
        currency: { currencySymbol: '', currencyCode: '' },
    });
}

async function getReviewReasonInsights(rawFilters = {}) {
    const filters = parseFilters(rawFilters);
    const replacements = {};
    if (filters.zoneId) replacements.zoneId = filters.zoneId;
    const range = buildPeriodRange(filters.period, filters.startDate, filters.endDate);
    if (range) {
        replacements.dateStart = sqlDateTime(range.start);
        replacements.dateEnd = sqlDateTime(range.end);
    }
    const sentiment =
        rawFilters.sentiment === 'positive' || rawFilters.sentiment === 'negative'
            ? rawFilters.sentiment
            : '';
    if (sentiment) replacements.sentiment = sentiment;

    const dateJoin = range
        ? 'AND sr.submittedAt BETWEEN :dateStart AND :dateEnd'
        : '';

    const rows = await query(
        `
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
          ${dateJoin}
          ${filters.zoneId ? `AND EXISTS (
              SELECT 1 FROM \`${T.bookings}\` b
              WHERE b.id = sr.bookingId AND b.zoneId = :zoneId AND b.deletedAt IS NULL
            )` : ''}
        WHERE rc.status = 1
          ${sentiment ? 'AND rc.sentiment = :sentiment' : ''}
        GROUP BY rc.id
        ORDER BY selectionCount DESC, rc.sentiment ASC, rc.sortOrder ASC
        `,
        replacements
    );

    const positives = [];
    const negatives = [];
    for (const r of rows) {
        const item = {
            reasonId: r.reasonId,
            code: r.code,
            label: r.label,
            sentiment: r.sentiment,
            selectionCount: asInt(r.selectionCount),
            shopCount: asInt(r.shopCount),
            reviewCount: asInt(r.reviewCount),
        };
        if (r.sentiment === 'positive') positives.push(item);
        else negatives.push(item);
    }

    return envelope({
        filters,
        data: {
            positives,
            negatives,
            topPositive: positives[0] || null,
            topNegative: negatives[0] || null,
        },
        total: rows.length,
        page: 1,
        limit: rows.length || 20,
        summary: {
            positiveReasons: positives.length,
            negativeReasons: negatives.length,
        },
        currency: { currencySymbol: '', currencyCode: '' },
    });
}

async function getReasonShopBreakdown(rawFilters = {}) {
    const filters = parseFilters(rawFilters);
    const code = String(rawFilters.reasonCode || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
    if (!code) return envelope({ filters, data: [], total: 0, page: 1, limit: 20, summary: {}, currency: {} });

    const { offset, limit, page } = paginate(filters);
    const { replacements } = buildSqlFragments(filters, 'sr.submittedAt');
    replacements.code = code;
    replacements.lim = limit;
    replacements.off = offset;
    const dateJoin = filters.period && filters.period !== 'all'
        ? 'AND sr.submittedAt BETWEEN :dateStart AND :dateEnd'
        : '';

    const rows = await query(
        `
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
          AND rc.code = :code
          ${dateJoin}
        GROUP BY bi.id
        ORDER BY selectionCount DESC
        LIMIT :lim OFFSET :off
        `,
        replacements
    );

    return envelope({
        filters: { ...filters, reasonCode: code },
        data: rows.map((r, idx) => ({
            sl: offset + idx + 1,
            shopId: r.shopId,
            shopName: r.shopName,
            selectionCount: asInt(r.selectionCount),
            avgRatingInSubset: money(r.avgRatingInSubset),
        })),
        total: rows.length,
        page,
        limit,
        summary: {},
        currency: { currencySymbol: '', currencyCode: '' },
    });
}

// ---------------------------------------------------------------------------
// 12. Payments — method mix + failures
// ---------------------------------------------------------------------------
async function getPaymentsReport(rawFilters = {}) {
    const filters = parseFilters(rawFilters);
    const currency = await resolveReportCurrency(filters);
    const { whereSql, replacements } = buildSqlFragments(filters, 'b.collectionDate');

    const mix = await query(
        `
        SELECT
            b.paymentType AS method,
            COUNT(b.id) AS orders,
            COALESCE(SUM(CASE WHEN b.bookingStatusId IN (${REVENUE_SQL}) THEN bd.total ELSE 0 END), 0) AS revenue
        FROM \`${T.bookings}\` b
        LEFT JOIN \`${T.billingDetails}\` bd ON bd.bookingId = b.id
        WHERE ${whereSql}
          AND b.bookingStatusId NOT IN (${ACTIVITY_EXCLUDE_SQL})
        GROUP BY b.paymentType
        ORDER BY orders DESC
        `,
        replacements
    );

    const failures = await query(
        `
        SELECT
            COALESCE(NULLIF(ipa.stripeDeclineCode, ''), NULLIF(ipa.stripeErrorCode, ''), 'unknown') AS reasonCode,
            MAX(ipa.errorMessage) AS errorMessage,
            COUNT(ipa.id) AS attempts,
            COUNT(DISTINCT ipa.bookingId) AS bookings,
            COALESCE(SUM(ipa.amount), 0) AS amount
        FROM \`${T.invoicePaymentAttempts}\` ipa
        JOIN \`${T.bookings}\` b ON b.id = ipa.bookingId
        WHERE ${whereSql}
          AND ipa.status = 'failed'
        GROUP BY reasonCode
        ORDER BY attempts DESC
        `,
        replacements
    );

    const orders = mix.reduce((s, r) => s + asInt(r.orders), 0);
    const mixRows = mix.map((r, idx) => ({
        sl: idx + 1,
        method: r.method || '—',
        orders: asInt(r.orders),
        share: orders > 0 ? `${((asInt(r.orders) / orders) * 100).toFixed(1)}%` : '0%',
        revenue: money(r.revenue),
    }));

    const failureRows = failures.map((r, idx) => ({
        sl: idx + 1,
        reasonCode: r.reasonCode,
        reason: formatPaymentFailureReason(r.reasonCode, r.errorMessage),
        attempts: asInt(r.attempts),
        bookings: asInt(r.bookings),
        amount: money(r.amount),
    }));

    const summary = {
        orders,
        cardOrders: asInt(mix.find((r) => r.method === 'card')?.orders),
        cashOrders: asInt(mix.find((r) => r.method === 'cash')?.orders),
        revenue: money(mix.reduce((s, r) => s + Number(r.revenue || 0), 0)),
        failedAttempts: failureRows.reduce((s, r) => s + r.attempts, 0),
        failedBookings: failureRows.reduce((s, r) => s + r.bookings, 0),
        failedAmount: money(failureRows.reduce((s, r) => s + Number(r.amount || 0), 0)),
    };

    return envelope({
        filters,
        data: attachCurrency(mixRows, currency),
        total: mixRows.length,
        page: 1,
        limit: mixRows.length || 20,
        summary,
        currency,
        failures: attachCurrency(failureRows, currency),
    });
}

// ---------------------------------------------------------------------------
// 13. Cancellations & no-shows
// ---------------------------------------------------------------------------
async function getCancellationsReport(rawFilters = {}) {
    const filters = parseFilters(rawFilters);
    const { offset, limit, page } = paginate(filters);
    const currency = await resolveReportCurrency(filters);
    const { whereSql, replacements } = buildSqlFragments(filters, 'b.collectionDate');
    if (filters.search) replacements.reasonSearch = `%${filters.search}%`;

    const reasons = await query(
        `
        SELECT
            COALESCE(NULLIF(cb.reasonText, ''), 'No reason recorded') AS reason,
            COUNT(DISTINCT b.id) AS cancelledOrders,
            SUM(CASE WHEN b.noShowFeeAccrued > 0 THEN 1 ELSE 0 END) AS noShowOrders,
            COALESCE(SUM(b.noShowFeeAccrued), 0) AS noShowFees
        FROM \`${T.bookings}\` b
        LEFT JOIN \`${T.cancelBookings}\` cb ON cb.bookingId = b.id
        WHERE ${whereSql}
          AND b.bookingStatusId = ${CANCELLED}
          ${filters.search ? 'AND COALESCE(NULLIF(cb.reasonText, \'\'), \'No reason recorded\') LIKE :reasonSearch' : ''}
        GROUP BY reason
        ORDER BY cancelledOrders DESC
        `,
        replacements
    );

    const totals = await query(
        `
        SELECT
            SUM(CASE WHEN b.bookingStatusId = ${CANCELLED} THEN 1 ELSE 0 END) AS cancelled,
            SUM(CASE WHEN b.bookingStatusId IN (${REVENUE_SQL}) THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN b.noShowFeeAccrued > 0 THEN 1 ELSE 0 END) AS noShowOrders,
            COALESCE(SUM(b.noShowFeeAccrued), 0) AS noShowFees,
            COUNT(b.id) AS placed
        FROM \`${T.bookings}\` b
        WHERE ${whereSql}
        `,
        replacements
    );

    const t = totals[0] || {};
    const cancelled = asInt(t.cancelled);
    const completed = asInt(t.completed);
    const placed = asInt(t.placed) || cancelled + completed;
    const cancelRate = placed > 0 ? `${((cancelled / placed) * 100).toFixed(1)}%` : '0%';

    const pageRows = reasons.slice(offset, offset + limit).map((r, idx) => ({
        sl: offset + idx + 1,
        reason: r.reason,
        cancelledOrders: asInt(r.cancelledOrders),
        noShowOrders: asInt(r.noShowOrders),
        noShowFees: money(r.noShowFees),
    }));

    return envelope({
        filters,
        data: attachCurrency(pageRows, currency),
        total: reasons.length,
        page,
        limit,
        summary: {
            cancelled,
            completed,
            noShowOrders: asInt(t.noShowOrders),
            noShowFees: money(t.noShowFees),
            cancelRate,
        },
        currency,
    });
}

// ---------------------------------------------------------------------------
// 14. Customers — new vs repeat + top spend
// ---------------------------------------------------------------------------
async function getCustomersReport(rawFilters = {}) {
    const filters = parseFilters(rawFilters);
    const { offset, limit, page } = paginate(filters);
    const currency = await resolveReportCurrency(filters);
    const { whereSql, replacements, range } = buildSqlFragments(filters, 'b.collectionDate');
    if (filters.search) replacements.customerSearch = `%${filters.search}%`;

    const customers = await query(
        `
        SELECT
            u.id AS customerId,
            TRIM(CONCAT(COALESCE(u.firstName, ''), ' ', COALESCE(u.lastName, ''))) AS customerName,
            u.email,
            COUNT(DISTINCT b.id) AS ordersInPeriod,
            SUM(CASE WHEN b.bookingStatusId IN (${REVENUE_SQL}) THEN 1 ELSE 0 END) AS completedOrders,
            COALESCE(SUM(CASE WHEN b.bookingStatusId IN (${REVENUE_SQL}) THEN bd.total ELSE 0 END), 0) AS spend,
            firsts.firstAt
        FROM \`${T.bookings}\` b
        JOIN \`${T.users}\` u ON u.id = b.customerId
        LEFT JOIN \`${T.billingDetails}\` bd ON bd.bookingId = b.id
        JOIN (
            SELECT customerId, MIN(createdAt) AS firstAt
            FROM \`${T.bookings}\`
            WHERE deletedAt IS NULL AND customerId IS NOT NULL
            GROUP BY customerId
        ) firsts ON firsts.customerId = u.id
        WHERE ${whereSql}
          AND b.bookingStatusId NOT IN (${ACTIVITY_EXCLUDE_SQL})
          ${filters.search ? 'AND (u.firstName LIKE :customerSearch OR u.lastName LIKE :customerSearch OR u.email LIKE :customerSearch)' : ''}
        GROUP BY u.id, firsts.firstAt
        ORDER BY spend DESC, ordersInPeriod DESC
        `,
        replacements
    );

    const periodStart = range?.start ? range.start.getTime() : null;
    const mapped = customers.map((r) => {
        const firstAt = r.firstAt ? new Date(r.firstAt).getTime() : null;
        const isNew = periodStart
            ? firstAt != null && firstAt >= periodStart
            : asInt(r.ordersInPeriod) <= 1;
        return {
            customerId: r.customerId,
            customerName: r.customerName || '—',
            email: r.email || '—',
            ordersInPeriod: asInt(r.ordersInPeriod),
            completedOrders: asInt(r.completedOrders),
            spend: Number(r.spend || 0),
            firstOrderAt: r.firstAt ? new Date(r.firstAt).toISOString().slice(0, 10) : '—',
            segment: isNew ? 'New' : 'Repeat',
        };
    });

    const newCount = mapped.filter((r) => r.segment === 'New').length;
    const summary = {
        customers: mapped.length,
        newCustomers: newCount,
        repeatCustomers: mapped.length - newCount,
        revenue: money(mapped.reduce((s, r) => s + r.spend, 0)),
    };

    const pageRows = mapped.slice(offset, offset + limit).map((r, idx) => ({
        sl: offset + idx + 1,
        ...r,
        spend: money(r.spend),
    }));

    return envelope({
        filters,
        data: attachCurrency(pageRows, currency),
        total: mapped.length,
        page,
        limit,
        summary,
        currency,
    });
}

// ---------------------------------------------------------------------------
// 15. Drivers — collection / delivery
// ---------------------------------------------------------------------------
async function getDriversReport(rawFilters = {}) {
    const filters = parseFilters(rawFilters);
    const { offset, limit, page } = paginate(filters);
    const currency = await resolveReportCurrency(filters);
    const { whereSql, replacements } = buildSqlFragments(filters, 'b.collectionDate');
    if (filters.search) replacements.driverSearch = `%${filters.search}%`;

    const rows = await query(
        `
        SELECT
            u.id AS driverId,
            TRIM(CONCAT(COALESCE(u.firstName, ''), ' ', COALESCE(u.lastName, ''))) AS driverName,
            u.email,
            SUM(CASE WHEN b.pickupCompletedByUserId = u.id THEN 1 ELSE 0 END) AS pickups,
            SUM(CASE WHEN b.deliveryCompletedByUserId = u.id THEN 1 ELSE 0 END) AS deliveries,
            SUM(CASE
                WHEN b.pickupCompletedByUserId = u.id
                 AND b.pickupCompletedAt IS NOT NULL
                 AND b.pickupCompletedAt <= CONCAT(DATE(b.collectionDate), ' ', COALESCE(b.collectionTimeTo, '23:59:59'))
                THEN 1 ELSE 0 END) AS onTimePickups,
            SUM(CASE
                WHEN b.deliveryCompletedByUserId = u.id
                 AND b.deliveryCompletedAt IS NOT NULL
                 AND b.deliveryCompletedAt <= CONCAT(DATE(b.deliveryDate), ' ', COALESCE(b.deliveryTimeTo, '23:59:59'))
                THEN 1 ELSE 0 END) AS onTimeDeliveries,
            COALESCE(SUM(CASE WHEN b.pickupCompletedByUserId = u.id THEN bd.pickupDriverEarning ELSE 0 END), 0)
              + COALESCE(SUM(CASE WHEN b.deliveryCompletedByUserId = u.id THEN bd.deliveryDriverEarning ELSE 0 END), 0) AS earnings
        FROM \`${T.users}\` u
        JOIN \`${T.bookings}\` b
          ON (b.pickupCompletedByUserId = u.id OR b.deliveryCompletedByUserId = u.id)
        LEFT JOIN \`${T.billingDetails}\` bd ON bd.bookingId = b.id
        WHERE ${whereSql}
          AND b.bookingStatusId NOT IN (${ACTIVITY_EXCLUDE_SQL})
          ${filters.search ? 'AND (u.firstName LIKE :driverSearch OR u.lastName LIKE :driverSearch)' : ''}
        GROUP BY u.id
        ORDER BY (pickups + deliveries) DESC, earnings DESC
        `,
        replacements
    );

    const mapped = rows.map((r) => ({
        driverId: r.driverId,
        driverName: r.driverName || '—',
        email: r.email || '—',
        pickups: asInt(r.pickups),
        deliveries: asInt(r.deliveries),
        onTimePickups: asInt(r.onTimePickups),
        onTimeDeliveries: asInt(r.onTimeDeliveries),
        earnings: Number(r.earnings || 0),
    }));

    const pickups = mapped.reduce((s, r) => s + r.pickups, 0);
    const onTimePickups = mapped.reduce((s, r) => s + r.onTimePickups, 0);
    const summary = {
        drivers: mapped.length,
        pickups,
        deliveries: mapped.reduce((s, r) => s + r.deliveries, 0),
        onTimePickupRate: pickups > 0 ? `${((onTimePickups / pickups) * 100).toFixed(1)}%` : '0%',
        earnings: money(mapped.reduce((s, r) => s + r.earnings, 0)),
    };

    const pageRows = mapped.slice(offset, offset + limit).map((r, idx) => ({
        sl: offset + idx + 1,
        ...r,
        earnings: money(r.earnings),
        onTimePickupRate: r.pickups > 0 ? `${((r.onTimePickups / r.pickups) * 100).toFixed(1)}%` : '—',
    }));

    return envelope({
        filters,
        data: attachCurrency(pageRows, currency),
        total: mapped.length,
        page,
        limit,
        summary,
        currency,
    });
}

// ---------------------------------------------------------------------------
// 16. Overdue / SLA (current snapshot)
// ---------------------------------------------------------------------------
async function getOverdueReport(rawFilters = {}) {
    const filters = parseFilters(rawFilters);
    const { offset, limit, page } = paginate(filters);
    const currency = await resolveReportCurrency(filters);
    const replacements = {};
    const parts = ['b.deletedAt IS NULL'];
    if (filters.zoneId) {
        parts.push('b.zoneId = :zoneId');
        replacements.zoneId = filters.zoneId;
    }
    if (filters.shopId) {
        parts.push('b.laundryShopId = :shopId');
        replacements.shopId = filters.shopId;
    }
    if (filters.search) {
        parts.push('bi.shopName LIKE :shopSearch');
        replacements.shopSearch = `%${filters.search}%`;
    }

    const pickupSql = OVERDUE_PICKUP_STATUSES.join(',');
    const deliverySql = OVERDUE_DELIVERY_STATUSES.join(',');

    const rows = await query(
        `
        SELECT
            bi.id AS shopId,
            bi.shopName,
            z.name AS zoneName,
            SUM(CASE
                WHEN b.bookingStatusId IN (${pickupSql})
                 AND CONCAT(DATE(b.collectionDate), ' ', COALESCE(b.collectionTimeTo, '23:59:59')) < NOW()
                THEN 1 ELSE 0 END) AS overduePickup,
            SUM(CASE
                WHEN b.bookingStatusId IN (${deliverySql})
                 AND CONCAT(DATE(b.deliveryDate), ' ', COALESCE(b.deliveryTimeTo, '23:59:59')) < NOW()
                THEN 1 ELSE 0 END) AS overdueDelivery
        FROM \`${T.bookings}\` b
        LEFT JOIN \`${T.addressDb}\` a ON a.id = b.laundryShopId
        LEFT JOIN \`${T.bussinessInformation}\` bi ON bi.shopAddressId = a.id
        LEFT JOIN \`${T.zones}\` z ON z.id = b.zoneId
        WHERE ${parts.join(' AND ')}
          AND b.bookingStatusId NOT IN (${CANCELLED}, ${COMPLETED}, 16, 21)
        GROUP BY bi.id, z.id
        HAVING overduePickup > 0 OR overdueDelivery > 0
        ORDER BY (overduePickup + overdueDelivery) DESC
        `,
        replacements
    );

    const summary = {
        shops: rows.length,
        overduePickup: rows.reduce((s, r) => s + asInt(r.overduePickup), 0),
        overdueDelivery: rows.reduce((s, r) => s + asInt(r.overdueDelivery), 0),
    };

    const pageRows = rows.slice(offset, offset + limit).map((r, idx) => ({
        sl: offset + idx + 1,
        shopId: r.shopId,
        shopName: r.shopName || 'Unassigned',
        zoneName: r.zoneName || '—',
        overduePickup: asInt(r.overduePickup),
        overdueDelivery: asInt(r.overdueDelivery),
        totalOverdue: asInt(r.overduePickup) + asInt(r.overdueDelivery),
    }));

    return envelope({
        filters,
        data: pageRows,
        total: rows.length,
        page,
        limit,
        summary,
        currency,
    });
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
    getPaymentsReport,
    getCancellationsReport,
    getCustomersReport,
    getDriversReport,
    getOverdueReport,
};
