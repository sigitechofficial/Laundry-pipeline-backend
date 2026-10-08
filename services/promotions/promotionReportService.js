'use strict';

/**
 * Reports for admins (docs/PROMOTIONS_CHECKOUT_PLAN.md, Phase 5), read from the ledger:
 * a COMMITTED redemption is a paid use with its final discount, RESERVED is a booking
 * still holding the offer, RELEASED did not go ahead, REVERSED was refunded.
 *
 * Zone staff only ever see their own zone's rows (restrictedZoneId).
 */

const { QueryTypes } = require('sequelize');
const {
  sequelize,
  promotion: Promotion,
  campaign: Campaign,
  orderAdjustment: OrderAdjustment,
  promotionRedemption: Redemption,
} = require('../../models');
const { NotFoundError } = require('../../middlewares/universalErrorHandler');

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const MAX_RANGE_DAYS = 366;

function dateRange({ from, to } = {}) {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 86400000);
  if (Number.isNaN(end.getTime()) || Number.isNaN(start.getTime())) return { start: null, end: null };
  const earliest = new Date(end.getTime() - MAX_RANGE_DAYS * 86400000);
  return { start: start < earliest ? earliest : start, end };
}

function scopeSql(alias, restrictedZoneId, replacements) {
  if (restrictedZoneId == null) return '';
  replacements.zoneId = Number(restrictedZoneId);
  return ` AND ${alias}.zoneId = :zoneId`;
}

const q = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

/** Ledger totals for a set of promotions. */
async function ledgerSummary(promotionIds, restrictedZoneId) {
  const rep = { ids: promotionIds, now: new Date() };
  const zone = scopeSql('r', restrictedZoneId, rep);
  const [row] = await q(
    `SELECT
       SUM(r.status = 'COMMITTED') AS uses,
       COALESCE(SUM(CASE WHEN r.status = 'COMMITTED' THEN r.discountAmount END), 0) AS discount,
       COUNT(DISTINCT CASE WHEN r.status = 'COMMITTED' THEN r.customerId END) AS customers,
       SUM(r.status = 'RESERVED' AND r.reservationExpiresAt > :now) AS holding,
       SUM(r.status = 'RELEASED') AS released,
       SUM(r.status = 'REVERSED') AS refunded,
       COALESCE(SUM(CASE WHEN r.status = 'REVERSED' THEN r.discountAmount END), 0) AS refundedDiscount
     FROM promotion_redemptions r
     WHERE r.promotionId IN (:ids)${zone}`,
    rep
  );
  const uses = Number(row?.uses || 0);
  const discount = money(row?.discount);
  return {
    uses,
    totalDiscount: discount,
    averageDiscount: uses ? money(discount / uses) : 0,
    uniqueCustomers: Number(row?.customers || 0),
    bookingsHolding: Number(row?.holding || 0),
    released: Number(row?.released || 0),
    refunded: Number(row?.refunded || 0),
    refundedDiscount: money(row?.refundedDiscount),
  };
}

async function byZone(promotionIds, restrictedZoneId) {
  const rep = { ids: promotionIds };
  const zone = scopeSql('r', restrictedZoneId, rep);
  const rows = await q(
    `SELECT r.zoneId, z.name AS zoneName, COUNT(*) AS uses, COALESCE(SUM(r.discountAmount), 0) AS discount,
            COUNT(DISTINCT r.customerId) AS customers
     FROM promotion_redemptions r LEFT JOIN zones z ON z.id = r.zoneId
     WHERE r.promotionId IN (:ids) AND r.status = 'COMMITTED'${zone}
     GROUP BY r.zoneId, z.name ORDER BY discount DESC`,
    rep
  );
  return rows.map((r) => ({
    zoneId: r.zoneId != null ? Number(r.zoneId) : null,
    zoneName: r.zoneName || (r.zoneId != null ? `Zone ${r.zoneId}` : 'Unknown'),
    uses: Number(r.uses),
    customers: Number(r.customers),
    discount: money(r.discount),
  }));
}

