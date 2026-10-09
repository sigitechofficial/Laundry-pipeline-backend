'use strict';

/**
 * Admin Reports → Promotions / Campaigns: what every promotion and campaign cost
 * in a period, ranked, searchable and exportable.
 *
 * Money comes from the ledger (promotion_redemptions):
 *   paid use  = COMMITTED, counted on committedAt inside the period
 *   cost      = discount + cashback of those uses (cashback is paid as credit after delivery)
 *   refunded  = REVERSED, counted on reversedAt inside the period (not part of cost)
 *   holding   = RESERVED and not expired (booked, not paid yet; not date-bound)
 *
 * Zone staff only see promotions that run in their zone, and only their zone's money.
 */

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../models');
const { buildPeriodRange, sqlDateTime } = require('../Admin/reportQuery');

const EXPORT_MAX_ROWS = 5000;
const PROMOTION_STATUSES = ['draft', 'pending_approval', 'approved', 'scheduled', 'active', 'paused', 'expired', 'archived'];
const CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'completed', 'archived'];

const round = (v) => Math.round((Number(v) || 0) * 100) / 100;
const int = (v) => Number(v) || 0;
const q = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

function positiveInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function cleanSearch(value) {
  return value == null ? '' : String(value).trim().slice(0, 80);
}

const likeTerm = (s) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;

function paging(raw) {
  if (raw.export === true || raw.export === '1' || raw.export === 1 || raw.export === 'true') {
    return { page: 1, limit: EXPORT_MAX_ROWS, offset: 0, exporting: true };
  }
  const limit = Math.min(100, Math.max(1, positiveInt(raw.limit) || 20));
  const page = positiveInt(raw.page) || 1;
  return { page, limit, offset: (page - 1) * limit, exporting: false };
}

/** Period as SQL bounds; null range = all time. */
function periodOf(raw) {
  const period = ['today', 'this_week', 'this_month', 'custom', 'all'].includes(raw.period) ? raw.period : 'all';
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.startDate || '')) ? raw.startDate : '';
  const endDate = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.endDate || '')) ? raw.endDate : '';
  const range = buildPeriodRange(period, startDate, endDate);
  return {
    period,
    startDate: period === 'custom' ? startDate : '',
    endDate: period === 'custom' ? endDate : '',
    start: range ? sqlDateTime(range.start) : null,
    end: range ? sqlDateTime(range.end) : null,
  };
}

/** SQL condition "column inside the period" (always true for all time). */
function inPeriod(column, range) {
  return range.start ? `(${column} BETWEEN :start AND :end)` : `(${column} IS NOT NULL)`;
}

/**
 * Per-promotion ledger totals for the period (zone-filtered). Joined into both reports.
 */
function ledgerSubquery(range, zoneSql) {
  const paid = `r.status = 'COMMITTED' AND ${inPeriod('r.committedAt', range)}`;
  const refunded = `r.status = 'REVERSED' AND ${inPeriod('r.reversedAt', range)}`;
  return `
    SELECT r.promotionId,
      SUM(${paid}) AS uses,
      COALESCE(SUM(CASE WHEN ${paid} THEN r.discountAmount END), 0) AS discount,
      COALESCE(SUM(CASE WHEN ${paid} THEN r.cashbackAmount END), 0) AS cashback,
      COUNT(DISTINCT CASE WHEN ${paid} THEN r.customerId END) AS customers,
      SUM(${refunded}) AS refunds,
      COALESCE(SUM(CASE WHEN ${refunded} THEN COALESCE(r.discountAmount, 0) + COALESCE(r.cashbackAmount, 0) END), 0) AS refundedAmount,
      SUM(r.status = 'RESERVED' AND r.reservationExpiresAt > NOW()) AS holding,
      MIN(CASE WHEN ${paid} THEN r.committedAt END) AS firstUsedAt,
      MAX(CASE WHEN ${paid} THEN r.committedAt END) AS lastUsedAt
    FROM promotion_redemptions r
    WHERE 1 = 1${zoneSql}
    GROUP BY r.promotionId`;
}

