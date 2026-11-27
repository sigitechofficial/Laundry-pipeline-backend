'use strict';

/**
 * Automatic WhatsApp messages to customers.
 *
 * Each event is a Meta-approved template created in Twilio (Content Template
 * Builder). Its Content SID (HX…) goes in the env key named below; the text
 * here is what to submit for approval, with {{1}}, {{2}}… in the same order as
 * `vars`. Admins switch every message on or off in Policies → Runtime checks.
 */
const WHATSAPP_EVENTS = Object.freeze({
    pickup_on_the_way: {
        label: 'Driver on the way to collect',
        settingKey: 'whatsappPickupOnTheWayEnabled',
        templateEnv: 'TWILIO_WA_TEMPLATE_PICKUP_ON_THE_WAY',
        vars: ['firstName', 'orderNumber', 'collectionWindow'],
        text:
            'Hi {{1}}, your Just Dry Cleans driver is on the way to collect your laundry for order #{{2}} ({{3}}). You can follow them live in the app.',
    },
    on_hold: {
        label: 'Items on hold: answer needed',
        settingKey: 'whatsappOnHoldEnabled',
        templateEnv: 'TWILIO_WA_TEMPLATE_ON_HOLD',
        vars: ['firstName', 'itemCount', 'orderNumber'],
        text:
            'Hi {{1}}, before cleaning we need your answer about {{2}} on order #{{3}}. Please open the Just Dry Cleans app to see the photo and choose.',
    },
    payment_failed: {
        label: 'Payment failed',
        settingKey: 'whatsappPaymentFailedEnabled',
        templateEnv: 'TWILIO_WA_TEMPLATE_PAYMENT_FAILED',
        vars: ['firstName', 'orderNumber', 'amount'],
        text:
            'Hi {{1}}, we could not take the payment for order #{{2}} ({{3}}). Please open the Just Dry Cleans app to update your card, or contact us.',
    },
    out_for_delivery: {
        label: 'Out for delivery',
        settingKey: 'whatsappOutForDeliveryEnabled',
        templateEnv: 'TWILIO_WA_TEMPLATE_OUT_FOR_DELIVERY',
        vars: ['firstName', 'orderNumber', 'deliveryWindow'],
        text:
            'Hi {{1}}, good news: your laundry for order #{{2}} is out for delivery ({{3}}). You can follow your driver live in the app.',
    },
    delivered: {
        label: 'Delivered',
        settingKey: 'whatsappDeliveredEnabled',
        templateEnv: 'TWILIO_WA_TEMPLATE_DELIVERED',
        vars: ['firstName', 'orderNumber'],
        text:
            'Hi {{1}}, your order #{{2}} has been delivered. Thank you for choosing Just Dry Cleans! You can rate your shop in the app.',
    },
});

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "09:00:00" -> "09:00" */
function hhmm(t) {
    if (!t) return '';
    const [h, m] = String(t).split(':');
    if (!h) return '';
    return `${String(parseInt(h, 10)).padStart(2, '0')}:${(m || '00').slice(0, 2).padStart(2, '0')}`;
}

/** "Thu 27 Nov, 09:00–10:00" from a DATEONLY / DATE and two TIME values. */
function windowText(date, from, to) {
    let day = '';
    if (date) {
        const m = String(date).match(/^(\d{4})-(\d{2})-(\d{2})/);
        const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : new Date(date);
        if (!Number.isNaN(d.getTime())) {
            day = `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
        }
    }
    const a = hhmm(from);
    const b = hhmm(to);
    const time = a && b ? `${a}–${b}` : a || b;
    return [day, time].filter(Boolean).join(', ') || 'today';
}

/** "1 item" / "3 items" */
function itemCountText(n) {
    const count = Math.max(1, Number(n) || 1);
    return `${count} ${count === 1 ? 'item' : 'items'}`;
}

/**
 * Twilio `contentVariables` (JSON string) for an event. WhatsApp refuses empty
 * variables, so a missing value is sent as "-".
 */
function contentVariables(event, values = {}) {
    const def = WHATSAPP_EVENTS[event];
    if (!def) throw new Error(`Unknown WhatsApp event: ${event}`);
    const out = {};
    def.vars.forEach((name, i) => {
        const v = values[name];
        const text = v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
        out[String(i + 1)] = text ? text.slice(0, 200) : '-';
    });
    return JSON.stringify(out);
}

/** The template text with the values filled in (admin preview / logs). */
function previewText(event, values = {}) {
    const vars = JSON.parse(contentVariables(event, values));
    return WHATSAPP_EVENTS[event].text.replace(/\{\{(\d+)\}\}/g, (_, n) => vars[n] || '-');
}

module.exports = { WHATSAPP_EVENTS, windowText, itemCountText, contentVariables, previewText };
