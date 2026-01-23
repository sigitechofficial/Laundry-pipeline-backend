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
 * Generic cleanup for orphaned records across ALL tables
 * Automatically discovers foreign key relationships and cleans up orphaned records
 */
async function cleanupOrphanedRecords() {
  try {
    const { sequelize } = db;
    const dbName = sequelize.config.database;
    
    console.log('\x1b[33m%s\x1b[0m', '<================= Starting generic orphaned records cleanup =======================>');
    
    // Get all foreign key constraints from the database
    const [foreignKeys] = await sequelize.query(`
      SELECT 
        TABLE_NAME as tableName,
        COLUMN_NAME as columnName,
        REFERENCED_TABLE_NAME as referencedTable,
        REFERENCED_COLUMN_NAME as referencedColumn,
        CONSTRAINT_NAME as constraintName
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = '${dbName}'
        AND REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY TABLE_NAME, COLUMN_NAME
    `);
    
    if (!foreignKeys || foreignKeys.length === 0) {
      console.log('\x1b[32m%s\x1b[0m', '  ✓ No foreign keys found to clean up');
      console.log('\x1b[32m%s\x1b[0m', '<================= Orphaned records cleanup completed =======================>');
      return;
    }
    
    console.log(`\x1b[36m%s\x1b[0m`, `  Found ${foreignKeys.length} foreign key relationships to check`);
    
    let totalCleaned = 0;
    const criticalTables = ['bookings', 'billingDetails', 'bookingHistories', 'customerSelectedServices'];
    
    for (const fk of foreignKeys) {
      try {
        const { tableName, columnName, referencedTable, referencedColumn } = fk;
        
        // Check if referenced table has paranoid (soft delete) support
        const [tableInfo] = await sequelize.query(`
          SELECT COLUMN_NAME 
          FROM INFORMATION_SCHEMA.COLUMNS 
          WHERE TABLE_SCHEMA = '${dbName}' 
            AND TABLE_NAME = '${referencedTable}' 
            AND COLUMN_NAME = 'deletedAt'
        `);
        
        const hasParanoid = tableInfo && tableInfo.length > 0;
        const paranoidCondition = hasParanoid ? 'AND deletedAt IS NULL' : '';
        
        // For critical tables, UPDATE to NULL instead of DELETE
        const isCriticalTable = criticalTables.includes(tableName);
        
        if (isCriticalTable) {
          // Set foreign key to NULL for critical tables
          const [result] = await sequelize.query(`
            UPDATE ${tableName}
            SET ${columnName} = NULL
            WHERE ${columnName} IS NOT NULL
              AND ${columnName} NOT IN (
                SELECT ${referencedColumn} FROM (
                  SELECT ${referencedColumn} FROM ${referencedTable} WHERE 1=1 ${paranoidCondition}
                ) AS valid_refs
              )
          `);
          
          const affectedRows = result?.affectedRows || 0;
          if (affectedRows > 0) {
            console.log(`\x1b[33m%s\x1b[0m`, `  ✓ ${tableName}.${columnName}: Set ${affectedRows} orphaned references to NULL`);
            totalCleaned += affectedRows;
          }
        } else {
          // Delete orphaned records for non-critical tables
          const [result] = await sequelize.query(`
            DELETE FROM ${tableName}
            WHERE ${columnName} IS NOT NULL
              AND ${columnName} NOT IN (
                SELECT ${referencedColumn} FROM (
                  SELECT ${referencedColumn} FROM ${referencedTable} WHERE 1=1 ${paranoidCondition}
                ) AS valid_refs
              )
          `);
          
          const affectedRows = result?.affectedRows || 0;
          if (affectedRows > 0) {
            console.log(`\x1b[33m%s\x1b[0m`, `  ✓ ${tableName}.${columnName}: Deleted ${affectedRows} orphaned records`);
            totalCleaned += affectedRows;
          }
        }
      } catch (fkError) {
        // Log but continue with other foreign keys
        console.log(`\x1b[31m%s\x1b[0m`, `  ✗ Error cleaning ${fk.tableName}.${fk.columnName}: ${fkError.message}`);
      }
    }
    
    if (totalCleaned > 0) {
      console.log(`\x1b[33m%s\x1b[0m`, `  Total: Cleaned ${totalCleaned} orphaned references`);
    } else {
      console.log(`\x1b[32m%s\x1b[0m`, `  ✓ No orphaned records found - database is clean!`);
    }
    
    console.log('\x1b[32m%s\x1b[0m', '<================= Orphaned records cleanup completed =======================>');
    
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', 'Error in generic cleanup function:', error.message);
    console.error('\x1b[31m%s\x1b[0m', 'Stack:', error.stack);
    // Don't throw - allow sync to continue even if cleanup fails
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