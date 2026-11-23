'use strict';

/**
 * A campaign has no zone: its budget's currency is the admin's, required when it has a
 * budget and never filled in from a platform default (models stubbed).
 * Run: node tests/campaignCurrency.test.js
 */

const assert = require('assert/strict');
const Module = require('module');

const created = [];
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === '../models' || request === '../../models' || /[\\/]models$/.test(request)) {
    return {
      sequelize: { QueryTypes: { SELECT: 'SELECT' }, query: async () => [] },
      campaign: {
        create: async (row) => {
          created.push(row);
          return { id: created.length, ...row, toJSON: () => row };
        },
      },
      promotion: {},
      promotionAuditLog: { create: async () => ({}) },
      zone: {
        findAll: async () => {
          throw new Error('a campaign never takes a zone currency');
        },
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { createCampaign, _validateCampaign } = require('../services/Admin/campaignService');

(async () => {
  // With a budget the currency is required.
  assert.throws(() => _validateCampaign({ name: 'Spring', budgetMinor: 5000 }), /currency of the campaign budget/);
  assert.throws(() => _validateCampaign({ name: 'Spring', budgetMinor: '5000', currency: '' }), /currency of the campaign budget/);
  assert.throws(() => _validateCampaign({ name: 'Spring', budgetMinor: 5000, currency: '£' }), /3-letter ISO code/);
  assert.doesNotThrow(() => _validateCampaign({ name: 'Spring', budgetMinor: 5000, currency: 'usd' }));
  // Without a budget there is no money, so no currency is needed.
  assert.doesNotThrow(() => _validateCampaign({ name: 'Spring' }));
  assert.doesNotThrow(() => _validateCampaign({ name: 'Spring', budgetMinor: '' }));

  await createCampaign({ name: 'Budgeted', budgetMinor: 5000, currency: ' eur ' }, 1);
  assert.equal(created.at(-1).currency, 'EUR', 'normalised, as given');
  await createCampaign({ name: 'No budget' }, 1);
  assert.equal(created.at(-1).currency, null, 'no budget: no currency, never a platform default');
  await assert.rejects(createCampaign({ name: 'Budget, no currency', budgetMinor: 100 }, 1), /currency of the campaign budget/);

  console.log('campaignCurrency.test.js passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
}).finally(() => {
  Module._load = originalLoad;
});
