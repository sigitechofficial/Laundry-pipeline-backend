'use strict';

/**
 * Automatic WhatsApp messages to customers through Twilio, using templates
 * approved by Meta (utils/whatsappTemplates.js).
 *
 * Needs (server .env):
 *   TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN  — already used for SMS
 *   TWILIO_WHATSAPP_FROM                    — the approved WhatsApp sender, e.g. +442039516293
 *   TWILIO_WA_TEMPLATE_<EVENT>              — each template's Content SID (HX…)
 * and the admin switches in Policies → Runtime checks (master + one per message).
 *
 * notifyWhatsApp() never throws and never blocks the order flow: it returns at
 * once and does the work in the background. Each (booking, event, dedupeKey) is
 * sent at most once; customers in whatsappOptOuts are skipped.
 */

const { WHATSAPP_EVENTS, windowText, itemCountText, contentVariables } = require('../utils/whatsappTemplates');

const LOG = '[whatsapp]';

function models() {
    return require('../models');
}

function senderNumber(env = process.env) {
    const raw = String(env.TWILIO_WHATSAPP_FROM || '').trim().replace(/^whatsapp:/i, '');
    return raw || null;
}

function templateSidFor(event, env = process.env) {
    const def = WHATSAPP_EVENTS[event];
    const sid = def ? String(env[def.templateEnv] || '').trim() : '';
    return sid || null;
}

/** Which parts are set up, for the admin page. */
function configurationStatus(env = process.env) {
    const twilio = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);
    return {
        twilioConfigured: twilio,
        senderConfigured: Boolean(senderNumber(env)),
        events: Object.entries(WHATSAPP_EVENTS).map(([event, def]) => ({
            event,
            label: def.label,
            settingKey: def.settingKey,
            templateEnv: def.templateEnv,
            templateConfigured: Boolean(templateSidFor(event, env)),
            text: def.text,
        })),
    };
}

async function isEventEnabled(event) {
    const def = WHATSAPP_EVENTS[event];
    if (!def) return false;
    const runtime = require('./Admin/runtimeSettingsService');
    const [master, own] = await Promise.all([
        runtime.getBoolean('whatsappEnabled'),
        runtime.getBoolean(def.settingKey),
    ]);
    return Boolean(master && own);
}

/** Template values for an event from the booking (+ extra, e.g. itemCount, amount). */
function valuesFor(event, bookingRow, extra = {}) {
    const firstName = String(bookingRow?.customer?.firstName || '').trim() || 'there';
    const orderNumber = bookingRow?.orderTrackId || String(bookingRow?.id || '');
    switch (event) {
        case 'pickup_on_the_way':
            return {
                firstName,
                orderNumber,
                collectionWindow: windowText(bookingRow.collectionDate, bookingRow.collectionTimeFrom, bookingRow.collectionTimeTo),
            };
        case 'out_for_delivery':
            return {
                firstName,
                orderNumber,
                deliveryWindow: windowText(bookingRow.deliveryDate, bookingRow.deliveryTimeFrom, bookingRow.deliveryTimeTo),
            };
        case 'on_hold':
            return { firstName, orderNumber, itemCount: itemCountText(extra.itemCount) };
        case 'payment_failed':
            return { firstName, orderNumber, amount: extra.amount || 'the balance due' };
        default:
            return { firstName, orderNumber };
    }
}

function isUniqueViolation(err) {
    return err?.name === 'SequelizeUniqueConstraintError' || /Duplicate entry|UNIQUE constraint/i.test(String(err?.message || ''));
}

/**
 * Send one event for one booking now. Resolves to { sent, reason?, sid? }; never throws.
 * @param {string} event key of WHATSAPP_EVENTS
 * @param {number|string} bookingId
 * @param {{ dedupeKey?: string, extra?: object, deps?: object }} [opts]
 */
