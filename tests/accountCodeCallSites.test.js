'use strict';

/**
 * How the customer, agent and driver flows use the emailed account code
 * (services/shared/passwordReset.js): sign-up verification, password reset and resend.
 *
 * Loads the real services/Customer/authService.js, services/Agent/authService.js and
 * controllers/Driver/driverAuth.js with the database, Redis, mail and sessions stubbed, and the
 * lifecycle running on the in-memory world of tests/memoryAccountCodes.js. Checks, per flow:
 *  - a userId from the client never picks the account (O-12); one that is sent is checked;
 *  - a used, locked or never-issued code verifies nothing, with the code missing or null
 *    (O-12-R1: a used code is OTP NULL and once matched a missing OTP);
 *  - each flow only serves its own account types (sign-up verify, reset, resend);
 *  - the 5678 test code is accepted where it always was (sign-up verify of all three, customer
 *    reset verify) and nowhere else;
 *  - the statuses and response shapes the installed apps were built against;
 *  - O-12-R2-1: a code verifies only through the flow of its purpose (a password-reset code
 *    never signs an account in through sign-up verify), a resend keeps the purpose, and the
 *    per-account backoff reaches the apps as their existing 429 with retryAfterSeconds;
 *  - O-12-R3-1: an account not verified yet that resets its password (completed or abandoned)
 *    can still verify its sign-up from the email-verification screen's resend.
 * And, from the source tree: no module other than the shared lifecycle reads or compares a
 * code's state, so a new reader cannot reintroduce a loose comparison.
 *   node tests/accountCodeCallSites.test.js
 */

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { Op } = require('sequelize');

const { makeAccountCodeWorld, wrongCode } = require('./memoryAccountCodes');
const realLifecycle = require('../services/shared/passwordReset');
const { UniversalHttpError } = require('../middlewares/universalErrorHandler');
const CustomException = require('../middlewares/customError');

const ROOT = path.join(__dirname, '..');
const { CODE_PURPOSES } = require('../services/shared/otpCode');

const SIGNUP = CODE_PURPOSES.SIGNUP;
const RESET = CODE_PURPOSES.PASSWORD_RESET;

// ── The world the stubs read and record into; replaced for every case ────────────────────────
let world;
const record = { sessions: [], verifiedAt: [], workingHours: [], mails: [] };

function freshWorld() {
  world = makeAccountCodeWorld({
    users: [
      { id: 10, userTypeId: 4, email: 'agent@x.test', firstName: 'Agent', password: 'old-agent' },
      { id: 11, userTypeId: 4, email: 'agent2@x.test', firstName: 'Agent2', password: 'old-agent2' },
      { id: 20, userTypeId: 2, email: 'cust@x.test', firstName: 'Cust', password: 'old-customer' },
      { id: 21, userTypeId: 2, email: 'cust2@x.test', firstName: 'Cust2', password: 'old-customer2' },
      { id: 40, userTypeId: 3, email: 'drv@x.test', firstName: 'Drv', password: 'old-driver' },
      { id: 41, userTypeId: 3, email: 'drv2@x.test', firstName: 'Drv2', password: 'old-driver2' },
    ],
  });
  record.sessions = [];
  record.verifiedAt = [];
  record.workingHours = [];
  record.mails = [];
  return world;
}

// ── Stub models over the world's users ───────────────────────────────────────────────────────
function userRow(u) {
  if (!u) return null;
  const plain = { ...u };
  return { ...plain, dataValues: plain, get: () => ({ ...plain }) };
}

function matches(u, where = {}) {
  if (where[Op.or] && !where[Op.or].some((w) => matches(u, w))) return false;
  if (where[Op.and] && !where[Op.and].every((w) => matches(u, w))) return false;
  for (const [key, cond] of Object.entries(where)) {
    const value = u[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if (Op.in in cond && !cond[Op.in].map(String).includes(String(value))) return false;
      if (Op.or in cond && !cond[Op.or].map(String).includes(String(value))) return false;
      if (Op.is in cond && (value ?? null) !== cond[Op.is]) return false;
    } else if (String(value) !== String(cond)) {
      return false;
    }
  }
  return true;
}

const models = {
  sequelize: { transaction: async (fn) => fn({}), literal: (s) => s, fn() {}, col() {} },
  users: {
    async findByPk(id) { return userRow(world.state.users.get(Number(id))); },
    async findOne({ where }) {
      return userRow([...world.state.users.values()].find((u) => matches(u, where)));
    },
    async update(values, { where }) {
      if ('verifiedAt' in values) record.verifiedAt.push(Number(where.id));
      return [1];
    },
  },
  bussinessWorkingHours: {
    async bulkCreate(rows) { record.workingHours.push(...rows); return rows; },
  },
  deviceToken: {},
  otpVerification: {},
};

