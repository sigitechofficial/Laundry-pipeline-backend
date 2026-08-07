require('dotenv').config();
require('./utils/ensureNodeCompat');
// pipeline-smoke-test: 2026-08-04 stage deploy verification
const express = require('express');
const db = require('./models/index');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const app = express();
const http = require("http");
const redis = require('./redis/redis');
const cookieParser = require('cookie-parser');
const { intilizeSocketFunc } = require('./socket_io');
// Routers
const customerRouter = require('./routes/customer');
const adminRouter = require('./routes/admin');
const driverRouter = require('./routes/driver');
const agentRouter = require('./routes/agent');
const error = require('./middlewares/error');
const { universalErrorHandler, universalNotFoundHandler, universalAsyncHandler } = require('./middlewares/universalErrorHandler');
const server = http.createServer(app);

// ============================================
// CORS CONFIGURATION
// ============================================
const NGROK_REGEX = /^https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.(?:app|dev)$/i;

const corsOptions = {
  origin: function (origin, callback) {
    // Allow no origin
    if (!origin) {
      return callback(null, true);
    }
    
    // Allow localhost
    if (/^http:\/\/localhost:\d+$/.test(origin)) {
      return callback(null, true);
    }

    // Allowed origins
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:4000',
      'http://localhost:5174',
      'https://stagelaundry.sigisolutions.net',
      'https://prodlaundry.sigisolutions.net',
      'https://main.dwc10i0wbe49w.amplifyapp.com',
      'https://main.d1bc8mk6y6halh.amplifyapp.com',
      'https://laundry-website-itlwfo883-sigitechofficials-projects.vercel.app',
      'https://admin.justdrycleans.com',
      'https://main.d38eb8q6y4vvam.amplifyapp.com',
      'https://www.justdrycleans.com',
      'https://dev.dkuj4lgqcrq22.amplifyapp.com',
      'https://dev.d1l8r4pedzet1t.amplifyapp.com'
    ];
    
    if (allowedOrigins.includes(origin) || NGROK_REGEX.test(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Not allowed by CORS'), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Cookie',
    'accesstoken',
    'x-access-token',
    'Featureid',
    'featureid',
    'ngrok-skip-browser-warning',
    'Ngrok-Skip-Browser-Warning'
  ],
  exposedHeaders: ['Set-Cookie'],
  optionsSuccessStatus: 200
};

// ============================================
// APPLY MIDDLEWARE IN CORRECT ORDER
// ============================================

// 1. CORS must be FIRST
app.use(cors(corsOptions));

// 2. Cookie parser
app.use(cookieParser());

// 3. Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// AutoSSL / Let's Encrypt HTTP-01 + cPanel pki-validation (stage/prod safe)
const path = require('path');
const fs = require('fs');
app.get('/.well-known/pki-validation/:file', function (req, res) {
  const filePath = path.join(
    __dirname,
    '.well-known',
    'pki-validation',
    path.basename(req.params.file)
  );
  if (!fs.existsSync(filePath)) {
    return res.status(404).type('text').send('Not found');
  }
  return res.sendFile(filePath);
});
app.get('/.well-known/acme-challenge/:file', function (req, res) {
  const filePath = path.join(
    __dirname,
    '.well-known',
    'acme-challenge',
    path.basename(req.params.file)
  );
  if (!fs.existsSync(filePath)) {
    return res.status(404).type('text').send('Not found');
  }
  return res.sendFile(filePath);
});

// ============================================
// STAGE DEPLOY TRIGGER
// ============================================
// Hosting proxies all HTTP to PM2/Express, so stage-trigger.php never reaches
// PHP. Respond immediately (avoids Apache 502 on long npm), then run deploy
// work in a detached shell. Production keeps using trigger.php (NODE_ENV=production).
app.get('/stage-trigger.php', function (req, res) {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).send('Not found');
  }

  const { spawn } = require('child_process');
  const fs = require('fs');
  const workingDir = '/home/sigisolutions/stagelaundry.sigisolutions.net';
  const lockPath = workingDir + '/.stage-trigger.lock';

  // CI greps these markers; work continues in the background after the response.
  res
    .status(200)
    .send('NPM install completed successfully.<br>PM2 command scheduled.<br>');

  try {
    // Clear stale locks (npm/pm2 can die mid-run and block every later deploy).
    if (fs.existsSync(lockPath)) {
      const ageMs = Date.now() - Number(fs.readFileSync(lockPath, 'utf8') || 0);
      if (!Number.isFinite(ageMs) || ageMs > 5 * 60 * 1000) {
        fs.unlinkSync(lockPath);
        console.warn('[stage-trigger] cleared stale lock (ageMs=%s)', ageMs);
      } else {
        console.warn('[stage-trigger] skip — deploy already in progress');
        return;
      }
    }
    fs.writeFileSync(lockPath, String(Date.now()));
  } catch (e) {
    // proceed even if lock file cannot be written
  }

  // Prefer Node 20/18 (firebase-admin / google-auth need global Headers/fetch).
  // Fall back to whatever nvm default is if newer versions are not installed.
  const script = [
    'source /home/sigisolutions/.nvm/nvm.sh',
    'export HOME=/home/sigisolutions',
    'cd /home/sigisolutions/stagelaundry.sigisolutions.net',
    'nvm use 20 >/dev/null 2>&1 || nvm use 18 >/dev/null 2>&1 || nvm use 16 >/dev/null 2>&1 || true',
    'echo "[stage-trigger] node=$(command -v node) version=$(node -v)"',
    'npm install',
    'pm2 restart laundary-stage --update-env || pm2 start laundary.js --name laundary-stage --interpreter "$(command -v node)" --update-env',
    'pm2 save',
    'rm -f /home/sigisolutions/stagelaundry.sigisolutions.net/.stage-trigger.lock'
  ].join(' && ');

  const child = spawn('/bin/bash', ['-lc', script], {
    cwd: workingDir,
    // Do not hardcode Node 16 in PATH — nvm use 20/18/16 runs inside the script.
    env: Object.assign({}, process.env, {
      HOME: '/home/sigisolutions'
    }),
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
});

// ============================================
// LIVE → STAGE DB SYNC (token-protected, stage only)
// ============================================
app.post('/internal/live-to-stage-db-sync', function (req, res) {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).send('Not found');
  }

  const token = process.env.DB_SYNC_TOKEN;
  const provided =
    (req.get('x-db-sync-token') || '') ||
    (req.query && req.query.token) ||
    '';
  if (!token || provided !== token) {
    return res.status(401).send('Unauthorized');
  }

  const { spawn } = require('child_process');
  const fs = require('fs');
  const path = require('path');
  const workingDir = '/home/sigisolutions/stagelaundry.sigisolutions.net';
  const statusPath = path.join(workingDir, 'backups', 'live-to-stage-sync-status.json');
  const lockPath = path.join(workingDir, 'backups', '.live-to-stage-sync.lock');

  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    if (fs.existsSync(lockPath)) {
      return res.status(409).send('Sync already running');
    }
    fs.writeFileSync(lockPath, String(Date.now()));
    fs.writeFileSync(
      statusPath,
      JSON.stringify(
        {
          state: 'queued',
          startedAt: new Date().toISOString(),
          phase: 'queued'
        },
        null,
        2
      )
    );
  } catch (e) {
    return res.status(500).send('Failed to start sync: ' + e.message);
  }

  res.status(202).send('Live→Stage DB sync started');

  const child = spawn(
    '/bin/bash',
    [
      '-lc',
      [
        'source /home/sigisolutions/.nvm/nvm.sh',
        'export HOME=/home/sigisolutions',
        'cd "' + workingDir + '"',
        'node scripts/live-to-stage-db-sync.js',
        'rm -f "' + lockPath + '"'
      ].join(' && ')
    ],
    {
      cwd: workingDir,
      env: Object.assign({}, process.env, {
        HOME: '/home/sigisolutions',
        APP_ROOT: workingDir,
        PROD_CONFIG_PATH: path.join(workingDir, 'config', 'config.prod.sync.json'),
        STAGE_CONFIG_PATH: path.join(workingDir, 'config', 'config.json'),
        DB_BACKUP_DIR: path.join(workingDir, 'backups'),
        DB_SYNC_STATUS_PATH: statusPath,
        PATH:
          '/home/sigisolutions/.nvm/versions/node/v16.20.2/bin:' +
          (process.env.PATH || '')
      }),
      detached: true,
      stdio: 'ignore'
    }
  );
  child.unref();
});

