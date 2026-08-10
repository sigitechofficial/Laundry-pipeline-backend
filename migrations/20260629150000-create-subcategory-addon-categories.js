'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../lib/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Create join table for the many-to-many relation.
    const tables = await queryInterface.showAllTables();
    const normalized = tables.map((t) =>
      typeof t === 'string' ? t : t.tableName
    );

    if (!normalized.includes('subCategoryAddOnCategories')) {
      await queryInterface.createTable('subCategoryAddOnCategories', {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER
        },
        subCategoryId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: 'subCategories', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE'
        },
        addOnCategoryId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: 'addOnCategories', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE'
        },
        createdAt: { allowNull: false, type: Sequelize.DATE },
        updatedAt: { allowNull: false, type: Sequelize.DATE }
      });

      await queryInterface.addIndex(
        'subCategoryAddOnCategories',
        ['subCategoryId', 'addOnCategoryId'],
        { unique: true, name: 'subcat_addoncat_unique' }
      );
    }

    // 2. Migrate any existing single links from subCategories.addOnCategoryId.
    const subCatColumns = await queryInterface.describeTable('subCategories');
    if (subCatColumns.addOnCategoryId) {
      await queryInterface.sequelize.query(`
        INSERT INTO \`subCategoryAddOnCategories\`
          (\`subCategoryId\`, \`addOnCategoryId\`, \`createdAt\`, \`updatedAt\`)
        SELECT s.\`id\`, s.\`addOnCategoryId\`, NOW(), NOW()
        FROM \`subCategories\` s
        WHERE s.\`addOnCategoryId\` IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM \`subCategoryAddOnCategories\` j
            WHERE j.\`subCategoryId\` = s.\`id\`
              AND j.\`addOnCategoryId\` = s.\`addOnCategoryId\`
          );
      `);

      // 3. Drop the now-redundant single FK column.
      await removeColumnIfExists(queryInterface, 'subCategories', 'addOnCategoryId');
    }
  },

  async down(queryInterface, Sequelize) {
    const subCatColumns = await queryInterface.describeTable('subCategories');
    if (!subCatColumns.addOnCategoryId) {
      await addColumnIfMissing(queryInterface, 'subCategories', 'addOnCategoryId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'addOnCategories', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      });

      // Best-effort restore: take the first linked category per sub-category.
      await queryInterface.sequelize.query(`
        UPDATE \`subCategories\` s
        JOIN (
          SELECT \`subCategoryId\`, MIN(\`addOnCategoryId\`) AS addOnCategoryId
          FROM \`subCategoryAddOnCategories\`
          GROUP BY \`subCategoryId\`
        ) j ON j.\`subCategoryId\` = s.\`id\`
        SET s.\`addOnCategoryId\` = j.\`addOnCategoryId\`;
      `);
    }

    await queryInterface.dropTable('subCategoryAddOnCategories');
  }
};
