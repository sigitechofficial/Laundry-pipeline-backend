const { StatusCodes } = require('http-status-codes');

/**
 * Universal API Response Helper
 * Combines functionality from both responseHelper and adminResponseHelper
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
            statusCode: statusCode,
            data: data,
            error: '',
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
            statusCode: statusCode,
            data: {},
            error: error,
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

    // ==================== ADMIN-SPECIFIC METHODS ====================

    /**
     * Admin dashboard response
     * @param {Object} res - Express response object
     * @param {string} message - Success message
     * @param {Object} dashboardData - Dashboard data
     */
    static dashboard(res, message, dashboardData = {}) {
        return this.success(res, message, dashboardData, StatusCodes.OK, { 
            type: 'dashboard',
            generatedAt: new Date().toISOString()
        });
    }

    /**
     * Admin statistics response
     * @param {Object} res - Express response object
     * @param {string} message - Success message
     * @param {Object} statistics - Statistics data
     */
    static statistics(res, message, statistics = {}) {
        return this.success(res, message, statistics, StatusCodes.OK, { 
            type: 'statistics',
            generatedAt: new Date().toISOString()
        });
    }

    /**
     * Admin list response with filters
     * @param {Object} res - Express response object
     * @param {string} message - Success message
     * @param {Array} data - List data
     * @param {Object} filters - Applied filters
     * @param {Object} pagination - Pagination info
     */
    static list(res, message, data = [], filters = {}, pagination = {}) {
        return this.success(res, message, data, StatusCodes.OK, { 
            filters,
            pagination,
            type: 'list',
            generatedAt: new Date().toISOString()
        });
    }

    // ==================== LEGACY COMPATIBILITY ====================

    /**
     * Legacy response format for backward compatibility
     * @param {Object} res - Express response object
     * @param {string} status - Status code ('1' for success, '0' for error)
     * @param {string} message - Response message
     * @param {*} data - Response data
     * @param {string} error - Error message (if any)
     */
    static legacy(res, status, message, data = {}, error = '') {
        const response = {
            status: status,
            message: message,
            data: data,
            error: error,
            timestamp: new Date().toISOString()
        };

        const statusCode = status === '1' ? StatusCodes.OK : StatusCodes.INTERNAL_SERVER_ERROR;
        return res.status(statusCode).json(response);
    }

    // ==================== UTILITY METHODS ====================

    /**
     * Custom response with full control
     * @param {Object} res - Express response object
     * @param {Object} customResponse - Custom response object
     * @param {number} statusCode - HTTP status code
     */
    static custom(res, customResponse, statusCode = StatusCodes.OK) {
        const response = {
            ...customResponse,
            timestamp: new Date().toISOString()
        };

        return res.status(statusCode).json(response);
    }

    /**
     * File download response
     * @param {Object} res - Express response object
     * @param {Buffer} fileBuffer - File buffer
     * @param {string} filename - File name
     * @param {string} mimeType - MIME type
     */
    static download(res, fileBuffer, filename, mimeType = 'application/octet-stream') {
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send(fileBuffer);
    }

    /**
     * Redirect response
     * @param {Object} res - Express response object
     * @param {string} url - Redirect URL
     * @param {number} statusCode - HTTP status code (default: 302)
     */
    static redirect(res, url, statusCode = StatusCodes.FOUND) {
        return res.redirect(statusCode, url);
    }
}

module.exports = ResponseHelper;
