'use strict';

const { tableExists } = require('../utils/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, 'reviewReasonCodes'))) {
    await queryInterface.createTable('reviewReasonCodes', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER,
      },
      code: {
        type: Sequelize.STRING(64),
        allowNull: false,
        unique: true,
      },
      label: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      sentiment: {
        type: Sequelize.ENUM('positive', 'negative'),
        allowNull: false,
      },
      sortOrder: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      status: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      isOther: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
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

    if (!(await tableExists(queryInterface, 'shopReviews'))) {
    await queryInterface.createTable('shopReviews', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER,
      },
      bookingId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        unique: true,
      },
      customerId: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      businessInfoId: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      laundryShopId: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      rating: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      comment: {
        type: Sequelize.STRING(500),
        allowNull: true,
      },
      visibility: {
        type: Sequelize.ENUM('published', 'hidden'),
        allowNull: false,
        defaultValue: 'published',
      },
      hiddenReason: {
        type: Sequelize.STRING(500),
        allowNull: true,
      },
      hiddenByAdminId: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      hiddenAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      submittedAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
      deletedAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
    });

    await queryInterface.addIndex('shopReviews', ['businessInfoId']);
    await queryInterface.addIndex('shopReviews', ['customerId']);
    await queryInterface.addIndex('shopReviews', ['visibility']);
    await queryInterface.addIndex('shopReviews', ['submittedAt']);
    }

    if (!(await tableExists(queryInterface, 'shopReviewReasons'))) {
    await queryInterface.createTable('shopReviewReasons', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER,
      },
      shopReviewId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'shopReviews',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      reasonCodeId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'reviewReasonCodes',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      otherText: {
        type: Sequelize.STRING(500),
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

    await queryInterface.addIndex(
      'shopReviewReasons',
      ['shopReviewId', 'reasonCodeId'],
      { unique: true, name: 'shop_review_reasons_unique' }
    );
    }

    if (!(await tableExists(queryInterface, 'shopReviewStats'))) {
    await queryInterface.createTable('shopReviewStats', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER,
      },
      businessInfoId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        unique: true,
      },
      avgRating: {
        type: Sequelize.DECIMAL(3, 2),
        allowNull: false,
        defaultValue: 0,
      },
      ratingCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      publishedCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      rating1: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      rating2: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      rating3: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      rating4: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      rating5: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      topPositiveReasonCode: {
        type: Sequelize.STRING(64),
        allowNull: true,
      },
      topNegativeReasonCode: {
        type: Sequelize.STRING(64),
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
  },

  async down(queryInterface) {
    await queryInterface.dropTable('shopReviewStats');
    await queryInterface.dropTable('shopReviewReasons');
    await queryInterface.dropTable('shopReviews');
    await queryInterface.dropTable('reviewReasonCodes');
  },
};
