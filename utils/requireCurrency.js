'use strict';

/**
 * Guards for pure helpers that receive money data (bills, payment summaries, Stripe
 * presentation, email templates). They never pick a currency themselves: the caller
 * passes the record's own currency (usually the booking zone's, see utils/zoneCurrency).
 * A missing currency is a caller bug, so it throws instead of guessing one.
 */

function present(value) {
  return value != null && String(value).trim() !== '';
}

/** ISO code (e.g. "GBP"), trimmed and upper-cased. Throws when missing. */
function requireCurrencyCode(code, where) {
  if (!present(code)) {
    throw new TypeError(`${where}: currency code is required (pass the booking zone's currency)`);
  }
  return String(code).trim().toUpperCase();
}

/** Display symbol (e.g. "£"), trimmed. Throws when missing. */
function requireCurrencySymbol(symbol, where) {
  if (!present(symbol)) {
    throw new TypeError(`${where}: currency symbol is required (pass the booking zone's currency)`);
  }
  return String(symbol).trim();
}

module.exports = { requireCurrencyCode, requireCurrencySymbol };
