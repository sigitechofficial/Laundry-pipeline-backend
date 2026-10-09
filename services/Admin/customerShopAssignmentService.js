'use strict';

const { Op } = require('sequelize');
const {
  customerShopAssignment,
  customerShopRoutingEvent,
  booking,
  addressDb,
  bussinessInformation,
  zone,
  users,
  sequelize,
} = require('../../models');
const {
  ValidationError,
  NotFoundError,
} = require('../../middlewares/universalErrorHandler');
const {
  COMPLETED,
  RETURNING_CUSTOMER_MIN_COMPLETED,
} = require('../../constants/bookingStatusIds');
const {
  computeShopOrderDistances,
  sortAssignableShops,
} = require('../../utils/shopOrderDistanceRank');
const customerShopExclusionService = require('./customerShopExclusionService');

const ACTIONS = Object.freeze({
  ASSIGN: 'assign',
  REASSIGN: 'reassign',
  UNLINK: 'unlink',
  RELINK: 'relink',
  EXCLUDE: 'exclude',
  INCLUDE: 'include',
});

function toPlain(row) {
  return row && typeof row.get === 'function' ? row.get({ plain: true }) : row;
}

async function assertCustomer(customerId) {
  const id = Number(customerId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new ValidationError('Valid customer id is required');
  }
  const customer = await users.findOne({
    where: { id, userTypeId: 2 },
    attributes: ['id'],
  });
  if (!customer) throw new NotFoundError('Customer not found');
  return id;
}

async function shopNameByAddressIds(ids) {
  const unique = [...new Set((ids || []).map(Number).filter((n) => n > 0))];
  const map = new Map();
  if (!unique.length) return map;
  const rows = await bussinessInformation.findAll({
    where: { shopAddressId: unique },
    attributes: ['shopAddressId', 'shopName'],
    raw: true,
  });
  for (const r of rows) {
    map.set(Number(r.shopAddressId), r.shopName || `Shop #${r.shopAddressId}`);
  }
  for (const id of unique) {
    if (!map.has(id)) map.set(id, `Shop #${id}`);
  }
  return map;
}

async function completedCountAtShop(customerId, shopAddressId) {
  if (!customerId || !shopAddressId) return 0;
  return booking.count({
    where: {
      customerId,
      laundryShopId: shopAddressId,
      bookingStatusId: COMPLETED,
    },
  });
}

async function isReturningAtShop(customerId, shopAddressId) {
  const n = await completedCountAtShop(customerId, shopAddressId);
  return n >= RETURNING_CUSTOMER_MIN_COMPLETED;
}

async function recordRoutingEvent({
  customerId,
  action,
  fromShopAddressId = null,
  toShopAddressId = null,
  sourceShopAddressId = null,
  wasReturningAtFromShop = null,
  wasReturningAtToShop = null,
  adminId = null,
  note = null,
} = {}) {
  try {
    await customerShopRoutingEvent.create({
      customerId: Number(customerId),
      action,
      fromShopAddressId:
        fromShopAddressId != null ? Number(fromShopAddressId) : null,
      toShopAddressId:
        toShopAddressId != null ? Number(toShopAddressId) : null,
      sourceShopAddressId:
        sourceShopAddressId != null ? Number(sourceShopAddressId) : null,
      wasReturningAtFromShop,
      wasReturningAtToShop,
      adminId: adminId != null ? Number(adminId) : null,
      note:
        note != null && String(note).trim()
          ? String(note).trim().slice(0, 500)
          : null,
    });
  } catch (err) {
    console.warn(
      '[customerShopAssignment] recordRoutingEvent skipped:',
      err?.message || err
    );
  }
}

