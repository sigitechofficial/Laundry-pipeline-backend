'use strict';

const {
  bookingShopAssignmentEvent,
  bussinessInformation,
  users,
} = require('../../models');

function toPlain(row) {
  return row && typeof row.get === 'function' ? row.get({ plain: true }) : row;
}

async function shopNameMap(shopIds) {
  const ids = [...new Set(shopIds.filter((id) => Number.isFinite(id) && id > 0))];
  const map = new Map();
  if (!ids.length) return map;
  const rows = await bussinessInformation.findAll({
    where: { shopAddressId: ids },
    attributes: ['shopAddressId', 'shopName'],
    raw: true,
  });
  for (const row of rows) {
    map.set(Number(row.shopAddressId), row.shopName || `Shop #${row.shopAddressId}`);
  }
  for (const id of ids) {
    if (!map.has(id)) map.set(id, `Shop #${id}`);
  }
  return map;
}

/**
 * Record a shop assign / reassign. Safe when table is missing (logs + no-op).
 */
async function recordShopAssignment({
  bookingId,
  fromShopId = null,
  toShopId,
  actedByUserId = null,
  source = 'admin',
  note = null,
} = {}) {
  const bid = Number(bookingId);
  const toId = Number(toShopId);
  if (!Number.isFinite(bid) || !Number.isFinite(toId) || toId <= 0) return null;

  const fromId =
    fromShopId != null && Number(fromShopId) > 0 ? Number(fromShopId) : null;
  if (fromId != null && fromId === toId) return null;

  try {
    const row = await bookingShopAssignmentEvent.create({
      bookingId: bid,
      fromShopId: fromId,
      toShopId: toId,
      actedByUserId:
        actedByUserId != null && Number(actedByUserId) > 0
          ? Number(actedByUserId)
          : null,
      source: String(source || 'admin').slice(0, 32),
      note: note != null ? String(note).slice(0, 500) : null,
    });
    return toPlain(row);
  } catch (err) {
    console.warn(
      '[shopAssignmentAudit] record skipped:',
      err?.message || err
    );
    return null;
  }
}

async function listShopAssignmentEvents(bookingId, { limit = 50 } = {}) {
  const bid = Number(bookingId);
  if (!Number.isFinite(bid) || bid <= 0) return [];

  try {
    const rows = await bookingShopAssignmentEvent.findAll({
      where: { bookingId: bid },
      order: [['createdAt', 'ASC'], ['id', 'ASC']],
      limit: Number(limit) > 0 ? Number(limit) : 50,
      include: [
        {
          model: users,
          as: 'actedByUser',
          attributes: ['id', 'firstName', 'lastName'],
          required: false,
        },
      ],
    });

    const plain = rows.map(toPlain).filter(Boolean);
    const shopIds = [];
    for (const ev of plain) {
      if (ev.fromShopId) shopIds.push(Number(ev.fromShopId));
      if (ev.toShopId) shopIds.push(Number(ev.toShopId));
    }
    const names = await shopNameMap(shopIds);

    return plain.map((ev) => ({
      id: ev.id,
      bookingId: ev.bookingId,
      fromShopId: ev.fromShopId != null ? Number(ev.fromShopId) : null,
      toShopId: Number(ev.toShopId),
      fromShopName:
        ev.fromShopId != null ? names.get(Number(ev.fromShopId)) || null : null,
      toShopName: names.get(Number(ev.toShopId)) || `Shop #${ev.toShopId}`,
      actedByUserId:
        ev.actedByUserId != null ? Number(ev.actedByUserId) : null,
      actedByUser: ev.actedByUser || null,
      source: ev.source || 'admin',
      note: ev.note || null,
      createdAt: ev.createdAt,
      updatedAt: ev.updatedAt,
      isReassign: ev.fromShopId != null,
    }));
  } catch (err) {
    console.warn(
      '[shopAssignmentAudit] list skipped:',
      err?.message || err
    );
    return [];
  }
}

/**
 * Summary for Order Details: original shop + current (last toShop).
 */
function summarizeShopTrack(events = []) {
  if (!Array.isArray(events) || !events.length) {
    return {
      originalShopId: null,
      originalShopName: null,
      currentShopId: null,
      currentShopName: null,
      reassignCount: 0,
    };
  }
  const first = events[0];
  const last = events[events.length - 1];
  const reassignCount = events.filter((e) => e.fromShopId != null).length;
  return {
    originalShopId: first.toShopId,
    originalShopName: first.toShopName,
    currentShopId: last.toShopId,
    currentShopName: last.toShopName,
    reassignCount,
  };
}

module.exports = {
  recordShopAssignment,
  listShopAssignmentEvents,
  summarizeShopTrack,
};
