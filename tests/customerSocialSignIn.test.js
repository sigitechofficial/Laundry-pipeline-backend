'use strict';

/**
 * Customer social sign-in (POST /customer/loginUser with signedFrom google/apple/facebook) and
 * the email shared by every account type.
 *
 * services/shared/firebaseSocialIdentity.js — the identity of a social sign-in is the verified
 * Firebase ID token's, never the body's:
 *  - no token (older app builds) → 401 SOCIAL_TOKEN_REQUIRED;
 *  - not a JWT / bad signature / expired / revoked → 401 SOCIAL_TOKEN_INVALID;
 *  - a token of a project this server does not hold → 401, Firebase never asked;
 *  - a reported firebaseProjectId that is not the token's project → 401;
 *  - a sign-in provider other than signedFrom → 401 SOCIAL_PROVIDER_MISMATCH;
 *  - no email / email not verified → 401 SOCIAL_EMAIL_UNVERIFIED;
 *  - Firebase unreachable → 503 (never a pass); verification always checks revocation.
 *
 * services/Customer/authService.js loginUser (real service, database / sessions stubbed):
 *  - the session is for the token's email (a different email in the body is ignored);
 *  - the "Information Missing" two-step sign-up creates the account from the token's email;
 *  - an address of a shop / driver / staff account or of a deleted account → 409, no row created.
 *
 * services/shared/accountEmail.js call sites:
 *  - agent sign-up over an unverified driver row → 409, row untouched, no code, no session;
 *  - driver sign-up over a shop row → 409, row untouched; driver login with a shop email → 400
 *    refusal (was a 500);
 *  - customer email sign-up with a shop email → 409.
 * middlewares/universalErrorHandler.js maps SequelizeUniqueConstraintError to 409.
 *   node tests/customerSocialSignIn.test.js
 */

const assert = require('assert/strict');
const Module = require('module');
const { Op } = require('sequelize');

const {
    createSocialIdentityVerifier,
    SOCIAL_AUTH_ERROR,
    unverifiedAudience,
} = require('../services/shared/firebaseSocialIdentity');
const { UniversalHttpError, uniqueConstraintConflict } = require('../middlewares/universalErrorHandler');
const CustomException = require('../middlewares/customError');
const { EMAIL_IN_USE_CODE, accountKindOf } = require('../services/shared/accountEmail');

const PRIMARY = 'justdrycleansltd';
const LEGACY = 'laundry-app-bf43c';

// ── Firebase stand-in ────────────────────────────────────────────────────────────────────────
/** An unsigned JWT-shaped string; the stub "verifies" it by looking it up in `issued`. */
function jwt(payload) {
    const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${part({ alg: 'RS256', kid: 'k' })}.${part(payload)}.signature`;
}

const issued = new Map(); // token → decoded claims | Error
const verifyCalls = [];

function idToken({ project = PRIMARY, provider = 'google.com', email = 'me@x.test', emailVerified = true, uid = 'uid-me' } = {}) {
    const claims = {
        aud: project,
        iss: `https://securetoken.google.com/${project}`,
        uid,
        sub: uid,
        email,
        email_verified: emailVerified,
        firebase: { sign_in_provider: provider },
    };
    const token = jwt({ ...claims, n: issued.size });
    issued.set(token, claims);
    return token;
}

function failingToken(code, project = PRIMARY) {
    const token = jwt({ aud: project, n: issued.size });
    issued.set(token, Object.assign(new Error(code), { code }));
    return token;
}

const projects = {
    isConfiguredProject: (id) => id === PRIMARY || id === LEGACY,
    authFor(projectId) {
        return {
            async verifyIdToken(token, checkRevoked) {
                verifyCalls.push({ projectId, checkRevoked });
                const entry = issued.get(token);
                if (!entry) throw Object.assign(new Error('bad signature'), { code: 'auth/argument-error' });
                if (entry instanceof Error) throw entry;
                if (entry.aud !== projectId) throw Object.assign(new Error('aud'), { code: 'auth/argument-error' });
                return { ...entry };
            },
        };
    },
};

const verifier = createSocialIdentityVerifier({ projects });

// ── Database stand-in (the users table; MySQL compares emails case-insensitively) ────────────
let rows;
const record = { created: [], updated: [], sessions: [], codes: [], mails: [] };

