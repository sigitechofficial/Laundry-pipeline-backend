# Agent Pickup & Delivery Attempts — No-Show Flow & API Guide

Guide for the **Agent mobile app** team: what to show the driver after **Arrived**, how pickup/delivery attempts work, when no-show fees apply, and which APIs to call.

**Base path:** `/agent`  
**Auth:** `Authorization: Bearer <agent_access_token>` on all endpoints below.  
Most booking-status endpoints also require `checkPermissions`.

**Related:** Active no-show policy for the zone → `GET /agent/getActivePolicies?zoneId=<id>`

---

## 1. Overview

After the driver marks **Arrived** at pickup or delivery, the app must support **three outcomes**:

| Outcome | When | Result |
|---------|------|--------|
| **Complete** | Customer hands over / receives laundry | Existing success APIs (pickup inspection / deliver) |
| **Unattended** | Bag at door, concierge, locker (policy + customer instructions allow) | New API + photo proof if required |
| **Failed (no-show)** | Customer not available after grace period | New APIs → fee recorded → reschedule or cancel |

**Max pickup attempts:** default **2**. After the 2nd failed pickup, the booking is **cancelled** (status 19).

**Fees:** Calculated from the zone’s active **no-show policy**. Recorded on the attempt (`feeAmount`) and booking (`noShowFeeAccrued`). **Stripe charging is not wired in this phase** — the app should show the fee to the driver; backend records it only.

---

## 2. Booking status reference

| ID | Title | Role in this flow |
|----|-------|-------------------|
| 3 | Awaiting Collection | Pickup retry after 1st fail — order waits for new slot |
| 4 | Driver Out for PickUp | Driver en route to customer |
| 5 | Driver Reached Pickup | **Arrived** — grace timer starts |
| 7 | In Transit to Facility | Pickup success |
| 12 | Completed (At Facility) | Ready for delivery after delivery reschedule |
| 13 | Out for Delivery | Driver en route for delivery |
| 14 | Driver Reached | **Arrived** at delivery — grace timer starts |
| 15 | Delivery Failed | Delivery no-show — needs reschedule |
| 17 | Delivered | Delivery success |
| 19 | Cancelled | 2nd pickup attempt failed |

---

## 3. Pickup flow (full)

### 3.1 Happy path

```
Status 3 (Awaiting Collection)
  → PATCH /agent/agentBookingStatusOnTheWay/:bookingId
  → Status 4 (On the Way)

Status 4
  → PATCH /agent/driverStatusArrived/:bookingId
  → Status 5 (Arrived)
  → Backend creates booking_attempt (type=pickup, status=arrived, arrivedAt=now)

Status 5 — driver waits grace period, then either:
  → PATCH /agent/agentInspectionStatus/:bookingId     [customer present — complete pickup]
  → Status 7 (In Transit to Facility)
  → Attempt marked completed
```

### 3.2 Arrived screen — three buttons (after grace)

Poll or refresh:

```
GET /agent/booking/:bookingId/attempt-options?type=pickup
```

Use response fields:

| Field | Use in UI |
|-------|-----------|
| `graceElapsed` | Enable **Mark Failed** only when `true` |
| `graceSecondsRemaining` | Countdown timer |
| `graceMinutes` | Show “Wait X minutes on site” |
| `unattendedOptions` | Show allowed unattended methods |
| `requirePhoto` | Block unattended until proof uploaded |
| `attemptNumber` | Show “Attempt 1 of 2” |
| `feePreview` | Show estimated no-show fee if driver marks fail |

**Option A — Complete pickup (customer present)**

```
PATCH /agent/agentInspectionStatus/:bookingId
Body (optional): { timeZone, clientTimeZone }
```

**Option B — Unattended pickup**

1. Upload proof if `requirePhoto === true`:

```
POST /agent/AddPickupDeliveryProof
Form-data:
  bookingId: <id>
  deliveryType: pickUp
  Images: <files>
  noOfBags / noOfItems (optional)
```

2. Complete unattended:

```
POST /agent/booking/:bookingId/attempt/unattended
Body:
{
  "type": "pickup",
  "method": "bag_at_door" | "concierge" | "locker",
  "timeZone": "Europe/London",
  "clientTimeZone": "Europe/London"
}
```

→ Status **7**, attempt `unattended`.

**Unattended method rules (pickup)**

| Customer instruction (`driverInstructionOptions`) | Allowed methods (if policy ON) |
|---------------------------------------------------|--------------------------------|
| Collect from Outside | `bag_at_door` (if `pickupBagAtDoor`) |
| Collect from reception/Porter / Collect from the reception | `concierge` (if `concierge`) |
| Any | `locker` (if `locker` in policy) |

