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


let origin;
let swaggerUrl;
if(process.env.NODE_ENV==='development'){
    origin= `http://localhost:${process.env.PORT}`;
    swaggerUrl=`http://localhost:${process.env.PORT}`
}
else if(process.env.NODE_ENV ==='test'){
  origin="https://testlaundaryb.fomino.ch";
  swaggerUrl="https://testlaundaryb.fomino.ch"
}
else if(process.env.NODE_ENV ==='production'){
  origin="https://backendlaundary.fomino.ch";
  swaggerUrl="https://backendlaundary.fomino.ch"
}



app.use(cookieParser())
app.use(cors({
  origin:origin,
  credentials:true
}))
app.use(express.json())

app.use(express.urlencoded({extended:true}))

const swaggerDocument = YAML.load('./swagger.yaml');
swaggerDocument.servers=[
  {
    url:swaggerUrl,
    description:`${process.env.NODE_ENV} environment`
  }
]

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

console.log(`Swagger URL---> http://localhost:${process.env.PORT}/api-docs`)

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
        await db.sequelize.sync({ alter: true });
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
  
