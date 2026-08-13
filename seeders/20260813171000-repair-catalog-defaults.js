'use strict';

/** Seeds Alteration & Repair service + dedicated repair garments/options (not wash catalog). */
module.exports = {
  async up(queryInterface) {
    const now = new Date();

    const [services] = await queryInterface.sequelize.query(
      `SELECT id, name FROM services WHERE deletedAt IS NULL AND (LOWER(name) LIKE '%repair%' OR LOWER(name) LIKE '%alteration%') LIMIT 1`
    );

    if (!services.length) {
      await queryInterface.bulkInsert('services', [
        {
          name: 'Alteration & Repair',
          description:
            'Professional alterations and repairs to restore and extend the life of your clothes.',
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
    }

    const [garmentCountRows] = await queryInterface.sequelize.query(
      `SELECT COUNT(*) AS cnt FROM repairGarments WHERE deletedAt IS NULL`
    );
    const garmentCount = Number(garmentCountRows?.[0]?.cnt || 0);
    if (garmentCount > 0) return;

    const optionDefs = [
      { name: 'Button resew / replace', price: 3.5, sortOrder: 1 },
      { name: 'Zip repair / replace', price: 12, sortOrder: 2 },
      { name: 'Hemming', price: 8, sortOrder: 3 },
      { name: 'Seam repair', price: 7, sortOrder: 4 },
      { name: 'Tear / hole patch', price: 10, sortOrder: 5 },
      { name: 'Take in / let out', price: 15, sortOrder: 6 },
      { name: 'Other alteration', price: 0, sortOrder: 7 },
    ];

    await queryInterface.bulkInsert(
      'repairOptions',
      optionDefs.map((o) => ({
        name: o.name,
        description: null,
        price: o.price,
        status: true,
        sortOrder: o.sortOrder,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }))
    );

    const [options] = await queryInterface.sequelize.query(
      `SELECT id, name FROM repairOptions WHERE deletedAt IS NULL`
    );
    const optionIdByName = new Map(options.map((o) => [o.name, o.id]));

    const garmentDefs = [
      {
        name: 'Shirt',
        sortOrder: 1,
        options: [
          'Button resew / replace',
          'Seam repair',
          'Take in / let out',
          'Other alteration',
        ],
      },
      {
        name: 'Trouser / Pants',
        sortOrder: 2,
        options: [
          'Zip repair / replace',
          'Hemming',
          'Seam repair',
          'Take in / let out',
          'Other alteration',
        ],
      },
      {
        name: 'Dress',
        sortOrder: 3,
        options: [
          'Zip repair / replace',
          'Hemming',
          'Seam repair',
          'Take in / let out',
          'Other alteration',
        ],
      },
      {
        name: 'Jacket / Coat',
        sortOrder: 4,
        options: [
          'Button resew / replace',
          'Zip repair / replace',
          'Seam repair',
          'Tear / hole patch',
          'Other alteration',
        ],
      },
      {
        name: 'Skirt',
        sortOrder: 5,
        options: [
          'Zip repair / replace',
          'Hemming',
          'Seam repair',
          'Take in / let out',
          'Other alteration',
        ],
      },
      {
        name: 'Other garment',
        sortOrder: 6,
        options: [
          'Button resew / replace',
          'Zip repair / replace',
          'Hemming',
          'Seam repair',
          'Tear / hole patch',
          'Take in / let out',
          'Other alteration',
        ],
      },
    ];

    await queryInterface.bulkInsert(
      'repairGarments',
      garmentDefs.map((g) => ({
        name: g.name,
        description: null,
        status: true,
        sortOrder: g.sortOrder,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }))
    );

    const [garments] = await queryInterface.sequelize.query(
      `SELECT id, name FROM repairGarments WHERE deletedAt IS NULL`
    );
    const garmentIdByName = new Map(garments.map((g) => [g.name, g.id]));

    const links = [];
    for (const g of garmentDefs) {
      const garmentId = garmentIdByName.get(g.name);
      for (const optName of g.options) {
        const optionId = optionIdByName.get(optName);
        if (!garmentId || !optionId) continue;
        links.push({
          repairGarmentId: garmentId,
          repairOptionId: optionId,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    if (links.length) {
      await queryInterface.bulkInsert('repairGarmentOptions', links);
    }
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('repairGarmentOptions', null, {});
    await queryInterface.bulkDelete('repairGarments', null, {});
    await queryInterface.bulkDelete('repairOptions', null, {});
  },
};
