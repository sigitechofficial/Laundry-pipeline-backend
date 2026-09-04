'use strict';

const { booking, tip, users } = require('../../models');
const {
    ValidationError,
    NotFoundError,
    ConflictError,
} = require('../../middlewares/universalErrorHandler');
const { COMPLETED } = require('../../constants/bookingStatusIds');
const { chargeOffSession } = require('../../controllers/stripe');
const customerPaymentMethodService = require('./customerPaymentMethodService');
const agentWalletService = require('../Agent/agentWalletService');
const {
    TIP_SOURCE,
    summarizeTips,
    roundMoney,
} = require('../../utils/bookingTips');

const LEGACY_COMPLETED = 16;
const MIN_TIP = 1;
const MAX_TIP = 200;

function isCompletedStatus(statusId) {
    const id = Number(statusId);
    return id === COMPLETED || id === LEGACY_COMPLETED;
}

async function loadOwnedBooking(bookingId, customerId) {
    const id = parseInt(bookingId, 10);
    if (!Number.isFinite(id) || id <= 0) {
        throw new ValidationError('Valid bookingId is required');
    }

    const row = await booking.findByPk(id, {
        attributes: [
            'id',
            'customerId',
            'bookingStatusId',
            'orderTrackId',
            'laundryShopId',
            'paymentType',
        ],
        include: [
            {
                model: tip,
                as: 'tips',
                required: false,
                attributes: [
                    'id',
                    'amount',
                    'source',
                    'paymentType',
                    'stripePaymentIntentId',
                    'paidAt',
                    'createdAt',
                ],
            },
        ],
    });

    if (!row) throw new NotFoundError('Booking not found');
    if (Number(row.customerId) !== Number(customerId)) {
        throw new NotFoundError('Booking not found');
    }
    return row;
}

function buildExtraTipPayload(row, { canAdd } = {}) {
    return summarizeTips(row.tips || [], { canAdd });
}

async function getExtraTipEligibility(bookingId, customerId) {
    const row = await loadOwnedBooking(bookingId, customerId);
    const completed = isCompletedStatus(row.bookingStatusId);
    const summary = buildExtraTipPayload(row, { canAdd: completed });
    return {
        bookingId: row.id,
        orderTrackId: row.orderTrackId,
        completed,
        ...summary,
        canAdd: completed && summary.extraTipAmount <= 0,
    };
}

async function addExtraTip({ bookingId, customerId, amount, paymentMethodId }) {
    const row = await loadOwnedBooking(bookingId, customerId);
    if (!isCompletedStatus(row.bookingStatusId)) {
        throw new ValidationError(
            'Extra tip can only be added after the order is completed.'
        );
    }

    const existing = summarizeTips(row.tips || []);
    if (existing.extraTipAmount > 0) {
        throw new ConflictError('An extra tip has already been added for this order.');
    }

    const tipAmount = roundMoney(amount);
    if (tipAmount < MIN_TIP || tipAmount > MAX_TIP) {
        throw new ValidationError(
            `Extra tip must be between ${MIN_TIP} and ${MAX_TIP}.`
        );
    }

    const user = await users.findByPk(customerId, {
        attributes: ['id', 'stripeCustomerId', 'defaultPaymentMethodId'],
    });
    if (!user) throw new NotFoundError('Customer not found');

    const cards = await customerPaymentMethodService.listPaymentMethods(customerId);
    const defaultId =
        paymentMethodId ||
        cards?.defaultPaymentMethodId ||
        user.defaultPaymentMethodId ||
        null;
    if (!defaultId) {
        throw new ValidationError(
            'Add a saved card in Payment methods to send an extra tip.'
        );
    }

    const stripeCustomerId = user.stripeCustomerId || cards?.stripeCustomerId;
    if (!stripeCustomerId) {
        throw new ValidationError(
            'Add a saved card in Payment methods to send an extra tip.'
        );
    }

    const paymentIntent = await chargeOffSession(
        tipAmount,
        stripeCustomerId,
        defaultId,
        `extra-tip-${row.id}`
    );

    if (!paymentIntent || !['succeeded', 'requires_capture'].includes(paymentIntent.status)) {
        throw new ValidationError(
            `Card charge did not complete (${paymentIntent?.status || 'unknown'}).`
        );
    }

    const now = new Date();
    const created = await tip.create({
        bookingId: row.id,
        amount: tipAmount,
        source: TIP_SOURCE.POST_COMPLETE,
        paymentType: 'card',
        stripePaymentIntentId: paymentIntent.id,
        paidAt: now,
        createdByUserId: customerId,
    });

    let walletResult = { credited: false, reason: 'skipped' };
    try {
        walletResult = await agentWalletService.creditExtraTipForBooking({
            bookingId: row.id,
            amount: tipAmount,
            tipId: created.id,
        });
    } catch (err) {
        console.error(
            `[extraTip] wallet credit failed booking=${row.id} tip=${created.id}:`,
            err?.message || err
        );
    }

    return {
        bookingId: row.id,
        orderTrackId: row.orderTrackId,
        tip: {
            id: created.id,
            amount: tipAmount,
            source: TIP_SOURCE.POST_COMPLETE,
            paymentType: 'card',
            stripePaymentIntentId: paymentIntent.id,
            paidAt: now,
        },
        wallet: walletResult,
        extraTip: summarizeTips([...(row.tips || []), created], { canAdd: false }),
    };
}

module.exports = {
    getExtraTipEligibility,
    addExtraTip,
    buildExtraTipPayload,
    isCompletedStatus,
};
