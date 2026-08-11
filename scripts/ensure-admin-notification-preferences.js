'use strict';

/**
 * Ensures admin_notification_preferences table exists (for deploys that skip migrations).
 * Run: node scripts/ensure-admin-notification-preferences.js
 */
require('dotenv').config();
const { sequelize } = require('../models');

async function main() {
    const qi = sequelize.getQueryInterface();
    const tables = await qi.showAllTables();
    const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));
    if (names.includes('admin_notification_preferences')) {
        console.log('admin_notification_preferences already exists');
        process.exit(0);
    }
    console.log('Running migration 20260811140000-create-admin-notification-preferences.js …');
    const migration = require('../migrations/20260811140000-create-admin-notification-preferences');
    await migration.up(qi, sequelize.Sequelize);
    console.log('Done.');
    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