async function sendWhatsAppForBooking(event, bookingId, opts = {}) {
    const { dedupeKey = '', extra = {} } = opts;
    const deps = opts.deps || {};
    try {
        if (!WHATSAPP_EVENTS[event]) return { sent: false, reason: 'unknown_event' };
        const enabled = await (deps.isEventEnabled || isEventEnabled)(event);
        if (!enabled) return { sent: false, reason: 'disabled' };

        const env = deps.env || process.env;
        const from = senderNumber(env);
        const contentSid = templateSidFor(event, env);
        if (!from || !contentSid) {
            console.warn(`${LOG} ${event}: not set up (TWILIO_WHATSAPP_FROM / ${WHATSAPP_EVENTS[event].templateEnv})`);
            return { sent: false, reason: 'not_configured' };
        }

        const db = deps.models || models();
        const bookingRow = await db.booking.findByPk(bookingId, {
            attributes: [
                'id', 'customerId', 'orderTrackId', 'zoneId', 'laundryShopId', 'pickupAddresId', 'dropOffAddressId',
                'collectionDate', 'collectionTimeFrom', 'collectionTimeTo',
                'deliveryDate', 'deliveryTimeFrom', 'deliveryTimeTo',
            ],
            include: [{
                model: db.users,
                as: 'customer',
                attributes: ['id', 'firstName', 'phoneNum', 'countryCode'],
                required: false,
            }],
        });
        if (!bookingRow) return { sent: false, reason: 'no_booking' };

        if (bookingRow.customerId) {
            const optedOut = await db.whatsappOptOut.findOne({
                where: { userId: bookingRow.customerId },
                attributes: ['id'],
            });
            if (optedOut) return { sent: false, reason: 'opted_out' };
        }

        const notify = deps.customerNotifyService || require('./Agent/customerNotifyService');
        const to = await notify.resolveCustomerE164(bookingRow);
        const { maskPhoneNumber } = require('../utils/maskPhone');

        // Claim the (booking, event, dedupeKey) slot first: a second call for the
        // same message stops here instead of sending it twice.
        let row;
        try {
            row = await db.whatsappMessage.create({
                bookingId: bookingRow.id,
                customerId: bookingRow.customerId || null,
                event,
                dedupeKey: String(dedupeKey).slice(0, 64),
                toMasked: to ? maskPhoneNumber(to) : null,
                templateSid: contentSid,
                status: 'queued',
            });
        } catch (err) {
            if (isUniqueViolation(err)) return { sent: false, reason: 'already_sent' };
            throw err;
        }

        if (!to) {
            await row.update({ status: 'failed', error: 'No valid customer phone number' });
            return { sent: false, reason: 'no_phone' };
        }

        const sms = deps.twilioSmsService || require('./twilioSmsService');
        const { client } = sms.getTwilioClient();
        const payload = {
            from: `whatsapp:${from}`,
            to: `whatsapp:${to}`,
            contentSid,
            contentVariables: contentVariables(event, valuesFor(event, bookingRow, extra)),
        };
        const base = sms.getPublicBaseUrl();
        if (base) payload.statusCallback = `${base}/webhooks/twilio/whatsapp/status`;

        try {
            const message = await client.messages.create(payload);
            await row.update({ twilioSid: message.sid, status: String(message.status || 'sent').slice(0, 24), sentAt: new Date() });
            return { sent: true, sid: message.sid };
        } catch (err) {
            const error = `${err?.code ? `${err.code}: ` : ''}${err?.message || err}`.slice(0, 255);
            await row.update({ status: 'failed', error });
            console.warn(`${LOG} ${event} booking=${bookingRow.id} failed: ${error}`);
            return { sent: false, reason: 'twilio_error', error };
        }
    } catch (err) {
        console.error(`${LOG} ${event} booking=${bookingId} error:`, err?.message || err);
        return { sent: false, reason: 'error', error: String(err?.message || err) };
    }
}

/** Fire-and-forget: never throws, never delays the caller. */
function notifyWhatsApp(event, bookingId, opts = {}) {
    setImmediate(() => {
        sendWhatsAppForBooking(event, bookingId, opts).catch(() => {});
    });
}

/** Customer's choice: WhatsApp messages on (optedOut=false) or off. */
async function setCustomerOptOut(userId, optedOut) {
    const db = models();
    if (optedOut) {
        await db.whatsappOptOut.findOrCreate({ where: { userId }, defaults: { userId } });
    } else {
        await db.whatsappOptOut.destroy({ where: { userId } });
    }
    return { optedOut: Boolean(optedOut) };
}

async function isCustomerOptedOut(userId) {
    const row = await models().whatsappOptOut.findOne({ where: { userId }, attributes: ['id'] });
    return Boolean(row);
}

/** Latest messages for the admin page. */
async function recentMessages(limit = 25) {
    const db = models();
    const rows = await db.whatsappMessage.findAll({
        order: [['id', 'DESC']],
        limit: Math.min(Math.max(Number(limit) || 25, 1), 100),
        include: [{ model: db.booking, as: 'booking', attributes: ['id', 'orderTrackId'], required: false }],
    });
    return rows.map((r) => {
        const p = r.get({ plain: true });
        return {
            id: p.id,
            bookingId: p.bookingId,
            orderTrackId: p.booking?.orderTrackId || null,
            event: p.event,
            label: WHATSAPP_EVENTS[p.event]?.label || p.event,
            toMasked: p.toMasked,
            status: p.status,
            error: p.error,
            sentAt: p.sentAt,
            deliveredAt: p.deliveredAt,
            createdAt: p.createdAt,
        };
    });
}

module.exports = {
    notifyWhatsApp,
    sendWhatsAppForBooking,
    configurationStatus,
    valuesFor,
    setCustomerOptOut,
    isCustomerOptedOut,
    recentMessages,
};
