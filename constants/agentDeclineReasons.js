'use strict';

/** Must stay aligned with agent app presets (new_order_card_widget.dart). */
const AGENT_DECLINE_REASON_PRESETS = Object.freeze([
  'Too busy / at capacity',
  'Outside my service area',
  'Shop closing soon',
  'Cannot meet pickup/delivery time',
  'Items/service not supported',
]);

const OTHER_KEY = 'other';
const UNSPECIFIED_KEY = 'unspecified';

/**
 * Map free-text decline reasons into stable buckets for admin analytics.
 * Exact preset match first; otherwise coarse keyword buckets; else Other.
 */
function normalizeDeclineReason(reason) {
  const raw = String(reason || '').trim();
  if (!raw) {
    return {
      key: UNSPECIFIED_KEY,
      label: 'No reason provided',
      raw: null,
    };
  }
  if (AGENT_DECLINE_REASON_PRESETS.includes(raw)) {
    return { key: raw, label: raw, raw };
  }

  const lower = raw.toLowerCase();
  if (
    lower.includes('busy') ||
    lower.includes('capacity') ||
    lower.includes('workload') ||
    lower.includes('too many')
  ) {
    return {
      key: 'Too busy / at capacity',
      label: 'Too busy / at capacity',
      raw,
    };
  }
  if (
    lower.includes('area') ||
    lower.includes('zone') ||
    lower.includes('distance') ||
    lower.includes('far')
  ) {
    return {
      key: 'Outside my service area',
      label: 'Outside my service area',
      raw,
    };
  }
  if (lower.includes('clos') || lower.includes('hours') || lower.includes('open')) {
    return {
      key: 'Shop closing soon',
      label: 'Shop closing soon',
      raw,
    };
  }
  if (
    lower.includes('time') ||
    lower.includes('slot') ||
    lower.includes('pickup') ||
    lower.includes('delivery') ||
    lower.includes('schedule')
  ) {
    return {
      key: 'Cannot meet pickup/delivery time',
      label: 'Cannot meet pickup/delivery time',
      raw,
    };
  }
  if (
    lower.includes('service') ||
    lower.includes('item') ||
    lower.includes('support') ||
    lower.includes('offer')
  ) {
    return {
      key: 'Items/service not supported',
      label: 'Items/service not supported',
      raw,
    };
  }

  return { key: OTHER_KEY, label: 'Other', raw };
}

function buildDeclineReasonBreakdown(rows) {
  const counts = new Map();
  for (const row of rows || []) {
    const { key, label } = normalizeDeclineReason(row?.reason);
    const prev = counts.get(key) || { key, label, count: 0 };
    prev.count += 1;
    counts.set(key, prev);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

module.exports = {
  AGENT_DECLINE_REASON_PRESETS,
  OTHER_KEY,
  UNSPECIFIED_KEY,
  normalizeDeclineReason,
  buildDeclineReasonBreakdown,
};
