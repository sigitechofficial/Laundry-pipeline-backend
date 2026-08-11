const { supportContactConfig, zone } = require('../../models');

function pickPhone(...candidates) {
    for (const c of candidates) {
        const v = c != null ? String(c).trim() : '';
        if (v) return v;
    }
    return '';
}

class SupportContactService {
    async getSupportContact() {
        const [row] = await supportContactConfig.findOrCreate({
            where: { id: 1 },
            defaults: {},
        });
        return row;
    }

    /**
     * Resolve support contact for an audience.
     * Priority: zone override → audience-specific global → shared supportPhone.
     *
     * @param {{ audience?: 'agent'|'customer', zoneId?: number|string|null }} opts
     */
    async getResolvedSupportContact(opts = {}) {
        const audience = opts.audience === 'agent' ? 'agent' : 'customer';
        const zoneId = opts.zoneId != null && opts.zoneId !== ''
            ? Number(opts.zoneId)
            : null;

        const global = await this.getSupportContact();
        const plain = typeof global.toJSON === 'function' ? global.toJSON() : { ...global };

        let zoneRow = null;
        if (Number.isFinite(zoneId) && zoneId > 0) {
            zoneRow = await zone.findByPk(zoneId, {
                attributes: ['id', 'name', 'agentSupportPhone', 'customerSupportPhone'],
            });
        }

        const zoneAgent = zoneRow?.agentSupportPhone;
        const zoneCustomer = zoneRow?.customerSupportPhone;

        const agentPhone = pickPhone(
            zoneAgent,
            plain.agentSupportPhone,
            plain.supportPhone
        );
        const customerPhone = pickPhone(
            zoneCustomer,
            plain.customerSupportPhone,
            plain.supportPhone
        );

        const supportPhone =
            audience === 'agent' ? agentPhone : customerPhone;

        return {
            id: plain.id,
            supportEmail: plain.supportEmail || '',
            supportPhone,
            agentSupportPhone: agentPhone,
            customerSupportPhone: customerPhone,
            helpUrl: plain.helpUrl || '',
            supportHours: plain.supportHours || '',
            audience,
            zoneId: zoneRow?.id ?? null,
            zoneName: zoneRow?.name ?? null,
            phoneSource: (() => {
                if (audience === 'agent' && pickPhone(zoneAgent)) return 'zone';
                if (audience === 'customer' && pickPhone(zoneCustomer)) return 'zone';
                if (audience === 'agent' && pickPhone(plain.agentSupportPhone)) {
                    return 'global_agent';
                }
                if (audience === 'customer' && pickPhone(plain.customerSupportPhone)) {
                    return 'global_customer';
                }
                return 'global_shared';
            })(),
        };
    }

    async updateSupportContact(data) {
        const {
            supportEmail,
            supportPhone,
            agentSupportPhone,
            customerSupportPhone,
            helpUrl,
            supportHours,
        } = data;

        const [row] = await supportContactConfig.findOrCreate({
            where: { id: 1 },
            defaults: {},
        });

        const shared = supportPhone != null ? String(supportPhone).trim() : row.supportPhone;
        const agent =
            agentSupportPhone != null && String(agentSupportPhone).trim() !== ''
                ? String(agentSupportPhone).trim()
                : shared;
        const customer =
            customerSupportPhone != null && String(customerSupportPhone).trim() !== ''
                ? String(customerSupportPhone).trim()
                : shared;

        await row.update({
            supportEmail: supportEmail != null ? String(supportEmail).trim() : row.supportEmail,
            supportPhone: shared,
            agentSupportPhone: agent,
            customerSupportPhone: customer,
            helpUrl: helpUrl != null ? helpUrl : row.helpUrl,
            supportHours: supportHours != null ? String(supportHours).trim() : row.supportHours,
        });

        return row;
    }
}

module.exports = new SupportContactService();
