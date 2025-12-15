# Cancellation Policy Management

## Overview
The Cancellation Policy Management system allows administrators to create, configure, and manage cancellation policies for the laundry service. The system provides granular control over cancellation charges based on order status and timing.

## Database Structure

### Tables

#### 1. `policies`
Main policy table that stores policy metadata:
- `id`: Primary key
- `name`: Policy name
- `type`: Policy type (enum: 'no_show', 'cancellation', 'late_pickup', 'late_delivery')
- `description`: Policy description
- `isActive`: Whether policy is active
- `isDefault`: Whether policy is the default for its type
- `createdBy`: User ID who created the policy
- `updatedBy`: User ID who last updated the policy

#### 2. `cancellation_policy_configs`
Configuration table for cancellation policies:

**Pre-Pickup / Driver En-Route Section:**
- `prePickupAbsoluteCurrency`: Currency for absolute charges (e.g., 'USD')
- `prePickupAbsoluteAmount`: Absolute amount to charge
- `prePickupPercentage`: Percentage to charge
- `prePickupFreeChargeWindowMinutes`: Free cancellation window in minutes (default: 120)
- `prePickupFirstCancellationLeniency`: Enable first cancellation leniency (default: false)

**Unprocessed Section:**
- `unprocessedAbsoluteCurrency`: Currency for unprocessed charges
- `unprocessedAbsoluteAmount`: Absolute amount to charge
- `unprocessedPercentage`: Percentage to charge
- `unprocessedAfterPickupMinutes`: Time window after pickup (default: 30)
- `unprocessedOrderValuePercentage`: Percentage of order value (default: 15.00)
- `allowCancelUnprocessed`: Allow cancellation for unprocessed orders (default: true)

**Customer Leniency Section:**
- `courtesyWindowDays`: Courtesy window in days (default: 30)
- `courtesyCapAmount`: Courtesy cap amount (default: 15.00)
- `courtesyCount`: Number of courtesy cancellations (default: 1)
- `customerLeniencyEnabled`: Enable customer leniency (default: true)

## API Endpoints

All endpoints require authentication via `validateAccessToken` middleware.

### 1. Create Cancellation Policy
**POST** `/admin/cancellation-policy`

**Request Body:**
```json
{
  "name": "Premium Cancellation Policy",
  "description": "Cancellation policy for premium customers",
  "isActive": true,
  "isDefault": false,
  "prePickupAbsoluteCurrency": "USD",
  "prePickupAbsoluteAmount": null,
  "prePickupPercentage": null,
  "prePickupFreeChargeWindowMinutes": 180,
  "prePickupFirstCancellationLeniency": true,
  "unprocessedAbsoluteCurrency": "USD",
  "unprocessedAbsoluteAmount": 25.00,
  "unprocessedPercentage": null,
  "unprocessedAfterPickupMinutes": 45,
  "unprocessedOrderValuePercentage": 10.00,
  "allowCancelUnprocessed": true,
  "courtesyWindowDays": 60,
  "courtesyCapAmount": 20.00,
  "courtesyCount": 2,
  "customerLeniencyEnabled": true
}
```

**Response:**
```json
{
  "status": "1",
  "message": "Cancellation policy created successfully",
  "data": {
    "id": 2,
    "name": "Premium Cancellation Policy",
    "type": "cancellation",
    "description": "Cancellation policy for premium customers",
    "isActive": true,
    "isDefault": false,
    "cancellationConfig": {
      "id": 2,
      "policyId": 2,
      "prePickupAbsoluteCurrency": "USD",
      // ... all config fields
    }
  }
}
```

### 2. Get All Cancellation Policies
**GET** `/admin/cancellation-policies?page=1&limit=10&isActive=true&isDefault=false`

**Query Parameters:**
- `page`: Page number (default: 1)
- `limit`: Items per page (default: 10)
- `isActive`: Filter by active status (optional)
- `isDefault`: Filter by default status (optional)