function mapAssignment(row, shopName = null) {
  const p = toPlain(row);
  if (!p) return null;
  return {
    id: p.id,
    customerId: Number(p.customerId),
    shopAddressId: Number(p.shopAddressId),
    shopUserId: Number(p.shopUserId),
    shopName: shopName || `Shop #${p.shopAddressId}`,
    sourceShopAddressId:
      p.sourceShopAddressId != null ? Number(p.sourceShopAddressId) : null,
    status: p.status,
    note: p.note || null,
    createdByAdminId:
      p.createdByAdminId != null ? Number(p.createdByAdminId) : null,
    unlinkedByAdminId:
      p.unlinkedByAdminId != null ? Number(p.unlinkedByAdminId) : null,
    unlinkedAt: p.unlinkedAt || null,
    createdAt: p.createdAt || null,
    updatedAt: p.updatedAt || null,
  };
}

async function getActiveAssignment(customerId) {
  const cid = Number(customerId);
  if (!Number.isFinite(cid) || cid <= 0) return null;
  try {
    const row = await customerShopAssignment.findOne({
      where: { customerId: cid, status: 'active' },
      order: [['updatedAt', 'DESC'], ['id', 'DESC']],
    });
    if (!row) return null;
    const names = await shopNameByAddressIds([
      row.shopAddressId,
      row.sourceShopAddressId,
    ]);
    const mapped = mapAssignment(row, names.get(Number(row.shopAddressId)));
    if (mapped && row.sourceShopAddressId) {
      mapped.sourceShopName = names.get(Number(row.sourceShopAddressId));
    }
    return mapped;
  } catch (err) {
    console.warn(
      '[customerShopAssignment] getActiveAssignment skipped:',
      err?.message || err
    );
    return null;
  }
}

async function getActiveAssignmentShopAddressId(customerId) {
  const active = await getActiveAssignment(customerId);
  return active?.shopAddressId || null;
}

async function getCustomerLastOrderAnchor(customerId) {
  const cid = Number(customerId);
  const completed = await booking.findOne({
    where: {
      customerId: cid,
      bookingStatusId: COMPLETED,
      laundryShopId: { [Op.ne]: null },
    },
    attributes: [
      'id',
      'zoneId',
      'laundryShopId',
      'pickupAddresId',
      'createdAt',
    ],
    include: [
      {
        model: addressDb,
        as: 'pickupAddress',
        attributes: ['id', 'lat', 'lng'],
        required: false,
      },
    ],
    order: [['updatedAt', 'DESC'], ['id', 'DESC']],
  });
  if (completed) return completed;

  return booking.findOne({
    where: {
      customerId: cid,
      laundryShopId: { [Op.ne]: null },
    },
    attributes: [
      'id',
      'zoneId',
      'laundryShopId',
      'pickupAddresId',
      'createdAt',
    ],
    include: [
      {
        model: addressDb,
        as: 'pickupAddress',
        attributes: ['id', 'lat', 'lng'],
        required: false,
      },
    ],
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
  });
}

async function resolveNaturalReturningShop(customerId, zoneId) {
  const cid = Number(customerId);
  const zid = Number(zoneId);
  if (!Number.isFinite(cid) || !Number.isFinite(zid)) return null;

  const rows = await sequelize.query(
    `
    SELECT
      b.laundryShopId AS shopAddressId,
      SUM(CASE WHEN b.bookingStatusId = :completedStatus THEN 1 ELSE 0 END) AS completedOrders,
      MAX(CASE WHEN b.bookingStatusId = :completedStatus THEN b.updatedAt END) AS lastCompletedAt
    FROM bookings b
    WHERE b.customerId = :customerId
      AND b.zoneId = :zoneId
      AND b.laundryShopId IS NOT NULL
      AND b.laundryShopId NOT IN (
        SELECT e.shopAddressId FROM customerShopExclusions e WHERE e.customerId = :customerId
      )
    GROUP BY b.laundryShopId
    HAVING completedOrders > 0
    ORDER BY completedOrders DESC, lastCompletedAt DESC
    LIMIT 20
    `,
    {
      replacements: {
        customerId: cid,
        zoneId: zid,
        completedStatus: COMPLETED,
      },
      type: sequelize.QueryTypes.SELECT,
    }
  );

  const list = Array.isArray(rows) ? rows : [];
  const returning = list.find(
    (r) => Number(r.completedOrders) >= RETURNING_CUSTOMER_MIN_COMPLETED
  );
  const pick = returning || list[0];
  if (!pick?.shopAddressId) return null;

  const addr = await addressDb.findOne({
    where: {
      id: Number(pick.shopAddressId),
      addressType: 'LaundaryShopAddress',
    },
    attributes: ['id', 'userId', 'zoneId', 'status'],
  });
  if (!addr || !addr.userId) return null;
  return {
    shopAddressId: Number(addr.id),
    shopUserId: Number(addr.userId),
    completedOrders: Number(pick.completedOrders) || 0,
    isReturning:
      Number(pick.completedOrders) >= RETURNING_CUSTOMER_MIN_COMPLETED,
  };
}

