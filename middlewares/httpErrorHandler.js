const { StatusCodes, ReasonPhrases } = require('http-status-codes');

/**
 * Custom HTTP Error Class with proper status codes
 */
class HttpError extends Error {
    constructor(message, statusCode = StatusCodes.INTERNAL_SERVER_ERROR, details = null) {
        super(message);
        this.name = 'HttpError';
        this.statusCode = statusCode;
        this.details = details;
        this.isOperational = true;
        
        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * Predefined error types with proper status codes
 */
class ValidationError extends HttpError {
    constructor(message, details = null) {
        super(message, StatusCodes.BAD_REQUEST, details);
        this.name = 'ValidationError';
    }
}

class NotFoundError extends HttpError {
    constructor(message = 'Resource not found', details = null) {
        super(message, StatusCodes.NOT_FOUND, details);
        this.name = 'NotFoundError';
    }
}

class UnauthorizedError extends HttpError {
    constructor(message = 'Unauthorized access', details = null) {
        super(message, StatusCodes.UNAUTHORIZED, details);
        this.name = 'UnauthorizedError';
    }
}

class ForbiddenError extends HttpError {
    constructor(message = 'Access forbidden', details = null) {
        super(message, StatusCodes.FORBIDDEN, details);
        this.name = 'ForbiddenError';
    }
}

class ConflictError extends HttpError {
    constructor(message = 'Resource conflict', details = null) {
        super(message, StatusCodes.CONFLICT, details);
        this.name = 'ConflictError';
    }
}

class UnprocessableEntityError extends HttpError {
    constructor(message = 'Unprocessable entity', details = null) {
        super(message, StatusCodes.UNPROCESSABLE_ENTITY, details);
        this.name = 'UnprocessableEntityError';
    }
}

class TooManyRequestsError extends HttpError {
    constructor(message = 'Too many requests', details = null) {
        super(message, StatusCodes.TOO_MANY_REQUESTS, details);
        this.name = 'TooManyRequestsError';
    }
}

/**
 * Enhanced error handler middleware
 */
const errorHandler = (err, req, res, next) => {
    let error = { ...err };
    error.message = err.message;

    // Log error for debugging
    console.error('Error:', {
        message: err.message,
        statusCode: err.statusCode || StatusCodes.INTERNAL_SERVER_ERROR,
        stack: err.stack,
        url: req.originalUrl,
        method: req.method,
        timestamp: new Date().toISOString()
    });

    // Handle different error types
    if (err.name === 'ValidationError') {
        const message = Object.values(err.errors).map(val => val.message).join(', ');
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
        const message = 'Invalid token';
        error = new UnauthorizedError(message);
    }

    if (err.name === 'TokenExpiredError') {
        const message = 'Token expired';
        error = new UnauthorizedError(message);
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
 * 404 handler for undefined routes
 */
const notFoundHandler = (req, res, next) => {
    const error = new NotFoundError(`Route ${req.originalUrl} not found`);
    next(error);
};

/**
 * Async error wrapper
 */
const asyncHandler = (fn) => {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
};

module.exports = {
    HttpError,
    ValidationError,
    NotFoundError,
    UnauthorizedError,
    ForbiddenError,
    ConflictError,
    UnprocessableEntityError,
    TooManyRequestsError,
    errorHandler,
    notFoundHandler,
    asyncHandler,
    StatusCodes
};
