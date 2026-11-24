# Firebase — push, live-tracking auth, Realtime Database

The backend can hold **two** Firebase projects at once (`utils/firebaseProjects.js`):

| role | credential | RTDB URL | purpose |
|---|---|---|---|
| primary | `FIREBASE_CREDENTIALS_PATH` (unset: `./firebase.json`) | `FIREBASE_DATABASE_URL` | the business's project (`justdrycleansltd`) |
| legacy (optional) | `FIREBASE_LEGACY_CREDENTIALS_PATH` | `FIREBASE_LEGACY_DATABASE_URL` | the old project (`laundry-app-bf43c`) app builds from before the move still use |

Project ids always come from the credentials. Remove the legacy variables once no installed
app build uses the old project; the server then runs on the primary only.

## Clients report their project

Apps, the website and the admin panel send `firebaseProjectId`
(`Firebase.app().options.projectId` / the web config's `projectId`) with every push-token
registration (sign-in, sign-up, `/agent/session`, `POST /customer/deviceToken`,
`POST /agent/deviceToken`, admin sign-in, admin register-fcm) and with the live-tracking
session request (`?firebaseProjectId=`). Missing = an older build: for live tracking the
legacy project (else the primary); for push tokens the row is stored unclassified.

## Push routing (`utils/fcmRouting.js`)

`deviceTokens.firebaseProjectId` records the project that issued each token. A token is sent
through its recorded project first, an unclassified one through the legacy project then the
primary. "Not my token" answers (sender-id mismatch, unregistered, invalid registration) move
the token on to the next project; the project that accepts it is recorded on the row. A token
is deleted only when every configured project rejected it and at least one said it is
unregistered/invalid. Server-side errors (quota, auth, APNs) never delete tokens.

## Live tracking across projects

- `GET /customer/live-tracking/:bookingId` and `GET /agent/live-tracking/:bookingId` mint the
  custom token in the caller's project and return `firebaseProjectId` + `databaseUrl`
  (`databaseURL` kept for older builds). Apps sign in on the default Firebase app and use
  `FirebaseDatabase.instanceFor(app: Firebase.app(), databaseURL: databaseUrl)`.
- Session `meta` is written to the RTDB of **every** configured project.
- The driver's request records its project as `meta.publisherProjectId`;
  `utils/liveTrackingBridge.js` relays `location` and `route` from that RTDB into every other
  project's RTDB (Admin SDK listeners). An old driver build (legacy) and an updated customer
  app / the website (primary) — or the reverse — therefore see the same trip with no gap.
  Bridges stop when the session closes or is reassigned and are reconciled from RTDB at boot
  and every `LIVE_TRACKING_BRIDGE_RECONCILE_MS` (default 2 min).

Auth model: custom token claims `{ role: "customer"|"agent", appUserId }`, UID
`customer_{id}` / `agent_{id}`. Rules: `firebase/database.rules.json` (deploy to every project).

## Provision an RTDB + deploy rules

```bash
FIREBASE_RTDB_LOCATION=europe-west1 \
  node scripts/provisionLiveTrackingRtdb.js --credentials=/secure/path/service-account.json
```

Creates `<project_id>-default-rtdb` in that region if missing (enabling the RTDB management
API when the credential may), deploys the rules and prints the URL to set as
`FIREBASE_DATABASE_URL` (`--role=legacy` → `FIREBASE_LEGACY_DATABASE_URL`;
`--write-env=<file>` writes it).

## Servers

`deploy-api.yml` writes the primary key from the environment's `FIREBASE_SERVICE_ACCOUNT_JSON`
secret and takes its RTDB URL from the `FIREBASE_DATABASE_URL` variable (optional
`FIREBASE_LEGACY_DATABASE_URL` variable). `scripts/firebase-server-credentials.sh` stores keys
in `$DEPLOY_ROOT/secrets/firebase/` (700/600), keeps the server's `./firebase.json` as the
legacy credential (copied once, never moved, so rollbacks keep working) and updates `.env`.
`GET /health/firebase` reports every project.
