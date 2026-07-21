# Customer App Guide - Failed Attempt Modal and Reschedule Flow

This document is for the **Customer app team**. It explains how to detect failed pickup/delivery attempts, show the "Action Required" modal, open the affected order, and submit reschedule requests.

Base API path: `/customer`
Auth: `Authorization: Bearer <customer_access_token>`

---

## 1) Business behavior

- **Delivery failed** has a dedicated booking status:
  - `bookingStatusId = 15` (`Delivery Failed`)
- **Pickup failed** does **not** have its own status row.
  - Booking returns to `bookingStatusId = 3` (`Awaiting Collection`)
  - Detect an unresolved pickup failure using `pickupRescheduleRequired === true`
  - `pickupAttemptCount` remains cumulative after rescheduling for policy limits

So customer app must treat both cases as attention-required:

- Delivery failed: `bookingStatusId === 15`
- Pickup failed: `bookingStatusId === 3 && pickupRescheduleRequired === true`

---

## 2) APIs used by customer app

### 2.1 Fetch customer bookings (for modal trigger)

`GET /customer/allBookings`

Use these fields from each booking:

- `id`
- `orderTrackId`
- `bookingStatusId`
- `pickupAttemptCount`
- `pickupRescheduleRequired`
- `deliveryAttemptCount`
- `noShowFeeAccrued` (optional display)
- schedule fields (`collectionDate`, `collectionTimeFrom`, `deliveryDate`, etc.)

Failed-attempt detector logic:

```js
const isDeliveryFailed = booking.bookingStatusId === 15;
const isPickupFailed =
  booking.bookingStatusId === 3 && Boolean(booking.pickupRescheduleRequired);
const needsAttention = isDeliveryFailed || isPickupFailed;
```

### 2.2 Open one order in Order History

Customer web flow deep-links to:

`/profile?tab=order-history&bookingId=<id>`

Order History then auto-opens that booking detail.

### 2.3 Booking detail API

`GET /customer/bookingDetailsById?bookingId=<id>&timeZone=<iana_tz>`

Use this for full booking information and "Schedule Again" action context.

### 2.4 Submit reschedule

`POST /customer/rescheduleBooking`

Required schedule fields:

- `bookingId`
- `collectionDate`, `collectionTimeFrom`, `collectionTimeTo`
- `deliveryDate`, `deliveryTimeFrom`, `deliveryTimeTo`
- `timeZone` (recommended)
- `reasonText` (recommended)

For failed-attempt flow also send:

- `rescheduleType`
  - `"delivery"` for delivery-failed reschedule
  - `"full"` for normal/full reschedule

Optional:

- `services`
- `preferencesArray`
- `totalBags`, `sameBagForAllServices`, `totalItems`

Example payload:

```json
{
  "bookingId": 1029,
  "collectionDate": "2026-07-16",
  "collectionTimeFrom": "06:00:00",
  "collectionTimeTo": "07:00:00",
  "deliveryDate": "2026-07-18",
  "deliveryTimeFrom": "16:00:00",
  "deliveryTimeTo": "17:00:00",
  "timeZone": "Europe/London",
  "reasonText": "My plans changed",
  "rescheduleType": "delivery"
}
```

---

## 3) Modal UX behavior (implemented pattern)

Show "Action Required" modal on Place Order screen when:

- user is logged in
- bookings fetched successfully
- at least one booking satisfies failed-attempt detector
- and current session is **not already** in reschedule flow

Suggested text:

- Delivery failed:
  - `"We were unable to deliver your laundry. Please reschedule your delivery slot."`
- Pickup failed:
  - `"Our driver was unable to collect your laundry. Please reschedule your collection slot."`

CTA:

- `View Order` -> navigate to `/profile?tab=order-history&bookingId=<id>`

Important:

- Do **not** re-open this modal when user has already entered reschedule flow.

---

## 4) Reschedule flow rules

### 4.1 Delivery-failed reschedule (`rescheduleType = "delivery"`)

- Keep pickup values unchanged
- Customer should edit delivery slot only
- Collection controls should be disabled in UI

Backend support:

- Delivery-failed booking (`status 15`) is allowed to reschedule
- For `rescheduleType = "delivery"`, backend skips "collection must be in future" validation
- Backend still validates delivery date/time is in the future

### 4.2 Full reschedule (`rescheduleType = "full"`)

- Both collection and delivery can be edited
- Normal future validations apply

---

## 5) Error handling notes

Common responses to handle:

- `"Cannot reschedule booking at this stage. Items are out for delivery"`  
  (status `14` is blocked)
- `"New delivery date and time must be in the future"`
- `"Cannot reschedule a completed booking"`
- `"Cannot reschedule a cancelled booking"`

Show these messages directly in user toast/snackbar where possible.

---

## 6) Recommended frontend status display mapping

For customer cards/list rows:

- If `bookingStatusId === 15` -> badge label: `Delivery Failed`
- If `bookingStatusId === 3 && pickupRescheduleRequired === true` -> badge label: `Pickup Failed`
- Else use backend `bookingStatus.title`

This keeps failed pickup behavior visually consistent with failed delivery.

