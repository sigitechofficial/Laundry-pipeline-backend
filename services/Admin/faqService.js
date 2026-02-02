const { FAQ } = require('../../models');
const { Op } = require('sequelize');

const {
    ValidationError,
    NotFoundError,
    ConflictError
} = require('../../middlewares/universalErrorHandler');

class FAQService {
    /**
     * Create new FAQ
     * @param {Object} faqData - FAQ data containing question, icon, answer
     * @returns {Object} Created FAQ data
     */
    async createFAQ(faqData) {
        const { question, icon, answer } = faqData;

        // Validate required fields
        if (!question || !question.trim()) {
            throw new ValidationError("Question is required");
        }

        if (!answer || !answer.trim()) {
            throw new ValidationError("Answer is required");
        }

        // Check if FAQ with same question already exists
        const existingFAQ = await FAQ.findOne({
            where: {
                question: question.trim()
            }
        });

        if (existingFAQ) {
            throw new ConflictError("FAQ with this question already exists");
        }

        // Create new FAQ
        const newFAQ = await FAQ.create({
            question: question.trim(),
            icon: icon || null,
            answer: answer.trim(),
            status: true
        });

        return newFAQ;
    }

    /**
     * Get all FAQs
     * @param {Object} filters - Optional filters (status)
     * @returns {Array} List of all FAQs
     */
    async getAllFAQs(filters = {}) {
        const whereClause = {};

        // Filter by status if provided
        if (filters.status !== undefined) {
            whereClause.status = filters.status;
        }

        const faqs = await FAQ.findAll({
            where: whereClause,
            order: [['createdAt', 'DESC']]
        });

        return faqs;
    }

    /**
     * Get FAQ by ID
     * @param {number} faqId - FAQ ID
     * @returns {Object} FAQ data
     */
    async getFAQById(faqId) {
        if (!faqId) {
            throw new ValidationError("FAQ ID is required");
        }

        const faq = await FAQ.findByPk(faqId);

        if (!faq) {
            throw new NotFoundError("FAQ not found");
        }

        return faq;
    }

    /**
     * Update an existing FAQ
     * @param {number} faqId - FAQ ID
     * @param {Object} faqData - Updated FAQ data
     * @returns {Object} Updated FAQ data
     */
    async updateFAQ(faqId, faqData) {
        const { question, icon, answer, status } = faqData;

        if (!faqId) {
            throw new ValidationError("FAQ ID is required");
        }

        const existingFAQ = await FAQ.findByPk(faqId);

        if (!existingFAQ) {
            throw new NotFoundError("FAQ not found");
        }

        // Check if another FAQ with the same question exists
        if (question) {
            const duplicateFAQ = await FAQ.findOne({
                where: {
                    question: question.trim(),
                    id: {
                        [Op.ne]: faqId
                    }
                }
            });

            if (duplicateFAQ) {
                throw new ConflictError("FAQ with this question already exists");
            }
        }

        // Update FAQ
        const updatedFAQ = await existingFAQ.update({
            question: question ? question.trim() : existingFAQ.question,
            icon: icon !== undefined ? icon : existingFAQ.icon,
            answer: answer ? answer.trim() : existingFAQ.answer,
            status: status !== undefined ? status : existingFAQ.status
        });

        return updatedFAQ;
    }

    /**
     * Delete a FAQ (soft delete)
     * @param {number} faqId - FAQ ID
     * @returns {Object} Deletion result
     */
    async deleteFAQ(faqId) {
        if (!faqId) {
            throw new ValidationError("FAQ ID is required");
        }

        const existingFAQ = await FAQ.findByPk(faqId);

        if (!existingFAQ) {
            throw new NotFoundError("FAQ not found");
        }

        // Soft delete (paranoid mode)
        await existingFAQ.destroy();

        return { message: "FAQ deleted successfully" };
    }

    /**
     * Toggle FAQ status
     * @param {number} faqId - FAQ ID
     * @returns {Object} Updated FAQ
     */
    async toggleFAQStatus(faqId) {
        if (!faqId) {
            throw new ValidationError("FAQ ID is required");
        }

        const existingFAQ = await FAQ.findByPk(faqId);

        if (!existingFAQ) {
            throw new NotFoundError("FAQ not found");
        }

        const updatedFAQ = await existingFAQ.update({
            status: !existingFAQ.status
        });

        return updatedFAQ;
    }
}

module.exports = new FAQService();

