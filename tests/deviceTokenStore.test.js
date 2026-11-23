'use strict';

const assert = require('assert/strict');
const path = require('path');
const { Op } = require('sequelize');

// ── In-memory deviceToken model, injected in place of ../models ───────────────────
const rows = [];
let nextId = 1;
const matches = (row, where) =>
  Object.entries(where).every(([k, v]) => {
    if (Array.isArray(v)) return v.includes(row[k]);
    if (v && typeof v === 'object' && Op.ne in v) return row[k] !== v[Op.ne];
    return row[k] === v;
  });
const deviceToken = {
  async destroy({ where }) {
    let n = 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (matches(rows[i], where)) { rows.splice(i, 1); n += 1; }
    }
    return n;
  },
  async create(values) { const r = { id: nextId++, ...values }; rows.push(r); return r; },
  async findOne({ where }) {
    const r = rows.find((x) => matches(x, where));
    return r ? { ...r, update: async (v) => Object.assign(r, v) } : null;
  },
};
const modelsPath = require.resolve(path.join(__dirname, '..', 'models'));
require.cache[modelsPath] = { id: modelsPath, filename: modelsPath, loaded: true, exports: { deviceToken } };

const store = require('../utils/deviceTokenStore');
const { appSessionKey, adminSessionKey } = require('../utils/sessionKeys');
const tokensOf = (userId) => rows.filter((r) => r.userId === userId).map((r) => r.tokenId).sort();

(async () => {
  // Sign-in replaces the user's devices with this one.
  await store.replaceUserToken(2, 'old-phone');
  await store.replaceUserToken(2, 'tablet');
  assert.deepEqual(tokensOf(2), ['tablet']);

  // The same shop tablet then signs in as a staff member: the owner no longer gets
  // pushes on it (the token is detached from the owner), the staff member does.
  await store.replaceUserToken(4, 'tablet');
  assert.deepEqual(tokensOf(2), []);
  assert.deepEqual(tokensOf(4), ['tablet']);

  // No token: no-op.
  await store.replaceUserToken(4, '');
  assert.deepEqual(tokensOf(4), ['tablet']);

  // Token rotation report is idempotent and keeps one row.
  await store.saveCurrentToken(4, 'tablet');
  await store.saveCurrentToken(4, 'tablet');
  assert.equal(rows.filter((r) => r.tokenId === 'tablet').length, 1);

  // Sign-out forgets the signed-in token and the app's current one; ignores blanks.
  await store.replaceUserToken(5, 'signin-token');
  await store.saveCurrentToken(5, 'rotated-token');
  assert.equal(await store.removeUserTokens(5, ['signin-token', 'rotated-token', '']), 2);
  assert.deepEqual(tokensOf(5), []);
  assert.equal(await store.removeUserTokens(5, []), 0);
  assert.deepEqual(tokensOf(4), ['tablet'], "another user's token is untouched");

  // Tokens recorded against the app install (deviceId): a rotation replaces that install's
  // old token only; signing out of the install removes exactly its tokens.
  await store.replaceUserToken(6, 'phone-a', 'install-phone');
  await store.saveCurrentToken(6, 'tablet-a', 'install-tablet');
  await store.saveCurrentToken(6, 'phone-b', 'install-phone'); // phone's token rotated
  assert.deepEqual(tokensOf(6), ['phone-b', 'tablet-a']);
  assert.equal(rows.find((r) => r.tokenId === 'phone-b').deviceId, 'install-phone');
  // A token first saved without an install id gets it when the install reports it.
  await store.saveCurrentToken(6, 'tablet-a', 'install-tablet');
  assert.equal(rows.find((r) => r.tokenId === 'tablet-a').deviceId, 'install-tablet');
  assert.equal(await store.removeInstallTokens(6, 'install-phone'), 1);
  assert.deepEqual(tokensOf(6), ['tablet-a'], "the other install keeps its pushes");
  assert.equal(await store.removeInstallTokens(6, null), 0, 'no install id: nothing removed');
  assert.equal(await store.removeInstallTokens(null, 'install-tablet'), 0);

  // Session keys: app and admin sessions are distinct and stable (the key the
  // validators read is the key logouts delete).
  assert.equal(appSessionKey(7), 'id-7');
  assert.equal(adminSessionKey(7), 'tsh7');
  assert.notEqual(appSessionKey(7), adminSessionKey(7));

  console.log('deviceTokenStore.test.js: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
