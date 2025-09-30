const { preferenceTypes,
    preferenceValues,
    preferencesServiceName,
    servicePreferences,
    serviceWithPreferences,
    bookingPreference
} = require('../../models')
const { NotFoundError } = require('../../middlewares/universalErrorHandler');

class PrefrencesServices {

    /**
     * Edit Preference Type
     * @param {number} preferenceTypeId - Preference Type ID
     * @param {string} name - Preference Type name
     * @returns {Object} Edited preference type data
     */
    async editPreferenceType(preferenceTypeId, name) {
        const editPreferenceType = await preferenceTypes.update(
            { name },
            { where: { id: preferenceTypeId } });
        if (!editPreferenceType) {
            throw new NotFoundError('Preference Type Not Found')
        }
        return editPreferenceType;
    }

    /**
     *  Delete Preference Type
     * @param {number} preferenceTypeId - Preference Type ID
     * @returns {Object} Deleted preference type data
     */
    async deletePreferenceType(preferenceTypeId) {
        const deletePreferenceType = await preferenceTypes.destroy({ where: { id: preferenceTypeId } });
        if (!deletePreferenceType) {
            throw new NotFoundError('Preference Type Not Found')
        }
        return deletePreferenceType;
    }



    /**
     *  Edit Preferences Values
     * @param {number} preferenceValueId - Preference Value ID
     * @param {string} value - Preference Value
     * @returns {Object} Edited preference value data
     */
    async editPreferenceValues(preferenceValueId, value) {
        const editPreferenceValue = await preferenceValues.update({ value }, { where: { id: preferenceValueId } });
        if (!editPreferenceValue) {
            throw new NotFoundError('Preference Value Not Found')
        }
        return editPreferenceValue;
    }

    /**
     *  Delete Preference Values
     * @param {number} preferenceValueId - Preference Value ID
     * @returns {Object} Deleted preference value data
     */
    async deletePreferenceValues(preferenceValueId) {
        const deletePreferenceValue = await preferenceValues.destroy({ where: { id: preferenceValueId } });
        if (!deletePreferenceValue) {
            throw new NotFoundError('Preference Value Not Found')
        }
        return deletePreferenceValue;
    }

    /**
     * Add preference values
     * @param {string|Array} value - Preference value(s) to add
     * @param {number} preferenceTypeId - Preference type ID
     * @returns {Object} Created preference values
     */
    async addPreferenceValues(value, preferenceTypeId) {
        try {
            if (!preferenceTypeId || !value || (Array.isArray(value) && value.length === 0)) {
                throw new ValidationError('Value(s) and preferenceTypeId are required');
            }

            const valuesToInsert = Array.isArray(value) ? value : [value];

            const existingValues = await preferenceValues.findAll({
                where: {
                    value: valuesToInsert,
                    preferenceTypeId: preferenceTypeId,
                    status: true
                }
            });

            const existingValueSet = new Set(existingValues.map(v => v.value));
            const newValues = valuesToInsert.filter(v => !existingValueSet.has(v));

            if (newValues.length === 0) {
                throw new ValidationError('All preference values already exist');
            }

            const bulkData = newValues.map(v => ({
                value: v,
                preferenceTypeId,
                status: true
            }));

            const createdValues = await preferenceValues.bulkCreate(bulkData);
            return { createdValues, count: createdValues.length };
        } catch (error) {
            if (error instanceof ValidationError) {
                throw error;
            }
            throw new Error(`Add preference values service error: ${error.message}`);
        }
    }

    /**
     * Add service with preferences mapping
     * @param {number|Array} serviceId - Service ID(s) to map
     * @param {number} preferenceTypeId - Preference type ID
     * @returns {Object} Created service-preference mappings
     */
    async addServiceWithPreferences(serviceId, preferenceTypeIds) {
            if (!preferenceTypeIds || !serviceId || (Array.isArray(preferenceTypeIds) && preferenceTypeIds.length === 0)) {
                throw new ValidationError('preferenceTypeIds and serviceId are required');
            }

            const preferenceTypeIdArray = Array.isArray(preferenceTypeIds) ? preferenceTypeIds : [preferenceTypeIds];

            const existingMappings = await serviceWithPreferences.findAll({
                where: {
                    preferenceTypeId: preferenceTypeIdArray,
                    serviceId,
                    status: true
                }
            });

            const existingPreferenceTypeIds = new Set(existingMappings.map(m => m.preferenceTypeId));
            const newMappings = preferenceTypeIdArray
                .filter(id => !existingPreferenceTypeIds.has(id))
                .map(id => ({
                    serviceId,
                    preferenceTypeId: id,
                    status: true
                }));

            if (newMappings.length === 0) {
                throw new ValidationError('All Preferences already mapped to this Service');
            }

            const createdMappings = await serviceWithPreferences.bulkCreate(newMappings);
            return { createdMappings, count: createdMappings.length };
    
    }

    /**
     * UnAssign Service From Preferences
     * @param {number} serviceId - Service ID
     * @returns {Object} Unassigned service data
     */
    async unAssignServiceFromPreferences(serviceId) {
        const unAssignService = await serviceWithPreferences.destroy({ where: { serviceId } });
        if (!unAssignService) {
            throw new NotFoundError('Service Not Found')
        }
        return unAssignService;
    }
}

module.exports = new PrefrencesServices();