'use strict';

/**
 * The shop address fields an agent app sends (POST /agent/agentAddressAdd,
 * PATCH /agent/agentAddressEdit), checked and tidied before they are stored.
 *
 * Field meanings (addressDb), as the apps and the admin portal use them:
 *   streetAddress  building and street (UK: "Royal Mail, Farringdon Road")
 *   district       the post town / city (UK: "London")
 *   province       county / region, optional (UK: "Greater London"; often empty)
 *   postalcode     the postcode; a UK one is stored uppercase with one space
 *                  ("EC1A 1BB"), whatever spacing or case the app sent.
 */

const { ValidationError } = require('../middlewares/universalErrorHandler');
const { normalizeCountryIso } = require('./postalCodeValidation');

/** A full UK postcode, spaces removed (outward code + inward code). */
const UK_FULL_COMPACT = /^(GIR0AA|[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2})$/;

function text(value) {
    return value === undefined || value === null ? '' : String(value).trim().replace(/\s+/g, ' ');
}

/** "ec1a1bb" / "EC1A  1BB" → "EC1A 1BB"; anything that is not a full UK postcode → null. */
function formatUkPostcode(value) {
    const compact = text(value).toUpperCase().replace(/\s+/g, '');
    if (!UK_FULL_COMPACT.test(compact)) return null;
    return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

/**
 * @param {object} body the request body
 * @param {*} country the shop zone's country (row or ISO code), for postcode rules
 * @returns {{streetAddress: string, district: string|null, province: string|null, postalcode: string}}
 */
function shopAddressFields(body, country) {
    const streetAddress = text(body.streetAddress);
    const district = text(body.district);
    const province = text(body.province);
    const postcode = text(body.postalcode);

    if (!streetAddress) throw new ValidationError('Enter the building and street');
    if (!postcode) throw new ValidationError('Enter the postcode');

    let postalcode = postcode.toUpperCase();
    if (normalizeCountryIso(country) === 'GB') {
        postalcode = formatUkPostcode(postcode);
        if (!postalcode) throw new ValidationError('Enter a full UK postcode, like EC1A 1BB');
    }

    return {
        streetAddress,
        district: district || null,
        province: province || null,
        postalcode,
    };
}

module.exports = { shopAddressFields, formatUkPostcode };
