'use strict';

const { booking } = require('../../models');
const { NotFoundError } = require('../../middlewares/universalErrorHandler');
const { restrictedZoneOf } = require('../../services/Admin/promotionAdminService');
const { bookingPromotions } = require('../../services/promotions/promotionReportService');
const { removeFromBooking } = require('../../services/promotions/bookingPromotionService');

/** The booking, if this admin may see it (zone staff: own zone only). */
async function bookingInScope(req) {
  const id = Number(req.params.bookingId);
  const row = Number.isInteger(id) && id > 0 ? await booking.findByPk(id, { attributes: ['id', 'zoneId'] }) : null;
  const zoneId = restrictedZoneOf(req.adminAuthz || null);
  if (!row || (zoneId != null && Number(row.zoneId) !== zoneId)) throw new NotFoundError('Order not found');
  return row;
}

module.exports = {
  /** GET /admin/orderPromotions/:bookingId — discount lines on the invoice + ledger history. */
  async get(req, res) {
    const row = await bookingInScope(req);
    res.json({ success: true, data: await bookingPromotions(row.id) });
  },

  /** POST /admin/orderPromotions/:bookingId/remove/:promotionId { reason } — unpaid orders only. */
  async remove(req, res) {
    const row = await bookingInScope(req);
    const result = await removeFromBooking(row.id, Number(req.params.promotionId), {
      actorId: req.user?.id || null,
      reason: req.body?.reason,
    });
    // Re-price now so the order shows the new totals (no invoice yet = nothing to re-price).
    try {
      await require('../../services/Agent/invoiceManagementService').getPaymentSummaryForBooking(row.id);
    } catch (err) {
      console.warn(`[promotions] re-price after removal failed for booking ${row.id}:`, err.message);
    }
    res.json({ success: true, data: { ...result, ...(await bookingPromotions(row.id)) } });
  },
};
