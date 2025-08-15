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

const server = http.createServer(app);

// === Setup origin based on environment ===
let origin;
let swaggerUrl;
if (process.env.NODE_ENV === 'development') {
  origin = `http://localhost:${process.env.PORT}`;
  swaggerUrl = `http://localhost:${process.env.PORT}`;
} else if (process.env.NODE_ENV === 'test') {
  origin = "https://testlaundaryb.fomino.ch";
  swaggerUrl = "https://testlaundaryb.fomino.ch";
} else if (process.env.NODE_ENV === 'production') {
  origin = "https://backendlaundary.fomino.ch";
  swaggerUrl = "https://backendlaundary.fomino.ch";
}
// === CORS config ===
// const corsOptions = {
//   origin: 'http://localhost:3000',
//   credentials: true,
//   methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
//   allowedHeaders: ['Content-Type', 'Authorization'],
// };

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, false); // block unknown origins (non-browser requests)

    const isLocalhost = /^http:\/\/localhost:\d+$/.test(origin);
    console.log("isLocalhost================>",isLocalhost)
    if (isLocalhost) {
      return callback(null, true); 
    }

    if (origin === 'http://localhost:3000') {
      return callback(null, true);
    }
    
    if (origin === 'https://backendlaundary.fomino.ch') {
      return callback(null, true);
    }
    if(origin === 'https://main.dwc10i0wbe49w.amplifyapp.com'){
      return callback(null, true);  
    }

    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true, 
};

// === Apply middleware ===
app.use(cors(corsOptions));
//app.options('*', cors(corsOptions)); // Handle preflight

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// === Swagger Docs ===
const swaggerDocument = YAML.load('./swagger.yaml');
swaggerDocument.servers = [
  {
    url: swaggerUrl,
    description: `${process.env.NODE_ENV} environment`
  }
];
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
console.log(`Swagger URL---> ${swaggerUrl}/api-docs`);

// === Routes ===
app.use('/customer', customerRouter);
app.use('/admin', adminRouter);
app.use('/driver', driverRouter);
app.use('/agent', agentRouter);
app.use('/Public', express.static('./Public'));

// === Error handler ===
app.use(error);

// === Sockets ===
intilizeSocketFunc(server);

// === Start server ===
const server_port = process.env.PORT;
let syncDb = 0;
async function startServer() {
  try {
    if (syncDb) {
      await db.sequelize.sync({ alter: true });
      console.log('Database synchronized successfully.');
    }
    server.listen(server_port, function (err) {
      if (err) throw err;
      console.log('Listening on port %d', server_port);
    });
  } catch (error) {
    console.error('Error during initialization:', error);
  }
}

startServer();
