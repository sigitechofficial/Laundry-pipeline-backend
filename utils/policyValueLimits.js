'use strict';
const { ValidationError } = require('../middlewares/universalErrorHandler');

/**
 * Sensible limits on policy settings (cancellation, reschedule, no-show), checked on create and
 * edit so a typo like 150% or a negative fee can never be saved. Settings are recognised by name:
 *  - "...Percentage" / "percentageFee" / "...PercentageWaiverAmount": 0–100
 *  - "...Amount" / "...Fee" / "...PerDay" / "...CapAmount": a number, not negative
 *  - "...Minutes" / "...Days" / "...Count" / "...Cap" / "...Period" / "...SLA" / "...Meters": a whole number, not negative
 * Empty (null / "") is always allowed: it means "not set".
 */
const words = (key) => key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();

function kindOf(key) {
  if (/currency|type$/i.test(key)) return null;
  if (/percentage/i.test(key)) return 'percent';
  if (/(Amount|Fee|PerDay)$/.test(key)) return 'money';
  if (/(Minutes|Days|Count|Cap|Period|SLA|Meters|OnSite)$/.test(key)) return 'whole';
  return null;
}

function assertPolicyValues(config = {}) {
  for (const [key, raw] of Object.entries(config || {})) {
    // Empty = not set; yes/no switches are not numbers.
    if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') continue;
    const kind = kindOf(key);
    if (!kind) continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new ValidationError(`${words(key)} must be a number`);
    if (n < 0) throw new ValidationError(`${words(key)} can't be negative`);
    if (kind === 'percent' && n > 100) throw new ValidationError(`${words(key)} can't be more than 100%`);
    if (kind === 'whole' && !Number.isInteger(n)) throw new ValidationError(`${words(key)} must be a whole number`);
  }
}

module.exports = { assertPolicyValues, kindOf };
