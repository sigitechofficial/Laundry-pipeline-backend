'use strict';

/** Canonical fail-reason catalog. Seed + self-heal both use this list. */
const DEFAULT_ATTEMPT_FAIL_REASONS = [
  {
    code: 'customer_not_home',
    label: 'Customer not home / no answer',
    description: 'On-site wait finished and the customer did not respond.',
    scope: 'both',
    chargesFee: true,
    requiresNote: false,
    isOther: false,
    sortOrder: 10,
  },
  {
    code: 'customer_refused',
    label: 'Customer refused the service',
    description: 'Customer was present but declined pickup or delivery.',
    scope: 'both',
    chargesFee: true,
    requiresNote: false,
    isOther: false,
    sortOrder: 20,
  },
  {
    code: 'cannot_access_address',
    label: 'Cannot access address / building',
    description: 'Access, intercom, or building issue — not the customer’s choice.',
    scope: 'both',
    chargesFee: false,
    requiresNote: false,
    isOther: false,
    sortOrder: 30,
  },
  {
    code: 'unsafe_or_blocked',
    label: 'Location unsafe or blocked',
    description: 'It was not safe or possible to complete at this location.',
    scope: 'both',
    chargesFee: false,
    requiresNote: false,
    isOther: false,
    sortOrder: 40,
  },
  {
    code: 'driver_emergency',
    label: 'Driver / vehicle emergency',
    description: 'Vehicle, illness, or emergency — shop issue, not the customer.',
    scope: 'both',
    chargesFee: false,
    requiresNote: false,
    isOther: false,
    sortOrder: 50,
  },
  {
    code: 'shop_operational',
    label: 'Shop operational issue',
    description: 'Capacity, equipment, or shop process blocked the attempt.',
    scope: 'both',
    chargesFee: false,
    requiresNote: false,
    isOther: false,
    sortOrder: 60,
  },
  {
    code: 'other',
    label: 'Other',
    description: 'Use only if none of the reasons above fit. Add a short note.',
    scope: 'both',
    chargesFee: false,
    requiresNote: true,
    isOther: true,
    sortOrder: 90,
  },
];

const SCOPES = new Set(['pickup', 'delivery', 'both']);

function normalizeScope(scope) {
  const s = String(scope || '').trim().toLowerCase();
  return SCOPES.has(s) ? s : null;
}

function scopeMatches(rowScope, attemptType) {
  const row = String(rowScope || 'both').toLowerCase();
  const type = String(attemptType || '').toLowerCase();
  if (row === 'both') return true;
  return row === type;
}

function slugifyCode(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 48);
}

module.exports = {
  DEFAULT_ATTEMPT_FAIL_REASONS,
  SCOPES,
  normalizeScope,
  scopeMatches,
  slugifyCode,
};
