'use strict';

/**
 * Transactional email outbox — pure logic (no models required), see emailOutbox.js for
 * the wired instance and worker.
 *
 *  - enqueue(): one INSERT on the request path. Optional dedupeKey makes once-only emails
 *    (welcome, booking confirmation) idempotent.
 *  - processDue(): claims due rows with a conditional UPDATE (safe with several API
 *    processes), sends via the template, then marks sent — or schedules a retry with
 *    exponential backoff; after maxAttempts the row is marked failed and kept for audit.
 *  - A row whose claim lease expired (process died mid-send) is picked up again.
 *    Delivery is therefore at-least-once, which is the right trade for notifications.
 */

const STATUS = Object.freeze({ PENDING: 'pending', SENDING: 'sending', SENT: 'sent', FAILED: 'failed' });

function createEmailOutbox({
  model,
  templates,
  Op,
  now = () => new Date(),
  log = console,
  maxAttempts = 8,
  baseDelayMs = 30 * 1000,
  maxDelayMs = 60 * 60 * 1000,
  lockMs = 2 * 60 * 1000,
}) {
  if (!model || !templates || !Op) throw new Error('createEmailOutbox: model, templates and Op are required');

  const later = (ms) => new Date(now().getTime() + ms);

  /** Delay before attempt (attempts + 1): 30s, 1m, 2m, 4m ... capped at maxDelayMs. */
  function retryDelayMs(attempts) {
    return Math.min(baseDelayMs * 2 ** Math.max(0, attempts - 1), maxDelayMs);
  }

  /**
   * Queue an email. Returns the outbox row, the existing row for a repeated dedupeKey,
   * or null when there is no recipient. Throws for an unknown template (programming error).
   */
  async function enqueue(template, payload, { dedupeKey = null, transaction } = {}) {
    if (!Object.prototype.hasOwnProperty.call(templates, template)) {
      throw new Error(`Unknown email template "${template}"`);
    }
    const email = payload && typeof payload.email === 'string' ? payload.email.trim() : '';
    if (!email) {
      log.warn(`[emailOutbox] ${template}: no recipient email; not queued`);
      return null;
    }
    try {
      return await model.create(
        { template, payload: { ...payload, email }, dedupeKey, status: STATUS.PENDING, attempts: 0, nextAttemptAt: now() },
        { transaction }
      );
    } catch (error) {
      if (dedupeKey && error && error.name === 'SequelizeUniqueConstraintError') {
        return model.findOne({ where: { dedupeKey }, transaction });
      }
      throw error;
    }
  }

  async function claim(row) {
    const [claimed] = await model.update(
      { status: STATUS.SENDING, attempts: row.attempts + 1, lockedUntil: later(lockMs) },
      { where: { id: row.id, status: row.status, attempts: row.attempts } }
    );
    return claimed === 1;
  }

  /** Send everything due now (up to `limit`). Returns counts. */
  async function processDue({ limit = 20 } = {}) {
    const current = now();
    const due = await model.findAll({
      where: {
        [Op.or]: [
          { status: STATUS.PENDING, nextAttemptAt: { [Op.lte]: current } },
          { status: STATUS.SENDING, lockedUntil: { [Op.lte]: current } },
        ],
      },
      order: [['nextAttemptAt', 'ASC'], ['id', 'ASC']],
      limit,
    });

    const result = { sent: 0, retrying: 0, failed: 0, skipped: 0 };
    for (const row of due) {
      if (!(await claim(row))) {
        result.skipped += 1; // another process took it
        continue;
      }
      const attempts = row.attempts + 1;
      try {
        await templates[row.template](row.payload);
        await model.update(
          { status: STATUS.SENT, sentAt: now(), lockedUntil: null, lastError: null },
          { where: { id: row.id } }
        );
        result.sent += 1;
      } catch (error) {
        const lastError = String((error && error.message) || error || 'unknown error').slice(0, 1000);
        const giveUp = attempts >= maxAttempts || !templates[row.template];
        await model.update(
          giveUp
            ? { status: STATUS.FAILED, lockedUntil: null, lastError }
            : { status: STATUS.PENDING, lockedUntil: null, lastError, nextAttemptAt: later(retryDelayMs(attempts)) },
          { where: { id: row.id } }
        );
        if (giveUp) {
          result.failed += 1;
          log.error(`[emailOutbox] #${row.id} ${row.template} failed permanently after ${attempts} attempt(s): ${lastError}`);
        } else {
          result.retrying += 1;
          log.warn(`[emailOutbox] #${row.id} ${row.template} attempt ${attempts} failed, retrying: ${lastError}`);
        }
      }
    }
    return result;
  }

  /** Delete sent rows older than `olderThanMs` (failed rows are kept for follow-up). */
  async function purgeSent({ olderThanMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
    return model.destroy({
      where: { status: STATUS.SENT, sentAt: { [Op.lt]: new Date(now().getTime() - olderThanMs) } },
    });
  }

  return { enqueue, processDue, purgeSent, retryDelayMs };
}

module.exports = { createEmailOutbox, STATUS };
