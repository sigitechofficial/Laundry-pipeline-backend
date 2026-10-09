'use strict';

const promoService = require('../../services/Admin/promotionAdminService');
const { buildPromotionContext } = require('../../services/promotions/contextBuilder');
const { simulatePromotions } = require('../../services/promotions/promotionEngine');
const { detectConflicts } = require('../../services/promotions/stackingResolver');
const { ValidationError } = require('../../middlewares/universalErrorHandler');

/** Zone/role scope set by checkPermission — zone staff only see their zone. */
const scopeOf = (req) => req.adminAuthz || null;

module.exports = {
  // ─── Promotion CRUD ──────────────────────────────────────────────────────

  async create(req, res) {
    const row = await promoService.createPromotion(req.body, req.user?.id, scopeOf(req));
    res.status(201).json({ success: true, data: row });
  },

  async list(req, res) {
    const result = await promoService.listPromotions(req.query, scopeOf(req));
    res.json({ success: true, ...result });
  },

  async getById(req, res) {
    const row = await promoService.getPromotionById(req.params.id, scopeOf(req));
    res.json({ success: true, data: row });
  },

  async update(req, res) {
    const row = await promoService.updatePromotion(req.params.id, req.body, req.user?.id, scopeOf(req));
    res.json({ success: true, data: row });
  },

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  async publish(req, res) {
    const row = await promoService.publishPromotion(req.params.id, req.user?.id, req.body?.reason, scopeOf(req));
    res.json({ success: true, data: row });
  },

  async pause(req, res) {
    const row = await promoService.pausePromotion(req.params.id, req.user?.id, req.body?.reason, scopeOf(req));
    res.json({ success: true, data: row });
  },

  async archive(req, res) {
    const row = await promoService.archivePromotion(req.params.id, req.user?.id, req.body?.reason, scopeOf(req));
    res.json({ success: true, data: row });
  },

  async changeStatus(req, res) {
    const row = await promoService.changeStatus(req.params.id, req.body?.status, req.user?.id, req.body?.reason, scopeOf(req));
    res.json({ success: true, data: row });
  },

  // ─── Clone ────────────────────────────────────────────────────────────────

  async clone(req, res) {
    const row = await promoService.clonePromotion(req.params.id, req.user?.id, scopeOf(req));
    res.status(201).json({ success: true, data: row });
  },

  // ─── Coupon codes ─────────────────────────────────────────────────────────

  async addCoupon(req, res) {
    const row = await promoService.addCouponCode(req.params.id, req.body, req.user?.id, scopeOf(req));
    res.status(201).json({ success: true, data: row });
  },

  async removeCoupon(req, res) {
    const result = await promoService.removeCouponCode(req.params.couponId, req.user?.id, scopeOf(req));
    res.json({ success: true, ...result });
  },

  // ─── Analytics ────────────────────────────────────────────────────────────

  async analytics(req, res) {
    const data = await promoService.getPromotionAnalytics(req.params.id, scopeOf(req), req.query);
    res.json({ success: true, data });
  },

  // ─── Simulate ─────────────────────────────────────────────────────────────

  /**
   * Same engine as checkout. Accepts catalog items (priced server-side) or a raw
   * what-if basket; admins may also pin the clock to test schedules.
   */
  async simulate(req, res) {
    const body = req.body || {};
    const restricted = promoService.restrictedZoneOf(scopeOf(req));
    const zoneId = restricted ?? body.zoneId ?? body.zone?.id;
    if (!zoneId) throw new ValidationError('zoneId is required');
    const context = await buildPromotionContext({
      zoneId,
      customerId: body.customerId ?? body.customer?.id ?? null,
      items: body.items,
      basket: body.basket,
      allowRawBasket: true,
      allowClockOverride: true,
      currentTime: body.currentTime,
      couponCodes: body.couponCodes ?? (body.couponCode ? [body.couponCode] : []),
      paymentMethod: body.paymentMethod,
      collectionDate: body.collectionDate,
      deliveryDate: body.deliveryDate,
    });
    const result = await simulatePromotions(context);
    res.json({ success: true, data: { ...result, context: { customer: context.customer, zone: context.zone } } });
  },

  // ─── Conflict detection ───────────────────────────────────────────────────

  async conflicts(req, res) {
    const live = await promoService.listLivePromotions(scopeOf(req));
    const conflicts = detectConflicts(live);
    res.json({
      success: true,
      data: conflicts.map((c) => ({
        promotionA: { id: c.a.id, name: c.a.name },
        promotionB: { id: c.b.id, name: c.b.name },
        reason: c.reason,
      })),
    });
  },
};
