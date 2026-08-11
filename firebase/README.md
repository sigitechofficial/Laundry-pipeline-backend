# Firebase Realtime Database — Live Agent Tracking

## Enable RTDB

1. Firebase Console → project `laundry-app-bf43c` → **Build → Realtime Database** → Create database.
2. Copy the database URL into backend env:

```bash
FIREBASE_DATABASE_URL=https://laundry-app-bf43c-default-rtdb.firebaseio.com
```

(Use the exact URL shown in the console if it includes a region, e.g. `...europe-west1.firebasedatabase.app`.)

## Deploy security rules

```bash
# From Laundry-pipeline-backend (requires Firebase CLI + project access)
firebase deploy --only database --project laundry-app-bf43c
```

Rules file: `firebase/database.rules.json`

Or paste the JSON into Console → Realtime Database → Rules.

## Auth model

Backend issues Firebase Auth **custom tokens** via:

- `GET /customer/live-tracking/:bookingId`
- `GET /agent/live-tracking/:bookingId`

Claims: `{ role: "customer"|"agent", appUserId: <number> }`  
UID: `customer_{id}` / `agent_{id}`

Apps sign in with `FirebaseAuth.instance.signInWithCustomToken`, then read/write RTDB under `liveTracking/{bookingId}`.
