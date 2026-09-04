'use strict';

const extraTipService = require('../../services/Customer/extraTipService');
const ResponseHelper = require('../../utils/responseHelper');

async function getExtraTipEligibility(req, res) {
    const data = await extraTipService.getExtraTipEligibility(
        req.params.bookingId,
        req.user.id
    );
    return ResponseHelper.success(res, 'Extra tip eligibility retrieved', data);
}

async function addExtraTip(req, res) {
    const data = await extraTipService.addExtraTip({
        bookingId: req.params.bookingId,
        customerId: req.user.id,
        amount: req.body?.amount,
        paymentMethodId: req.body?.paymentMethodId,
    });
    return ResponseHelper.success(res, 'Extra tip added', data, 201);
}

module.exports = {
    getExtraTipEligibility,
    addExtraTip,
};
