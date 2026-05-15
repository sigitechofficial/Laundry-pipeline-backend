'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('banners', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      title: {
        type: Sequelize.STRING(200),
        allowNull: false
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      bannerImage: {
        type: Sequelize.STRING(500),
        allowNull: true
      },
      offerType: {
        type: Sequelize.ENUM('percentage', 'flat', 'free_delivery'),
        allowNull: false
      },
      discountValue: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: true
      },
      maxDiscountCap: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: true
      },
      targetType: {
        type: Sequelize.ENUM('global', 'service', 'category', 'sub_category'),
        allowNull: false
      },
      targetId: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      zoneIds: {
        type: Sequelize.JSON,
        allowNull: true,
        comment: 'JSON array of zone ids; null or [] = all zones'
      },
      startDate: {
        type: Sequelize.DATEONLY,
        allowNull: true
      },
      endDate: {
        type: Sequelize.DATEONLY,
        allowNull: true
      },
      displayOrder: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1
      },
      showOnHome: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      isActive: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
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
  },

  async down(queryInterface) {
    await queryInterface.dropTable('banners');
  }
};
