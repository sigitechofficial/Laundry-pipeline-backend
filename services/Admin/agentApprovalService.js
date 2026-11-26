const {
    users,
    addressDb,
    bussinessInformation,
    bussinessWorkingHours,
    agentSelectServices,
    service,
    machineCount,
    machines,
    zone,
    cities,
    countries,
} = require('../../models');
const { Op } = require('sequelize');
const { NotFoundError, ValidationError } = require('../../middlewares/universalErrorHandler');
const { enqueueEmail } = require('../email/emailOutbox');

/**
 * Reasons admin can pick when rejecting a shop's registration. The admin panel
 * shows the same list; "Other" needs a note.
 */
const AGENT_REJECTION_REASONS = Object.freeze([
    'Business details are incomplete or incorrect',
    'Shop address could not be verified',
    'Shop is outside our service areas',
    'Services offered do not match what we need',
    'Not enough machinery or capacity',
    'Working hours do not fit our collection and delivery times',
    'Turnaround times are too long',
    'Contact details could not be verified',
    'Duplicate or existing account',
    'Other',
]);
const OTHER_REASON = 'Other';
const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** "Reason A; Reason B. Note: …" kept within the 500-char column. */
function composeRejection(reasons, note) {
    const text = reasons.filter((r) => r !== OTHER_REASON).join('; ');
    const withNote = note ? (text ? `${text}. Note: ${note}` : note) : text;
    return withNote.slice(0, 500);
}

/** Validates the admin's choice: at least one listed reason; "Other" needs a note. */
function parseRejection(reasons, note, legacyReason) {
    let list = Array.isArray(reasons) ? reasons : reasons ? [reasons] : [];
    list = [...new Set(list.map((r) => String(r || '').trim()).filter(Boolean))];
    const cleanNote = note ? String(note).trim().slice(0, 400) : '';
    // Old admin builds send a single free-text "reason".
    if (!list.length && legacyReason && String(legacyReason).trim()) {
        return { reasons: [], note: String(legacyReason).trim().slice(0, 400) };
    }
    if (!list.length) {
        throw new ValidationError('Choose at least one reason for rejecting this shop');
    }
    const unknown = list.filter((r) => !AGENT_REJECTION_REASONS.includes(r));
    if (unknown.length) {
        throw new ValidationError(`Unknown rejection reason: ${unknown[0]}`);
    }
    if (list.includes(OTHER_REASON) && !cleanNote) {
        throw new ValidationError('Add a note explaining the "Other" reason');
    }
    return { reasons: list, note: cleanNote };
}

const plain = (row) => (row && typeof row.get === 'function' ? row.get({ plain: true }) : row || null);

class AgentApprovalService {
    get rejectionReasons() {
        return AGENT_REJECTION_REASONS;
    }

    _mapAgentRow(row) {
        const plainRow = row.get({ plain: true });
        const shop = Array.isArray(plainRow.agentInfo)
            ? plainRow.agentInfo[0]
            : plainRow.agentInfo;
        return {
            id: plainRow.id,
            firstName: plainRow.firstName,
            lastName: plainRow.lastName,
            email: plainRow.email,
            phoneNum: plainRow.phoneNum,
            countryCode: plainRow.countryCode,
            createdAt: plainRow.createdAt,
            agentApprovalStatus: plainRow.agentApprovalStatus,
            rejectionReason: plainRow.rejectionReason || null,
            shopName: shop?.shopName || null,
            matchProfileOptions: shop?.matchProfileOptions || null,
            address: plainRow.addressDb || null,
        };
    }

    async getAgentsByApprovalStatus(status) {
        const agents = await users.findAll({
            where: {
                userTypeId: 4,
                agentApprovalStatus: status,
                deletedAt: { [Op.is]: null },
            },
            attributes: [
                'id',
                'firstName',
                'lastName',
                'email',
                'phoneNum',
                'countryCode',
                'createdAt',
                'agentApprovalStatus',
                'rejectionReason',
            ],
            include: [
                {
                    model: addressDb,
                    attributes: ['streetAddress', 'district', 'province', 'postalcode'],
                    required: false,
                },
                {
                    model: bussinessInformation,
                    as: 'agentInfo',
                    attributes: ['id', 'shopName', 'matchProfileOptions'],
                    required: false,
                },
            ],
            order: [['createdAt', 'DESC']],
        });

        return agents.map((row) => this._mapAgentRow(row));
    }

    async getPendingAgents() {
        return this.getAgentsByApprovalStatus('pending');
    }

    async getRejectedAgents() {
        return this.getAgentsByApprovalStatus('rejected');
    }

    /**
     * Everything the shop gave when it registered, for the admin review screen:
     * account, shop details, address and zone, services with turnaround,
     * working hours, machines and payout set-up.
     */
    async getAgentRegistration(agentId) {
        const agent = await users.findOne({
            where: { id: agentId, userTypeId: 4, deletedAt: { [Op.is]: null } },
            attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum', 'countryCode',
                'createdAt', 'verifiedAt', 'agentApprovalStatus', 'rejectionReason', 'status'],
        });
        if (!agent) throw new NotFoundError('Agent not found');

        const info = plain(await bussinessInformation.findOne({
            where: { agentId },
            order: [['id', 'ASC']],
        }));

        const shopAddress = plain(await addressDb.findOne({
            where: { userId: agentId, addressType: 'LaundaryShopAddress' },
            attributes: ['id', 'streetAddress', 'district', 'province', 'postalcode', 'lat', 'lng',
                'zoneId', 'status', 'cityId', 'countryId'],
            include: [
                { model: cities, attributes: ['id', 'name'], required: false },
                { model: countries, attributes: ['id', 'name'], required: false },
            ],
            order: [['id', 'ASC']],
        }));
        let zoneName = null;
        if (shopAddress?.zoneId) {
            const z = await zone.findByPk(shopAddress.zoneId, { attributes: ['id', 'name'] });
            zoneName = z?.name || null;
        }

