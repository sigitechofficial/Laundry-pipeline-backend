# HTTP Status Codes Guide

This document explains the proper HTTP status codes and error handling in our laundry backend application.

## 📚 **Libraries Used**

### 1. **http-status-codes**
```bash
npm install http-status-codes
```

### 2. **Usage**
```javascript
const { StatusCodes, ReasonPhrases } = require('http-status-codes');
```

## 🎯 **Status Code Categories**

### **2xx Success Codes**
- **200 OK** - Request successful
- **201 Created** - Resource created successfully
- **204 No Content** - Request successful, no content returned

### **4xx Client Error Codes**
- **400 Bad Request** - Invalid request data
- **401 Unauthorized** - Authentication required
- **403 Forbidden** - Access denied
- **404 Not Found** - Resource not found
- **409 Conflict** - Resource already exists
- **422 Unprocessable Entity** - Valid request but can't be processed
- **429 Too Many Requests** - Rate limit exceeded

### **5xx Server Error Codes**
- **500 Internal Server Error** - Server error
- **502 Bad Gateway** - Invalid response from upstream
- **503 Service Unavailable** - Service temporarily unavailable

## 🛠️ **Implementation Examples**

### **1. Using Custom Error Classes**

```javascript
const { 
    ValidationException, 
    NotFoundException, 
    ConflictException 
} = require('../middlewares/customError');

// Validation error (400)
if (!email || !password) {
    throw new ValidationException('Email and password are required');
}

// Not found error (404)
if (!user) {
    throw new NotFoundException('User not found');
}

// Conflict error (409)
if (emailExists) {
    throw new ConflictException('Email already exists');
}
```

### **2. Using ResponseHelper**

```javascript
const ResponseHelper = require('../utils/responseHelper');

// Success responses
ResponseHelper.success(res, 'Data retrieved successfully', data);
ResponseHelper.created(res, 'User created successfully', newUser);
ResponseHelper.paginated(res, 'Users retrieved', users, pagination);

// Error responses
ResponseHelper.validationError(res, 'Invalid input', validationErrors);
ResponseHelper.notFound(res, 'User not found');
ResponseHelper.conflict(res, 'Email already exists');
```

### **3. Using AsyncHandler**

```javascript
const { asyncHandler } = require('../middlewares/httpErrorHandler');

// Wrap controller functions
const getUserById = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    
    if (!userId) {
        throw new ValidationException('User ID is required');
    }
    
    const user = await findUserById(userId);
    if (!user) {
        throw new NotFoundException('User not found');
    }
    
    return ResponseHelper.success(res, 'User retrieved successfully', user);
});
```

## 📋 **Common Status Code Scenarios**

### **Authentication & Authorization**
```javascript
// 401 Unauthorized
if (!req.user) {
    throw new UnauthorizedException('Authentication required');
}

// 403 Forbidden
if (!hasPermission(req.user, 'admin')) {
    throw new ForbiddenException('Insufficient permissions');
}
```

### **Validation Errors**
```javascript
// 400 Bad Request
if (!email || !isValidEmail(email)) {
    throw new ValidationException('Valid email is required');
}

if (age < 0 || age > 120) {
    throw new ValidationException('Age must be between 0 and 120');
}
```

### **Resource Management**
```javascript
// 404 Not Found
const user = await findUserById(userId);
if (!user) {
    throw new NotFoundException('User not found');
}

// 409 Conflict
const existingUser = await findUserByEmail(email);
if (existingUser) {
    throw new ConflictException('User with this email already exists');
}
```

### **Rate Limiting**
```javascript
// 429 Too Many Requests
if (requestCount > rateLimit) {
    throw new TooManyRequestsError('Rate limit exceeded');
}
```

## 🔧 **Error Response Format**

### **Success Response**
```json
{
    "status": "1",
    "message": "User retrieved successfully",
    "data": {
        "id": 1,
        "name": "John Doe",
        "email": "john@example.com"
    },
    "error": "",
    "statusCode": 200,
    "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### **Error Response**
```json
{
    "status": "0",
    "message": "User not found",
    "data": {},
    "error": "User not found",
    "statusCode": 404,
    "timestamp": "2024-01-15T10:30:00.000Z",
    "path": "/api/users/999"
}
```

### **Validation Error Response**
```json
{
    "status": "0",
    "message": "Validation failed",
    "data": {},
    "error": "Validation failed",
    "statusCode": 400,
    "timestamp": "2024-01-15T10:30:00.000Z",
    "details": {
        "email": "Email is required",
        "password": "Password must be at least 8 characters"
    }
}
```

## 🚀 **Best Practices**

### **1. Use Appropriate Status Codes**
- Don't use 200 for errors
- Use 4xx for client errors, 5xx for server errors
- Be consistent across your API

### **2. Provide Clear Error Messages**
```javascript
// Good
throw new ValidationException('Email format is invalid');

// Bad
throw new ValidationException('Invalid input');
```

### **3. Include Helpful Details**
```javascript
throw new ValidationException('Validation failed', {
    email: 'Email is required',
    password: 'Password must be at least 8 characters'
});
```

### **4. Log Errors Properly**
```javascript
// Errors are automatically logged in the error handler
console.error('Error:', {
    message: err.message,
    statusCode: err.statusCode,
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
    timestamp: new Date().toISOString()
});
```

### **5. Handle Async Errors**
```javascript
// Always wrap async functions
const controller = asyncHandler(async (req, res) => {
    // Your async code here
    // Errors will be automatically caught and handled
});
```

## 📝 **Migration Guide**

### **Before (Old Way)**
```javascript
async function updateUser(req, res) {
    try {
        const user = await findUserById(req.params.id);
        if (!user) {
            return res.status(404).json({
                status: '0',
                message: 'User not found',
                data: {},
                error: 'User not found'
            });
        }
        // ... update logic
        return res.json({
            status: '1',
            message: 'User updated successfully',
            data: updatedUser,
            error: ''
        });
    } catch (error) {
        return res.status(500).json({
            status: '0',
            message: 'Something went wrong',
            data: {},
            error: error.message
        });
    }
}
```

### **After (New Way)**
```javascript
const updateUser = asyncHandler(async (req, res) => {
    const { id } = req.params;
    
    if (!id) {
        throw new ValidationException('User ID is required');
    }
    
    const user = await findUserById(id);
    if (!user) {
        throw new NotFoundException('User not found');
    }
    
    const updatedUser = await updateUserById(id, req.body);
    return ResponseHelper.success(res, 'User updated successfully', updatedUser);
});
```

## 🎯 **Summary**

This error handling system provides:
- ✅ **Proper HTTP status codes**
- ✅ **Consistent error responses**
- ✅ **Automatic error logging**
- ✅ **Type-safe error handling**
- ✅ **Easy migration from existing code**
- ✅ **Better debugging experience**

The system is designed to be backward compatible while providing modern error handling capabilities.
