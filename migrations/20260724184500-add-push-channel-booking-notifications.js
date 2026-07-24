'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface) {
        // MySQL: expand ENUM to include push (Firebase notify before SMS).
        await queryInterface.sequelize.query(
            "ALTER TABLE `booking_notifications` MODIFY COLUMN `channel` ENUM('sms','call','push') NOT NULL DEFAULT 'sms'"
        );
    },

    async down(queryInterface) {
        await queryInterface.sequelize.query(
            "ALTER TABLE `booking_notifications` MODIFY COLUMN `channel` ENUM('sms','call') NOT NULL DEFAULT 'sms'"
        );
    },
};
