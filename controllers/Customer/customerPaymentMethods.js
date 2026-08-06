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
    console.log(`[paymentMethods] GET list userId=${userId}`);
    const data = await customerPaymentMethodService.listPaymentMethods(userId);
    console.log(
        `[paymentMethods] GET list OK userId=${userId} cards=${data?.cards?.length ?? 0} default=${data?.defaultPaymentMethodId || 'none'}`
    );
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
    console.log(`[paymentMethods] POST setup-intent userId=${userId}`);
    const data = await customerPaymentMethodService.createSetupIntentForCustomer(userId);
    console.log(`[paymentMethods] POST setup-intent OK userId=${userId}`);
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
    console.log(
        `[paymentMethods] POST add/activate userId=${userId} pm=${paymentMethodId || 'missing'}`
    );
    const data = await customerPaymentMethodService.addAndActivatePaymentMethod(
        userId,
        paymentMethodId
    );
    console.log(
        `[paymentMethods] POST add/activate OK userId=${userId} default=${data?.defaultPaymentMethodId || 'n/a'} openBookingsUpdated=${data?.openBookingsUpdated ?? 'n/a'}`
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
    console.log(
        `[paymentMethods] PATCH default userId=${userId} pm=${paymentMethodId || 'missing'}`
    );
    const data = await customerPaymentMethodService.setDefaultPaymentMethod(
        userId,
        paymentMethodId
    );
    console.log(`[paymentMethods] PATCH default OK userId=${userId}`);
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
    console.log(
        `[paymentMethods] DELETE userId=${userId} pm=${paymentMethodId || 'missing'}`
    );
    const data = await customerPaymentMethodService.removePaymentMethod(
        userId,
        paymentMethodId
    );
    console.log(`[paymentMethods] DELETE OK userId=${userId}`);
    return ResponseHelper.success(res, data.message, data);
}

module.exports = {
    listPaymentMethods,
    createPaymentMethodSetupIntent,
    addAndActivatePaymentMethod,
    setDefaultPaymentMethod,
    removePaymentMethod,
};
