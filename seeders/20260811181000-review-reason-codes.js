'use strict';

const { insertMissing, deleteSeeded } = require('./helpers/idempotentSeed');

/**
 * Shop review reason codes shown to customers after an order.
 * Idempotent: inserts only missing rows (by code); undo removes only these rows.
 */
const ROWS = [
  {
    code: 'POS_QUALITY',
    label: 'Excellent cleaning quality',
    sentiment: 'positive',
    sortOrder: 1,
    status: true,
    isOther: false
  },
  {
    code: 'POS_ON_TIME',
    label: 'On-time pickup & delivery',
    sentiment: 'positive',
    sortOrder: 2,
    status: true,
    isOther: false
  },
  {
    code: 'POS_PACKAGING',
    label: 'Great packaging & presentation',
    sentiment: 'positive',
    sortOrder: 3,
    status: true,
    isOther: false
  },
  {
    code: 'POS_STAFF',
    label: 'Friendly & professional staff',
    sentiment: 'positive',
    sortOrder: 4,
    status: true,
    isOther: false
  },
  {
    code: 'POS_VALUE',
    label: 'Good value for money',
    sentiment: 'positive',
    sortOrder: 5,
    status: true,
    isOther: false
  },
  {
    code: 'POS_OTHER',
    label: 'Other',
    sentiment: 'positive',
    sortOrder: 99,
    status: true,
    isOther: true
  },
  {
    code: 'NEG_QUALITY',
    label: 'Poor cleaning quality',
    sentiment: 'negative',
    sortOrder: 1,
    status: true,
    isOther: false
  },
  {
    code: 'NEG_DELAY',
    label: 'Late pickup or delivery',
    sentiment: 'negative',
    sortOrder: 2,
    status: true,
    isOther: false
  },
  {
    code: 'NEG_DAMAGE',
    label: 'Items damaged',
    sentiment: 'negative',
    sortOrder: 3,
    status: true,
    isOther: false
  },
  {
    code: 'NEG_MISSING',
    label: 'Missing items',
    sentiment: 'negative',
    sortOrder: 4,
    status: true,
    isOther: false
  },
  {
    code: 'NEG_STAFF',
    label: 'Unprofessional staff',
    sentiment: 'negative',
    sortOrder: 5,
    status: true,
    isOther: false
  },
  {
    code: 'NEG_OTHER',
    label: 'Other',
    sentiment: 'negative',
    sortOrder: 99,
    status: true,
    isOther: true
  }
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await insertMissing(queryInterface, 'reviewReasonCodes', ROWS, { key: 'code' });
  },

  async down(queryInterface) {
    await deleteSeeded(queryInterface, 'reviewReasonCodes', ROWS, { key: 'code' });
  },
};
