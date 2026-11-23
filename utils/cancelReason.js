'use strict';

/**
 * Resolve the optional cancellation reason before a cancel has any side effect.
 *
 * cancelBookings.reasonId is a nullable foreign key to `reasons`. An id that does not
 * exist used to reach the INSERT at the very end of the cancel flow, after card holds
 * were released and a cancellation fee may already have been charged, and failed there
 * with a 500 (the booking stayed active). Callers now validate first:
 *   - missing / null / ''  → null (the free-text reasonText still explains it)
 *   - a positive integer of an existing reason → that id
 *   - anything else → the error from makeError (a 400 for the API)
 *
 * @param {*} rawReasonId value from the request body
 * @param {(id: number) => Promise<object|null>} findReasonById
 * @param {(message: string) => Error} makeError
 * @returns {Promise<number|null>}
 */
async function resolveCancelReasonId(rawReasonId, findReasonById, makeError) {
    if (rawReasonId === undefined || rawReasonId === null || rawReasonId === '') {
        return null;
    }
    const id = Number(rawReasonId);
    if (!Number.isInteger(id) || id <= 0) {
        throw makeError('Invalid cancellation reason');
    }
    const row = await findReasonById(id);
    if (!row) {
        throw makeError('Unknown cancellation reason');
    }
    return id;
}

module.exports = { resolveCancelReasonId };