async function getAssignableShopsForCustomer(customerId) {
  const cid = await assertCustomer(customerId);
  const anchor = await getCustomerLastOrderAnchor(cid);
  if (!anchor) {
    throw new ValidationError(
      'This customer has no order history to determine zone or location.'
    );
  }
  if (anchor.zoneId == null) {
    throw new ValidationError(
      'This customer’s last order has no zone. Cannot list shops.'
    );
  }

  const orderZoneId = Number(anchor.zoneId);
  let zoneName = null;
  try {
    const z = await zone.findByPk(orderZoneId, {
      attributes: ['id', 'name'],
      paranoid: false,
    });
    zoneName = z?.name ? String(z.name).trim() : null;
  } catch (_) {
    /* ignore */
  }

  const pickupAddress = anchor.pickupAddress || null;
  const active = await getActiveAssignment(cid);
  const excludedIds =
    await customerShopExclusionService.getExcludedShopAddressIds(cid);

  const shops = await addressDb.findAll({
    where: {
      zoneId: orderZoneId,
      addressType: 'LaundaryShopAddress',
      status: true,
    },
    attributes: ['id', 'userId', 'zoneId', 'status', 'lat', 'lng'],
  });

  const shopIds = shops.map((s) => s.id);
  const completedMap = new Map();
  const totalMap = new Map();
  if (shopIds.length) {
    const [completedGrouped, totalGrouped] = await Promise.all([
      booking.count({
        where: {
          customerId: cid,
          laundryShopId: { [Op.in]: shopIds },
          bookingStatusId: COMPLETED,
        },
        group: ['laundryShopId'],
      }),
      booking.count({
        where: {
          customerId: cid,
          laundryShopId: { [Op.in]: shopIds },
        },
        group: ['laundryShopId'],
      }),
    ]);
    (Array.isArray(completedGrouped) ? completedGrouped : []).forEach((row) => {
      completedMap.set(Number(row.laundryShopId), Number(row.count) || 0);
    });
    (Array.isArray(totalGrouped) ? totalGrouped : []).forEach((row) => {
      totalMap.set(Number(row.laundryShopId), Number(row.count) || 0);
    });
  }

  const bizRows = shopIds.length
    ? await bussinessInformation.findAll({
        where: { shopAddressId: shopIds },
        attributes: ['shopAddressId', 'shopName'],
        raw: true,
      })
    : [];
  const nameByShop = new Map(
    bizRows.map((b) => [Number(b.shopAddressId), b.shopName || null])
  );

  const shopList = [];
  for (const shop of shops) {
    const completed = completedMap.get(Number(shop.id)) || 0;
    const total = totalMap.get(Number(shop.id)) || 0;
    const { pickupDistanceKm: distanceKm } = await computeShopOrderDistances(
      shop.lat,
      shop.lng,
      pickupAddress,
      null
    );
    const isAssignedShop =
      active != null && Number(active.shopAddressId) === Number(shop.id);
    shopList.push({
      laundryShopId: shop.id,
      shopAddressId: shop.id,
      userId: shop.userId,
      zoneId: orderZoneId,
      zoneName,
      sameZone: true,
      distanceKm,
      shopName: nameByShop.get(Number(shop.id)) || `Shop #${shop.id}`,
      customerOrdersAtShop: completed,
      customerTotalOrdersAtShop: total,
      isReturning: completed >= RETURNING_CUSTOMER_MIN_COMPLETED,
      isExcluded: excludedIds.has(Number(shop.id)),
      isAssignedShop,
      isCurrentShop: isAssignedShop,
      canAssign: !isAssignedShop,
    });
  }

  sortAssignableShops(shopList);

  return {
    customerId: cid,
    zoneId: orderZoneId,
    zoneName,
    anchorBookingId: anchor.id,
    lastOrderAt: anchor.createdAt || null,
    pickupHasCoords: shopList.some((s) => s.distanceKm != null),
    activeAssignment: active,
    shopCount: shopList.length,
    shops: shopList,
  };
}

