"use strict";

const ResponseHelper = require("../../utils/responseHelper");
const invoiceAutoChargeService = require("../../services/Agent/invoiceAutoChargeService");
const paymentMethodChangeService = require("../../services/Admin/paymentMethodChangeService");
const { ValidationError, NotFoundError } = require("../../middlewares/universalErrorHandler");

exports.listPaymentFailures = async (req, res) => {
    const result = await invoiceAutoChargeService.listPaymentFailures({
        limit: req.query.limit,
        sortBy: req.query.sortBy,
        sortDir: req.query.sortDir,
    });
    return ResponseHelper.success(res, "Payment failures", {
        failures: result.failures,
        count: result.totalCount,
        totalCount: result.totalCount,
    });
};

exports.resolvePaymentFailure = async (req, res) => {
    const bookingId = req.params.bookingId || req.params.id;
    const { action, notes } = req.body || {};

    if (!bookingId) {
        throw new ValidationError("bookingId is required");
    }
    if (!action) {
        throw new ValidationError(
            "action is required (shift_to_cash | allow_proceed | keep_waiting)"
        );
    }

    try {
        const result = await invoiceAutoChargeService.resolvePaymentFailure(
            bookingId,
            action,
            req.user?.id,
            notes
        );
        return ResponseHelper.success(res, "Payment failure resolved", result);
    } catch (err) {
        if (err.statusCode === 404) {
            throw new NotFoundError(err.message);
        }
        if (err.statusCode === 400) {
            throw new ValidationError(err.message);
        }
        throw err;
    }
};

/**
 * PATCH /admin/bookings/:bookingId/payment-method
 * Change how the order's outstanding balance is collected (card <-> cash),
 * with a required reason. Body: { method, reasonCode?, reason?, note? }.
 */
exports.changePaymentMethod = async (req, res) => {
    const bookingId = req.params.bookingId || req.params.id;
    const { method, reasonCode, reason, note } = req.body || {};

    if (!bookingId) {
        throw new ValidationError("bookingId is required");
    }

    const result = await paymentMethodChangeService.changeBalancePaymentMethod(
        bookingId,
        {
            method,
            reasonCode,
            reason,
            note,
            adminUserId: req.user?.id,
        }
    );
    return ResponseHelper.success(
        res,
        result.changed ? "Payment method updated" : result.message || "No change",
        result
    );
};
