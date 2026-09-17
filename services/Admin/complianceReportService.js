'use strict';

const { Op, fn, col, literal } = require('sequelize');
const {
  agentComplianceEvent,
  booking,
  users,
  bussinessInformation,
} = require('../../models');
const { ValidationError } = require('../../middlewares/universalErrorHandler');
const { resolveListWindow, andWhere, buildPagination } = require('../../utils/listQuery');
const {
  buildComplianceEventSearchWhere,
  mergeCreatedAtRange,
  COMPLIANCE_EVENTS_DEFAULT_LIMIT,
} = require('../../utils/adminListFilters');

const GEO_ACTIONS = [
  'arrived_pickup',
  'arrived_delivery',
  'complete_pickup',
  'complete_delivery',
];

function parseDateRange(query = {}) {
  const where = {};
  if (query.from || query.to) {
    where.createdAt = {};
    if (query.from) {
      const from = new Date(query.from);
      if (Number.isNaN(from.getTime())) throw new ValidationError('from must be a valid date');
      where.createdAt[Op.gte] = from;
    }
    if (query.to) {
      const to = new Date(query.to);
      if (Number.isNaN(to.getTime())) throw new ValidationError('to must be a valid date');
      where.createdAt[Op.lte] = to;
    }
  }
  const parsePositiveId = (value, field) => {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ValidationError(`${field} must be a positive integer`);
    }
    return id;
  };
  if (query.shopId) where.shopId = parsePositiveId(query.shopId, 'shopId');
  if (query.driverId || query.actorUserId) {
    where.actorUserId = parsePositiveId(
      query.driverId || query.actorUserId,
      query.driverId ? 'driverId' : 'actorUserId'
    );
  }
  if (query.action) where.action = query.action;
  if (query.bookingId) {
    where.bookingId = parsePositiveId(query.bookingId, 'bookingId');
  }
  return where;
}

async function getGeofenceOverrideAggregates(query = {}) {
  const where = {
    ...parseDateRange(query),
    action: { [Op.in]: GEO_ACTIONS },
  };

  const rows = await agentComplianceEvent.findAll({
    where,
    attributes: [
      'actorUserId',
      'shopId',
      [fn('COUNT', col('id')), 'totalActions'],
      [
        fn(
          'SUM',
          literal(
            'CASE WHEN overrideUsed = 1 AND geofenceBypassedGlobal = 0 THEN 1 ELSE 0 END'
          )
        ),
        'overrideCount',
      ],
      [
        fn(
          'SUM',
          literal('CASE WHEN geofenceBypassedGlobal = 1 THEN 1 ELSE 0 END')
        ),
        'globalBypassCount',
      ],
    ],
    group: ['actorUserId', 'shopId'],
    raw: true,
  });

  const enriched = [];
  for (const row of rows) {
    const total = Number(row.totalActions || 0);
    const overrides = Number(row.overrideCount || 0);
    let actorName = null;
    let shopName = null;
    if (row.actorUserId) {
      const u = await users.findByPk(row.actorUserId, {
        attributes: ['id', 'firstName', 'lastName', 'email'],
      });
      if (u) {
        actorName =
          [u.firstName, u.lastName].filter(Boolean).join(' ').trim() ||
          u.email ||
          `User #${u.id}`;
      }
    }
    if (row.shopId) {
      const s = await users.findByPk(row.shopId, {
        attributes: ['id', 'firstName', 'lastName', 'shopName', 'email'],
      });
      if (s) {
        shopName =
          s.shopName ||
          [s.firstName, s.lastName].filter(Boolean).join(' ').trim() ||
          s.email ||
          `Shop #${s.id}`;
      }
    }
    enriched.push({
      actorUserId: row.actorUserId,
      shopId: row.shopId,
      actorName,
      shopName,
      totalActions: total,
      overrideCount: overrides,
      globalBypassCount: Number(row.globalBypassCount || 0),
      overrideRate: total > 0 ? Number(((overrides / total) * 100).toFixed(2)) : 0,
    });
  }

  enriched.sort((a, b) => b.overrideCount - a.overrideCount);

  const totals = enriched.reduce(
    (acc, r) => {
      acc.totalActions += r.totalActions;
      acc.overrideCount += r.overrideCount;
      acc.globalBypassCount += r.globalBypassCount;
      return acc;
    },
    { totalActions: 0, overrideCount: 0, globalBypassCount: 0 }
  );

  return {
    summary: {
      ...totals,
      overrideRate:
        totals.totalActions > 0
          ? Number(((totals.overrideCount / totals.totalActions) * 100).toFixed(2))
          : 0,
    },
    byActor: enriched,
  };
}

/**
 * Agent compliance event log.
 *
 * Legacy filters: from/to, shopId, driverId|actorUserId, action, bookingId, overridesOnly.
 * Shared list contract (utils/listQuery): search (order track id, driver name/email,
 * shop owner name/email, shop name), startDate/endDate (inclusive, on createdAt),
 * page/limit (default 20), export=1 → whole filtered set (capped).
 */
async function listComplianceEvents(query = {}) {
  const window = resolveListWindow(query, {
    defaultLimit: COMPLIANCE_EVENTS_DEFAULT_LIMIT,
  });
  let where = mergeCreatedAtRange(parseDateRange(query), query);

  if (query.overridesOnly === 'true' || query.overridesOnly === true) {
    where.overrideUsed = true;
    where.geofenceBypassedGlobal = false;
  }

  const searchWhere = buildComplianceEventSearchWhere(query.search);
  where = andWhere(where, searchWhere);

  const { rows, count } = await agentComplianceEvent.findAndCountAll({
    where,
    include: [
      {
        model: booking,
        as: 'booking',
        attributes: ['id', 'orderTrackId', 'bookingStatusId'],
        required: false,
      },
      {
        model: users,
        as: 'actor',
        attributes: ['id', 'firstName', 'lastName', 'email'],
        required: false,
      },
      {
        model: users,
        as: 'shop',
        attributes: ['id', 'firstName', 'lastName', 'email'],
        required: false,
        include: [
          {
            model: bussinessInformation,
            as: 'businessInfo',
            attributes: ['id', 'shopName'],
            required: false,
          },
        ],
      },
    ],
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    limit: window.limit,
    offset: window.offset,
    distinct: true,
  });

  const pagination = buildPagination(count, window);
  return {
    // legacy keys
    page: pagination.currentPage,
    limit: pagination.recordsPerPage,
    total: count,
    rows,
    // standard list contract
    pagination,
  };
}

module.exports = {
  getGeofenceOverrideAggregates,
  listComplianceEvents,
  GEO_ACTIONS,
};