**Response:**
```json
{
  "status": "1",
  "message": "All cancellation policies",
  "data": {
    "policies": [
      {
        "id": 1,
        "name": "Default Cancellation Policy",
        "type": "cancellation",
        "isActive": true,
        "isDefault": true,
        "cancellationConfig": { /* config details */ }
      }
    ],
    "pagination": {
      "total": 5,
      "page": 1,
      "limit": 10,
      "pages": 1
    }
  }
}
```

### 3. Get Cancellation Policy by ID
**GET** `/admin/cancellation-policy/:id`

**Response:**
```json
{
  "status": "1",
  "message": "Cancellation policy details",
  "data": {
    "id": 1,
    "name": "Default Cancellation Policy",
    "type": "cancellation",
    "description": "Standard cancellation policy",
    "isActive": true,
    "isDefault": true,
    "cancellationConfig": {
      "id": 1,
      "policyId": 1,
      "prePickupFreeChargeWindowMinutes": 120,
      // ... all config fields
    }
  }
}
```

### 4. Update Cancellation Policy
**PUT** `/admin/cancellation-policy/:id`

**Request Body:** (same structure as create, all fields optional)
```json
{
  "name": "Updated Policy Name",
  "prePickupFreeChargeWindowMinutes": 150,
  "unprocessedAbsoluteAmount": 35.00
}
```

### 5. Delete Cancellation Policy
**DELETE** `/admin/cancellation-policy/:id`

**Note:** Cannot delete default policies. Set another policy as default first.

### 6. Set Default Cancellation Policy
**PATCH** `/admin/cancellation-policy/:id/set-default`

Sets the specified policy as the default cancellation policy. Automatically unsets other default policies.

### 7. Toggle Cancellation Policy Status
**PATCH** `/admin/cancellation-policy/:id/toggle-status`

Toggles the active status of a policy. If deactivating a default policy, another policy will be automatically set as default.

### 8. Get Active Cancellation Policy
**GET** `/admin/cancellation-policy/active/current`

Returns the currently active cancellation policy (default or first active).

### 9. Get Cancellation Policy Statistics
**GET** `/admin/cancellation-policy/statistics/summary`

**Response:**
```json
{
  "status": "1",
  "message": "Cancellation policy statistics",
  "data": {
    "totalCancellationPolicies": 3,
    "activeCancellationPolicies": 2,
    "inactiveCancellationPolicies": 1,
    "defaultCancellationPolicy": {
      "id": 1,
      "name": "Default Cancellation Policy",
      "isActive": true
    }
  }
}
```

## Service Layer

### CancellationPolicyService

Located at: `services/Admin/cancellationPolicyService.js`

**Methods:**
- `createCancellationPolicy(data)` - Create new policy with configuration
- `getCancellationPolicyById(policyId)` - Get policy by ID
- `getAllCancellationPolicies(filters)` - Get all policies with pagination
- `updateCancellationPolicy(policyId, updateData, updatedBy)` - Update policy
- `deleteCancellationPolicy(policyId)` - Delete policy
- `setDefaultCancellationPolicy(policyId, updatedBy)` - Set as default
- `toggleCancellationPolicyStatus(policyId, updatedBy)` - Toggle status
- `getActiveCancellationPolicy()` - Get active policy
- `getCancellationPolicyStatistics()` - Get statistics
- `duplicateCancellationPolicy(policyId, newName, createdBy)` - Duplicate policy

## Migration & Seeding

### Run Migration
```bash
npx sequelize-cli db:migrate
```

This will create the `cancellation_policy_configs` table.

### Run Seeder
```bash
npx sequelize-cli db:seed --seed 20251114163000-default-cancellation-policy.js
```

This will create a default cancellation policy with standard configuration.

## Policy Configuration Guide

### Pre-Pickup Configuration
Configure cancellation charges for orders before pickup:
- Set a free cancellation window (e.g., 120 minutes before pickup)
- Enable first cancellation leniency to waive charges for first-time cancellers
- Choose between absolute amount or percentage charges

