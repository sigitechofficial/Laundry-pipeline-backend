'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    const has = tables.some(
      (t) => String(t).toLowerCase() === 'support_contact_configs'
    );
    if (!has) {
      await queryInterface.createTable('support_contact_configs', {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER,
        },
        supportEmail: {
          type: Sequelize.STRING(255),
          allowNull: true,
        },
        supportPhone: {
          type: Sequelize.STRING(50),
          allowNull: true,
        },
        helpUrl: {
          type: Sequelize.STRING(500),
          allowNull: true,
        },
        supportHours: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        createdAt: {
          allowNull: false,
          type: Sequelize.DATE,
        },
        updatedAt: {
          allowNull: false,
          type: Sequelize.DATE,
        },
      });
    }

    const [rows] = await queryInterface.sequelize.query(
      'SELECT id FROM support_contact_configs LIMIT 1'
    );
    if (!rows || !rows.length) {
      await queryInterface.bulkInsert('support_contact_configs', [
        {
          id: 1,
          supportEmail: null,
          supportPhone: null,
          helpUrl: null,
          supportHours: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('support_contact_configs');
  },
};
