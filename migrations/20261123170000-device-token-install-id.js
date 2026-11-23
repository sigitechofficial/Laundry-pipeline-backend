'use strict';

const { DataTypes } = require('sequelize');
const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

const INDEX = 'deviceTokens_userId_deviceId';

/**
 * deviceTokens.deviceId: the app install a push token belongs to. App sessions are keyed by
 * that install id, not by the push token (utils/appSession.js), so a token rotation replaces
 * the install's old token and signing out of an install removes exactly its tokens.
 * NULL for rows written by app builds that predate deviceId (removed by token instead).
 */
module.exports = {
  async up(queryInterface) {
    await addColumnIfMissing(queryInterface, 'deviceTokens', 'deviceId', {
      type: DataTypes.STRING(36),
      allowNull: true,
      comment: 'App install id (UUID) the push token belongs to; NULL for legacy rows',
    });
    const indexes = await queryInterface.showIndex('deviceTokens');
    if (!indexes.some((i) => i.name === INDEX)) {
      await queryInterface.addIndex('deviceTokens', ['userId', 'deviceId'], { name: INDEX });
    }
  },

  async down(queryInterface) {
    const indexes = await queryInterface.showIndex('deviceTokens');
    if (indexes.some((i) => i.name === INDEX)) {
      await queryInterface.removeIndex('deviceTokens', INDEX);
    }
    await removeColumnIfExists(queryInterface, 'deviceTokens', 'deviceId');
  },
};
