'use strict';

const { DataTypes } = require('sequelize');
const { tableExists } = require('../utils/migrationHelpers');

/**
 * Transactional email outbox. Requests insert a row (fast, durable); the email outbox
 * worker (services/email/emailOutbox.js) sends it, retrying with backoff, so a slow or
 * failing mail provider never delays or breaks an API request and no email is lost.
 */
module.exports = {
  async up(queryInterface) {
    if (await tableExists(queryInterface, 'email_outbox')) return;

    await queryInterface.createTable('email_outbox', {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      template: {
        type: DataTypes.STRING(64),
        allowNull: false,
        comment: 'Template key in services/email/emailOutbox.js',
      },
      payload: {
        type: DataTypes.JSON,
        allowNull: false,
        comment: 'Template parameters, including the recipient email',
      },
      dedupeKey: {
        type: DataTypes.STRING(191),
        allowNull: true,
        unique: true,
        comment: 'Set for once-only emails (e.g. welcome); repeats are ignored',
      },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'pending',
        comment: 'pending | sending | sent | failed',
      },
      attempts: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      nextAttemptAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      lockedUntil: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'Claim lease while sending; an expired lease is retried',
      },
      lastError: {
        type: DataTypes.STRING(1000),
        allowNull: true,
      },
      sentAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    });

    await queryInterface.addIndex('email_outbox', ['status', 'nextAttemptAt'], {
      name: 'email_outbox_status_next_attempt',
    });
  },

  async down(queryInterface) {
    if (!(await tableExists(queryInterface, 'email_outbox'))) return;
    await queryInterface.dropTable('email_outbox');
  },
};
