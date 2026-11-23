'use strict';

const assert = require('assert/strict');
const {
  createUnverifiedCustomer,
  refreshUnverifiedCustomer,
} = require('../services/Customer/customerSignupPersistence');

/** In-memory stand-ins: a transaction commits its writes only if the callback resolves. */
function makeDeps({ failOn = null, stripeFails = null, deleteFails = false } = {}) {
  const state = { users: [], otps: [], tokens: [], stripe: new Map(), logs: [], nextId: 1 };
  let pending = null;

  const write = (table, row) => {
    if (failOn === table) throw new Error(`db failure on ${table}`);
    pending.push(() => state[table].push(row));
    return row;
  };

  const deps = {
    log: (msg) => state.logs.push(msg),
    sequelize: {
      async transaction(fn) {
        pending = [];
        const result = await fn({ id: 'tx' });
        pending.forEach((commit) => commit());
        pending = null;
        return result;
      },
    },
    users: {
      async create(values, opts) {
        assert.equal(opts.transaction.id, 'tx', 'user write must be in the transaction');
        return write('users', { id: state.nextId++, ...values });
      },
      async update(values, opts) {
        assert.equal(opts.transaction.id, 'tx');
        if (failOn === 'users') throw new Error('db failure on users');
        pending.push(() => Object.assign(state.users.find((u) => u.id === opts.where.id), values));
      },
    },
    otpVerification: {
      async create(values, opts) {
        assert.equal(opts.transaction.id, 'tx', 'otp write must be in the transaction');
        return write('otps', { id: 100 + state.otps.length, ...values });
      },
      async findOne({ where }) {
        const row = state.otps.find((o) => o.userId === where.userId);
        return row && { ...row, async update(v, opts) { assert.equal(opts.transaction.id, 'tx'); pending.push(() => Object.assign(row, v)); } };
      },
    },
    deviceToken: {
      async create(values, opts) {
        assert.equal(opts.transaction.id, 'tx', 'device token write must be in the transaction');
        return write('tokens', values);
      },
    },
    stripeApi: {
      async createCustomer({ name, email }) {
        if (stripeFails === 'create') throw new Error('stripe down');
        const id = `cus_${state.stripe.size + 1}`;
        state.stripe.set(id, { name, email });
        return id;
      },
      async updateCustomer(id, params) {
        Object.assign(state.stripe.get(id), params);
      },
      async deleteCustomer(id) {
        if (deleteFails) throw new Error('stripe delete failed');
        state.stripe.delete(id);
      },
    },
  };
  return { deps, state };
}

const input = () => ({
  profile: { email: 'new@example.com', firstName: 'Ada', lastName: 'L', phoneNum: '7400123456' },
  passwordHash: 'hash',
  otp: { code: '1234', requestedAt: new Date(), expiresAt: new Date() },
  dvToken: 'device-1',
});

async function run() {
  // Happy path: everything written, Stripe id stored on the user.
  {
    const { deps, state } = makeDeps();
    const out = await createUnverifiedCustomer(deps, input());
    assert.equal(state.users.length, 1);
    assert.equal(state.users[0].stripeCustomerId, out.stripeCustomerId);
    assert.equal(state.users[0].userTypeId, 2);
    assert.equal(state.otps.length, 1);
    assert.equal(state.tokens.length, 1);
    assert.equal(state.stripe.size, 1);
  }

  // Stripe fails first: nothing written anywhere.
  {
    const { deps, state } = makeDeps({ stripeFails: 'create' });
    await assert.rejects(createUnverifiedCustomer(deps, input()), /stripe down/);
    assert.equal(state.users.length + state.otps.length + state.tokens.length, 0);
  }

  // Database fails mid-way: no rows committed and the Stripe customer is deleted.
  for (const table of ['users', 'otps', 'tokens']) {
    const { deps, state } = makeDeps({ failOn: table });
    await assert.rejects(createUnverifiedCustomer(deps, input()), /db failure/);
    assert.equal(state.users.length + state.otps.length + state.tokens.length, 0, `rollback on ${table}`);
    assert.equal(state.stripe.size, 0, `Stripe customer compensated on ${table} failure`);
  }

  // Compensation itself fails: original error is kept and the orphan is logged for ops.
  {
    const { deps, state } = makeDeps({ failOn: 'otps', deleteFails: true });
    await assert.rejects(createUnverifiedCustomer(deps, input()), /db failure on otps/);
    assert.match(state.logs[0], /Failed to delete Stripe customer cus_1/);
  }

  // No device token supplied: no empty token row.
  {
    const { deps, state } = makeDeps();
    await createUnverifiedCustomer(deps, { ...input(), dvToken: undefined });
    assert.equal(state.tokens.length, 0);
  }

  // Existing unverified customer with a Stripe record: renamed, never replaced.
  {
    const { deps, state } = makeDeps();
    state.stripe.set('cus_existing', { name: 'Old', email: 'new@example.com' });
    state.users.push({ id: 7, firstName: 'Old', stripeCustomerId: 'cus_existing' });
    const out = await refreshUnverifiedCustomer(deps, state.users[0], input());
    assert.equal(out.stripeCustomerId, 'cus_existing');
    assert.equal(state.stripe.size, 1, 'no new Stripe customer');
    assert.equal(state.stripe.get('cus_existing').name, 'Ada');
    assert.equal(state.users[0].firstName, 'Ada');
    assert.equal(state.otps.length, 1);
  }

  // Existing customer that never got a Stripe record: created, and compensated on failure.
  {
    const { deps, state } = makeDeps({ failOn: 'users' });
    state.users.push({ id: 8, firstName: 'Ada', stripeCustomerId: null });
    await assert.rejects(refreshUnverifiedCustomer(deps, state.users[0], input()), /db failure/);
    assert.equal(state.stripe.size, 0, 'newly created Stripe customer removed');
    assert.equal(state.users[0].stripeCustomerId, null, 'user unchanged');
  }

  console.log('customerSignupPersistence tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
