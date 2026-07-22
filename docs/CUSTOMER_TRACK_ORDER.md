# Customer Track Order (Detailed Timeline)

## APIs

### Preferred (focused)

```http
GET /customer/trackOrder?bookingId=123&timeZone=Asia/Karachi
Authorization: Bearer <token>
```

Also supports `orderTrackId` instead of `bookingId`.

### Also available on booking details

```http
GET /customer/bookingDetailsById?bookingId=123&timeZone=Asia/Karachi
```

Extra fields:

- `trackTimeline` — detailed events, newest first
- `trackCurrentStatus` — customer-friendly current status
- `actionRequired` — reschedule CTA when pickup/delivery failed and unresolved

## Response shape (`/customer/trackOrder`)

```json
{
  "status": "1",
  "message": "Order track timeline fetched",
  "data": {
    "id": 123,
    "orderTrackId": "123-456",
    "bookingStatusId": 13,
    "currentStatus": {
      "id": 13,
      "title": "Out for Delivery",
      "message": "Your laundry is on the way to you."
    },
    "actionRequired": null,
    "timeline": [
      {
        "id": "history-88",
        "source": "history",
        "kind": "status",
        "statusId": 13,
        "title": "Out for Delivery",
        "message": "Your laundry is on the way to you.",
        "attemptNumber": null,
        "attemptType": null,
        "failureReason": null,
        "date": "2026-07-06",
        "time": "10:03:00",
        "occurredAt": "2026-07-06T10:03:00",
        "isException": false
      },
      {
        "id": "attempt-failed-12",
        "source": "attempt",
        "kind": "delivery_failed",
        "title": "Delivery Attempt Failed",
        "message": "Attempt 1 was unsuccessful — customer not at home.",
        "attemptNumber": 1,
        "attemptType": "delivery",
        "failureReason": "customer not at home",
        "date": "2026-07-06",
        "time": "19:05:00",
        "isException": true
      }
    ],
    "collectionDate": "...",
    "deliveryDate": "...",
    "pickupAddress": {},
    "dropOffAddress": {}
  }
}
```

## UI rules

1. Show `currentStatus.title` as the badge.
2. Render `timeline` newest-first (already sorted).
3. Exception rows (`isException: true`) in red (failed attempts / cancelled / on hold).
4. If `actionRequired` is present:
   - Show banner with `actionRequired.message`
   - CTA button → existing reschedule flow
5. Keep historical failed attempts in timeline after reschedule; only hide Action Required when resolved.

## Action required

```json
{
  "type": "pickup",
  "title": "Action Required",
  "message": "We were unable to collect your laundry. Please reschedule your collection slot.",
  "cta": "reschedule"
}
```

or `"type": "delivery"` for delivery failed.
