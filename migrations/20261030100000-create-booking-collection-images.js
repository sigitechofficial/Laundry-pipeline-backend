'use strict';

const { tableExists } = require('../utils/migrationHelpers');

/**
 * Customer photos of where bags are left for "Collect from Outside" pickups.
 * Optional per booking: older customer apps never send them.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, 'bookingCollectionImages'))) {
      await queryInterface.createTable('bookingCollectionImages', {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER,
        },
        bookingId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: 'bookings', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        imageUrl: {
          type: Sequelize.STRING,
          allowNull: false,
          comment: 'Relative path under /Public (e.g. Public/collectionImages/...)',
        },
        sortOrder: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 1,
        },
        createdAt: { allowNull: false, type: Sequelize.DATE },
        updatedAt: { allowNull: false, type: Sequelize.DATE },
      });
      await queryInterface.addIndex('bookingCollectionImages', ['bookingId']);
    }
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, 'bookingCollectionImages')) {
      await queryInterface.dropTable('bookingCollectionImages');
    }
  },
};
