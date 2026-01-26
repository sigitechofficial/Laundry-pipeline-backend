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
        // Declare variables outside try block so they're accessible in catch
        let normalizedPostcode = '';
        let spacedPostcode = '';
        
        try {
            // Normalize postcode (remove extra spaces, uppercase, but keep format)
            // UK postcodes can be: SW1A1AA or SW1A 1AA
            normalizedPostcode = postcode.trim().replace(/\s+/g, '').toUpperCase();
            
            // Also create a version with proper spacing for display
            // Format: [A-Z]{1,2}[0-9]{1,2}[A-Z]?[space][0-9][A-Z]{2}
            spacedPostcode = normalizedPostcode.replace(/^([A-Z]{1,2}\d{1,2}[A-Z]?)(\d[A-Z]{2})$/, '$1 $2');
            
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

            // Call getAddress.io API using autocomplete endpoint (works with free/basic plans)
            // Note: Using /autocomplete instead of /find as it's available on more subscription tiers
            const apiUrl = `https://api.getaddress.io/autocomplete/${normalizedPostcode}`;
            console.log(`🔍 Fetching addresses for postcode: ${normalizedPostcode} (spaced: ${spacedPostcode})`);
            console.log(`🔑 API Key configured: ${process.env.GETADDRESS_API_KEY ? 'Yes (first 8 chars: ' + process.env.GETADDRESS_API_KEY.substring(0, 8) + '...)' : 'NO - MISSING!'}`);
            console.log(`🌐 Full API URL: ${apiUrl}?all=true`);
            
            const response = await axios.get(apiUrl, {
                params: {
                    'api-key': process.env.GETADDRESS_API_KEY,
                    'all': true  // Get all addresses for this postcode
                },
                timeout: 10000,
                validateStatus: function (status) {
                    // Don't throw on any status, we'll handle it
                    return true;
                }
            });

            console.log(`📊 API Response Status: ${response.status}`);
            console.log(`📦 Response Data:`, JSON.stringify(response.data, null, 2));
            console.log(`📋 Response Headers:`, JSON.stringify(response.headers, null, 2));

            // Handle error responses
            if (response.status === 404) {
                throw new NotFoundError(
                    `Postcode "${postcode}" not found. ` +
                    `API Response: ${JSON.stringify(response.data)}. ` +
                    `Please verify: (1) The postcode exists and is valid, (2) Your API key has available lookups, ` +
                    `(3) Your subscription includes this postcode. Test with: SW1A1AA, M11AE, B11AA`
                );
            } else if (response.status === 401 || response.status === 403) {
                throw new ValidationError(
                    `Invalid or missing API key. Status: ${response.status}. ` +
                    `Response: ${JSON.stringify(response.data)}. ` +
                    `Please check GETADDRESS_API_KEY in your .env file. Get your key from: https://getaddress.io/dashboard`
                );
            } else if (response.status === 429) {
                throw new ValidationError(
                    `API rate limit exceeded. Status: ${response.status}. ` +
                    `Response: ${JSON.stringify(response.data)}. ` +
                    `You have used all available lookups for this billing period.`
                );
            } else if (response.status === 400) {
                throw new ValidationError(
                    `Invalid postcode format: "${postcode}". Status: ${response.status}. ` +
                    `API Response: ${JSON.stringify(response.data)}`
                );
            } else if (response.status !== 200) {
                throw new ValidationError(
                    `Unexpected API response. Status: ${response.status}. ` +
                    `Response: ${JSON.stringify(response.data)}`
                );
            }

            if (response.data && response.data.suggestions && response.data.suggestions.length > 0) {
                // Format addresses for response
                // Autocomplete endpoint returns suggestions array with address, url, and id
                const formattedAddresses = response.data.suggestions.map((suggestion, index) => {
                    // Each suggestion has: { address, url, id }
                    // Address format: "Street, Locality, Town, County, Postcode"
                    const addressParts = suggestion.address.split(',').map(part => part.trim());
                    
                    // Parse address parts (typically: line1, line2, town, county, postcode)
                    const line1 = addressParts[0] || '';
                    const line2 = addressParts[1] || '';
                    const town = addressParts[2] || '';
                    const county = addressParts[3] || '';
                    
                    return {
                        id: index,
                        suggestionId: suggestion.id,  // getAddress.io's unique ID
                        line1: line1,
                        line2: line2,
                        line3: '',
                        locality: line2,
                        town: town,
                        county: county,
                        postcode: normalizedPostcode,
                        fullAddress: suggestion.address
                    };
                });

                return {
                    postcode: normalizedPostcode,
                    addressCount: formattedAddresses.length,
                    addresses: formattedAddresses,
                    latitude: null,  // Autocomplete endpoint doesn't return coordinates
                    longitude: null
                };
            } else {
                throw new NotFoundError('No addresses found for this postcode');
            }
        } catch (error) {
            // Log the full error for debugging
            console.error(`❌ getAddress.io API Error:`, {
                postcode: normalizedPostcode || postcode,
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data,
                message: error.message,
                code: error.code
            });
            
            // Re-throw known errors
            if (error instanceof ValidationError || error instanceof NotFoundError) {
                throw error;
            }
            
            // Network/timeout errors
            if (error.code === 'ECONNABORTED') {
                throw new ValidationError('Request timeout. Please try again.');
            }
            
            if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
                throw new ValidationError('Cannot connect to getAddress.io API. Please check your internet connection.');
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