**Option C — Pickup failed (no-show)**

Only when `canMarkFailed` / `graceElapsed` is true:

```
POST /agent/booking/:bookingId/attempt/fail
Body:
{
  "type": "pickup",
  "reason": "Customer not home",
  "driverLateMinutes": 0,
  "timeZone": "Europe/London",
  "clientTimeZone": "Europe/London"
}
```

| Attempt | Backend result | Booking status |
|---------|----------------|----------------|
| 1st fail | `outcome: "reschedule_required"` | **3** (Awaiting Collection) |
| 2nd fail | `outcome: "cancelled"` | **19** (Cancelled) |

Customer receives a push notification in both cases.

### 3.3 Reschedule after 1st pickup fail

Booking must be status **3**.

```
POST /agent/booking/:bookingId/attempt/reschedule
Body:
{
  "type": "pickup",
  "collectionDate": "2026-07-15",
  "collectionTimeFrom": "10:00:00",
  "collectionTimeTo": "11:00:00",
  "deliveryDate": "2026-07-16",
  "deliveryTimeFrom": "14:00:00",
  "deliveryTimeTo": "15:00:00",
  "timeZone": "Europe/London",
  "clientTimeZone": "Europe/London"
}
```

→ Stays status **3** with updated dates. Driver can run **Attempt 2** from On the Way again.

### 3.4 Two-attempt loop (diagram)

```
Attempt 1:
  4 → Arrived (5) → grace → fail → fee → status 3 → reschedule slot

Attempt 2:
  4 → Arrived (5) → grace → fail → fee → status 19 (CANCELLED)

Attempt 2 success:
  5 → complete / unattended → status 7 → normal facility flow
```

---

## 4. Delivery flow (full)

### 4.1 Happy path

```
Status 13 (Out for Delivery)
  → PATCH /agent/driverReachedForDelivery/:bookingId
  → Status 14 (Driver Reached)
  → Backend creates booking_attempt (type=delivery, status=arrived)

Status 14 — after grace:
  → PATCH /agent/bookingDeliverToCustomer/:bookingId
  → Status 17 (Delivered)
  → Attempt marked completed
```

### 4.2 Arrived at delivery — three options

```
GET /agent/booking/:bookingId/attempt-options?type=delivery
```

**Option A — Delivered (customer present)**

```
PATCH /agent/bookingDeliverToCustomer/:bookingId
Body (optional): { timeZone, clientTimeZone }
```

**Option B — Unattended delivery**

1. Proof if required:

```
POST /agent/AddPickupDeliveryProof
  deliveryType: dropOff
```

2. Complete:

```
POST /agent/booking/:bookingId/attempt/unattended
Body:
{
  "type": "delivery",
  "method": "bag_at_door" | "concierge" | "locker",
  "timeZone": "Europe/London"
}
```

→ Status **17**.

**Unattended method rules (delivery)**

| Customer instruction (`driverInstructionOptions1`) | Allowed methods |
|----------------------------------------------------|-----------------|
| Leave at the door | `bag_at_door` (if `deliveryLeaveAtDoor`) |
| Deliver to the Reception/Porter | `concierge` (if `concierge`) |
| Any | `locker` (if policy allows) |

**Option C — Delivery failed**

```
POST /agent/booking/:bookingId/attempt/fail
Body:
{
  "type": "delivery",
  "reason": "Customer not available",
  "driverLateMinutes": 0,
  "timeZone": "Europe/London"
}
```

→ Status **15** (Delivery Failed), `outcome: "delivery_failed"`.

### 4.3 Reschedule after delivery fail

Booking must be status **15**.

```
POST /agent/booking/:bookingId/attempt/reschedule
Body:
{
  "type": "delivery",
  "deliveryDate": "2026-07-18",
  "deliveryTimeFrom": "16:00:00",
  "deliveryTimeTo": "17:00:00",
  "timeZone": "Europe/London"
}
```

→ Status **12** (Completed at Facility) — ready to dispatch again (`Out for Delivery` when driver goes out).

---

## 5. No-show policy — what affects the fee

Policy comes from the booking’s zone: `GET /agent/getActivePolicies?zoneId=<zoneId>` → `activeNoShowPolicy.noShowConfig`.

