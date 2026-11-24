'use strict';

const { DataTypes } = require('sequelize');
const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/**
 * deviceTokens.firebaseProjectId: the Firebase project that issued the push token. An FCM
 * token can only be sent through its own project, and the backend holds more than one while
 * apps move projects (utils/firebaseProjects.js). Existing rows stay NULL ("unclassified"):
 * they are tried on the legacy project, then the primary, and the project that accepts the
 * token is recorded on the row (utils/fcmRouting.js).
 */
module.exports = {
  async up(queryInterface) {
    await addColumnIfMissing(queryInterface, 'deviceTokens', 'firebaseProjectId', {
      type: DataTypes.STRING(64),
      allowNull: true,
      comment: 'Firebase project that issued tokenId; NULL = not known yet (legacy rows)',
    });
  },

  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'deviceTokens', 'firebaseProjectId');
  },
};
