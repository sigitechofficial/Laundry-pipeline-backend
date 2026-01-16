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
     * Create new cancellation reason(s)
     * @param {Object} reasonData - Reason data containing cancelReason (string) or cancelReasons (array)
     * @returns {Object|Array} Created reason(s) data
     */
    async createReason(reasonData) {
        const { cancelReason, cancelReasons } = reasonData;

        // Support both single reason and array of reasons
        if (!cancelReason && !cancelReasons) {
            throw new ValidationError("Cancel reason(s) is required");
        }

        // Handle array of reasons
        if (cancelReasons && Array.isArray(cancelReasons)) {
            if (cancelReasons.length === 0) {
                throw new ValidationError("Cancel reasons array cannot be empty");
            }

            // Validate all reasons are strings and not empty
            const invalidReasons = cancelReasons.filter(r => !r || typeof r !== 'string' || r.trim() === '');
            if (invalidReasons.length > 0) {
                throw new ValidationError("All cancel reasons must be non-empty strings");
            }

            // Check for duplicates in the input array
            const uniqueReasons = [...new Set(cancelReasons.map(r => r.trim()))];
            
            // Check which reasons already exist in database
            const existingReasons = await reason.findAll({
                where: {
                    cancelReason: {
                        [Op.in]: uniqueReasons
                    }
                }
            });

            const existingReasonTexts = existingReasons.map(r => r.cancelReason);
            const newReasons = uniqueReasons.filter(r => !existingReasonTexts.includes(r));

            if (newReasons.length === 0) {
                throw new ConflictError("All reasons already exist in the database");
            }

            // Bulk create new reasons
            const createdReasons = await reason.bulkCreate(
                newReasons.map(r => ({ cancelReason: r })),
                { returning: true }
            );

            return {
                created: createdReasons,
                skipped: existingReasonTexts,
                message: existingReasonTexts.length > 0 
                    ? `Created ${createdReasons.length} reason(s). Skipped ${existingReasonTexts.length} duplicate(s).`
                    : `Created ${createdReasons.length} reason(s) successfully.`
            };
        }

        // Handle single reason (backward compatibility)
        if (cancelReason) {
            const trimmedReason = cancelReason.trim();
            
            if (!trimmedReason) {
                throw new ValidationError("Cancel reason cannot be empty");
            }

            const existingReason = await reason.findOne({
                where: {
                    cancelReason: trimmedReason
                }
            });

            if (existingReason) {
                throw new ConflictError("Reason already exists");
            }

            const newReason = await reason.create({
                cancelReason: trimmedReason
            });

            return newReason;
        }
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

