'use strict';

const JOB_TTL_MS = 10 * 60 * 1000;
const CLAIM_STALE_MS = 2 * 60 * 1000;
const PRINT_KINDS = new Set(['tags', 'receipt', 'test']);

/** Expiry and stalled claims are derived on read, so no sweeper job is needed. */
function effectiveStatus(job, now = Date.now()) {
  if (job.status === 'pending' && new Date(job.expiresAt).getTime() <= now) {
    return 'expired';
  }
  if (
    job.status === 'printing' &&
    job.claimedAt &&
    now - new Date(job.claimedAt).getTime() > CLAIM_STALE_MS
  ) {
    return 'stalled';
  }
  return job.status;
}

module.exports = { JOB_TTL_MS, CLAIM_STALE_MS, PRINT_KINDS, effectiveStatus };