async function assignCustomerToShop({
  customerId,
  shopId,
  note = null,
  sourceShopId = null,
  adminId = null,
} = {}) {
  const cid = await assertCustomer(customerId);
  const { shopAddressId, shopUserId } =
    await customerShopExclusionService.resolveShopAddress(shopId);

  let sourceShopAddressId = null;
  if (sourceShopId != null && String(sourceShopId).trim() !== '') {
    const src =
      await customerShopExclusionService.resolveShopAddress(sourceShopId);
    sourceShopAddressId = src.shopAddressId;
  }

  const cleanedNote =
    note != null && String(note).trim()
      ? String(note).trim().slice(0, 500)
      : null;

  const existingActive = await customerShopAssignment.findOne({
    where: { customerId: cid, status: 'active' },
  });

  const fromShopAddressId = existingActive
    ? Number(existingActive.shopAddressId)
    : null;
  const sameTarget =
    fromShopAddressId != null && fromShopAddressId === shopAddressId;

  if (sameTarget) {
    if (cleanedNote != null) {
      await existingActive.update({ note: cleanedNote });
    }
    const names = await shopNameByAddressIds([shopAddressId]);
    return mapAssignment(existingActive, names.get(shopAddressId));
  }

  const [wasReturningAtFromShop, wasReturningAtToShop] = await Promise.all([
    fromShopAddressId
      ? isReturningAtShop(cid, fromShopAddressId)
      : Promise.resolve(null),
    isReturningAtShop(cid, shopAddressId),
  ]);

  const action = existingActive ? ACTIONS.REASSIGN : ACTIONS.ASSIGN;

  // One transaction with the customer row locked: a double submit can never
  // leave two active assignments (every active row is unlinked first).
  const created = await sequelize.transaction(async (transaction) => {
    await users.findByPk(cid, { attributes: ['id'], lock: transaction.LOCK.UPDATE, transaction });
    await customerShopAssignment.update(
      {
        status: 'unlinked',
        unlinkedByAdminId: adminId != null ? Number(adminId) : null,
        unlinkedAt: new Date(),
      },
      { where: { customerId: cid, status: 'active' }, transaction }
    );
    return customerShopAssignment.create({
      customerId: cid,
      shopAddressId,
      shopUserId,
      sourceShopAddressId,
      status: 'active',
      note: cleanedNote,
      createdByAdminId: adminId != null ? Number(adminId) : null,
    }, { transaction });
  });

  await recordRoutingEvent({
    customerId: cid,
    action,
    fromShopAddressId,
    toShopAddressId: shopAddressId,
    sourceShopAddressId,
    wasReturningAtFromShop,
    wasReturningAtToShop,
    adminId,
    note: cleanedNote,
  });

  const names = await shopNameByAddressIds([
    shopAddressId,
    sourceShopAddressId,
    fromShopAddressId,
  ]);
  const mapped = mapAssignment(created, names.get(shopAddressId));
  if (mapped && sourceShopAddressId) {
    mapped.sourceShopName = names.get(sourceShopAddressId);
  }
  // Open orders: waiting ones go to the new shop first; accepted ones elsewhere
  // are listed for the admin to reassign.
  if (mapped) {
    const { applyCustomerShopMove } = require('./customerShopMoveService');
    mapped.openOrders = await applyCustomerShopMove(cid, { keepShopAddressId: shopAddressId }).catch((err) => {
      console.warn('[assignCustomerToShop] open-order handling failed:', err?.message || err);
      return { rerouted: [], stillWithOtherShop: [] };
    });
  }
  return mapped;
}

