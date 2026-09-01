'use strict';

const {
  tableExists,
  addColumnIfMissing,
  removeColumnIfExists,
} = require('../utils/migrationHelpers');

/**
 * Admin-controlled routing restrictions per shop.
 *
 * preferredEligible=false  → shop never gets the returning-customer head-start,
 *                            but can still see broadcast bookings.
 * marketplaceHold=true     → shop receives no new offers at all (preferred or
 *                            broadcast). Admin manual assignment still works.
 *
 * These are deliberately separate from users.status (login block) so ops can
 * restrict routing without locking the account out of in-flight orders.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, 'shopAssignmentPolicies'))) {
      await queryInterface.createTable('shopAssignmentPolicies', {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER,
        },
        shopUserId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          unique: true,
          references: { model: 'users', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        preferredEligible: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        marketplaceHold: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        reason: {
          type: Sequelize.STRING(500),
          allowNull: true,
        },
        expiresAt: {
          type: Sequelize.DATE,
          allowNull: true,
          defaultValue: null,
          comment: 'When set and in the past, restrictions no longer apply',
        },
        updatedByUserId: {
          type: Sequelize.INTEGER,
          allowNull: true,
        },
        createdAt: { allowNull: false, type: Sequelize.DATE },
        updatedAt: { allowNull: false, type: Sequelize.DATE },
      });
    }

    // Why a preferred shop was (or was not) picked — assignment debugging.
    await addColumnIfMissing(
      queryInterface,
      'bookings',
      'preferredShopSkipReason',
      { type: Sequelize.STRING(64), allowNull: true, defaultValue: null }
    );
  },

  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'bookings', 'preferredShopSkipReason');
    if (await tableExists(queryInterface, 'shopAssignmentPolicies')) {
      await queryInterface.dropTable('shopAssignmentPolicies');
    }
  },
};