/** Cashback actually credited to customers (after delivery), per promotion, for the period's paid uses. */
function creditedSubquery(range, zoneSql) {
  return `
    SELECT r.promotionId, COALESCE(SUM(e.amount), 0) AS credited
    FROM customer_credit_entries e JOIN promotion_redemptions r ON r.id = e.redemptionId
    WHERE e.type = 'EARN' AND r.status = 'COMMITTED' AND ${inPeriod('r.committedAt', range)}${zoneSql}
    GROUP BY r.promotionId`;
}

/** Promotions a zone manager may see: those that run in their zone. */
function promotionZoneVisibilitySql(alias, restrictedZoneId) {
  if (restrictedZoneId == null) return '';
  return ` AND (${alias}.zoneScopeMode = 'all'
    OR (${alias}.zoneScopeMode = 'selected' AND JSON_CONTAINS(${alias}.zoneIds, CAST(:visibleZone AS JSON)))
    OR (${alias}.zoneScopeMode = 'excluded' AND NOT JSON_CONTAINS(COALESCE(${alias}.zoneIds, JSON_ARRAY()), CAST(:visibleZone AS JSON))))`;
}

const PROMOTION_SORTS = {
  cost: 'cost',
  uses: 'uses',
  customers: 'customers',
  discount: 'discount',
  cashback: 'cashback',
  average: 'averageCost',
  refunds: 'refundedAmount',
  last_used: 'lastUsedAt',
  name: 'name',
  newest: 'id',
};

function orderBy(sorts, rawSort, rawDir, fallback) {
  const key = sorts[rawSort] ? rawSort : fallback;
  const dir = rawDir === 'asc' || rawDir === 'desc' ? rawDir : key === 'name' ? 'asc' : 'desc';
  // Ties: most spent first, then newest — stable pages.
  return { key, dir, sql: `${sorts[key]} ${dir.toUpperCase()}, cost DESC, id DESC` };
}

/**
 * GET /admin/reports/promotions
 * Filters: period/startDate/endDate, search (name, coupon code, campaign, #id), status,
 * campaignId (or "none"), benefitType, zoneId, onlyUsed, sort/dir, page/limit, export=1.
 */