/**
 * Unlink / relink, then deal with open orders: waiting ones are routed again;
 * on relink, orders the previous shop already accepted are listed for the admin.
 */
async function clearOrRelinkAssignment(args = {}) {
  const result = await clearOrRelinkAssignmentOnly(args);
  try {
    const { applyCustomerShopMove, reroutePendingOrders } = require('./customerShopMoveService');
    const movedAway = result.mode === 'relink' &&
      result.previousShopAddressId &&
      result.activeAssignment?.shopAddressId &&
      Number(result.activeAssignment.shopAddressId) !== Number(result.previousShopAddressId);
    result.openOrders = movedAway
      ? await applyCustomerShopMove(result.customerId, { onlyShopAddressId: result.previousShopAddressId })
      : { rerouted: await reroutePendingOrders(result.customerId), stillWithOtherShop: [] };
  } catch (err) {
    console.warn('[clearOrRelinkAssignment] open-order handling failed:', err?.message || err);
  }
  return result;
}

async function clearOrRelinkAssignmentOnly({
  customerId,
  mode = 'unlink',
  note = null,
  adminId = null,
} = {}) {
  const cid = await assertCustomer(customerId);
  const normalized = String(mode || 'unlink').toLowerCase();
  if (normalized !== 'unlink' && normalized !== 'relink') {
    throw new ValidationError('mode must be "unlink" or "relink"');
  }

  const active = await customerShopAssignment.findOne({
    where: { customerId: cid, status: 'active' },
  });
  if (!active) {
    throw new ValidationError('This customer has no active shop assignment.');
  }

  const fromShopAddressId = Number(active.shopAddressId);
  const wasReturningAtFromShop = await isReturningAtShop(
    cid,
    fromShopAddressId
  );
  const cleanedNote =
    note != null && String(note).trim()
      ? String(note).trim().slice(0, 500)
      : null;

  if (normalized === 'unlink') {
    await active.update({
      status: 'unlinked',
      unlinkedByAdminId: adminId != null ? Number(adminId) : null,
      unlinkedAt: new Date(),
      note: cleanedNote != null ? cleanedNote : active.note,
    });
    await recordRoutingEvent({
      customerId: cid,
      action: ACTIONS.UNLINK,
      fromShopAddressId,
      toShopAddressId: null,
      sourceShopAddressId: active.sourceShopAddressId,
      wasReturningAtFromShop,
      wasReturningAtToShop: null,
      adminId,
      note: cleanedNote,
    });
    return {
      mode: 'unlink',
      customerId: cid,
      previousShopAddressId: fromShopAddressId,
      activeAssignment: null,
    };
  }

  const anchor = await getCustomerLastOrderAnchor(cid);
  const zoneId = anchor?.zoneId != null ? Number(anchor.zoneId) : null;
  const natural = zoneId
    ? await resolveNaturalReturningShop(cid, zoneId)
    : null;

  if (!natural) {
    throw new ValidationError(
      'No natural returning shop found for this customer. Use unlink instead.'
    );
  }

  if (Number(natural.shopAddressId) === fromShopAddressId) {
    await active.update({
      status: 'unlinked',
      unlinkedByAdminId: adminId != null ? Number(adminId) : null,
      unlinkedAt: new Date(),
      note: cleanedNote != null ? cleanedNote : active.note,
    });
    await recordRoutingEvent({
      customerId: cid,
      action: ACTIONS.RELINK,
      fromShopAddressId,
      toShopAddressId: natural.shopAddressId,
      sourceShopAddressId: active.sourceShopAddressId,
      wasReturningAtFromShop,
      wasReturningAtToShop: natural.isReturning,
      adminId,
      note: cleanedNote || 'Cleared override; natural returning shop unchanged',
    });
    return {
      mode: 'relink',
      customerId: cid,
      previousShopAddressId: fromShopAddressId,
      activeAssignment: null,
      naturalShop: natural,
      note: 'Natural returning shop matches previous assignment; override cleared.',
    };
  }

  await active.update({
    status: 'unlinked',
    unlinkedByAdminId: adminId != null ? Number(adminId) : null,
    unlinkedAt: new Date(),
  });

  const created = await customerShopAssignment.create({
    customerId: cid,
    shopAddressId: natural.shopAddressId,
    shopUserId: natural.shopUserId,
    sourceShopAddressId: fromShopAddressId,
    status: 'active',
    note: cleanedNote || 'Relinked to natural returning shop',
    createdByAdminId: adminId != null ? Number(adminId) : null,
  });

  await recordRoutingEvent({
    customerId: cid,
    action: ACTIONS.RELINK,
    fromShopAddressId,
    toShopAddressId: natural.shopAddressId,
    sourceShopAddressId: fromShopAddressId,
    wasReturningAtFromShop,
    wasReturningAtToShop: natural.isReturning,
    adminId,
    note: cleanedNote,
  });

  const names = await shopNameByAddressIds([
    natural.shopAddressId,
    fromShopAddressId,
  ]);
  return {
    mode: 'relink',
    customerId: cid,
    previousShopAddressId: fromShopAddressId,
    activeAssignment: mapAssignment(created, names.get(natural.shopAddressId)),
    naturalShop: {
      ...natural,
      shopName: names.get(natural.shopAddressId),
    },
  };
}

