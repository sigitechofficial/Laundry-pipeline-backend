'use strict';

const {
  customerShopExclusion,
  addressDb,
  users,
  bussinessInformation,
} = require('../../models');
const {
  ValidationError,
  NotFoundError,
} = require('../../middlewares/universalErrorHandler');

function toPlain(row) {
  return row && typeof row.get === 'function' ? row.get({ plain: true }) : row;
}

function mapExclusion(row) {
  const p = toPlain(row);
  if (!p) return null;
  const shopName =
    p.shopName ||
    (p.shopAddressId ? `Shop #${p.shopAddressId}` : null);
  return {
    id: p.id,
    customerId: Number(p.customerId),
    shopAddressId: Number(p.shopAddressId),
    shopUserId: Number(p.shopUserId),
    shopName,
    reason: p.reason || null,
    createdByAdminId:
      p.createdByAdminId != null ? Number(p.createdByAdminId) : null,
    createdAt: p.createdAt || null,
    updatedAt: p.updatedAt || null,
  };
}

async function resolveShopAddress(shopId) {
  const id = Number(shopId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new ValidationError('Valid shop id is required');
  }

  let addr = await addressDb.findOne({
    where: { id, addressType: 'LaundaryShopAddress' },
    attributes: ['id', 'userId'],
  });
  if (!addr) {
    const biz = await bussinessInformation.findOne({
      where: { id },
      attributes: ['id', 'shopAddressId', 'agentId', 'shopName'],
    });
    if (biz?.shopAddressId) {
      addr = await addressDb.findOne({
        where: {
          id: biz.shopAddressId,
          addressType: 'LaundaryShopAddress',
        },
        attributes: ['id', 'userId'],
      });
    }
  }
  if (!addr) {
    const bizByAgent = await bussinessInformation.findOne({
      where: { agentId: id },
      attributes: ['id', 'shopAddressId', 'agentId', 'shopName'],
    });
    if (bizByAgent?.shopAddressId) {
      addr = await addressDb.findOne({
        where: {
          id: bizByAgent.shopAddressId,
          addressType: 'LaundaryShopAddress',
        },
        attributes: ['id', 'userId'],
      });
    }
  }
  if (!addr || !addr.userId) {
    throw new NotFoundError('Shop not found');
  }
  return { shopAddressId: Number(addr.id), shopUserId: Number(addr.userId) };
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

/**
 * Shop address IDs this customer must not be routed to (marketplace).
 */
async function getExcludedShopAddressIds(customerId) {
  const id = Number(customerId);
  if (!Number.isFinite(id) || id <= 0) return new Set();
  try {
    const rows = await customerShopExclusion.findAll({
      where: { customerId: id },
      attributes: ['shopAddressId'],
      raw: true,
    });
    return new Set(
      rows
        .map((r) => Number(r.shopAddressId))
        .filter((n) => Number.isFinite(n) && n > 0)
    );
  } catch (err) {
    // Table missing on a drifted DB — fail open for routing (admin can still exclude after migrate).
    console.warn(
      '[customerShopExclusion] getExcludedShopAddressIds skipped:',
      err?.message || err
    );
    return new Set();
  }
}

async function isCustomerExcludedFromShop(customerId, shopAddressId) {
  const cid = Number(customerId);
  const sid = Number(shopAddressId);
  if (!Number.isFinite(cid) || !Number.isFinite(sid)) return false;
  try {
    const row = await customerShopExclusion.findOne({
      where: { customerId: cid, shopAddressId: sid },
      attributes: ['id'],
    });
    return Boolean(row);
  } catch (err) {
    console.warn(
      '[customerShopExclusion] isCustomerExcludedFromShop skipped:',
      err?.message || err
    );
    return false;
  }
}

async function listForCustomer(customerId) {
  const id = await assertCustomer(customerId);
  const rows = await customerShopExclusion.findAll({
    where: { customerId: id },
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
  });
  const shopIds = [
    ...new Set(rows.map((r) => Number(r.shopAddressId)).filter(Boolean)),
  ];
  const nameByShop = new Map();
  if (shopIds.length) {
    const bizRows = await bussinessInformation.findAll({
      where: { shopAddressId: shopIds },
      attributes: ['shopAddressId', 'shopName'],
      raw: true,
    });
    for (const b of bizRows) {
      nameByShop.set(Number(b.shopAddressId), b.shopName || null);
    }
  }
  return rows
    .map((row) => {
      const mapped = mapExclusion(row);
      if (!mapped) return null;
      mapped.shopName =
        nameByShop.get(mapped.shopAddressId) ||
        `Shop #${mapped.shopAddressId}`;
      return mapped;
    })
    .filter(Boolean);
}

async function listForShop(shopAddressId) {
  const sid = Number(shopAddressId);
  if (!Number.isFinite(sid) || sid <= 0) return [];
  const rows = await customerShopExclusion.findAll({
    where: { shopAddressId: sid },
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    attributes: [
      'id',
      'customerId',
      'shopAddressId',
      'shopUserId',
      'reason',
      'createdByAdminId',
      'createdAt',
      'updatedAt',
    ],
  });
  return rows.map(mapExclusion).filter(Boolean);
}

async function excludeCustomerFromShop({
  customerId,
  shopId,
  reason = null,
  adminId = null,
} = {}) {
  const cid = await assertCustomer(customerId);
  const { shopAddressId, shopUserId } = await resolveShopAddress(shopId);
  const cleanedReason =
    reason != null && String(reason).trim()
      ? String(reason).trim().slice(0, 500)
      : null;

  const existing = await customerShopExclusion.findOne({
    where: { customerId: cid, shopAddressId },
  });
  if (existing) {
    await existing.update({
      reason: cleanedReason != null ? cleanedReason : existing.reason,
      shopUserId,
      createdByAdminId:
        adminId != null ? Number(adminId) : existing.createdByAdminId,
    });
    return mapExclusion(existing);
  }

  const created = await customerShopExclusion.create({
    customerId: cid,
    shopAddressId,
    shopUserId,
    reason: cleanedReason,
    createdByAdminId: adminId != null ? Number(adminId) : null,
  });

  try {
    const assignmentService = require('./customerShopAssignmentService');
    await assignmentService.recordRoutingEvent({
      customerId: cid,
      action: assignmentService.ACTIONS.EXCLUDE,
      fromShopAddressId: null,
      toShopAddressId: shopAddressId,
      adminId,
      note: cleanedReason,
    });
  } catch (err) {
    console.warn(
      '[customerShopExclusion] exclude audit skipped:',
      err?.message || err
    );
  }

  return mapExclusion(created);
}

async function includeCustomerForShop({
  customerId,
  shopId,
  adminId = null,
} = {}) {
  const cid = await assertCustomer(customerId);
  const { shopAddressId } = await resolveShopAddress(shopId);
  const existing = await customerShopExclusion.findOne({
    where: { customerId: cid, shopAddressId },
    attributes: ['id', 'reason'],
  });
  const deleted = await customerShopExclusion.destroy({
    where: { customerId: cid, shopAddressId },
  });

  if (deleted > 0) {
    try {
      const assignmentService = require('./customerShopAssignmentService');
      await assignmentService.recordRoutingEvent({
        customerId: cid,
        action: assignmentService.ACTIONS.INCLUDE,
        fromShopAddressId: shopAddressId,
        toShopAddressId: null,
        adminId,
        note: existing?.reason || null,
      });
    } catch (err) {
      console.warn(
        '[customerShopExclusion] include audit skipped:',
        err?.message || err
      );
    }
  }

  return { removed: deleted > 0, customerId: cid, shopAddressId };
}

module.exports = {
  getExcludedShopAddressIds,
  isCustomerExcludedFromShop,
  listForCustomer,
  listForShop,
  excludeCustomerFromShop,
  includeCustomerForShop,
  resolveShopAddress,
};
