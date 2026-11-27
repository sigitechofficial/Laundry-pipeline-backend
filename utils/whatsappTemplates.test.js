'use strict';

const assert = require('assert/strict');
const { WHATSAPP_EVENTS, windowText, itemCountText, contentVariables, previewText } = require('./whatsappTemplates');

for (const [key, def] of Object.entries(WHATSAPP_EVENTS)) {
    const placeholders = def.text.match(/\{\{\d+\}\}/g) || [];
    assert.equal(placeholders.length, def.vars.length, `${key}: one {{n}} per variable`);
    assert.ok(!/^\s*\{\{/.test(def.text) && !/\}\}\s*$/.test(def.text), `${key}: Meta refuses a template that starts or ends with a variable`);
    assert.ok(!/\}\}\s*\{\{/.test(def.text), `${key}: no two variables side by side`);
    assert.ok(def.settingKey && def.templateEnv, `${key}: setting and env key`);
}

assert.equal(windowText('2026-11-27', '09:00:00', '10:00:00'), 'Fri 27 Nov, 09:00–10:00');
assert.equal(windowText(null, '17:00', null), '17:00');
assert.equal(windowText(null, null, null), 'today');
assert.equal(itemCountText(1), '1 item');
assert.equal(itemCountText(3), '3 items');

assert.deepEqual(
    JSON.parse(contentVariables('pickup_on_the_way', { firstName: 'Amy', orderNumber: '440-33', collectionWindow: 'Fri 27 Nov, 09:00–10:00' })),
    { 1: 'Amy', 2: '440-33', 3: 'Fri 27 Nov, 09:00–10:00' }
);
assert.deepEqual(JSON.parse(contentVariables('delivered', { orderNumber: '9' })), { 1: '-', 2: '9' }, 'empty value -> "-"');
assert.equal(
    previewText('delivered', { firstName: 'Amy', orderNumber: '440-33' }),
    'Hi Amy, your order #440-33 has been delivered. Thank you for choosing Just Dry Cleans! You can rate your shop in the app.'
);
assert.throws(() => contentVariables('nope'), /Unknown WhatsApp event/);
console.log('whatsappTemplates tests passed');