/** Paid uses per day, oldest first, with empty days filled in. */
async function byDay(promotionIds, restrictedZoneId, range) {
  if (!range.start) return [];
  const rep = { ids: promotionIds, start: range.start, end: range.end };
  const zone = scopeSql('r', restrictedZoneId, rep);
  const rows = await q(
    `SELECT DATE(r.committedAt) AS day, COUNT(*) AS uses, COALESCE(SUM(r.discountAmount), 0) AS discount
     FROM promotion_redemptions r
     WHERE r.promotionId IN (:ids) AND r.status = 'COMMITTED' AND r.committedAt BETWEEN :start AND :end${zone}
     GROUP BY DATE(r.committedAt) ORDER BY day ASC`,
    rep
  );
  const found = new Map(rows.map((r) => [String(r.day instanceof Date ? r.day.toISOString().slice(0, 10) : r.day).slice(0, 10), r]));
  const days = [];
  for (let d = new Date(range.start.toISOString().slice(0, 10)); d <= range.end; d = new Date(d.getTime() + 86400000)) {
    const key = d.toISOString().slice(0, 10);
    const r = found.get(key);
    days.push({ date: key, uses: r ? Number(r.uses) : 0, discount: r ? money(r.discount) : 0 });
  }
  return days;
}

async function byCode(promotionIds, restrictedZoneId) {
  const rep = { ids: promotionIds };
  const zone = scopeSql('r', restrictedZoneId, rep);
  const rows = await q(
    `SELECT r.couponCode AS code, COUNT(*) AS uses, COALESCE(SUM(r.discountAmount), 0) AS discount
     FROM promotion_redemptions r
     WHERE r.promotionId IN (:ids) AND r.status = 'COMMITTED' AND r.couponCode IS NOT NULL${zone}
     GROUP BY r.couponCode ORDER BY uses DESC LIMIT 50`,
    rep
  );
  return rows.map((r) => ({ code: r.code, uses: Number(r.uses), discount: money(r.discount) }));
}

async function recentUses(promotionIds, restrictedZoneId, limit = 20) {
  const rep = { ids: promotionIds, limit };
  const zone = scopeSql('r', restrictedZoneId, rep);
  const rows = await q(
    `SELECT r.id, r.bookingId, b.orderTrackId, r.customerId, r.couponCode, r.discountAmount, r.committedAt, r.zoneId, r.promotionId
     FROM promotion_redemptions r LEFT JOIN bookings b ON b.id = r.bookingId
     WHERE r.promotionId IN (:ids) AND r.status = 'COMMITTED'${zone}
     ORDER BY r.committedAt DESC LIMIT :limit`,
    rep
  );
  return rows.map((r) => ({
    redemptionId: Number(r.id),
    promotionId: Number(r.promotionId),
    bookingId: r.bookingId != null ? Number(r.bookingId) : null,
    orderTrackId: r.orderTrackId || null,
    customerId: r.customerId != null ? Number(r.customerId) : null,
    couponCode: r.couponCode || null,
    discount: money(r.discountAmount),
    paidAt: r.committedAt,
    zoneId: r.zoneId != null ? Number(r.zoneId) : null,
  }));
}

/** Full report for one promotion (caller has already checked the admin may see it). */
async function promotionReport(promotionId, { from, to, restrictedZoneId = null } = {}) {
  const promo = await Promotion.findByPk(promotionId, {
    attributes: ['id', 'name', 'status', 'benefitType', 'globalUsageLimit', 'globalUsedCount', 'globalReservedCount', 'campaignId', 'startDate', 'endDate'],
  });
  if (!promo) throw new NotFoundError('Promotion not found');
  const ids = [promo.id];
  const range = dateRange({ from, to });
  const [summary, zones, days, codes, recent] = await Promise.all([
    ledgerSummary(ids, restrictedZoneId),
    byZone(ids, restrictedZoneId),
    byDay(ids, restrictedZoneId, range),
    byCode(ids, restrictedZoneId),
    recentUses(ids, restrictedZoneId),
  ]);
  return {
    promotion: {
      id: promo.id,
      name: promo.name,
      status: promo.status,
      benefitType: promo.benefitType,
      startDate: promo.startDate,
      endDate: promo.endDate,
      usageLimit: promo.globalUsageLimit,
      usesLeft: promo.globalUsageLimit != null
        ? Math.max(0, promo.globalUsageLimit - (promo.globalUsedCount || 0) - (promo.globalReservedCount || 0))
        : null,
    },
    range: { from: range.start, to: range.end },
    summary,
    byZone: zones,
    byDay: days,
    byCode: codes,
    recent,
  };
}

