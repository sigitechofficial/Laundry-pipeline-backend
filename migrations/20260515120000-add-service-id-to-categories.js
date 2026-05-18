'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('categories');
    if (!table.serviceId) {
      await queryInterface.addColumn('categories', 'serviceId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'services',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('categories');
    if (table.serviceId) {
      await queryInterface.removeColumn('categories', 'serviceId');
    }
  },
};
