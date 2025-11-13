 require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const cors = require("cors");
const http = require('http');
const { init: initSocket } = require('./config/socket');
//=====================RUTAS==========================
const routers = require('./rutas');
const connect = require('./connectBd');
const logger = require('./config/logs')
const tarjetasRouter= require('./consultas/clsTarjetas')

//==================================================

const app = express();
const port = process.env.PORT || 3001;


app.use(cookieParser());

app.use(helmet({
 
  hsts: process.env.NODE_ENV === 'production' ? {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  } : false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: [
        "'self'",
        ...(process.env.NODE_ENV === 'production' ? [
          "wss://alquiladora-romero-server.onrender.com", 
          "https://alquiladora-romero-server.onrender.com",
          "https://alquiladoraromero.bina5.com/"  
        ] : [
          "ws://localhost:3001", 
          "http://localhost:3001",
          "http://localhost:3000",
         
        ]),
      ],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https://alquiladoraromero.bina5.com"],
    },
  },
  frameguard: { action: 'deny' },
  xssFilter: false,
  ieNoOpen: false,
}));


// Configuración de CORS
const allowedOrigins = [
  'http://localhost:3001',
  'https://alquiladora-romero-server.onrender.com',
  'http://localhost:3000',
  'https://alquiladoraromero.bina5.com',
  'https://epiclike-epicyclic-jennifer.ngrok-free.dev' ,
];

app.use(cors({
  origin: (origin, callback) => {
    if (allowedOrigins.includes(origin) || !origin) {
      callback(null, true);
    } else {
      callback(new Error('No permitido por CORS'));
    }
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS', 'PUT'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token','stripe-signature'   ],
  credentials: true,
}));
app.options('*', cors());




//=================RUTAS DEFINIDOS=======================
app.use('/api/tarjetas', tarjetasRouter)

app.use(express.json());

app.use('/api', routers);

//=======================================================

// 📌 **Middleware Global para Manejo de Errores 500**
app.use((err, req, res, next) => {
  logger.error('Error del sistema detectado', {
    method: req.method,
    url: req.url,
    stack: err.stack,
    ip: req.ip,
    timestamp: new Date().toISOString(),
  });
  if (process.env.NODE_ENV === 'production') {
    res.status(500).json({ error: 'Error interno del servidor' });
  } else {
    res.status(500).json({ error: 'Error interno del servidor', message: err.message });
  }
});


const server = http.createServer(app);



const startServer = async () => {
  try {
    await connect.connect();
    connect.startKeepAlive();
    logger.info('Conexión a la base de datos establecida', { 
      db: process.env.DB_NAME || 'unknown' 
    });
    server.listen(port, '0.0.0.0', () => {
     
      const io = initSocket(server);
      logger.info('WebSocket inicializado');
    });
  } catch (error) {
    logger.error('Fallo al conectar a la base de datos', { 
      error: error.message, 
      stack: error.stack 
    });
    process.exit(1);
  }
};


if (process.env.NODE_ENV !== 'test') {
  startServer();
}


module.exports = {
  app,
  server,
}; 
