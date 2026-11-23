'use strict';

/**
 * bookings.onHoldReason labels had typos baked into the ENUM ("Items .Items",
 * "Risk .", "Needed.sDelicate"). Each old label is mapped to its corrected text,
 * so existing rows keep their meaning; the column is then narrowed to the new set.
 */
const OLD_TO_NEW = [
  ['Missing or Damaged Items .Items lost or damaged, requiring customer verification.',
    'Missing or Damaged Items. Items lost or damaged, requiring customer verification.'],
  ['Special Instructions Pending. Waiting for customer confirmation on delicate fabrics, stains, or specific washing preferences.',
    'Special Instructions Pending. Waiting for customer confirmation on delicate fabrics, stains, or specific washing preferences.'],
  ['Damaged or Shrinking Risk . Items that may shrink, bleed color, or have pre-existing damage, requiring approval before proceeding.',
    'Damaged or Shrinking Risk. Items that may shrink, bleed color, or have pre-existing damage, requiring approval before proceeding.'],
  ['Incorrect Tagging or Sorting. Mislabeling or mixing up orders requiring manual sorting.',
    'Incorrect Tagging or Sorting. Mislabeling or mixing up orders requiring manual sorting.'],
  ['Damage Liability Waiver Needed.sDelicate or high-risk items need the customer to sign a waiver before cleaning.',
    'Damage Liability Waiver Needed. Delicate or high-risk items need the customer to sign a waiver before cleaning.'],
  ['Other', 'Other'],
];

async function setEnum(queryInterface, Sequelize, values, transaction) {
  await queryInterface.changeColumn('bookings', 'onHoldReason', {
    type: Sequelize.ENUM(...values),
    allowNull: true,
  }, { transaction });
}

async function remap(queryInterface, Sequelize, pairs, fromIdx, toIdx) {
  const oldValues = pairs.map((p) => p[fromIdx]);
  const newValues = pairs.map((p) => p[toIdx]);
  await queryInterface.sequelize.transaction(async (transaction) => {
    // Widen to both sets, move the rows, then narrow to the target set.
    await setEnum(queryInterface, Sequelize, [...new Set([...oldValues, ...newValues])], transaction);
    for (const pair of pairs) {
      if (pair[fromIdx] === pair[toIdx]) continue;
      await queryInterface.sequelize.query(
        'UPDATE bookings SET onHoldReason = :to WHERE onHoldReason = :from',
        { replacements: { from: pair[fromIdx], to: pair[toIdx] }, transaction },
      );
    }
    await setEnum(queryInterface, Sequelize, newValues, transaction);
  });
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await remap(queryInterface, Sequelize, OLD_TO_NEW, 0, 1);
  },
  async down(queryInterface, Sequelize) {
    await remap(queryInterface, Sequelize, OLD_TO_NEW, 1, 0);
  },
};
