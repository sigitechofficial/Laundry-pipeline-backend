const { StatusCodes, ReasonPhrases } = require('http-status-codes');

/**
 * Universal HTTP Error Class with proper status codes
 */
class UniversalHttpError extends Error {
    constructor(message, statusCode = StatusCodes.INTERNAL_SERVER_ERROR, details = null) {
        super(message);
        this.name = 'UniversalHttpError';
        this.statusCode = statusCode;
        this.details = details;
        this.isOperational = true;
        
        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * Universal error types with proper status codes
 */
class ValidationError extends UniversalHttpError {
    constructor(message, details = null) {
        super(message, StatusCodes.BAD_REQUEST, details);
        this.name = 'ValidationError';
    }
}

class NotFoundError extends UniversalHttpError {
    constructor(message = 'Resource not found', details = null) {
        super(message, StatusCodes.NOT_FOUND, details);
        this.name = 'NotFoundError';
    }
}

class UnauthorizedError extends UniversalHttpError {
    constructor(message = 'Unauthorized access', details = null) {
        super(message, StatusCodes.UNAUTHORIZED, details);
        this.name = 'UnauthorizedError';
    }
}

class ForbiddenError extends UniversalHttpError {
    constructor(message = 'Access forbidden', details = null) {
        super(message, StatusCodes.FORBIDDEN, details);
        this.name = 'ForbiddenError';
    }
}

class ConflictError extends UniversalHttpError {
    constructor(message = 'Resource conflict', details = null) {
        super(message, StatusCodes.CONFLICT, details);
        this.name = 'ConflictError';
    }
}

class UnprocessableEntityError extends UniversalHttpError {
    constructor(message = 'Unprocessable entity', details = null) {
        super(message, StatusCodes.UNPROCESSABLE_ENTITY, details);
        this.name = 'UnprocessableEntityError';
    }
}

class TooManyRequestsError extends UniversalHttpError {
    constructor(message = 'Too many requests', details = null) {
        super(message, StatusCodes.TOO_MANY_REQUESTS, details);
        this.name = 'TooManyRequestsError';
    }
}

/**
 * Universal error handler middleware
 */
const universalErrorHandler = (err, req, res, next) => {
    let error = { ...err };
    error.message = err.message;

    // Determine context (admin, customer, driver, etc.)
    const context = req.route?.path?.includes('/admin') ? 'Admin' : 
                   req.route?.path?.includes('/customer') ? 'Customer' :
                   req.route?.path?.includes('/driver') ? 'Driver' :
                   req.route?.path?.includes('/agent') ? 'Agent' : 'General';

    // Log error for debugging with context
    console.error(`${context} Error:`, {
        message: err.message,
        statusCode: err.statusCode || StatusCodes.INTERNAL_SERVER_ERROR,
        stack: err.stack,
        url: req.originalUrl,
        method: req.method,
        timestamp: new Date().toISOString(),
        userId: req.user?.id || 'unknown',
        context: context
    });

    // Handle different error types
    if (err.name === 'ValidationError') {
        const message = err.errors ? Object.values(err.errors).map(val => val.message).join(', ') : err.message;
        error = new ValidationError(message);
    }

    if (err.name === 'CastError') {
        const message = 'Invalid ID format';
        error = new ValidationError(message);
    }

    if (err.code === 11000) {
        const message = 'Duplicate field value entered';
        error = new ConflictError(message);
    }

    if (err.name === 'JsonWebTokenError') {
        const message = context === 'Admin' ? 'Invalid admin token' : 'Invalid token';
        error = new UnauthorizedError(message);
    }

    if (err.name === 'TokenExpiredError') {
        const message = context === 'Admin' ? 'Admin token expired' : 'Token expired';
        error = new UnauthorizedError(message);
    }

    // Handle admin-specific errors
    if (err.name && err.name.startsWith('Admin')) {
        // Convert admin errors to universal errors
        switch (err.name) {
            case 'AdminValidationError':
                error = new ValidationError(err.message);
                break;
            case 'AdminNotFoundError':
                error = new NotFoundError(err.message);
                break;
            case 'AdminUnauthorizedError':
                error = new UnauthorizedError(err.message);
                break;
            case 'AdminForbiddenError':
                error = new ForbiddenError(err.message);
                break;
            case 'AdminConflictError':
                error = new ConflictError(err.message);
                break;
            default:
                error = new UniversalHttpError(err.message, err.statusCode);
        }
    }

    // Determine status code
    const statusCode = error.statusCode || StatusCodes.INTERNAL_SERVER_ERROR;
    const message = error.message || ReasonPhrases.INTERNAL_SERVER_ERROR;

    // Prepare response based on context
    const response = {
        status: statusCode >= 400 ? '0' : '1',
        message: statusCode >= 500 ? 'Internal Server Error' : message,
        statusCode: statusCode,
        data: {},
        error: statusCode >= 500 ? 'Something went wrong' : message,
        timestamp: new Date().toISOString(),
        path: req.originalUrl
    };

    // Add details if available
    if (error.details) {
        response.data = error.details;
    }

    // Add stack trace in development
    if (process.env.NODE_ENV === 'development') {
        response.stack = err.stack;
    }

    res.status(statusCode).json(response);
};

/**
 * Universal 404 handler for undefined routes
 */
const universalNotFoundHandler = (req, res, next) => {
    const context = req.originalUrl.includes('/admin') ? 'Admin' : 
                   req.originalUrl.includes('/customer') ? 'Customer' :
                   req.originalUrl.includes('/driver') ? 'Driver' :
                   req.originalUrl.includes('/agent') ? 'Agent' : 'General';
    
    const error = new NotFoundError(`${context} route ${req.originalUrl} not found`);
    next(error);
};

/**
 * Universal async error wrapper
 */
const universalAsyncHandler = (fn) => {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
};

module.exports = {
    // Error Classes
    UniversalHttpError,
    ValidationError,
    NotFoundError,
    UnauthorizedError,
    ForbiddenError,
    ConflictError,
    UnprocessableEntityError,
    TooManyRequestsError,
    
    // Middleware Functions
    universalErrorHandler,
    universalNotFoundHandler,
    universalAsyncHandler,
    
    // Status Codes
    StatusCodes
};
