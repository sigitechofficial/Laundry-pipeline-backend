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
  customerCreditEntry: CreditEntry,
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

/**
 * " AND <col> BETWEEN …" when the report is limited to its date range (inRange),
 * '' for all-time figures (the default, as before).
 */
function periodSql(period, column, replacements) {
  if (!period?.start) return '';
  replacements.periodStart = period.start;
  replacements.periodEnd = period.end;
  return ` AND ${column} BETWEEN :periodStart AND :periodEnd`;
}

/** Ledger totals for a set of promotions. */
async function ledgerSummary(promotionIds, restrictedZoneId, period = null) {
  const rep = { ids: promotionIds, now: new Date() };
  const zone = scopeSql('r', restrictedZoneId, rep);
  // In-range mode: uses on their paid date, refunds on their refund date, releases on theirs.
  const paid = `r.status = 'COMMITTED'${periodSql(period, 'r.committedAt', rep)}`;
  const reversed = `r.status = 'REVERSED'${periodSql(period, 'r.reversedAt', rep)}`;
  const released = `r.status = 'RELEASED'${periodSql(period, 'r.releasedAt', rep)}`;
  const [row] = await q(
    `SELECT
       SUM(${paid}) AS uses,
       COALESCE(SUM(CASE WHEN ${paid} THEN r.discountAmount END), 0) AS discount,
       COUNT(DISTINCT CASE WHEN ${paid} THEN r.customerId END) AS customers,
       SUM(r.status = 'RESERVED' AND r.reservationExpiresAt > :now) AS holding,
       SUM(${released}) AS released,
       SUM(${reversed}) AS refunded,
       COALESCE(SUM(CASE WHEN ${reversed} THEN r.discountAmount END), 0) AS refundedDiscount,
       COALESCE(SUM(CASE WHEN ${reversed} THEN r.cashbackAmount END), 0) AS refundedCashback,
       COALESCE(SUM(CASE WHEN ${paid} THEN r.cashbackAmount END), 0) AS cashback
     FROM promotion_redemptions r
     WHERE r.promotionId IN (:ids)${zone}`,
    rep
  );
  // Cashback reaches the customer as credit after delivery (customer_credit_entries).
  const [credited] = await q(
    `SELECT COALESCE(SUM(e.amount), 0) AS credited
     FROM customer_credit_entries e JOIN promotion_redemptions r ON r.id = e.redemptionId
     WHERE e.type = 'EARN' AND r.promotionId IN (:ids) AND r.status = 'COMMITTED'${zone}${periodSql(period, 'r.committedAt', rep)}`,
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
    refundedCashback: money(row?.refundedCashback),
    totalCashback: money(row?.cashback),
    cashbackCredited: money(credited?.credited),
    cashbackPending: money(Math.max(0, Number(row?.cashback || 0) - Number(credited?.credited || 0))),
  };
}

async function byZone(promotionIds, restrictedZoneId, period = null) {
  const rep = { ids: promotionIds };
  const zone = scopeSql('r', restrictedZoneId, rep) + periodSql(period, 'r.committedAt', rep);
  const rows = await q(
    `SELECT r.zoneId, z.name AS zoneName, COUNT(*) AS uses, COALESCE(SUM(r.discountAmount), 0) AS discount,
            COALESCE(SUM(r.cashbackAmount), 0) AS cashback, COUNT(DISTINCT r.customerId) AS customers
     FROM promotion_redemptions r LEFT JOIN zones z ON z.id = r.zoneId
     WHERE r.promotionId IN (:ids) AND r.status = 'COMMITTED'${zone}
     GROUP BY r.zoneId, z.name ORDER BY COALESCE(SUM(r.discountAmount), 0) + COALESCE(SUM(r.cashbackAmount), 0) DESC`,
    rep
  );
  return rows.map((r) => ({
    zoneId: r.zoneId != null ? Number(r.zoneId) : null,
    zoneName: r.zoneName || (r.zoneId != null ? `Zone ${r.zoneId}` : 'Unknown'),
    uses: Number(r.uses),
    customers: Number(r.customers),
    discount: money(r.discount),
    cashback: money(r.cashback),
  }));
}

