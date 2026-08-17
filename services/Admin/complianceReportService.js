'use strict';

const { Op, fn, col, literal } = require('sequelize');
const { agentComplianceEvent, booking, users } = require('../../models');

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
    if (query.from) where.createdAt[Op.gte] = new Date(query.from);
    if (query.to) where.createdAt[Op.lte] = new Date(query.to);
  }
  if (query.shopId) where.shopId = Number(query.shopId);
  if (query.driverId || query.actorUserId) {
    where.actorUserId = Number(query.driverId || query.actorUserId);
  }
  if (query.action) where.action = query.action;
  if (query.bookingId) where.bookingId = Number(query.bookingId);
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

async function listComplianceEvents(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  const offset = (page - 1) * limit;
  const where = parseDateRange(query);

  if (query.overridesOnly === 'true' || query.overridesOnly === true) {
    where.overrideUsed = true;
    where.geofenceBypassedGlobal = false;
  }

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
    ],
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });

  return {
    page,
    limit,
    total: count,
    rows,
  };
}

module.exports = {
  getGeofenceOverrideAggregates,
  listComplianceEvents,
  GEO_ACTIONS,
};
