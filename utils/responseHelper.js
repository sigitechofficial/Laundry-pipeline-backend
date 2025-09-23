const { StatusCodes } = require('http-status-codes');

/**
 * Standardized API Response Helper
 */
class ResponseHelper {
    /**
     * Success response
     * @param {Object} res - Express response object
     * @param {string} message - Success message
     * @param {*} data - Response data
     * @param {number} statusCode - HTTP status code (default: 200)
     * @param {Object} meta - Additional metadata (pagination, etc.)
     */
    static success(res, message, data = {}, statusCode = StatusCodes.OK, meta = {}) {
        const response = {
            status: '1',
            message: message,
            data: data,
            error: '',
            statusCode: statusCode,
            timestamp: new Date().toISOString()
        };

        // Add metadata if provided
        if (Object.keys(meta).length > 0) {
            response.meta = meta;
        }

        return res.status(statusCode).json(response);
    }

    /**
     * Error response
     * @param {Object} res - Express response object
     * @param {string} message - Error message
     * @param {*} error - Error details
     * @param {number} statusCode - HTTP status code (default: 500)
     * @param {Object} details - Additional error details
     */
    static error(res, message, error = '', statusCode = StatusCodes.INTERNAL_SERVER_ERROR, details = {}) {
        const response = {
            status: '0',
            message: message,
            data: {},
            error: error,
            statusCode: statusCode,
            timestamp: new Date().toISOString()
        };

        // Add details if provided
        if (Object.keys(details).length > 0) {
            response.details = details;
        }

        return res.status(statusCode).json(response);
    }

    /**
     * Validation error response
     * @param {Object} res - Express response object
     * @param {string} message - Validation error message
     * @param {Object} validationErrors - Validation error details
     */
    static validationError(res, message, validationErrors = {}) {
        return this.error(res, message, 'Validation failed', StatusCodes.BAD_REQUEST, validationErrors);
    }

    /**
     * Not found response
     * @param {Object} res - Express response object
     * @param {string} message - Not found message
     */
    static notFound(res, message = 'Resource not found') {
        return this.error(res, message, 'Resource not found', StatusCodes.NOT_FOUND);
    }

    /**
     * Unauthorized response
     * @param {Object} res - Express response object
     * @param {string} message - Unauthorized message
     */
    static unauthorized(res, message = 'Unauthorized access') {
        return this.error(res, message, 'Unauthorized', StatusCodes.UNAUTHORIZED);
    }

    /**
     * Forbidden response
     * @param {Object} res - Express response object
     * @param {string} message - Forbidden message
     */
    static forbidden(res, message = 'Access forbidden') {
        return this.error(res, message, 'Forbidden', StatusCodes.FORBIDDEN);
    }

    /**
     * Conflict response
     * @param {Object} res - Express response object
     * @param {string} message - Conflict message
     */
    static conflict(res, message = 'Resource conflict') {
        return this.error(res, message, 'Conflict', StatusCodes.CONFLICT);
    }

    /**
     * Created response
     * @param {Object} res - Express response object
     * @param {string} message - Success message
     * @param {*} data - Created resource data
     */
    static created(res, message, data = {}) {
        return this.success(res, message, data, StatusCodes.CREATED);
    }

    /**
     * No content response
     * @param {Object} res - Express response object
     */
    static noContent(res) {
        return res.status(StatusCodes.NO_CONTENT).send();
    }

    /**
     * Paginated response
     * @param {Object} res - Express response object
     * @param {string} message - Success message
     * @param {Array} data - Response data
     * @param {Object} pagination - Pagination info
     */
    static paginated(res, message, data = [], pagination = {}) {
        return this.success(res, message, data, StatusCodes.OK, { pagination });
    }
}

module.exports = ResponseHelper;
