# Agent App Guide — Delivery Attempt Failed (No-Show)

This document is for the **Agent mobile app team**. It covers **only** the delivery-side no-show flow: what to do when the driver reaches the customer for delivery but the customer is not available, and how to retry until delivery succeeds.

**Base path:** `/agent`
**Auth:** `Authorization: Bearer <agent_access_token>` on every endpoint below.

---

## 1. When this applies

Booking is status **13 (Out for Delivery)** → driver arrives at customer → customer is not there / not answering / refuses to accept → driver must mark the delivery attempt as **failed**, and then either the driver or the system reschedules and retries.

**Key rule: delivery attempts are unlimited.** Unlike pickup (capped at 3 attempts then auto-cancel), delivery has **no max attempt cap** — the driver keeps retrying (fail → reschedule → out for delivery → fail → reschedule → ...) until it eventually succeeds. Every failed attempt can charge its own no-show fee.

---

## 2. Status reference (delivery leg only)

| ID | Title | Meaning |
|----|-------|---------|
| 12 | Completed (At Facility) | Laundry ready, waiting to be dispatched for delivery |
| 13 | Out for Delivery | Driver en route to customer |
| 14 | Driver Reached | Driver arrived at customer — grace timer starts |
| 15 | Delivery Failed | Customer not available — this attempt failed |
| 17 | Delivered | Delivery successful (attempt completed) |

---

## 3. Full flow (step by step)

```
Status 13 (Out for Delivery)
  │
  ▼
PATCH /agent/driverReachedForDelivery/:bookingId
  Body: { "driverLat": 51.5074, "driverLng": -0.1278, "timeZone": "Europe/London" }
  │  → Geofence check (driver must be within radius of customer address)
  │  → Status 14 (Driver Reached)
  │  → Backend opens a delivery attempt (grace timer starts from arrivedAt)
  ▼
GET /agent/booking/:bookingId/attempt-options?type=delivery&driverLat=...&driverLng=...
  │  → Poll every 30-60s, or run local countdown from graceEndAt
  │  → canMarkFailed becomes true once grace period elapses AND driver is within geofence
  ▼
Customer not available →
POST /agent/booking/:bookingId/attempt/fail
  Body: { "type": "delivery", "reason": "Customer not available", "driverLateMinutes": 0,
          "driverLat": 51.5074, "driverLng": -0.1278, "timeZone": "Europe/London" }
  │  → Status 15 (Delivery Failed)
  │  → deliveryAttemptCount +1
  │  → No-show fee calculated from zone's active no-show policy
  │  → If fee > 0 and not waived → customer's saved card is charged automatically via Stripe
  ▼
POST /agent/booking/:bookingId/attempt/reschedule
  Body: { "type": "delivery", "deliveryDate": "2026-07-18",
          "deliveryTimeFrom": "16:00:00", "deliveryTimeTo": "17:00:00",
          "timeZone": "Europe/London" }
  │  → Status 12 (Completed at Facility) — new delivery slot saved
  ▼
PATCH /agent/laundryDeliverToCustomer/:bookingId?driverId=<id>
  │  → Status 13 (Out for Delivery) again — cycle repeats from the top
  ▼
... repeat until driver marks Delivered or Unattended successfully ...
```

---

## 4. Arrived screen — what the driver sees at status 14

Poll:

```
GET /agent/booking/:bookingId/attempt-options?type=delivery&driverLat=51.5&driverLng=-0.12
```

**Example response:**

```json
{
  "status": "1",
  "message": "Attempt options fetched",
  "data": {
    "bookingId": 988,
    "attemptType": "delivery",
    "attemptId": 41,
    "attemptNumber": 1,
    "arrivedAt": "2026-07-15T10:05:00.000Z",
    "graceMinutes": 15,
    "graceEndAt": "2026-07-15T10:20:00.000Z",
    "graceElapsed": false,
    "graceSecondsRemaining": 420,
    "withinGeofence": true,
    "distanceMeters": 12,
    "requiredRadiusMeters": 100,
    "gpsRequired": false,
    "geofenceBypassed": false,
    "canMarkFailed": false,
    "canMarkUnattended": true,
    "unattendedOptions": [
      { "method": "bag_at_door", "label": "Leave at door" }
    ],
    "requirePhoto": true,
    "deliveryAttemptCount": 0,
    "feePreview": {
      "amount": 15,
      "currency": "GBP",
      "policyApplied": "no_show_fee"
    },
    "canComplete": true
  }
}
```

