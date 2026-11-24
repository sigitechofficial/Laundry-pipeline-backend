'use strict';

const { NotFoundError, ValidationError } = require('./universalErrorHandler');

/**
 * The one ownership rule for customer routes that name a booking (by bookingId or
 * orderTrackId, in the path, query or body): the booking must belong to the signed-in
 * customer (req.user.id, set by validateAccessToken), checked in the database before the
 * handler runs. Another customer's booking, or one that does not exist, answers the same
 * 404 "Booking not found", so a caller cannot tell whether an id exists.
 *
 * On success req.ownBookingId is the booking's id.
 *
 * @param {object} [options]
 * @param {object} [options.bookingModel] the Sequelize booking model (tests pass a stub)
 */
function requireOwnBooking({ bookingModel } = {}) {
    return async function requireOwnBookingMiddleware(req, res, next) {
        try {
            const pick = (key) => {
                const value = req.params?.[key] ?? req.query?.[key] ?? req.body?.[key];
                return value === undefined || value === null || String(value).trim() === ''
                    ? null
                    : String(value).trim();
            };
            const bookingId = pick('bookingId');
            const orderTrackId = pick('orderTrackId');
            if (!bookingId && !orderTrackId) {
                throw new ValidationError('bookingId or orderTrackId is required');
            }
            const customerId = Number(req.user?.id);
            if (!Number.isInteger(customerId) || customerId <= 0) {
                throw new NotFoundError('Booking not found');
            }

            const where = { customerId };
            if (bookingId) {
                if (!/^\d+$/.test(bookingId)) throw new NotFoundError('Booking not found');
                where.id = Number(bookingId);
            }
            if (orderTrackId) where.orderTrackId = orderTrackId;

            const model = bookingModel || require('../models').booking;
            const row = await model.findOne({ where, attributes: ['id'] });
            if (!row) throw new NotFoundError('Booking not found');

            req.ownBookingId = Number(row.id);
            return next();
        } catch (err) {
            return next(err);
        }
    };
}

module.exports = { requireOwnBooking };