const lifecycleStub = { ...realLifecycle, defaultPasswordReset: () => world.reset };
const mailStub = async (mail) => { record.mails.push(mail); };
const appSessionStub = {
  resolveSessionIdentity: () => ({ deviceId: 'install-1' }),
  async openAppSession({ userId, claims }) {
    record.sessions.push({ userId, claims });
    return `token-for-${userId}`;
  },
  async endAppSession() {},
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request.endsWith('/models')) return models;
  if (request.endsWith('shared/passwordReset')) return lifecycleStub;
  if (request.endsWith('/redis/redis')) return {};
  if (request.endsWith('/helper/otpMail') || request.endsWith('/helper/forgotPasswordMail')) return mailStub;
  if (request.endsWith('/email/emailOutbox')) return { enqueueEmail: async () => {} };
  if (request.endsWith('/utils/appSession')) return appSessionStub;
  if (request.endsWith('/controllers/stripe') || (request === '../stripe' && parent && /Driver/.test(parent.filename))) return {};
  if (request === './guestAuthService') return {};
  return originalLoad.call(this, request, parent, isMain);
};
const customer = require('../services/Customer/authService');
const agent = require('../services/Agent/authService');
const driver = require('../controllers/Driver/driverAuth');
Module._load = originalLoad;
// Mail helpers the flows require lazily (customer forgetPasswordRequest) resolve to the stub
// too, so no test can reach the mail provider.
for (const helper of ['../helper/otpMail', '../helper/forgotPasswordMail']) {
  const file = require.resolve(helper);
  require.cache[file] = { id: file, filename: file, loaded: true, exports: mailStub };
}

// The shop's display values are not part of these flows.
agent._getUserIanaTimeZone = async () => 'Europe/London';
agent._shopCurrencySymbol = async () => '£';

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────
async function rejectsHttp(promise, status, message) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof UniversalHttpError, `expected UniversalHttpError, got ${err && err.stack}`);
    assert.equal(err.statusCode, status, `status for "${err.message}"`);
    if (message) assert.equal(err.message, message);
    return true;
  });
}

/** Call a driver handler; resolves with the JSON body. */
async function callDriver(handler, body) {
  let sent;
  await handler({ body }, { json: (b) => { sent = b; return b; } });
  return sent;
}

const nothingHappened = () => {
  assert.deepEqual(record.sessions, [], 'no session opened');
  assert.deepEqual(record.verifiedAt, [], 'no account verified');
  assert.deepEqual(record.workingHours, [], 'no working hours created');
};

/** Use a code up through a completed reset, leaving OTP NULL (the row state of O-12-R1). */
async function usedRow(userId, userTypeIds) {
  const c = await world.reset.issueCode({ userId, purpose: RESET });
  await world.reset.verifyResetCode({ otpId: c.otpId, code: c.code, userTypeIds });
  await world.reset.resetPassword({ otpId: c.otpId, password: 'reset', userTypeIds });
  assert.equal(world.row(c.otpId).OTP, null);
  world.state.ended = [];
  return c.otpId;
}

/** Lock a sign-up code with wrong guesses (OTP NULL, failedAttempts at the limit). */
async function lockedRow(userId, userTypeIds) {
  const c = await world.reset.issueCode({ userId, purpose: SIGNUP });
  for (let i = 0; i < realLifecycle.MAX_FAILED_ATTEMPTS; i += 1) {
    await assert.rejects(world.reset.verifySignupCode({ otpId: c.otpId, code: wrongCode(c.code), userTypeIds }));
  }
  assert.equal(world.row(c.otpId).OTP, null);
  return c;
}

const NO_CODE = [undefined, null, ''];

