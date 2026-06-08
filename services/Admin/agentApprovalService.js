const { users, addressDb, bussinessInformation } = require('../../models');
const { Op } = require('sequelize');
const { NotFoundError, ValidationError } = require('../../middlewares/universalErrorHandler');

class AgentApprovalService {
    _mapAgentRow(row) {
        const plain = row.get({ plain: true });
        const shop = Array.isArray(plain.agentInfo)
            ? plain.agentInfo[0]
            : plain.agentInfo;
        return {
            id: plain.id,
            firstName: plain.firstName,
            lastName: plain.lastName,
            email: plain.email,
            phoneNum: plain.phoneNum,
            countryCode: plain.countryCode,
            createdAt: plain.createdAt,
            agentApprovalStatus: plain.agentApprovalStatus,
            rejectionReason: plain.rejectionReason || null,
            shopName: shop?.shopName || null,
            matchProfileOptions: shop?.matchProfileOptions || null,
            address: plain.addressDb || null,
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

    async updateAgentApproval(agentId, action, reason) {
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
            const trimmedReason = reason ? String(reason).trim().slice(0, 500) : null;
            await users.update(
                {
                    agentApprovalStatus: 'rejected',
                    rejectionReason: trimmedReason,
                },
                { where: { id: agentId } }
            );
            return {
                id: Number(agentId),
                agentApprovalStatus: 'rejected',
                rejectionReason: trimmedReason,
            };
        }

        throw new ValidationError('action must be "approve" or "reject"');
    }
}

module.exports = new AgentApprovalService();
