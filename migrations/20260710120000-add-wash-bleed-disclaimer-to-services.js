'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('services', 'washBleedDisclaimerEnabled', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment:
        'When true, customer sees colour-bleed disclaimer for mixed wash on this service',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('services', 'washBleedDisclaimerEnabled');
  },
};