async function promotionPerformance(raw = {}, { restrictedZoneId = null } = {}) {
  const range = periodOf(raw);
  const pg = paging(raw);
  const zoneId = restrictedZoneId ?? positiveInt(raw.zoneId);
  const rep = { start: range.start, end: range.end };
  const zoneSql = zoneId != null ? ' AND r.zoneId = :zoneId' : '';
  if (zoneId != null) rep.zoneId = zoneId;

  const where = ['1 = 1'];
  const status = PROMOTION_STATUSES.includes(raw.status) ? raw.status : null;
  if (status) { where.push('p.status = :status'); rep.status = status; }
  const benefitType = /^[a-z_]{3,40}$/.test(String(raw.benefitType || '')) ? raw.benefitType : null;
  if (benefitType) { where.push('p.benefitType = :benefitType'); rep.benefitType = benefitType; }
  if (raw.campaignId === 'none') where.push('p.campaignId IS NULL');
  else if (positiveInt(raw.campaignId)) { where.push('p.campaignId = :campaignId'); rep.campaignId = positiveInt(raw.campaignId); }
  const search = cleanSearch(raw.search);
  if (search) {
    rep.term = likeTerm(search);
    rep.searchId = positiveInt(search.replace(/^#/, '')) || 0;
    where.push(`(p.name LIKE :term OR c.name LIKE :term OR p.id = :searchId
      OR EXISTS (SELECT 1 FROM coupon_codes cc WHERE cc.promotionId = p.id AND cc.code LIKE :term))`);
  }
  if (restrictedZoneId != null) rep.visibleZone = String(restrictedZoneId);
  const onlyUsed = raw.onlyUsed === '1' || raw.onlyUsed === 'true' || raw.onlyUsed === true;
  if (onlyUsed) where.push('(COALESCE(s.uses, 0) > 0 OR COALESCE(s.refunds, 0) > 0)');

  const base = `
    FROM promotions p
    LEFT JOIN campaigns c ON c.id = p.campaignId
    LEFT JOIN (${ledgerSubquery(range, zoneSql)}) s ON s.promotionId = p.id
    LEFT JOIN (${creditedSubquery(range, zoneSql)}) cr ON cr.promotionId = p.id
    WHERE ${where.join(' AND ')}${promotionZoneVisibilitySql('p', restrictedZoneId)}`;

  const rowSql = `
    SELECT p.id, p.name, p.status, p.benefitType, p.activationType, p.campaignId, c.name AS campaignName,
      p.startDate, p.endDate, p.globalUsageLimit, p.globalUsedCount, p.createdAt,
      (SELECT GROUP_CONCAT(cc.code ORDER BY cc.id SEPARATOR ', ') FROM coupon_codes cc WHERE cc.promotionId = p.id) AS codes,
      COALESCE(s.uses, 0) AS uses, COALESCE(s.customers, 0) AS customers,
      COALESCE(s.discount, 0) AS discount, COALESCE(s.cashback, 0) AS cashback,
      COALESCE(s.discount, 0) + COALESCE(s.cashback, 0) AS cost,
      CASE WHEN COALESCE(s.uses, 0) > 0 THEN (COALESCE(s.discount, 0) + COALESCE(s.cashback, 0)) / s.uses ELSE 0 END AS averageCost,
      COALESCE(cr.credited, 0) AS cashbackCredited,
      COALESCE(s.refunds, 0) AS refunds, COALESCE(s.refundedAmount, 0) AS refundedAmount,
      COALESCE(s.holding, 0) AS holding, s.firstUsedAt, s.lastUsedAt
    ${base}`;

  const sort = orderBy(PROMOTION_SORTS, raw.sort, raw.dir, 'cost');
  const [rows, [totals], [people], byBenefit] = await Promise.all([
    q(`${rowSql} ORDER BY ${sort.sql} LIMIT :limit OFFSET :offset`, { ...rep, limit: pg.limit, offset: pg.offset }),
    q(`SELECT COUNT(*) AS promotions, SUM(t.uses > 0) AS promotionsUsed, SUM(t.uses) AS uses,
              SUM(t.discount) AS discount, SUM(t.cashback) AS cashback, SUM(t.cashbackCredited) AS cashbackCredited,
              SUM(t.refunds) AS refunds, SUM(t.refundedAmount) AS refundedAmount, SUM(t.holding) AS holding
       FROM (${rowSql}) t`, rep),
    // Distinct customers across the whole filtered set (one customer may use several promotions).
    q(`SELECT COUNT(DISTINCT r.customerId) AS customers, COUNT(DISTINCT r.bookingId) AS orders
       FROM promotion_redemptions r
       WHERE r.status = 'COMMITTED' AND ${inPeriod('r.committedAt', range)}${zoneSql}
         AND r.promotionId IN (SELECT t.id FROM (${rowSql}) t)`, rep),
    q(`SELECT t.benefitType, COUNT(*) AS promotions, SUM(t.uses) AS uses, SUM(t.cost) AS cost
       FROM (${rowSql}) t GROUP BY t.benefitType HAVING SUM(t.uses) > 0 ORDER BY SUM(t.cost) DESC`, rep),
  ]);
  const [top] = await q(`${rowSql} AND COALESCE(s.uses, 0) > 0 ORDER BY cost DESC, id DESC LIMIT 1`, rep);

  const total = int(totals?.promotions);
  const discount = round(totals?.discount);
  const cashback = round(totals?.cashback);
  const uses = int(totals?.uses);
  return {
    data: rows.map(mapPromotionRow),
    total,
    page: pg.page,
    limit: pg.limit,
    truncated: pg.exporting && total > EXPORT_MAX_ROWS,
    summary: {
      promotions: total,
      promotionsUsed: int(totals?.promotionsUsed),
      uses,
      orders: int(people?.orders),
      customers: int(people?.customers),
      discount,
      cashback,
      cost: round(discount + cashback),
      averageCost: uses ? round((discount + cashback) / uses) : 0,
      cashbackCredited: round(totals?.cashbackCredited),
      cashbackPending: round(Math.max(0, cashback - Number(totals?.cashbackCredited || 0))),
      refunds: int(totals?.refunds),
      refundedAmount: round(totals?.refundedAmount),
      holding: int(totals?.holding),
      topSpender: top ? { id: Number(top.id), name: top.name, cost: round(top.cost) } : null,
      byBenefitType: byBenefit.map((b) => ({
        benefitType: b.benefitType, promotions: int(b.promotions), uses: int(b.uses), cost: round(b.cost),
      })),
    },
    currency: { currencySymbol: '£', currencyCode: 'GBP' },
    filters: {
      period: range.period, startDate: range.startDate, endDate: range.endDate, zoneId,
      search, status, benefitType, campaignId: raw.campaignId || null, onlyUsed, sort: sort.key, dir: sort.dir,
    },
  };
}

function mapPromotionRow(r) {
  const uses = int(r.uses);
  const cashback = round(r.cashback);
  return {
    id: Number(r.id),
    name: r.name,
    status: r.status,
    benefitType: r.benefitType,
    activationType: r.activationType,
    campaignId: r.campaignId != null ? Number(r.campaignId) : null,
    campaignName: r.campaignName || null,
    codes: r.codes || '',
    startDate: r.startDate,
    endDate: r.endDate,
    usageLimit: r.globalUsageLimit != null ? Number(r.globalUsageLimit) : null,
    usedAllTime: int(r.globalUsedCount),
    uses,
    customers: int(r.customers),
    discount: round(r.discount),
    cashback,
    cost: round(r.cost),
    averageCost: round(r.averageCost),
    cashbackCredited: round(r.cashbackCredited),
    cashbackPending: round(Math.max(0, cashback - Number(r.cashbackCredited || 0))),
    refunds: int(r.refunds),
    refundedAmount: round(r.refundedAmount),
    holding: int(r.holding),
    firstUsedAt: r.firstUsedAt || null,
    lastUsedAt: r.lastUsedAt || null,
    createdAt: r.createdAt,
  };
}

const CAMPAIGN_SORTS = {
  cost: 'cost',
  uses: 'uses',
  customers: 'customers',
  budget: 'budget',
  budget_used: 'percentUsed',
  promotions: 'promotions',
  name: 'name',
  newest: 'id',
};

/**
 * GET /admin/reports/campaigns
 * Filters: period/startDate/endDate, search (name, objective, channel, promotion name), status,
 * objective, channel, zoneId, onlyUsed, sort/dir, page/limit, export=1.
 * "Spent in period" comes from the ledger; "budget used" is the campaign's lifetime counter.
 */
async function campaignPerformance(raw = {}, { restrictedZoneId = null } = {}) {
  const range = periodOf(raw);
  const pg = paging(raw);
  const zoneId = restrictedZoneId ?? positiveInt(raw.zoneId);
  const rep = { start: range.start, end: range.end };
  const zoneSql = zoneId != null ? ' AND r.zoneId = :zoneId' : '';
  if (zoneId != null) rep.zoneId = zoneId;
  if (restrictedZoneId != null) rep.visibleZone = String(restrictedZoneId);

  const where = ['1 = 1'];
  const status = CAMPAIGN_STATUSES.includes(raw.status) ? raw.status : null;
  if (status) { where.push('c.status = :status'); rep.status = status; }
  for (const key of ['objective', 'channel']) {
    if (/^[a-z_]{2,40}$/.test(String(raw[key] || ''))) { where.push(`c.${key} = :${key}`); rep[key] = raw[key]; }
  }
  const search = cleanSearch(raw.search);
  if (search) {
    rep.term = likeTerm(search);
    rep.searchId = positiveInt(search.replace(/^#/, '')) || 0;
    where.push(`(c.name LIKE :term OR c.objective LIKE :term OR c.channel LIKE :term OR c.id = :searchId
      OR EXISTS (SELECT 1 FROM promotions sp WHERE sp.campaignId = c.id AND sp.name LIKE :term))`);
  }
  const onlyUsed = raw.onlyUsed === '1' || raw.onlyUsed === 'true' || raw.onlyUsed === true;

  // Promotions the admin may see, with their period totals, rolled up per campaign.
  const perPromotion = `
    SELECT p.campaignId,
      COUNT(*) AS promotions, SUM(p.status = 'active') AS activePromotions,
      SUM(COALESCE(s.uses, 0)) AS uses, SUM(COALESCE(s.discount, 0)) AS discount,
      SUM(COALESCE(s.cashback, 0)) AS cashback, SUM(COALESCE(s.refunds, 0)) AS refunds,
      SUM(COALESCE(s.refundedAmount, 0)) AS refundedAmount,
      MAX(s.lastUsedAt) AS lastUsedAt
    FROM promotions p
    LEFT JOIN (${ledgerSubquery(range, zoneSql)}) s ON s.promotionId = p.id
    WHERE p.campaignId IS NOT NULL${promotionZoneVisibilitySql('p', restrictedZoneId)}
    GROUP BY p.campaignId`;
  const customersPerCampaign = `
    SELECT p.campaignId, COUNT(DISTINCT r.customerId) AS customers
    FROM promotion_redemptions r JOIN promotions p ON p.id = r.promotionId
    WHERE p.campaignId IS NOT NULL AND r.status = 'COMMITTED' AND ${inPeriod('r.committedAt', range)}${zoneSql}
    GROUP BY p.campaignId`;
  if (onlyUsed) where.push('(COALESCE(pp.uses, 0) > 0 OR COALESCE(pp.refunds, 0) > 0)');

  const rowSql = `
    SELECT c.id, c.name, c.status, c.objective, c.channel, c.startDate, c.endDate, c.currency, c.createdAt,
      c.budgetMinor / 100 AS budget, COALESCE(c.usedBudgetMinor, 0) / 100 AS budgetUsed,
      CASE WHEN c.budgetMinor > 0 THEN LEAST(100, ROUND(COALESCE(c.usedBudgetMinor, 0) * 100 / c.budgetMinor, 1)) ELSE NULL END AS percentUsed,
      COALESCE(pp.promotions, 0) AS promotions, COALESCE(pp.activePromotions, 0) AS activePromotions,
      COALESCE(pp.uses, 0) AS uses, COALESCE(cu.customers, 0) AS customers,
      COALESCE(pp.discount, 0) AS discount, COALESCE(pp.cashback, 0) AS cashback,
      COALESCE(pp.discount, 0) + COALESCE(pp.cashback, 0) AS cost,
      COALESCE(pp.refunds, 0) AS refunds, COALESCE(pp.refundedAmount, 0) AS refundedAmount, pp.lastUsedAt
    FROM campaigns c
    LEFT JOIN (${perPromotion}) pp ON pp.campaignId = c.id
    LEFT JOIN (${customersPerCampaign}) cu ON cu.campaignId = c.id
    WHERE ${where.join(' AND ')}`;

  const sort = orderBy(CAMPAIGN_SORTS, raw.sort, raw.dir, 'cost');
  const [rows, [totals], [noCampaign]] = await Promise.all([
    q(`${rowSql} ORDER BY ${sort.sql} LIMIT :limit OFFSET :offset`, { ...rep, limit: pg.limit, offset: pg.offset }),
    q(`SELECT COUNT(*) AS campaigns, SUM(t.uses > 0) AS campaignsUsed, SUM(t.uses) AS uses,
              SUM(t.discount) AS discount, SUM(t.cashback) AS cashback, SUM(t.budget) AS budget,
              SUM(t.budgetUsed) AS budgetUsed, SUM(t.refundedAmount) AS refundedAmount,
              SUM(t.percentUsed >= 100) AS budgetsUsedUp
       FROM (${rowSql}) t`, rep),
    // Spend from promotions that belong to no campaign (so the totals add up).
    q(`SELECT COUNT(*) AS promotions, SUM(COALESCE(s.uses, 0)) AS uses,
              SUM(COALESCE(s.discount, 0) + COALESCE(s.cashback, 0)) AS cost
       FROM promotions p LEFT JOIN (${ledgerSubquery(range, zoneSql)}) s ON s.promotionId = p.id
       WHERE p.campaignId IS NULL${promotionZoneVisibilitySql('p', restrictedZoneId)}`, rep),
  ]);
  const [top] = await q(`${rowSql} AND COALESCE(pp.uses, 0) > 0 ORDER BY cost DESC, id DESC LIMIT 1`, rep);

  const total = int(totals?.campaigns);
  const discount = round(totals?.discount);
  const cashback = round(totals?.cashback);
  return {
    data: rows.map(mapCampaignRow),
    total,
    page: pg.page,
    limit: pg.limit,
    truncated: pg.exporting && total > EXPORT_MAX_ROWS,
    summary: {
      campaigns: total,
      campaignsUsed: int(totals?.campaignsUsed),
      uses: int(totals?.uses),
      discount,
      cashback,
      cost: round(discount + cashback),
      budget: round(totals?.budget),
      budgetUsed: round(totals?.budgetUsed),
      budgetsUsedUp: int(totals?.budgetsUsedUp),
      refundedAmount: round(totals?.refundedAmount),
      topSpender: top ? { id: Number(top.id), name: top.name, cost: round(top.cost) } : null,
      notInCampaign: { promotions: int(noCampaign?.promotions), uses: int(noCampaign?.uses), cost: round(noCampaign?.cost) },
    },
    currency: { currencySymbol: '£', currencyCode: 'GBP' },
    filters: {
      period: range.period, startDate: range.startDate, endDate: range.endDate, zoneId,
      search, status, objective: rep.objective || null, channel: rep.channel || null, onlyUsed, sort: sort.key, dir: sort.dir,
    },
  };
}

function mapCampaignRow(r) {
  const budget = r.budget != null ? round(r.budget) : null;
  const budgetUsed = round(r.budgetUsed);
  return {
    id: Number(r.id),
    name: r.name,
    status: r.status,
    objective: r.objective || null,
    channel: r.channel || null,
    startDate: r.startDate,
    endDate: r.endDate,
    currency: r.currency || 'GBP',
    budget,
    budgetUsed,
    budgetRemaining: budget != null ? round(Math.max(0, budget - budgetUsed)) : null,
    percentUsed: r.percentUsed != null ? Number(r.percentUsed) : null,
    promotions: int(r.promotions),
    activePromotions: int(r.activePromotions),
    uses: int(r.uses),
    customers: int(r.customers),
    discount: round(r.discount),
    cashback: round(r.cashback),
    cost: round(r.cost),
    refunds: int(r.refunds),
    refundedAmount: round(r.refundedAmount),
    lastUsedAt: r.lastUsedAt || null,
    createdAt: r.createdAt,
  };
}

module.exports = { promotionPerformance, campaignPerformance, EXPORT_MAX_ROWS };
