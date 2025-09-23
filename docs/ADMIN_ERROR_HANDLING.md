# Admin-Specific Error Handling Guide

This document explains how to use the admin-specific error handling system in your laundry backend application.

## 🎯 **Purpose**

The admin error handling system is designed specifically for admin controllers and provides:
- ✅ **Admin-specific error types** with proper HTTP status codes
- ✅ **Admin-specific response helpers** for consistent API responses
- ✅ **Admin-specific logging** with admin context
- ✅ **Backward compatibility** with existing `customError.js`

## 📁 **Files Created**

1. **`middlewares/adminErrorHandler.js`** - Admin-specific error classes and middleware
2. **`utils/adminResponseHelper.js`** - Admin-specific response helpers
3. **`examples/adminErrorHandlingExample.js`** - Usage examples

## 🚀 **Usage**

### **1. Import Admin Error Classes**

```javascript
const { 
    AdminValidationError, 
    AdminNotFoundError, 
    AdminUnauthorizedError, 
    AdminConflictError 
} = require('../../middlewares/adminErrorHandler');
const AdminResponseHelper = require('../../utils/adminResponseHelper');
const { adminAsyncHandler } = require('../../middlewares/adminErrorHandler');
```

### **2. Admin Error Types**

#### **AdminValidationError (400 Bad Request)**
```javascript
// Use for input validation errors
if (!customerId || isNaN(customerId)) {
    throw new AdminValidationError('Invalid customer ID provided');
}

if (!email || !isValidEmail(email)) {
    throw new AdminValidationError('Valid email is required');
}
```

#### **AdminNotFoundError (404 Not Found)**
```javascript
// Use when resources are not found
const customer = await findCustomerById(customerId);
if (!customer) {
    throw new AdminNotFoundError('Customer not found');
}
```

#### **AdminConflictError (409 Conflict)**
```javascript
// Use when resources already exist or have conflicts
const existingService = await findServiceByName(name);
if (existingService) {
    throw new AdminConflictError('Service with this name already exists');
}
```

#### **AdminUnauthorizedError (401 Unauthorized)**
```javascript
// Use for authentication issues
if (!req.user || req.user.role !== 'admin') {
    throw new AdminUnauthorizedError('Admin access required');
}
```

### **3. Admin Response Helpers**

#### **Success Responses**
```javascript
// Basic success response
AdminResponseHelper.success(res, 'Customer updated successfully', customerData);

// Created response
AdminResponseHelper.created(res, 'Service created successfully', newService);

// Dashboard response
AdminResponseHelper.dashboard(res, 'Dashboard data retrieved', dashboardData);

// Statistics response
AdminResponseHelper.statistics(res, 'Statistics retrieved', statisticsData);

// List response with filters and pagination
AdminResponseHelper.list(res, 'Orders retrieved', orders, filters, pagination);
```

#### **Error Responses**
```javascript
// Validation error
AdminResponseHelper.validationError(res, 'Invalid input', validationErrors);

// Not found
AdminResponseHelper.notFound(res, 'Customer not found');

// Conflict
AdminResponseHelper.conflict(res, 'Email already exists');
```

### **4. Using AdminAsyncHandler**

```javascript
// Wrap your admin controller functions
const updateCustomer = adminAsyncHandler(async (req, res) => {
    const { customerId } = req.params;
    
    // Validation
    if (!customerId || isNaN(customerId)) {
        throw new AdminValidationError('Invalid customer ID provided');
    }
    
    // Your business logic here
    const updatedCustomer = await updateCustomerLogic(customerId, req.body);
    
    return AdminResponseHelper.success(res, 'Customer updated successfully', updatedCustomer);
});
```

## 📋 **Complete Example**

