'use strict';

const assert = require('assert/strict');
const { ensureStripeCustomer } = require('../services/shared/stripeCustomerService');

function makeDeps({ user, failSave = false, deleteFails = false, concurrentWinner = null } = {}) {
  const state = { row: { ...user }, stripe: new Map(), logs: [], locked: false };
  const deps = {
    log: (msg) => state.logs.push(msg),
    sequelize: {
      async transaction(fn) {
        return fn({ id: 'tx', LOCK: { UPDATE: 'UPDATE' } });
      },
    },
    users: {
      async findByPk(id, opts = {}) {
        if (id !== state.row.id) return null;
        if (opts.lock) {
          assert.equal(opts.lock, 'UPDATE', 'creation must lock the user row');
          assert.equal(opts.transaction.id, 'tx');
          state.locked = true;
          // Simulates another request that created the customer between the
          // unlocked read and acquiring the lock.
          if (concurrentWinner) state.row.stripeCustomerId = concurrentWinner;
        }
        return { ...state.row };
      },
      async update(values, opts) {
        assert.equal(opts.transaction.id, 'tx', 'save must be inside the locking transaction');
        if (failSave) throw new Error('db save failed');
        Object.assign(state.row, values);
      },
    },
    stripeApi: {
      async createCustomer({ name, email, metadata }) {
        const id = `cus_${state.stripe.size + 1}`;
        state.stripe.set(id, { name, email, metadata });
        return id;
      },
      async deleteCustomer(id) {
        if (deleteFails) throw new Error('stripe delete failed');
        state.stripe.delete(id);
      },
    },
  };
  return { deps, state };
}

const baseUser = { id: 5, firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', stripeCustomerId: null };

async function run() {
  // Existing customer: returned without a lock or a Stripe call.
  {
    const { deps, state } = makeDeps({ user: { ...baseUser, stripeCustomerId: 'cus_existing' } });
    assert.equal(await ensureStripeCustomer(5, deps), 'cus_existing');
    assert.equal(state.locked, false);
    assert.equal(state.stripe.size, 0);
  }

  // First payment: created under the row lock, saved, tagged with the user id.
  {
    const { deps, state } = makeDeps({ user: baseUser });
    const id = await ensureStripeCustomer(5, deps);
    assert.equal(id, 'cus_1');
    assert.equal(state.locked, true);
    assert.equal(state.row.stripeCustomerId, 'cus_1');
    assert.deepEqual(state.stripe.get('cus_1'), {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      metadata: { userId: '5' },
    });
  }

  // A parallel request won the race: its customer is reused, no second one created.
  {
    const { deps, state } = makeDeps({ user: baseUser, concurrentWinner: 'cus_winner' });
    assert.equal(await ensureStripeCustomer(5, deps), 'cus_winner');
    assert.equal(state.stripe.size, 0);
  }

  // Saving the id fails: the new Stripe customer is deleted and the error surfaces.
  {
    const { deps, state } = makeDeps({ user: baseUser, failSave: true });
    await assert.rejects(ensureStripeCustomer(5, deps), /db save failed/);
    assert.equal(state.stripe.size, 0);
    assert.equal(state.row.stripeCustomerId, null);
  }

  // Cleanup also fails: original error kept, orphan logged with its id for ops.
  {
    const { deps, state } = makeDeps({ user: baseUser, failSave: true, deleteFails: true });
    await assert.rejects(ensureStripeCustomer(5, deps), /db save failed/);
    assert.match(state.logs[0], /Failed to delete Stripe customer cus_1 for user 5/);
  }

  // Name falls back to the email when the user has no name.
  {
    const { deps, state } = makeDeps({ user: { ...baseUser, firstName: null, lastName: null } });
    await ensureStripeCustomer(5, deps);
    assert.equal(state.stripe.get('cus_1').name, 'ada@example.com');
  }

  // Unknown user.
  {
    const { deps } = makeDeps({ user: baseUser });
    await assert.rejects(ensureStripeCustomer(99, deps), /User 99 not found/);
  }

  console.log('stripeCustomerService tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
