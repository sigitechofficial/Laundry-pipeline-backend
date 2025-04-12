require('dotenv').config()
const express=require('express')
const db=require('./models/index')
const cors=require('cors')
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const app=express()
const http = require("http");
const redis=require('./redis/redis')
const customerRouter=require('./routes/customer')
const adminRouter=require('./routes/admin')
const driverRouter=require('./routes/driver')
const agentRouter=require('./routes/agent')
const error=require('./middlewares/error')
const cookieParser=require('cookie-parser')
const {intilizeSocketFunc}=require('./socket_io')

const server = http.createServer(app);

app.use(cookieParser())
app.use(cors())
app.use(express.json())

app.use(express.urlencoded({extended:true}))


const swaggerDocument = YAML.load('./swagger.yaml');
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

app.use('/customer',customerRouter);
app.use('/admin',adminRouter);
app.use('/driver',driverRouter);
app.use('/agent',agentRouter)






app.use('/Public', express.static('./Public'));
app.use(error)

intilizeSocketFunc(server)
const server_port=process.env.PORT
let syncDb=0;
async function startServer() {
    try {
      if (syncDb) {
        await db.sequelize.sync({ force: true });
        console.log('Database synchronized successfully.');
        intilizeSocketFunc(server)
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
  
