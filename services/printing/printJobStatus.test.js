'use strict';

const assert = require('assert');
const { effectiveStatus, JOB_TTL_MS, CLAIM_STALE_MS } = require('./printJobStatus');

const now = Date.parse('2026-09-28T12:00:00Z');

assert.strictEqual(
  effectiveStatus({ status: 'pending', expiresAt: new Date(now + 1000) }, now),
  'pending'
);
assert.strictEqual(
  effectiveStatus({ status: 'pending', expiresAt: new Date(now - JOB_TTL_MS) }, now),
  'expired'
);
assert.strictEqual(
  effectiveStatus(
    { status: 'printing', expiresAt: new Date(now), claimedAt: new Date(now - 5000) },
    now
  ),
  'printing'
);
assert.strictEqual(
  effectiveStatus(
    {
      status: 'printing',
      expiresAt: new Date(now),
      claimedAt: new Date(now - CLAIM_STALE_MS - 1),
    },
    now
  ),
  'stalled'
);
assert.strictEqual(
  effectiveStatus({ status: 'printed', expiresAt: new Date(now - JOB_TTL_MS) }, now),
  'printed'
);
assert.strictEqual(
  effectiveStatus({ status: 'failed', expiresAt: new Date(now - JOB_TTL_MS) }, now),
  'failed'
);

console.log('printJobStatus tests passed');
