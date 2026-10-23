'use strict';

const { ValidationError } = require('../../middlewares/universalErrorHandler');
const {
  parseZoneIds,
  isPolicyActiveForZone,
  percentsForStep,
} = require('../../utils/revenueRamp');

const DISABLED = {
  enabled: false,
  applyToAllZones: true,
  zoneIds: [],
};

function shape(row) {
  const plain = typeof row?.get === 'function' ? row.get({ plain: true }) : row;
  return {
    enabled: Boolean(plain?.enabled),
    applyToAllZones: plain?.applyToAllZones !== false,
    zoneIds: parseZoneIds(plain?.zoneIds),
  };
}

async function policyModel() {
  const { revenueRampPolicy } = require('../../models');
  return revenueRampPolicy;
}

async function getSettings() {
  try {
    const revenueRampPolicy = await policyModel();
    let row = await revenueRampPolicy.findOne({ order: [['id', 'ASC']] });
    if (!row) {
      row = await revenueRampPolicy.create({
        enabled: false,
        applyToAllZones: true,
        zoneIds: '[]',
      });
    }
    return shape(row);
  } catch (err) {
    console.warn('[revenueRamp] settings unavailable:', err?.message || err);
    return { ...DISABLED };
  }
}

async function updateSettings(input) {
  const enabled = Boolean(input?.enabled);
  const applyToAllZones = input?.applyToAllZones !== false;
  const zoneIds = parseZoneIds(input?.zoneIds);
  if (enabled && !applyToAllZones && zoneIds.length === 0) {
    throw new ValidationError('Select at least one zone, or apply the ramp to all zones.');
  }

  const revenueRampPolicy = await policyModel();
  let row = await revenueRampPolicy.findOne({ order: [['id', 'ASC']] });
  const payload = {
    enabled,
    applyToAllZones,
    zoneIds: JSON.stringify(zoneIds),
  };
  if (!row) {
    row = await revenueRampPolicy.create(payload);
  } else {
    await row.update(payload);
  }
  return shape(row);
}

/**
 * A laundry shop created while the switch is on for its zone joins the ramp.
 * Shops that already exist stay on normal commission.
 */
async function markNewShopIfCovered(shopRow) {
  if (!shopRow?.id) return false;
  const type = shopRow.addressType;
  if (type && type !== 'LaundaryShopAddress') return false;
  try {
    const settings = await getSettings();
    if (!isPolicyActiveForZone(settings, shopRow.zoneId)) return false;
    const { addressDb } = require('../../models');
    await addressDb.update(
      { revenueRampEligible: true },
      { where: { id: shopRow.id } }
    );
    return true;
  } catch (err) {
    console.warn('[revenueRamp] could not mark new shop:', err?.message || err);
    return false;
  }
}

/**
 * Called inside the snapshot transaction. Increments the shop counter only
 * when this accept actually uses the ramp, so two devices cannot both take
 * step 1.
 */
async function claimSplit({ transaction, laundryShopId, zoneId, live }) {
  const normal = {
    agentCommissionPercent: Number(live?.agentCommissionPercent) || 0,
    platformCommissionPercent: Number(live?.platformCommissionPercent) || 0,
    revenueRampStep: null,
  };
  const settings = await getSettings();
  if (!isPolicyActiveForZone(settings, zoneId) || !laundryShopId) return normal;

  const { addressDb } = require('../../models');
  const shop = await addressDb.findByPk(laundryShopId, {
    transaction,
    lock: transaction.LOCK.UPDATE,
    attributes: ['id', 'revenueRampEligible', 'revenueRampOrdersTaken'],
  });
  if (!shop?.revenueRampEligible) return normal;

  const step = Number(shop.revenueRampOrdersTaken || 0) + 1;
  await shop.update({ revenueRampOrdersTaken: step }, { transaction });
  return percentsForStep(step, live);
}

module.exports = {
  getSettings,
  updateSettings,
  markNewShopIfCovered,
  claimSplit,
};