function resetDb(users) {
    rows = users.map((u) => ({ deletedAt: null, verifiedAt: new Date(), status: true, ...u }));
    record.created = [];
    record.updated = [];
    record.sessions = [];
    record.codes = [];
    record.mails = [];
    verifyCalls.length = 0;
}

function asRow(u) {
    if (!u) return null;
    const plain = { ...u };
    return { ...plain, dataValues: plain, get: () => ({ ...plain }) };
}

function same(value, cond, key) {
    if (key === 'email') return String(value || '').toLowerCase() === String(cond || '').toLowerCase();
    return String(value) === String(cond);
}

function matches(u, where = {}) {
    if (where[Op.or] && !where[Op.or].some((w) => matches(u, w))) return false;
    for (const [key, cond] of Object.entries(where)) {
        const value = u[key];
        if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
            if (Op.in in cond && !cond[Op.in].map(String).includes(String(value))) return false;
            if (Op.is in cond && (value ?? null) !== cond[Op.is]) return false;
        } else if (!same(value, cond, key)) {
            return false;
        }
    }
    return true;
}

const models = {
    sequelize: { transaction: async (fn) => fn({}), literal: (s) => s, fn() {}, col() {} },
    users: {
        async findOne({ where, paranoid }) {
            const visible = paranoid === false ? rows : rows.filter((u) => !u.deletedAt);
            return asRow(visible.find((u) => matches(u, where)));
        },
        async findByPk(id) { return asRow(rows.find((u) => u.id === Number(id))); },
        async create(values) {
            if (rows.some((u) => same(u.email, values.email, 'email'))) {
                const err = new Error('Validation error');
                err.name = 'SequelizeUniqueConstraintError';
                err.fields = { email: values.email };
                throw err;
            }
            const row = { id: 1000 + rows.length, deletedAt: null, ...values };
            rows.push(row);
            record.created.push(row);
            return asRow(row);
        },
        async update(values, { where }) {
            record.updated.push({ values, where });
            return [1];
        },
    },
    otpVerification: { async findOne() { return null; } },
    deviceToken: {},
    countries: {},
    cities: {},
};

const resetStub = {
    defaultPasswordReset: () => ({
        async reserveIssue(args) { record.codes.push(args); },
        async issueCode(args) { record.codes.push(args); return { code: '123456', otpId: 1 }; },
    }),
    toHttpError: (err) => err,
    toId: (v) => Number(v),
};

Module._load = ((originalLoad) => function load(request, parent, isMain) {
    if (request.endsWith('/models')) return models;
    if (request.endsWith('shared/passwordReset')) return { ...originalLoad.call(this, request, parent, isMain), ...resetStub };
    if (request.endsWith('/redis/redis')) return {};
    if (request.endsWith('/helper/otpMail') || request.endsWith('/helper/forgotPasswordMail')) {
        return async (mail) => { record.mails.push(mail); };
    }
    if (request.endsWith('/email/emailOutbox')) return { enqueueEmail: async () => {} };
    if (request.endsWith('/utils/appSession')) {
        return {
            resolveSessionIdentity: () => ({ deviceId: 'install-1' }),
            async openAppSession({ userId, claims }) {
                record.sessions.push({ userId, claims });
                return `token-for-${userId}`;
            },
            async endAppSession() {},
            signupPushToken: () => ({}),
        };
    }
    if (request.endsWith('/controllers/stripe') || (request === '../stripe' && parent && /Driver/.test(parent.filename))) return {};
    if (request === './guestAuthService') return {};
    return originalLoad.call(this, request, parent, isMain);
})(Module._load);

const customer = require('../services/Customer/authService');
const agent = require('../services/Agent/authService');
const driver = require('../controllers/Driver/driverAuth');
customer.socialIdentity = verifier;
agent._getUserIanaTimeZone = async () => 'Europe/London';

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────
async function rejectsHttp(promise, status, code) {
    let caught;
    await assert.rejects(promise, (err) => {
        caught = err;
        assert.ok(err instanceof UniversalHttpError, `expected UniversalHttpError, got ${err && err.stack}`);
        assert.equal(err.statusCode, status, `status for "${err.message}"`);
        if (code) assert.equal(err.details && err.details.code, code, `code for "${err.message}"`);
        return true;
    });
    return caught;
}

