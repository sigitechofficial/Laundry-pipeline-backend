'use strict';

const promoService = require('../../services/Admin/promotionAdminService');
const { simulatePromotions } = require('../../services/promotions/promotionEngine');
const { detectConflicts } = require('../../services/promotions/stackingResolver');

module.exports = {
  // ─── Promotion CRUD ──────────────────────────────────────────────────────

  async create(req, res) {
    const row = await promoService.createPromotion(req.body, req.user?.id);
    res.status(201).json({ success: true, data: row });
  },

  async list(req, res) {
    const result = await promoService.listPromotions(req.query);
    res.json({ success: true, ...result });
  },

  async getById(req, res) {
    const row = await promoService.getPromotionById(req.params.id);
    res.json({ success: true, data: row });
  },

  async update(req, res) {
    const row = await promoService.updatePromotion(req.params.id, req.body, req.user?.id);
    res.json({ success: true, data: row });
  },

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  async publish(req, res) {
    const row = await promoService.publishPromotion(req.params.id, req.user?.id, req.body.reason);
    res.json({ success: true, data: row });
  },

  async pause(req, res) {
    const row = await promoService.pausePromotion(req.params.id, req.user?.id, req.body.reason);
    res.json({ success: true, data: row });
  },

  async archive(req, res) {
    const row = await promoService.archivePromotion(req.params.id, req.user?.id, req.body.reason);
    res.json({ success: true, data: row });
  },

  async changeStatus(req, res) {
    const row = await promoService.changeStatus(req.params.id, req.body.status, req.user?.id, req.body.reason);
    res.json({ success: true, data: row });
  },

  // ─── Clone ────────────────────────────────────────────────────────────────

  async clone(req, res) {
    const row = await promoService.clonePromotion(req.params.id, req.user?.id);
    res.status(201).json({ success: true, data: row });
  },

  // ─── Coupon codes ─────────────────────────────────────────────────────────

  async addCoupon(req, res) {
    const row = await promoService.addCouponCode(req.params.id, req.body, req.user?.id);
    res.status(201).json({ success: true, data: row });
  },

  async removeCoupon(req, res) {
    const result = await promoService.removeCouponCode(req.params.couponId, req.user?.id);
    res.json({ success: true, ...result });
  },

  // ─── Analytics ────────────────────────────────────────────────────────────

  async analytics(req, res) {
    const data = await promoService.getPromotionAnalytics(req.params.id);
    res.json({ success: true, data });
  },

  // ─── Simulate ─────────────────────────────────────────────────────────────

  async simulate(req, res) {
    const result = await simulatePromotions(req.body);
    res.json({ success: true, data: result });
  },

  // ─── Conflict detection ───────────────────────────────────────────────────

  async conflicts(req, res) {
    const { promotion: Promotion } = require('../../models');
    const active = await Promotion.findAll({ where: { status: 'active' } });
    const conflicts = detectConflicts(active);
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
