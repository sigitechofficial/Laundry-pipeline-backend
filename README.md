# Laundry Pipeline Backend

Node.js / Express API for the Laundry platform (customer, agent, admin, driver).

## Requirements (local Mac)

| Tool | Purpose | Notes |
|------|---------|--------|
| **Node.js `>= 22`** | Run the API | Required by Firebase Admin 14 |
| **npm** | Install dependencies | Comes with Node |
| **MAMP** | MySQL 8 + phpMyAdmin in browser | MySQL port **8889**, Apache/phpMyAdmin port **8888** |
| **Redis** | Sessions / tokens cache | Default port **6379** |
| **Git** | Clone the repo | — |

Optional but needed for full health checks / features:

- `firebase.json` (Firebase Admin service account) — push notifications  
- Stripe **test** keys — payments  
- `ZEPTOMAIL_API_TOKEN` — email  

> **Important:** `.env`, `config/config.json`, and `firebase.json` are **gitignored**. Every new machine must create them locally (steps below).

---

## One-time setup (new developer / new Mac)

### 1. Clone and install

```bash
cd /path/to/your/projects
git clone <repo-url> Laundry-pipeline-backend
cd Laundry-pipeline-backend
npm install
```

### 2. Create `.env`

```bash
cp .env.example .env
```

Edit `.env` at minimum:

```bash
NODE_ENV=development
PORT=3010
PUBLIC_BASE_URL=http://localhost:3010
JWT_ACCESS_SECRET=<generate with: openssl rand -base64 48>
JWT_GUEST_SECRET=<generate another: openssl rand -base64 48>
```

Add Stripe test keys and ZeptoMail token when you have them (see `.env.example`).

**Dotenv rules:** no spaces around `=`, prefer unquoted values.

### 3. Create `config/config.json` (local DB)

MAMP defaults used by this team:

```bash
cat > config/config.json <<'EOF'
{
  "development": {
    "username": "root",
    "password": "root",
    "database": "laundry_pipeline",
    "host": "127.0.0.1",
    "port": 8889,
    "dialect": "mysql",
    "logging": false,
    "dialectOptions": {
      "decimalNumbers": true
    }
  },
  "test": {
    "username": "root",
    "password": "root",
    "database": "laundry_pipeline",
    "host": "127.0.0.1",
    "port": 8889,
    "dialect": "mysql",
    "logging": false
  },
  "production": {
    "username": "root",
    "password": "root",
    "database": "laundry_pipeline",
    "host": "127.0.0.1",
    "port": 8889,
    "dialect": "mysql",
    "logging": false
  }
}
EOF
```

More DB detail: [docs/LOCAL_DATABASE_SETUP.md](docs/LOCAL_DATABASE_SETUP.md).

### 4. Firebase (optional for basic API boot)

Place a valid service account file at:

```text
./firebase.json
```

Without it, the API can still run; Firebase/push health will fail until you add it.

### 5. Install Redis (once)

```bash
brew install redis
```

---

## Start everything (daily / copy-paste)

Paste this in Terminal:

```bash
# 1) MAMP MySQL + Apache (phpMyAdmin)
/Applications/MAMP/bin/startMysql.sh
/Applications/MAMP/bin/startApache.sh

# 2) Redis
if ! redis-cli ping >/dev/null 2>&1; then
  redis-server --daemonize yes
fi

# 3) Wait for MySQL
sleep 5

# 4) Smoke-check deps
redis-cli ping
/Applications/MAMP/Library/bin/mysql80/bin/mysql -h127.0.0.1 -P8889 -uroot -proot -e "SELECT 1 AS mysql_ok;" 2>/dev/null | grep -v Warning

# 5) Backend
cd /Users/mac/Desktop/faisalProjects/laundryAll/Laundry-pipeline-backend
# (change the path above if your clone lives elsewhere)
npm run dev
```

Leave that terminal open. You should see **Server running in DEVELOPMENT (local)** on port **3010**.

### First time only — database schema (+ optional seeds)

In a **second** terminal (with MySQL already up):

```bash
cd /Users/mac/Desktop/faisalProjects/laundryAll/Laundry-pipeline-backend
npm run db:setup
# optional demo/reference data:
npm run db:seed
```

---

## Verify it works

| What | URL / command |
|------|----------------|
| Liveness | http://localhost:3010/health |
| Full deps (MySQL, Redis, Firebase, Stripe, ZeptoMail) | http://localhost:3010/health/ready |
| Single check | http://localhost:3010/health/mysql (also `redis`, `firebase`, `stripe`, `zeptomail`) |
| Swagger | http://localhost:3010/api-docs |
| phpMyAdmin (browser) | http://localhost:8888/phpMyAdmin/ |

