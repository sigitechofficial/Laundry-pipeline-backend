# No-Show Policy API - Postman Request Body Documentation

## Endpoint
**POST** `/admin/no-show-policy`

## Request Body Structure

### Policy Basic Information (Required)
- **`name`** (string, **REQUIRED**) - Policy name/identifier
- **`description`** (string, optional) - Policy description/notes
- **`isActive`** (boolean, optional, default: `true`) - Whether policy is active
- **`isDefault`** (boolean, optional, default: `false`) - Set as default policy. If `true`, automatically unsets other default policies of the same type

### Basic Settings (Optional - all have defaults)
- **`enableForPickup`** (boolean, default: `true`) - Enable no-show policy for pickup orders
- **`enableForDelivery`** (boolean, default: `true`) - Enable no-show policy for delivery orders
- **`useUnifiedFee`** (boolean, default: `true`) - Use unified fee for both pickup and delivery

### Fee Configuration (Optional)
- **`feeType`** (enum: `'absolute'`, `'percentage'`, `'both'`, default: `'absolute'`) - Fee calculation type
- **`currency`** (string, default: `'USD'`) - Currency code (e.g., 'USD', 'EUR')
- **`pickupNoShowFee`** (decimal, default: `15.00`) - No-show fee for pickup orders in absolute amount
- **`deliveryNoShowFee`** (decimal, default: `20.00`) - No-show fee for delivery orders in absolute amount
- **`storageFeePerDay`** (decimal, default: `1.00`) - Daily storage fee for unclaimed orders
- **`percentageFee`** (decimal, optional) - Percentage fee (e.g., `5.00` for 5%). Used when `feeType` is `'percentage'` or `'both'`

### Eligibility Configuration (Optional)
- **`graceMinutesOnSite`** (integer, default: `15`) - Minutes to wait before no-show applies
- **`driverLateSLA`** (integer, default: `30`) - Driver late SLA in minutes - auto-waive if exceeded
- **`callsMinutes`** (integer, default: `5`) - Minutes to wait before no-show applies for calls
- **`smsMinutes`** (integer, default: `5`) - Minutes to wait before no-show applies for SMS

### Unattended Options (Optional - all default to `true`)
- **`pickupBagAtDoor`** (boolean, default: `true`) - Allow pickup bag at door
- **`deliveryLeaveAtDoor`** (boolean, default: `true`) - Allow delivery to be left at door
- **`concierge`** (boolean, default: `true`) - Allow concierge service
- **`locker`** (boolean, default: `true`) - Allow locker service
- **`requirePhoto`** (boolean, default: `true`) - Require photo proof for unattended deliveries

### Waivers & Caps (Optional)
- **`waiverType`** (enum: `'absolute'`, `'percentage'`, `'both'`, default: `'absolute'`) - Waiver calculation type
- **`absoluteWaiverAmount`** (decimal, optional) - Absolute amount for auto-waive. Used when `waiverType` is `'absolute'` or `'both'`
- **`percentageWaiverAmount`** (decimal, optional) - Percentage of order value for auto-waive (e.g., `5.00` for 5%)
- **`autoForgiveFirstNoShow`** (boolean, default: `true`) - Automatically forgive first no-show
- **`autoForgiveCount`** (integer, default: `1`) - Number of no-shows to auto-forgive
- **`autoForgivePeriod`** (integer, default: `30`) - Period in days for auto-forgive
- **`requirePaymentAfterCap`** (boolean, default: `true`) - Require payment after cap is reached
- **`perCustomerCap`** (integer, default: `3`) - Maximum charges per customer
- **`capWindowDays`** (integer, default: `90`) - Window in days for cap calculation

---

## Example Request Body (Minimal - Only Required Fields)

```json
{
  "name": "Basic No-Show Policy"
}
```

## Example Request Body (Complete - All Fields)

```json
{
  "name": "Standard No-Show Policy",
  "description": "Standard no-show policy for handling customer no-show scenarios",
  "isActive": true,
  "isDefault": false,
  "enableForPickup": true,
  "enableForDelivery": true,
  "useUnifiedFee": true,
  "feeType": "absolute",
  "currency": "USD",
  "pickupNoShowFee": 15.00,
  "deliveryNoShowFee": 20.00,
  "storageFeePerDay": 1.00,
  "percentageFee": 5.00,
  "graceMinutesOnSite": 15,
  "driverLateSLA": 30,
  "callsMinutes": 5,
  "smsMinutes": 5,
  "pickupBagAtDoor": true,
  "deliveryLeaveAtDoor": true,
  "concierge": true,
  "locker": true,
  "requirePhoto": true,
  "waiverType": "absolute",
  "absoluteWaiverAmount": 10.00,
  "percentageWaiverAmount": 5.00,
  "autoForgiveFirstNoShow": true,
  "autoForgiveCount": 1,
  "autoForgivePeriod": 30,
  "requirePaymentAfterCap": true,
  "perCustomerCap": 3,
  "capWindowDays": 90
}
```

## Example Request Body (Percentage-Based Fee)

```json
{
  "name": "Percentage-Based No-Show Policy",
  "description": "No-show policy using percentage-based fees",
  "isActive": true,
  "feeType": "percentage",
  "currency": "USD",
  "percentageFee": 10.00,
  "graceMinutesOnSite": 20,
  "autoForgiveFirstNoShow": true
}
```

## Example Request Body (Both Fee Types)

```json
{
  "name": "Hybrid Fee No-Show Policy",
  "description": "No-show policy using both absolute and percentage fees",
  "isActive": true,
  "feeType": "both",
  "currency": "USD",
  "pickupNoShowFee": 15.00,
  "deliveryNoShowFee": 20.00,
  "percentageFee": 5.00,
  "graceMinutesOnSite": 15,
  "driverLateSLA": 30
}
```

---

## Notes

1. **Only `name` is required** - All other fields are optional and will use their default values if not provided
2. **`createdBy`** is automatically set from the authenticated user (`req.user.id`)
3. **`type`** is automatically set to `'no_show'` - you don't need to include it
4. If `isDefault` is set to `true`, it will automatically unset other default no-show policies
5. All decimal values should be numbers (not strings)
6. All boolean values should be `true` or `false` (not strings)
7. Enum values (`feeType`, `waiverType`) must match exactly: `'absolute'`, `'percentage'`, or `'both'`

