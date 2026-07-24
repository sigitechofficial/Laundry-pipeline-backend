# Agent → Customer notify (Twilio SMS)

When the agent reaches **pickup** or **delivery**, the app can send an SMS from the Twilio business number.

## Endpoint

```http
POST /agent/bookings/:bookingId/notify-customer
Authorization: Bearer <agent_token>
Content-Type: application/json
```

### Body

```json
{
  "leg": "pickup",
  "channel": "sms",
  "templateKey": "arrived_pickup",
  "customMessage": null
}
```

| Field | Required | Notes |
|-------|----------|--------|
| `leg` | Yes | `"pickup"` or `"delivery"` |
| `channel` | No | `"sms"` only for now (`call` later) |
| `templateKey` | No | Default: `arrived_pickup` / `arrived_delivery` by leg |
| `customMessage` | No | If set, overrides template (max 320 chars) |

### When allowed

| leg | Booking status |
|-----|----------------|
| `pickup` | **5** (Driver Reached Pickup) or **6** |
| `delivery` | **13** (Out for Delivery) or **14** (Driver Reached) |

### Success

```json
{
  "status": "1",
  "message": "SMS sent to customer",
  "data": {
    "bookingId": 123,
    "leg": "pickup",
    "channel": "sms",
    "to": "+4477****1133",
    "from": "+447450310609",
    "messageSid": "SMxxx",
    "twilioStatus": "queued",
    "bodyPreview": "Hi John, your driver has arrived..."
  }
}
```

### App UI

- Pickup reached screen → **Notify SMS** → `{ "leg": "pickup" }`
- Delivery reached screen → **Notify SMS** → `{ "leg": "delivery" }`
- Rate limit: 1 SMS per booking+leg every **2 minutes**

### Env

```env
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+447450310609
```

## Customer phone privacy

Agent APIs **do not** return the full customer phone number.

| Field | Meaning |
|--------|---------|
| `phoneNum` | Masked, e.g. `+44****133` |
| `phoneMasked` | `true` |
| `hasPhone` | `true` if a number exists (show Call/SMS buttons) |

## Contact log (before attempt fail)

Every successful `notify-customer` SMS is saved in `booking_notifications` and linked to the open `booking_attempt` when present.

### `GET /agent/booking/:bookingId/attempt-options?type=pickup|delivery`

Extra fields:

```json
{
  "contacted": {
    "smsSent": true,
    "smsSentAt": "2026-07-24T10:15:00.000Z",
    "smsCount": 1,
    "callMade": false,
    "callMadeAt": null,
    "callCount": 0,
    "hasContactedCustomer": true,
    "latest": {
      "channel": "sms",
      "sentAt": "2026-07-24T10:15:00.000Z",
      "twilioSid": "SMxxx",
      "twilioStatus": "queued"
    }
  },
  "contactRecommendedBeforeFail": true
}
```

**App:** fail se pehle agar `contacted.hasContactedCustomer === false` → warn / pehle Notify SMS.  
Hard block abhi nahi (sirf recommended).

### Notify response also includes

`attemptId`, `notificationId`, `sentAt`
