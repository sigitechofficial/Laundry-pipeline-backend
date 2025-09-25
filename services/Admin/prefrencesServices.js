const{preferenceTypes,
    preferenceValues,
    preferencesServiceName,
    servicePreferences,
    serviceWithPreferences,
    bookingPreference
}=require('../../models')
const { NotFoundError } = require('../../middlewares/universalErrorHandler');

class PrefrencesServices{

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

    
}

module.exports = new PrefrencesServices();