### **Before (Old Way)**
```javascript
async function updateCustomer(req, res) {
    try {
        const { customerId } = req.params;
        
        if (!customerId) {
            return res.status(400).json({
                status: '0',
                message: 'Invalid customer ID',
                data: {},
                error: 'Invalid customer ID'
            });
        }
        
        const customer = await findCustomerById(customerId);
        if (!customer) {
            return res.status(404).json({
                status: '0',
                message: 'Customer not found',
                data: {},
                error: 'Customer not found'
            });
        }
        
        // Update logic...
        
        return res.json({
            status: '1',
            message: 'Customer updated successfully',
            data: updatedCustomer,
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

### **After (New Admin Way)**
```javascript
const updateCustomer = adminAsyncHandler(async (req, res) => {
    const { customerId } = req.params;
    
    // Admin-specific validation
    if (!customerId || isNaN(customerId)) {
        throw new AdminValidationError('Invalid customer ID provided');
    }
    
    const customer = await findCustomerById(customerId);
    if (!customer) {
        throw new AdminNotFoundError('Customer not found');
    }
    
    // Update logic...
    const updatedCustomer = await updateCustomerLogic(customerId, req.body);
    
    return AdminResponseHelper.success(res, 'Customer updated successfully', updatedCustomer);
});
```

## 🎯 **Admin-Specific Features**

### **1. Admin Context Logging**
```javascript
// Errors are automatically logged with admin context
console.error('Admin Error:', {
    message: err.message,
    statusCode: err.statusCode,
    adminId: req.user?.id || 'unknown',
    url: req.originalUrl,
    method: req.method,
    timestamp: new Date().toISOString()
});
```

### **2. Admin-Specific Response Types**
```javascript
// Dashboard responses include metadata
AdminResponseHelper.dashboard(res, 'Dashboard data', data);
// Response includes: { type: 'dashboard', generatedAt: timestamp }

// Statistics responses include metadata
AdminResponseHelper.statistics(res, 'Statistics', data);
// Response includes: { type: 'statistics', generatedAt: timestamp }

// List responses include filters and pagination
AdminResponseHelper.list(res, 'Orders', data, filters, pagination);
// Response includes: { filters, pagination, type: 'list', generatedAt: timestamp }
```

### **3. Admin-Specific Error Messages**
```javascript
// More descriptive error messages for admin context
throw new AdminValidationError('Invalid customer ID provided');
throw new AdminNotFoundError('Customer not found in the system');
throw new AdminConflictError('Cannot delete customer with active bookings');
```

## 🔧 **Migration Strategy**

### **Step 1: Keep Existing Code**
Your existing `customError.js` remains unchanged and continues to work.

### **Step 2: Gradual Migration**
Update admin controller functions one by one:

```javascript
// Old way (still works)
throw new customError("Customer not found", "Please provide a valid customer ID");

// New admin way (recommended)
throw new AdminNotFoundError('Customer not found');
```

### **Step 3: Use Admin Response Helpers**
```javascript
// Old way (still works)
return res.json(responsefunc("1", "Customer updated successfully", updatedCustomer, ""));

// New admin way (recommended)
return AdminResponseHelper.success(res, 'Customer updated successfully', updatedCustomer);
```

## 📊 **Response Format**

### **Success Response**
```json
{
    "status": "1",
    "message": "Customer updated successfully",
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
    "message": "Customer not found",
    "data": {},
    "error": "Customer not found",
    "statusCode": 404,
    "timestamp": "2024-01-15T10:30:00.000Z",
    "path": "/admin/customers/999"
}
```

## 🎯 **Benefits**

1. **✅ Admin-Specific Context** - Errors and responses tailored for admin use
2. **✅ Proper HTTP Status Codes** - RESTful API standards
3. **✅ Consistent Error Handling** - All admin errors follow the same pattern
4. **✅ Better Debugging** - Admin-specific logging and error context
5. **✅ Backward Compatibility** - Existing code continues to work
6. **✅ Easy Migration** - Gradual adoption without breaking changes

## 🚀 **Next Steps**

1. **Start using admin error classes** in new admin controller functions
2. **Gradually migrate existing functions** to use admin response helpers
3. **Test the error handling** with different admin scenarios
4. **Customize error messages** for your specific admin use cases

The admin error handling system is now ready to use! 🎉