const nothingWritten = () => {
    assert.deepEqual(record.created, [], 'no row created');
    assert.deepEqual(record.updated, [], 'no row updated');
    assert.deepEqual(record.sessions, [], 'no session opened');
    assert.deepEqual(record.codes, [], 'no sign-up code issued');
    assert.deepEqual(record.mails, [], 'no mail sent');
};

function socialLogin(body) {
    return customer.loginUser({ password: '', deviceId: 'install-1', ...body });
}

async function callDriver(handler, body) {
    let sent;
    await handler({ body, files: {} }, { json: (b) => { sent = b; return b; } });
    return sent;
}

const AGENT_ROW = { id: 10, userTypeId: 4, email: 'shop@x.test', firstName: 'Shop', password: 'hash-shop' };
const DRIVER_UNVERIFIED = {
    id: 40, userTypeId: 3, email: 'drv@x.test', firstName: 'Drv', lastName: 'D',
    phoneNum: '7400000040', password: 'hash-driver', verifiedAt: null,
};
const CUSTOMER_ME = {
    id: 20, userTypeId: 2, email: 'me@x.test', firstName: 'Me', lastName: 'C', phoneNum: '7400000020', signedFrom: 'google',
};
const CUSTOMER_VICTIM = {
    id: 21, userTypeId: 2, email: 'victim@x.test', firstName: 'Vic', lastName: 'T', phoneNum: '7400000021', signedFrom: 'google',
};

