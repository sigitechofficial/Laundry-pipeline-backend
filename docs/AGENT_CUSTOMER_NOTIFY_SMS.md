# Agent → Customer notify (Twilio SMS + dialer call)

When the agent reaches **pickup** or **delivery**, the app can notify (push/SMS) or call the customer via Twilio. Customer phone stays server-side (masked in agent APIs).

## Scope

**In scope:**
- Notify ladder: 1st = push+SMS; 2nd–3rd = push; then SMS
- **Native dialer call:** API returns Twilio number → app opens `tel:` → agent dials → Twilio webhook bridges to customer

**Out of scope:** number pool, encrypted phone vault, bidirectional customer→agent, enterprise multi-DID allocation.

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

| Attempt # | What happens |
|-----------|----------------|
| **1st** | Firebase push **+** Twilio SMS (together) |
| **2nd–3rd** | Firebase push only |
| **4th+** | Twilio SMS only |

### Body — Call (native dialer)

```json
{
  "leg": "pickup",
  "channel": "call"
}
```

### Call flow

```text
Agent taps Call
  → API creates call session (matches agent phone → booking)
  → Response: maskedNumber + dialUri (Twilio UK number — NOT customer number)
  → App opens native dialer with dialUri
  → Agent dials
  → Twilio hits POST /webhooks/twilio/voice/incoming
  → Backend returns TwiML Dial customer (callerId = Twilio number)
  → Customer rings; both talk
```

**App must:**
1. Call API with `channel: "call"`
2. Open `data.dialUri` (e.g. `tel:+447450310609`) in the system dialer
3. Never dial `data.to` (that is a **masked customer** display field only)

**Requirements:**
- Agent profile `phoneNum` + `countryCode` must match the phone that will place the call (Twilio `From` on inbound)
- `PUBLIC_BASE_URL` must be the public HTTPS origin of this API
- Twilio Console: Voice webhook for `TWILIO_PHONE_NUMBER` → `{PUBLIC_BASE_URL}/webhooks/twilio/voice/incoming` (HTTP POST)

Session TTL: **30 minutes** (override with `PHONE_CALL_SESSION_TTL_MINUTES`).

### Success — Call

```json
{
  "status": "1",
  "message": "Open your phone dialer and call the masked number...",
  "data": {
    "bookingId": 123,
    "leg": "pickup",
    "channel": "call",
    "sessionId": 1,
    "maskedNumber": "+447450310609",
    "displayNumber": "+447450310609",
    "dialUri": "tel:+447450310609",
    "expiresAt": "2026-07-24T12:00:00.000Z",
    "to": "+4477****1133",
    "agentTo": "+4477****9988",
    "from": "+447450310609",
    "twilioStatus": "session_ready"
  }
}
```

### Twilio webhook (provider only)

```http
POST /webhooks/twilio/voice/incoming
```

- Public; validates `X-Twilio-Signature`
- Looks up active session by caller (`From`) = agent phone
- Returns TwiML `<Dial callerId="TWILIO_NUMBER">customer</Dial>`
- Unknown / expired / invalid → neutral reject + hangup (no order details)

### When allowed

| leg | Booking status |
|-----|----------------|
| `pickup` | **5** or **6** |
| `delivery` | **13** or **14** |

### Env

```env
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+447450310609
PUBLIC_BASE_URL=https://prodlaundry.sigisolutions.net
# PHONE_CALL_SESSION_TTL_MINUTES=30
# TWILIO_VOICE_ENABLED=false
# TWILIO_SKIP_SIGNATURE_VALIDATION=true   # non-production tests only
```

### Prod setup

1. Deploy code.
2. Create table: `node scripts/ensure-booking-call-sessions.js`
3. Set `PUBLIC_BASE_URL` on the server.
4. Twilio Console → Phone Numbers → your UK number → **A call comes in** → Webhook URL:
   `https://prodlaundry.sigisolutions.net/webhooks/twilio/voice/incoming` (POST)
5. Restart app (pm2).
6. Agent profile phone must be the SIM that dials.

### App UI summary

- **Notify** → `{ "leg", "channel": "sms" }`
- **Call** → `{ "leg", "channel": "call" }` then `launchUrl(dialUri)`
- UX: “Dial the number shown — customer connects automatically.”

### Phone / country code

Built from `users.phoneNum` + `users.countryCode` (agent + customer). See normalize rules in service.

### Contact log

`booking_notifications` + `booking_call_sessions`. Attempt-options `contacted` still includes sms/push/call flags.
