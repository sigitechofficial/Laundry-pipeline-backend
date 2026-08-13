'use strict';

/**
 * Restore Dry Clean categories/subcategories that were soft-disabled
 * by earlier dry-clean-catalog batch seeders (status=0).
 * Does not delete the new catalog — only turns old rows back on.
 */
const { SERVICE_NAME } = require('./data/dryCleanCatalog');

module.exports = {
  async up(queryInterface) {
    const now = new Date();

    const [services] = await queryInterface.sequelize.query(
      `SELECT id FROM services
       WHERE deletedAt IS NULL AND LOWER(name) = LOWER(:name)
       LIMIT 1`,
      { replacements: { name: SERVICE_NAME } }
    );
    if (!services.length) return;

    const serviceId = Number(services[0].id);

    // Re-enable categories owned by / linked to Dry Clean
    await queryInterface.sequelize.query(
      `UPDATE categories c
       SET c.status = 1, c.updatedAt = :now
       WHERE c.deletedAt IS NULL
         AND c.status = 0
         AND (
           c.serviceId = :serviceId
           OR EXISTS (
             SELECT 1 FROM serviceCategories sc
             WHERE sc.categoryId = c.id
               AND sc.serviceId = :serviceId
               AND sc.deletedAt IS NULL
           )
         )`,
      { replacements: { serviceId, now } }
    );

    // Re-enable their subcategories
    await queryInterface.sequelize.query(
      `UPDATE subCategories sc
       INNER JOIN categories c ON c.id = sc.categoryId
       SET sc.status = 1, sc.updatedAt = :now
       WHERE sc.deletedAt IS NULL
         AND sc.status = 0
         AND c.deletedAt IS NULL
         AND (
           c.serviceId = :serviceId
           OR EXISTS (
             SELECT 1 FROM serviceCategories j
             WHERE j.categoryId = c.id
               AND j.serviceId = :serviceId
               AND j.deletedAt IS NULL
           )
         )`,
      { replacements: { serviceId, now } }
    );

    // Re-enable junction links
    await queryInterface.sequelize.query(
      `UPDATE serviceCategories
       SET status = 1, updatedAt = :now
       WHERE deletedAt IS NULL
         AND serviceId = :serviceId
         AND status = 0`,
      { replacements: { serviceId, now } }
    );
  },

  async down() {},
};
