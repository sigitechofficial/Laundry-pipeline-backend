'use strict';

const campaignService = require('../../services/Admin/campaignService');

module.exports = {
  async create(req, res) {
    const row = await campaignService.createCampaign(req.body, req.user?.id);
    res.status(201).json({ success: true, data: row });
  },

  async list(req, res) {
    const result = await campaignService.listCampaigns(req.query);
    res.json({ success: true, ...result });
  },

  async getById(req, res) {
    const row = await campaignService.getCampaignById(req.params.id);
    res.json({ success: true, data: row });
  },

  async update(req, res) {
    const row = await campaignService.updateCampaign(req.params.id, req.body, req.user?.id);
    res.json({ success: true, data: row });
  },

  /** GET /admin/campaigns/:id/report?from=&to= — budget, spent, remaining, per promotion, by zone/day. */
  async report(req, res) {
    const { restrictedZoneOf } = require('../../services/Admin/promotionAdminService');
    const { campaignReport } = require('../../services/promotions/promotionReportService');
    const data = await campaignReport(req.params.id, {
      from: req.query.from,
      to: req.query.to,
      restrictedZoneId: restrictedZoneOf(req.adminAuthz || null),
    });
    res.json({ success: true, data });
  },

  async remove(req, res) {
    const result = await campaignService.deleteCampaign(req.params.id, req.user?.id);
    res.json({ success: true, ...result });
  },
};
