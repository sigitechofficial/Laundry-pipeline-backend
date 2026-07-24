# Agent → Customer notify (Twilio SMS + click-to-call)

When the agent reaches **pickup** or **delivery**, the app can SMS or call the customer via the Twilio business number. Customer phone stays server-side (masked in agent APIs).

## Scope

**In scope:** SMS + REST click-to-call (Twilio rings agent, then dials customer).

**Out of scope (do not build):** enterprise phone masking, number pools, native-dialer session APIs, inbound Voice webhooks, encrypted phone session tables, bidirectional customer→agent calling.

## Endpoint

```http
POST /agent/bookings/:bookingId/notify-customer
Authorization: Bearer <agent_token>
Content-Type: application/json
```

### Body — Notify (push then SMS)

```json
{
  "leg": "pickup",
  "channel": "sms"
}
```

Same body for notify. Backend picks channel by attempt count **per booking + leg**:

| Attempt # | What happens |
|-----------|----------------|
| **1st–3rd** | Firebase push to customer app |
| **4th+** | Twilio SMS to customer phone |

Fixed message template (push body + SMS body):

- pickup: `Hi {name}, your driver has arrived for laundry pickup. Order {orderTrackId}. — Just Dry Cleans`
- delivery: `Hi {name}, your driver has arrived to deliver your laundry. Order {orderTrackId}. — Just Dry Cleans`

If the customer has no FCM device token on attempts 1–3, the attempt is still **counted**; SMS unlocks on the 4th notify.

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

### Call flow

1. Twilio rings the **agent’s** phone (`users.phoneNum` + `countryCode` for logged-in agent).
2. Agent answers → short prompt → Twilio dials the **customer**.
3. Customer sees `TWILIO_PHONE_NUMBER` as caller ID (not the agent’s personal number).
4. Logged in `booking_notifications` with `channel: "call"`.

**UX copy for app:** “Your phone will ring first; answer to connect to the customer.”

**Requirements:** agent profile phone must be valid E.164 (same normalize rules as customer). Missing/invalid agent phone → clear 400 validation error. SMS still works if voice is disabled.

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

### Success — Notify (push, attempts 1–3)

```json
{
  "status": "1",
  "message": "Push notification sent (attempt 1 of 3).",
  "data": {
    "bookingId": 123,
    "leg": "pickup",
    "channel": "push",
    "attemptNumber": 1,
    "remainingPushAttempts": 2,
    "nextChannel": "push",
    "pushSent": true,
    "bodyPreview": "Hi John, your driver has arrived for laundry pickup..."
  }
}
```

### Success — Notify (SMS, attempt 4+)

```json
{
  "status": "1",
  "message": "SMS sent (notify attempt 4).",
  "data": {
    "bookingId": 123,
    "leg": "pickup",
    "channel": "sms",
    "attemptNumber": 4,
    "to": "+4477****1133",
    "from": "+447450310609",
    "messageSid": "SMxxx",
    "bodyPreview": "Hi John, your driver has arrived for laundry pickup..."
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

- **Notify customer** → `{ "leg": "...", "channel": "sms" }` (one button; backend chooses push vs SMS)
- Response includes `channel` (`push`|`sms`), `attemptNumber`, `remainingPushAttempts`, `nextChannel`
- **Call customer** → `{ "leg": "...", "channel": "call" }`
- Rate limit: notify (push/sms shared) and call each **2 minutes** per booking+leg
- Cost note: SMS only from 4th notify; call ≈ 2 Twilio legs

### Env

```env
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+447450310609
# Optional kill switch for voice only (SMS unaffected). Default: enabled.
# TWILIO_VOICE_ENABLED=false
```

Voice uses the same credentials / From number. No public webhook URL required (inline TwiML).

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
    "smsCount": 1,
    "pushSent": true,
    "pushCount": 3,
    "notifyAttemptCount": 4,
    "nextNotifyChannel": "sms",
    "callMade": false,
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

## Prod / ops checklist (click-to-call)

1. Deploy backend that includes `twilioCallService.js` + updated `customerNotifyService.js`.
2. On server: `npm install` so `twilio` is present in `node_modules`; restart the app.
3. Env on prod: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` (same as SMS).
4. Agent user in DB must have valid `phoneNum` + `countryCode` (call rings this number first).
5. Twilio Console → Voice Geographic Permissions: enable **United Kingdom** (and **Pakistan** only if you intentionally call PK mobiles).
6. Paid Twilio account (not trial) so you are not limited to Verified Caller IDs.
7. Optional: set `TWILIO_VOICE_ENABLED=false` to disable calls without touching SMS.
