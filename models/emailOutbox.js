'use strict';

const { jsonColumn } = require('../utils/jsonColumn');

/** Transactional email outbox — see migrations/20261123130000-create-email-outbox.js. */
module.exports = (sequelize, DataTypes) => {
  const emailOutbox = sequelize.define(
    'emailOutbox',
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      template: {
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      payload: jsonColumn(DataTypes, 'payload', { allowNull: false }),
      dedupeKey: {
        type: DataTypes.STRING(191),
        allowNull: true,
        unique: true,
      },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'pending',
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
      },
      lastError: {
        type: DataTypes.STRING(1000),
        allowNull: true,
      },
      sentAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      tableName: 'email_outbox',
      timestamps: true,
    }
  );

  return emailOutbox;
};
