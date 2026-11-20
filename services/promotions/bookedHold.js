'use strict';

/**
 * A booking "has" a promotion while its hold is live and it is either not priced yet or priced
 * with money off (discount or cashback). A hold priced at £0 (e.g. "A better offer was used on
 * this order", or below the minimum) stays held, so it can apply again if the invoice changes,
 * but it is not counted as a booked order in the list or the report.
 */
const BOOKED_HOLD_SQL = (alias = 'r') =>
  `${alias}.status = 'RESERVED' AND ${alias}.reservationExpiresAt > :now`
  + ` AND (${alias}.discountAmount IS NULL OR ${alias}.discountAmount > 0 OR ${alias}.cashbackAmount > 0)`;

module.exports = { BOOKED_HOLD_SQL };
