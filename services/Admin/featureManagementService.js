const { features, classifiedAs } = require('../../models');
const { NotFoundError, ValidationError } = require('../../middlewares/universalErrorHandler');

class FeatureManagementService {
    /**
     * Add a new feature
     * @param {Object} featureData - Feature data containing title, status, featureOf, and key
     * @returns {Object} Created feature data
     */
    async addFeature(featureData) {
        try {
            // Check if feature already exists
            const featureExists = await features.findOne({
                where: { title: featureData.title, featureOf: featureData.featureOf }
            });
            
            if (featureExists) {
                throw new ValidationError('Feature with this title already exists for this feature type');
            }

            const featureCreate = await features.create(featureData);
            
            return featureCreate;
        } catch (error) {
            if (error instanceof ValidationError) {
                throw error;
            }
            throw new Error(`Add feature error: ${error.message}`);
        }
    }

    /**
     * Get all features
     * @returns {Array} List of all features
     */
    async getFeatures() {
        try {
            const getFeatures = await features.findAll({
                order: [['createdAt', 'DESC']]
            });
            return getFeatures;
        } catch (error) {
            throw new Error(`Get features error: ${error.message}`);
        }
    }

    /**
     * Update feature
     * @param {number} featureId - Feature ID
     * @param {Object} updateData - Feature update data
     * @returns {Object} Updated feature data
     */
    async updateFeature(featureId, updateData) {
        try {
            const { title, status, featureOf, key } = updateData;
            
            const featureExists = await features.findOne({ where: { id: featureId } });
            if (!featureExists) {
                throw new NotFoundError('Feature not found');
            }

            const updatedFeature = await features.update(
                { title, status, featureOf, key },
                { where: { id: featureId } }
            );

            if (!updatedFeature[0]) {
                throw new Error('Failed to update feature');
            }

            const updatedFeatureData = await features.findOne({ where: { id: featureId } });
            return updatedFeatureData;
        } catch (error) {
            if (error instanceof NotFoundError) {
                throw error;
            }
            throw new Error(`Update feature error: ${error.message}`);
        }
    }

    /**
     * Delete feature
     * @param {number} featureId - Feature ID
     * @returns {Object} Deleted feature data
     */
    async deleteFeature(featureId) {
        try {
            const featureToDelete = await features.destroy({ where: { id: featureId } });
            
            if (!featureToDelete) {
                throw new NotFoundError('Feature not found');
            }
            
            return { message: 'Feature deleted successfully' };
        } catch (error) {
            if (error instanceof NotFoundError) {
                throw error;
            }
            throw new Error(`Delete feature error: ${error.message}`);
        }
    }

    /**
     * Add classified as
     * @param {Object} classifiedData - Classified data containing name
     * @returns {Object} Created classified data
     */
    async addClassifiedAs(classifiedData) {
        try {
            const classifiedCreate = await classifiedAs.create(classifiedData);
            return classifiedCreate;
        } catch (error) {
            throw new Error(`Add classified as error: ${error.message}`);
        }
    }

    /**
     * Get all classified as
     * @returns {Array} List of all classified as
     */
    async getClassifiedAs() {
        try {
            const getClassifiedAs = await classifiedAs.findAll({
                order: [['createdAt', 'DESC']]
            });
            return getClassifiedAs;
        } catch (error) {
            throw new Error(`Get classified as error: ${error.message}`);
        }
    }

    /**
     * Update classified as
     * @param {number} classifiedId - Classified ID
     * @param {Object} updateData - Classified update data
     * @returns {Object} Updated classified data
     */
    async updateClassifiedAs(classifiedId, updateData) {
        try {
            const { name } = updateData;
            
            const classifiedExists = await classifiedAs.findOne({ where: { id: classifiedId } });
            if (!classifiedExists) {
                throw new NotFoundError('Classified as not found');
            }

            const updatedClassified = await classifiedAs.update(
                { name },
                { where: { id: classifiedId } }
            );

            if (!updatedClassified[0]) {
                throw new Error('Failed to update classified as');
            }

            const updatedClassifiedData = await classifiedAs.findOne({ where: { id: classifiedId } });
            return updatedClassifiedData;
        } catch (error) {
            if (error instanceof NotFoundError) {
                throw error;
            }
            throw new Error(`Update classified as error: ${error.message}`);
        }
    }

    /**
     * Delete classified as
     * @param {number} classifiedId - Classified ID
     * @returns {Object} Deleted classified data
     */
    async deleteClassifiedAs(classifiedId) {
        try {
            const classifiedToDelete = await classifiedAs.destroy({ where: { id: classifiedId } });
            
            if (!classifiedToDelete) {
                throw new NotFoundError('Classified as not found');
            }
            
            return { message: 'Classified as deleted successfully' };
        } catch (error) {
            if (error instanceof NotFoundError) {
                throw error;
            }
            throw new Error(`Delete classified as error: ${error.message}`);
        }
    }
}

module.exports = new FeatureManagementService();