/** Paid uses per day, oldest first, with empty days filled in. */
async function byDay(promotionIds, restrictedZoneId, range) {
  if (!range.start) return [];
  const rep = { ids: promotionIds, start: range.start, end: range.end };
  const zone = scopeSql('r', restrictedZoneId, rep);
  const rows = await q(
    `SELECT DATE(r.committedAt) AS day, COUNT(*) AS uses, COALESCE(SUM(r.discountAmount), 0) AS discount,
            COALESCE(SUM(r.cashbackAmount), 0) AS cashback
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
    days.push({ date: key, uses: r ? Number(r.uses) : 0, discount: r ? money(r.discount) : 0, cashback: r ? money(r.cashback) : 0 });
  }
  return days;
}

async function byCode(promotionIds, restrictedZoneId, period = null) {
  const rep = { ids: promotionIds };
  const zone = scopeSql('r', restrictedZoneId, rep) + periodSql(period, 'r.committedAt', rep);
  const rows = await q(
    `SELECT r.couponCode AS code, COUNT(*) AS uses, COALESCE(SUM(r.discountAmount), 0) AS discount,
            COALESCE(SUM(r.cashbackAmount), 0) AS cashback
     FROM promotion_redemptions r
     WHERE r.promotionId IN (:ids) AND r.status = 'COMMITTED' AND r.couponCode IS NOT NULL${zone}
     GROUP BY r.couponCode ORDER BY uses DESC LIMIT 50`,
    rep
  );
  return rows.map((r) => ({ code: r.code, uses: Number(r.uses), discount: money(r.discount), cashback: money(r.cashback) }));
}

async function recentUses(promotionIds, restrictedZoneId, limit = 20, period = null) {
  const rep = { ids: promotionIds, limit };
  const zone = scopeSql('r', restrictedZoneId, rep) + periodSql(period, 'r.committedAt', rep);
  const rows = await q(
    `SELECT r.id, r.bookingId, b.orderTrackId, r.customerId, r.couponCode, r.discountAmount, r.cashbackAmount, r.committedAt, r.zoneId, r.promotionId,
            TRIM(CONCAT(COALESCE(u.firstName, ''), ' ', COALESCE(u.lastName, ''))) AS customerName, z.name AS zoneName
     FROM promotion_redemptions r LEFT JOIN bookings b ON b.id = r.bookingId
     LEFT JOIN users u ON u.id = r.customerId LEFT JOIN zones z ON z.id = r.zoneId
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
    customerName: r.customerName || null,
    couponCode: r.couponCode || null,
    discount: money(r.discountAmount),
    cashback: money(r.cashbackAmount),
    paidAt: r.committedAt,
    zoneId: r.zoneId != null ? Number(r.zoneId) : null,
    zoneName: r.zoneName || null,
  }));
}

/** inRange / recentLimit options shared by the promotion and campaign reports. */
function reportOptions(range, { inRange = false, recentLimit } = {}) {
  const on = inRange === true || inRange === '1' || inRange === 'true';
  const n = parseInt(recentLimit, 10);
  return {
    period: on && range.start ? { start: range.start, end: range.end } : null,
    recentLimit: Number.isFinite(n) && n > 0 ? Math.min(5000, n) : 20,
  };
}

/** Full report for one promotion (caller has already checked the admin may see it). */
async function promotionReport(promotionId, { from, to, restrictedZoneId = null, inRange, recentLimit } = {}) {
  const promo = await Promotion.findByPk(promotionId, {
    attributes: ['id', 'name', 'status', 'benefitType', 'globalUsageLimit', 'globalUsedCount', 'globalReservedCount', 'campaignId', 'startDate', 'endDate'],
  });
  if (!promo) throw new NotFoundError('Promotion not found');
  const ids = [promo.id];
  const range = dateRange({ from, to });
  const opt = reportOptions(range, { inRange, recentLimit });
  const [summary, zones, days, codes, recent] = await Promise.all([
    ledgerSummary(ids, restrictedZoneId, opt.period),
    byZone(ids, restrictedZoneId, opt.period),
    byDay(ids, restrictedZoneId, range),
    byCode(ids, restrictedZoneId, opt.period),
    recentUses(ids, restrictedZoneId, opt.recentLimit, opt.period),
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
    // true: every figure is for the range; false: summary/zones/codes are all time, byDay is the range.
    inRange: Boolean(opt.period),
    summary,
    byZone: zones,
    byDay: days,
    byCode: codes,
    recent,
  };
}

/** Campaign: budget, spent, remaining, and each promotion's share. */
async function campaignReport(campaignId, { from, to, restrictedZoneId = null, inRange } = {}) {
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
  const opt = reportOptions(range, { inRange });
  const rep = { ids };
  const zone = scopeSql('r', restrictedZoneId, rep) + periodSql(opt.period, 'r.committedAt', rep);
  const perPromo = await q(
    `SELECT r.promotionId, SUM(r.status = 'COMMITTED') AS uses,
            COALESCE(SUM(CASE WHEN r.status = 'COMMITTED' THEN r.discountAmount END), 0) AS discount,
            COALESCE(SUM(CASE WHEN r.status = 'COMMITTED' THEN r.cashbackAmount END), 0) AS cashback
     FROM promotion_redemptions r WHERE r.promotionId IN (:ids)${zone} GROUP BY r.promotionId`,
    rep
  );
  const stats = new Map(perPromo.map((r) => [Number(r.promotionId), r]));
  const [summary, zones, days] = await Promise.all([
    ledgerSummary(ids, restrictedZoneId, opt.period),
    byZone(ids, restrictedZoneId, opt.period),
    byDay(ids, restrictedZoneId, range),
  ]);
  return {
    ...base,
    range: { from: range.start, to: range.end },
    inRange: Boolean(opt.period),
    summary,
    promotions: promos.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      benefitType: p.benefitType,
      uses: Number(stats.get(p.id)?.uses || 0),
      discount: money(stats.get(p.id)?.discount),
      cashback: money(stats.get(p.id)?.cashback),
    })),
    byZone: zones,
    byDay: days,
  };
}

