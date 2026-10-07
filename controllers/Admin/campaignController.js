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

  async remove(req, res) {
    const result = await campaignService.deleteCampaign(req.params.id, req.user?.id);
    res.json({ success: true, ...result });
  },
};