async function run() {
    // ═══ The verifier ═══════════════════════════════════════════════════════════════════════
    {
        assert.equal(unverifiedAudience(jwt({ aud: PRIMARY })), PRIMARY);
        assert.equal(unverifiedAudience('not-a-jwt'), null);
        assert.equal(unverifiedAudience('a.%%%.c'), null);

        for (const firebaseIdToken of [undefined, null, '', '   ']) {
            await rejectsHttp(verifier.verifySocialSignIn({ signedFrom: 'google', firebaseIdToken }), 401, SOCIAL_AUTH_ERROR.TOKEN_REQUIRED);
        }
        await rejectsHttp(verifier.verifySocialSignIn({ signedFrom: 'google', firebaseIdToken: 'garbage' }), 401, SOCIAL_AUTH_ERROR.TOKEN_INVALID);
        // Forged: JWT-shaped, right project, but not a token Firebase issued (signature fails).
        await rejectsHttp(verifier.verifySocialSignIn({ signedFrom: 'google', firebaseIdToken: jwt({ aud: PRIMARY, email: 'victim@x.test' }) }), 401, SOCIAL_AUTH_ERROR.TOKEN_INVALID);
        for (const code of ['auth/id-token-expired', 'auth/id-token-revoked', 'auth/user-disabled', 'auth/argument-error']) {
            const err = await rejectsHttp(verifier.verifySocialSignIn({ signedFrom: 'google', firebaseIdToken: failingToken(code) }), 401, SOCIAL_AUTH_ERROR.TOKEN_INVALID);
            if (code === 'auth/id-token-expired') assert.match(err.message, /expired/);
        }
        // Firebase unreachable: a 503, never a pass.
        await rejectsHttp(verifier.verifySocialSignIn({ signedFrom: 'google', firebaseIdToken: failingToken('app/network-error') }), 503, SOCIAL_AUTH_ERROR.VERIFY_UNAVAILABLE);

        // A project this server does not hold: refused before Firebase is asked.
        verifyCalls.length = 0;
        await rejectsHttp(verifier.verifySocialSignIn({ signedFrom: 'google', firebaseIdToken: idToken({ project: 'someone-elses-app' }) }), 401, SOCIAL_AUTH_ERROR.PROJECT_UNKNOWN);
        assert.equal(verifyCalls.length, 0);
        // The reported project must be the token's.
        await rejectsHttp(verifier.verifySocialSignIn({ signedFrom: 'google', firebaseIdToken: idToken(), firebaseProjectId: LEGACY }), 401, SOCIAL_AUTH_ERROR.TOKEN_INVALID);
        await rejectsHttp(verifier.verifySocialSignIn({ signedFrom: 'google', firebaseIdToken: idToken(), firebaseProjectId: 'NOT A PROJECT!' }), 400);

        // Provider must match signedFrom.
        await rejectsHttp(verifier.verifySocialSignIn({ signedFrom: 'google', firebaseIdToken: idToken({ provider: 'apple.com' }) }), 401, SOCIAL_AUTH_ERROR.PROVIDER_MISMATCH);
        await rejectsHttp(verifier.verifySocialSignIn({ signedFrom: 'apple', firebaseIdToken: idToken({ provider: 'password' }) }), 401, SOCIAL_AUTH_ERROR.PROVIDER_MISMATCH);
        await rejectsHttp(verifier.verifySocialSignIn({ signedFrom: 'facebook', firebaseIdToken: idToken({ provider: 'google.com' }) }), 401, SOCIAL_AUTH_ERROR.PROVIDER_MISMATCH);

        // Verified email required.
        await rejectsHttp(verifier.verifySocialSignIn({ signedFrom: 'facebook', firebaseIdToken: idToken({ provider: 'facebook.com', emailVerified: false }) }), 401, SOCIAL_AUTH_ERROR.EMAIL_UNVERIFIED);
        await rejectsHttp(verifier.verifySocialSignIn({ signedFrom: 'google', firebaseIdToken: idToken({ email: '' }) }), 401, SOCIAL_AUTH_ERROR.EMAIL_UNVERIFIED);

        // Valid: each project verifies its own tokens, with revocation checked.
        verifyCalls.length = 0;
        const legacy = await verifier.verifySocialSignIn({ signedFrom: 'google', firebaseIdToken: idToken({ project: LEGACY }) });
        assert.deepEqual(legacy, { email: 'me@x.test', uid: 'uid-me', firebaseProjectId: LEGACY, signInProvider: 'google.com' });
        const relay = await verifier.verifySocialSignIn({
            signedFrom: 'apple',
            firebaseIdToken: idToken({ provider: 'apple.com', email: 'abc@privaterelay.appleid.com' }),
            firebaseProjectId: PRIMARY,
        });
        assert.equal(relay.email, 'abc@privaterelay.appleid.com');
        assert.deepEqual(verifyCalls, [{ projectId: LEGACY, checkRevoked: true }, { projectId: PRIMARY, checkRevoked: true }]);
    }

    // ═══ Customer loginUser ═════════════════════════════════════════════════════════════════
    {
        // The reported hole: email + signedFrom alone opened the account's session.
        resetDb([CUSTOMER_VICTIM]);
        await rejectsHttp(socialLogin({ email: 'victim@x.test', signedFrom: 'google' }), 401, SOCIAL_AUTH_ERROR.TOKEN_REQUIRED);
        await rejectsHttp(socialLogin({ email: 'victim@x.test', signedFrom: 'apple', firebaseIdToken: 'expired-or-forged' }), 401, SOCIAL_AUTH_ERROR.TOKEN_INVALID);
        await rejectsHttp(socialLogin({ email: 'victim@x.test', signedFrom: 'google', firebaseIdToken: failingToken('auth/id-token-expired') }), 401, SOCIAL_AUTH_ERROR.TOKEN_INVALID);
        await rejectsHttp(socialLogin({ email: 'victim@x.test', signedFrom: 'google', firebaseIdToken: idToken({ provider: 'apple.com', email: 'victim@x.test' }) }), 401, SOCIAL_AUTH_ERROR.PROVIDER_MISMATCH);
        // A new email with no token no longer creates an account.
        await rejectsHttp(socialLogin({ email: 'anyone@x.test', signedFrom: 'google', firstName: 'A', lastName: 'B', phoneNum: '7400000099' }), 401, SOCIAL_AUTH_ERROR.TOKEN_REQUIRED);
        nothingWritten();
    }
    {
        // Valid token: the session is the token email's account; the body's email is ignored.
        resetDb([CUSTOMER_ME, CUSTOMER_VICTIM]);
        const result = await socialLogin({ email: 'victim@x.test', signedFrom: 'google', firebaseIdToken: idToken(), firebaseProjectId: PRIMARY });
        assert.equal(result.type, 'success');
        assert.equal(result.userData.id, 20);
        assert.deepEqual(record.sessions.map((s) => s.userId), [20]);
        assert.deepEqual(record.created, []);
    }
    {
        // Information Missing two-step sign-up: both calls carry the token; the account gets the
        // token's email even when the body names another.
        resetDb([CUSTOMER_VICTIM]);
        const token = idToken({ email: 'new@x.test', uid: 'uid-new' });
        const first = await rejectsHttp(socialLogin({ email: 'victim@x.test', signedFrom: 'google', firebaseIdToken: token }), 400);
        assert.equal(first.message, 'Information Missing');
        assert.equal(first.details.email, 'new@x.test');
        assert.deepEqual(first.details.missingFields, ['firstName', 'lastName', 'phoneNum']);
        nothingWritten();

        const second = await socialLogin({
            email: 'victim@x.test', signedFrom: 'google', firebaseIdToken: token,
            firstName: 'New', lastName: 'Person', phoneNum: '7400000055',
        });
        assert.equal(second.type, 'success');
        assert.equal(record.created.length, 1);
        assert.equal(record.created[0].email, 'new@x.test');
        assert.equal(record.created[0].userTypeId, 2);
        assert.equal(record.created[0].signedFrom, 'google');
        assert.deepEqual(record.sessions.map((s) => s.userId), [record.created[0].id]);
    }
    {
        // A shop owner's email through customer social sign-in: 409, no customer row (was a 500).
        resetDb([AGENT_ROW]);
        const err = await rejectsHttp(
            socialLogin({ signedFrom: 'google', firebaseIdToken: idToken({ email: 'shop@x.test' }), firstName: 'A', lastName: 'B', phoneNum: '7400000001' }),
            409, EMAIL_IN_USE_CODE
        );
        assert.match(err.message, /shop account/);
        nothingWritten();

        // Same for a driver, a shop team member and admin staff, in any letter case.
        for (const other of [
            { id: 41, userTypeId: 3, email: 'Driver@X.test' },
            { id: 42, userTypeId: null, classifiedAsId: 1, email: 'team@x.test' },
            { id: 43, userTypeId: null, classifiedAsId: 2, email: 'staff@x.test' },
            { id: 44, userTypeId: 1, email: 'admin@x.test' },
        ]) {
            resetDb([other]);
            await rejectsHttp(socialLogin({ signedFrom: 'apple', firebaseIdToken: idToken({ provider: 'apple.com', email: other.email.toLowerCase() }) }), 409, EMAIL_IN_USE_CODE);
            nothingWritten();
        }

        // A deleted customer's address (the unique index still holds it): 409, not a 500.
        resetDb([{ ...CUSTOMER_ME, deletedAt: new Date() }]);
        const deleted = await rejectsHttp(socialLogin({ signedFrom: 'google', firebaseIdToken: idToken(), firstName: 'A', lastName: 'B', phoneNum: '7400000001' }), 409, EMAIL_IN_USE_CODE);
        assert.match(deleted.message, /deleted account/);
        nothingWritten();
    }
    {
        // Email + password sign-in is unchanged: it needs no token.
        resetDb([{ ...CUSTOMER_ME, signedFrom: null, password: require('bcryptjs').hashSync('right-password', 4) }]);
        const ok = await customer.loginUser({ email: 'me@x.test', password: 'right-password', signedFrom: '', deviceId: 'install-1' });
        assert.equal(ok.type, 'success');
        assert.deepEqual(record.sessions.map((s) => s.userId), [20]);
        resetDb([{ ...CUSTOMER_ME, signedFrom: null, password: require('bcryptjs').hashSync('right-password', 4) }]);
        await rejectsHttp(customer.loginUser({ email: 'me@x.test', password: 'wrong', signedFrom: '', deviceId: 'install-1' }), 401);
        assert.deepEqual(record.sessions, []);
    }
    {
        // Customer email sign-up with a shop owner's email: 409, the shop row untouched.
        resetDb([AGENT_ROW]);
        await rejectsHttp(customer.registerCustomerWithOTP({
            email: 'shop@x.test', firstName: 'A', lastName: 'B', password: 'pw123456', phoneNum: '7400000002', deviceId: 'install-1',
        }), 409, EMAIL_IN_USE_CODE);
        nothingWritten();
    }

    // ═══ Agent sign-up ══════════════════════════════════════════════════════════════════════
    {
        // An unverified self-registered driver: agent sign-up used to rewrite its profile and
        // password and open a session for it. Now 409 and the row is untouched.
        resetDb([DRIVER_UNVERIFIED]);
        const before = JSON.stringify(rows);
        const err = await rejectsHttp(agent.registerAgentWithOTP({
            email: 'drv@x.test', firstName: 'Evil', lastName: 'Shop', password: 'attacker-pw', phoneNum: '7400000077', deviceId: 'install-1',
        }), 409, EMAIL_IN_USE_CODE);
        assert.match(err.message, /driver account/);
        assert.equal(JSON.stringify(rows), before);
        nothingWritten();

        // The customer wording the agent app already shows is unchanged.
        resetDb([{ ...CUSTOMER_ME, verifiedAt: null }]);
        const cust = await rejectsHttp(agent.registerAgentWithOTP({ email: 'me@x.test', password: 'pw', phoneNum: '1', deviceId: 'install-1' }), 409, EMAIL_IN_USE_CODE);
        assert.equal(cust.message, 'This email is already registered as a customer account. Please use a different email for your shop account.');
        nothingWritten();
    }

    // ═══ Driver sign-up and login ═══════════════════════════════════════════════════════════
    {
        // Driver sign-up with an unverified shop owner's email: 409, no code for the shop row.
        resetDb([{ ...AGENT_ROW, verifiedAt: null }]);
        await rejectsHttp(callDriver(driver.driverregisterStep1, { email: 'shop@x.test', phoneNum: '7400000088', password: 'pw' }), 409, EMAIL_IN_USE_CODE);
        nothingWritten();

        // A phone number held by another driver is not taken over from a different email.
        resetDb([DRIVER_UNVERIFIED]);
        await assert.rejects(callDriver(driver.driverregisterStep1, { email: 'other@x.test', phoneNum: DRIVER_UNVERIFIED.phoneNum, password: 'pw' }), CustomException);
        nothingWritten();

        // The driver's own unverified sign-up still continues (new code on its row).
        resetDb([DRIVER_UNVERIFIED]);
        const again = await callDriver(driver.driverregisterStep1, { email: 'drv@x.test', phoneNum: DRIVER_UNVERIFIED.phoneNum, password: 'pw' });
        assert.equal(again.status, '1');
        assert.deepEqual(record.codes.map((c) => c.userId), [40]);

        // Driver login with a shop owner's email: a refusal, not a 500, and no session.
        resetDb([AGENT_ROW]);
        await assert.rejects(callDriver(driver.driverLogin, { email: 'shop@x.test', password: 'whatever', deviceId: 'install-1' }), CustomException);
        nothingWritten();
    }

    // ═══ Safety net and helpers ═════════════════════════════════════════════════════════════
    {
        const emailClash = uniqueConstraintConflict({ name: 'SequelizeUniqueConstraintError', fields: { 'users.email': 'a@b.c' } });
        assert.equal(emailClash.statusCode, 409);
        assert.equal(emailClash.details.code, 'EMAIL_IN_USE');
        assert.ok(!emailClash.message.includes('a@b.c'), 'the duplicated value is not echoed');
        const other = uniqueConstraintConflict({ name: 'SequelizeUniqueConstraintError', fields: { trackId: 'X1' } });
        assert.equal(other.statusCode, 409);
        assert.equal(other.details.code, 'DUPLICATE_RECORD');

        // Through the middleware.
        const { universalErrorHandler } = require('../middlewares/universalErrorHandler');
        let status;
        let body;
        const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
        const originalError = console.error;
        console.error = () => {};
        try {
            universalErrorHandler(Object.assign(new Error('Validation error'), { name: 'SequelizeUniqueConstraintError', fields: { email: 'x@y.z' } }), { originalUrl: '/customer/loginUser' }, res, () => {});
        } finally {
            console.error = originalError;
        }
        assert.equal(status, 409);
        assert.equal(body.data.code, 'EMAIL_IN_USE');

        assert.equal(accountKindOf({ userTypeId: 2 }), 'customer');
        assert.equal(accountKindOf({ userTypeId: 4 }), 'shop');
        assert.equal(accountKindOf({ userTypeId: 3 }), 'driver');
        assert.equal(accountKindOf({ userTypeId: null, classifiedAsId: 1 }), 'shop_staff');
        assert.equal(accountKindOf({ userTypeId: null, classifiedAsId: 2 }), 'staff');
    }

    console.log('customerSocialSignIn.test.js: all assertions passed');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
