'use strict';

const assert = require('assert/strict');
const {
  createUnverifiedAccount,
  refreshUnverifiedAccount,
} = require('../services/shared/signupAccountPersistence');

/** In-memory stand-ins: a transaction commits its writes only if the callback resolves. */
function makeDeps({ failOn = null } = {}) {
  const state = { users: [], otps: [], tokens: [], nextId: 1 };
  let pending = null;
  const inTx = (opts) => assert.equal(opts && opts.transaction && opts.transaction.id, 'tx', 'write must be in the transaction');
  const stage = (table, fn) => {
    if (failOn === table) throw new Error(`db failure on ${table}`);
    pending.push(fn);
  };

  const deps = {
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
        inTx(opts);
        const row = { id: state.nextId++, ...values };
        stage('users', () => state.users.push(row));
        return row;
      },
      async update(values, opts) {
        inTx(opts);
        stage('users', () => Object.assign(state.users.find((u) => u.id === opts.where.id), values));
      },
    },
    otpVerification: {
      async create(values, opts) {
        inTx(opts);
        const row = { id: 100 + state.otps.length, ...values };
        stage('otps', () => state.otps.push(row));
        return row;
      },
      async findOne({ where }, ...rest) {
        const row = state.otps.find((o) => o.userId === where.userId);
        if (!row) return null;
        return {
          ...row,
          async update(values, opts) {
            inTx(opts);
            stage('otps', () => Object.assign(row, values));
          },
        };
      },
    },
    deviceToken: {
      async create(values, opts) {
        inTx(opts);
        stage('tokens', () => state.tokens.push(values));
        return values;
      },
    },
  };
  return { deps, state };
}

const otp = () => ({ code: '1234', requestedAt: new Date(), expiresAt: new Date() });
const newInput = (overrides = {}) => ({
  userTypeId: 2,
  profile: { email: 'new@example.com', firstName: 'Ada', lastName: 'L', phoneNum: '7400123456' },
  passwordHash: 'hash',
  otp: otp(),
  pushToken: 'push-token-1',
  deviceId: '6f1c2d3e-4a5b-4c6d-8e7f-901234567890',
  ...overrides,
});

async function run() {
  // Happy path: user, OTP and device token written together.
  {
    const { deps, state } = makeDeps();
    const { user, otpRow } = await createUnverifiedAccount(deps, newInput());
    assert.equal(state.users.length, 1);
    assert.equal(state.users[0].userTypeId, 2);
    assert.equal(state.users[0].password, 'hash');
    assert.equal(state.users[0].status, true);
    assert.equal(state.users[0].stripeCustomerId, undefined, 'sign-up never creates a Stripe customer');
    assert.equal(state.otps[0].userId, user.id);
    assert.equal(state.otps[0].OTP, '1234');
    assert.equal(otpRow.id, state.otps[0].id);
    assert.equal(state.tokens.length, 1);
    assert.equal(state.tokens[0].tokenId, 'push-token-1');
    assert.equal(state.tokens[0].deviceId, '6f1c2d3e-4a5b-4c6d-8e7f-901234567890', 'token recorded against the install');
  }

  // Shop agents use the same flow with their own user type.
  {
    const { deps, state } = makeDeps();
    await createUnverifiedAccount(deps, newInput({ userTypeId: 4 }));
    assert.equal(state.users[0].userTypeId, 4);
  }

  // A failure at any write leaves nothing behind.
  for (const table of ['users', 'otps', 'tokens']) {
    const { deps, state } = makeDeps({ failOn: table });
    await assert.rejects(createUnverifiedAccount(deps, newInput()), /db failure/);
    assert.equal(state.users.length + state.otps.length + state.tokens.length, 0, `rollback on ${table}`);
  }

  // No push token (simulator, Firebase unavailable): no empty token row.
  {
    const { deps, state } = makeDeps();
    await createUnverifiedAccount(deps, newInput({ pushToken: undefined }));
    assert.equal(state.tokens.length, 0);
  }

  // Re-sign-up of an unverified account: details and existing OTP updated together.
  {
    const { deps, state } = makeDeps();
    state.users.push({ id: 7, firstName: 'Old', password: 'old' });
    state.otps.push({ id: 50, userId: 7, OTP: '0000' });
    const { otpRow } = await refreshUnverifiedAccount(deps, { id: 7 }, {
      profile: { firstName: 'Ada' },
      passwordHash: 'new-hash',
      otp: otp(),
    });
    assert.equal(state.users[0].firstName, 'Ada');
    assert.equal(state.users[0].password, 'new-hash');
    assert.equal(state.otps.length, 1, 'existing OTP row reused');
    assert.equal(state.otps[0].OTP, '1234');
    assert.equal(otpRow.id, 50);
  }

  // Re-sign-up without an OTP row yet: one is created.
  {
    const { deps, state } = makeDeps();
    state.users.push({ id: 8, firstName: 'Ada' });
    await refreshUnverifiedAccount(deps, { id: 8 }, { profile: {}, passwordHash: 'h', otp: otp() });
    assert.equal(state.otps.length, 1);
    assert.equal(state.otps[0].userId, 8);
  }

  // Re-sign-up failure: user details are not changed.
  {
    const { deps, state } = makeDeps({ failOn: 'otps' });
    state.users.push({ id: 9, firstName: 'Old', password: 'old' });
    await assert.rejects(
      refreshUnverifiedAccount(deps, { id: 9 }, { profile: { firstName: 'New' }, passwordHash: 'h', otp: otp() }),
      /db failure on otps/
    );
    assert.equal(state.users[0].firstName, 'Old');
    assert.equal(state.users[0].password, 'old');
  }

  console.log('signupAccountPersistence tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