| Config field | Effect |
|--------------|--------|
| `enableForPickup` / `enableForDelivery` | If OFF for that leg → fee = 0 |
| `graceMinutesOnSite` | Minutes after `arrivedAt` before **Mark Failed** is allowed |
| `feeType` | `absolute`, `percentage`, or `both` |
| `pickupNoShowFee` / `deliveryNoShowFee` | Fixed fee (or unified if `useUnifiedFee`) |
| `percentageFee` | % of order value (`orderAmount` or `subTotal`) |
| `driverLateSLA` | If `driverLateMinutes` > SLA → fee **waived** |
| `autoForgiveFirstNoShow` + `autoForgiveCount` | First N no-shows per customer in period → fee 0 |
| `perCustomerCap` + `capWindowDays` | Max charged no-shows in window → fee 0 at cap |
| `pickupBagAtDoor`, `concierge`, `locker`, `deliveryLeaveAtDoor` | Control unattended options |
| `requirePhoto` | Unattended blocked until proof exists |

**Driver late waiver:** Pass actual lateness in fail body:

```json
{ "driverLateMinutes": 25 }
```

If 25 > policy `driverLateSLA` (e.g. 15), fee is waived (`feeWaived: true`).

---

## 6. API reference (new endpoints)

### Geofence (100m radius)

For **Arrived**, **no-show (fail)**, and **unattended**, the agent app must send the driver's current GPS:

| Field | Required | Notes |
|-------|----------|-------|
| `driverLat` | Yes | Driver latitude |
| `driverLng` | Yes | Driver longitude |

Backend compares driver position to:
- **Pickup** → `pickupAddresId` address `lat` / `lng`
- **Delivery** → `dropOffAddressId` address `lat` / `lng`

If distance **> 100m**, request is rejected with `distanceMeters` and `requiredRadiusMeters` in error details.

`GET attempt-options` accepts optional `driverLat` / `driverLng` query params and returns `withinGeofence`, `distanceMeters`, `requiredRadiusMeters` for UI button states.

**On the Way** does **not** require geofence.

### 6.1 Get attempt options

```
GET /agent/booking/:bookingId/attempt-options?type=pickup|delivery&driverLat=51.5&driverLng=-0.12
```

**Example response (pickup, grace still running):**

```json
{
  "status": "1",
  "message": "Attempt options fetched",
  "data": {
    "bookingId": 587,
    "attemptType": "pickup",
    "attemptId": 12,
    "attemptNumber": 1,
    "arrivedAt": "2026-07-10T11:05:00.000Z",
    "graceMinutes": 15,
    "graceEndAt": "2026-07-10T11:20:00.000Z",
    "graceElapsed": false,
    "graceSecondsRemaining": 420,
    "canMarkFailed": false,
    "unattendedOptions": [
      { "method": "bag_at_door", "label": "Bag at door" }
    ],
    "requirePhoto": true,
    "maxPickupAttempts": 2,
    "pickupAttemptCount": 0,
    "deliveryAttemptCount": 0,
    "feePreview": {
      "amount": 15,
      "currency": "USD",
      "policyApplied": "no_show_fee"
    },
    "canComplete": true
  }
}
```

**Poll:** Call every 30–60s on the Arrived screen, or run a local countdown from `graceEndAt`.

---

### 6.2 Mark attempt failed

```
POST /agent/booking/:bookingId/attempt/fail
```

| Field | Required | Notes |
|-------|----------|-------|
| `type` | Yes | `pickup` or `delivery` |
| `reason` | No | Stored on attempt |
| `driverLateMinutes` | No | For late-driver waiver |
| `timeZone` / `clientTimeZone` | No | Booking history timestamp |

**Example — 1st pickup fail:**

```json
{
  "status": "1",
  "message": "Pickup failed. Booking returned to Awaiting Collection for retry.",
  "data": {
    "outcome": "reschedule_required",
    "attemptId": 12,
    "pickupAttemptCount": 1,
    "maxPickupAttempts": 2,
    "fee": {
      "feeAmount": 15,
      "currency": "USD",
      "feeWaived": false,
      "feeWaiveReason": null,
      "policyApplied": "no_show_fee"
    },
    "bookingStatusId": 3
  }
}
```

**Example — 2nd pickup fail:**

```json
{
  "data": {
    "outcome": "cancelled",
    "pickupAttemptCount": 2,
    "bookingStatusId": 19,
    "message": "Maximum pickup attempts reached. Booking cancelled."
  }
}
```

---

### 6.3 Reschedule after fail

```
POST /agent/booking/:bookingId/attempt/reschedule
```

| `type` | Required body fields | Required booking status |
|--------|----------------------|-------------------------|
| `pickup` | `collectionDate`, `collectionTimeFrom`, `collectionTimeTo`, `deliveryDate`, `deliveryTimeFrom`, `deliveryTimeTo` | 3 |
| `delivery` | `deliveryDate`, `deliveryTimeFrom`, `deliveryTimeTo` | 15 |

---

### 6.4 Unattended completion