app.get('/internal/live-to-stage-db-sync/status', function (req, res) {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).send('Not found');
  }

  const token = process.env.DB_SYNC_TOKEN;
  const provided =
    (req.get('x-db-sync-token') || '') ||
    (req.query && req.query.token) ||
    '';
  if (!token || provided !== token) {
    return res.status(401).send('Unauthorized');
  }

  const fs = require('fs');
  const statusPath =
    '/home/sigisolutions/stagelaundry.sigisolutions.net/backups/live-to-stage-sync-status.json';
  if (!fs.existsSync(statusPath)) {
    return res.status(404).json({ state: 'unknown', error: 'No status file yet' });
  }
  try {
    return res.status(200).json(JSON.parse(fs.readFileSync(statusPath, 'utf8')));
  } catch (e) {
    return res.status(500).json({ state: 'error', error: e.message });
  }
});

// ============================================
// SWAGGER DOCS
// ============================================
let swaggerUrl;
if (process.env.NODE_ENV === 'development') {
  swaggerUrl = `http://localhost:${process.env.PORT}`;
} else if (process.env.NODE_ENV === 'test') {
  swaggerUrl = "https://stagelaundry.sigisolutions.net";
} else if (process.env.NODE_ENV === 'production') {
  swaggerUrl = "https://prodlaundry.sigisolutions.net";
}

