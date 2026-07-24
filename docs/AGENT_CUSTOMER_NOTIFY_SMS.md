# Agent → Customer notify (Twilio SMS + click-to-call)

When the agent reaches **pickup** or **delivery**, the app can SMS or call the customer via the Twilio business number. Customer phone stays server-side (masked in agent APIs).

## Endpoint

```http
POST /agent/bookings/:bookingId/notify-customer
Authorization: Bearer <agent_token>
Content-Type: application/json
```

### Body — SMS

```json
{
  "leg": "pickup",
  "channel": "sms",
  "customMessage": "Hi, I'm at your door for laundry pickup — please come out."
}
```

### Body — Call (click-to-call)

```json
{
  "leg": "pickup",
  "channel": "call"
}
```

| Field | Required | Notes |
|-------|----------|--------|
| `leg` | Yes | `"pickup"` or `"delivery"` |
| `channel` | No | `"sms"` (default) or `"call"` |
| `customMessage` | **Yes for SMS** | Agent-typed text (max 320). Not used for call. |

### Call flow

1. Twilio rings the **agent’s** phone (`users.phoneNum` + `countryCode` for logged-in agent).
2. Agent answers → short prompt → Twilio dials the **customer**.
3. Customer sees `TWILIO_PHONE_NUMBER` as caller ID (not the agent’s personal number).
4. Logged in `booking_notifications` with `channel: "call"`.

**Requirements:** agent profile phone must be valid E.164 (same normalize rules as customer).

### Phone / country code

`To` is built server-side from `users.phoneNum` + `users.countryCode`.

| DB example | Twilio number |
|------------|---------------|
| `phoneNum=+923001234567` | `+923001234567` (as-is) |
| `countryCode=+92`, `phoneNum=03001234567` | `+923001234567` |
| `countryCode=+44`, `phoneNum=07123456789` | `+447123456789` |
| no countryCode, `03…` | assume PK → `+92…` |
| no countryCode, `07…` | assume UK → `+44…` |

### When allowed

| leg | Booking status |
|-----|----------------|
| `pickup` | **5** (Driver Reached Pickup) or **6** |
| `delivery` | **13** (Out for Delivery) or **14** (Driver Reached) |

### Success — SMS

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
    "callSid": null,
    "twilioStatus": "queued",
    "bodyPreview": "Hi, I'm at your door..."
  }
}
```

### Success — Call

```json
{
  "status": "1",
  "message": "Calling your phone — answer to connect to the customer",
  "data": {
    "bookingId": 123,
    "leg": "pickup",
    "channel": "call",
    "to": "+4477****1133",
    "agentTo": "+4477****9988",
    "from": "+447450310609",
    "messageSid": null,
    "callSid": "CAxxx",
    "twilioStatus": "queued",
    "bodyPreview": "click-to-call",
    "message": "Calling your phone first. Answer to be connected to the customer."
  }
}
```

### App UI

- **Send SMS** → `{ "leg": "...", "channel": "sms", "customMessage": "..." }`
- **Call customer** → `{ "leg": "...", "channel": "call" }` (no customMessage)
- Rate limit: 1 SMS **and** 1 call per booking+leg every **2 minutes** (separate)
- Cost note: call ≈ 2 legs (Twilio→agent + Twilio→customer)

### Env

```env
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+447450310609
```

Voice uses the same credentials / From number. No extra webhook URL required (inline TwiML).

## Customer phone privacy

| Field | Meaning |
|--------|---------|
| `phoneNum` | Masked, e.g. `+44****133` |
| `phoneMasked` | `true` |
| `hasPhone` | `true` if a number exists (show Call/SMS buttons) |

## Contact log (before attempt fail)

SMS and calls are saved in `booking_notifications` and linked to the open `booking_attempt` when present.

### `GET /agent/booking/:bookingId/attempt-options?type=pickup|delivery`

```json
{
  "contacted": {
    "smsSent": true,
    "smsSentAt": "2026-07-24T10:15:00.000Z",
    "smsCount": 1,
    "callMade": true,
    "callMadeAt": "2026-07-24T10:16:00.000Z",
    "callCount": 1,
    "hasContactedCustomer": true,
    "latest": {
      "channel": "call",
      "sentAt": "2026-07-24T10:16:00.000Z",
      "twilioSid": "CAxxx",
      "twilioStatus": "queued"
    }
  },
  "contactRecommendedBeforeFail": true
}
```

**App:** fail se pehle agar `contacted.hasContactedCustomer === false` → warn / pehle SMS or Call.  
Hard block abhi nahi (sirf recommended).

### Notify response also includes

`attemptId`, `notificationId`, `sentAt`
