/**
 * HTTP API compatibility: routes are unversioned (no /v1 prefix).
 * Do not introduce a breaking /v2 mount. Additive changes stay on existing paths.
 */
const { StatusCodes, ReasonPhrases } = require('http-status-codes');
const CustomException = require('./customError');

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

    // Check if error is already a UniversalHttpError (or its subclass)
    if (err instanceof UniversalHttpError) {
        const statusCode = err.statusCode;
        const message = err.message;
        const hasErrorDetails = err.details && Object.keys(err.details).length > 0;

        const response = {
            status: '0',
            message: message,
            statusCode: statusCode,
            data: hasErrorDetails ? err.details : {},
            error: err.errorCode || message,
            timestamp: new Date().toISOString(),
            path: req.originalUrl
        };

        if (process.env.NODE_ENV === 'development') {
            response.stack = err.stack;
        }

        return res.status(statusCode).json(response);
    }

    // Handle CustomException from old controllers
    if (err instanceof CustomException || err.constructor?.name === 'CustomException') {
        const message = err.message;
        const body = err.body || '';

        const response = {
            status: '0',
            message: message,
            statusCode: StatusCodes.BAD_REQUEST,
            data: body ? { details: body } : {},
            error: message,
            timestamp: new Date().toISOString(),
            path: req.originalUrl
        };

        if (process.env.NODE_ENV === 'development') {
            response.stack = err.stack;
        }

        return res.status(StatusCodes.BAD_REQUEST).json(response);
    }

    // Handle other error types
    let error = err;

    if (err.name === 'ValidationError' && err.errors) {
        const message = Object.values(err.errors).map(val => val.message).join(', ');
        error = new ValidationError(message);
    }

    if (err.name === 'CastError') {
        error = new ValidationError('Invalid ID format');
    }

    if (err.code === 11000) {
        error = new ConflictError('Duplicate field value entered');
    }

    if (err.name === 'JsonWebTokenError') {
        error = new UnauthorizedError(context === 'Admin' ? 'Invalid admin token' : 'Invalid token');
    }

    if (err.name === 'TokenExpiredError') {
        error = new UnauthorizedError(context === 'Admin' ? 'Admin token expired' : 'Token expired');
    }

    if (err.name === 'MulterError' || err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        const multerMessage =
            err.code === 'LIMIT_FILE_SIZE'
                ? 'File must be 5MB or smaller'
                : err.code === 'LIMIT_UNEXPECTED_FILE'
                    ? `Unexpected file field "${err.field}". Use the documented field name.`
                    : err.message || 'Invalid file upload';
        error = new ValidationError(multerMessage);
    }

    // Handle admin-specific errors
    if (err.name && err.name.startsWith('Admin')) {
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
    const isServerError = statusCode >= 500;

    // Prepare response
    const hasErrorDetails = error.details && Object.keys(error.details).length > 0;
    const response = {
        status: '0',
        message: isServerError ? 'Internal Server Error' : message,
        statusCode: statusCode,
        data: hasErrorDetails ? error.details : {},
        error: isServerError ? 'Something went wrong' : message,
        timestamp: new Date().toISOString(),
        path: req.originalUrl
    };

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