### Unprocessed Configuration
Configure cancellation charges for orders after pickup but before processing:
- Define the time window after pickup (e.g., 30 minutes)
- Set absolute charges or percentage of order value
- Enable/disable cancellation for unprocessed orders

### Customer Leniency Configuration
Provide courtesy cancellations within a time period:
- Set courtesy window (e.g., 30 days)
- Define courtesy cap amount
- Set number of courtesy cancellations allowed

## Business Logic

### Cancellation Fee Calculation
1. **Pre-Pickup Cancellation:**
   - If within free charge window → No charge
   - If first cancellation and leniency enabled → No charge
   - Otherwise → Apply configured charge

2. **Unprocessed Cancellation:**
   - Check if cancellation is allowed
   - Check if within unprocessed window
   - Apply higher of: absolute amount or order value percentage

3. **Customer Leniency:**
   - Check courtesy count within window
   - If under limit → Waive or reduce charges
   - If over limit → Apply full charges

## Error Handling

The service uses universal error handlers:
- `ValidationError` (400) - Invalid input or business rule violation
- `NotFoundError` (404) - Policy not found
- `ConflictError` (409) - Cannot delete default policy

## Best Practices

1. **Always have a default policy** - The system requires at least one active cancellation policy
2. **Test policies before activating** - Create policies as inactive, test, then activate
3. **Use descriptive names** - Clearly identify policies by customer type or service level
4. **Set reasonable windows** - Balance business needs with customer satisfaction
5. **Monitor statistics** - Regularly check policy usage and effectiveness

## Integration Example

```javascript
// In order cancellation logic
const cancellationPolicyService = require('./services/Admin/cancellationPolicyService');

async function cancelOrder(orderId, userId) {
    // Get active cancellation policy
    const policy = await cancellationPolicyService.getActiveCancellationPolicy();
    const config = policy.cancellationConfig;
    
    // Calculate cancellation charge based on order status
    const order = await getOrder(orderId);
    let cancellationCharge = 0;
    
    if (order.status === 'awaiting_collection') {
        // Pre-pickup logic
        const timeUntilPickup = calculateMinutesUntilPickup(order.pickupTime);
        if (timeUntilPickup > config.prePickupFreeChargeWindowMinutes) {
            cancellationCharge = 0; // Free cancellation
        } else {
            // Check first cancellation leniency
            const isFirstCancellation = await checkFirstCancellation(userId);
            if (isFirstCancellation && config.prePickupFirstCancellationLeniency) {
                cancellationCharge = 0;
            } else {
                cancellationCharge = config.prePickupAbsoluteAmount || 0;
            }
        }
    } else if (order.status === 'picked_up') {
        // Unprocessed logic
        const minutesSincePickup = calculateMinutesSincePickup(order.pickedUpAt);
        if (minutesSincePickup <= config.unprocessedAfterPickupMinutes) {
            if (config.allowCancelUnprocessed) {
                cancellationCharge = config.unprocessedAbsoluteAmount || 
                    (order.totalAmount * config.unprocessedOrderValuePercentage / 100);
            } else {
                throw new Error('Cancellation not allowed for unprocessed orders');
            }
        }
    }
    
    // Apply customer leniency
    if (config.customerLeniencyEnabled) {
        const courtesyCancellations = await getCourtesyCancellations(
            userId, 
            config.courtesyWindowDays
        );
        
        if (courtesyCancellations.count < config.courtesyCount) {
            cancellationCharge = Math.min(cancellationCharge, config.courtesyCapAmount);
        }
    }
    
    // Process cancellation with calculated charge
    await processCancellation(orderId, cancellationCharge);
}
```

## Future Enhancements

1. **Multi-tier policies** - Different policies for different customer tiers
2. **Dynamic pricing** - Adjust charges based on demand
3. **Policy scheduling** - Activate policies during specific time periods
4. **A/B testing** - Test multiple policies simultaneously
5. **Analytics dashboard** - Detailed policy performance metrics

