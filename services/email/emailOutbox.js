'use strict';

/**
 * The app's transactional email outbox and its worker.
 *
 * Request handlers call enqueueEmail() instead of awaiting the mail provider: the API
 * responds immediately, provider outages (e.g. ZeptoMail credit exhausted, 429) are
 * retried with backoff, and failures stay visible in the email_outbox table.
 *
 * OTP and password-reset emails are deliberately NOT queued: the caller must know
 * whether they were sent.
 */

const { Op } = require('sequelize');
const { createEmailOutbox } = require('./emailOutboxCore');

// Lazy requires: templates (and their inline images) load only when a mail is sent.
const TEMPLATES = Object.freeze({
  driverArrived: (p) => require('../../helper/driverArrivedMail')(p),
  invoiceReady: (p) => require('../../helper/invoiceReadyMail')(p),
  agentInvoice: (p) => require('../../helper/agentInvoiceMail')(p),
  bookingConfirmation: (p) => require('../../helper/bookingConfirmationMail')(p),
  signupWelcome: (p) => require('../../helper/signupWelcomeMail')(p),
  onHold: (p) => require('../../helper/onHoldMail')(p),
});

const INTERVAL_MS = Math.max(1000, Number(process.env.EMAIL_OUTBOX_INTERVAL_MS) || 15 * 1000);
const PURGE_EVERY_MS = 6 * 60 * 60 * 1000;

let outbox = null;
function getOutbox() {
  if (!outbox) {
    const { emailOutbox } = require('../../models');
    outbox = createEmailOutbox({ model: emailOutbox, templates: TEMPLATES, Op });
  }
  return outbox;
}

/** Queue a transactional email. See emailOutboxCore.enqueue for options. */
function enqueueEmail(template, payload, options) {
  return getOutbox().enqueue(template, payload, options);
}

let timer = null;
let running = false;
let lastPurgeAt = 0;

async function runOnce() {
  if (running) return; // never overlap ticks
  running = true;
  try {
    const result = await getOutbox().processDue();
    if (result.sent || result.retrying || result.failed) {
      console.log('[emailOutbox] tick', result);
    }
    if (Date.now() - lastPurgeAt > PURGE_EVERY_MS) {
      lastPurgeAt = Date.now();
      await getOutbox().purgeSent();
    }
  } finally {
    running = false;
  }
}

function startEmailOutboxJob() {
  if (timer) return;
  const run = () => {
    runOnce().catch((error) => console.error('[emailOutbox] job error:', error.message));
  };
  run();
  timer = setInterval(run, INTERVAL_MS);
  console.log(`[emailOutbox] scheduled every ${INTERVAL_MS / 1000}s`);
}

module.exports = { enqueueEmail, startEmailOutboxJob, TEMPLATES };
