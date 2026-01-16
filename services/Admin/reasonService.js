const { reason } = require('../../models');
const { Op } = require('sequelize');

const {
    ValidationError,
    NotFoundError,
    UnauthorizedError,
    ConflictError
} = require('../../middlewares/universalErrorHandler');

class ReasonService {
    /**
     * Create a new cancellation reason
     * @param {Object} reasonData - Reason data containing cancelReason
     * @returns {Object} Created reason data
     */
    async createReason(reasonData) {
        const { cancelReason } = reasonData;

        if (!cancelReason) {
            throw new ValidationError("Cancel reason is required");
        }

        const existingReason = await reason.findOne({
            where: {
                cancelReason: cancelReason
            }
        });

        if (existingReason) {
            throw new ConflictError("Reason already exists");
        }

        const newReason = await reason.create({
            cancelReason
        });

        return newReason;
    }

    /**
     * Get all cancellation reasons
     * @returns {Array} List of all reasons
     */
    async getAllReasons() {
        const reasons = await reason.findAll({
            order: [['createdAt', 'DESC']]
        });

        return reasons;
    }

    /**
     * Update an existing cancellation reason
     * @param {number} reasonId - Reason ID
     * @param {Object} reasonData - Updated reason data
     * @returns {Object} Updated reason data
     */
    async updateReason(reasonId, reasonData) {
        const { cancelReason } = reasonData;

        if (!reasonId) {
            throw new ValidationError("Reason ID is required");
        }

        const existingReason = await reason.findByPk(reasonId);

        if (!existingReason) {
            throw new NotFoundError("Reason not found");
        }

        // Check if another reason with the same name exists
        if (cancelReason) {
            const duplicateReason = await reason.findOne({
                where: {
                    cancelReason: cancelReason,
                    id: {
                        [Op.ne]: reasonId
                    }
                }
            });

            if (duplicateReason) {
                throw new ConflictError("Reason with this name already exists");
            }
        }

        const updatedReason = await existingReason.update({
            cancelReason: cancelReason || existingReason.cancelReason
        });

        return updatedReason;
    }

    /**
     * Delete a cancellation reason
     * @param {number} reasonId - Reason ID
     * @returns {Object} Deletion result
     */
    async deleteReason(reasonId) {
        if (!reasonId) {
            throw new ValidationError("Reason ID is required");
        }

        const existingReason = await reason.findByPk(reasonId);

        if (!existingReason) {
            throw new NotFoundError("Reason not found");
        }

        await existingReason.destroy();

        return { message: "Reason deleted successfully" };
    }

    /**
     * Get reason by ID
     * @param {number} reasonId - Reason ID
     * @returns {Object} Reason data
     */
    async getReasonById(reasonId) {
        if (!reasonId) {
            throw new ValidationError("Reason ID is required");
        }

        const existingReason = await reason.findByPk(reasonId);

        if (!existingReason) {
            throw new NotFoundError("Reason not found");
        }

        return existingReason;
    }
}

module.exports = new ReasonService();

