require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const cors = require("cors");
const routers = require('./rutas');
const connect = require('./connectBd');


const app = express();
const port = process.env.PORT || 3001;

app.use(express.json());
app.use(helmet());
app.use(cookieParser());

// Configuración de CORS
const allowedOrigins = ['http://localhost:3001', 'https://alquiladoraromero.isoftuthh.com', 'https://alquiladora-romero-backed-1.onrender.com', 'http://localhost:3000'];

app.use(cors({
  origin: (origin, callback) => {
    if (allowedOrigins.includes(origin) || !origin) {
      callback(null, true);
    } else {
      callback(new Error('No permitido por CORS'));
    }
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS', 'PUT'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  credentials: true,
}));

// Conectar a la base de datos
(async () => {
  try {
    await connect.connect();
    console.log('Conexión a la base de datos establecida');
  } catch (error) {
    console.error('Fallo al conectar a la base de datos', error);
  }
})();


// Middleware para manejar errores 500
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    error: "Error interno del servidor",
    message: err.message 
  });
})

app.use('/api', routers);

//Error 500
app.get('/ping', (req, res) => {
  res.status(200).send('Servidor en línea');
});

app.listen(port, () => {
  console.log(`Servidor en http://localhost:${port}`);
});