```
POST /agent/booking/:bookingId/attempt/unattended
```

| Field | Required | Values |
|-------|----------|--------|
| `type` | Yes | `pickup` \| `delivery` |
| `method` | Yes | `bag_at_door` \| `concierge` \| `locker` |

Booking must be status **5** (pickup) or **14** (delivery).

---

## 7. Existing endpoints wired to attempts

These automatically create or close `booking_attempts` rows:

| Endpoint | Attempt action |
|----------|----------------|
| `PATCH /agent/driverStatusArrived/:bookingId` | Creates open **pickup** attempt |
| `PATCH /agent/driverReachedForDelivery/:bookingId` | Creates open **delivery** attempt |
| `PATCH /agent/agentInspectionStatus/:bookingId` | Closes pickup attempt as **completed** |
| `PATCH /agent/bookingDeliverToCustomer/:bookingId` | Closes delivery attempt as **completed** |

```
PATCH /agent/driverStatusArrived/:bookingId
Body: { "driverLat": 51.5074, "driverLng": -0.1278, "timeZone": "Europe/London" }

PATCH /agent/driverReachedForDelivery/:bookingId
Body: { "driverLat": 51.5074, "driverLng": -0.1278, "timeZone": "Europe/London" }
```

Always call **Arrived** (with GPS) before using attempt-options / fail / unattended.

---

## 8. Recommended agent app UI

### Pickup — status 5 screen

```
┌─────────────────────────────────────┐
│  Arrived at pickup — Attempt 1/2    │
│  ⏱ Grace: 08:32 remaining           │
├─────────────────────────────────────┤
│  [ Complete Pickup ]                │  → agentInspectionStatus
│  [ Leave bag / Concierge ]          │  → proof + attempt/unattended
│  [ Customer not available ]       │  → disabled until graceElapsed
│       Est. fee: $15.00              │  → feePreview
└─────────────────────────────────────┘
```

After 1st fail → show reschedule form → `attempt/reschedule` → return to order list (status 3).

After 2nd fail → show “Order cancelled” → remove from active list.

### Delivery — status 14 screen

Same pattern with `type=delivery`; success button → `bookingDeliverToCustomer`.

---

## 9. Error cases (show to driver)

| HTTP / message | Cause | App action |
|----------------|-------|------------|
| Grace period not elapsed | Fail tapped too early | Keep countdown |
| No open attempt found | Arrived not called | Call `driverStatusArrived` first |
| Unattended method not allowed | Policy or customer instruction | Hide that option |
| Photo proof is required | `requirePhoto` + no proof | Open camera upload |
| Booking must be in arrived status | Wrong status for `attempt-options` | Navigate to correct step |

---

## 10. Database (for debugging)

| Table / column | Purpose |
|----------------|---------|
| `booking_attempts` | Per-attempt log: arrived, failed, unattended, fees |
| `bookings.pickupAttemptCount` | Failed pickup count |
| `bookings.deliveryAttemptCount` | Failed delivery count |
| `bookings.maxPickupAttempts` | Default 2 |
| `bookings.noShowFeeAccrued` | Running total fees on booking |
| `bookings.noShowPolicyId` | Snapshotted policy on first attempt |

---

## 11. Deploy checklist

1. Run migration: `npx sequelize-cli db:migrate` (creates `booking_attempts` + booking columns).
2. Deploy backend with new routes.
3. Agent app: implement Arrived screen per §8.
4. Ensure zone has an active no-show policy in admin (`GET /admin/getActiveNoShowPolicy`).

---

## 12. Quick test sequence (Postman / QA)

**Pickup no-show (attempt 1)**

1. Booking status **4** → `PATCH driverStatusArrived/:id`
2. `GET booking/:id/attempt-options?type=pickup` — note `graceEndAt`
3. Wait for grace OR test with policy `graceMinutesOnSite: 0` in admin
4. `POST booking/:id/attempt/fail` `{ "type": "pickup", "reason": "test" }`
5. Expect status **3**, `pickupAttemptCount: 1`
6. `POST booking/:id/attempt/reschedule` with new dates
7. Repeat from step 1 for attempt 2 → expect status **19**

**Unattended pickup**

1. Customer instruction = `Collect from Outside`
2. Policy `pickupBagAtDoor: true`, `requirePhoto: true`
3. Arrived → upload proof → `attempt/unattended` `{ "type": "pickup", "method": "bag_at_door" }`
4. Expect status **7**

---

## 13. Out of scope (this phase)

- Stripe charge for no-show fee (fee is recorded only)
- Cash-order-specific no-show handling
- Admin waive UI for fees
- Storage fee per day after no-show

These may be added in a later phase.
