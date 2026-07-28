'use strict';

const serviceComparisonService = require('../../services/Admin/serviceComparisonService');
const ResponseHelper = require('../../utils/responseHelper');

/**
 * GET /admin/bookings/:bookingId/service-comparison
 * Returns customer's original service selections (snapshot) vs agent's current invoice lines.
 */
exports.getServiceComparison = async (req, res) => {
    const { bookingId } = req.params;
    const data = await serviceComparisonService.getServiceComparison(bookingId);
    return ResponseHelper.success(res, 'Service comparison fetched', data);
};
