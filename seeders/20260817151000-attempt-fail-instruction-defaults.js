'use strict';

/** Idempotent default fail-attempt instruction checklists (pickup + delivery). */
module.exports = {
  async up(queryInterface) {
    const now = new Date();
    const sequelize = queryInterface.sequelize;

    const [setCountRows] = await sequelize.query(
      `SELECT COUNT(*) AS cnt FROM attempt_fail_instruction_sets`
    );
    if (Number(setCountRows?.[0]?.cnt || 0) > 0) {
      console.log('[seed] attempt fail instruction sets already present');
      return;
    }

    await queryInterface.bulkInsert('attempt_fail_instruction_sets', [
      {
        scope: 'pickup',
        name: 'Default pickup fail checklist',
        zoneId: null,
        isActive: true,
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        scope: 'delivery',
        name: 'Default delivery fail checklist',
        zoneId: null,
        isActive: true,
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const [sets] = await sequelize.query(
      `SELECT id, scope FROM attempt_fail_instruction_sets WHERE zoneId IS NULL`
    );
    const pickupSet = sets.find((s) => s.scope === 'pickup');
    const deliverySet = sets.find((s) => s.scope === 'delivery');
    if (!pickupSet || !deliverySet) {
      throw new Error('Failed to create default fail instruction sets');
    }

    const pickupItems = [
      {
        title: 'Knock or ring the doorbell',
        body: 'Make a clear attempt at the door so the customer can hear you.',
        sortOrder: 1,
        isRequired: true,
      },
      {
        title: 'Wait visibly at the address',
        body: 'Remain at the pickup address for the required on-site wait time.',
        sortOrder: 2,
        isRequired: true,
      },
      {
        title: 'Call or message the customer',
        body: 'Try to reach the customer by phone or in-app contact before marking failed.',
        sortOrder: 3,
        isRequired: true,
      },
      {
        title: 'Confirm you are at the correct address',
        body: 'Double-check street number, flat/unit, and entry instructions.',
        sortOrder: 4,
        isRequired: false,
      },
    ];

    const deliveryItems = [
      {
        title: 'Knock or ring the doorbell',
        body: 'Make a clear attempt at the door so the customer can hear you.',
        sortOrder: 1,
        isRequired: true,
      },
      {
        title: 'Wait visibly at the delivery address',
        body: 'Remain at the drop-off address for the required on-site wait time.',
        sortOrder: 2,
        isRequired: true,
      },
      {
        title: 'Call or message the customer',
        body: 'Try to reach the customer by phone or in-app contact before marking failed.',
        sortOrder: 3,
        isRequired: true,
      },
      {
        title: 'Check delivery instructions',
        body: 'Review any leave-at-door / concierge notes before failing the delivery.',
        sortOrder: 4,
        isRequired: false,
      },
    ];

    const rows = [
      ...pickupItems.map((item) => ({
        setId: pickupSet.id,
        title: item.title,
        body: item.body,
        sortOrder: item.sortOrder,
        isEnabled: true,
        isRequired: item.isRequired,
        createdAt: now,
        updatedAt: now,
      })),
      ...deliveryItems.map((item) => ({
        setId: deliverySet.id,
        title: item.title,
        body: item.body,
        sortOrder: item.sortOrder,
        isEnabled: true,
        isRequired: item.isRequired,
        createdAt: now,
        updatedAt: now,
      })),
    ];

    await queryInterface.bulkInsert('attempt_fail_instructions', rows);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('attempt_fail_instructions', null, {});
    await queryInterface.bulkDelete('attempt_fail_instruction_sets', null, {});
  },
};