async function run() {
  // ═══ Customer ═══════════════════════════════════════════════════════════════════════════
  {
    // O-12-R1: a used row, any userId, no code → nothing (it once minted a session).
    freshWorld();
    const used = await usedRow(20, [2]);
    for (const OTP of NO_CODE) {
      await rejectsHttp(customer.verifyOTpSignUp({ otpId: used, userId: 21, OTP, deviceId: 'd' }), 401);
      await rejectsHttp(customer.verifyOTpSignUp({ otpId: used, userId: 20, OTP, deviceId: 'd' }), 400);
      await rejectsHttp(customer.verifyOTpSignUp({ otpId: used, OTP, deviceId: 'd' }), 400);
    }
    nothingHappened();

    // A live code of customer 20 with customer 21's userId (accepted on main) → 401, code kept.
    const live = await world.reset.issueCode({ userId: 20, purpose: SIGNUP });
    await rejectsHttp(customer.verifyOTpSignUp({ otpId: live.otpId, userId: 21, OTP: live.code, deviceId: 'd' }), 401);
    assert.equal(world.row(live.otpId).OTP, live.code);
    // Wrong code: the customer app's 400, its wording, and the attempts left.
    await assert.rejects(
      customer.verifyOTpSignUp({ otpId: live.otpId, userId: 20, OTP: wrongCode(live.code), deviceId: 'd' }),
      (err) => err.statusCode === 400
        && err.message === 'Entered Incorrect OTP. Please enter correct OTP to continue'
        && err.details.attemptsRemaining === realLifecycle.MAX_FAILED_ATTEMPTS - 1
    );
    nothingHappened();

    // The right code: the owner is verified and signed in; the code is used up.
    const out = await customer.verifyOTpSignUp({ otpId: String(live.otpId), userId: '20', OTP: live.code, deviceId: 'd' });
    assert.equal(out.userData.id, 20);
    assert.equal(out.accessToken, 'token-for-20');
    assert.equal(out.isGuest, false);
    assert.deepEqual(record.verifiedAt, [20]);
    assert.deepEqual(record.sessions.map((s) => s.claims.id), [20]);
    await rejectsHttp(customer.verifyOTpSignUp({ otpId: live.otpId, userId: 20, OTP: live.code, deviceId: 'd' }), 400);

    // A locked code and an agent's code are refused; an unknown otpId is the app's 404.
    freshWorld();
    const locked = await lockedRow(21, [2]);
    await rejectsHttp(customer.verifyOTpSignUp({ otpId: locked.otpId, userId: 21, OTP: locked.code, deviceId: 'd' }), 429);
    const agentCode = await world.reset.issueCode({ userId: 10, purpose: SIGNUP });
    await rejectsHttp(customer.verifyOTpSignUp({ otpId: agentCode.otpId, OTP: agentCode.code, deviceId: 'd' }), 404);
    await rejectsHttp(customer.verifyOTpSignUp({ otpId: 999, userId: 20, OTP: '1234', deviceId: 'd' }), 404);
    nothingHappened();

    // 5678 (kept where it was): sign-up verify of the code's own account only.
    const own = await world.reset.issueCode({ userId: 20, purpose: SIGNUP });
    await rejectsHttp(customer.verifyOTpSignUp({ otpId: own.otpId, userId: 21, OTP: '5678', deviceId: 'd' }), 401);
    nothingHappened();
    const viaTest = await customer.verifyOTpSignUp({ otpId: own.otpId, userId: 20, OTP: '5678', deviceId: 'd' });
    assert.equal(viaTest.userData.id, 20);
    assert.equal(world.row(own.otpId).OTP, null, 'the emailed code is used up too');
  }

  {
    // Reset: the code's owner is reset, a client userId is checked and never picks the account.
    freshWorld();
    const c = await world.reset.issueCode({ userId: 20, purpose: RESET });
    await rejectsHttp(customer.verifyOTPforPassword({ otpId: c.otpId, OTP: wrongCode(c.code) }), 400);
    await rejectsHttp(customer.verifyOTPforPassword({ otpId: c.otpId, userId: 21, OTP: c.code }), 401);
    assert.deepEqual(
      await customer.verifyOTPforPassword({ otpId: c.otpId, OTP: c.code }),
      { otpId: c.otpId, userId: 20, message: 'OTP verified' }
    );
    await rejectsHttp(customer.changePasswordOTP({ otpId: c.otpId, userId: 21, password: 'pwned' }), 401);
    assert.equal(world.state.users.get(21).password, 'old-customer2');
    assert.deepEqual(
      await customer.changePasswordOTP({ otpId: c.otpId, password: 'n3w' }),
      { message: 'Password updated successfully. Please login to continue' }
    );
    assert.equal(world.state.users.get(20).password, 'hash(n3w)');
    assert.deepEqual(world.state.ended, [20]);
    await rejectsHttp(customer.changePasswordOTP({ otpId: c.otpId, password: 'again' }), 401);

    // A driver's reset code is not found through the customer endpoints.
    const d = await world.reset.issueCode({ userId: 40, purpose: RESET });
    await rejectsHttp(customer.verifyOTPforPassword({ otpId: d.otpId, OTP: d.code }), 404);

    // 5678 on customer reset verify (kept where it was) opens the owner's reset only.
    const t = await world.reset.issueCode({ userId: 21, purpose: RESET });
    await rejectsHttp(customer.verifyOTPforPassword({ otpId: t.otpId, userId: 20, OTP: '5678' }), 401);
    assert.equal((await customer.verifyOTPforPassword({ otpId: t.otpId, OTP: '5678' })).userId, 21);

    // Resend: customers only.
    await rejectsHttp(customer.resendOTP({ userId: 10 }), 404);
    await rejectsHttp(customer.resendOTP({ userId: 40 }), 404);
    await rejectsHttp(customer.resendOTP({ userId: { $gt: 0 } }), 404);
    const r = await customer.resendOTP({ userId: '20' });
    assert.deepEqual(Object.keys(r).sort(), ['message', 'otpId']);
    assert.equal(world.row(r.otpId).userId, 20);
    assert.equal(record.mails.at(-1).email, 'cust@x.test');
  }

  // ═══ Agent ══════════════════════════════════════════════════════════════════════════════
  {
    freshWorld();
    const used = await usedRow(10, [4]);
    for (const OTP of NO_CODE) {
      await rejectsHttp(agent.verifyOTpSignUp({ otpId: used, userId: 11, OTP }), 401);
      await rejectsHttp(agent.verifyOTpSignUp({ otpId: used, userId: 10, OTP }), 400);
    }
    nothingHappened();

    const live = await world.reset.issueCode({ userId: 10, purpose: SIGNUP });
    await rejectsHttp(agent.verifyOTpSignUp({ otpId: live.otpId, userId: 11, OTP: live.code }), 401);
    await rejectsHttp(
      agent.verifyOTpSignUp({ otpId: live.otpId, userId: 10, OTP: wrongCode(live.code) }),
      401,
      'Entered Incorrect OTP. Please enter correct OTP to continue'
    );
    await rejectsHttp(
      agent.verifyOTpSignUp({ otpId: 999, userId: 10, OTP: '1234' }),
      404,
      'Sorry, we could not fetch the data or You Entered Incorrect OTP'
    );
    nothingHappened();

    const out = await agent.verifyOTpSignUp({ otpId: String(live.otpId), userId: '10', OTP: live.code });
    assert.deepEqual(out, { userId: '10', ianaTimeZone: 'Europe/London', currencyUnit: '£' }, 'the app reads these');
    assert.deepEqual(record.verifiedAt, [10]);
    assert.equal(record.workingHours.length, 7);
    assert.ok(record.workingHours.every((h) => h.userId === 10), 'working hours for the code owner');
    await rejectsHttp(agent.verifyOTpSignUp({ otpId: live.otpId, userId: 10, OTP: live.code }), 400);
    assert.equal(record.workingHours.length, 7, 'a used code creates nothing more');

    // Expired code: the agent app's 401.
    freshWorld();
    const old = await world.reset.issueCode({ userId: 10, purpose: SIGNUP });
    world.advance(2 * 60 * 1000);
    await rejectsHttp(agent.verifyOTpSignUp({ otpId: old.otpId, userId: 10, OTP: old.code }), 401);
    // A customer's code is not found through the agent endpoint.
    const cust = await world.reset.issueCode({ userId: 20, purpose: SIGNUP });
    await rejectsHttp(agent.verifyOTpSignUp({ otpId: cust.otpId, userId: 20, OTP: cust.code }), 404);
    nothingHappened();

    // 5678 (kept where it was): sign-up verify of the code's own account only.
    const own = await world.reset.issueCode({ userId: 11, purpose: SIGNUP });
    await rejectsHttp(agent.verifyOTpSignUp({ otpId: own.otpId, userId: 10, OTP: '5678' }), 401);
    nothingHappened();
    assert.equal((await agent.verifyOTpSignUp({ otpId: own.otpId, userId: 11, OTP: '5678' })).userId, 11);
  }

  {
    freshWorld();
    const c = await world.reset.issueCode({ userId: 10, purpose: RESET });
    // 5678 is not a reset code for agents: it counts as a wrong guess.
    await rejectsHttp(agent.verifyOTPforPassword({ otpId: c.otpId, userId: 10, OTP: '5678' }), 401);
    assert.equal(world.row(c.otpId).failedAttempts, 1);
    await rejectsHttp(agent.verifyOTPforPassword({ otpId: c.otpId, userId: 11, OTP: c.code }), 401);
    assert.deepEqual(
      await agent.verifyOTPforPassword({ otpId: c.otpId, userId: '10', OTP: c.code }),
      { otpId: c.otpId, userId: 10 }
    );
    await rejectsHttp(agent.changePasswordOTP({ otpId: c.otpId, userId: 11, password: 'pwned' }), 401);
    assert.equal(world.state.users.get(11).password, 'old-agent2');
    assert.deepEqual(await agent.changePasswordOTP({ otpId: c.otpId, userId: '10', password: 'n3w' }), {});
    assert.equal(world.state.users.get(10).password, 'hash(n3w)');
    assert.deepEqual(world.state.ended, [10]);

    await rejectsHttp(agent.resendOTP({ userId: 20 }), 404);
    await rejectsHttp(agent.resendOTP({ userId: 40 }), 404);
    const r = await agent.resendOTP({ userId: 11 });
    assert.deepEqual(Object.keys(r), ['otpId']);
    assert.equal(world.row(r.otpId).userId, 11);
  }

  // ═══ Driver ═════════════════════════════════════════════════════════════════════════════
  for (const [name, handler] of [['verifyOTP', driver.verifyOTP], ['verifyOtp', driver.verifyOtp]]) {
    freshWorld();
    // The driver app sends { OTP, userId }: the userId names the account, the code proves it.
    const locked = await lockedRow(40, [3]);
    for (const OTP of NO_CODE) {
      await rejectsHttp(callDriver(handler, { userId: 40, OTP }), 429);
      await rejectsHttp(callDriver(handler, { userId: '40', OTP }), 429);
    }
    await rejectsHttp(callDriver(handler, { userId: 40, OTP: locked.code }), 429);
    const used = await usedRow(41, [3]);
    for (const OTP of NO_CODE) {
      await rejectsHttp(callDriver(handler, { userId: 41, OTP }), 400);
      await rejectsHttp(callDriver(handler, { otpId: used, userId: 40, OTP }), 401);
    }
    // Other account types, unknown accounts and no account at all.
    const cust = await world.reset.issueCode({ userId: 20, purpose: SIGNUP });
    await rejectsHttp(callDriver(handler, { userId: 20, OTP: cust.code }), 400, 'OTP Data not available');
    await rejectsHttp(callDriver(handler, { userId: 999, OTP: '1234' }), 400, 'OTP Data not available');
    await rejectsHttp(callDriver(handler, { OTP: '1234' }), 400, 'OTP Data not available');
    nothingHappened();

    const live = await world.reset.issueCode({ userId: 40, purpose: SIGNUP });
    await rejectsHttp(callDriver(handler, { userId: 40, OTP: wrongCode(live.code) }), 400, 'Invalid OTP');
    const body = await callDriver(handler, { userId: '40', OTP: live.code });
    assert.deepEqual(body, { status: '1', messsage: 'OTP verified Sucessfully', data: { userId: '40' }, error: '' }, name);
    assert.deepEqual(record.verifiedAt, [40]);
    await rejectsHttp(callDriver(handler, { userId: 40, OTP: live.code }), 400);

    // 5678 (kept where it was): the named driver account, which must have a code row.
    freshWorld();
    await rejectsHttp(callDriver(handler, { userId: 40, OTP: '5678' }), 400, 'OTP Data not available');
    await world.reset.issueCode({ userId: 40, purpose: SIGNUP });
    await rejectsHttp(callDriver(handler, { userId: 20, OTP: '5678' }), 400, 'OTP Data not available');
    assert.equal((await callDriver(handler, { userId: 40, OTP: '5678' })).data.userId, 40);
  }

  {
    // Registration step 1 again for an unverified driver: a new code on the account's one row,
    // emailed after it is stored, counted against the account's code limit.
    freshWorld();
    world.state.users.get(41).verifiedAt = null;
    world.state.codes.push({ id: 50, userId: 41, OTP: '1111', expirtAt: world.state.clock, failedAttempts: 0 });
    world.state.codes.push({ id: 51, userId: 41, OTP: '2222', expirtAt: world.state.clock, failedAttempts: 0 });
    const step1 = { email: 'drv2@x.test', phoneNum: '000' };
    const body = await callDriver(driver.driverregisterStep1, step1);
    assert.equal(body.status, '1');
    assert.equal(body.data.userId, '41');
    assert.equal(record.mails.at(-1).OTP, world.row(50).OTP, 'the stored code is the emailed one');
    assert.equal(world.row(51).OTP, null, 'one live code per account');
    const verified = await callDriver(driver.verifyOTP, { userId: 41, OTP: record.mails.at(-1).OTP });
    assert.equal(verified.status, '1');
    for (let i = 1; i < realLifecycle.CODE_ISSUE_LIMITS.hourly.max; i += 1) await callDriver(driver.driverregisterStep1, step1);
    await rejectsHttp(callDriver(driver.driverregisterStep1, step1), 429);
  }

  {
    freshWorld();
    const c = await world.reset.issueCode({ userId: 40, purpose: RESET });
    await rejectsHttp(callDriver(driver.verifyOTPforPassword, { otpId: c.otpId, OTP: '5678' }), 400);
    await rejectsHttp(callDriver(driver.verifyOTPforPassword, { otpId: c.otpId, userId: 41, OTP: c.code }), 401);
    const verified = await callDriver(driver.verifyOTPforPassword, { otpId: c.otpId, OTP: c.code });
    assert.deepEqual(verified.data, { otpId: c.otpId, userId: 40 });
    await rejectsHttp(callDriver(driver.changePasswordOTP, { otpId: c.otpId, userId: 41, password: 'pwned' }), 401);
    assert.equal(world.state.users.get(41).password, 'old-driver2');
    const changed = await callDriver(driver.changePasswordOTP, { otpId: c.otpId, password: 'n3w' });
    assert.equal(changed.status, '1');
    assert.equal(world.state.users.get(40).password, 'hash(n3w)');
    assert.deepEqual(world.state.ended, [40]);

    // Unchanged refusal: the driver API's customError (400 through the universal handler).
    for (const userId of [20, 10, 999, { $gt: 0 }]) {
      await assert.rejects(callDriver(driver.resendOTP, { userId }), (err) =>
        err instanceof CustomException && err.message === 'Sorry, we could not fetch the associated data');
    }
    const r = await callDriver(driver.resendOTP, { userId: 41 });
    assert.deepEqual(Object.keys(r.data).sort(), ['otpId', 'otpid', 'userId']);
    assert.equal(world.row(r.data.otpId).userId, 41);
  }

  // ═══ O-12-R2-1: a code verifies only for its purpose; issuing is bounded over days ═════════
  {
    // Customer: a password-reset code never signs the account in through sign-up verify, with
    // the code or with 5678; the reset itself still works with it.
    freshWorld();
    const forgot = await world.reset.issueCode({ userId: 20, purpose: RESET });
    for (const OTP of [forgot.code, '5678']) {
      await rejectsHttp(customer.verifyOTpSignUp({ otpId: forgot.otpId, userId: 20, OTP, deviceId: 'd' }), 400);
      await rejectsHttp(customer.verifyOTpSignUp({ otpId: forgot.otpId, OTP, deviceId: 'd' }), 400);
    }
    nothingHappened();
    assert.equal(world.codeOf(forgot.otpId), forgot.code);
    // The forgot-password screen's resend keeps the reset purpose.
    const resent = await customer.resendOTP({ userId: 20 });
    const resentCode = world.codeOf(resent.otpId);
    await rejectsHttp(customer.verifyOTpSignUp({ otpId: resent.otpId, OTP: resentCode, deviceId: 'd' }), 400);
    assert.equal((await customer.verifyOTPforPassword({ otpId: resent.otpId, OTP: resentCode })).userId, 20);
    // A verified customer's resend is a reset code, never a sign-up one.
    world.state.users.get(21).verifiedAt = new Date('2026-01-01T00:00:00Z');
    const verifiedResend = await customer.resendOTP({ userId: 21 });
    await rejectsHttp(customer.verifyOTpSignUp({
      otpId: verifiedResend.otpId, OTP: world.codeOf(verifiedResend.otpId), deviceId: 'd',
    }), 400);
    nothingHappened();
    // A sign-up code never opens a reset (5678 included).
    const signup = await world.reset.issueCode({ userId: 20, purpose: SIGNUP });
    await rejectsHttp(customer.verifyOTPforPassword({ otpId: signup.otpId, OTP: signup.code }), 400);
    await rejectsHttp(customer.verifyOTPforPassword({ otpId: signup.otpId, OTP: '5678' }), 400);
    await rejectsHttp(customer.changePasswordOTP({ otpId: signup.otpId, password: 'x' }), 401);
    assert.equal(world.state.users.get(20).password, 'old-customer');
    assert.equal(world.codeOf(signup.otpId), signup.code, 'refused attempts leave the code alone');
  }

  {
    // Agent: forget-password issues a reset code; sign-up verify refuses it; the shop is not
    // verified and gets no working hours.
    freshWorld();
    const forgot = await agent.forgetPasswordRequest({ email: 'agent@x.test' });
    assert.equal(record.mails.at(-1).type, 'ForgetPassword');
    const code = world.codeOf(forgot.otpId);
    await rejectsHttp(agent.verifyOTpSignUp({ otpId: forgot.otpId, userId: 10, OTP: code }), 400);
    await rejectsHttp(agent.verifyOTpSignUp({ otpId: forgot.otpId, userId: 10, OTP: '5678' }), 400);
    nothingHappened();
    const resent = await agent.resendOTP({ userId: 10 });
    assert.equal(world.row(resent.otpId).codePurpose, RESET);
    // Driver: the same, by userId (the driver app sends no otpId).
    const drv = await callDriver(driver.forgetPasswordRequest, { email: 'drv@x.test' });
    const drvCode = world.codeOf(drv.data.otpId);
    for (const handler of [driver.verifyOTP, driver.verifyOtp]) {
      await rejectsHttp(callDriver(handler, { userId: 40, OTP: drvCode }), 400);
      await rejectsHttp(callDriver(handler, { userId: 40, OTP: '5678' }), 400);
    }
    nothingHappened();
    const drvResent = await callDriver(driver.resendOTP, { userId: 40 });
    assert.equal(world.row(drvResent.data.otpId).codePurpose, RESET);
    assert.equal((await callDriver(driver.verifyOTPforPassword, {
      otpId: drvResent.data.otpId, OTP: world.codeOf(drvResent.data.otpId),
    })).data.userId, 40);
  }

  {
    // Wrong guesses add up per account: after the second locked code the next code waits,
    // with the 429 and retryAfterSeconds the apps already handle.
    freshWorld();
    for (let n = 0; n < 2; n += 1) {
      const c = await world.reset.issueCode({ userId: 10, purpose: RESET });
      for (let i = 0; i < realLifecycle.MAX_FAILED_ATTEMPTS; i += 1) {
        await assert.rejects(agent.verifyOTPforPassword({ otpId: c.otpId, userId: 10, OTP: wrongCode(c.code) }));
      }
    }
    for (const request of [
      () => agent.forgetPasswordRequest({ email: 'agent@x.test' }),
      () => agent.resendOTP({ userId: 10 }),
    ]) {
      await assert.rejects(request(), (err) => {
        assert.ok(err instanceof UniversalHttpError);
        assert.equal(err.statusCode, 429);
        assert.equal(err.details.retryAfterSeconds, realLifecycle.FAILED_GUESS_BACKOFF.baseSec);
        return true;
      });
    }
    world.advance(realLifecycle.FAILED_GUESS_BACKOFF.baseSec * 1000);
    assert.ok((await agent.resendOTP({ userId: 10 })).otpId);
  }

  // ═══ O-12-R3-1: an unverified account's reset ends; its sign-up verification still works ═══
  // Forget password → (reset completed, or abandoned) → login sends the account to email
  // verification with its otpId → resend there → sign-up verify with the emailed code.
  const flows = [
    {
      name: 'customer',
      userId: 20,
      async forget() { return (await customer.forgetPasswordRequest({ email: 'cust@x.test' })).otpId; },
      async verifyReset(otpId, OTP) { await customer.verifyOTPforPassword({ otpId, OTP }); },
      async changePassword(otpId) { await customer.changePasswordOTP({ otpId, password: 'n3w' }); },
      async resend() { return (await customer.resendOTP({ userId: 20 })).otpId; },
      async verifySignup(otpId, OTP) {
        assert.equal((await customer.verifyOTpSignUp({ otpId, userId: 20, OTP, deviceId: 'd' })).userData.id, 20);
        assert.deepEqual(record.sessions.map((x) => x.userId), [20], 'signed in');
      },
    },
    {
      name: 'agent',
      userId: 10,
      async forget() { return (await agent.forgetPasswordRequest({ email: 'agent@x.test' })).otpId; },
      async verifyReset(otpId, OTP) { await agent.verifyOTPforPassword({ otpId, userId: 10, OTP }); },
      async changePassword(otpId) { await agent.changePasswordOTP({ otpId, userId: 10, password: 'n3w' }); },
      async resend() { return (await agent.resendOTP({ userId: 10 })).otpId; },
      async verifySignup(otpId, OTP) {
        assert.equal((await agent.verifyOTpSignUp({ otpId, userId: 10, OTP })).userId, 10);
        assert.deepEqual(record.verifiedAt, [10], 'verified');
      },
    },
    {
      name: 'driver',
      userId: 40,
      async forget() { return (await callDriver(driver.forgetPasswordRequest, { email: 'drv@x.test' })).data.otpId; },
      async verifyReset(otpId, OTP) { await callDriver(driver.verifyOTPforPassword, { otpId, OTP }); },
      async changePassword(otpId) {
        assert.equal((await callDriver(driver.changePasswordOTP, { otpId, password: 'n3w' })).status, '1');
      },
      async resend() { return (await callDriver(driver.resendOTP, { userId: 40 })).data.otpId; },
      async verifySignup(otpId, OTP) {
        assert.equal((await callDriver(driver.verifyOTP, { userId: 40, OTP })).status, '1');
        assert.deepEqual(record.verifiedAt, [40], 'verified');
      },
    },
  ];
  for (const flow of flows) {
    // Completed reset: the next resend is a sign-up code, at once.
    freshWorld();
    const forgot = await flow.forget();
    assert.equal(world.row(forgot).codePurpose, RESET, flow.name);
    await flow.verifyReset(forgot, world.codeOf(forgot));
    await flow.changePassword(forgot);
    assert.equal(world.state.users.get(flow.userId).password, 'hash(n3w)', flow.name);
    assert.equal(world.row(forgot).codePurpose, null, `${flow.name}: the reset purpose ended with the reset`);
    const resent = await flow.resend();
    assert.equal(world.row(resent).codePurpose, SIGNUP, flow.name);
    await flow.verifySignup(resent, world.codeOf(resent));

    // Abandoned reset (code never entered): a reset code while it is in progress, then a
    // sign-up code that verifies.
    freshWorld();
    const abandoned = await flow.forget();
    world.advance(realLifecycle.RESET_IN_PROGRESS_MS - 1);
    const stillResetting = await flow.resend();
    assert.equal(world.row(stillResetting).codePurpose, RESET, `${flow.name}: forgot-password screen's resend`);
    world.advance(realLifecycle.RESET_IN_PROGRESS_MS);
    const resentLater = await flow.resend();
    assert.equal(resentLater, abandoned, 'the account\'s one row');
    assert.equal(world.row(resentLater).codePurpose, SIGNUP, flow.name);
    nothingHappened();
    await flow.verifySignup(resentLater, world.codeOf(resentLater));
  }

  // ═══ Source: only the shared lifecycle reads or compares a code's state ═════════════════
  {
    const OWNERS = new Set([
      'services/shared/passwordReset.js',
      'services/shared/otpCode.js',
      'models/otpverification.js',
    ]);
    const SKIP_DIRS = new Set(['node_modules', 'tests', 'migrations', 'seeders', 'scripts', 'coverage', '.git', 'public', 'uploads', 'docs']);
    // Code-state columns, in any file that touches the otpVerifications model or table.
    const STATE_COLUMNS = /\b(expirtAt|failedAttempts|verifiedAtForgetCase|resetExpiresAt|codePurpose)\b/;
    const TOUCHES_CODES = /\botpVerifications?\b/;
    // A stored code compared with anything but a literal (the 5678 test code is a literal).
    const CODE_COMPARE = /\.OTP\s*[!=]==?(?!=)\s*(?![\s'"`])|(?<!['"`]\s*)[!=]==?\s*[\w$.]*\.OTP\b/;
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') && entry.isDirectory()) continue;
        const full = path.join(dir, entry.name);
        const rel = path.relative(ROOT, full).split(path.sep).join('/');
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(full);
        } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js') && !OWNERS.has(rel)) {
          const text = fs.readFileSync(full, 'utf8');
          const touchesCodes = TOUCHES_CODES.test(text);
          text.split(/\r?\n/).forEach((line, i) => {
            if ((touchesCodes && STATE_COLUMNS.test(line)) || CODE_COMPARE.test(line)) {
              offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
            }
          });
        }
      }
    };
    // The patterns catch the O-12-R1 comparisons and leave the test-code checks alone.
    assert.ok(CODE_COMPARE.test('if (otpData.OTP != OTP) {'));
    assert.ok(CODE_COMPARE.test("if (otpData.OTP != OTP && OTP !== '5678') {"));
    assert.ok(CODE_COMPARE.test('if (data.OTP == row.OTP) {'));
    assert.ok(!CODE_COMPARE.test("skipCodeCheck: data.OTP === '5678',"));
    assert.ok(!CODE_COMPARE.test("verifyDriverSignupCode(req, res, req.body.OTP == '5678')"));
    walk(ROOT);
    assert.deepEqual(offenders, [], 'code state is read only through services/shared/passwordReset.js');
  }

  console.log('accountCodeCallSites.test.js: all assertions passed');
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
