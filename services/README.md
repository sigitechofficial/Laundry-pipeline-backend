# Service Layer Architecture

This directory contains the service layer for the laundry backend application. The service layer separates business logic from the controller layer, making the code more maintainable and testable.

## Structure

```
services/
├── Admin/
│   ├── index.js                    # Exports all admin services
│   ├── dashboardService.js         # Dashboard statistics and metrics
│   ├── customerService.js          # Customer management operations
│   ├── driverService.js            # Driver management operations
│   ├── orderService.js             # Order management operations
│   ├── serviceManagementService.js # Service and category management
│   ├── dataService.js              # General data operations (countries, cities, etc.)
│   ├── shopManagementService.js    # Shop management operations
│   └── employeeManagementService.js # Employee management operations
└── README.md
```

## Usage

### In Controllers

Instead of writing database queries directly in controllers, use the service layer:

```javascript
// Before (in controller)
async function getAllCustomers(req, res) {
    const findCustomers = await users.findAll({
        where: { userTypeId: 2 },
        // ... complex query
    });
    return res.json(responsefunc("1", "All Customer Details", findCustomers, ""));
}

// After (using service layer)
async function getAllCustomers(req, res) {
    try {
        const customers = await customerService.getAllCustomers();
        return res.json(responsefunc("1", "All Customer Details", customers, ""));
    } catch (error) {
        console.error("Get All Customers Error:", error);
        return res.status(500).json(responsefunc("0", "Something went wrong", {}, error.message));
    }
}
```

### Service Methods

Each service contains methods that handle specific business logic:

#### DashboardService
- `getDashboardData()` - Get admin dashboard statistics

#### CustomerService
- `getAllCustomers()` - Get all customers with booking statistics
- `getCustomerCount()` - Get customer count metrics
- `getSpecificCustomerDetails(customerId)` - Get detailed customer information

#### DriverService
- `getDriverCount()` - Get driver count statistics
- `getAllDriversWithStats()` - Get all drivers with booking statistics
- `getSpecificDriverDetails(driverId)` - Get detailed driver information

#### OrderService
- `getOrderCount()` - Get order count statistics
- `getAllOrderDetails(filters, page, limit)` - Get all orders with pagination
- `getPendingOrders(page, limit)` - Get pending orders
- `getCancelledOrders(page, limit)` - Get cancelled orders
- `getCompletedOrders(page, limit)` - Get completed orders
- `getOrderForEdit(orderId)` - Get order details for editing

#### ServiceManagementService
- `getAdminServicesWithCategories()` - Get services with category counts
- `getSubCategories(categoryId)` - Get subcategories by category
- `getServicesAndCategoriesForOrderEdit()` - Get services and categories for order editing
- `getAllServices()` - Get all active services
- `getCategories()` - Get all categories
- `getSubcategories()` - Get all subcategories
    
#### DataService
- `getCountries()` - Get all countries
- `getCities()` - Get all cities
- `getZones()` - Get all zones with additional information
- `getUnitsDistanceAndCurrency()` - Get distance and currency units
- `getAllUnits()` - Get all units
- `getAllRoles()` - Get all active roles
- `getClassifiedAs()` - Get all classified as options
- `getFeatures()` - Get all active features
- `getOnHoldOptions()` - Get on hold options
- `getOnHoldCustomerOptions()` - Get on hold customer options
- `getPreferenceTypes()` - Get preference types with values
- `getAccountPreferences()` - Get account preferences
- `getCancelBookingReasons()` - Get cancel booking reasons

#### ShopManagementService
- `getShopInformation()` - Get shop count statistics
- `getShopsData()` - Get all shops with detailed information
- `getSingleShopData(shopId)` - Get single shop data
- `getShopEmployees(businessId)` - Get shop employees

#### EmployeeManagementService
- `getAdminEmployees()` - Get all admin employees

## Benefits

1. **Separation of Concerns**: Business logic is separated from HTTP handling
2. **Reusability**: Services can be used across different controllers
3. **Testability**: Services can be easily unit tested
4. **Maintainability**: Changes to business logic only require updating the service
5. **Consistency**: Standardized error handling and response formatting

## Error Handling

All services throw errors with descriptive messages. Controllers should catch these errors and return appropriate HTTP responses:

```javascript
try {
    const result = await someService.someMethod();
    return res.json(responsefunc("1", "Success", result, ""));
} catch (error) {
    console.error("Service Error:", error);
    return res.status(500).json(responsefunc("0", "Something went wrong", {}, error.message));
}
```

## Adding New Services

1. Create a new service file in the appropriate directory
2. Export the service class/object
3. Add the service to the index.js file
4. Import and use the service in controllers

Example:
```javascript
// services/Admin/newService.js
class NewService {
    async someMethod() {
        // Business logic here
    }
}

module.exports = new NewService();
```

```javascript
// services/Admin/index.js
const newService = require('./newService');

module.exports = {
    // ... other services
    newService
};
```