        const serviceRows = await agentSelectServices.findAll({
            where: { agentServiceId: agentId },
            attributes: ['id', 'serviceId', 'status', 'serviceTimeRequired'],
            include: [{ model: service, attributes: ['id', 'name'], required: false, paranoid: false }],
            order: [['id', 'ASC']],
        });

        const hourRows = await bussinessWorkingHours.findAll({
            where: { userId: agentId },
            attributes: ['dayOfWeek', 'openTime', 'closeTime', 'status'],
        });
        const hours = hourRows
            .map(plain)
            .sort((a, b) => DAY_ORDER.indexOf(a.dayOfWeek) - DAY_ORDER.indexOf(b.dayOfWeek))
            .map((h) => ({
                day: h.dayOfWeek,
                open: Boolean(h.status),
                openTime: h.openTime || null,
                closeTime: h.closeTime || null,
            }));

        const machineRows = info?.id
            ? await machineCount.findAll({
                where: { bussinessInformationId: info.id },
                attributes: ['id', 'total', 'machineId'],
                include: [{ model: machines, attributes: ['id', 'name'], required: false }],
            })
            : [];

        const a = plain(agent);
        return {
            account: {
                id: a.id,
                name: [a.firstName, a.lastName].filter(Boolean).join(' ').trim() || null,
                email: a.email || null,
                phone: a.phoneNum ? `${a.countryCode || ''}${a.phoneNum}` : null,
                registeredAt: a.createdAt,
                verifiedAt: a.verifiedAt || null,
                approvalStatus: a.agentApprovalStatus,
                rejectionReason: a.rejectionReason || null,
            },
            shop: info
                ? {
                    name: info.shopName || null,
                    profileType: info.matchProfileOptions || null,
                    profileOther: info.otherText || null,
                    website: info.website || null,
                    description: info.description || null,
                    collectionMethod: info.collectionMethod || null,
                    deliveryMethod: info.deliveryMethod || null,
                    leadTimeHours: info.leadTimeHours ?? null,
                    maxActiveOrders: info.maxActiveOrders ?? null,
                    payoutConnected: Boolean(info.isConnectAccountConnected),
                }
                : null,
            address: shopAddress
                ? {
                    street: shopAddress.streetAddress || null,
                    district: shopAddress.district || null,
                    province: shopAddress.province || null,
                    postcode: shopAddress.postalcode || null,
                    city: shopAddress.city?.name || null,
                    country: shopAddress.country?.name || null,
                    zone: zoneName,
                    lat: shopAddress.lat || null,
                    lng: shopAddress.lng || null,
                }
                : null,
            services: serviceRows.map(plain).map((s) => ({
                name: s.service?.name || `Service #${s.serviceId}`,
                offered: Boolean(s.status),
                turnaround: s.serviceTimeRequired && s.serviceTimeRequired !== 'N/A' ? s.serviceTimeRequired : null,
            })),
            workingHours: hours,
            hoursSet: hours.some((h) => h.open && h.openTime && h.closeTime),
            machines: machineRows.map(plain).map((m) => ({
                name: m.machine?.name || `Machine #${m.machineId}`,
                // The shop picks a range ("1-2", "3-5", …), so keep it as given.
                count: m.total != null && String(m.total).trim() ? String(m.total).trim() : null,
            })),
            rejectionReasons: AGENT_REJECTION_REASONS,
        };
    }

    async updateAgentApproval(agentId, action, reason, { reasons, note } = {}) {
        const agent = await users.findOne({
            where: {
                id: agentId,
                userTypeId: 4,
                deletedAt: { [Op.is]: null },
            },
        });

        if (!agent) {
            throw new NotFoundError('Agent not found');
        }

        if (action === 'approve') {
            const wasRejected = agent.agentApprovalStatus === 'rejected';
            await users.update(
                {
                    agentApprovalStatus: 'approved',
                    rejectionReason: null,
                },
                { where: { id: agentId } }
            );
            return {
                id: Number(agentId),
                agentApprovalStatus: 'approved',
                restored: wasRejected,
            };
        }

        if (action === 'reject') {
            const parsed = parseRejection(reasons, note, reason);
            const rejectionReason = composeRejection(parsed.reasons, parsed.note);
            await users.update(
                {
                    agentApprovalStatus: 'rejected',
                    rejectionReason,
                },
                { where: { id: agentId } }
            );

            // Tell the shop why, so it can fix it or get in touch.
            let emailQueued = false;
            try {
                const info = await bussinessInformation.findOne({
                    where: { agentId },
                    attributes: ['shopName'],
                    order: [['id', 'ASC']],
                });
                const row = await enqueueEmail('agentRejected', {
                    email: agent.email,
                    userName: agent.firstName || 'there',
                    shopName: info?.shopName || null,
                    reasons: parsed.reasons.filter((r) => r !== OTHER_REASON),
                    note: parsed.note || null,
                });
                emailQueued = Boolean(row);
            } catch (err) {
                console.error('⚠️ Failed to queue agent rejection email:', err.message);
            }

            return {
                id: Number(agentId),
                agentApprovalStatus: 'rejected',
                rejectionReason,
                emailQueued,
            };
        }

        throw new ValidationError('action must be "approve" or "reject"');
    }
}

module.exports = new AgentApprovalService();
module.exports.AGENT_REJECTION_REASONS = AGENT_REJECTION_REASONS;
module.exports.parseRejection = parseRejection;
module.exports.composeRejection = composeRejection;