Use these fields:

| Field | Use in UI |
|-------|-----------|
| `graceElapsed` / `graceSecondsRemaining` | Disable **Customer Not Available** button until grace elapses; show countdown |
| `withinGeofence` | Disable fail/unattended if driver GPS is outside allowed radius |
| `canMarkFailed` | `true` only when grace elapsed **and** within geofence — gate the fail button on this |
| `canMarkUnattended` | Gate unattended options on this |
| `unattendedOptions` | Show only these buttons (e.g. "Leave at door") |
| `requirePhoto` | If true, force photo upload before allowing unattended completion |
| `feePreview.amount` / `currency` | Show "Marking this as failed may charge the customer £15.00" |
| `deliveryAttemptCount` | Show "Attempt N" (no max, so no "of X") |

Recommended screen:

```
┌─────────────────────────────────────┐
│  Arrived for delivery — Attempt 1   │
│  ⏱ Grace: 07:00 remaining           │
├─────────────────────────────────────┤
│  [ Delivered to customer ]          │  → bookingDeliverToCustomer
│  [ Leave at door / Concierge ]      │  → proof + attempt/unattended
│  [ Customer not available ]         │  → disabled until canMarkFailed
│       Est. fee: £15.00              │  → feePreview
└─────────────────────────────────────┘
```

---

## 5. Marking the delivery attempt as failed

```
POST /agent/booking/:bookingId/attempt/fail
```

| Field | Required | Notes |
|-------|----------|-------|
| `type` | Yes | Must be `"delivery"` |
| `reason` | No | Free text, stored on the attempt (e.g. "Customer not available") |
| `driverLateMinutes` | No | If driver was late beyond policy SLA, fee gets waived automatically |
| `driverLat` / `driverLng` | Yes (unless geofence bypass is on) | Used for the geofence check |
| `timeZone` / `clientTimeZone` | No | For booking history timestamp |

**Example response — fee charged successfully:**

```json
{
  "status": "1",
  "message": "Delivery failed. Customer must reschedule delivery.",
  "data": {
    "outcome": "delivery_failed",
    "attemptId": 41,
    "deliveryAttemptCount": 1,
    "fee": {
      "feeAmount": 15,
      "currency": "GBP",
      "feeWaived": false,
      "feeWaiveReason": null,
      "policyApplied": "no_show_fee",
      "stripeCharged": true,
      "stripePaymentIntentId": "pi_xxx",
      "stripeChargeError": null
    },
    "bookingStatusId": 15
  }
}
```

**Example response — fee waived (e.g. driver was late):**

```json
{
  "data": {
    "outcome": "delivery_failed",
    "fee": {
      "feeAmount": 0,
      "feeWaived": true,
      "feeWaiveReason": "Driver late 25m (SLA 15m)",
      "stripeCharged": false,
      "stripeChargeError": null
    },
    "bookingStatusId": 15
  }
}
```

**Example response — charge attempted but failed (no card on file):**

```json
{
  "data": {
    "outcome": "delivery_failed",
    "fee": {
      "feeAmount": 15,
      "feeWaived": false,
      "stripeCharged": false,
      "stripeChargeError": "No saved payment method found for this booking"
    },
    "bookingStatusId": 15
  }
}
```

App should show the driver/support team a clear message when `stripeChargeError` is present — the fee is still recorded on the booking (`noShowFeeAccrued`), it just wasn't collected automatically; admin may need to follow up.

**Precondition errors:**

| Message | Cause | Fix |
|---------|-------|-----|
| `Grace period not elapsed. Wait Xs...` | Tapped fail before grace ended | Wait / disable button until `canMarkFailed` |
| `No open attempt found. Mark Arrived first.` | `driverReachedForDelivery` wasn't called | Call Arrived endpoint first |
| `Cannot mark delivery failed from current booking status` | Booking isn't at status 14 | Re-sync booking status before showing this screen |
| `GEOFENCE_OUT_OF_RANGE` | Driver GPS too far from customer address | Show distance, block action until in range |

---

## 6. Alternative to failing: unattended delivery

If the customer's delivery instructions allow it (and policy permits), the driver can complete delivery **without** marking it failed:

