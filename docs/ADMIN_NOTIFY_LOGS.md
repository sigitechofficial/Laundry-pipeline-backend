# Admin — Notify / Call logs

List all agent→customer notify and dialer-call session logs for support.

## Endpoint

```http
GET /admin/notify-logs
Authorization: admin access token (same as other /admin routes)
```

### Query params

| Param | Notes |
|-------|--------|
| `type` | `all` (default), `notifications`, `sessions` |
| `channel` | `push` \| `sms` \| `call` (notifications only) |
| `bookingId` | filter |
| `agentUserId` | filter |
| `leg` | `pickup` \| `delivery` |
| `sessionStatus` | `active` \| `closed` \| `expired` (sessions) |
| `startDate` / `endDate` | `YYYY-MM-DD` |
| `page` | default 1 |
| `limit` | default 50, max 100 |

### Response (shape)

```json
{
  "status": "1",
  "message": "Notify / call logs",
  "data": {
    "filters": { "type": "all", "page": 1, "limit": 50 },
    "notifications": {
      "total": 10,
      "page": 1,
      "limit": 50,
      "rows": [
        {
          "id": 1,
          "bookingId": 1135,
          "orderTrackId": "…",
          "leg": "pickup",
          "channel": "sms",
          "agent": { "id": 250, "firstName": "…", "phoneNum": "…" },
          "customer": { "id": 12, "firstName": "…", "phoneNum": "0317…" },
          "customerPhone": "0317…",
          "customerCountryCode": "+92",
          "toMasked": "+92****593",
          "fromNumber": "+447450310609",
          "twilioSid": "SMxxx",
          "twilioStatus": "queued",
          "bodyPreview": "Hi …",
          "sentAt": "…"
        }
      ]
    },
    "callSessions": {
      "total": 4,
      "page": 1,
      "limit": 50,
      "rows": [
        {
          "id": 4,
          "bookingId": 1136,
          "agentPhoneE164": "+92312…",
          "status": "active",
          "customerPhone": "…",
          "expiresAt": "…"
        }
      ]
    }
  }
}
```

**Note:** Admin response includes **full customer phone** (support). Agent APIs remain masked. Final Twilio Delivered/Undelivered is only as stored in `twilioStatus` at send time unless StatusCallbacks are added later.
