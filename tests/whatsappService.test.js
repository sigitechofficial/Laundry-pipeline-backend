'use strict';

/** whatsappService with stubbed models / Twilio: no database or network. */
const assert = require('assert/strict');
require('./stubSequelizeModels').install();
const { sendWhatsAppForBooking, configurationStatus } = require('../services/whatsappService');

function fakeDb({ optedOut = false, booking } = {}) {
    const rows = [];
    const keys = new Set();
    return {
        rows,
        users: {},
        booking: { findByPk: async () => booking },
        whatsappOptOut: { findOne: async () => (optedOut ? { id: 1 } : null) },
        whatsappMessage: {
            create: async (data) => {
                const k = `${data.bookingId}|${data.event}|${data.dedupeKey}`;
                if (keys.has(k)) {
                    const e = new Error('dup'); e.name = 'SequelizeUniqueConstraintError'; throw e;
                }
                keys.add(k);
                const row = { ...data, update: async (u) => Object.assign(row, u) };
                rows.push(row);
                return row;
            },
        },
    };
}

const bookingRow = {
    id: 440, customerId: 7, orderTrackId: '440-339899',
    collectionDate: '2026-11-27', collectionTimeFrom: '09:00:00', collectionTimeTo: '10:00:00',
    customer: { firstName: 'Amy', phoneNum: '7700900123', countryCode: '+44' },
};
const env = { TWILIO_WHATSAPP_FROM: '+442039516293', TWILIO_WA_TEMPLATE_PICKUP_ON_THE_WAY: 'HX123' };

function deps(db, sent, overrides = {}) {
    return {
        env,
        models: db,
        isEventEnabled: async () => true,
        customerNotifyService: { resolveCustomerE164: async () => '+447700900123' },
        twilioSmsService: {
            getTwilioClient: () => ({ client: { messages: { create: async (p) => { sent.push(p); return { sid: 'SM1', status: 'queued' }; } } } }),
            getPublicBaseUrl: () => 'https://api.example',
        },
        ...overrides,
    };
}

(async () => {
    // happy path
    let db = fakeDb({ booking: bookingRow }); let sent = [];
    let r = await sendWhatsAppForBooking('pickup_on_the_way', 440, { deps: deps(db, sent) });
    assert.deepEqual(r, { sent: true, sid: 'SM1' });
    assert.equal(sent[0].from, 'whatsapp:+442039516293');
    assert.equal(sent[0].to, 'whatsapp:+447700900123');
    assert.equal(sent[0].contentSid, 'HX123');
    assert.deepEqual(JSON.parse(sent[0].contentVariables), { 1: 'Amy', 2: '440-339899', 3: 'Fri 27 Nov, 09:00–10:00' });
    assert.equal(sent[0].statusCallback, 'https://api.example/webhooks/twilio/whatsapp/status');
    assert.equal(db.rows[0].status, 'queued');
    assert.equal(db.rows[0].twilioSid, 'SM1');

    // never twice
    r = await sendWhatsAppForBooking('pickup_on_the_way', 440, { deps: deps(db, sent) });
    assert.equal(r.reason, 'already_sent');
    assert.equal(sent.length, 1);

    // switched off
    r = await sendWhatsAppForBooking('pickup_on_the_way', 440, { deps: deps(fakeDb({ booking: bookingRow }), [], { isEventEnabled: async () => false }) });
    assert.equal(r.reason, 'disabled');

    // template not set up
    r = await sendWhatsAppForBooking('delivered', 440, { deps: deps(fakeDb({ booking: bookingRow }), []) });
    assert.equal(r.reason, 'not_configured');

    // opted out
    sent = [];
    r = await sendWhatsAppForBooking('pickup_on_the_way', 440, { deps: deps(fakeDb({ booking: bookingRow, optedOut: true }), sent) });
    assert.equal(r.reason, 'opted_out'); assert.equal(sent.length, 0);

    // no phone -> logged as failed, nothing sent
    db = fakeDb({ booking: bookingRow }); sent = [];
    r = await sendWhatsAppForBooking('pickup_on_the_way', 440, { deps: deps(db, sent, { customerNotifyService: { resolveCustomerE164: async () => null } }) });
    assert.equal(r.reason, 'no_phone'); assert.equal(db.rows[0].status, 'failed'); assert.equal(sent.length, 0);

    // Twilio error -> logged, no throw
    db = fakeDb({ booking: bookingRow });
    r = await sendWhatsAppForBooking('pickup_on_the_way', 440, {
        deps: deps(db, [], {
            twilioSmsService: {
                getTwilioClient: () => ({ client: { messages: { create: async () => { const e = new Error('Template not approved'); e.code = 63016; throw e; } } } }),
                getPublicBaseUrl: () => null,
            },
        }),
    });
    assert.equal(r.reason, 'twilio_error');
    assert.equal(db.rows[0].status, 'failed');
    assert.match(db.rows[0].error, /63016: Template not approved/);

    // a later payment failure is a new message (dedupeKey)
    db = fakeDb({ booking: bookingRow }); sent = [];
    const payEnv = { ...env, TWILIO_WA_TEMPLATE_PAYMENT_FAILED: 'HX9' };
    const d = { ...deps(db, sent), env: payEnv };
    await sendWhatsAppForBooking('payment_failed', 440, { dedupeKey: '2026-11-27', extra: { amount: '£32.60' }, deps: d });
    await sendWhatsAppForBooking('payment_failed', 440, { dedupeKey: '2026-11-27', extra: { amount: '£32.60' }, deps: d });
    await sendWhatsAppForBooking('payment_failed', 440, { dedupeKey: '2026-11-28', extra: { amount: '£32.60' }, deps: d });
    assert.equal(sent.length, 2, 'once per day');
    assert.equal(JSON.parse(sent[0].contentVariables)[3], '£32.60');

    const status = configurationStatus(env);
    assert.equal(status.senderConfigured, true);
    assert.equal(status.events.find((e) => e.event === 'pickup_on_the_way').templateConfigured, true);
    assert.equal(status.events.find((e) => e.event === 'delivered').templateConfigured, false);
    console.log('whatsappService tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
