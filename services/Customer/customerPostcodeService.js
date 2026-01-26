require("dotenv").config();
const axios = require('axios');
const { 
    ValidationError, 
    NotFoundError 
} = require('../../middlewares/universalErrorHandler');

/**
 * Customer Postcode Service
 * Handles UK address lookup using getAddress.io API
 */
class CustomerPostcodeService {
    /**
     * Get list of addresses for a given UK postcode using getAddress.io API
     * @param {string} postcode - UK postcode (e.g., "SW1A1AA" or "SW1A 1AA")
     * @returns {Object} - List of addresses with formatted data
     */
    async getAddressesByPostcode(postcode) {
        try {
            // Normalize postcode (remove extra spaces, uppercase, but keep format)
            // UK postcodes can be: SW1A1AA or SW1A 1AA
            const normalizedPostcode = postcode.trim().replace(/\s+/g, '').toUpperCase();
            
            // Also create a version with proper spacing for display
            // Format: [A-Z]{1,2}[0-9]{1,2}[A-Z]?[space][0-9][A-Z]{2}
            const spacedPostcode = normalizedPostcode.replace(/^([A-Z]{1,2}\d{1,2}[A-Z]?)(\d[A-Z]{2})$/, '$1 $2');
            
            if (!normalizedPostcode) {
                throw new ValidationError('Postcode is required');
            }

            // Validate UK postcode format (basic regex)
            const postcodeRegex = /^[A-Z]{1,2}[0-9]{1,2}[A-Z]?[0-9][A-Z]{2}$/;
            if (!postcodeRegex.test(normalizedPostcode)) {
                throw new ValidationError('Invalid UK postcode format');
            }

            // Check if API key is configured
            if (!process.env.GETADDRESS_API_KEY) {
                throw new ValidationError('getAddress.io API key is not configured');
            }

            // Call getAddress.io API (try without space first, as API normalizes it)
            console.log(`🔍 Fetching addresses for postcode: ${normalizedPostcode} (spaced: ${spacedPostcode})`);
            console.log(`🔑 API Key configured: ${process.env.GETADDRESS_API_KEY ? 'Yes (hidden)' : 'NO - MISSING!'}`);
            
            const response = await axios.get(
                `https://api.getaddress.io/find/${normalizedPostcode}`,
                {
                    params: {
                        'api-key': process.env.GETADDRESS_API_KEY,
                        'expand': true
                    },
                    timeout: 10000
                }
            );

            console.log(`✅ API Response Status: ${response.status}`);
            console.log(`📦 Response Data:`, JSON.stringify(response.data, null, 2));

            if (response.data && response.data.addresses) {
                // Format addresses for response
                // getAddress.io returns addresses as arrays of strings
                const formattedAddresses = response.data.addresses.map((address, index) => {
                    // Each address is an array: [line1, line2, line3, locality, town, county]
                    const addressParts = Array.isArray(address) ? address : address.split(',');
                    
                    return {
                        id: index,
                        line1: addressParts[0] || '',
                        line2: addressParts[1] || '',
                        line3: addressParts[2] || '',
                        locality: addressParts[3] || '',
                        town: addressParts[4] || '',
                        county: addressParts[5] || '',
                        postcode: normalizedPostcode,
                        fullAddress: addressParts.filter(part => part && part.trim()).join(', ') + ', ' + normalizedPostcode
                    };
                });

                return {
                    postcode: normalizedPostcode,
                    addressCount: formattedAddresses.length,
                    addresses: formattedAddresses,
                    latitude: response.data.latitude || null,
                    longitude: response.data.longitude || null
                };
            } else {
                throw new NotFoundError('No addresses found for this postcode');
            }
        } catch (error) {
            // Log the full error for debugging
            console.error(`❌ getAddress.io API Error:`, {
                postcode: normalizedPostcode,
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data,
                message: error.message
            });

            if (error.response) {
                // API error responses
                if (error.response.status === 404) {
                    throw new NotFoundError(
                        `Postcode "${postcode}" not found. ` +
                        `Please verify: (1) The postcode exists and is valid, (2) Try format like "SW1A 1AA", ` +
                        `(3) Check if your getAddress.io subscription includes this postcode. ` +
                        `Test with known postcodes: SW1A1AA, M11AE, B11AA`
                    );
                } else if (error.response.status === 401 || error.response.status === 403) {
                    throw new ValidationError(
                        'Invalid or missing API key. Please add GETADDRESS_API_KEY to your .env file. ' +
                        'Get your key from: https://getaddress.io/dashboard'
                    );
                } else if (error.response.status === 429) {
                    throw new ValidationError('API rate limit exceeded. You have used all available lookups for this billing period.');
                } else if (error.response.status === 400) {
                    throw new ValidationError(
                        `Invalid postcode format: "${postcode}". ` +
                        `UK postcodes should be like: SW1A1AA, EC1A1BB, M11AE. ` +
                        `Error: ${error.response.data?.Message || JSON.stringify(error.response.data)}`
                    );
                }
            }
            
            // Re-throw known errors
            if (error instanceof ValidationError || error instanceof NotFoundError) {
                throw error;
            }
            
            // Generic error
            throw new ValidationError(`Failed to fetch addresses: ${error.message}`);
        }
    }

    /**
     * Get full address details by ID (after user selects from list)
     * @param {string} postcode - UK postcode
     * @param {number} addressIndex - Index of the selected address
     * @returns {Object} - Full address details
     */
    async getAddressById(postcode, addressIndex) {
        const result = await this.getAddressesByPostcode(postcode);
        
        const index = parseInt(addressIndex);
        
        if (isNaN(index)) {
            throw new ValidationError('Invalid address index');
        }
        
        if (index >= 0 && index < result.addresses.length) {
            return {
                ...result.addresses[index],
                latitude: result.latitude,
                longitude: result.longitude
            };
        } else {
            throw new NotFoundError('Address not found at specified index');
        }
    }

    /**
     * Validate UK postcode format
     * @param {string} postcode - UK postcode to validate
     * @returns {Object} - Validation result with isValid boolean
     */
    validatePostcodeFormat(postcode) {
        if (!postcode || typeof postcode !== 'string') {
            return {
                isValid: false,
                message: 'Postcode is required'
            };
        }

        const normalizedPostcode = postcode.trim().replace(/\s+/g, '').toUpperCase();
        const postcodeRegex = /^[A-Z]{1,2}[0-9]{1,2}[A-Z]?[0-9][A-Z]{2}$/;
        
        if (!postcodeRegex.test(normalizedPostcode)) {
            return {
                isValid: false,
                message: 'Invalid UK postcode format',
                normalizedPostcode
            };
        }

        return {
            isValid: true,
            message: 'Valid postcode format',
            normalizedPostcode
        };
    }
}

module.exports = new CustomerPostcodeService();

