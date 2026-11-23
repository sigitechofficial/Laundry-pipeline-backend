'use strict';

/**
 * Display symbols of ISO currency codes, from the `units` table (type 'currency'):
 * the same data zones point at. Replaces a hard-coded { GBP: '£', USD: '$', EUR: '€' }.
 *
 * Promotion labels are built synchronously deep inside the engine, so the symbols are
 * loaded (warmCurrencySymbols, cached for CACHE_TTL_MS) by the async code that loads the
 * promotions, and read synchronously with currencySymbolOf. A code without a units row —
 * or before the cache is warm — displays as the code itself ("CHF 5.00"): the record's own
 * data, never another currency's symbol.
 */

const CACHE_TTL_MS = 60 * 1000;

let cache = { at: 0, byCode: new Map(), loading: null };

function normalize(code) {
  return code != null ? String(code).trim().toUpperCase() : '';
}

function store(rows) {
  const byCode = new Map();
  for (const row of rows || []) {
    const code = normalize(row.name);
    const symbol = row.symbol != null ? String(row.symbol).trim() : '';
    if (code && !byCode.has(code)) byCode.set(code, symbol || code);
  }
  cache = { at: Date.now(), byCode, loading: null };
}

/** Load the currency units (no-op while the cache is fresh). */
async function warmCurrencySymbols() {
  if (cache.at && Date.now() - cache.at < CACHE_TTL_MS) return;
  if (cache.loading) return cache.loading;
  const { units } = require('../models');
  cache.loading = units
    .findAll({ where: { type: 'currency' }, attributes: ['id', 'name', 'symbol'], order: [['id', 'ASC']] })
    .then(store)
    .catch((err) => {
      cache.loading = null;
      console.warn('[currencySymbols] could not load currency units:', err?.message || err);
    });
  return cache.loading;
}

/**
 * Symbol to prefix an amount with: the unit's symbol ("£"), or "CODE " when there is no
 * unit for it; '' when there is no code.
 */
function currencySymbolOf(code) {
  const c = normalize(code);
  if (!c) return '';
  const symbol = cache.byCode.get(c);
  return symbol && symbol !== c ? symbol : `${c} `;
}

/** Tests: set the known units directly. */
function primeCurrencySymbols(rows) {
  store(rows);
}

module.exports = { warmCurrencySymbols, currencySymbolOf, primeCurrencySymbols };
