'use strict';

const assert = require('assert/strict');
const { Op } = require('sequelize');
const { createEmailOutbox } = require('../services/email/emailOutboxCore');

// ── In-memory stand-in for the emailOutbox model (only what the core uses) ─────────
function matches(row, where) {
  return Object.entries(where).every(([key, cond]) => {
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if (Op.lte in cond) return row[key] != null && row[key] <= cond[Op.lte];
      if (Op.lt in cond) return row[key] != null && row[key] < cond[Op.lt];
    }
    return row[key] === cond;
  });
}
function whereMatches(row, where) {
  if (where[Op.or]) return where[Op.or].some((w) => matches(row, w));
  return matches(row, where);
}
function fakeModel() {
  const rows = [];
  let id = 0;
  return {
    rows,
    async create(values) {
      if (values.dedupeKey && rows.some((r) => r.dedupeKey === values.dedupeKey)) {
        const e = new Error('dup');
        e.name = 'SequelizeUniqueConstraintError';
        throw e;
      }
      const row = { id: ++id, lockedUntil: null, lastError: null, sentAt: null, ...values };
      rows.push(row);
      return { ...row };
    },
    async findOne({ where }) {
      const r = rows.find((x) => whereMatches(x, where));
      return r ? { ...r } : null;
    },
    async findAll({ where, limit }) {
      return rows.filter((r) => whereMatches(r, where)).slice(0, limit).map((r) => ({ ...r }));
    },
    async update(values, { where }) {
      const hit = rows.filter((r) => whereMatches(r, where));
      hit.forEach((r) => Object.assign(r, values));
      return [hit.length];
    },
    async destroy({ where }) {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1) if (whereMatches(rows[i], where)) rows.splice(i, 1);
      return before - rows.length;
    },
  };
}

const silent = { warn() {}, error() {}, log() {} };

async function main() {
  let clock = new Date('2026-11-23T12:00:00Z');
  const now = () => new Date(clock.getTime());
  const advance = (ms) => { clock = new Date(clock.getTime() + ms); };

  // ── enqueue ──────────────────────────────────────────────────────────────────────
  {
    const model = fakeModel();
    const outbox = createEmailOutbox({ model, templates: { welcome: async () => {} }, Op, now, log: silent });
    await assert.rejects(() => outbox.enqueue('nope', { email: 'a@b.test' }), /Unknown email template/);
    assert.equal(await outbox.enqueue('welcome', { email: '  ' }), null, 'no recipient → not queued');
    const first = await outbox.enqueue('welcome', { email: ' a@b.test ', userName: 'A' }, { dedupeKey: 'welcome:user:1' });
    const again = await outbox.enqueue('welcome', { email: 'a@b.test' }, { dedupeKey: 'welcome:user:1' });
    assert.equal(again.id, first.id, 'dedupeKey makes enqueue idempotent');
    assert.equal(model.rows.length, 1);
    assert.equal(model.rows[0].payload.email, 'a@b.test', 'recipient trimmed');
    assert.equal(model.rows[0].status, 'pending');
  }

  // ── send success ─────────────────────────────────────────────────────────────────
  {
    const model = fakeModel();
    const sent = [];
    const outbox = createEmailOutbox({ model, templates: { welcome: async (p) => sent.push(p) }, Op, now, log: silent });
    await outbox.enqueue('welcome', { email: 'a@b.test', userName: 'A' });
    assert.deepEqual(await outbox.processDue(), { sent: 1, retrying: 0, failed: 0, skipped: 0 });
    assert.deepEqual(sent, [{ email: 'a@b.test', userName: 'A' }]);
    assert.equal(model.rows[0].status, 'sent');
    assert.equal(model.rows[0].attempts, 1);
    assert.deepEqual(await outbox.processDue(), { sent: 0, retrying: 0, failed: 0, skipped: 0 }, 'sent once only');

    advance(31 * 24 * 60 * 60 * 1000);
    assert.equal(await outbox.purgeSent(), 1, 'old sent rows purged');
  }

  // ── provider failure: backoff, then permanent failure ────────────────────────────
  {
    const model = fakeModel();
    let calls = 0;
    const outbox = createEmailOutbox({
      model,
      templates: { welcome: async () => { calls += 1; throw new Error('Resource Limit Exhausted.'); } },
      Op, now, log: silent, maxAttempts: 3, baseDelayMs: 30000,
    });
    await outbox.enqueue('welcome', { email: 'a@b.test' });

    assert.deepEqual(await outbox.processDue(), { sent: 0, retrying: 1, failed: 0, skipped: 0 });
    assert.equal(model.rows[0].status, 'pending');
    assert.equal(model.rows[0].lastError, 'Resource Limit Exhausted.');
    assert.equal(model.rows[0].nextAttemptAt.getTime() - clock.getTime(), 30000, 'first retry after 30s');

    assert.equal((await outbox.processDue()).retrying, 0, 'not retried before it is due');
    advance(30000);
    await outbox.processDue();
    assert.equal(model.rows[0].nextAttemptAt.getTime() - clock.getTime(), 60000, 'backoff doubles');
    advance(60000);
    assert.deepEqual(await outbox.processDue(), { sent: 0, retrying: 0, failed: 1, skipped: 0 });
    assert.equal(model.rows[0].status, 'failed');
    assert.equal(calls, 3);
    advance(24 * 60 * 60 * 1000);
    assert.equal((await outbox.processDue()).failed, 0, 'failed rows are not retried');
  }

  // ── crashed sender: expired lease is retried; live lease is not ──────────────────
  {
    const model = fakeModel();
    const sent = [];
    const outbox = createEmailOutbox({ model, templates: { welcome: async (p) => sent.push(p) }, Op, now, log: silent, lockMs: 120000 });
    await outbox.enqueue('welcome', { email: 'a@b.test' });
    Object.assign(model.rows[0], { status: 'sending', attempts: 1, lockedUntil: new Date(clock.getTime() + 120000) });
    assert.equal((await outbox.processDue()).sent, 0, 'live lease left alone');
    advance(120000);
    assert.equal((await outbox.processDue()).sent, 1, 'expired lease picked up again');
    assert.equal(model.rows[0].attempts, 2);
  }

  // ── two workers race for the same row: only one sends ────────────────────────────
  {
    const model = fakeModel();
    const sent = [];
    const outbox = createEmailOutbox({ model, templates: { welcome: async (p) => sent.push(p) }, Op, now, log: silent });
    await outbox.enqueue('welcome', { email: 'a@b.test' });
    const [a, b] = await Promise.all([outbox.processDue(), outbox.processDue()]);
    assert.equal(a.sent + b.sent, 1);
    assert.equal(a.skipped + b.skipped, 1);
    assert.equal(sent.length, 1);
  }

  console.log('emailOutbox.test.js: all assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
