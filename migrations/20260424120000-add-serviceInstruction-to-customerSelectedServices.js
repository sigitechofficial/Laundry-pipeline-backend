'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('customerSelectedServices', 'serviceInstruction', {
      type: Sequelize.TEXT,
      allowNull: true
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('customerSelectedServices', 'serviceInstruction');
  }
};
