'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('addOnServices', 'price', {
      type: Sequelize.DECIMAL(10, 2),
      allowNull: false
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('addOnServices', 'price', {
      type: Sequelize.DECIMAL(10, 0),
      allowNull: false
    });
  }
};