1. If `requirePhoto` is true, upload proof first:

```
POST /agent/AddPickupDeliveryProof
Form-data:
  bookingId: <id>
  deliveryType: dropOff
  Images: <files>
```

2. Complete unattended:

```
POST /agent/booking/:bookingId/attempt/unattended
Body: {
  "type": "delivery",
  "method": "bag_at_door" | "concierge" | "locker",
  "driverLat": 51.5074,
  "driverLng": -0.1278,
  "timeZone": "Europe/London"
}
```

→ Status **17 (Delivered)**. No fee, no failed attempt recorded.

| Customer instruction (`driverInstructionOptions1`) | Allowed method |
|-----------------------------------------------------|-----------------|
| Leave at the door | `bag_at_door` (if policy `deliveryLeaveAtDoor` is on) |
| Deliver to the Reception/Porter | `concierge` (if policy `concierge` is on) |
| Any | `locker` (if policy `locker` is on) |

---

## 7. Rescheduling after a failed delivery attempt

Booking must be status **15 (Delivery Failed)**.

```
POST /agent/booking/:bookingId/attempt/reschedule
Body: {
  "type": "delivery",
  "deliveryDate": "2026-07-18",
  "deliveryTimeFrom": "16:00:00",
  "deliveryTimeTo": "17:00:00",
  "timeZone": "Europe/London"
}
```

**Response:**

```json
{
  "data": {
    "outcome": "delivery_rescheduled",
    "bookingStatusId": 12,
    "schedule": {
      "deliveryDate": "2026-07-18",
      "deliveryTimeFrom": "16:00:00",
      "deliveryTimeTo": "17:00:00"
    }
  }
}
```

→ Booking goes back to status **12 (Completed at Facility)**.

---

## 8. Re-dispatching for the next delivery attempt

Once rescheduled (status 12), dispatch the driver again to bring it back to **Out for Delivery**:

```
PATCH /agent/laundryDeliverToCustomer/:bookingId?driverId=<driverId>
Body (optional): { "timeZone": "Europe/London" }
```

→ Status **13 (Out for Delivery)**. Now repeat from §3 (`driverReachedForDelivery` → grace → fail/unattended/delivered).

There is **no limit** on how many times this cycle can repeat — keep looping until the driver successfully delivers or marks unattended.

---

## 9. Successful delivery (for contrast)

```
PATCH /agent/bookingDeliverToCustomer/:bookingId
Body (optional): { "timeZone": "Europe/London" }
```

→ Status **17 (Delivered)**. Closes the open delivery attempt as `completed`, no fee.

---

## 10. Geofence quick reference

- Driver must be within `requiredRadiusMeters` (from the zone's active no-show policy, default **100m**) of the customer's **drop-off address** lat/lng.
- App must **not** hardcode 100 — always read `requiredRadiusMeters` from the API response.
- If `driverLat`/`driverLng` are missing on `GET attempt-options`: `withinGeofence: false`, `gpsRequired: true`.
- QA-only bypass: backend `.env` → `GEOFENCE_BYPASS_ENABLED=true` (no app changes needed, response shows `geofenceBypassed: true`). Must be `false` in production.

---

## 11. Quick test sequence (Postman / QA)

1. Get a booking to status **13** (dispatch it).
2. `PATCH /agent/driverReachedForDelivery/:bookingId` with driver GPS at the customer's location → expect status **14**.
3. `GET /agent/booking/:bookingId/attempt-options?type=delivery` → note `graceEndAt` (or set policy `graceMinutesOnSite: 0` in admin for instant testing).
4. Wait for grace / confirm `canMarkFailed: true`.
5. `POST /agent/booking/:bookingId/attempt/fail` with `{ "type": "delivery", "reason": "test" }` → expect status **15**, `deliveryAttemptCount: 1`, check `fee.stripeCharged`.
6. `POST /agent/booking/:bookingId/attempt/reschedule` with new delivery date/time → expect status **12**.
7. `PATCH /agent/laundryDeliverToCustomer/:bookingId?driverId=<id>` → expect status **13** again.
8. Repeat steps 2-5 for a 2nd failed attempt → confirm no cap is enforced and a 2nd fee/charge occurs.
9. On a later attempt, call `PATCH /agent/bookingDeliverToCustomer/:bookingId` instead of failing → expect status **17 (Delivered)**.