async function listRoutingEventsForCustomer(customerId, { limit = 50 } = {}) {
  const cid = await assertCustomer(customerId);
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  try {
    const rows = await customerShopRoutingEvent.findAll({
      where: { customerId: cid },
      order: [['createdAt', 'DESC'], ['id', 'DESC']],
      limit: lim,
    });
    const shopIds = [];
    for (const r of rows) {
      if (r.fromShopAddressId) shopIds.push(Number(r.fromShopAddressId));
      if (r.toShopAddressId) shopIds.push(Number(r.toShopAddressId));
      if (r.sourceShopAddressId) shopIds.push(Number(r.sourceShopAddressId));
    }
    const names = await shopNameByAddressIds(shopIds);
    return rows.map((row) => {
      const p = toPlain(row);
      return {
        id: p.id,
        customerId: Number(p.customerId),
        action: p.action,
        fromShopAddressId:
          p.fromShopAddressId != null ? Number(p.fromShopAddressId) : null,
        fromShopName: p.fromShopAddressId
          ? names.get(Number(p.fromShopAddressId))
          : null,
        toShopAddressId:
          p.toShopAddressId != null ? Number(p.toShopAddressId) : null,
        toShopName: p.toShopAddressId
          ? names.get(Number(p.toShopAddressId))
          : null,
        sourceShopAddressId:
          p.sourceShopAddressId != null
            ? Number(p.sourceShopAddressId)
            : null,
        sourceShopName: p.sourceShopAddressId
          ? names.get(Number(p.sourceShopAddressId))
          : null,
        wasReturningAtFromShop: p.wasReturningAtFromShop,
        wasReturningAtToShop: p.wasReturningAtToShop,
        adminId: p.adminId != null ? Number(p.adminId) : null,
        note: p.note || null,
        createdAt: p.createdAt,
      };
    });
  } catch (err) {
    console.warn(
      '[customerShopAssignment] listRoutingEventsForCustomer skipped:',
      err?.message || err
    );
    return [];
  }
}

