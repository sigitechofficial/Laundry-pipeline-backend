"use strict";

const ResponseHelper = require("../../utils/responseHelper");
const invoiceAutoChargeService = require("../../services/Agent/invoiceAutoChargeService");
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
