'use strict';

/**
 * Every runtime setting's label and description fit their database columns
 * (a longer text made saving that setting fail). No database needed.
 */

const assert = require('assert');

require('./stubSequelizeModels').install();
const { DEFINITIONS, LABEL_MAX, DESCRIPTION_MAX } = require('../services/Admin/runtimeSettingsService');

for (const [key, def] of Object.entries(DEFINITIONS)) {
  assert.ok(String(def.label).length <= LABEL_MAX, `${key}: label is ${String(def.label).length} characters (max ${LABEL_MAX})`);
  assert.ok(String(def.description || '').length <= DESCRIPTION_MAX, `${key}: description is ${String(def.description).length} characters (max ${DESCRIPTION_MAX})`);
  assert.ok(String(def.envKey || '').length <= 64, `${key}: envKey too long`);
}

console.log('runtimeSettingsDefinitions.test.js passed');
