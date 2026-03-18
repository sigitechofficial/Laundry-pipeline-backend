const SENSITIVE_FIELDS = new Set([
    'password',
    'confirmPassword',
    'oldPassword',
    'newPassword',
    'token',
    'accessToken',
    'refreshToken',
    'authorization',
    'apiKey',
    'secret',
    'setupIntentId',
    'paymentMethodId',
    'paymentIntentId'
]);

function maskSensitiveValues(value) {
    if (Array.isArray(value)) {
        return value.map(maskSensitiveValues);
    }

    if (!value || typeof value !== 'object') {
        return value;
    }

    const masked = {};
    Object.keys(value).forEach((key) => {
        if (SENSITIVE_FIELDS.has(key)) {
            masked[key] = '***';
            return;
        }

        masked[key] = maskSensitiveValues(value[key]);
    });

    return masked;
}

function requestBodyLogger(req, res, next) {
    const origin = req.headers.origin || 'none';
    const body = req.body && typeof req.body === 'object' ? maskSensitiveValues(req.body) : req.body;
    const hasBody = body && (typeof body !== 'object' || Object.keys(body).length > 0);

    console.log(`${req.method} ${req.path} - Origin: ${origin}`);
    console.log('req.body:', hasBody ? body : {});

    next();
}

module.exports = requestBodyLogger;
