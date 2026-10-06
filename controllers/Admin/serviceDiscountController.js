'use strict';

const svc = require('../../services/Admin/serviceDiscountService');

async function list(req, res) {
  const { page = 1, limit = 50, isActive } = req.query;
  const result = await svc.listDiscounts({ page, limit, isActive });
  res.json({ success: true, ...result });
}

async function getById(req, res) {
  const row = await svc.getDiscountById(req.params.id);
  const targetLabel = await svc.resolveTargetLabel(row);
  res.json({ success: true, data: { ...row.toJSON(), targetLabel } });
}

async function create(req, res) {
  const adminUserId = req.admin?.id ?? req.user?.id ?? null;
  const row = await svc.createDiscount(req.body, adminUserId);
  res.status(201).json({ success: true, data: row });
}

async function update(req, res) {
  const adminUserId = req.admin?.id ?? req.user?.id ?? null;
  const row = await svc.updateDiscount(req.params.id, req.body, adminUserId);
  res.json({ success: true, data: row });
}

async function remove(req, res) {
  await svc.deleteDiscount(req.params.id);
  res.json({ success: true });
}

module.exports = { list, getById, create, update, remove };
