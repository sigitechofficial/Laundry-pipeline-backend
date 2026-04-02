'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('support_contact_configs', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      supportEmail: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      supportPhone: {
        type: Sequelize.STRING(50),
        allowNull: true
      },
      helpUrl: {
        type: Sequelize.STRING(500),
        allowNull: true
      },
      supportHours: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      }
    });

    await queryInterface.bulkInsert('support_contact_configs', [
      {
        id: 1,
        supportEmail: null,
        supportPhone: null,
        helpUrl: null,
        supportHours: null,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ]);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('support_contact_configs');
  }
};
