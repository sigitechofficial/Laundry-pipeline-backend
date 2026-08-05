"use strict";

const customerPaymentMethodService = require("../../services/Customer/customerPaymentMethodService");
const ResponseHelper = require("../../utils/responseHelper");
const { ValidationError } = require("../../middlewares/universalErrorHandler");

/**
 * GET /customer/payment-methods
 */
async function listPaymentMethods(req, res) {
    const userId = req.user?.id;
    if (!userId) {
        throw new ValidationError("Unauthorized");
    }
    const data = await customerPaymentMethodService.listPaymentMethods(userId);
    return ResponseHelper.success(res, "Payment methods fetched", data);
}

/**
 * POST /customer/payment-methods/setup-intent
 * Returns SetupIntent clientSecret for PaymentSheet (add card, no charge).
 */
async function createPaymentMethodSetupIntent(req, res) {
    const userId = req.user?.id;
    if (!userId) {
        throw new ValidationError("Unauthorized");
    }
    const data = await customerPaymentMethodService.createSetupIntentForCustomer(userId);
    return ResponseHelper.success(
        res,
        "Setup Intent created — confirm to save card without charging",
        data
    );
}

/**
 * POST /customer/payment-methods
 * Body: { paymentMethodId }
 * Option A: newly added card becomes the active default; open bookings synced.
 */
async function addAndActivatePaymentMethod(req, res) {
    const userId = req.user?.id;
    if (!userId) {
        throw new ValidationError("Unauthorized");
    }
    const { paymentMethodId } = req.body || {};
    const data = await customerPaymentMethodService.addAndActivatePaymentMethod(
        userId,
        paymentMethodId
    );
    return ResponseHelper.success(res, data.message, data);
}

/**
 * PATCH /customer/payment-methods/default
 * Body: { paymentMethodId } — switch active card among saved cards.
 */
async function setDefaultPaymentMethod(req, res) {
    const userId = req.user?.id;
    if (!userId) {
        throw new ValidationError("Unauthorized");
    }
    const { paymentMethodId } = req.body || {};
    const data = await customerPaymentMethodService.setDefaultPaymentMethod(
        userId,
        paymentMethodId
    );
    return ResponseHelper.success(res, data.message, data);
}

/**
 * DELETE /customer/payment-methods/:paymentMethodId
 */
async function removePaymentMethod(req, res) {
    const userId = req.user?.id;
    if (!userId) {
        throw new ValidationError("Unauthorized");
    }
    const { paymentMethodId } = req.params;
    const data = await customerPaymentMethodService.removePaymentMethod(
        userId,
        paymentMethodId
    );
    return ResponseHelper.success(res, data.message, data);
}

module.exports = {
    listPaymentMethods,
    createPaymentMethodSetupIntent,
    addAndActivatePaymentMethod,
    setDefaultPaymentMethod,
    removePaymentMethod,
};
