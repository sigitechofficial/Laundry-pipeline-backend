'use strict';

const { addColumnIfMissing, removeColumnIfExists, tableExists } = require('../utils/migrationHelpers');

/**
 * Banners can show on the website as well as the mobile app. `bannerImage` stays the
 * mobile image; the website gets its own wide image in `webImage`. Existing rows are mobile.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, 'banners'))) return;
    await addColumnIfMissing(queryInterface, 'banners', 'placement', {
      type: Sequelize.STRING(10),
      allowNull: false,
      defaultValue: 'mobile',
      comment: 'mobile | web | both',
    });
    await addColumnIfMissing(queryInterface, 'banners', 'webImage', {
      type: Sequelize.STRING(500),
      allowNull: true,
      defaultValue: null,
      comment: 'Website banner image (wide); bannerImage is the mobile app image',
    });
  },

  async down(queryInterface) {
    if (!(await tableExists(queryInterface, 'banners'))) return;
    await removeColumnIfExists(queryInterface, 'banners', 'webImage');
    await removeColumnIfExists(queryInterface, 'banners', 'placement');
  },
};
