'use strict';

/** utils/fcmRouting.js: each token goes to its own Firebase project; self-healing; safe cleanup. */

const assert = require('assert');
const { deliverRouted, isWrongProjectError, candidateProjects } = require('../utils/fcmRouting');

const NEW = 'new-project';
const OLD = 'old-project';

const MISMATCH = { code: 'messaging/mismatched-credential', message: 'SenderId mismatch' };
const UNREGISTERED = { code: 'messaging/registration-token-not-registered', message: 'Requested entity was not found.' };
const QUOTA = { code: 'messaging/quota-exceeded', message: 'quota' };

/** owner: token -> project that issued it ('dead' = unregistered everywhere, 'foreign' = third project). */
function fakeFcm(owner, { failCall = {}, serverError = {} } = {}) {
  const calls = [];
  const messagingFor = (projectId) => ({
    async sendEachForMulticast(message, dryRun) {
      calls.push({ projectId, tokens: message.tokens, dryRun });
      if (failCall[projectId]) throw failCall[projectId];
      return {
        responses: message.tokens.map((t) => {
          if (serverError[t]) return { success: false, error: serverError[t] };
          const o = owner[t];
          if (o === projectId) return { success: true, messageId: `${projectId}:${t}` };
          if (o === 'dead') return { success: false, error: UNREGISTERED };
          if (o === 'web-new-notfound' && projectId === OLD) return { success: false, error: UNREGISTERED };
          if (o === 'web-new-notfound' && projectId === NEW) return { success: true, messageId: 'w' };
          return { success: false, error: MISMATCH };
        }),
      };
    },
  });
  return { calls, messagingFor };
}

function run(entries, fcm, { ready = [NEW, OLD], order = [OLD, NEW], dryRun } = {}) {
  return deliverRouted({
    entries,
    buildMessage: (tokens) => ({ tokens }),
    messagingFor: fcm.messagingFor,
    readyProjectIds: ready,
    unclassifiedOrder: order,
    dryRun,
  });
}

(async () => {
  assert.ok(isWrongProjectError(MISMATCH));
  assert.ok(isWrongProjectError({ code: 'messaging/invalid-argument', message: 'SenderId mismatch' }));
  assert.ok(!isWrongProjectError(UNREGISTERED));
  assert.deepEqual(candidateProjects(NEW, [NEW, OLD], [OLD, NEW]), { queue: [NEW, OLD], recordedUnavailable: false });
  assert.deepEqual(candidateProjects(null, [NEW, OLD], [OLD, NEW]), { queue: [OLD, NEW], recordedUnavailable: false });
  assert.deepEqual(candidateProjects('gone', [NEW], [NEW]), { queue: [NEW], recordedUnavailable: true });

  // Recorded tokens go straight to their project, one multicast per project.
  {
    const fcm = fakeFcm({ a: NEW, b: OLD });
    const out = await run([{ token: 'a', projectId: NEW }, { token: 'b', projectId: OLD }], fcm);
    assert.deepEqual(out.map((o) => [o.verdict, o.deliveredProjectId]), [['delivered', NEW], ['delivered', OLD]]);
    assert.equal(fcm.calls.length, 2);
  }

  // Unclassified: legacy first; an app token (old) is delivered there, a web token (new) is
  // handed to the primary after a sender mismatch — and the real project is reported.
  {
    const fcm = fakeFcm({ app: OLD, web: NEW, web2: 'web-new-notfound' });
    const out = await run([{ token: 'app' }, { token: 'web' }, { token: 'web2' }], fcm);
    assert.deepEqual(out.map((o) => o.deliveredProjectId), [OLD, NEW, NEW]);
    assert.ok(out.every((o) => o.verdict === 'delivered' && o.recordedProjectId === null));
    assert.deepEqual(fcm.calls.map((c) => c.projectId), [OLD, NEW]);
    assert.deepEqual(fcm.calls[1].tokens, ['web', 'web2']);
  }

  // Mis-recorded token heals: recorded NEW but issued by OLD.
  {
    const out = await run([{ token: 'x', projectId: NEW }], fakeFcm({ x: OLD }));
    assert.equal(out[0].verdict, 'delivered');
    assert.equal(out[0].deliveredProjectId, OLD);
  }

  // Dead everywhere -> dead (delete). Sender mismatch everywhere -> kept (third project / missing key).
  {
    const out = await run([{ token: 'd' }, { token: 'f' }], fakeFcm({ d: 'dead', f: 'foreign' }));
    assert.equal(out[0].verdict, 'dead');
    assert.equal(out[0].attempts.length, 2);
    assert.equal(out[1].verdict, 'kept');
    assert.equal(out[1].reason, 'SENDER_MISMATCH_ALL_PROJECTS');
  }

  // Server-side error stops the token on that project and keeps it (no hop, no delete).
  {
    const fcm = fakeFcm({ q: OLD }, { serverError: { q: QUOTA } });
    const out = await run([{ token: 'q' }], fcm);
    assert.equal(out[0].verdict, 'kept');
    assert.equal(out[0].reason, QUOTA.code);
    assert.equal(fcm.calls.length, 1);
  }

  // A whole call failing (credential problem) keeps every token of the batch.
  {
    const fcm = fakeFcm({ a: OLD }, { failCall: { [OLD]: Object.assign(new Error('bad cred'), { code: 'app/invalid-credential' }) } });
    const out = await run([{ token: 'a' }], fcm);
    assert.equal(out[0].verdict, 'kept');
  }

  // Recorded project not configured here: tried on the others, never deleted.
  {
    const out = await run([{ token: 'z', projectId: OLD }], fakeFcm({ z: 'dead' }), { ready: [NEW], order: [NEW] });
    assert.equal(out[0].verdict, 'kept');
    assert.equal(out[0].reason, 'FIREBASE_PROJECT_NOT_CONFIGURED');
  }

  // New-only server: an unregistered token is deleted as before.
  {
    const out = await run([{ token: 'd' }], fakeFcm({ d: 'dead' }), { ready: [NEW], order: [NEW] });
    assert.equal(out[0].verdict, 'dead');
  }

  // No project at all.
  {
    const out = await run([{ token: 'a' }], fakeFcm({}), { ready: [], order: [] });
    assert.equal(out[0].reason, 'FIREBASE_NOT_CONFIGURED');
  }

  // dryRun is passed through; batches are capped at 500 tokens.
  {
    const owner = {};
    const entries = [];
    for (let i = 0; i < 501; i++) { owner[`t${i}`] = NEW; entries.push({ token: `t${i}`, projectId: NEW }); }
    const fcm = fakeFcm(owner);
    const out = await run(entries, fcm, { dryRun: true });
    assert.equal(out.filter((o) => o.verdict === 'delivered').length, 501);
    assert.deepEqual(fcm.calls.map((c) => [c.tokens.length, c.dryRun]), [[500, true], [1, true]]);
  }

  console.log('fcmRouting.test.js: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