async function listRoutingEventsForShop(shopAddressId, { limit = 30 } = {}) {
  const sid = Number(shopAddressId);
  if (!Number.isFinite(sid) || sid <= 0) return [];
  const lim = Math.min(Math.max(Number(limit) || 30, 1), 100);
  try {
    const rows = await customerShopRoutingEvent.findAll({
      where: {
        [Op.or]: [
          { toShopAddressId: sid },
          { fromShopAddressId: sid },
          { sourceShopAddressId: sid },
        ],
      },
      order: [['createdAt', 'DESC'], ['id', 'DESC']],
      limit: lim,
    });
    const shopIds = [sid];
    const customerIds = [];
    for (const r of rows) {
      customerIds.push(Number(r.customerId));
      if (r.fromShopAddressId) shopIds.push(Number(r.fromShopAddressId));
      if (r.toShopAddressId) shopIds.push(Number(r.toShopAddressId));
    }
    const names = await shopNameByAddressIds(shopIds);
    const customers = await users.findAll({
      where: { id: [...new Set(customerIds.filter(Boolean))] },
      attributes: ['id', 'firstName', 'lastName', 'email'],
      raw: true,
    });
    const custById = new Map(customers.map((c) => [Number(c.id), c]));

    return rows.map((row) => {
      const p = toPlain(row);
      const cust = custById.get(Number(p.customerId));
      return {
        id: p.id,
        customerId: Number(p.customerId),
        customerName: cust
          ? `${cust.firstName || ''} ${cust.lastName || ''}`.trim() ||
            cust.email
          : `Customer #${p.customerId}`,
        action: p.action,
        fromShopAddressId:
          p.fromShopAddressId != null ? Number(p.fromShopAddressId) : null,
        fromShopName: p.fromShopAddressId
          ? names.get(Number(p.fromShopAddressId))
          : null,
        toShopAddressId:
          p.toShopAddressId != null ? Number(p.toShopAddressId) : null,
        toShopName: p.toShopAddressId
          ? names.get(Number(p.toShopAddressId))
          : null,
        note: p.note || null,
        wasReturningAtFromShop: p.wasReturningAtFromShop,
        wasReturningAtToShop: p.wasReturningAtToShop,
        createdAt: p.createdAt,
      };
    });
  } catch (err) {
    console.warn(
      '[customerShopAssignment] listRoutingEventsForShop skipped:',
      err?.message || err
    );
    return [];
  }
}

async function getActiveAssignmentsForCustomers(customerIds) {
  const ids = [
    ...new Set((customerIds || []).map(Number).filter((n) => n > 0)),
  ];
  const map = new Map();
  if (!ids.length) return map;
  try {
    const rows = await customerShopAssignment.findAll({
      where: { customerId: { [Op.in]: ids }, status: 'active' },
      order: [['updatedAt', 'DESC'], ['id', 'DESC']],
    });
    const shopIds = rows.map((r) => Number(r.shopAddressId));
    const names = await shopNameByAddressIds(shopIds);
    for (const row of rows) {
      const cid = Number(row.customerId);
      if (map.has(cid)) continue;
      map.set(cid, mapAssignment(row, names.get(Number(row.shopAddressId))));
    }
  } catch (err) {
    console.warn(
      '[customerShopAssignment] getActiveAssignmentsForCustomers skipped:',
      err?.message || err
    );
  }
  return map;
}

module.exports = {
  ACTIONS,
  recordRoutingEvent,
  getActiveAssignment,
  getActiveAssignmentShopAddressId,
  getAssignableShopsForCustomer,
  assignCustomerToShop,
  clearOrRelinkAssignment,
  listRoutingEventsForCustomer,
  listRoutingEventsForShop,
  getActiveAssignmentsForCustomers,
  resolveNaturalReturningShop,
};