const swaggerDocument = YAML.load('./swagger.yaml');
swaggerDocument.servers = [{
  url: swaggerUrl,
  description: `${process.env.NODE_ENV} environment`
}];
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// ============================================
// ROUTES
// ============================================
app.use('/customer', customerRouter);
app.use('/admin', adminRouter);
app.use('/driver', driverRouter);
app.use('/agent', agentRouter);
app.use('/debug', require('./routes/debug'));
app.use('/webhooks/twilio', require('./routes/twilioWebhooks'));
app.use('/Public', express.static('./Public'));

// ============================================
// ERROR HANDLERS (must be last)
// ============================================
app.use(universalNotFoundHandler);
app.use(universalErrorHandler);

// ============================================
// SOCKETS
// ============================================
intilizeSocketFunc(server);

// ============================================
// START SERVER
// ============================================
const server_port = process.env.PORT;
let syncDb = 0;

async function startServer() {
  try {
    const env = process.env.NODE_ENV || 'development';
    const dbConfig = require('./config/config.json')[env] || {};

    // Human-readable env label for ops (development | test | production)
    let envLabel = 'UNKNOWN';
    if (env === 'development') envLabel = 'DEVELOPMENT (local)';
    else if (env === 'test') envLabel = 'TEST / STAGE';
    else if (env === 'production') envLabel = 'PRODUCTION';
    else envLabel = `UNKNOWN (${env}) — expected: development | test | production`;

    const passwordLen = typeof dbConfig.password === 'string' ? dbConfig.password.length : 0;

    // Safe DB identity logs (never log password — only length)
    console.log('\x1b[36m%s\x1b[0m', `
**********************************************************
** ENVIRONMENT
** NODE_ENV:     ${env}
** ENV LABEL:    ${envLabel}
** config.json:  using "${env}" block
**********************************************************
** DB CONFIG
** host:           ${dbConfig.host || 'n/a'}
** port:           ${dbConfig.port || 3306}
** database:       ${dbConfig.database || 'n/a'}
** username:       ${dbConfig.username || 'n/a'}
** passwordLength: ${passwordLen} (value never logged)
**********************************************************`);

    try {
      await db.sequelize.authenticate();
      const [dbRows] = await db.sequelize.query('SELECT DATABASE() AS currentDb');
      const currentDb = dbRows?.[0]?.currentDb || 'n/a';
      console.log('\x1b[32m%s\x1b[0m', `** DB CONNECTED OK → SELECT DATABASE() = ${currentDb}`);
    } catch (dbErr) {
      console.error('\x1b[31m%s\x1b[0m', `** DB CONNECT FAILED: ${dbErr.message}`);
      console.error('\x1b[31m%s\x1b[0m', `
** DB ACCESS HINTS
** 1) On server, test same creds (interactive password prompt):
**    mysql -h 127.0.0.1 -P ${dbConfig.port || 3306} -u '${dbConfig.username || ''}' -p '${dbConfig.database || ''}'
** 2) If CLI fails → cPanel user/password/host is wrong (not Node).
** 3) If CLI works → config.json password/username mismatch or stale file.
** 4) MySQL user must exist for @localhost AND/OR @127.0.0.1 (cPanel often needs both).
** 5) After creating user: confirm Current Privileges shows the DB, then reset password once and paste into the matching config.json block password exactly.
** 6) Restart only the Node process you are currently using for this app (do not touch other PM2 apps).
`);
      throw dbErr;
    }

    if (syncDb) {
      if (env === 'development' || env === 'test') {
        await db.sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
        await db.sequelize.sync({ alter: true });
        await db.sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
      } else {
        await db.sequelize.sync({ alter: true });
      }

      console.log('\x1b[32m%s\x1b[0m', '<================= Database synchronized =======================>');
    }

    const { startHeldBookingReleaseJob } = require('./services/bookingHeldReleaseService');
    startHeldBookingReleaseJob();
    const { startInvoiceAutoChargeJob } = require('./services/Agent/invoiceAutoChargeService');
    startInvoiceAutoChargeJob();

    server.listen(server_port, function (err) {
      if (err) throw err;

      let baseUrl;

      switch(env) {
        case 'production':
          baseUrl = 'https://prodlaundry.sigisolutions.net';
          break;
        case 'test':
          baseUrl = 'https://stagelaundry.sigisolutions.net';
          break;
        default:
          baseUrl = `http://localhost:${server_port}`;
      }

      const startupMsg = `
**********************************************************
** Server running in ${envLabel}
** NODE_ENV=${env}  (development | test | production)
** Server URL: ${baseUrl}
** Swagger: ${baseUrl}/api-docs
** CORS: Enabled with credentials
** Active DB: ${dbConfig.database || 'n/a'} (user: ${dbConfig.username || 'n/a'})
**********************************************************`;
      
      console.log('\x1b[94m%s\x1b[0m', startupMsg);
    });
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', '================= Error during initialization ======================>', error);
  }
}

startServer();