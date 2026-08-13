'use strict';

const {
  priceForItem,
  ALL_CATEGORY_NAMES,
  SERVICE_NAME,
} = require('../data/dryCleanCatalog');

async function ensureDryCleanService(queryInterface, now) {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT id, name FROM services
     WHERE deletedAt IS NULL AND LOWER(name) = LOWER(:name)
     LIMIT 1`,
    { replacements: { name: SERVICE_NAME } }
  );
  if (rows.length) return Number(rows[0].id);

  await queryInterface.bulkInsert('services', [
    {
      name: SERVICE_NAME,
      description:
        'Professional dry cleaning service for delicate and special care garments.',
      status: true,
      image: null,
      timeRequired: '48-72 hours',
      pricingBasis: 'item',
      numberOfBags: false,
      numberOfItems: true,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  const [created] = await queryInterface.sequelize.query(
    `SELECT id FROM services
     WHERE deletedAt IS NULL AND LOWER(name) = LOWER(:name)
     LIMIT 1`,
    { replacements: { name: SERVICE_NAME } }
  );
  return Number(created[0].id);
}

async function disableLegacyCategories(queryInterface, serviceId, now) {
  const allowListSql = ALL_CATEGORY_NAMES.map((n) =>
    queryInterface.sequelize.escape(n)
  ).join(', ');

  await queryInterface.sequelize.query(
    `UPDATE categories
     SET status = 0, updatedAt = :now
     WHERE deletedAt IS NULL
       AND serviceId = :serviceId
       AND status = 1
       AND name NOT IN (${allowListSql})`,
    { replacements: { serviceId, now } }
  );

  await queryInterface.sequelize.query(
    `UPDATE categories c
     INNER JOIN serviceCategories sc
       ON sc.categoryId = c.id
      AND sc.serviceId = :serviceId
      AND sc.deletedAt IS NULL
     SET c.status = 0, c.updatedAt = :now
     WHERE c.deletedAt IS NULL
       AND c.status = 1
       AND (c.serviceId IS NULL OR c.serviceId = :serviceId)
       AND c.name NOT IN (${allowListSql})`,
    { replacements: { serviceId, now } }
  );

  await queryInterface.sequelize.query(
    `UPDATE subCategories sc
     INNER JOIN categories c ON c.id = sc.categoryId
     SET sc.status = 0, sc.updatedAt = :now
     WHERE sc.deletedAt IS NULL
       AND sc.status = 1
       AND c.deletedAt IS NULL
       AND (
         c.serviceId = :serviceId
         OR EXISTS (
           SELECT 1 FROM serviceCategories j
           WHERE j.categoryId = c.id
             AND j.serviceId = :serviceId
             AND j.deletedAt IS NULL
         )
       )
       AND c.name NOT IN (${allowListSql})`,
    { replacements: { serviceId, now } }
  );

  await queryInterface.sequelize.query(
    `UPDATE serviceCategories sc
     INNER JOIN categories c ON c.id = sc.categoryId
     SET sc.status = 0, sc.updatedAt = :now
     WHERE sc.deletedAt IS NULL
       AND sc.serviceId = :serviceId
       AND sc.status = 1
       AND c.name NOT IN (${allowListSql})`,
    { replacements: { serviceId, now } }
  );
}

async function ensureServiceCategoryLink(queryInterface, serviceId, categoryId, now) {
  const [existing] = await queryInterface.sequelize.query(
    `SELECT id, status, deletedAt FROM serviceCategories
     WHERE serviceId = :serviceId AND categoryId = :categoryId
     LIMIT 1`,
    { replacements: { serviceId, categoryId } }
  );

  if (!existing.length) {
    await queryInterface.bulkInsert('serviceCategories', [
      {
        serviceId,
        categoryId,
        status: true,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ]);
    return;
  }

  const row = existing[0];
  if (row.deletedAt || row.status === 0 || row.status === false) {
    await queryInterface.sequelize.query(
      `UPDATE serviceCategories
       SET status = 1, deletedAt = NULL, updatedAt = :now
       WHERE id = :id`,
      { replacements: { id: row.id, now } }
    );
  }
}

async function ensureCategory(queryInterface, serviceId, catDef, now) {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT id FROM categories
     WHERE deletedAt IS NULL
       AND serviceId = :serviceId
       AND name = :name
     LIMIT 1`,
    { replacements: { serviceId, name: catDef.name } }
  );

  if (rows.length) {
    const categoryId = Number(rows[0].id);
    await queryInterface.sequelize.query(
      `UPDATE categories
       SET status = 1,
           sortOrder = :sortOrder,
           description = :description,
           updatedAt = :now
       WHERE id = :id`,
      {
        replacements: {
          id: categoryId,
          sortOrder: catDef.sortOrder,
          description: catDef.description,
          now,
        },
      }
    );
    await ensureServiceCategoryLink(queryInterface, serviceId, categoryId, now);
    return categoryId;
  }

  const [deleted] = await queryInterface.sequelize.query(
    `SELECT id FROM categories
     WHERE deletedAt IS NOT NULL
       AND serviceId = :serviceId
       AND name = :name
     LIMIT 1`,
    { replacements: { serviceId, name: catDef.name } }
  );

  if (deleted.length) {
    const categoryId = Number(deleted[0].id);
    await queryInterface.sequelize.query(
      `UPDATE categories
       SET status = 1,
           deletedAt = NULL,
           sortOrder = :sortOrder,
           description = :description,
           image = NULL,
           updatedAt = :now
       WHERE id = :id`,
      {
        replacements: {
          id: categoryId,
          sortOrder: catDef.sortOrder,
          description: catDef.description,
          now,
        },
      }
    );
    await ensureServiceCategoryLink(queryInterface, serviceId, categoryId, now);
    return categoryId;
  }

  await queryInterface.bulkInsert('categories', [
    {
      name: catDef.name,
      status: true,
      image: null,
      description: catDef.description,
      serviceId,
      sortOrder: catDef.sortOrder,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ]);

  const [created] = await queryInterface.sequelize.query(
    `SELECT id FROM categories
     WHERE deletedAt IS NULL
       AND serviceId = :serviceId
       AND name = :name
     LIMIT 1`,
    { replacements: { serviceId, name: catDef.name } }
  );
  const categoryId = Number(created[0].id);
  await ensureServiceCategoryLink(queryInterface, serviceId, categoryId, now);
  return categoryId;
}

