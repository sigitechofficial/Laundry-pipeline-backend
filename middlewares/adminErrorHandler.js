const { StatusCodes, ReasonPhrases } = require('http-status-codes');

/**
 * Admin-specific HTTP Error Classes with proper status codes
 */
class AdminHttpError extends Error {
    constructor(message, statusCode = StatusCodes.INTERNAL_SERVER_ERROR, details = null) {
        super(message);
        this.name = 'AdminHttpError';
        this.statusCode = statusCode;
        this.details = details;
        this.isOperational = true;
        
        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * Admin-specific error types
 */
class AdminValidationError extends AdminHttpError {
    constructor(message, details = null) {
        super(message, StatusCodes.BAD_REQUEST, details);
        this.name = 'AdminValidationError';
    }
}

class AdminNotFoundError extends AdminHttpError {
    constructor(message = 'Resource not found', details = null) {
        super(message, StatusCodes.NOT_FOUND, details);
        this.name = 'AdminNotFoundError';
    }
}

class AdminUnauthorizedError extends AdminHttpError {
    constructor(message = 'Unauthorized access', details = null) {
        super(message, StatusCodes.UNAUTHORIZED, details);
        this.name = 'AdminUnauthorizedError';
    }
}

class AdminForbiddenError extends AdminHttpError {
    constructor(message = 'Access forbidden', details = null) {
        super(message, StatusCodes.FORBIDDEN, details);
        this.name = 'AdminForbiddenError';
    }
}

class AdminConflictError extends AdminHttpError {
    constructor(message = 'Resource conflict', details = null) {
        super(message, StatusCodes.CONFLICT, details);
        this.name = 'AdminConflictError';
    }
}

class AdminUnprocessableEntityError extends AdminHttpError {
    constructor(message = 'Unprocessable entity', details = null) {
        super(message, StatusCodes.UNPROCESSABLE_ENTITY, details);
        this.name = 'AdminUnprocessableEntityError';
    }
}

/**
 * Admin-specific error handler middleware
 */
const adminErrorHandler = (err, req, res, next) => {
    let error = { ...err };
    error.message = err.message;

    // Log error for debugging
    console.error('Admin Error:', {
        message: err.message,
        statusCode: err.statusCode || StatusCodes.INTERNAL_SERVER_ERROR,
        stack: err.stack,
        url: req.originalUrl,
        method: req.method,
        timestamp: new Date().toISOString(),
        adminId: req.user?.id || 'unknown'
    });

    // Handle different error types
    if (err.name === 'ValidationError') {
        const message = Object.values(err.errors).map(val => val.message).join(', ');
        error = new AdminValidationError(message);
    }

    if (err.name === 'CastError') {
        const message = 'Invalid ID format';
        error = new AdminValidationError(message);
    }

    if (err.code === 11000) {
        const message = 'Duplicate field value entered';
        error = new AdminConflictError(message);
    }

    if (err.name === 'JsonWebTokenError') {
        const message = 'Invalid admin token';
        error = new AdminUnauthorizedError(message);
    }

    if (err.name === 'TokenExpiredError') {
        const message = 'Admin token expired';
        error = new AdminUnauthorizedError(message);
    }

    // Determine status code
    const statusCode = error.statusCode || StatusCodes.INTERNAL_SERVER_ERROR;
    const message = error.message || ReasonPhrases.INTERNAL_SERVER_ERROR;

    // Prepare response
    const response = {
        status: statusCode >= 400 ? '0' : '1',
        message: statusCode >= 500 ? 'Internal Server Error' : message,
        data: {},
        error: statusCode >= 500 ? 'Something went wrong' : message,
        statusCode: statusCode,
        timestamp: new Date().toISOString(),
        path: req.originalUrl
    };

    // Add details if available
    if (error.details) {
        response.details = error.details;
    }

    // Add stack trace in development
    if (process.env.NODE_ENV === 'development') {
        response.stack = err.stack;
    }

    res.status(statusCode).json(response);
};

/**
 * Admin 404 handler for undefined routes
 */
const adminNotFoundHandler = (req, res, next) => {
    const error = new AdminNotFoundError(`Admin route ${req.originalUrl} not found`);
    next(error);
};

/**
 * Admin async error wrapper
 */
const adminAsyncHandler = (fn) => {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
};

module.exports = {
    AdminHttpError,
    AdminValidationError,
    AdminNotFoundError,
    AdminUnauthorizedError,
    AdminForbiddenError,
    AdminConflictError,
    AdminUnprocessableEntityError,
    adminErrorHandler,
    adminNotFoundHandler,
    adminAsyncHandler,
    StatusCodes
};
