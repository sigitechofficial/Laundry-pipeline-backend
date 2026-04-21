require('dotenv').config();
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
** Server running in ${env.toUpperCase()} mode
** Server URL: ${baseUrl}
** Swagger: ${baseUrl}/api-docs
** CORS: Enabled with credentials
**********************************************************`;
      
      console.log('\x1b[94m%s\x1b[0m', startupMsg);
    });
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', '================= Error during initialization ======================>', error);
  }
}

startServer();