phpMyAdmin login (MAMP default):

- Username: `root`  
- Password: `root`  

Healthy ready response:

```json
"overall": "ok",
"ready": true
```

`summary.ok` should include `mysql`, `redis`, and (when configured) `firebase`, `stripe`, `zeptomail`.

### Health logs

Every health call writes structured logs with prefix **`[HEALTH]`** (message + fix hint, no secrets).

```bash
# if you redirected npm output:
grep '\[HEALTH\]' /tmp/laundry-local-backend.log

# or watch the terminal where `npm run dev` is running
```

---

## View MySQL and Redis locally

### MySQL (browser — like cPanel phpMyAdmin)

1. Start MAMP Apache + MySQL (see start script above).
2. Open **http://localhost:8888/phpMyAdmin/**
3. Login:
   - Server: `localhost` / `127.0.0.1`
   - Username: `root`
   - Password: `root`
4. Select database **`laundry_pipeline`**

Also available: **http://localhost:8888/adminer/** (same MAMP stack).

MAMP start page: **http://localhost:8888/MAMP/**

### MySQL (Terminal)

```bash
/Applications/MAMP/Library/bin/mysql80/bin/mysql -h127.0.0.1 -P8889 -uroot -proot laundry_pipeline
```

Useful checks:

```bash
# list tables
/Applications/MAMP/Library/bin/mysql80/bin/mysql -h127.0.0.1 -P8889 -uroot -proot laundry_pipeline -e "SHOW TABLES;"

# migration status table
/Applications/MAMP/Library/bin/mysql80/bin/mysql -h127.0.0.1 -P8889 -uroot -proot laundry_pipeline -e "SELECT COUNT(*) AS migrations FROM SequelizeMeta;"
```

Connection used by the API (`config/config.json`):

| Setting | Local MAMP value |
|---------|------------------|
| Host | `127.0.0.1` |
| Port | `8889` |
| User | `root` |
| Password | `root` |
| Database | `laundry_pipeline` |

### Redis (Terminal)

Redis has no built-in browser UI in this setup. Inspect it with `redis-cli`:

```bash
# is it up?
redis-cli ping
# → PONG

# see keys (dev only; can be noisy)
redis-cli KEYS '*'

# inspect one key
redis-cli GET '<key-name>'

# how many keys
redis-cli DBSIZE

# monitor live commands (Ctrl+C to stop)
redis-cli MONITOR
```

Redis defaults used by this app (`redis/redis.js`): host `localhost`, port **`6379`**.

Optional health probe via API: **http://localhost:3010/health/redis**

---

## Stop

- Backend terminal: `Ctrl + C`
- Optional stop MAMP:

```bash
/Applications/MAMP/bin/stopApache.sh
/Applications/MAMP/bin/stopMysql.sh
```

---

## Useful npm scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Start API with nodemon |
| `npm run db:setup` | Create DB (if needed) + run migrations |
| `npm run db:setup:reset` | **Local only** wipe + remigrate |
| `npm run db:seed` | Run seeders |
| `npm test` | Run included unit tests |

---

## Troubleshooting

| Symptom | What to do |
|---------|------------|
| `/health/ready` → MySQL fail | Start MAMP MySQL; confirm `config/config.json` port **8889** |
| Redis fail | `redis-server` then `redis-cli ping` → `PONG` |
| Stripe / ZeptoMail fail | Put real values in `.env` (no placeholder keys); **save file**; restart `npm run dev` |
| JWT / login broken | Set `JWT_ACCESS_SECRET` and `JWT_GUEST_SECRET` in `.env`, restart |
| Env var “missing” but you typed it | Invalid dotenv syntax (`KEY = 'value'`). Use `KEY=value` |
| phpMyAdmin not loading | Start Apache: `/Applications/MAMP/bin/startApache.sh` → http://localhost:8888/phpMyAdmin/ |

---

## Project layout (short)

```text
laundary.js          # app entry
routes/              # HTTP routes
controllers/         # request handlers
services/            # business logic
models/              # Sequelize models
migrations/          # DB migrations
config/config.json   # local DB config (gitignored)
.env                 # secrets (gitignored)
.env.example         # template (committed)
swagger.yaml         # API docs (includes Health tag)
```

---

## Security notes

- Never commit `.env`, `firebase.json`, or real `config/config.json` passwords.  
- Use **Stripe test** keys locally (`sk_test_...` / `pk_test_...`).  
- Keep local JWT secrets different from stage/production.  
- Do not point local `config.json` at live production databases.