/** "subCategory:12" / "addon:3" → catalog name, for the order's discount lines. */
async function lineItemNames(lines) {
  const ids = { subCategory: new Set(), addon: new Set() };
  for (const l of lines) {
    if (l.lineItemId != null && ids[l.lineType]) ids[l.lineType].add(Number(l.lineItemId));
  }
  const names = new Map();
  const models = require('../../models');
  const [items, addons] = await Promise.all([
    ids.subCategory.size ? models.subCategories.findAll({ where: { id: [...ids.subCategory] }, attributes: ['id', 'name'], paranoid: false }) : [],
    ids.addon.size ? models.addOnServices.findAll({ where: { id: [...ids.addon] }, attributes: ['id', 'name'], paranoid: false }) : [],
  ]);
  for (const r of items) names.set(`subCategory:${r.id}`, r.name);
  for (const r of addons) names.set(`addon:${r.id}`, r.name);
  return names;
}

/**
 * Promotions on one order, for the admin order detail: the discount lines now on the
 * invoice and every hold/use the booking has in the ledger.
 */
async function bookingPromotions(bookingId) {
  const [lines, ledger, creditRows] = await Promise.all([
    OrderAdjustment.findAll({
      where: { bookingId, appliedBy: 'system', reversedAt: null },
      attributes: ['promotionId', 'couponCode', 'lineType', 'lineItemId', 'amount', 'label', 'description'],
      order: [['id', 'ASC']],
    }),
    Redemption.findAll({
      where: { bookingId },
      include: [{ model: Promotion, as: 'promotion', attributes: ['id', 'name', 'benefitType'] }],
      order: [['id', 'ASC']],
    }),
    CreditEntry.findAll({ where: { bookingId }, order: [['id', 'ASC']] }),
  ]);
  const itemNames = await lineItemNames(lines);
  const applied = new Map();
  for (const l of lines) {
    const key = Number(l.promotionId);
    const row = applied.get(key) || { promotionId: key, couponCode: l.couponCode || null, label: l.label, amount: 0, lines: [] };
    const amount = money(Math.abs(Number(l.amount) || 0));
    row.amount = money(row.amount + amount);
    // Where the discount landed: each item / add-on, the delivery fee or the whole basket.
    row.lines.push({
      lineType: l.lineType,
      lineItemId: l.lineItemId != null ? Number(l.lineItemId) : null,
      item: l.lineType === 'delivery' ? 'Delivery fee'
        : l.lineType === 'basket' ? 'Whole order'
        : itemNames.get(`${l.lineType}:${l.lineItemId}`) || `${l.lineType} #${l.lineItemId}`,
      label: l.label || l.description || null,
      amount,
    });
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
      cashback: r.cashbackAmount != null ? money(r.cashbackAmount) : null,
      reservedAt: r.reservedAt,
      committedAt: r.committedAt,
      releasedAt: r.releasedAt,
      reversedAt: r.reversedAt,
      reason: r.reason || null,
    })),
    credit: {
      // Credit the customer used to pay this order (held until paid).
      used: money(creditRows.filter((e) => e.type === 'SPEND' && ['HELD', 'COMMITTED'].includes(e.status))
        .reduce((sum, e) => sum + Math.abs(Number(e.amount)), 0)),
      usedStatus: creditRows.find((e) => e.type === 'SPEND' && e.status === 'COMMITTED') ? 'paid'
        : creditRows.find((e) => e.type === 'SPEND' && e.status === 'HELD') ? 'held' : null,
      // Cashback this order earned (credited after delivery) and anything taken back.
      cashbackCredited: money(creditRows.filter((e) => e.type === 'EARN').reduce((sum, e) => sum + Number(e.amount), 0)),
      cashbackTakenBack: money(creditRows.filter((e) => e.type === 'REVERSE').reduce((sum, e) => sum + Math.abs(Number(e.amount)), 0)),
      creditReturned: money(creditRows.filter((e) => e.type === 'RESTORE').reduce((sum, e) => sum + Number(e.amount), 0)),
      entries: creditRows.filter((e) => !(e.type === 'SPEND' && e.status === 'RELEASED')).map((e) => ({
        id: e.id, type: e.type, status: e.status, amount: Number(e.amount), description: e.description, createdAt: e.createdAt,
      })),
    },
  };
}

module.exports = { promotionReport, campaignReport, bookingPromotions };