/** Campaign: budget, spent, remaining, and each promotion's share. */
async function campaignReport(campaignId, { from, to, restrictedZoneId = null } = {}) {
  const camp = await Campaign.findByPk(campaignId);
  if (!camp) throw new NotFoundError('Campaign not found');
  const promos = await Promotion.findAll({ where: { campaignId: camp.id }, attributes: ['id', 'name', 'status', 'benefitType'], order: [['id', 'ASC']] });
  const ids = promos.map((p) => p.id);
  const budget = camp.budgetMinor != null ? money(camp.budgetMinor / 100) : null;
  const spent = money((camp.usedBudgetMinor || 0) / 100);
  const base = {
    campaign: {
      id: camp.id,
      name: camp.name,
      status: camp.status,
      objective: camp.objective,
      channel: camp.channel,
      startDate: camp.startDate,
      endDate: camp.endDate,
    },
    budget: {
      budget,
      spent,
      remaining: budget != null ? money(Math.max(0, budget - spent)) : null,
      percentUsed: budget ? Math.min(100, Math.round((spent / budget) * 1000) / 10) : null,
      currency: camp.currency || 'GBP',
    },
  };
  if (!ids.length) return { ...base, summary: await ledgerSummary([0], restrictedZoneId), promotions: [], byZone: [], byDay: [] };

  const range = dateRange({ from, to });
  const rep = { ids };
  const zone = scopeSql('r', restrictedZoneId, rep);
  const perPromo = await q(
    `SELECT r.promotionId, SUM(r.status = 'COMMITTED') AS uses,
            COALESCE(SUM(CASE WHEN r.status = 'COMMITTED' THEN r.discountAmount END), 0) AS discount
     FROM promotion_redemptions r WHERE r.promotionId IN (:ids)${zone} GROUP BY r.promotionId`,
    rep
  );
  const stats = new Map(perPromo.map((r) => [Number(r.promotionId), r]));
  const [summary, zones, days] = await Promise.all([
    ledgerSummary(ids, restrictedZoneId),
    byZone(ids, restrictedZoneId),
    byDay(ids, restrictedZoneId, range),
  ]);
  return {
    ...base,
    range: { from: range.start, to: range.end },
    summary,
    promotions: promos.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      benefitType: p.benefitType,
      uses: Number(stats.get(p.id)?.uses || 0),
      discount: money(stats.get(p.id)?.discount),
    })),
    byZone: zones,
    byDay: days,
  };
}

/**
 * Promotions on one order, for the admin order detail: the discount lines now on the
 * invoice and every hold/use the booking has in the ledger.
 */
async function bookingPromotions(bookingId) {
  const [lines, ledger] = await Promise.all([
    OrderAdjustment.findAll({
      where: { bookingId, appliedBy: 'system', reversedAt: null },
      attributes: ['promotionId', 'couponCode', 'lineType', 'amount', 'label'],
      order: [['id', 'ASC']],
    }),
    Redemption.findAll({
      where: { bookingId },
      include: [{ model: Promotion, as: 'promotion', attributes: ['id', 'name', 'benefitType'] }],
      order: [['id', 'ASC']],
    }),
  ]);
  const applied = new Map();
  for (const l of lines) {
    const key = Number(l.promotionId);
    const row = applied.get(key) || { promotionId: key, couponCode: l.couponCode || null, label: l.label, amount: 0 };
    row.amount = money(row.amount + Math.abs(Number(l.amount) || 0));
    applied.set(key, row);
  }
  const names = new Map(ledger.map((r) => [Number(r.promotionId), r.promotion?.name]));
  return {
    total: money([...applied.values()].reduce((s, a) => s + a.amount, 0)),
    applied: [...applied.values()].map((a) => ({ ...a, name: names.get(a.promotionId) || a.label })),
    ledger: ledger.map((r) => ({
      id: r.id,
      promotionId: Number(r.promotionId),
      name: r.promotion?.name || null,
      benefitType: r.promotion?.benefitType || null,
      couponCode: r.couponCode || null,
      status: r.status,
      discount: r.discountAmount != null ? money(r.discountAmount) : null,
      reservedAt: r.reservedAt,
      committedAt: r.committedAt,
      releasedAt: r.releasedAt,
      reversedAt: r.reversedAt,
      reason: r.reason || null,
    })),
  };
}

module.exports = { promotionReport, campaignReport, bookingPromotions };
