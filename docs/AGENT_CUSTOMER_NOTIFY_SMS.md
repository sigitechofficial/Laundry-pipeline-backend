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
  "customMessage": "Hi, I'm at your door for laundry pickup — please come out."
}
```

| Field | Required | Notes |
|-------|----------|--------|
| `leg` | Yes | `"pickup"` or `"delivery"` |
| `channel` | No | `"sms"` only for now (`call` later) |
| `customMessage` | **Yes** | Agent-typed SMS text (max 320 chars). No auto template. |

### Phone / country code

SMS `To` is built server-side from `users.phoneNum` + `users.countryCode` (agent does not send the number).

| DB example | Twilio `To` |
|------------|-------------|
| `phoneNum=+923001234567` | `+923001234567` (as-is) |
| `countryCode=+92`, `phoneNum=03001234567` | `+923001234567` |
| `countryCode=+44`, `phoneNum=07123456789` | `+447123456789` |
| `countryCode=+44`, `phoneNum=1234567890` | `+441234567890` |
| no countryCode, `03…` | assume PK → `+92…` |
| no countryCode, `07…` | assume UK → `+44…` |

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
    "bodyPreview": "Hi, I'm at your door for laundry pickup..."
  }
}
```

### App UI

- Pickup / delivery reached → text field → **Send SMS**
- Body: `{ "leg": "pickup"|"delivery", "customMessage": "<agent text>" }`
- Empty `customMessage` → **400** validation error
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
