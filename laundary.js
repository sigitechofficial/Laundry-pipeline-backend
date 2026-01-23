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
    console.log('🔍 Origin check:', origin);
    
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
      'http://localhost:5173',
      'http://192.168.18.26:5174',
      'http://192.168.18.27:5174',
      'http://localhost:5174',
      'https://backendlaundary.fomino.ch',
      'https://testlaundaryb.fomino.ch',
      'https://main.dwc10i0wbe49w.amplifyapp.com',
      'https://main.d1bc8mk6y6halh.amplifyapp.com',
      'http://192.168.18.36:3001'
    ];
    
    if (allowedOrigins.includes(origin) || NGROK_REGEX.test(origin)) {
      console.log('✅ Allowed:', origin);
      return callback(null, true);
    }

    console.log('❌ Blocked:', origin);
    return callback(new Error('Not allowed by CORS'), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cookie', 'ngrok-skip-browser-warning'],
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

// 4. Debug logging (optional - remove in production)
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path} - Origin: ${req.headers.origin || 'none'}`);
  next();
});

// ============================================
// SWAGGER DOCS
// ============================================
let swaggerUrl;
if (process.env.NODE_ENV === 'development') {
  swaggerUrl = `http://localhost:${process.env.PORT}`;
} else if (process.env.NODE_ENV === 'test') {
  swaggerUrl = "https://testlaundaryb.fomino.ch";
} else if (process.env.NODE_ENV === 'production') {
  swaggerUrl = "https://backendlaundary.fomino.ch";
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

/**
 * Cleanup orphaned records before database sync
 * Removes records with foreign keys that reference non-existent parent records
 */
async function cleanupOrphanedRecords() {
  try {
    const { sequelize } = db;
    console.log('\x1b[33m%s\x1b[0m', '<================= Starting orphaned records cleanup =======================>');
    
    // Clean up orphaned addresses (userId doesn't exist in users table)
    const [addressResults] = await sequelize.query(`
      DELETE FROM addressDbs 
      WHERE userId IS NOT NULL 
      AND userId NOT IN (
        SELECT id FROM (
          SELECT id FROM users WHERE deletedAt IS NULL
        ) AS valid_users
      )
    `);
    const addressCount = addressResults?.affectedRows || 0;
    if (addressCount > 0) {
      console.log(`\x1b[33m%s\x1b[0m`, `  ✓ Cleaned up ${addressCount} orphaned address records`);
    } else {
      console.log(`\x1b[32m%s\x1b[0m`, `  ✓ No orphaned address records found`);
    }
    
    // Add more cleanup queries here for other tables if needed
    // Example:
    // const [bookingResults] = await sequelize.query(`
    //   DELETE FROM bookings 
    //   WHERE customerId IS NOT NULL 
    //   AND customerId NOT IN (SELECT id FROM users WHERE deletedAt IS NULL)
    // `);
    // console.log(`  ✓ Cleaned up ${bookingResults?.affectedRows || 0} orphaned booking records`);
    
    console.log('\x1b[32m%s\x1b[0m', '<================= Orphaned records cleanup completed =======================>');
    
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', 'Error cleaning up orphaned records:', error.message);
    // Don't throw - allow sync to continue even if cleanup fails
    // Log the error but don't block server startup
  }
}

async function startServer() {
  try {
    if (syncDb) {
      // Clean up orphaned records BEFORE sync
      await cleanupOrphanedRecords();
      
      await db.sequelize.sync({ alter: true });
      console.log('\x1b[32m%s\x1b[0m', '<================= Database synchronized =======================>');
    }
    
    server.listen(server_port, function (err) {
      if (err) throw err;
      
      const env = process.env.NODE_ENV || 'development';
      let baseUrl;
      
      switch(env) {
        case 'production':
          baseUrl = 'https://backendlaundary.fomino.ch';
          break;
        case 'test':
          baseUrl = 'https://testlaundaryb.fomino.ch';
          break;
        default:
          baseUrl = `http://localhost:${server_port}`;
      }
      
      console.log('\x1b[94m%s\x1b[0m', `**********************************************************`);
      console.log('\x1b[94m%s\x1b[0m', `** Server running in ${env.toUpperCase()} mode`);
      console.log('\x1b[94m%s\x1b[0m', `** Server URL: ${baseUrl}`);
      console.log('\x1b[94m%s\x1b[0m', `** Swagger: ${baseUrl}/api-docs`);
      console.log('\x1b[94m%s\x1b[0m', `** CORS: Enabled with credentials`);
      console.log('\x1b[94m%s\x1b[0m', `**********************************************************`);
    });
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', '================= Error during initialization ======================>', error);
  }
}

startServer();