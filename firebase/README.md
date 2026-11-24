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
  and every `LIVE_TRACKING_BRIDGE_RECONCILE_MS` (default 2 min). Reconcile reads only session
  `meta` (shallow key listing over REST, then each meta), from every readable project; where
  projects disagree the most recent meta wins, and a bridge the readable projects know nothing
  about is kept while another project is unreadable.
- Every RTDB call is bounded (`LIVE_TRACKING_RTDB_TIMEOUT_MS`, default 5s) and circuit-broken
  per project (`utils/rtdbAccess.js`): after `LIVE_TRACKING_RTDB_BREAKER_THRESHOLD` (2)
  consecutive failures that project is skipped for `LIVE_TRACKING_RTDB_COOLDOWN_MS` (30s), so a
  missing or down RTDB costs at most a couple of timeouts, not one per request.
  `GET /health/firebase` probes each project's RTDB and fails (`degraded` in `/health/ready`)
  when one is missing or unreachable.
- A customer request naming a project the server does not hold is rejected (503
  `FIREBASE_PROJECT_NOT_CONFIGURED`) before any RTDB read or write.

Auth model: custom token claims `{ role: "customer"|"agent", appUserId }`, UID
`customer_{id}` / `agent_{id}`. Rules: `firebase/database.rules.json` (deploy to every project).

## Customer social sign-in (`POST /customer/loginUser`)

Google / Apple / Facebook sign-in is proven with a **Firebase ID token**, never with the email
the client sends (`services/shared/firebaseSocialIdentity.js`):

- The app / website signs in with Firebase Auth first and sends `firebaseIdToken`
  (`currentUser.getIdToken()`, fresh) with `signedFrom` and `firebaseProjectId`, on **every**
  social call, including the second call after an `Information Missing` answer.
- The server picks the project from the token's audience; it must be one of the projects above
  (primary or legacy), and a reported `firebaseProjectId` must be that same project. A token of
  any other project is refused before Firebase is asked.
- `verifyIdToken(token, true)` on that project's Admin app: signature, expiry, issuer, audience,
  revocation, disabled user.
- `firebase.sign_in_provider` must match `signedFrom`: google → `google.com`, apple →
  `apple.com`, facebook → `facebook.com`.
- The account is the token's `email`; `email_verified` must be true (Apple private-relay
  addresses count when Firebase marks them verified). The body's `email` is ignored.
- Failures are 401 with `code`: `SOCIAL_TOKEN_REQUIRED` (no token: app builds from before this
  rule — they are refused, there is no token-less path), `SOCIAL_TOKEN_INVALID`,
  `SOCIAL_TOKEN_PROJECT_UNKNOWN`, `SOCIAL_PROVIDER_MISMATCH`, `SOCIAL_EMAIL_UNVERIFIED`.
  Firebase unreachable is a 503 (`SOCIAL_TOKEN_VERIFY_UNAVAILABLE`), never a pass.
- An address held by a shop, driver or staff account, or by a deleted account, is a 409
  `EMAIL_IN_USE` (`users.email` is unique across every account type;
  `services/shared/accountEmail.js`). No customer row is created.

Email + password sign-in is unchanged and needs no token. Shop accounts (agent app) have no
social sign-in at all.

Facebook: Firebase usually reports Facebook emails as **not verified**, so Facebook sign-in is
refused (`SOCIAL_EMAIL_UNVERIFIED`) unless Firebase marks the email verified. That is
deliberate: an unverified provider email does not prove the address.

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

`deploy-api.yml` takes the primary key from the environment's `FIREBASE_SERVICE_ACCOUNT_JSON`
secret and its RTDB URL from the `FIREBASE_DATABASE_URL` variable (optional
`FIREBASE_LEGACY_DATABASE_URL` variable).

- The key never travels through step outputs or remote environment variables (those leak into
  process argv, `/proc/<pid>/environ` and `~/.pm2/dump.pm2`). The runner writes it to a 600
  file, scp copies it into the 700 drop dir `$DEPLOY_ROOT/secrets/firebase/incoming/`, and the
  deploy only gets its path (`FIREBASE_SERVICE_ACCOUNT_FILE`). The drop file is shredded after
  install and on every failure/rollback path.
- The workflow refuses to deploy when `FIREBASE_DATABASE_URL` names an RTDB that does not
  exist (HTTP 404 on a shallow read). Set the variable and secret only after provisioning.
- `scripts/firebase-server-credentials.sh` stores keys in `$DEPLOY_ROOT/secrets/firebase/`
  (700/600), keeps the server's `./firebase.json` as the legacy credential (copied once, never
  moved, so rollbacks keep working) and updates `.env`.
- `GET /health/firebase` reports every project, including a bounded probe of its RTDB.
