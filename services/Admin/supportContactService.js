const { supportContactConfig } = require('../../models');

class SupportContactService {
    async getSupportContact() {
        const [row] = await supportContactConfig.findOrCreate({ where: { id: 1 }, defaults: {} });
        return row;
    }

    async updateSupportContact(data) {
        const { supportEmail, supportPhone, helpUrl, supportHours } = data;
        const [row] = await supportContactConfig.findOrCreate({ where: { id: 1 }, defaults: {} });
        await row.update({ supportEmail, supportPhone, helpUrl, supportHours });
        return row;
    }
}

module.exports = new SupportContactService();
