'use strict';

const { users } = require('../../models');
const { NotFoundError, ForbiddenError } = require('../../middlewares/universalErrorHandler');
const { restrictedZoneOf } = require('../../services/Admin/promotionAdminService');
const customerCredit = require('../../services/promotions/customerCreditService');

/** The customer row, or 404. */
async function customerOf(req) {
  const id = Number(req.params.customerId);
  const row = Number.isInteger(id) && id > 0
    ? await users.findOne({ where: { id, userTypeId: 2 }, attributes: ['id', 'firstName', 'lastName', 'email'] })
    : null;
  if (!row) throw new NotFoundError('Customer not found');
  return row;
}

async function view(customerId, query = {}) {
  const [balance, history] = await Promise.all([
    customerCredit.getBalance(customerId),
    customerCredit.getHistory(customerId, { page: query.page, limit: query.limit }),
  ]);
  return { customerId, ...balance, expiryDays: customerCredit.expiryDays() || null, history };
}

module.exports = {
  /** GET /admin/customerCredit/:customerId?page=&limit= — balance + full ledger history. */
  async get(req, res) {
    const customer = await customerOf(req);
    res.json({ success: true, data: await view(customer.id, req.query) });
  },

  /**
   * POST /admin/customerCredit/:customerId/adjust { amount, reason, requestId? }
   * Adds (+) or removes (−) credit. Money: platform admins only (not zone staff).
   * requestId makes a double-click / retry safe.
   */
  async adjust(req, res) {
    if (restrictedZoneOf(req.adminAuthz || null) != null) {
      throw new ForbiddenError('Only platform admins can change customer credit');
    }
    const customer = await customerOf(req);
    const requestId = String(req.body?.requestId || '').trim().slice(0, 80);
    await customerCredit.adjust({
      customerId: customer.id,
      amount: Number(req.body?.amount),
      reason: req.body?.reason,
      actorId: req.user?.id || null,
      idempotencyKey: requestId ? `admin-adjust-${customer.id}-${requestId}` : null,
    });
    res.json({ success: true, data: await view(customer.id) });
  },
};