async function ensureSubCategories(queryInterface, categoryId, categoryName, items, now) {
  for (let i = 0; i < items.length; i += 1) {
    const name = items[i];
    const sortOrder = i + 1;
    const price = priceForItem(categoryName, name);
    const description = 'UK default dry-clean price (GBP) — adjust in admin if needed';

    const [rows] = await queryInterface.sequelize.query(
      `SELECT id FROM subCategories
       WHERE deletedAt IS NULL
         AND categoryId = :categoryId
         AND name = :name
       LIMIT 1`,
      { replacements: { categoryId, name } }
    );

    if (rows.length) {
      await queryInterface.sequelize.query(
        `UPDATE subCategories
         SET status = 1,
             sortOrder = :sortOrder,
             price = :price,
             description = :description,
             updatedAt = :now
         WHERE id = :id`,
        {
          replacements: {
            id: rows[0].id,
            sortOrder,
            price,
            description,
            now,
          },
        }
      );
      continue;
    }

    const [deleted] = await queryInterface.sequelize.query(
      `SELECT id FROM subCategories
       WHERE deletedAt IS NOT NULL
         AND categoryId = :categoryId
         AND name = :name
       LIMIT 1`,
      { replacements: { categoryId, name } }
    );

    if (deleted.length) {
      await queryInterface.sequelize.query(
        `UPDATE subCategories
         SET status = 1,
             deletedAt = NULL,
             sortOrder = :sortOrder,
             price = :price,
             description = :description,
             updatedAt = :now
         WHERE id = :id`,
        {
          replacements: {
            id: deleted[0].id,
            sortOrder,
            price,
            description,
            now,
          },
        }
      );
      continue;
    }

    await queryInterface.bulkInsert('subCategories', [
      {
        name,
        price,
        status: true,
        description,
        barCode: null,
        weightKg: null,
        unitCount: 1,
        sortOrder,
        categoryId,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ]);
  }
}

/**
 * @param {object} queryInterface
 * @param {Array<{name:string,sortOrder:number,description:string,items:string[]}>} batch
 * @param {{ disableLegacy?: boolean }} [opts]
 */
async function seedDryCleanBatch(queryInterface, batch, opts = {}) {
  const now = new Date();
  const disableLegacy = opts.disableLegacy !== false;
  const serviceId = await ensureDryCleanService(queryInterface, now);

  if (disableLegacy) {
    await disableLegacyCategories(queryInterface, serviceId, now);
  }

  for (const catDef of batch) {
    const categoryId = await ensureCategory(
      queryInterface,
      serviceId,
      catDef,
      now
    );
    await ensureSubCategories(
      queryInterface,
      categoryId,
      catDef.name,
      catDef.items,
      now
    );
  }

  return serviceId;
}

module.exports = {
  seedDryCleanBatch,
  ensureDryCleanService,
  disableLegacyCategories,
};
